#!/usr/bin/env node
/**
 * deepbot-recall — build a greppable index of past sessions.
 *
 * Why an indexer instead of a tool plugin:
 *   The agent runs confined to its home directory, so it cannot read the session
 *   store itself, and the harness ships no model-facing session-search tool. This
 *   script runs on the HOST side (launchd or a shell), reads the compressed
 *   session logs, and writes a plain-text JSONL index *inside the agent's
 *   workspace*. The agent then recalls with the file tools it already has.
 *
 * Storage layout it reads:
 *   $DSH_HOME/sessions/<cwd-bucket>/<session-id>/session.v4.jsonl.zstd
 *
 * The log is zstd with one frame appended per write. `zstdDecompressSync` only
 * decodes the FIRST frame, so frames are split on the zstd magic number and
 * decoded one at a time. (Verified: a 31-event session decodes to 1 event with
 * the naive call and to all 31 events with the split.)
 *
 * Usage:
 *   deepbot-recall.mjs index [--out FILE] [--quiet]
 *   deepbot-recall.mjs search <query> [--limit N] [--index FILE]
 *   deepbot-recall.mjs recent [--limit N] [--index FILE]
 *   deepbot-recall.mjs show <sessionId> [--limit N] [--index FILE]
 *
 * Zero dependencies. Node 22+ (needs node:zlib zstd support).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/**
 * Where the agent lives. `DEEPBOT_HOME` wins so the launchd refresh job and the
 * agent's own shell agree with the gateway's configuration. The middle case
 * covers the common single-agent layout with no environment at all.
 */
function resolveAgentHome() {
  if (process.env.DEEPBOT_HOME) return process.env.DEEPBOT_HOME
  const conventional = join(homedir(), 'dsh-agent')
  if (existsSync(conventional)) return conventional
  return join(homedir(), '.deepbot')
}
const AGENT_HOME = resolveAgentHome()

const argv = process.argv.slice(2)
const command = argv[0] ?? 'index'
function flag(name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

/** Decode every zstd frame in a buffer and concatenate the plaintext. */
function decompressAllFrames(buf) {
  const starts = []
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf.compare(ZSTD_MAGIC, 0, 4, i, i + 4) === 0) starts.push(i)
  }
  if (starts.length === 0) return ''
  let out = ''
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]
    const to = i + 1 < starts.length ? starts[i + 1] : buf.length
    try {
      out += zstdDecompressSync(buf.subarray(from, to)).toString('utf8')
    } catch {
      // A partially written trailing frame is expected while a session is live.
    }
  }
  return out
}

/** Pull text blocks out of whichever shape this event carries. */
function textOf(event) {
  const candidates = [
    event?.data?.message?.content,
    event?.data?.content,
    ...(Array.isArray(event?.data?.inserted) ? event.data.inserted.map((m) => m?.content) : []),
  ]
  for (const content of candidates) {
    if (!Array.isArray(content)) continue
    const text = content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim()
    if (text !== '') return text
  }
  return ''
}

function roleOf(event) {
  if (event.type === 'user/message') return 'user'
  if (event.type === 'assistant/message') return 'assistant'
  return null
}

/**
 * The harness records system injections as user-role messages, so filtering by
 * role alone is not enough: measured on a real store, 33% of "user" messages
 * were injections (time-context, runtime-context, skill-catalog, user-approval,
 * agent-message, subagent-settled). Indexing them pollutes recall — a search for
 * "runtime" matches harness boilerplate instead of anything a person said.
 *
 * `source.kind` separates them cleanly: 'user' is human speech, 'model' is model
 * output. Anything else is protocol traffic. An absent kind is kept, so an
 * unknown shape is never silently dropped.
 */
function sourceKindOf(event) {
  return event?.data?.message?.source?.kind ?? event?.data?.source?.kind ?? null
}
const HUMAN_KINDS = new Set(['user'])
const MODEL_KINDS = new Set(['model'])

/** Find every session log under the store. */
function findSessionLogs(root) {
  const found = []
  if (!existsSync(root)) return found
  for (const bucket of readdirSync(root)) {
    const bucketPath = join(root, bucket)
    let entries
    try { if (!statSync(bucketPath).isDirectory()) continue; entries = readdirSync(bucketPath) } catch { continue }
    for (const entry of entries) {
      const file = join(bucketPath, entry, 'session.v4.jsonl.zstd')
      if (existsSync(file)) found.push({ file, sessionId: entry })
    }
  }
  return found
}

function readSession(file, sessionId, includeInjected) {
  const raw = decompressAllFrames(readFileSync(file))
  const lines = raw.split('\n').filter((l) => l.trim() !== '')
  const records = []
  let skippedInjected = 0
  let header = { id: sessionId, createdAt: undefined, cwd: undefined }
  for (const line of lines) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === 'session') {
      header = { id: event.id ?? sessionId, createdAt: event.createdAt, cwd: event.cwd }
      continue
    }
    const role = roleOf(event)
    if (role === null) continue
    const kind = sourceKindOf(event)
    if (!includeInjected && kind !== null) {
      const wanted = role === 'user' ? HUMAN_KINDS : MODEL_KINDS
      if (!wanted.has(kind)) { skippedInjected++; continue }
    }
    const text = textOf(event)
    if (text === '') continue
    records.push({
      sessionId: header.id ?? sessionId,
      ts: event.time ?? header.createdAt ?? null,
      seq: event.seq ?? null,
      role,
      ...(kind !== null ? { sourceKind: kind } : {}),
      text,
    })
  }
  return { header, records, skippedInjected }
}

