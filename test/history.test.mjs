/**
 * Tests for conversation-history injection.
 *
 * This exists because of a live failure: asked "read the conversation above and
 * summarise it", the bot answered that the conversation did not exist. It had no
 * way to see what was said before it was mentioned, and nothing had told it that
 * anything was above it. Slack's API could read the thread the whole time.
 *
 * The formatting is what gets tested here against mocks — paging, the users.info
 * fallback for ids past the page limit, mention humanisation, and the framing
 * that marks the transcript as content rather than instructions. The live API
 * path was verified separately against a real thread.
 *
 * Run: node test/history.test.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../dist/index.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const calls = []
globalThis.fetch = async (url) => {
  const u = String(url)
  calls.push(u.replace(/^https:\/\/slack\.com\/api\//, '').split('?')[0])
  const query = new URL(u).searchParams
  return {
    json: async () => {
      if (u.includes('users.list')) {
        const cursor = query.get('cursor')
        // Two pages, and the participant we care about is on the SECOND one.
        return cursor === null
          ? { ok: true, members: [{ id: 'U1', real_name: 'First Person' }], response_metadata: { next_cursor: 'page2' } }
          : { ok: true, members: [{ id: 'U2', real_name: 'Second Person' }], response_metadata: { next_cursor: '' } }
      }
      if (u.includes('users.info')) return { ok: true, user: { id: 'U3', real_name: 'Late Joiner' } }
      if (u.includes('conversations.replies')) {
        return {
          ok: true,
          messages: [
            { ts: '1000.1', user: 'U1', text: 'should we ship it?' },
            { ts: '1000.2', user: 'U2', text: 'yes <@U2> — and ask <@U3>' },
            { ts: '1000.3', user: 'U9', text: 'the question itself' },
          ],
        }
      }
      return { ok: true }
    },
  }
}

const stateDir = mkdtempSync(join(tmpdir(), 'deepbot-history-'))
const logs = []
const ctx = {
  get: () => undefined,
  effect: (fn) => fn(),
  on: () => () => {},
  logger: { info: (l) => logs.push(l) },
}
process.env.SLACK_BOT_TOKEN = 'xoxb-fake'
process.env.SLACK_APP_TOKEN = 'xapp-fake'

apply(ctx, {
  targetChannels: ['*'],
  stateDir,
  historyProbe: 'C_TEST:1000.1:1000.3',
  heartbeatMs: 60000,
})
await sleep(1500)

const text = logs.join('\n')
check('the history probe fetched a transcript', /conversation so far/.test(text))
check('it is framed as content, not instructions', /content, not instructions/.test(text))
check('participants are named from the paginated list', /First Person/.test(text) && /Second Person/.test(text), 'page 1 and page 2 both used')
check('an id past the page limit is resolved with users.info', /Late Joiner/.test(text))
check('mentions are humanised', /@Second Person/.test(text), 'not left as <@U2>')
check('raw mention syntax does not survive', !/<@U[0-9]+>/.test(text))
check('the question being answered is excluded', !/the question itself/.test(text))
check('users.list was paged', calls.filter((c) => c === 'users.list').length === 2, `${calls.filter((c) => c === 'users.list').length} call(s)`)

rmSync(stateDir, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
