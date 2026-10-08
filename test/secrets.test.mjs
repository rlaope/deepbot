/**
 * SPEC S5: no secret reaches stored memory or a log.
 *
 * Scans the artifacts a session leaves behind — the recall index, memory notes,
 * the plugin log, the health file and the watch state — for token shapes. It is
 * a pattern scan, not a proof: it catches the realistic accident (a token echoed
 * into a note or a log line), not an exfiltration channel.
 *
 * Run: node test/secrets.test.mjs <dir> [more dirs...]
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { findSecrets } from '../tools/secret-patterns.mjs'

const roots = process.argv.slice(2)
if (roots.length === 0) roots.push(join(homedir(), 'dsh-agent'), join(homedir(), '.dsh', 'slack-state'))

let scanned = 0
const hits = []
function walk(path) {
  let st
  try { st = statSync(path) } catch { return }
  if (st.isDirectory()) {
    for (const entry of readdirSync(path)) {
      if (entry === 'node_modules' || entry === 'sessions') continue
      walk(join(path, entry))
    }
    return
  }
  if (st.size > 4_000_000) return
  let text
  try { text = readFileSync(path, 'utf8') } catch { return }
  scanned++
  for (const hit of findSecrets(text)) hits.push(`${path}: ${hit.label} (${hit.sample})`)
}
for (const root of roots) { if (existsSync(root)) walk(root) }

if (hits.length > 0) {
  console.log(`FAIL — ${hits.length} secret-shaped value(s) in ${scanned} file(s):`)
  for (const hit of hits) console.log(`  ${hit}`)
  process.exit(1)
}
console.log(`PASS — scanned ${scanned} file(s), no token-shaped value found`)