function buildIndex(outFile, quiet) {
  const logs = findSessionLogs(join(DSH_HOME, 'sessions'))
  // Privacy default: only the agent's own sessions. The store is shared by every
  // profile and working directory, so indexing everything would let the bot
  // recall unrelated contexts (other profiles' sessions, build/planning runs).
  // Pass --all-cwds to index the entire store deliberately.
  const includeAllCwds = argv.includes('--all-cwds')
  // --include-injected indexes harness protocol traffic too (debugging only).
  const includeInjected = argv.includes('--include-injected')
  const wantedCwd = flag('cwd', AGENT_HOME)
  const all = []
  const perSession = []
  let skippedOtherCwd = 0
  let injected = 0
  for (const { file, sessionId } of logs) {
    let parsed
    try { parsed = readSession(file, sessionId, includeInjected) } catch (e) {
      if (!quiet) console.error(`  skip ${sessionId}: ${String(e.message ?? e)}`)
      continue
    }
    if (!includeAllCwds && parsed.header.cwd !== wantedCwd) { skippedOtherCwd++; continue }
    injected += parsed.skippedInjected ?? 0
    if (parsed.records.length === 0) continue
    all.push(...parsed.records)
    perSession.push({
      sessionId: parsed.header.id ?? sessionId,
      cwd: parsed.header.cwd,
      startedAt: parsed.header.createdAt,
      messages: parsed.records.length,
    })
  }
  all.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || (a.seq ?? 0) - (b.seq ?? 0))
  mkdirSync(dirname(outFile), { recursive: true })
  writeFileSync(outFile, all.map((r) => JSON.stringify(r)).join('\n') + (all.length ? '\n' : ''))
  writeFileSync(
    outFile.replace(/\.jsonl$/, '.sessions.json'),
    JSON.stringify({
      generatedAt: Date.now(),
      scope: includeAllCwds ? 'all working directories' : wantedCwd,
      skippedOtherCwd,
      skippedInjected: injected,
      sessions: perSession.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)),
    }, null, 1),
  )
  if (!quiet) {
    console.log(`indexed ${all.length} messages from ${perSession.length} session(s) -> ${outFile}`)
    if (skippedOtherCwd > 0) {
      console.log(`  ${skippedOtherCwd} session(s) skipped (different working directory; use --all-cwds to include)`)
    }
    if (injected > 0) {
      console.log(`  ${injected} injected protocol message(s) skipped (use --include-injected to keep)`)
    }
  }
  return { messages: all.length, sessions: perSession.length }
}

function loadIndex(indexFile) {
  if (!existsSync(indexFile)) {
    console.error(`no index at ${indexFile} — run: deepbot-recall.mjs index`)
    process.exit(2)
  }
  return readFileSync(indexFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
}

function fmtTime(ms) {
  if (!ms) return '?'
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function snippet(text, query, width = 160) {
  const flat = text.replace(/\s+/g, ' ')
  if (!query) return flat.slice(0, width)
  const at = flat.toLowerCase().indexOf(query.toLowerCase())
  if (at < 0) return flat.slice(0, width)
  const from = Math.max(0, at - 60)
  return (from > 0 ? '…' : '') + flat.slice(from, from + width)
}

const INDEX_DEFAULT = join(AGENT_HOME, 'memory', 'recall-index.jsonl')

switch (command) {
  case 'index':
    buildIndex(flag('out', INDEX_DEFAULT), argv.includes('--quiet'))
    break

  case 'search': {
    const query = argv[1]
    if (!query) { console.error('usage: deepbot-recall.mjs search <query>'); process.exit(2) }
    const limit = Number(flag('limit', 20))
    const hits = loadIndex(flag('index', INDEX_DEFAULT)).filter((r) => r.text.toLowerCase().includes(query.toLowerCase()))
    console.log(`${hits.length} match(es) for ${JSON.stringify(query)}`)
    for (const r of hits.slice(0, limit)) {
      console.log(`  [${fmtTime(r.ts)}] ${r.role} (${r.sessionId})`)
      console.log(`    ${snippet(r.text, query)}`)
    }
    break
  }

  case 'recent': {
    const limit = Number(flag('limit', 20))
    const all = loadIndex(flag('index', INDEX_DEFAULT))
    for (const r of all.slice(-limit)) {
      console.log(`[${fmtTime(r.ts)}] ${r.role} (${r.sessionId}) ${snippet(r.text, null, 120)}`)
    }
    break
  }

  case 'show': {
    const sessionId = argv[1]
    if (!sessionId) { console.error('usage: deepbot-recall.mjs show <sessionId>'); process.exit(2) }
    const limit = Number(flag('limit', 50))
    const rows = loadIndex(flag('index', INDEX_DEFAULT)).filter((r) => r.sessionId === sessionId).slice(-limit)
    console.log(`${rows.length} message(s) in ${sessionId}`)
    for (const r of rows) console.log(`  [${fmtTime(r.ts)}] ${r.role}: ${r.text.replace(/\s+/g, ' ').slice(0, 300)}`)
    break
  }

  case 'sessions': {
    const meta = flag('index', INDEX_DEFAULT).replace(/\.jsonl$/, '.sessions.json')
    if (!existsSync(meta)) { console.error(`no session metadata at ${meta} — run index first`); process.exit(2) }
    const d = JSON.parse(readFileSync(meta, 'utf8'))
    console.log(`${d.sessions.length} session(s), generated ${fmtTime(d.generatedAt)}`)
    for (const s of d.sessions) console.log(`  ${fmtTime(s.startedAt)}  ${String(s.messages).padStart(4)} msgs  ${s.sessionId}`)
    break
  }

  default:
    console.error(`unknown command: ${command}\ncommands: index | search | recent | show | sessions`)
    process.exit(2)
}
