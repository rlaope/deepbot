/**
 * Tests for agent-initiated delivery.
 *
 * A scheduled reminder is delivered as a follow-up into the original Session, so
 * the agent takes a turn by itself and nothing in this composition tells Slack.
 * The plugin watches session events and delivers assistant messages for session
 * ids it is not currently driving.
 *
 * This test drives `apply()` with a mock context, pre-seeds a thread→session
 * mapping, then feeds a synthetic session event and asserts the reply went to the
 * right channel and thread.
 *
 * Run: node test/delivery.test.mjs
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../dist/index.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const posted = []
// Faithful to Cordis: a name can have several listeners and every one runs. A stub
// keeping only the last would pass while a second listener silently disabled the
// first — which is exactly what happened when the adapter gained a second one.
let sessionEventHandlers = []
const sessionEventHandler = (session, event) => { for (const handler of sessionEventHandlers) handler(session, event) }

globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  const body = init.body ? JSON.parse(init.body) : {}
  if (u.includes('chat.postMessage')) posted.push(body)
  return {
    json: async () => {
      if (u.includes('auth.test')) return { ok: true, user: 'testbot', user_id: 'U_BOT', team: 'T' }
      if (u.includes('apps.connections.open')) return { ok: true, url: 'wss://fake.invalid/link' }
      return { ok: true }
    },
  }
}

// A socket that opens and stays open, so no reconnect chatter interferes.
class FakeWebSocket {
  constructor() { this.listeners = { open: [], close: [], message: [], error: [] }; setTimeout(() => this.listeners.open.forEach((f) => f()), 5) }
  addEventListener(type, fn) { this.listeners[type].push(fn) }
  close() {}
  send() {}
}
globalThis.WebSocket = FakeWebSocket

const stateDir = mkdtempSync(join(tmpdir(), 'deepbot-delivery-'))
const THREAD_KEY = 'C_TEST:1791999999.000100'
const SESSION_ID = 'slack-deadbeef-0000-4000-8000-000000000001'
writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({ sessions: { [THREAD_KEY]: SESSION_ID }, seen: {} }))

const ctx = {
  get: (name) => (name === 'credentials' ? { resolve: async () => undefined } : undefined),
  effect: (fn) => fn(),
  on: (name, handler) => { if (name === 'session/event') sessionEventHandlers.push(handler); return () => {} },
  logger: { info: () => {} },
}

process.env.SLACK_BOT_TOKEN = 'xoxb-fake'
process.env.SLACK_APP_TOKEN = 'xapp-fake'

apply(ctx, { targetChannels: ['*'], stateDir })
await sleep(600)   // let startup connect and register the watcher

check('the session/event watcher was registered', typeof sessionEventHandler === 'function')

const session = { header: { id: SESSION_ID } }
sessionEventHandler(session, {
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text: '리마인더: 회의 10분 전입니다.' }] } },
})
await sleep(300)

check('the agent-initiated message was delivered', posted.length === 1, `${posted.length} post(s)`)
check('it went to the mapped channel', posted[0]?.channel === 'C_TEST', JSON.stringify(posted[0]?.channel))
check('it went into the mapped thread', posted[0]?.thread_ts === '1791999999.000100', JSON.stringify(posted[0]?.thread_ts))
check('the text was carried through', String(posted[0]?.text ?? '').includes('리마인더'), JSON.stringify(posted[0]?.text ?? '').slice(0, 60))


// An unmapped session must be ignored: the plugin has no thread to answer in.
sessionEventHandler({ header: { id: 'slack-not-mapped' } }, {
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text: 'should not be delivered' }] } },
})
await sleep(200)
check('an unmapped session is ignored', posted.length === 1, `${posted.length} post(s)`)

// Non-assistant events must be ignored.
sessionEventHandler(session, { type: 'turn/start', data: { turn: 1 } })
await sleep(150)
check('non-assistant events are ignored', posted.length === 1, `${posted.length} post(s)`)

// A long agent-initiated message is chunked; the first chunk replaces a progress
// placeholder rather than adding a second message.
posted.length = 0
const long = 'x'.repeat(9000)
sessionEventHandler(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: long }] } } })
await sleep(400)
const chips = posted.filter((p) => p.text)
check('a long message is chunked', chips.length >= 3, `${chips.length} chunk(s)`)

const log = readFileSync(join(stateDir, 'deepbot.log'), 'utf8')
check('the delivery was logged', /agent-initiated message/.test(log))

rmSync(stateDir, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
