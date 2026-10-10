/**
 * The Discord transport, against a mocked gateway and REST API.
 *
 * The third transport, and the one that proves the seam covers a platform with a
 * different event shape: a gateway websocket that must be identified with an intents
 * bitmask and heartbeated, plus REST for everything outbound. What is tested is what
 * would otherwise be discovered in a live server: the intents, what counts as being
 * addressed, that a message with no content is a permission problem rather than a
 * silent no-op, editing a progress message, and history.
 *
 * Run: node test/discord.test.mjs
 */
import './dist-fresh.mjs'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDiscordTransport } from '../dist/transports/discord.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A websocket that behaves like Discord's gateway, and a REST API behind it. */
function fakeDiscord(options = {}) {
  const sent = []
  const rest = []
  const handlers = {}
  const emit = (frame) => { for (const fn of handlers.message ?? []) fn({ data: JSON.stringify(frame) }) }
  class FakeSocket {
    constructor(url) {
      this.url = url
      this.frames = []
      // Discord opens with a Hello frame carrying the heartbeat interval; the client
      // identifies only after it, so a fake that skips Hello tests nothing.
      setTimeout(() => emit({ op: 10, d: { heartbeat_interval: 45000 } }), 5)
    }
    addEventListener(type, fn) { (handlers[type] ??= []).push(fn) }
    send(payload) {
      const frame = JSON.parse(payload)
      this.frames.push(frame)
      sent.push(frame)
      if (frame.op === 2) {
        // Identify: answer with READY, then the queued dispatches.
        setTimeout(() => {
          emit({ op: 0, t: 'READY', d: { user: { id: '9', username: 'bot' } } })
          for (const update of options.updates ?? []) emit({ op: 0, t: 'MESSAGE_CREATE', d: update })
        }, 10)
      }
    }
    close() { for (const fn of handlers.close ?? []) fn({}) }
  }

  const fetchImpl = async (url, init = {}) => {
    const path = String(url).replace('https://discord.com/api/v10', '')
    rest.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null })
    const json = (value, ok = true, status = 200) => ({ ok, status, json: async () => value, text: async () => JSON.stringify(value), arrayBuffer: async () => new ArrayBuffer(0) })
    if (path === '/users/@me') return json({ id: '9', username: 'testbot', bot: true })
    if (path.startsWith('/channels/') && path.includes('/messages') && !path.includes('?')) {
      if ((init.method ?? 'POST') === 'POST') return json({ id: `m${rest.length}`, channel_id: 'C1' })
      return json({ id: options.editTarget ?? 'm1', channel_id: 'C1' })
    }
    if (path.includes('/messages?')) {
      if (options.historyFails) return json({ message: 'Missing Access' }, false, 403)
      return json(options.history ?? [])
    }
    if (String(url).startsWith('https://cdn')) {
      const bytes = Buffer.from('file body')
      return { ok: true, status: 200, json: async () => ({}), text: async () => '', arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
    }
    return json({})
  }
  return { sent, rest, fetchImpl, WebSocketImpl: FakeSocket, identify: () => sent.find((f) => f.op === 2) }
}

function transportFor(api, cwd, extra = {}) {
  const logs = []
  const t = createDiscordTransport({
    cfg: { discordTokenRef: 'DISCORD_BOT_TOKEN', downloadAttachments: true, maxAttachmentBytes: 1024 * 1024, attachmentTextChars: 500, ...extra },
    log: (...parts) => logs.push(parts.join(' ')),
    sessionCwd: async () => cwd,
    credential: async () => 'discord-token',
    onHealth: () => {},
    fetchImpl: api.fetchImpl,
    WebSocketImpl: api.WebSocketImpl,
  })
  t.logs = logs
  return t
}

/** A guild message. The guild id is what makes it a guild message rather than a DM. */
function message(overrides = {}) {
  return { id: '100', channel_id: 'C1', guild_id: 'G1', content: 'hello', author: { id: '5', username: 'khope' }, ...overrides }
}

