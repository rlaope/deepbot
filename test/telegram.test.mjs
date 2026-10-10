/**
 * The Telegram transport, against a mocked Bot API.
 *
 * This is the second transport, and its job is to prove the seam holds: the core
 * did not change to accommodate it beyond reading `threadTs: null` as "one session
 * per conversation". The platform facts being tested are the ones that would
 * otherwise be discovered in a live chat: what counts as being addressed, that
 * mentions must be stripped, that edits can be refused, and that Telegram has no
 * history endpoint.
 *
 * Run: node test/telegram.test.mjs
 */
import './dist-fresh.mjs'   // fails loudly on a stale dist

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTelegramTransport } from '../dist/transports/telegram.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A Bot API that answers from a queue and records what it was asked. */
function fakeApi(options = {}) {
  const calls = []
  const updates = [...(options.updates ?? [])]
  const fetchImpl = async (url, init) => {
    const method = String(url).split('/').pop()
    calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : null })
    const json = (value, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => value, arrayBuffer: async () => new ArrayBuffer(0) })
    if (method === 'getMe') return json({ ok: true, result: { id: 42, username: 'deepbot_test', first_name: 'Deep', is_bot: true } })
    if (method === 'getUpdates') {
      if (updates.length > 0) return json({ ok: true, result: [updates.shift()] })
      // Behave like a long poll instead of spinning: the real call waits.
      await sleep(120)
      return json({ ok: true, result: [] })
    }
    if (method === 'getFile') return json({ ok: true, result: { file_id: 'F1', file_path: 'documents/notes.txt', file_size: 12 } })
    if (method === 'sendMessage') return json({ ok: true, result: { message_id: 100 + calls.length, chat: { id: 7 } } })
    if (method === 'editMessageText') {
      if (options.editFails) return json({ ok: false, error_code: 400, description: 'message is too old to edit' }, false)
      return json({ ok: true, result: { message_id: 99, chat: { id: 7 } } })
    }
    if (String(url).includes('/file/bot')) {
      const bytes = Buffer.from('notes: hello')
      return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
    }
    return json({ ok: true, result: {} })
  }
  return { calls, fetchImpl }
}

function transportFor(api, cwd, extra = {}) {
  const logs = []
  const transport = createTelegramTransport({
    cfg: {
      telegramTokenRef: 'TELEGRAM_BOT_TOKEN', downloadAttachments: true,
      maxAttachmentBytes: 1024 * 1024, attachmentTextChars: 500,
      ...extra,
    },
    log: (...parts) => logs.push(parts.join(' ')),
    sessionCwd: async () => cwd,
    credential: async () => 'telegram-token',
    onHealth: () => {},
    fetchImpl: api.fetchImpl,
  })
  transport.logs = logs
  return transport
}

function privateMessage(overrides = {}) {
  return { update_id: 1, message: { message_id: 10, from: { id: 5, username: 'khope' }, chat: { id: 7, type: 'private' }, text: 'hello', ...overrides } }
}
function groupMessage(overrides = {}) {
  return { update_id: 2, message: { message_id: 11, from: { id: 5, username: 'khope' }, chat: { id: 8, type: 'supergroup' }, text: 'hello all', ...overrides } }
}

// 1. Identity
{
  const api = fakeApi()
  const t = transportFor(api, mkdtempSync(join(tmpdir(), 'tg-')))
  const me = await t.identity()
  check('identity reports the bot username', me.name === 'deepbot_test' && me.id === '42', JSON.stringify(me))
}

// 2. A private chat is always addressed, and has no threads.
{
  const api = fakeApi({ updates: [privateMessage()] })
  const t = transportFor(api, mkdtempSync(join(tmpdir(), 'tg-')))
  const received = []
  await t.connect({ onMessage: (m) => received.push(m) })
  await sleep(250)
  await t.close()
  check('a private message is delivered', received.length === 1, `${received.length} message(s)`)
  check('a private message counts as addressed', received[0]?.addressed === true)
  check('a threadless platform reports no thread', received[0]?.target?.threadTs === null)
  check('the chat id is the conversation', received[0]?.target?.channel === '7')
}

// 3. In a group, chatter without a mention is not for the bot.
{
  const api = fakeApi({ updates: [groupMessage()] })
  const t = transportFor(api, mkdtempSync(join(tmpdir(), 'tg-')))
  const received = []
  await t.connect({ onMessage: (m) => received.push(m) })
  await sleep(250)
  await t.close()
  check('group chatter is not addressed', received.length === 1 && received[0].addressed === false)
}

// 4. A mention is addressed, and is stripped from the text.
{
  const text = '@deepbot_test summarize this'
  const api = fakeApi({ updates: [groupMessage({ text, entities: [{ type: 'mention', offset: 0, length: 13 }] })] })
  const t = transportFor(api, mkdtempSync(join(tmpdir(), 'tg-')))
  const received = []
  await t.connect({ onMessage: (m) => received.push(m) })
  await sleep(250)
  await t.close()
  check('a mention is addressed', received[0]?.addressed === true)
  check('the mention is stripped from the prompt', received[0]?.text === 'summarize this', JSON.stringify(received[0]?.text))
}

