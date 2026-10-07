/**
 * Tests for the watch primitive.
 *
 * The rules being checked are the M4 acceptance criteria, and each of them
 * exists because the naive version is wrong:
 *   - the first observation is a baseline, not a change (otherwise every watch
 *     fires the moment it is created)
 *   - silence when nothing changed (a watch that speaks every interval is a
 *     heartbeat, and it teaches its owner to ignore it)
 *   - a flapping condition is rate-limited, and says how much it suppressed
 *
 * Runs watch.mjs as a subprocess in dry-run mode against a temp config, so no
 * Slack connection is needed.
 *
 * Run: node test/watch.test.mjs
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WATCH = join(HERE, '..', 'watch', 'watch.mjs')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dir = mkdtempSync(join(tmpdir(), 'deepbot-watch-'))
const valueFile = join(dir, 'value.txt')
const configFile = join(dir, 'watches.json')
const stateFile = join(dir, 'state.json')

writeFileSync(valueFile, 'alpha')
writeFileSync(configFile, JSON.stringify({
  watches: [{
    id: 'test',
    name: 'test watch',
    command: `cat ${valueFile}`,
    intervalSeconds: 60,
    channel: 'C_TEST',
    rateLimitMinutes: 0.02,          // 1.2s, so the window boundary is testable
  }],
}))

function run() {
  // --force bypasses the interval; --dry-run prints instead of posting.
  // Exit 1 means "at least one alert was emitted", which is expected here, so a
  // non-zero exit must not throw.
  let out = ''
  try {
    out = execFileSync(process.execPath, [WATCH, '--config', configFile, '--state', stateFile, '--dry-run', '--force'], { encoding: 'utf8' })
  } catch (e) {
    out = String(e?.stdout ?? '')
  }
  const alerts = out.split('\n').filter((l) => l.includes('DRY-RUN alert'))
  return { out, alerts }
}

// 1) first observation is a baseline
let r = run()
check('the first observation is a baseline, not a change', r.alerts.length === 0, `${r.alerts.length} alert(s)`)
check('the baseline was recorded', /baseline recorded/.test(r.out))

// 2) a change alerts once
writeFileSync(valueFile, 'beta')
r = run()
check('a change produces exactly one alert', r.alerts.length === 1, `${r.alerts.length} alert(s)`)
check('the alert carries the new value', r.alerts[0]?.includes('beta'))
check('the alert names the watch', r.alerts[0]?.includes('test watch'))

// 3) silence when nothing changed
r = run()
check('no change produces no alert', r.alerts.length === 0, `${r.alerts.length} alert(s)`)

// 4) a change inside the rate-limit window is suppressed, not lost
writeFileSync(valueFile, 'gamma')
r = run()
check('a change inside the rate-limit window is suppressed', r.alerts.length === 0, `${r.alerts.length} alert(s)`)
check('the suppression is recorded', /suppressed/.test(r.out))

// 5) once the window reopens the alert reports what it suppressed
await sleep(1500)
writeFileSync(valueFile, 'delta')
r = run()
check('the next change after the window alerts', r.alerts.length === 1, `${r.alerts.length} alert(s)`)
check('the alert reports the suppressed count', /1 earlier change\(s\) were suppressed/.test(r.alerts[0] ?? ''), (r.alerts[0] ?? '').replace(/\n/g, ' ').slice(-90))

// 6) state is durable: a fresh run with no change stays silent
r = run()
check('state survives between runs', r.alerts.length === 0, `${r.alerts.length} alert(s)`)

// 7) contract: no file is fine (nothing to do), a broken file is not.
let exitCode = 0
try {
  execFileSync(process.execPath, [WATCH, '--config', join(dir, 'nope.json'), '--state', stateFile, '--dry-run'], { encoding: 'utf8', stdio: 'pipe' })
} catch (e) { exitCode = e.status ?? 1 }
check('a missing host config is not an error, just nothing to do', exitCode === 0, `exit ${exitCode}`)

const brokenFile = join(dir, 'broken.json')
writeFileSync(brokenFile, '{ this is not json')
exitCode = 0
try {
  execFileSync(process.execPath, [WATCH, '--config', brokenFile, '--state', stateFile, '--dry-run'], { encoding: 'utf8', stdio: 'pipe' })
} catch (e) { exitCode = e.status ?? 1 }
check('an unparseable host config exits 2', exitCode === 2, `exit ${exitCode}`)

// 8) an agent-authored watch is picked up from the agent home
const agentHome = join(dir, 'agent-home')
mkdirSync(join(agentHome, 'watches'), { recursive: true })
const agentValue = join(dir, 'agent-value.txt')
writeFileSync(agentValue, 'one')
writeFileSync(join(agentHome, 'watches', 'agent.json'), JSON.stringify({
  id: 'agent-made', name: 'agent-made watch', command: `cat ${agentValue}`, intervalSeconds: 60, channel: 'C_AGENT', rateLimitMinutes: 30,
}))
process.env.DEEPBOT_HOME = agentHome
const emptyConfig = join(dir, 'empty.json')
writeFileSync(emptyConfig, JSON.stringify({ watches: [] }))
let agentOut = ''
try {
  agentOut = execFileSync(process.execPath, [WATCH, '--config', emptyConfig, '--state', join(dir, 'agent-state.json'), '--dry-run', '--force'], { encoding: 'utf8' })
} catch (e) { agentOut = String(e?.stdout ?? '') }
check('an agent-authored watch is loaded', /baseline recorded/.test(agentOut) || /agent-made/.test(agentOut), agentOut.split('\n')[0]?.slice(0, 80))
writeFileSync(agentValue, 'two')
let agentOut2 = ''
try {
  agentOut2 = execFileSync(process.execPath, [WATCH, '--config', emptyConfig, '--state', join(dir, 'agent-state.json'), '--dry-run', '--force'], { encoding: 'utf8' })
} catch (e) { agentOut2 = String(e?.stdout ?? '') }
check('and its change alerts to its own channel', /DRY-RUN alert to C_AGENT/.test(agentOut2), agentOut2.split('\n').find((l) => l.includes('DRY-RUN'))?.slice(0, 80) ?? '')
delete process.env.DEEPBOT_HOME

const state = JSON.parse(readFileSync(stateFile, 'utf8'))
check('the fingerprint was persisted', typeof state.watches?.test?.fingerprint === 'string')

rmSync(dir, { recursive: true, force: true })
const failed = results.filter((x) => !x.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
