/**
 * deepbot-harness — a Slack Socket Mode platform adapter that runs *inside* a
 * DeepSeek Harness gateway.
 *
 * It takes over the "messaging platform <-> agent" role without spawning a
 * process per message: it drives the already-running `agents` service of the
 * gateway, so sessions are created and resumed in process.
 *
 * ── Verified driving sequence ────────────────────────────────────────────────
 * The shipped one-shot runner (`dsh-headless`) and the in-process subagent
 * driver (`dsh-subagent-in-process-driver`) both use the same sequence:
 *
 *   agents.create({ sessionId, meta: { cwd }, agentOptions, setup })
 *     -> agent.whenIdle()
 *     -> agent.followup(userMessage)
 *     -> agent.whenIdle()
 *     -> sessions.flush(agent.session)
 *     -> read the last assistant text out of the session log
 *
 * Resuming a previous turn uses `agents.resume({ resumeSessionId,
 * agentOptions, setup })` instead of `create`. Session adoption is bound to the
 * recorded working directory, so this plugin resolves the cwd exactly once at
 * startup and reuses it for every turn.
 *
 * ── Why this file imports nothing ────────────────────────────────────────────
 * First-party plugins import helpers such as `createUserMessage` from
 * `@deepseek-ai/dsh-llm`. Those packages ship inside the application archive,
 * and a profile has no `node_modules` of its own, so a third-party plugin that
 * imports the same specifiers may fail to resolve them. Everything needed is
 * therefore inlined below, with its origin noted in each case:
 *
 *   brandString(...)        -> a plain string (the runtime brand is a tag only)
 *   createUserMessage(o)    -> deepFreeze(structuredClone({ ...o, role, id }))
 *   SessionSeq(n)           -> a plain number
 *   summarize()             -> same fold the one-shot runner performs
 *
 * The one thing that cannot be inlined is `installModelSelection`, which the
 * shipped runners call inside `setup` to pin the model selection. This plugin
 * passes `agentOptions` instead and reports a loud error if bootstrapping
 * fails. See MODEL_SELECTION below.
 *
 * Sanity check for the message identity: a user message needs an `id`. Without
 * it, the persisted log is rejected on the next read with
 * "session event at seq N lacks an identified message" and resume breaks.
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'platform-slack'

// Activate only after these services exist. dsh-base provides all of them.
export const inject = [
  'agents',
  'sessions',
  'agentDefaultModel',
  'credentials',
  'sessionQuery',
  'sessionPersistence',
]

// Config is validated by hand instead of with a schemastery schema, to keep the
// dependency surface at zero.
const DEFAULTS = {
  botTokenRef: 'SLACK_BOT_TOKEN',
  appTokenRef: 'SLACK_APP_TOKEN',
  replyMode: 'mention',
  maxConcurrency: 2,
  runTimeoutMs: 15 * 60 * 1000,
  maxPromptChars: 12000,
  chunkChars: 3500,
  stateDir: undefined,
  // Diagnostic: run a single turn with this prompt at startup, log the result,
  // and never touch Slack. This is the only way to exercise in-process session
  // creation without opening a Socket Mode connection.
  selfTest: undefined,
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }

  // ── Config validation: never fail silently ────────────────────────────────
  const problems = []
  if (!Array.isArray(cfg.targetChannels) || cfg.targetChannels.filter((c) => typeof c === 'string' && c.trim()).length === 0) {
    problems.push('targetChannels: at least one channel ID is required (this guard prevents answering everywhere)')
  }
  if (!['mention', 'all'].includes(cfg.replyMode)) problems.push(`replyMode: must be 'mention' or 'all' (got: ${String(cfg.replyMode)})`)
  if (problems.length > 0) throw new Error(`platform-slack config error:\n  - ${problems.join('\n  - ')}`)

  const targetChannels = cfg.targetChannels.map((c) => c.trim()).filter(Boolean)
  // '*' means "every channel the bot has been invited to".
  const allChannels = targetChannels.includes('*')
  // Channel ID prefixes: C=public, G=legacy private, D=DM, U=MPDM member.
  const isDirect = (channel) => typeof channel === 'string' && (channel.startsWith('D') || channel.startsWith('U'))

  const stateDir = cfg.stateDir ?? join(process.cwd(), 'slack-state')
  mkdirSync(stateDir, { recursive: true })
  const LOG = join(stateDir, 'platform-slack.log')
  const STATE = join(stateDir, 'sessions.json')

  const log = (...parts) => {
    const line = `${new Date().toISOString()} ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`
      .replace(/xox[baprs]-[A-Za-z0-9-]+/g, '<REDACTED>')
      .replace(/xapp-[A-Za-z0-9-]+/g, '<REDACTED>')
    ctx.logger?.info?.(line) ?? console.log(`[platform-slack] ${line}`)
    try { appendFileSync(LOG, line + '\n') } catch { /* never die because logging failed */ }
  }

  // ── State: channel:thread -> sessionId ────────────────────────────────────
  const state = loadState()
  let saveTimer = null
  function loadState() {
    if (!existsSync(STATE)) return { sessions: {}, seen: {} }
    try {
      const raw = JSON.parse(readFileSync(STATE, 'utf8'))
      return { sessions: raw.sessions ?? {}, seen: raw.seen ?? {} }
    } catch { return { sessions: {}, seen: {} } }
  }
  function saveState() {
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      try {
        const cutoff = Date.now() - 24 * 3600 * 1000
        for (const [k, v] of Object.entries(state.seen)) if (v < cutoff) delete state.seen[k]
        writeFileSync(STATE, JSON.stringify(state, null, 1))
      } catch (e) { log('state write failed', String(e)) }
    }, 500)
  }
  /** Slack redelivers events. Drop anything already handled. */
  function alreadySeen(eventId) {
    if (!eventId) return false
    if (state.seen[eventId]) return true
    state.seen[eventId] = Date.now()
    saveState()
    return false
  }

  // ── Credentials ───────────────────────────────────────────────────────────
  // ctx.credentials.resolve(ref) -> { value, source } | undefined.
  // An empty value means "absent" everywhere in the harness. process.env is the
  // highest-priority layer, so it doubles as the fallback here.
  async function credential(ref) {
    const creds = ctx.get('credentials')
    if (creds?.resolve) {
      try {
        const r = await creds.resolve(ref)
        if (r?.value) return r.value
      } catch (e) {
        log(`credentials.resolve(${ref}) failed — falling back to the environment`, String(e))
      }
    }
    return process.env[ref]
  }

  // ── Session cwd ───────────────────────────────────────────────────────────
  // Session resume is bound to the working directory: adoption compares the
  // recorded cwd. It must be a stable value, so it is resolved exactly once.
  let cwdPromise = null
  async function sessionCwd() {
    if (cwdPromise === null) {
      cwdPromise = (async () => {
        try {
          const fsSvc = ctx.get('fs')
          if (fsSvc?.resolve && fsSvc?.processPath) return fsSvc.processPath(await fsSvc.resolve('.'))
        } catch (e) { log('fs service unavailable for cwd — using process.cwd()', String(e)) }
        return process.cwd()
      })()
    }
    return cwdPromise
  }

  // ── createUserMessage, inlined ────────────────────────────────────────────
  // Upstream: dsh-llm `createMessage(input)` is
  //   deepFreeze(structuredClone({ ...input, id: brandString(randomUUID()) }))
  // and `createUserMessage` only adds role: 'user'.
  //
  // The `id` is load-bearing. Omit it and the stored log fails validation on the
  // next read ("lacks an identified message"), which silently breaks resume.
  function deepFreeze(value) {
    if (value !== null && typeof value === 'object') {
      for (const key of Object.keys(value)) deepFreeze(value[key])
      Object.freeze(value)
    }
    return value
  }
  function userMessage(text) {
    return deepFreeze(structuredClone({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
      role: 'user',
      id: randomUUID(),
    }))
  }

  // ── Drive one turn ────────────────────────────────────────────────────────
  /**
   * Create a session (or resume one) and drive it to completion.
   * @returns {Promise<{text: string, reason: unknown, sessionId: string}>}
   */
  async function runTurn(prompt, existingSessionId) {
    const agents = ctx.get('agents')
    const sessions = ctx.get('sessions')
    const defaultModel = ctx.get('agentDefaultModel')
    if (!agents || !sessions || !defaultModel) throw new Error('platform-slack: agents/sessions/agentDefaultModel missing')

    // The same selection is used for create and resume.
    const selection = defaultModel.currentSelection()
    const agentOptions = { provider: selection.provider, model: selection.model }
    const cwd = await sessionCwd()

    // MODEL_SELECTION: upstream calls installModelSelection(agentCtx, ...) here
    // to pin the model selection into the agent tree. That helper lives in
    // @deepseek-ai/dsh-agent and is not importable from a profile-installed
    // plugin, so only `agentOptions` is passed. If bootstrapping ever fails,
    // the surrounding catch surfaces the original error.
    const setup = (agentCtx) => {
      void agentCtx
    }

    let handle
    let sessionId = existingSessionId
    if (existingSessionId) {
      handle = await agents.resume({ resumeSessionId: existingSessionId, agentOptions, setup })
    } else {
      sessionId = `slack-${randomUUID()}`           // stands in for brandString(...)
      handle = await agents.create({ sessionId, meta: { cwd }, agentOptions, setup })
    }
    const agent = handle?.agent
    if (!agent?.followup || !agent?.whenIdle) throw new Error('platform-slack: agents.create/resume did not return an Agent')

    try {
      await agent.whenIdle()
      const firstSeq = agent.session.seq
      agent.followup(userMessage(prompt))
      await agent.whenIdle()
      await sessions.flush(agent.session)
      const outcome = summarize(agent.session, firstSeq)
      return { text: outcome.text, reason: outcome.reason, sessionId }
    } finally {
      // Release the agent after every turn. The log is persisted, so the next
      // turn can resume; keeping it alive would pile one agent per thread into
      // memory.
      try { await handle.dispose?.() } catch (e) { log('dispose failed', String(e)) }
    }
  }

  /**
   * Last assistant text and turn outcome over the owned interval.
   * Ported from the shipped one-shot runner's `summarize` (SessionSeq(n) -> n).
   */
  function summarize(session, firstSeq) {
    let started = false
    let text = ''
    let reason
    const length = session.seq
    for (let seq = firstSeq; seq < length; seq++) {
      const event = session.eventAt(seq)
      if (event === undefined) continue
      if (event.type === 'turn/start') { started = true; continue }
      if (!started) continue
      if (event.type === 'assistant/message') {
        const joined = (event.data?.message?.content ?? [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('')
        if (joined !== '') text = joined
      }
      if (event.type === 'turn/end') reason = event.data?.reason
    }
    return { text, reason }
  }

  // ── Slack Web API (built-in fetch) ────────────────────────────────────────
  async function slackPost(token, method, body) {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body ?? {}),
    })
    return res.json()
  }
  async function slackGet(token, method, params = {}) {
    const url = new URL(`https://slack.com/api/${method}`)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    return res.json()
  }

  /** DSH emits standard Markdown; Slack uses its own dialect. */
  function toSlackMarkdown(md) {
    return md
      .replace(/\*\*(.+?)\*\*/g, '*$1*')
      .replace(/^#{1,6}\s+(.*)$/gm, '*$1*')
      .replace(/^\s*[-*]\s+/gm, '• ')
  }

  async function say(botToken, channel, threadTs, text) {
    const chunks = []
    for (let i = 0; i < text.length; i += cfg.chunkChars) chunks.push(text.slice(i, i + cfg.chunkChars))
    if (chunks.length === 0) chunks.push('(empty response)')
    for (const [i, chunk] of chunks.entries()) {
      const r = await slackPost(botToken, 'chat.postMessage', {
        channel,
        thread_ts: threadTs,
        text: chunks.length > 1 ? `(${i + 1}/${chunks.length})\n${chunk}` : chunk,
      })
      if (!r.ok) log(`chat.postMessage failed: ${r.error} — check the chat:write scope and channel membership`)
    }
  }

  // ── Concurrency ───────────────────────────────────────────────────────────
  const queue = []
  let running = 0
  function enqueue(job) { queue.push(job); pump() }
  function pump() {
    while (running < cfg.maxConcurrency && queue.length > 0) {
      const job = queue.shift()
      running++
      Promise.resolve(job()).catch((e) => log('job threw', String(e))).finally(() => { running--; pump() })
    }
  }

  // ── Event handling ────────────────────────────────────────────────────────
  async function handleEvent(event, eventId, botToken, botUserId) {
    const channel = event.channel
    // Outside the allowlist, do nothing. '*' means every invited channel.
    if (!allChannels && !targetChannels.includes(channel)) return
    if (event.bot_id || event.subtype || event.edited) return     // bot/edit events
    if (!event.user || event.user === botUserId) return
    const isMention = event.type === 'app_mention'
    // DMs are answered without a mention; channels follow replyMode.
    const isDm = isDirect(channel) || event.channel_type === 'im' || event.channel_type === 'mpim'
    if (!isDm && cfg.replyMode === 'mention' && !isMention) return
    if (!event.text?.trim()) return
    if (alreadySeen(eventId)) { log(`duplicate event ignored event_id=${eventId}`); return }

    const threadTs = event.thread_ts ?? event.ts
    const key = `${channel}:${threadTs}`
    const prompt = event.text.replace(new RegExp(`<@${botUserId}>`, 'g'), '').trim().slice(0, cfg.maxPromptChars)
    if (!prompt) return

    log(`accepted channel=${channel} thread=${threadTs} session=${state.sessions[key] ?? 'new'}`)

    enqueue(async () => {
      const started = Date.now()
      try {
        const r = await withTimeout(runTurn(prompt, state.sessions[key]), cfg.runTimeoutMs)
        if (r.sessionId && r.sessionId !== state.sessions[key]) { state.sessions[key] = r.sessionId; saveState() }
        const ok = r.reason?.kind === 'completed'
        if (ok && r.text) {
          log(`answered channel=${channel} len=${r.text.length} ${Date.now() - started}ms`)
          await say(botToken, channel, threadTs, toSlackMarkdown(r.text))
        } else {
          log(`turn ended abnormally reason=${JSON.stringify(r.reason)}`)
          await say(botToken, channel, threadTs, `The turn did not complete (${r.reason?.kind ?? 'unknown'}). Log: ${LOG}`)
        }
      } catch (e) {
        log('turn failed', String(e?.stack ?? e))
        await say(botToken, channel, threadTs, `Execution failed: ${String(e?.message ?? e).slice(0, 300)}`)
      }
    })
  }

  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`turn timed out after ${Math.round(ms / 1000)}s`)), ms)
      promise.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
    })
  }

  // ── Socket Mode ───────────────────────────────────────────────────────────
  let ws = null
  let backoff = 1000
  let stopped = false
  let botToken = null
  let appToken = null

  async function openConnection() {
    // Two traps here, both hit in practice:
    //   1) this endpoint requires the *app-level* token (xapp-), not the bot
    //      token — a bot token yields `not_allowed_token_type`.
    //   2) it is POST-only — a GET yields `insecure_request`.
    const r = await slackPost(appToken, 'apps.connections.open', {})
    if (!r.ok) throw new Error(`apps.connections.open failed: ${r.error}`)
    return r.url
  }

  async function connect(botUserId) {
    if (stopped) return
    const url = await openConnection()
    ws = new WebSocket(url)

    ws.addEventListener('open', () => { backoff = 1000; log('Socket Mode connected') })

    ws.addEventListener('message', (msg) => {
      let env
      try { env = JSON.parse(msg.data) } catch { return }
      // Every envelope must be acknowledged within 3 seconds.
      if (env.envelope_id) {
        try { ws.send(JSON.stringify({ envelope_id: env.envelope_id })) } catch { /* reconnecting */ }
      }
      if (env.type === 'hello') { log('hello received'); return }
      if (env.type === 'disconnect') {
        log(`disconnect received (reason=${env.reason ?? '-'}) — reconnecting`)
        try { ws.close() } catch { /* ignore */ }
        return
      }
      if (env.type === 'events_api' && env.payload?.event) {
        // Acknowledge first, handle in the background.
        handleEvent(env.payload.event, env.payload.event_id, botToken, botUserId)
          .catch((e) => log('handleEvent threw', String(e)))
      }
    })

    ws.addEventListener('close', () => {
      if (stopped) return
      log(`connection closed — retrying in ${backoff}ms`)
      setTimeout(() => connect(botUserId).catch((e) => log('reconnect failed', String(e))), backoff)
      backoff = Math.min(backoff * 2, 60000)
    })

    ws.addEventListener('error', (e) => log('WebSocket error', String(e?.message ?? e)))
  }

  async function start() {
    // ── Diagnostic mode: exercise in-process session driving without Slack ──
    if (typeof cfg.selfTest === 'string' && cfg.selfTest.trim() !== '') {
      const cwd = await sessionCwd()
      log(`selfTest start — cwd=${cwd}`)
      try {
        const r1 = await withTimeout(runTurn(cfg.selfTest, undefined), cfg.runTimeoutMs)
        log(`selfTest turn 1: reason=${r1.reason?.kind} session=${r1.sessionId} text=${JSON.stringify(r1.text)}`)
        // Resume the same session, which is the path that memory depends on.
        const r2 = await withTimeout(runTurn('What did I just ask you? One line.', r1.sessionId), cfg.runTimeoutMs)
        log(`selfTest turn 2 (resumed): reason=${r2.reason?.kind} text=${JSON.stringify(r2.text)}`)
        log(`selfTest result: ${r1.reason?.kind === 'completed' && r2.reason?.kind === 'completed' ? 'session create + resume both succeeded' : 'a turn failed'}`)
      } catch (e) {
        log(`selfTest failed: ${String(e?.stack ?? e)}`)
      }
      return
    }

    botToken = await credential(cfg.botTokenRef)
    appToken = await credential(cfg.appTokenRef)
    if (!botToken) throw new Error(`platform-slack: credential ${cfg.botTokenRef} not found`)
    if (!appToken) throw new Error(`platform-slack: credential ${cfg.appTokenRef} not found`)

    const me = await slackGet(botToken, 'auth.test')
    if (!me.ok) throw new Error(`platform-slack: auth.test failed (${me.error}) — check the bot token`)

    const cwd = await sessionCwd()
    log(`starting — bot=@${me.user} team=${me.team} channels=${targetChannels.join(',')} mode=${cfg.replyMode}`)
    log(`session cwd=${cwd}  state=${stateDir}  mapped sessions=${Object.keys(state.sessions).length}`)

    await connect(me.user_id)
  }

  // ── Lifecycle: close the socket when the plugin unloads ───────────────────
  ctx.effect(() => {
    start().catch((e) => log('startup failed', String(e?.stack ?? e)))
    return () => {
      stopped = true
      try { ws?.close() } catch { /* ignore */ }
      log('plugin unloading — socket closed')
    }
  }, 'platform-slack: socket-mode')
}