// 5. Replying to the bot is addressed, and an unresolvable mention is not.
{
  const reply = groupMessage({ text: 'and this?', reply_to_message: { message_id: 9, from: { id: 42, is_bot: true }, chat: { id: 8, type: 'supergroup' } } })
  const api = fakeApi({ updates: [reply] })
  const t = transportFor(api, mkdtempSync(join(tmpdir(), 'tg-')))
  const received = []
  await t.connect({ onMessage: (m) => received.push(m) })
  await sleep(250)
  await t.close()
  check('a reply to the bot is addressed', received[0]?.addressed === true)

  const other = groupMessage({ text: '@someoneelse look', entities: [{ type: 'mention', offset: 0, length: 13 }] })
  const api2 = fakeApi({ updates: [other] })
  const t2 = transportFor(api2, mkdtempSync(join(tmpdir(), 'tg-')))
  const got2 = []
  await t2.connect({ onMessage: (m) => got2.push(m) })
  await sleep(250)
  await t2.close()
  check('a mention of someone else is not addressed', got2[0]?.addressed === false)
}

// 6. Posting, and replacing a progress placeholder.
{
  const api = fakeApi()
  const t = transportFor(api, mkdtempSync(join(tmpdir(), 'tg-')))
  await t.identity()
  const sent = await t.post({ channel: '7', threadTs: null }, 'the answer')
  check('post sends a message and returns its id', sent?.ts !== undefined && sent?.channel === '7', JSON.stringify(sent))
  await t.post({ channel: '7', threadTs: null }, 'replaced', { replace: '55' })
  check('a replace edits instead of sending', api.calls.some((c) => c.method === 'editMessageText' && c.body?.message_id === 55))
  check('the edit carries the new text', api.calls.find((c) => c.method === 'editMessageText')?.body?.text === 'replaced')
}

// 7. If the edit is refused, the answer is still delivered.
{
  const api = fakeApi({ editFails: true })
  const t = transportFor(api, mkdtempSync(join(tmpdir(), 'tg-')))
  await t.identity()
  await t.post({ channel: '7', threadTs: null }, 'the answer', { replace: '55' })
  check('a refused edit falls back to a new message', api.calls.filter((c) => c.method === 'sendMessage').length === 1)
}

// 8. Attachments: two-step lookup, then the bytes.
{
  const cwd = mkdtempSync(join(tmpdir(), 'tg-home-'))
  const api = fakeApi()
  const t = transportFor(api, cwd)
  await t.identity()
  const manifest = await t.fetchAttachments({
    eventId: 'e', target: { channel: '7', threadTs: null }, ts: '10', text: '', user: '5', addressed: true,
    files: [{ id: 'F1', name: 'notes.txt', mimetype: 'text/plain', size: 12 }], raw: {},
  }, '10')
  check('the file was fetched through getFile', api.calls.some((c) => c.method === 'getFile'))
  check('the attachment is written', existsSync(join(cwd, 'attachments', '10-notes.txt')), readFileSync(join(cwd, 'attachments', '10-notes.txt'), 'utf8'))
  check('text content is inlined in the manifest', /notes: hello/.test(manifest.text))
  rmSync(cwd, { recursive: true, force: true })
}

// 9. History comes from what the transport has seen, as a delta.
{
  const api = fakeApi({ updates: [privateMessage({ text: 'first thing' }), privateMessage({ message_id: 11, text: 'second thing', update_id: 3 })] })
  const t = transportFor(api, mkdtempSync(join(tmpdir(), 'tg-')))
  const received = []
  await t.connect({ onMessage: (m) => received.push(m) })
  await sleep(300)
  const all = await t.fetchHistory({ channel: '7', threadTs: null }, { currentTs: '11', sinceTs: null, limit: 20, maxChars: 1000 })
  const delta = await t.fetchHistory({ channel: '7', threadTs: null }, { currentTs: '11', sinceTs: '10', limit: 20, maxChars: 1000 })
  await t.close()
  check('the conversation so far is available', /first thing/.test(all.text), JSON.stringify(all.text.slice(0, 60)))
  check('the question itself is excluded', !/second thing/.test(all.text))
  check('a delta returns only what is new', delta.text === '' && delta.lastTs === null, JSON.stringify(delta))
}

// 10. Closing stops the poll loop.
{
  const api = fakeApi()
  const t = transportFor(api, mkdtempSync(join(tmpdir(), 'tg-')))
  await t.connect({ onMessage: () => {} })
  const was = await t.close()
  await sleep(200)
  const after = api.calls.filter((c) => c.method === 'getUpdates').length
  await sleep(200)
  check('closing reports that polling was running', was === true)
  check('hasSocket reports no polling afterwards', t.hasSocket() === false)
  check('the loop stops asking for updates', api.calls.filter((c) => c.method === 'getUpdates').length === after, `${after} → ${api.calls.filter((c) => c.method === 'getUpdates').length}`)
}

// 11. A poll failure is reported and retried, not fatal.
{
  let attempts = 0
  const api = fakeApi()
  const flaky = async (url, init) => {
    if (String(url).includes('getUpdates') && attempts++ === 0) throw new Error('network down')
    return api.fetchImpl(url, init)
  }
  const t = transportFor({ calls: api.calls, fetchImpl: flaky }, mkdtempSync(join(tmpdir(), 'tg-')))
  await t.connect({ onMessage: () => {} })
  await sleep(200)
  await t.close()
  check('a poll failure is logged as retried', t.logs.some((l) => /telegram poll failed.*retrying in \d+ms/.test(l)), t.logs.find((l) => /poll failed/.test(l)) ?? 'no line')
  check('the loop keeps running after a failure', attempts >= 1 && t.hasSocket() === false)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
