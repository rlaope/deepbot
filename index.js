/**
 * deepbot — a Slack Socket Mode platform adapter that runs *inside* a
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

import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSlackApi } from './transports/slack.mjs'

export const name = 'deepbot'

// Activate only after these services exist. dsh-base provides all of them.
export const inject = [
  'agents',
  'sessions',
  'agentDefaultModel',
  'credentials',
  'sessionQuery',
  'sessionPersistence',
  // Session composition. Declared so the adapter activates only once these exist:
  // an agent composed without a preset has no tools, and that failure is silent.
  'agentPresets',
  'permissionPresets',
  'workspaceRegistry',
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
  // Context injection.
  //
  // The harness's own AGENTS.md loader is workspace-scoped, and this adapter
  // creates sessions without attaching a workspace — so the agent received NO
  // instructions at all: a measured system prompt was 2861 characters of base
  // persona and tool boilerplate, with zero occurrences of the agent's identity
  // file. Read the instruction chain here and carry it in the prompt instead.
  // Slack history. A bot has no memory of what was said before it was mentioned,
  // and "summarize the conversation above" is one of the most common things asked
  // of a channel bot. Measured live: the model answered that the conversation did
  // not exist, because nothing had ever told it what was above.
  // Attachments. A user who drops a file into Slack expects the agent to see it;
  // before this the file was simply invisible, because Slack sends only a
  // reference and nothing fetched it.
  // Progress. A turn can take a minute, and a silent thread is indistinguishable
  // from a dead bot — the failure this project already had once.
  progressAfterMs: 8000,
  progressText: ':hourglass_flowing_sand: 작업 중입니다…',
  downloadAttachments: true,
  maxAttachmentBytes: 10 * 1024 * 1024,
  attachmentsDir: undefined,        // default: <cwd>/attachments
  attachmentTextChars: 4000,        // how much of a text-like file to inline
  fetchHistory: true,
  historyLimit: 20,
  historyMaxChars: 9000,
  injectInstructions: true,
  maxInstructionChars: 12000,
  maxMemoryChars: 6000,
  // Persona and memory files, following the convention the owner already uses
  // elsewhere. Three separate files because they change at different rates and
  // for different reasons: who the agent is, who the user is, what has been
  // learned. All are injected every turn, so each has its own budget — an
  // unbounded profile file is a prompt that grows until it is cut off.
  personaFile: 'SOUL.md',           // who the agent is, and its voice
  userFile: 'USER.md',              // durable facts about the user
  factsFile: 'MEMORY.md',           // durable facts about the work
  maxPersonaChars: 6000,
  maxUserChars: 4000,
  maxFactsChars: 4000,
  // Session composition. An agent's tools are NOT global: they are composed by
  // an agent preset, mounted into that agent's own context. Creating a session
  // without mounting one yields an agent with no tools at all — which is what
  // happened here for days, and it looked like a memory bug because the agent
  // could not read the file it was told to search.
  //
  // The reference implementation (dsh-webhook) does the same five steps:
  // resolve the permission preset, resolve the agent preset, acquire its scope,
  // create the workspace, then mount the preset inside `setup` and attach the
  // session to the workspace.
  // Health. A process that is running but disconnected looks perfectly healthy
  // from outside — that is how a 57-minute outage went unnoticed. The plugin
  // publishes what it actually knows, and an external probe reads it.
  healthFile: undefined,          // default: <stateDir>/health.json
  heartbeatMs: 60000,
  // Diagnostic: log the assembled context preamble and exit path, so what the
  // agent actually sees can be inspected instead of guessed. Never opens a socket.
  contextProbe: process.env.DEEPBOT_CONTEXT_PROBE === '1',
  // Diagnostic: "<channel>:<message ts>" — download that message's attachments
  // and log the manifest, without opening a Socket Mode connection.
  attachmentProbe: process.env.DEEPBOT_ATTACHMENT_PROBE ?? undefined,
  // Diagnostic: "<channel>" or "<channel>:<thread_ts>" — fetch a transcript,
  // log it, and never open a Socket Mode connection.
  historyProbe: process.env.DEEPBOT_HISTORY_PROBE ?? undefined,
  agentPreset: 'standard',
  // Unset by default: the deployment's own default governs. This adapter used to
  // force 'workspace-write' on every session, which silently re-applied
  // approval=ask over a profile that had deliberately chosen approval=never — and
  // approval=ask with no answerer is how a turn hung forever. A bot should not
  // overrule a permission decision the deployment made on purpose.
  permissionPreset: undefined,
  attachWorkspace: true,
  // Diagnostic: run a single turn with this prompt at startup, log the result,
  // and never touch Slack. This is the only way to exercise in-process session
  // creation without opening a Socket Mode connection.
  selfTest: undefined,
  // Scenario mode (the test harness). A JSON file of steps executed against the
  // real services, with assertions. Nothing here touches Slack. This exists so
  // memory can be verified by a command instead of by a human typing in Slack.
  selfTestScript: process.env.DEEPBOT_SELF_TEST_SCRIPT ?? undefined,
  // The host-side indexer, used by a `rebuildIndex` scenario step. Without it a
  // recall test would depend on the periodic refresh job's timing.
  recallScript: process.env.DEEPBOT_RECALL_SCRIPT ?? undefined,
  // Keep the episodic index current instead of waiting for the periodic job.
  // Measured: the indexer costs ~0.4s for 61 session logs, so a per-turn refresh
  // is affordable, and a 10-minute window makes "what did we just discuss?"
  // fail in exactly the situation it is asked.
  autoIndex: true,
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }

  // ── Config validation: never fail silently ────────────────────────────────
  const problems = []
  if (!Array.isArray(cfg.targetChannels) || cfg.targetChannels.filter((c) => typeof c === 'string' && c.trim()).length === 0) {
    problems.push('targetChannels: at least one channel ID is required (this guard prevents answering everywhere)')
  }
  if (!['mention', 'all'].includes(cfg.replyMode)) problems.push(`replyMode: must be 'mention' or 'all' (got: ${String(cfg.replyMode)})`)
  if (problems.length > 0) throw new Error(`deepbot config error:\n  - ${problems.join('\n  - ')}`)

  const targetChannels = cfg.targetChannels.map((c) => c.trim()).filter(Boolean)
  // '*' means "every channel the bot has been invited to".
  const allChannels = targetChannels.includes('*')
  // Channel ID prefixes: C=public, G=legacy private, D=DM, U=MPDM member.
  const isDirect = (channel) => typeof channel === 'string' && (channel.startsWith('D') || channel.startsWith('U'))

  const stateDir = cfg.stateDir ?? join(process.cwd(), 'slack-state')
  mkdirSync(stateDir, { recursive: true })
  const LOG = join(stateDir, 'deepbot.log')
  const STATE = join(stateDir, 'sessions.json')

  const log = (...parts) => {
    const line = `${new Date().toISOString()} ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`
      .replace(/xox[baprs]-[A-Za-z0-9-]+/g, '<REDACTED>')
      .replace(/xapp-[A-Za-z0-9-]+/g, '<REDACTED>')
    ctx.logger?.info?.(line) ?? console.log(`[deepbot] ${line}`)
    try { appendFileSync(LOG, line + '\n') } catch { /* never die because logging failed */ }
  }

  // ── Health ────────────────────────────────────────────────────────────────
  // Written on every connection change, every handled message, and on a timer.
  // The probe treats a stale file as unhealthy too, which covers a wedged
  // process (alive, not scheduled, not logging).
  const HEALTH = cfg.healthFile ?? join(stateDir, 'health.json')
  const health = {
    pid: process.pid,
    startedAt: Date.now(),
    connected: false,
    connectedAt: null,
    disconnectedAt: null,
    connectAttempts: 0,
    consecutiveFailures: 0,
    accepted: 0,
    answered: 0,
    lastEventAt: null,
    lastError: null,
    updatedAt: Date.now(),
  }
  let healthTimer = null
  function writeHealth() {
    health.updatedAt = Date.now()
    try { writeFileSync(HEALTH, JSON.stringify(health, null, 1)) } catch { /* never die for this */ }
  }

  // ── State: channel:thread -> sessionId ────────────────────────────────────
  const state = loadState()

  // Restart continuity. A scenario that spans a process restart cannot keep its
  // mapping in memory, so the runner seeds it on the way in and collects it on
  // the way out.
  //
  // This is a SEPARATE map from `state.sessions`: that one is keyed by
  // channel:thread for real Slack threads, this one by scenario session name.
  // Putting the seed in the wrong one looked like it worked (it logged) and had
  // no effect, which is why the first restart test created a brand-new session
  // and quietly answered nothing useful.
  const seededSessions = {}
  if (process.env.DEEPBOT_SESSION_SEED) {
    try {
      const seed = JSON.parse(readFileSync(process.env.DEEPBOT_SESSION_SEED, 'utf8'))
      for (const [name, id] of Object.entries(seed.sessions ?? {})) seededSessions[name] = id
      log(`seeded ${Object.keys(seededSessions).length} scenario session(s) from the runner`)
    } catch (e) { log(`could not read the session seed: ${String(e?.message ?? e)}`) }
  }
  let saveTimer = null
  function loadState() {
    if (!existsSync(STATE)) return { sessions: {}, seen: {}, standing: {}, history: {} }
    try {
      const raw = JSON.parse(readFileSync(STATE, 'utf8'))
      return {
        sessions: raw.sessions ?? {},
        seen: raw.seen ?? {},
        // Per-session digest of the standing context last sent, and the newest
        // thread message already delivered. Both avoid re-sending what the model
        // already has.
        standing: raw.standing ?? {},
        history: raw.history ?? {},
      }
    } catch { return { sessions: {}, seen: {}, standing: {}, history: {} } }
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

  // ── Context injection ─────────────────────────────────────────────────────
  /**
   * Per-turn context carrier.
   *
   * The instruction chain and the agent's own notes are read from the session
   * working directory and prepended to the user's text. This is a deliberate
   * workaround, not the harness-native path: a plugin that could attach a
   * workspace would let `agent-instructions` do it. Until then, carrying it in
   * the prompt is the only lever a platform adapter has, and an agent that never
   * sees its own instructions is worse than one with a slightly padded prompt.
   *
   * Everything injected here is content, not authority: recalled notes are
   * marked as data so the model does not treat them as permission.
   */
  function readTextIfPresent(path, limit) {
    try {
      if (!existsSync(path)) return null
      const text = readFileSync(path, 'utf8')
      if (text.trim() === '') return null
      return text.length > limit ? text.slice(0, limit) + '\n…(truncated)' : text
    } catch { return null }
  }

  /** A compact index of the agent's own notes: name and opening line, not the body. */
  function memoryIndex(cwd) {
    const dir = join(cwd, 'memory')
    if (!existsSync(dir)) return ''
    const lines = []
    try {
      for (const file of readdirSync(dir).sort()) {
        if (!file.endsWith('.md')) continue          // skip recall-index.* and friends
        const text = readTextIfPresent(join(dir, file), cfg.maxMemoryChars)
        if (text === null) continue
        const first = text.split('\n').find((l) => l.trim() !== '' && !l.trim().startsWith('<!--')) ?? ''
        lines.push(`- memory/${file} — ${first.trim().slice(0, 100)}`)
      }
    } catch { /* a missing notes directory is normal */ }
    return lines.length === 0 ? '' : `[your notes] Topic notes that already exist. Open one when it is relevant:\n${lines.join('\n')}`
  }

  /**
   * The per-turn context, split by how it behaves over time.
   *
   * Standing context does not change between turns, so it goes in only when its
   * content changes. Repeating it every turn costs a fixed amount of prompt per
   * turn and rewrites the prefix that prompt caching reuses.
   *
   * Dynamic context is new by nature: attachments, and only the messages that
   * arrived since the last turn.
   *
   * The four standing files — SOUL.md, AGENTS.md, USER.md, MEMORY.md — are
   * deliberately not injected here. dsh-agent-instructions appends them once as a
   * durable baseline, adds only deltas afterwards, and is built so that new
   * content does not invalidate existing KV cache entries. Injecting them here
   * duplicated AGENTS.md (measured: 7,625 characters per turn on top of the
   * harness's own 3,634) and left a copy in every historical turn.
   */
  async function contextPreamble(origin = null, historyText = '', attachmentText = '', sessionKey = null) {
    if (!cfg.injectInstructions) return { preamble: '', instructions: 0, memory: 0 }
    const cwd = await sessionCwd()

    const standing = []
    if (origin !== null) {
      const watchConfig = `${cwd}/watches/${origin.channel}-${origin.threadTs}.json`
      standing.push([
        '[this conversation]',
        `channel=${origin.channel} thread=${origin.threadTs}`,
        `To set up a watch that reports back here, write ${watchConfig} with`,
        '{"id":"<short-id>","name":"…","command":"<shell command>","intervalSeconds":300,"channel":"' + origin.channel + '","rateLimitMinutes":30}',
        'then tell the user what you will watch and how often.',
      ].join('\n'))
    }
    // Which directory is writable, stated plainly. Measured: asked to create a
    // file in "홈 디렉터리", the agent read that as the OS home, correctly decided
    // it was out of scope, and refused — right instinct, wrong map.
    standing.push([
      '[your files]',
      `Your home is ${cwd}. Create and edit files there freely.`,
      'Anything outside it needs the user to ask for it explicitly.',
    ].join('\n'))
    const notes = memoryIndex(cwd)
    if (notes !== '') standing.push(notes)

    const standingText = standing.join('\n\n')
    const digest = createHash('sha1').update(standingText).digest('hex').slice(0, 16)
    const sentBefore = sessionKey === null ? undefined : state.standing?.[sessionKey]
    const includeStanding = sessionKey === null || sentBefore !== digest

    const parts = []
    if (includeStanding) parts.push(standingText)
    if (typeof attachmentText === 'string' && attachmentText !== '') parts.push(attachmentText)
    if (typeof historyText === 'string' && historyText !== '') parts.push(historyText)

    if (includeStanding && sessionKey !== null) {
      state.standing = { ...(state.standing ?? {}), [sessionKey]: digest }
      saveState()
    }
    return {
      preamble: parts.length > 0 ? parts.join('\n\n') + '\n\n' : '',
      instructions: includeStanding ? standingText.length : 0,
      memory: 0,
      standingIncluded: includeStanding,
    }
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

  // ── Agent-initiated delivery ──────────────────────────────────────────────
  /**
   * Deliver messages the agent produces on its own.
   *
   * A scheduled reminder is delivered as a follow-up into the original Session,
   * which makes the agent take a turn and write an assistant message — and
   * nothing else in this composition answers to that. Without this watcher a
   * reminder fires, the agent does the work, and Slack sees nothing.
   *
   * The discriminator is `activeTurns`: anything the plugin is driving right now
   * is already delivered by `runTurn`. An assistant message on a mapped session
   * outside that set came from the agent itself.
   */
  const activeTurns = new Set()
  let deliveryWatcher = null

  function startDeliveryWatcher() {
    if (deliveryWatcher !== null || typeof ctx.on !== 'function') return
    deliveryWatcher = ctx.on('session/event', (session, event) => {
      try {
        if (event?.type !== 'assistant/message') return
        const sessionId = session?.header?.id ?? session?.id
        if (typeof sessionId !== 'string' || activeTurns.has(sessionId)) return
        const key = Object.keys(state.sessions).find((k) => state.sessions[k] === sessionId)
        if (key === undefined) return
        const text = (event.data?.message?.content ?? [])
          .filter((b) => b.type === 'text').map((b) => b.text).join('').trim()
        if (text === '') return
        const separator = key.indexOf(':')
        const channel = key.slice(0, separator)
        const threadTs = key.slice(separator + 1)
        health.delivered = (health.delivered ?? 0) + 1
        writeHealth()
        if (botToken === null) { log(`agent-initiated message in ${sessionId} — no Slack client (scenario mode), not delivered`); return }
        log(`agent-initiated message in ${sessionId} — delivering to ${channel}`)
        say(botToken, channel, threadTs, toSlackMarkdown(text))
          .then(() => refreshIndex('agent-initiated'))
          .catch((e) => log('agent-initiated delivery failed', String(e?.message ?? e)))
      } catch (e) { log('delivery watcher error', String(e?.message ?? e)) }
    })
  }

  // ── Drive one turn ────────────────────────────────────────────────────────
  /**
   * Create a session (or resume one) and drive it to completion.
   * @returns {Promise<{text: string, reason: unknown, sessionId: string}>}
   */
  async function runTurn(prompt, existingSessionId, origin = null, historyText = '', attachmentText = '', sessionKey = null) {
    const agents = ctx.get('agents')
    const sessions = ctx.get('sessions')
    const defaultModel = ctx.get('agentDefaultModel')
    if (!agents || !sessions || !defaultModel) throw new Error('deepbot: agents/sessions/agentDefaultModel missing')

    // The same selection is used for create and resume.
    const selection = defaultModel.currentSelection()
    const agentOptions = { provider: selection.provider, model: selection.model }
    const cwd = await sessionCwd()

    // ── Session composition ────────────────────────────────────────────────
    // Everything above this line is a session shell. The capabilities — the tool
    // set — come from mounting an agent preset into the agent's own context.
    // MODEL_SELECTION: upstream additionally calls installModelSelection here;
    // that helper lives in @deepseek-ai/dsh-agent and is not importable from a
    // profile-installed plugin, so `agentOptions` carries the model instead.
    const agentPresets = ctx.get('agentPresets')
    const permissionPresets = ctx.get('permissionPresets')
    const workspaceRegistry = ctx.get('workspaceRegistry')

    // Fail loud rather than degrade silently. An earlier version guarded this
    // with `if (cfg.agentPreset && agentPresets)`, so a missing service or a typo
    // produced an agent with zero tools and no error — the original symptom,
    // reproducible by configuration.
    let presetId = null
    if (cfg.agentPreset) {
      if (!agentPresets) throw new Error('deepbot: agentPreset is configured but the agentPresets service is not composed — the agent would have no tools')
      // Only validate a preset this deployment actually named. Passing `undefined`
      // through resolve() looks up the literal string "undefined" and throws, and
      // leaving permissionPreset unset is the documented way to accept the
      // deployment's own default.
      if (cfg.permissionPreset !== undefined) {
        try { permissionPresets?.resolve?.(cfg.permissionPreset) }
        catch (e) { throw new Error(`deepbot: unknown permission preset ${JSON.stringify(cfg.permissionPreset)} — ${String(e?.message ?? e)}`) }
      }
      try {
        const record = await agentPresets.resolve(cfg.agentPreset)
        presetId = record?.id ?? cfg.agentPreset
      } catch (e) {
        throw new Error(`deepbot: could not resolve agent preset ${JSON.stringify(cfg.agentPreset)} — ${String(e?.message ?? e)}`)
      }
    }
    // Only Symbol.asyncDispose exists on this lease; there is no dispose().
    const scope = presetId && agentPresets?.acquireScope ? await agentPresets.acquireScope(presetId) : null

    const setup = async (agentCtx) => {
      if (presetId && agentPresets?.mount) await agentPresets.mount(agentCtx, presetId)
    }

    // A workspace is what the harness's own instruction loader and other
    // workspace-scoped plugins key off. Attaching one is also why AGENTS.md was
    // invisible before; the prompt injection above remains as a fallback.
    let workspace = null
    if (cfg.attachWorkspace && workspaceRegistry?.create) {
      try { workspace = await workspaceRegistry.create(cwd) }
      catch (e) { log(`workspace create failed — continuing without one: ${String(e?.message ?? e)}`) }
    }

    // meta.cwd must be the workspace's CANONICAL path, and meta.agentPreset must
    // record the composition. attachSession compares the header cwd against the
    // workspace path by exact string after realpath, and a resume reads the
    // preset from the projection rather than the header — so a session created
    // without it silently reverts to the deployment default on resume, and a
    // symlinked workspace path fails the attach.
    const sessionCwdPath = workspace?.path ?? cwd
    const meta = { cwd: sessionCwdPath, ...(presetId !== null ? { agentPreset: presetId } : {}) }

    // A scheduled delivery owns its session while it runs, so a resume attempted
    // at that moment is refused ("already owned by an active write handle").
    // Retrying briefly is the right behaviour: the reminder's own turn is what
    // the user is waiting for, and this message is a second one arriving on top.
    async function adopt(existing) {
      let lastError
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          return existing
            ? await agents.resume({ resumeSessionId: existing, agentOptions, setup })
            : await agents.create({ sessionId, meta, agentOptions, setup })
        } catch (e) {
          lastError = e
          const message = String(e?.message ?? e)
          if (!/active write handle/i.test(message)) throw e
          log(`session ${sessionId} is busy (another turn owns it) — retry ${attempt}/3 in 3s`)
          await new Promise((resolve) => setTimeout(resolve, 3000))
        }
      }
      throw new Error(`deepbot: could not take the session after retries — ${String(lastError?.message ?? lastError)}`)
    }

    let handle
    let sessionId = existingSessionId ?? `slack-${randomUUID()}`   // stands in for brandString(...)
    activeTurns.add(sessionId)
    try {
      handle = await adopt(existingSessionId)
    } catch (e) {
      activeTurns.delete(sessionId)
      await scope?.[Symbol.asyncDispose]?.().catch(() => {})
      throw e
    }
    const agent = handle?.agent
    if (!agent?.followup || !agent?.whenIdle) {
      await scope?.[Symbol.asyncDispose]?.().catch(() => {})
      throw new Error('deepbot: agents.create/resume did not return an Agent')
    }

    // Post-attach steps, in the reference implementation's order.
    if (workspace?.attachSession && sessionId) {
      try { await workspace.attachSession(sessionId) }
      catch (e) {
        // Reported loudly: the message it throws is about a cwd mismatch, which is
        // the difference between "workspace-scoped features work" and "they
        // silently do not".
        log(`WARNING workspace.attachSession failed: ${String(e?.message ?? e)}`)
      }
    }
    if (cfg.permissionPreset && permissionPresets?.set) {
      try { permissionPresets.set(agent.session, cfg.permissionPreset) }
      catch (e) { log(`permissionPresets.set failed: ${String(e?.message ?? e)}`) }
    }

    try {
      await agent.whenIdle()
      const firstSeq = agent.session.seq
      const { preamble } = await contextPreamble(origin ?? null, historyText, attachmentText, sessionKey)
      agent.followup(userMessage(preamble === '' ? prompt : `${preamble}[user message]\n${prompt}`))
      await agent.whenIdle()
      await sessions.flush(agent.session)
      // Refresh here, not in the Slack event handler: this is the one place every
      // path passes through (Slack messages, the test harness, any other caller),
      // and a refresh that only happens on one of them is a refresh that is
      // missing when it matters.
      void refreshIndex('turn')
      // Read the token projection before describing the turn. `uncachedInputTokens`
      // against the total input is the only honest measure of whether the prompt
      // prefix is being reused: it is provider-reported for an identical request
      // envelope and otherwise a replay-based estimate. It comes from the
      // tokenUsage projection rather than the raw log, which carries no usage
      // events at all.
      try {
        const projections = ctx.get('sessionProjections')
        const usage = projections?.snapshot?.(agent.session)?.values?.tokenUsage
        if (usage) {
          const cached = usage.cacheReadTokens ?? 0
          const uncached = usage.uncachedInputTokens ?? 0
          const total = cached + uncached + (usage.cacheWriteTokens ?? 0)
          const pct = total > 0 ? Math.round((cached / total) * 100) : 0
          log(`tokens: input ${total} (${pct}% cache-read) uncached ${uncached} output ${usage.outputTokens ?? 0}`)
        }
      } catch (e) { log(`token readout failed: ${String(e?.message ?? e)}`) }
      const outcome = summarize(agent.session, firstSeq)
      return { text: outcome.text, reason: outcome.reason, toolsUsed: outcome.toolsUsed, sessionId }
    } finally {
      // Release the agent after every turn. The log is persisted, so the next
      // turn can resume; keeping it alive would pile one agent per thread into
      // memory.
      activeTurns.delete(sessionId)
      try { await handle.dispose?.() } catch (e) { log('dispose failed', String(e)) }
      try { await scope?.[Symbol.asyncDispose]?.() } catch (e) { log('preset scope dispose failed', String(e)) }
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
    // Tool names invoked in the owned interval. The test harness asserts on this:
    // a model can claim it lacks a tool, or write a fake tool-call as text, and a
    // text-only assertion would happily pass on that refusal.
    const toolsUsed = []
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
      if (event.type === 'tool/call') {
        const name = event.data?.name ?? event.data?.toolName ?? event.data?.call?.name
        if (typeof name === 'string') toolsUsed.push(name)
      }
      if (event.type === 'turn/end') reason = event.data?.reason
    }
    return { text, reason, toolsUsed }
  }

  // ── Slack transport ───────────────────────────────────────────────────────
  // The Web API layer lives in transports/slack.mjs. It receives only what it
  // uses from this adapter: config, the logger, and the session directory.
  const slackApi = createSlackApi({ cfg, log, sessionCwd })
  const { slackPost, slackGet, fetchHistoryText, fetchAttachments, say, toSlackMarkdown } = slackApi

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

    health.accepted++
    health.lastEventAt = Date.now()
    writeHealth()
    log(`accepted channel=${channel} thread=${threadTs} session=${state.sessions[key] ?? 'new'}`)

    enqueue(async () => {
      const started = Date.now()
      try {
        let historyText = ''
        let historyLastTs = null
        try {
          const seenUpTo = state.history?.[key] ?? null
          const hist = await fetchHistoryText(botToken, channel, event.thread_ts ?? null, event.ts, seenUpTo)
          historyText = hist.text
          historyLastTs = hist.lastTs
        } catch (e) { log(`history fetch threw: ${String(e?.message ?? e)}`) }
        let attachmentText = ''
        try { attachmentText = await fetchAttachments(botToken, event.files, String(event.ts).replace('.', '-')) }
        catch (e) { log(`attachment fetch threw: ${String(e?.message ?? e)}`) }
        if (attachmentText !== '') log(`attachments: ${(event.files ?? []).length} file(s) for ts=${event.ts}`)
        let placeholderTs = null
        const progressTimer = cfg.progressAfterMs > 0
          ? setTimeout(async () => {
              try {
                const posted = await slackPost(botToken, 'chat.postMessage', { channel, thread_ts: threadTs, text: cfg.progressText })
                if (posted.ok) { placeholderTs = posted.ts; log(`progress placeholder posted after ${cfg.progressAfterMs}ms`) }
              } catch { /* progress is best effort */ }
            }, cfg.progressAfterMs)
          : null
        let r
        try {
          r = await withTimeout(runTurn(prompt, state.sessions[key], { channel, threadTs }, historyText, attachmentText, key), cfg.runTimeoutMs)
          // Advance the thread pointer only after the turn succeeded, so a failed
          // turn does not swallow messages it never delivered.
          if (historyLastTs !== null && r.reason?.kind === 'completed') {
            state.history = { ...(state.history ?? {}), [key]: historyLastTs }
            saveState()
          }
        } finally {
          if (progressTimer !== null) clearTimeout(progressTimer)
        }
        if (r.sessionId && r.sessionId !== state.sessions[key]) { state.sessions[key] = r.sessionId; saveState() }
        const ok = r.reason?.kind === 'completed'
        if (ok && r.text) {
          health.answered++
          writeHealth()
          log(`answered channel=${channel} len=${r.text.length} ${Date.now() - started}ms`)
          await say(botToken, channel, threadTs, toSlackMarkdown(r.text), placeholderTs)
        } else {
          log(`turn ended abnormally reason=${JSON.stringify(r.reason)}`)
          await say(botToken, channel, threadTs, `The turn did not complete (${r.reason?.kind ?? 'unknown'}). Log: ${LOG}`, placeholderTs)
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
  let botUserId = null
  // Reconnect state.
  //
  // A single retry is NOT enough. An earlier version scheduled exactly one retry
  // inside the close handler; when that retry failed (network down, machine
  // asleep) the catch only logged it and the chain ended — leaving the process
  // alive, the web UI healthy, and NO Slack connection, with nothing in the log
  // after the failure. It went unnoticed for 57 minutes. The loop below never
  // gives up, and the watchdog re-arms it if the socket goes quiet without a
  // close event.
  let reconnectTimer = null
  let watchdogTimer = null
  let connected = false
  let consecutiveFailures = 0

  async function openConnection() {
    // Two traps here, both hit in practice:
    //   1) this endpoint requires the *app-level* token (xapp-), not the bot
    //      token — a bot token yields `not_allowed_token_type`.
    //   2) it is POST-only — a GET yields `insecure_request`.
    const r = await slackPost(appToken, 'apps.connections.open', {})
    if (!r.ok) throw new Error(`apps.connections.open failed: ${r.error}`)
    return r.url
  }

  /** Retry forever with capped backoff; a successful open resets it. */
  function scheduleReconnect(delay = backoff) {
    // No Slack client in this mode (scenario / selfTest): there is nothing to
    // reconnect, and trying would spam the log with auth failures against a real
    // app token. This happened while running the test harness.
    if (appToken === null || botToken === null) return
    if (stopped || reconnectTimer !== null) return
    log(`reconnect scheduled in ${delay}ms`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (stopped) return
      connect().catch((e) => {
        consecutiveFailures++
        health.connectAttempts++
        health.consecutiveFailures = consecutiveFailures
        health.lastError = String(e?.message ?? e)
        writeHealth()
        log(`reconnect failed (${consecutiveFailures} in a row): ${String(e?.message ?? e)} — still trying`)
        backoff = Math.min(backoff * 2, 60000)
        scheduleReconnect()
      })
    }, delay)
    backoff = Math.min(backoff * 2, 60000)
  }

  /** The socket can also die without a close event; re-arm if nothing is pending. */
  function startWatchdog() {
    if (appToken === null) return          // see scheduleReconnect
    if (watchdogTimer !== null) return
    watchdogTimer = setInterval(() => {
      if (stopped) return
      if (!connected && reconnectTimer === null) {
        log('watchdog: not connected and nothing scheduled — re-arming')
        scheduleReconnect(0)
      }
    }, 60000)
  }

  async function connect() {
    if (stopped) return
    const url = await openConnection()
    ws = new WebSocket(url)

    ws.addEventListener('open', () => {
      connected = true
      backoff = 1000
      consecutiveFailures = 0
      if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null }
      health.connected = true
      health.connectedAt = Date.now()
      health.disconnectedAt = null
      health.consecutiveFailures = 0
      health.lastError = null
      writeHealth()
      log('Socket Mode connected')
    })

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
      connected = false
      health.connected = false
      health.disconnectedAt = Date.now()
      writeHealth()
      log('connection closed')
      scheduleReconnect()
    })

    ws.addEventListener('error', (e) => {
      connected = false
      health.connected = false
      health.lastError = String(e?.message ?? e) || 'WebSocket error'
      writeHealth()
      log('WebSocket error', String(e?.message ?? e))
    })
  }

  // ── Scenario runner (test harness) ────────────────────────────────────────
  /**
   * Run a scenario file against the real services.
   *
   * Steps:
   *   { "session": "A", "say": "…", "expectContains": "…", "expectNotContains": "…" }
   *   { "rebuildIndex": true }
   *
   * `session` is a scenario-local name, not a session id: the runner keeps the
   * mapping so a second step in the same name continues the same conversation.
   * A failing expectation makes the run fail; the runner writes
   * `scenario-result.json` next to the state for an orchestrator to read.
   *
   * Deliberately does NOT connect to Slack — that is what makes it safe to run
   * while the live instance is serving.
   */
  const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
  let indexInFlight = false
  let indexPending = false

  /** Where the indexer lives: configured, or the sibling directory in this repo. */
  function recallScriptPath() {
    if (typeof cfg.recallScript === 'string' && cfg.recallScript !== '') return cfg.recallScript
    // This file sits at the repository root, next to recall/.
    return join(PLUGIN_DIR, 'recall', 'deepbot-recall.mjs')
  }

  /**
   * Refresh the recall index in the background. Single-flight with one queued
   * follow-up, so a burst of messages cannot pile up indexer processes.
   */
  async function refreshIndex(reason) {
    if (cfg.autoIndex !== true) return
    if (indexInFlight) { indexPending = true; return }
    indexInFlight = true
    try {
      const script = recallScriptPath()
      if (!existsSync(script)) { log(`auto-index: indexer not found at ${script}`); return }
      const cwd = await sessionCwd()
      await new Promise((resolve) => {
        execFile(process.execPath, [script, 'index', '--quiet'],
          { env: { ...process.env, DEEPBOT_HOME: cwd }, timeout: 120000 },
          (err, _stdout, stderr) => {
            if (err) log(`auto-index failed: ${String(err.message)}${stderr ? ` — ${String(stderr).slice(0, 200)}` : ''}`)
            else log(`auto-index: refreshed after ${reason}`)
            resolve()
          })
      })
    } catch (e) {
      log(`auto-index threw: ${String(e?.message ?? e)}`)
    } finally {
      indexInFlight = false
      if (indexPending) { indexPending = false; setTimeout(() => { refreshIndex('queued') }, 250) }
    }
  }

  function rebuildIndex() {
    const script = cfg.recallScript
    if (!script) return Promise.reject(new Error('a rebuildIndex step needs recallScript (DEEPBOT_RECALL_SCRIPT)'))
    return sessionCwd().then((cwd) => new Promise((resolve, reject) => {
      execFile(process.execPath, [script, 'index', '--quiet'],
        { env: { ...process.env, DEEPBOT_HOME: cwd }, timeout: 120000 },
        (err, _stdout, stderr) => err ? reject(new Error(`${err.message}${stderr ? ` — ${stderr}` : ''}`)) : resolve())
    }))
  }

  async function runScenario(scriptPath) {
    const steps = JSON.parse(readFileSync(scriptPath, 'utf8')).steps ?? []
    const sessions = { ...seededSessions }
    const results = []
    let failed = 0
    log(`scenario start — ${steps.length} step(s) from ${scriptPath}`)

    for (const [index, step] of steps.entries()) {
      const n = index + 1
      if (step.expectSessionTurn !== undefined) {
        // Assert against the session LOG rather than by driving a turn. A
        // scheduled delivery owns the session while it runs, so the adapter
        // cannot resume it — and that is exactly the case worth checking: the
        // reminder fired and the agent acted, without this plugin's involvement.
        const target = step.expectSessionTurn
        const sessionId = sessions[target.session ?? 'default']
        try {
          const query = ctx.get('sessionQuery')
          if (!query || !sessionId) throw new Error('no session to inspect')
          const observation = await query.observeSession(sessionId)
          const events = observation?.events ?? []
          const hit = events.some((e) => {
            if (e?.type !== 'user/message' && e?.type !== 'assistant/message') return false
            const text = (e.data?.message?.content ?? e.data?.content ?? [])
              .filter((b) => b?.type === 'text').map((b) => b.text).join('')
            return text.includes(target.contains)
          })
          if (!hit) failed++
          results.push({ step: n, kind: 'expectSessionTurn', session: target.session, contains: target.contains, ok: hit, events: events.length })
          log(`  step ${n}: session log contains ${JSON.stringify(target.contains)} — ${hit ? 'PASS' : 'FAIL'} (${events.length} events)`)
        } catch (e) {
          failed++
          results.push({ step: n, kind: 'expectSessionTurn', ok: false, error: String(e?.message ?? e) })
          log(`  step ${n}: session inspection FAILED — ${String(e?.message ?? e)}`)
        }
        continue
      }
      if (step.expectMissingFile !== undefined) {
        const cwd = await sessionCwd()
        const abs = step.expectMissingFile.startsWith('/') ? step.expectMissingFile : join(cwd, step.expectMissingFile)
        const absent = !existsSync(abs)
        if (!absent) failed++
        results.push({ step: n, kind: 'expectMissingFile', path: step.expectMissingFile, ok: absent })
        log(`  step ${n}: ${step.expectMissingFile} — ${absent ? 'PASS (absent)' : 'FAIL (it exists)'}`)
        continue
      }
      if (step.expectFile !== undefined) {
        // Assert on the artifact itself. A model that describes a document it did
        // not create reads exactly like one that did, and the difference only
        // shows up when someone tries to open the file. For OOXML, checking for
        // the ZIP magic plus an inner path proves it is a real package rather
        // than a text file with a .docx name.
        const spec = step.expectFile
        const cwd = await sessionCwd()
        const abs = join(cwd, spec.path)
        try {
          const stat = statSync(abs)
          const bytes = readFileSync(abs)
          const checks = []
          if (spec.minBytes !== undefined) checks.push({ what: `≥${spec.minBytes} bytes (saw ${stat.size})`, ok: stat.size >= spec.minBytes })
          if (spec.kind === 'zip') checks.push({ what: 'is a ZIP package', ok: bytes[0] === 0x50 && bytes[1] === 0x4b })
          if (spec.contains !== undefined) checks.push({ what: `contains ${JSON.stringify(spec.contains)}`, ok: bytes.includes(Buffer.from(spec.contains)) })
          if (spec.notContains !== undefined) checks.push({ what: `does not contain ${JSON.stringify(spec.notContains)}`, ok: !bytes.includes(Buffer.from(spec.notContains)) })
          const bad = checks.filter((c) => !c.ok)
          if (bad.length > 0) failed++
          results.push({ step: n, kind: 'expectFile', path: spec.path, size: stat.size, ok: bad.length === 0, failedChecks: bad })
          log(`  step ${n}: file ${spec.path} — ${bad.length === 0 ? 'PASS' : 'FAIL'} (${stat.size} bytes${bad.length ? `, ${bad.map((c) => c.what).join(', ')}` : ''})`)
        } catch (e) {
          failed++
          results.push({ step: n, kind: 'expectFile', path: spec.path, ok: false, error: String(e?.message ?? e) })
          log(`  step ${n}: file ${spec.path} — FAIL (${String(e?.message ?? e)})`)
        }
        continue
      }
      if (typeof step.waitSeconds === 'number' && step.waitSeconds > 0) {
        // Waiting is a first-class step: a scheduled reminder fires on the host's
        // clock, so the only way to test the path is to let the clock move.
        const ms = Math.min(step.waitSeconds, 600) * 1000
        log(`  step ${n}: waiting ${ms / 1000}s for a scheduled delivery`)
        await new Promise((resolve) => setTimeout(resolve, ms))
        results.push({ step: n, kind: 'wait', ok: true, ms })
        continue
      }
      if (step.rebuildIndex === true) {
        try {
          await rebuildIndex()
          results.push({ step: n, kind: 'rebuildIndex', ok: true })
          log(`  step ${n}: recall index rebuilt`)
        } catch (e) {
          failed++
          results.push({ step: n, kind: 'rebuildIndex', ok: false, error: String(e?.message ?? e) })
          log(`  step ${n}: index rebuild FAILED — ${String(e?.message ?? e)}`)
        }
        continue
      }
      const name = step.session ?? 'default'
      try {
        const r = await withTimeout(runTurn(step.say, sessions[name], null, '', '', `scenario:${name}`), cfg.runTimeoutMs)
        if (r.sessionId) sessions[name] = r.sessionId
        const text = r.text ?? ''
        const checks = []
        if (step.expectContains !== undefined) checks.push({ what: `contains ${JSON.stringify(step.expectContains)}`, ok: text.includes(step.expectContains) })
        if (step.expectNotContains !== undefined) checks.push({ what: `not contains ${JSON.stringify(step.expectNotContains)}`, ok: !text.includes(step.expectNotContains) })
        // "must admit it does not know", phrased as any-of: a not-contains check
        // cannot express it, because an honest answer may name the thing it is
        // declining to claim. Learned from a false failure on exactly that.
        // "must NOT report a miss". A contains-check cannot tell "found it" from
        // "named it while denying", which is how a failing search passed twice.
        if (Array.isArray(step.expectNotAnyOf) && step.expectNotAnyOf.length > 0) {
          const hit = step.expectNotAnyOf.find((phrase) => text.includes(phrase))
          checks.push({ what: `does not report a miss (none of ${step.expectNotAnyOf.join(' / ')})`, ok: hit === undefined })
        }
        if (Array.isArray(step.expectAnyOf) && step.expectAnyOf.length > 0) {
          const hit = step.expectAnyOf.find((phrase) => text.includes(phrase))
          checks.push({ what: `says it does not know (one of ${step.expectAnyOf.join(' / ')})`, ok: hit !== undefined })
        }
        if (Array.isArray(step.expectToolUse) && step.expectToolUse.length > 0) {
          const used = r.toolsUsed ?? []
          const hit = step.expectToolUse.some((t) => used.includes(t))
          checks.push({ what: `used one of ${step.expectToolUse.join('/')} (saw: ${used.join('/') || 'none'})`, ok: hit })
        }
        const failedChecks = checks.filter((c) => !c.ok)
        const ok = r.reason?.kind === 'completed' && failedChecks.length === 0
        if (!ok) failed++
        results.push({ step: n, kind: 'turn', session: name, say: step.say, reason: r.reason?.kind, text, toolsUsed: r.toolsUsed ?? [], ok, failedChecks })
        log(`  step ${n} [${name}] ${ok ? 'PASS' : 'FAIL'}${ok ? '' : ` (${[...failedChecks.map((c) => c.what), r.reason?.kind !== 'completed' ? `reason=${r.reason?.kind}` : ''].filter(Boolean).join(', ')})`}: ${JSON.stringify(text.slice(0, 240))}`)
      } catch (e) {
        failed++
        results.push({ step: n, kind: 'turn', session: name, say: step.say, ok: false, error: String(e?.message ?? e) })
        log(`  step ${n} [${name}] ERROR — ${String(e?.message ?? e)}`)
      }
    }

    if (process.env.DEEPBOT_SESSION_DUMP) {
      try { writeFileSync(process.env.DEEPBOT_SESSION_DUMP, JSON.stringify({ sessions }, null, 1)) }
      catch (e) { log('could not write the session dump', String(e)) }
    }
    const out = { scenario: scriptPath, cwd: await sessionCwd(), total: results.length, failed, steps: results, finishedAt: Date.now() }
    // The runner may pin this path: the agent home is fresh per run, so a fixed
    // path under it cannot be predicted from outside.
    const resultPath = process.env.DEEPBOT_SCENARIO_RESULT ?? join(stateDir, 'scenario-result.json')
    try { writeFileSync(resultPath, JSON.stringify(out, null, 1)); log(`scenario result -> ${resultPath}`) }
    catch (e) { log('could not write the scenario result', String(e)) }
    log(`scenario done — ${results.length - failed}/${results.length} step(s) passed`)
    return out
  }

  async function start() {
    // ── History probe: fetch one transcript and log it, without connecting ──
    // Verifies the real Slack path against a real thread while the live instance
    // keeps its Socket Mode connection to itself.
    if (typeof cfg.historyProbe === 'string' && cfg.historyProbe.trim() !== '') {
      // "<channel>", "<channel>:<thread_ts>" or "<channel>:<thread_ts>:<ts to exclude>"
      const [probeChannel, probeThread, probeCurrent] = cfg.historyProbe.split(':')
      try {
        const token = await credential(cfg.botTokenRef)
        if (!token) throw new Error(`credential ${cfg.botTokenRef} not found`)
        const probed = await fetchHistoryText(token, probeChannel, probeThread ?? null, probeCurrent ?? 'PROBE')
        log(`history probe ${cfg.historyProbe} — ${probed.text.length} chars`)
        log(`----8<----\n${probed.text}\n---->8----`)
      } catch (e) { log(`history probe failed: ${String(e?.stack ?? e)}`) }
      return
    }

    // ── Context probe ──────────────────────────────────────────────────────
    if (cfg.contextProbe === true) {
      const probe = await contextPreamble(null, '', '')
      log(`context probe — standing ${probe.instructions} chars, included=${probe.standingIncluded}`)
      log(`----8<----\n${probe.preamble}\n---->8----`)
      return
    }

    // ── Attachment probe ───────────────────────────────────────────────────
    if (typeof cfg.attachmentProbe === 'string' && cfg.attachmentProbe.trim() !== '') {
      const [probeChannel, probeTs] = cfg.attachmentProbe.split(':')
      try {
        const token = await credential(cfg.botTokenRef)
        if (!token) throw new Error(`credential ${cfg.botTokenRef} not found`)
        const history = await slackGet(token, 'conversations.history', { channel: probeChannel, limit: '50' })
        if (!history.ok) throw new Error(`conversations.history failed: ${history.error}`)
        const message = (history.messages ?? []).find((m) => m.ts === probeTs)
        const files = message?.files ?? []
        log(`attachment probe ${cfg.attachmentProbe} — message found=${message !== undefined}, files=${files.length}`)
        const manifest = await fetchAttachments(token, files, String(probeTs).replace('.', '-'))
        log(`----8<----\n${manifest}\n---->8----`)
      } catch (e) { log(`attachment probe failed: ${String(e?.stack ?? e)}`) }
      return
    }

    // ── Scenario mode: the test harness ────────────────────────────────────
    if (typeof cfg.selfTestScript === 'string' && cfg.selfTestScript.trim() !== '') {
      try { await runScenario(cfg.selfTestScript) }
      catch (e) { log(`scenario failed to run: ${String(e?.stack ?? e)}`) }
      return
    }

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
    if (!botToken) throw new Error(`deepbot: credential ${cfg.botTokenRef} not found`)
    if (!appToken) throw new Error(`deepbot: credential ${cfg.appTokenRef} not found`)

    const me = await slackGet(botToken, 'auth.test')
    if (!me.ok) throw new Error(`deepbot: auth.test failed (${me.error}) — check the bot token`)

    const cwd = await sessionCwd()
    log(`starting — bot=@${me.user} team=${me.team} channels=${targetChannels.join(',')} mode=${cfg.replyMode}`)
    log(`session cwd=${cwd}  state=${stateDir}  mapped sessions=${Object.keys(state.sessions).length}`)
    if (cfg.injectInstructions) {
      const probe = await contextPreamble()
      log(`memory: auto-index=${cfg.autoIndex} indexer=${recallScriptPath()}`)
      log(`session composition: preset=${cfg.agentPreset} permission=${cfg.permissionPreset} workspace=${cfg.attachWorkspace ? 'attach' : 'none'}`)
        const present = [cfg.personaFile, 'AGENTS.md', cfg.userFile, cfg.factsFile]
          .filter((f) => existsSync(join(cwd, f)))
        log(`context injection: standing block ${probe.instructions} chars; instruction files present: ${present.join(', ') || 'NONE'}`)
        if (present.length === 0) log('context injection: WARNING — no persona or instruction files in the agent home')
    } else {
      log('context injection: disabled')
    }

    botUserId = me.user_id
    await connect()
  }

  // ── Lifecycle: close the socket when the plugin unloads ───────────────────
  /**
   * Startup keeps retrying too: if the credentials are temporarily unresolvable
   * or the network is down at boot, giving up would leave the bot silently dead.
   */
  async function startWithRetry() {
    try { await start() }
    catch (e) {
      if (stopped) return
      consecutiveFailures++
      log(`startup failed (${consecutiveFailures} in a row): ${String(e?.message ?? e)} — retrying in ${backoff}ms`)
      setTimeout(() => {
        backoff = Math.min(backoff * 2, 60000)
        if (!stopped) startWithRetry()
      }, backoff)
    }
  }

  ctx.effect(() => {
    startWithRetry()
    startWatchdog()
    startDeliveryWatcher()
    writeHealth()
    if (healthTimer === null) healthTimer = setInterval(writeHealth, cfg.heartbeatMs)
    return () => {
      stopped = true
      if (healthTimer !== null) clearInterval(healthTimer)
      health.connected = false
      writeHealth()
      if (reconnectTimer !== null) clearTimeout(reconnectTimer)
      if (watchdogTimer !== null) clearInterval(watchdogTimer)
      const hadSocket = ws !== null
      try { ws?.close() } catch { /* ignore */ }
      log(hadSocket ? 'plugin unloading — socket closed' : 'plugin unloading — no socket was open')
    }
  }, 'deepbot: socket-mode')
}

// Re-exported at the end of the module: `defaults` must be read after DEFAULTS is
// initialized, and an export placed above the declaration throws at import time.
// tools/persona-check.mjs reads the real budgets instead of a copy that drifts.
export { DEFAULTS as defaults }
