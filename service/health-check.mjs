#!/usr/bin/env node
/**
 * deepbot health probe.
 *
 * Why this exists: the bot once sat disconnected for 57 minutes while the process
 * was alive and the web UI answered 401. Everything outside looked healthy. A
 * process check cannot see that; only the plugin knows whether it holds a Slack
 * connection, so the plugin publishes its state and this probe reads it.
 *
 * What "unhealthy" means, in order of what it catches:
 *   - no health file at all          → the plugin never started
 *   - connected !== true             → dropped and not retrying
 *   - updatedAt older than STALE_MS  → wedged: alive, not logging, not scheduled
 *
 * On unhealthy it restarts the service, waits for recovery, and only then alerts
 * — so a transient blip that heals itself produces no noise. Alerts are
 * rate-limited, because an alert storm is its own outage.
 *
 * Usage:  node service/health-check.mjs [--status] [--dry-run]
 * Exit:   0 healthy, 1 unhealthy (restart and/or alert attempted), 2 setup error
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
const statusOnly = args.includes('--status')
const dryRun = args.includes('--dry-run')

const HEALTH_FILE = process.env.DEEPBOT_HEALTH_FILE ?? join(homedir(), '.dsh', 'slack-state', 'health.json')
const STALE_MS = Number(process.env.DEEPBOT_STALE_MS ?? 5 * 60 * 1000)
const LABEL = process.env.DEEPBOT_SERVICE_LABEL ?? 'ai.deepbot.gateway'
const UID = process.getuid?.() ?? 501
const ALERT_TO = process.env.DEEPBOT_ALERT_TO ?? ''           // Slack user id or channel id
const ALERT_MIN_MS = Number(process.env.DEEPBOT_ALERT_MIN_MS ?? 30 * 60 * 1000)
const STATE_FILE = process.env.DEEPBOT_HEALTH_STATE ?? join(homedir(), '.dsh', 'slack-state', 'health-probe.json')
const CREDENTIALS = process.env.DSH_HOME ? join(process.env.DSH_HOME, '.env') : join(homedir(), '.dsh', '.env')
const RECOVERY_WAIT_MS = Number(process.env.DEEPBOT_RECOVERY_WAIT_MS ?? 45000)

function readHealth() {
  if (!existsSync(HEALTH_FILE)) return { missing: true }
  try { return JSON.parse(readFileSync(HEALTH_FILE, 'utf8')) }
  catch (e) { return { unreadable: String(e?.message ?? e) } }
}

function diagnose(health) {
  if (health.missing) return 'no health file — the plugin has never started'
  if (health.unreadable) return `health file unreadable: ${health.unreadable}`
  if (health.connected !== true) {
    const since = health.disconnectedAt ? `${Math.round((Date.now() - health.disconnectedAt) / 1000)}s ago` : 'unknown'
    return `not connected (disconnected ${since}, failures in a row: ${health.consecutiveFailures ?? '?'})${health.lastError ? `, last error: ${health.lastError}` : ''}`
  }
  const age = Date.now() - (health.updatedAt ?? 0)
  if (age > STALE_MS) return `connection claims to be up but the heartbeat is ${Math.round(age / 1000)}s stale`
  return null
}

function loadProbeState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return { lastAlertAt: 0, lastRestartAt: 0 } }
}
function saveProbeState(state) {
  try { mkdirSync(dirname(STATE_FILE), { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(state, null, 1)) }
  catch { /* best effort */ }
}

function restartService() {
  if (dryRun) return 'dry-run: would restart'
  try {
    execFileSync('launchctl', ['kickstart', '-k', `gui/${UID}/${LABEL}`], { stdio: 'pipe' })
    return 'restart requested'
  } catch (e) {
    return `restart failed: ${String(e?.message ?? e)}`
  }
}

function envToken() {
  try {
    const line = readFileSync(CREDENTIALS, 'utf8').split('\n').find((l) => l.startsWith('SLACK_BOT_TOKEN='))
    return line ? line.slice('SLACK_BOT_TOKEN='.length).trim().replace(/^["']|["']$/g, '') : ''
  } catch { return '' }
}

async function alert(text) {
  const state = loadProbeState()
  if (Date.now() - state.lastAlertAt < ALERT_MIN_MS) return 'alert suppressed (rate limit)'
  if (!ALERT_TO) return 'no alert target configured (DEEPBOT_ALERT_TO)'
  const token = process.env.SLACK_BOT_TOKEN || envToken()
  if (!token) return 'no Slack token available for the alert'
  if (dryRun) return `dry-run: would alert ${ALERT_TO}`
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: ALERT_TO, text }),
    })
    const body = await res.json()
    if (!body.ok) return `alert failed: ${body.error}`
    state.lastAlertAt = Date.now()
    saveProbeState(state)
    return 'alert sent'
  } catch (e) {
    return `alert threw: ${String(e?.message ?? e)}`
  }
}

async function waitForRecovery(ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000))
    if (diagnose(readHealth()) === null) return true
  }
  return false
}

const health = readHealth()
const problem = diagnose(health)

if (statusOnly || problem === null) {
  const summary = problem === null
    ? `healthy — connected since ${health.connectedAt ? new Date(health.connectedAt).toISOString() : '?'}, accepted ${health.accepted ?? 0}, answered ${health.answered ?? 0}, heartbeat ${Math.round((Date.now() - (health.updatedAt ?? 0)) / 1000)}s old`
    : `unhealthy — ${problem}`
  console.log(summary)
  process.exit(problem === null ? 0 : 1)
}

console.log(`unhealthy — ${problem}`)
const restartResult = restartService()
console.log(`  ${restartResult}`)
const recovered = await waitForRecovery(RECOVERY_WAIT_MS)
console.log(recovered ? '  recovered after restart' : '  did NOT recover within the wait window')

if (recovered) {
  const state = loadProbeState(); state.lastRestartAt = Date.now(); saveProbeState(state)
  process.exit(1)                                  // it was down; a restart was needed
}

const note = await alert(`:rotating_light: deepbot is down and did not recover.\n> ${problem}\n> ${restartResult}`)
console.log(`  ${note}`)
process.exit(1)