// 1. Identity and the intents the gateway is identified with.
{
  const api = fakeDiscord()
  const t = transportFor(api, mkdtempSync(join(tmpdir(), 'dc-')))
  const me = await t.identity()
  check('identity reports the bot user', me.name === 'testbot' && me.id === '9', JSON.stringify(me))
  const received = []
  await t.connect({ onMessage: (m) => received.push(m) })
  await sleep(60)
  const identify = api.identify()
  check('the gateway is identified', identify !== undefined)
  // GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
  check('the intents ask for message content', identify?.d?.intents === 37377, String(identify?.d?.intents))
  check('a ready gateway is reported connected', t.hasSocket() === true)
  await t.close()
}

// 2. A direct message is addressed; a guild message needs a mention or a reply.
{
  const api = fakeDiscord({ updates: [{ id: '200', channel_id: 'D1', content: 'hi', author: { id: '5', username: 'khope' } }] })
  const t = transportFor(api, mkdtempSync(join(tmpdir(), 'dc-')))
  const received = []
  await t.connect({ onMessage: (m) => received.push(m) })
  await sleep(60)
  await t.close()
  check('a direct message is delivered', received.length === 1, `${received.length}`)
  check('a direct message counts as addressed', received[0]?.addressed === true)
  check('the channel is the conversation', received[0]?.target?.channel === 'D1' && received[0]?.target?.threadTs === null)
}

{
  const api = fakeDiscord({ updates: [message()] })
  const t = transportFor(api, mkdtempSync(join(tmpdir(), 'dc-')))
  const received = []
  await t.connect({ onMessage: (m) => received.push(m) })
  await sleep(60)
  await t.close()
  check('guild chatter is not addressed', received[0]?.addressed === false)

  const api2 = fakeDiscord({ updates: [message({ content: '<@9> summarize this' })] })
  const t2 = transportFor(api2, mkdtempSync(join(tmpdir(), 'dc-')))
  const got2 = []
  await t2.connect({ onMessage: (m) => got2.push(m) })
  await sleep(60)
  await t2.close()
  check('a mention is addressed', got2[0]?.addressed === true)
  check('the mention is stripped', got2[0]?.text === 'summarize this', JSON.stringify(got2[0]?.text))
}

// 3. Empty content is a permission problem, not silence.
{
  const api = fakeDiscord({ updates: [{ id: '300', channel_id: 'D1', content: '', author: { id: '5', username: 'khope' } }] })
  const t = transportFor(api, mkdtempSync(join(tmpdir(), 'dc-')))
  const received = []
  await t.connect({ onMessage: (m) => received.push(m) })
  await sleep(60)
  await t.close()
  check('a content-less message is not delivered', received.length === 0)
  check('and the likely cause is named', t.logs.some((l) => /MESSAGE_CONTENT intent/.test(l)), t.logs.filter((l) => /intent/.test(l)).join(' | '))
}

// 4. Posting, editing a progress message, and the fallback when the edit is refused.
{
  const api = fakeDiscord()
  const t = transportFor(api, mkdtempSync(join(tmpdir(), 'dc-')))
  await t.identity()
  const sent = await t.post({ channel: 'C1', threadTs: null }, 'the answer')
  check('post sends a message and returns its id', sent?.ts !== undefined && sent?.channel === 'C1', JSON.stringify(sent))
  check('it went to the channel', api.rest.some((c) => c.path === '/channels/C1/messages' && c.method === 'POST'))

  const api2 = fakeDiscord()
  const t2 = transportFor(api2, mkdtempSync(join(tmpdir(), 'dc-')))
  await t2.identity()
  await t2.post({ channel: 'C1', threadTs: null }, 'replaced', { replace: 'm1' })
  check('a replace patches the message', api2.rest.some((c) => c.path === '/channels/C1/messages/m1' && c.method === 'PATCH'))
  check('and does not send a second one', api2.rest.filter((c) => c.method === 'POST').length === 0)

  const api3 = fakeDiscord()
  const t3 = transportFor(api3, mkdtempSync(join(tmpdir(), 'dc-')))
  await t3.identity()
  const failing = { ...api3, fetchImpl: async (url, init) => (String(init?.method ?? 'POST') === 'PATCH'
    ? { ok: false, status: 404, json: async () => ({}), text: async () => 'Unknown Message', arrayBuffer: async () => new ArrayBuffer(0) }
    : api3.fetchImpl(url, init)) }
  const t4 = transportFor(failing, mkdtempSync(join(tmpdir(), 'dc-')))
  await t4.identity()
  await t4.post({ channel: 'C1', threadTs: null }, 'the answer', { replace: 'm1' })
  check('a refused edit falls back to a new message', api3.rest.filter((c) => c.method === 'POST').length === 1, JSON.stringify(api3.rest.map((c) => c.method)))
}

