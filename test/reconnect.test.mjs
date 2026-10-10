/**
 * Regression tests for the reconnect logic.
 *
 * Context: an earlier version scheduled exactly ONE retry inside the close
 * handler. When that retry failed (a transient network error while the machine
 * was asleep), the catch only logged it and the chain ended. The process stayed
 * alive, the web UI stayed healthy, and the bot silently answered nothing in
 * Slack for 57 minutes, with no log line after the failure.
 *
 * These tests drive `apply()` against a mock context and a fake WebSocket, and
 * assert the loops keep going.
 *
 * Run: node test/reconnect.test.mjs
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../dist/index.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Minimal Cordis-like context: only what the plugin touches. */
function makeCtx(logs) {
  const services = {
    credentials: { resolve: async () => undefined },   // fall through to process.env
  }
  return {
    get: (name) => services[name],
    effect: (fn) => {
      const disposer = fn()
      return disposer
    },
    logger: { info: (line) => logs.push(line) },
  }
}

function readLog(stateDir) {
  try { return readFileSync(join(stateDir, 'deepbot.log'), 'utf8') } catch { return '' }
}

// ── Scenario A: startup cannot resolve a session, and must keep trying ───────
async function scenarioStartupRetry() {
  console.log('\nA) startup failure retries instead of stopping')
  const stateDir = mkdtempSync(join(tmpdir(), 'deepbot-a-'))
  const logs = []
  process.env.SLACK_BOT_TOKEN = 'xoxb-fake'
  process.env.SLACK_APP_TOKEN = 'xapp-fake'
  // Every Slack API call fails, standing in for "credentials wrong / network down".
  globalThis.fetch = async () => ({ json: async () => ({ ok: false, error: 'invalid_auth' }) })

  apply(makeCtx(logs), { targetChannels: ['*'], stateDir })
  await sleep(6000)

  const text = readLog(stateDir)
  const attempts = (text.match(/startup failed/g) ?? []).length
  check('startup retried more than once', attempts >= 2, `${attempts} attempt(s)`)
  check('startup retry grew the backoff', /retrying in \d+ms/.test(text))
  rmSync(stateDir, { recursive: true, force: true })
}

// ── Scenario B: a live connection drops and reconnect keeps failing ──────────
async function scenarioReconnectRetry() {
  console.log('\nB) a failed reconnect keeps retrying')
  const stateDir = mkdtempSync(join(tmpdir(), 'deepbot-b-'))
  const logs = []
  process.env.SLACK_BOT_TOKEN = 'xoxb-fake'
  process.env.SLACK_APP_TOKEN = 'xapp-fake'

  globalThis.fetch = async (url) => ({
    json: async () => {
      const u = String(url)
      if (u.includes('auth.test')) return { ok: true, user: 'testbot', user_id: 'U_TEST', team: 'T_TEST' }
      if (u.includes('apps.connections.open')) return { ok: true, url: 'wss://fake.invalid/link' }
      return { ok: true }
    },
  })

  // A socket that opens and then immediately closes: this is the drop path.
  let sockets = 0
  class FakeWebSocket {
    constructor() {
      sockets++
      this.listeners = { open: [], close: [], message: [], error: [] }
      setTimeout(() => {
        for (const fn of this.listeners.open) fn()
        setTimeout(() => { for (const fn of this.listeners.close) fn() }, 20)
      }, 10)
    }
    addEventListener(type, fn) { this.listeners[type].push(fn) }
    close() {}
    send() {}
  }
  globalThis.WebSocket = FakeWebSocket

  apply(makeCtx(logs), { targetChannels: ['*'], stateDir })
  await sleep(9000)

  const text = readLog(stateDir)
  check('initial connection was established', /Socket Mode connected/.test(text))
  const closes = (text.match(/connection closed/g) ?? []).length
  const scheduled = (text.match(/reconnect scheduled/g) ?? []).length
  check('a drop was observed', closes >= 1, `${closes} close(s)`)
  check('reconnect kept being scheduled after drops', scheduled >= 2, `${scheduled} schedule(s)`)
  rmSync(stateDir, { recursive: true, force: true })
}

await scenarioStartupRetry()
await scenarioReconnectRetry()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
