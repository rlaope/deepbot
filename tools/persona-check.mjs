#!/usr/bin/env node
/**
 * Check the persona and memory files before they are injected.
 *
 * All four files go into the prompt on every turn, so a file over its budget is
 * silently truncated — the tail that someone carefully wrote just stops existing.
 * This says so, by name and by amount, before that happens.
 *
 * It also looks for the two mistakes that are easy to make and hard to notice:
 * the same fact written into two files (it will be injected twice), and a secret,
 * which would then be in every prompt and every session log.
 *
 * Usage: node tools/persona-check.mjs [agent-home]
 * Exit: 0 clean (warnings allowed), 1 problems found.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defaults } from '../dist/index.js'
import { findSecrets } from './secret-patterns.mjs'

const home = process.argv[2] ?? join(homedir(), 'dsh-agent')

const FILES = [
  { name: defaults.personaFile, budget: defaults.maxPersonaChars, role: 'persona', dated: false },
  { name: 'AGENTS.md', budget: defaults.maxInstructionChars, role: 'operating rules', dated: false },
  { name: defaults.userFile, budget: defaults.maxUserChars, role: 'facts about the user', dated: true },
  { name: defaults.factsFile, budget: defaults.maxFactsChars, role: 'facts about the work', dated: true },
]

const errors = []
const warnings = []
const rows = []

if (!existsSync(home)) {
  console.log(`No agent home at ${home}. Nothing to check.`)
  process.exit(0)
}

/** Lines worth comparing across files: long enough to be a statement of fact. */
function factLines(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 40 && !l.startsWith('<!--') && !l.startsWith('#'))
}

const seen = new Map()

for (const file of FILES) {
  const path = join(home, file.name)
  if (!existsSync(path)) {
    rows.push({ name: file.name, chars: 0, budget: file.budget, note: 'not present (optional)' })
    continue
  }
  const text = readFileSync(path, 'utf8')
  const chars = text.length
  const over = chars > file.budget
  rows.push({ name: file.name, chars, budget: file.budget, note: over ? `OVER by ${chars - file.budget}` : file.role })
  if (over) {
    errors.push(`${file.name}: ${chars} chars against a ${file.budget} budget — the last ${chars - file.budget} characters are cut from every prompt. Trim it or move detail into memory/<topic>.md.`)
  }
  for (const hit of findSecrets(text)) {
    errors.push(`${file.name}: looks like a ${hit.label} (${hit.sample}) — it would be injected into every prompt and written to every session log.`)
  }
  if (file.dated) {
    // Comment blocks are guidance, not facts, so track them instead of only
    // skipping the lines that happen to carry the markers — otherwise the shipped
    // template warns about itself the first time anyone runs this.
    let inComment = false
    const undated = text.split('\n').filter((l) => {
      const line = l.trim()
      if (inComment) { if (line.endsWith('-->')) inComment = false; return false }
      if (line.startsWith('<!--')) { if (!line.endsWith('-->')) inComment = true; return false }
      if (line === '' || line.startsWith('#') || line.startsWith('§')) return false
      if (l !== l.trimStart()) return false            // continuation of the line above
      return !/^\d{4}-\d\d-\d\d:/.test(line)
    })
    if (undated.length > 0) warnings.push(`${file.name}: ${undated.length} line(s) without a leading date, e.g. ${JSON.stringify(undated[0].slice(0, 60))}`)
  }
  for (const line of factLines(text)) {
    const key = line.toLowerCase().replace(/[^a-z0-9가-힣 ]+/g, '').replace(/\s+/g, ' ').trim()
    if (key.length < 30) continue
    if (seen.has(key)) warnings.push(`same fact in ${seen.get(key)} and ${file.name}: ${JSON.stringify(line.slice(0, 70))} — it will be injected twice`)
    else seen.set(key, file.name)
  }
}

const memoryDir = join(home, 'memory')
let memoryNote = ''
if (existsSync(memoryDir)) {
  const topics = readdirSync(memoryDir).filter((f) => f.endsWith('.md'))
  const bytes = topics.reduce((n, f) => n + statSync(join(memoryDir, f)).size, 0)
  memoryNote = `${topics.length} topic file(s), ${bytes} bytes (injected in full)`
}

const w = Math.max(...rows.map((r) => r.name.length))
console.log(`agent home: ${home}\n`)
for (const r of rows) {
  const flag = r.note.startsWith('OVER') ? ' !' : '  '
  console.log(`${flag} ${r.name.padEnd(w)}  ${String(r.chars).padStart(6)} / ${String(r.budget).padStart(6)}  ${r.note}`)
}
const total = rows.reduce((n, r) => n + r.chars, 0)
const budgetTotal = rows.reduce((n, r) => n + r.budget, 0)
console.log(`\n  ${'injected total'.padEnd(w)}  ${String(total).padStart(6)} / ${String(budgetTotal).padStart(6)}`)
if (memoryNote !== '') console.log(`  memory/: ${memoryNote}`)

if (warnings.length > 0) {
  console.log('\nWarnings')
  for (const line of warnings) console.log(`  - ${line}`)
}
if (errors.length > 0) {
  console.log('\nProblems')
  for (const line of errors) console.log(`  - ${line}`)
  console.log(`\n${errors.length} problem(s). These files are injected every turn.`)
  process.exit(1)
}
console.log(warnings.length > 0 ? '\nNo problems, some warnings.' : '\nClean.')