// 5. History comes from the API, in reading order, with the question excluded.
{
  const api = fakeDiscord({ history: [{ id: '102', channel_id: 'C1', content: 'second', author: { username: 'b' } }, { id: '101', channel_id: 'C1', content: 'first', author: { username: 'a' } }] })
  const t = transportFor(api, mkdtempSync(join(tmpdir(), 'dc-')))
  await t.identity()
  const history = await t.fetchHistory({ channel: 'C1', threadTs: null }, { currentTs: '103', sinceTs: null, limit: 20, maxChars: 1000 })
  check('history is read in order', /a: first[\s\S]*b: second/.test(history.text), JSON.stringify(history.text.slice(0, 80)))
  check('the newest id is reported back', history.lastTs === '102', String(history.lastTs))
  const delta = await t.fetchHistory({ channel: 'C1', threadTs: null }, { currentTs: '103', sinceTs: '102', limit: 20, maxChars: 1000 })
  check('a delta asks for what is after the last seen message', api.rest.some((c) => c.path.includes('after=102')), JSON.stringify(api.rest.map((c) => c.path).slice(-2)))
  check('and returns nothing new', delta.text === '' || delta.lastTs === '102')
}

// 6. A history failure degrades to what the process has seen rather than failing the turn.
{
  const api = fakeDiscord({ historyFails: true, updates: [{ id: '400', channel_id: 'D1', content: 'something said', author: { id: '5', username: 'khope' } }] })
  const t = transportFor(api, mkdtempSync(join(tmpdir(), 'dc-')))
  await t.connect({ onMessage: () => {} })
  await sleep(60)
  const history = await t.fetchHistory({ channel: 'D1', threadTs: null }, { currentTs: '500', sinceTs: null, limit: 20, maxChars: 1000 })
  await t.close()
  check('a history failure is logged, not thrown', t.logs.some((l) => /discord history failed/.test(l)))
  check('and the fallback has what this process saw', /something said/.test(history.text), JSON.stringify(history.text.slice(0, 80)))
}

// 7. Attachments: bytes from the CDN, written and described.
{
  const cwd = mkdtempSync(join(tmpdir(), 'dc-home-'))
  const api = fakeDiscord()
  const t = transportFor(api, cwd)
  await t.identity()
  const manifest = await t.fetchAttachments({
    eventId: 'e', target: { channel: 'C1', threadTs: null }, ts: '100', text: 'see file', user: '5', addressed: true,
    files: [{ id: 'A1', name: 'notes.txt', mimetype: 'text/plain', size: 9 }],
    raw: { attachments: [{ id: 'A1', filename: 'notes.txt', content_type: 'text/plain', size: 9, url: 'https://cdn.discordapp.com/A1' }] },
  }, '100')
  check('the attachment is written', existsSync(join(cwd, 'attachments', '100-notes.txt')), readFileSync(join(cwd, 'attachments', '100-notes.txt'), 'utf8'))
  check('text content is inlined in the manifest', /file body/.test(manifest.text), manifest.text.slice(0, 60))
  rmSync(cwd, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
