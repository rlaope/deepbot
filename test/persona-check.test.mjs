/**
 * The persona check exists because an over-budget file is truncated silently: all
 * four files are injected every turn, so the tail someone wrote just stops
 * existing, with no error anywhere. These tests pin the detections that matter —
 * truncation, a secret, and the same fact in two files.
 *
 * The tool is exercised as a child process, so what is tested is what users run.
 *
 * Run: node test/persona-check.test.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOL = fileURLToPath(new URL('../tools/persona-check.mjs', import.meta.url))
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Run the tool on a scratch home; returns { status, output }. */
function run(files) {
  const home = mkdtempSync(join(tmpdir(), 'deepbot-persona-'))
  for (const [name, content] of Object.entries(files)) {
    if (name === 'memory/') { mkdirSync(join(home, 'memory'), { recursive: true }); continue }
    writeFileSync(join(home, name), content)
  }
  let status = 0
  let output = ''
  try {
    output = execFileSync(process.execPath, [TOOL, home], { encoding: 'utf8' })
  } catch (e) {
    status = e.status ?? 1
    output = String(e.stdout ?? '')
  }
  rmSync(home, { recursive: true, force: true })
  return { status, output }
}

const GOOD = {
  'SOUL.md': '# Agent\n\nBe direct. Say when you do not know.\n',
  'USER.md': '2026-01-01: Prefers concise answers.\n',
  'MEMORY.md': '2026-01-01: Runs on DeepSeek Harness.\n',
}
let r = run(GOOD)
check('a healthy home is clean', r.status === 0 && /Clean/.test(r.output), `exit ${r.status}`)
check('it reports every budget', ['SOUL.md', 'AGENTS.md', 'USER.md', 'MEMORY.md'].every((f) => r.output.includes(f)))

r = run({ ...GOOD, 'SOUL.md': `# Agent\n${'x'.repeat(6500)}\n` })
check('an over-budget file is an error', r.status === 1)
check('it names the file', /SOUL\.md/.test(r.output))
check('it says how much is dropped', /cut from every prompt|OVER by/.test(r.output), (r.output.match(/OVER by \d+/) ?? [''])[0])

// The fixture is assembled at runtime rather than written literally: a literal
// token shape in this repository trips the repository-wide scan in
// test/secrets.test.mjs, and loosening that scan to accommodate a test would
// weaken the thing worth keeping strict.
const FAKE_TOKEN = ['xoxb', '1234567890', 'abcdef'].join('-')
r = run({ ...GOOD, 'USER.md': `2026-01-01: token is ${FAKE_TOKEN}\n` })
check('a secret in a persona file is an error', r.status === 1)
check('it names the secret type', /Slack token/.test(r.output))

const shared = '2026-01-01: The deploy command is sionic-deploy document-harness dev.\n'
r = run({ ...GOOD, 'USER.md': shared, 'MEMORY.md': shared })
check('the same fact in two files warns', /injected twice/.test(r.output), 'not injected twice')
check('a duplicate is not fatal', r.status === 0)

r = run({ ...GOOD, 'USER.md': 'Prefers concise answers.\n' })
check('an undated fact warns', /without a leading date/.test(r.output))

// The shipped templates end with a comment block. A fresh setup must be clean, or
// the first thing a new user sees is a warning about the file we gave them.
r = run({ ...GOOD, 'USER.md': '2026-01-01: Prefers concise answers.\n\n<!--\nGuidance line one.\nMore guidance that is not a fact.\n-->\n' })
check('a multi-line comment is not treated as undated facts', !/without a leading date/.test(r.output), r.output.match(/without a leading date[^\n]*/) ?? 'no warning')

// A home that does not exist yet is what a first run looks like, so it must be a
// clear message rather than a crash. (An empty directory is not the same case.)
{
  const base = mkdtempSync(join(tmpdir(), 'deepbot-persona-'))
  const missing = join(base, 'not-created-yet')
  let status = 0
  let output = ''
  try {
    output = execFileSync(process.execPath, [TOOL, missing], { encoding: 'utf8' })
  } catch (e) {
    status = e.status ?? 1
    output = String(e.stdout ?? '')
  }
  rmSync(base, { recursive: true, force: true })
  check('a missing home is not an error', status === 0 && /Nothing to check/.test(output), `exit ${status}`)
}

// All four files absent: the tool should report them as optional, not as failures.
r = run({})
check('an empty home passes with every file listed as optional', r.status === 0 && /not present/.test(r.output))

const failed = results.filter((x) => !x.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
