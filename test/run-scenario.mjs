#!/usr/bin/env node
/**
 * Run a scenario against the real agent services, in an isolated instance.
 *
 * Why this exists: verifying memory by hand means a human typing in Slack, a
 * symptom appearing, a patch, and another hand test. That loop is what this
 * replaces. A scenario is a JSON file of steps; the plugin's scenario mode runs
 * them and writes a result file, and this script turns that into an exit code.
 *
 * Isolation, so it is safe to run while the live instance is serving:
 *   - its own profile      (DEEPBOT_TEST_PROFILE, default agent-test)
 *   - its own agent home   (DEEPBOT_TEST_HOME,    default ~/dsh-agent-test)
 *   - its own FTS index    (the test profile points at a different path)
 *   - its own port
 *   - and it never connects to Slack: scenario mode returns before that.
 *
 * Usage:
 *   node test/run-scenario.mjs [scenario.json] [--keep] [--timeout 300]
 *
 * Exits 0 when every step passed, 1 when a step failed, 2 on setup problems.
 */

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

const args = process.argv.slice(2)
// Options that consume the next argument must be skipped when looking for the
// positional scenario path — otherwise `--timeout 240` reads as a scenario.
let scenarioArg
let timeoutS = 300
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--timeout') { timeoutS = Number(args[++i]); continue }
  if (arg.startsWith('--')) continue
  if (scenarioArg === undefined) scenarioArg = arg
}
const scenario = resolve(scenarioArg ?? join(HERE, 'scenarios', 'recall.json'))
const keep = args.includes('--keep')

const DSH_BIN = process.env.DSH_BIN ?? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const PROFILE = process.env.DEEPBOT_TEST_PROFILE ?? 'agent-test'
// A UNIQUE home per run, deliberately.
//
// The session store is bucketed by working directory, so reusing one home makes
// a second run inherit the first run's sessions and memory notes — and a recall
// assertion can then pass on stale state without this run proving anything. It
// looked green for exactly that reason once. A fresh home per run means the only
// thing recall can find is what this run wrote.
const TEST_HOME = process.env.DEEPBOT_TEST_HOME ?? join(homedir(), `dsh-agent-test-${Date.now().toString(36)}`)
const PORT = process.env.DEEPBOT_TEST_PORT ?? '19599'
const LIVE_HOME = process.env.DEEPBOT_LIVE_HOME ?? join(homedir(), 'dsh-agent')
// The result path is pinned outside the (fresh, disposable) agent home, because
// the plugin cannot predict a home that changes every run.
const RESULT = process.env.DEEPBOT_SCENARIO_RESULT ?? join(tmpdir(), `deepbot-scenario-${process.pid}.json`)

function fail(message) {
  console.error(`setup error: ${message}`)
  process.exit(2)
}

if (!existsSync(scenario)) fail(`scenario not found: ${scenario}`)
if (!existsSync(DSH_BIN)) fail(`dsh not found: ${DSH_BIN} (set DSH_BIN)`)

console.log(`scenario : ${scenario}`)
console.log(`profile  : ${PROFILE}`)
console.log(`home     : ${TEST_HOME}${process.env.DEEPBOT_TEST_HOME ? ' (pinned)' : ' (fresh)'}`)
console.log(`port     : ${PORT}`)
console.log()

// A test home mirrors the live one where it matters — the instruction file is
// what tells the agent that a recall index exists at all.
mkdirSync(TEST_HOME, { recursive: true })
for (const file of ['AGENTS.md', 'CLAUDE.md']) {
  const from = join(LIVE_HOME, file)
  if (existsSync(from)) cpSync(from, join(TEST_HOME, file))
}
mkdirSync(join(TEST_HOME, 'memory'), { recursive: true })
rmSync(RESULT, { force: true })

const child = spawn(DSH_BIN, ['--profile', PROFILE, '--port', PORT, '--no-open'], {
  cwd: TEST_HOME,
  env: {
    ...process.env,
    DEEPBOT_SELF_TEST_SCRIPT: scenario,
    DEEPBOT_RECALL_SCRIPT: join(REPO, 'recall', 'deepbot-recall.mjs'),
    DEEPBOT_SCENARIO_RESULT: RESULT,
    DEEPBOT_HOME: TEST_HOME,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let childOutput = ''
child.stdout.on('data', (d) => { childOutput += d })
child.stderr.on('data', (d) => { childOutput += d })

let finished = false
const started = Date.now()
const deadline = started + timeoutS * 1000

function stop(signal = 'SIGTERM') {
  try { child.kill(signal) } catch { /* already gone */ }
}

// Poll for the result file; the plugin writes it when the scenario completes.
while (Date.now() < deadline) {
  if (existsSync(RESULT)) { finished = true; break }
  if (child.exitCode !== null) break
  await new Promise((r) => setTimeout(r, 500))
}

stop()
await new Promise((r) => setTimeout(r, 1500))
if (child.exitCode === null) { stop('SIGKILL'); await new Promise((r) => setTimeout(r, 500)) }

if (!finished) {
  console.error(`scenario did not finish within ${timeoutS}s`)
  console.error('--- gateway output ---')
  console.error(childOutput.split('\n').slice(-40).join('\n'))
  if (!keep) rmSync(TEST_HOME, { recursive: true, force: true })
  process.exit(1)
}

const result = JSON.parse(readFileSync(RESULT, 'utf8'))
console.log('--- steps ---')
for (const step of result.steps) {
  const label = step.kind === 'rebuildIndex' ? 'rebuildIndex' : `${step.session}: ${JSON.stringify(step.say ?? '').slice(0, 60)}`
  console.log(`  ${step.ok ? 'PASS' : 'FAIL'}  step ${step.step}  ${label}`)
  if (step.kind === 'turn') console.log(`        answer: ${JSON.stringify((step.text ?? '').slice(0, 200))}`)
  if (!step.ok) console.log(`        ${step.error ?? (step.failedChecks ?? []).map((c) => `failed: ${c.what}`).join(', ')}`)
}
console.log()
console.log(`${result.total - result.failed}/${result.total} steps passed  (cwd ${result.cwd})`)

// Always clean the unique home unless asked to keep it: it exists only for this
// run, and leaving it would pollute the next run's session bucket.
if (!keep) rmSync(TEST_HOME, { recursive: true, force: true })
else console.log(`kept test home for inspection: ${TEST_HOME}`)

process.exit(result.failed === 0 ? 0 : 1)
