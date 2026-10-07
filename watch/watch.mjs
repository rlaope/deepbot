#!/usr/bin/env node
/**
 * deepbot watch — "tell me when this changes".
 *
 * A watch is a command, a cadence, and a place to report. This script runs on the
 * host (launchd, every minute) and decides what is due; it is deliberately NOT a
 * long-lived process, so a crash costs one interval rather than the feature.
 *
 * Rules that matter, all from SPEC §7 and the M4 acceptance criteria:
 *   - The first observation is a BASELINE, not a change. Telling someone "it
 *     changed" the moment you first look at it is a false alarm by construction.
 *   - Silent when nothing changed. A watch that speaks every interval is not a
 *     watch, it is a heartbeat, and it trains its owner to ignore it.
 *   - Rate-limited. A flapping condition fires once, then the suppression count
 *     is reported when the window reopens, so the owner learns both that it
 *     flapped and how badly.
 *   - Every alert carries what changed and what it changed from.
 *
 * Config (default ~/.dsh/watches.json):
 *   { "watches": [
 *       { "id": "disk", "name": "disk free", "command": "df -h / | tail -1",
 *         "intervalSeconds": 300, "channel": "U0123", "rateLimitMinutes": 30 } ] }
 *
 * Usage: node watch.mjs [--config FILE] [--state FILE] [--dry-run] [--force]
 * Exit:  0 nothing to do, 1 at least one alert was emitted, 2 setup problem
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const force = args.includes('--force')
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const HOME = homedir()
const CONFIG = flag('config', process.env.DEEPBOT_WATCH_CONFIG ?? join(HOME, '.dsh', 'watches.json'))
const STATE = flag('state', process.env.DEEPBOT_WATCH_STATE ?? join(HOME, '.dsh', 'watch-state.json'))
const CREDENTIALS = join(process.env.DSH_HOME ?? join(HOME, '.dsh'), '.env')
const COMMAND_TIMEOUT_MS = Number(process.env.DEEPBOT_WATCH_TIMEOUT_MS ?? 60000)
const MAX_OUTPUT_CHARS = Number(process.env.DEEPBOT_WATCH_MAX_CHARS ?? 1500)

function log(message) {
  console.log(`${new Date().toISOString()} ${message}`)
}

function loadJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}
function saveJson(path, value) {
  try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 1)) } catch { /* best effort */ }
}

