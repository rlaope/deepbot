/**
 * The progress message rules, with no agent and no platform.
 *
 * The point of the message is that a long turn looks alive. The rules that make it
 * work are small and easy to get wrong: post once, edit after that, do not edit
 * faster than the throttle, and never leave the message behind — an orphaned
 * "working on it" is worse than no progress at all.
 *
 * Run: node test/progress.test.mjs
 */
import { createProgressTracker } from '../dist/progress.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const target = { channel: 'C1', threadTs: 't1' }

function tracker(options = {}) {
  const posted = []
  let clock = 1000
  const t = createProgressTracker({
    async post(target, text, opts = {}) {
      posted.push({ target, text, replace: opts.replace ?? null })
      return { ts: `ts-${posted.length}` }
    },
    throttleMs: 2500,
    label: 'working',
    now: () => clock,
    ...options,
  })
  return { t, posted, tick: (ms) => { clock += ms } }
}

// 1. The first activity posts; nothing else does until the throttle window passes.
{
  const { t, posted, tick } = tracker()
  await t.note('k', target, 'bash')
  check('the first activity posts a message', posted.length === 1, JSON.stringify(posted[0]?.text))
  check('the message names the tool', /bash/.test(posted[0].text))
  await t.note('k', target, 'grep')
  check('a second update inside the window is skipped', posted.length === 1, `${posted.length} post(s)`)
  tick(3000)
  await t.note('k', target, 'read')
  check('an update after the window edits the same message', posted.length === 2 && posted[1].replace === 'ts-1', JSON.stringify(posted[1]))
  check('the edit counts the tools', /3개 도구/.test(posted[1].text), posted[1].text)
}

// 2. force ignores the throttle, which is how a slow turn first appears.
{
  const { t, posted } = tracker()
  await t.force('k', target)
  check('force posts without any activity', posted.length === 1)
  await t.force('k', target)
  check('force edits immediately', posted.length === 2 && posted[1].replace === 'ts-1')
  check('the label alone is enough when nothing has happened yet', posted[0].text === 'working', posted[0].text)
}

// 3. take returns what to replace and stops tracking.
{
  const { t, posted } = tracker()
  await t.note('k', target, 'bash')
  const taken = t.take('k')
  check('take returns the message id', taken?.ts === 'ts-1', JSON.stringify(taken))
  check('take returns the target', taken?.target?.channel === 'C1')
  check('take stops tracking', t.size() === 0)
  check('take on an unknown conversation is null', t.take('other') === null)
  check('nothing was posted twice', posted.length === 1)
}

// 4. A conversation that produced no message is forgotten without one.
{
  const { t, posted } = tracker()
  t.forget('k')
  check('forgetting an unknown conversation is harmless', posted.length === 0 && t.size() === 0)
}

// 5. Conversations are independent.
{
  const { t, posted } = tracker()
  await t.note('a', { channel: 'CA', threadTs: null }, 'bash')
  await t.note('b', { channel: 'CB', threadTs: null }, 'grep')
  check('two conversations get two messages', posted.length === 2 && posted[0].target.channel === 'CA' && posted[1].target.channel === 'CB')
  check('each keeps its own id', t.take('a')?.ts === 'ts-1' && t.take('b')?.ts === 'ts-2')
}

// 6. A failed post leaves no message id, so nothing tries to edit a ghost.
{
  const posted = []
  const t = createProgressTracker({
    async post(target, text, opts = {}) { posted.push({ text, replace: opts.replace ?? null }); return null },
    throttleMs: 0, label: 'working', now: () => 1000,
  })
  await t.note('k', target, 'bash')
  await t.note('k', target, 'grep')
  check('a post that returned nothing is retried as a post', posted.length === 2 && posted[1].replace === null, JSON.stringify(posted))
  check('and take reports no message', t.take('k')?.ts === null)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