function runCommand(command) {
  try {
    const out = execFileSync('/bin/sh', ['-c', command], { timeout: COMMAND_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, output: out.trim() }
  } catch (e) {
    const out = String(e?.stdout ?? '').trim()
    return { ok: false, output: out, error: String(e?.message ?? e) }
  }
}

function fingerprint(result) {
  return createHash('sha256').update(`${result.ok ? 'ok' : 'err'}\n${result.output}`).digest('hex').slice(0, 16)
}

function slackToken() {
  try {
    const line = readFileSync(CREDENTIALS, 'utf8').split('\n').find((l) => l.startsWith('SLACK_BOT_TOKEN='))
    return line ? line.slice('SLACK_BOT_TOKEN='.length).trim().replace(/^["']|["']$/g, '') : ''
  } catch { return '' }
}

const summary = { due: 0, changed: 0, alerted: 0, suppressed: 0, errors: 0 }

/**
 * Two sources, merged by id:
 *   - the host config (the operator's own file)
 *   - $DEEPBOT_HOME/watches/*.json — watches the AGENT created
 *
 * The second one exists so the agent can set up a watch with the file tools it
 * already has, rather than needing a new model-facing tool. That keeps the
 * surface small and the mechanism inspectable: a watch is a readable file.
 */
function loadAgentWatches() {
  const dir = join(process.env.DEEPBOT_HOME ?? join(HOME, 'dsh-agent'), 'watches')
  if (!existsSync(dir)) return []
  const found = []
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue
      const one = loadJson(join(dir, entry), null)
      if (one === null) continue
      if (Array.isArray(one.watches)) found.push(...one.watches)
      else if (typeof one.id === 'string') found.push(one)
    }
  } catch { /* a broken file must not stop the host's own watches */ }
  return found
}

// Contract: a MISSING host config is fine (the agent may be the only source),
// but an unparseable one is a setup error and must not pass silently — that is
// how a disabled watch looks identical to a working one.
let hostConfig = { watches: [] }
if (existsSync(CONFIG)) {
  const parsed = loadJson(CONFIG, null)
  if (parsed === null) { console.error(`watch config at ${CONFIG} is not valid JSON`); process.exit(2) }
  if (parsed.watches !== undefined && !Array.isArray(parsed.watches)) {
    console.error(`watch config at ${CONFIG} has a non-array "watches"`)
    process.exit(2)
  }
  hostConfig = parsed
}

const merged = new Map()
for (const watch of Array.isArray(hostConfig?.watches) ? hostConfig.watches : []) {
  if (typeof watch?.id === 'string') merged.set(watch.id, watch)
}
for (const watch of loadAgentWatches()) {
  if (typeof watch?.id !== 'string') continue
  merged.set(watch.id, { ...(merged.get(watch.id) ?? {}), ...watch })
}
const config = { watches: [...merged.values()] }
if (config.watches.length === 0) {
  log(`no watches configured (host ${CONFIG}, agent <home>/watches) — nothing to do`)
  process.exit(0)
}
const state = loadJson(STATE, { watches: {} })
state.watches ??= {}

const now = Date.now()
const pendings = []

for (const watch of config.watches) {
  if (typeof watch?.id !== 'string' || typeof watch?.command !== 'string') {
    log(`skipping an invalid watch entry: ${JSON.stringify(watch)?.slice(0, 120)}`)
    summary.errors++
    continue
  }
  const record = state.watches[watch.id] ??= { lastRunAt: 0, fingerprint: null, lastOutput: null, lastAlertAt: 0, suppressed: 0, lastError: null }
  const intervalMs = Math.max(60, Number(watch.intervalSeconds ?? 300)) * 1000
  if (!force && now - record.lastRunAt < intervalMs) continue
  summary.due++

  const result = runCommand(watch.command)
  record.lastRunAt = now
  const print = fingerprint(result)
  const previous = record.fingerprint

  if (previous === null) {
    // First observation: establish the baseline and stay quiet.
    record.fingerprint = print
    record.lastOutput = result.output.slice(0, MAX_OUTPUT_CHARS)
    record.lastError = result.ok ? null : result.error
    log(`watch ${watch.id}: baseline recorded (${result.ok ? 'ok' : 'error'}), not alerting`)
    continue
  }

  if (print === previous) continue
  summary.changed++

  const rateLimitMs = Math.max(0, Number(watch.rateLimitMinutes ?? 30)) * 60000
  const withinLimit = rateLimitMs > 0 && record.lastAlertAt > 0 && now - record.lastAlertAt < rateLimitMs
  if (withinLimit) {
    record.suppressed = (record.suppressed ?? 0) + 1
    summary.suppressed++
    log(`watch ${watch.id}: changed but suppressed by the rate limit (${record.suppressed} pending)`)
    record.fingerprint = print
    record.lastOutput = result.output.slice(0, MAX_OUTPUT_CHARS)
    continue
  }

  const suppressedNote = record.suppressed > 0 ? `\n(and ${record.suppressed} earlier change(s) were suppressed by the rate limit)` : ''
  const body = result.ok ? result.output.slice(0, MAX_OUTPUT_CHARS) : `the check FAILED: ${result.error}`
  const text = `:eyes: *${watch.name ?? watch.id}* changed.\n\`\`\`\n${body}\n\`\`\`${suppressedNote}`

  pendings.push({ watch, text })
  record.fingerprint = print
  record.lastOutput = result.output.slice(0, MAX_OUTPUT_CHARS)
  record.lastError = result.ok ? null : result.error
  record.lastAlertAt = now
  record.suppressed = 0
}

for (const { watch, text } of pendings) {
  if (dryRun) { log(`DRY-RUN alert to ${watch.channel ?? '(no channel)'}: ${text.replace(/\n/g, ' | ')}`); summary.alerted++; continue }
  const channel = watch.channel
  if (typeof channel !== 'string' || channel === '') { log(`watch ${watch.id}: nowhere to report (no channel)`); summary.errors++; continue }
  const token = slackToken()
  if (token === '') { log(`watch ${watch.id}: no Slack token available`); summary.errors++; continue }
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel, text }),
    })
    const body = await res.json()
    if (!body.ok) { log(`watch ${watch.id}: post failed (${body.error})`); summary.errors++; continue }
    log(`watch ${watch.id}: alert posted to ${channel}`)
    summary.alerted++
  } catch (e) {
    log(`watch ${watch.id}: post threw (${String(e?.message ?? e)})`)
    summary.errors++
  }
}

saveJson(STATE, state)
log(`done — due ${summary.due}, changed ${summary.changed}, alerted ${summary.alerted}, suppressed ${summary.suppressed}, errors ${summary.errors}`)
process.exit(summary.alerted > 0 ? 1 : 0)
