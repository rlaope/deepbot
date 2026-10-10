/**
 * The core, driven by a fake transport.
 *
 * This is what the transport seam was for. Mapping, the channel allowlist,
 * de-duplication, the history delta, progress, and the failure paths are
 * platform-agnostic, and until now the only way to exercise them was to talk to
 * Slack. Here they run with no account and no network, and the assertions are on
 * what the core *asked the transport for* rather than on what a platform replied.
 *
 * A turn cannot complete without the DSH services, so a delivered message reaches
 * the failure path. That path is a feature: a turn that cannot run still answers,
 * and the test uses it to check the pointer guard as well.
 *
 * Run: node test/core.test.mjs
 */
import './dist-fresh.mjs'   // fails loudly on a stale dist

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../dist/index.js'
import { createFakeTransport } from './fake-transport.mjs'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Boot the plugin with a fake transport and a state file we control. */
function boot({ state = {}, config = {} } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'deepbot-core-'))
  writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({
    sessions: {}, seen: {}, standing: {}, history: {}, ...state,
  }))
  const transport = createFakeTransport(config.fake ?? {})
  const logs = []
  const listeners = {}
  const ctx = {
    get: () => undefined,
    effect: (fn) => fn(),
    on: (name, handler) => { (listeners[name] ??= []).push(handler); return () => {} },
    logger: { info: (l) => logs.push(String(l)) },
  }
  apply(ctx, {
    targetChannels: ['C_ALLOWED'],
    stateDir,
    transportFactory: () => transport,
    progressAfterMs: 50,
    ...config,
  })
  const read = () => JSON.parse(readFileSync(join(stateDir, 'sessions.json'), 'utf8'))
  /** Run the pre-execute gate the way the harness would. */
  const gate = (exec) => {
    const listeners_ = listeners['tools/pre-execute'] ?? []
    if (listeners_.length === 0) return '(no gate)'
    let delegated = false
    const decision = listeners_[0](exec, () => { delegated = true; return { kind: 'allow' } })
    return delegated ? 'delegated' : decision
  }
  /** Fire an approval request the way the harness would, and get the outcome back. */
  const askApproval = (sessionId = 'slack-abc', reason = 'escalate sandbox to danger-full-access') =>
    listeners['approval/request'][0]({ agent: { session: { header: { id: sessionId } } }, reason })
  return { transport, logs, stateDir, read, askApproval, gate, done: () => rmSync(stateDir, { recursive: true, force: true }) }
}

// 1. An allowed message reaches the transport, with the thread it arrived in.
{
  const t = boot()
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'ping', target: { channel: 'C_ALLOWED', threadTs: 't1' } }))
  await sleep(300)
  check('an allowed message asks the transport for history', t.transport.historyCalls.length === 1, `${t.transport.historyCalls.length} call(s)`)
  check('it asks for the right conversation', t.transport.historyCalls[0]?.target?.channel === 'C_ALLOWED')
  check('the first turn asks for the whole thread', t.transport.historyCalls[0]?.sinceTs === null, String(t.transport.historyCalls[0]?.sinceTs))
  t.done()
}

// 2. Policy: a channel outside the allowlist is ignored, and nothing is fetched.
{
  const t = boot()
  await sleep(60)
  t.transport.deliver(t.transport.message({ target: { channel: 'C_OTHER', threadTs: 't1' } }))
  await sleep(200)
  check('a channel outside the allowlist is ignored', t.transport.historyCalls.length === 0 && t.transport.posted.length === 0)
  t.done()
}

// 3. The transport decides what is "addressed"; the core obeys it.
{
  const t = boot()
  await sleep(60)
  t.transport.deliver(t.transport.message({ addressed: false }))
  await sleep(200)
  check('an unaddressed message is ignored', t.transport.historyCalls.length === 0)
  t.done()
}

// 4. The same platform event twice is handled once.
{
  const t = boot()
  await sleep(60)
  const message = t.transport.message()
  t.transport.deliver(message)
  await sleep(150)
  t.transport.deliver(message)
  await sleep(200)
  check('a repeated event id is de-duplicated', t.transport.historyCalls.length === 1, `${t.transport.historyCalls.length} call(s)`)
  check('the duplicate is logged', t.logs.some((l) => /duplicate event ignored/.test(l)))
  t.done()
}

// 5. The history pointer is a delta, and a turn that did not complete does not
//    advance it — otherwise the messages it never delivered are swallowed.
{
  const t = boot({ state: { history: { 'C_ALLOWED:t1': '500.1' } }, config: { fake: { history: { text: 'context', lastTs: '999.9' } } } })
  await sleep(60)
  t.transport.deliver(t.transport.message({ target: { channel: 'C_ALLOWED', threadTs: 't1' } }))
  await sleep(300)
  check('a later turn asks only for what is new', t.transport.historyCalls[0]?.sinceTs === '500.1', String(t.transport.historyCalls[0]?.sinceTs))
  check('a turn that did not complete does not advance the pointer', t.read().history['C_ALLOWED:t1'] === '500.1', t.read().history['C_ALLOWED:t1'])
  t.done()
}

// 6. A turn that cannot run still answers, rather than leaving the user waiting.
{
  const t = boot()
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'will fail' }))
  await sleep(400)
  check('a failed turn still replies', t.transport.posted.some((p) => /Execution failed|did not complete/.test(p.text)), `${t.transport.posted.length} post(s)`)
  t.done()
}

// 7. Attachments are handed to the transport with a stamp, and its manifest reaches
//    the prompt (the manifest text is what the core inserts; here it is asserted
//    through the call, since the prompt itself needs an agent).
{
  const t = boot({ config: { fake: { attachments: { text: '[attachments] one file' } } } })
  await sleep(60)
  const files = [{ name: 'a.txt', mimetype: 'text/plain', size: 3, url_private_download: 'https://x/a.txt' }]
  t.transport.deliver(t.transport.message({ files }))
  await sleep(300)
  check('attachments are passed to the transport', t.transport.attachmentCalls.length === 1)
  check('with a filesystem-safe stamp', /^\d+-\d+$/.test(String(t.transport.attachmentCalls[0]?.stamp)), String(t.transport.attachmentCalls[0]?.stamp))
  t.done()
}

// 8. Unloading closes the transport and says which case it was.
{
  const t = boot()
  await sleep(60)
  await t.transport.close()
  check('closing the transport is recorded', t.transport.closed >= 1)
  check('hasSocket reports false afterwards', t.transport.hasSocket() === false)
  t.done()
}

// 9. A stop request with nothing running says so, and does not start a turn.
{
  const t = boot()
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: '그만' }))
  await sleep(250)
  check('a stop request starts no turn', t.transport.historyCalls.length === 0, `${t.transport.historyCalls.length} call(s)`)
  check('and says there is nothing to stop', t.transport.posted.some((p) => /작업이 없습니다/.test(p.text)), JSON.stringify(t.transport.posted.map((p) => p.text)))
  t.done()
}

// 9b. A finished turn leaves nothing behind to be "stopped".
{
  const t = boot()
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'this turn will fail' }))
  await sleep(300)
  t.transport.deliver(t.transport.message({ text: '그만' }))
  await sleep(250)
  check('a finished turn is not reported as stoppable', !t.logs.some((l) => /cancelling the running turn/.test(l)), t.logs.filter((l) => /cancelling/.test(l)).join(' | '))
  check('and the stop request says nothing is running', t.transport.posted.some((p) => /작업이 없습니다/.test(p.text)), JSON.stringify(t.transport.posted.map((p) => p.text.slice(0, 30))))
  t.done()
}

// 10. The shapes people actually type are recognised, and nothing else is.
{
  for (const word of ['중단', 'stop', 'Cancel!', '멈춰']) {
    const t = boot()
    await sleep(60)
    t.transport.deliver(t.transport.message({ text: word }))
    await sleep(200)
    check(`"${word}" is read as a stop request`, t.transport.historyCalls.length === 0 && t.transport.posted.length === 1, `${t.transport.historyCalls.length} turn(s)`)
    t.done()
  }
  // A sentence that merely contains the word is a request, not a stop.
  const t = boot()
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: '이 작업 그만 두고 다른 걸 해줘' }))
  await sleep(250)
  check('a sentence containing the word is still a turn', t.transport.historyCalls.length === 1, `${t.transport.historyCalls.length} turn(s)`)
  t.done()
}

// 11. Approvals over chat: the request reaches the thread, and the answer settles it.
{
  const t = boot({ state: { sessions: { 'C_ALLOWED:t1': 'slack-abc' } } })
  await sleep(60)
  const outcome = t.askApproval()
  await sleep(100)
  check('an approval request is posted into the conversation', t.transport.posted.some((p) => /권한이 필요합니다/.test(p.text)), JSON.stringify(t.transport.posted.map((p) => p.text.slice(0, 40))))
  check('the request says how to answer', t.transport.posted.some((p) => /허용/.test(p.text) && /거부/.test(p.text)))
  t.transport.deliver(t.transport.message({ text: '허용' }))
  check('answering 허용 allows the action once', await outcome === 'allowed-once', await outcome)
  check('a decision is confirmed', t.transport.posted.some((p) => /허용했습니다/.test(p.text)))
  check('the decision is logged', t.logs.some((l) => /approval in C_ALLOWED:t1 answered: allowed-once/.test(l)))
  t.done()
}

// 12. Denying is a rejection, not a hang.
{
  const t = boot({ state: { sessions: { 'C_ALLOWED:t1': 'slack-abc' } } })
  await sleep(60)
  const outcome = t.askApproval()
  await sleep(100)
  t.transport.deliver(t.transport.message({ text: '거부' }))
  check('answering 거부 rejects', await outcome === 'rejected', await outcome)
  t.done()
}

// 13. Fail closed: no conversation to ask in, or a request already pending.
{
  const t = boot({ state: { sessions: { 'C_ALLOWED:t1': 'slack-abc' } } })
  await sleep(60)
  check('an unmapped session fails closed', await t.askApproval('slack-unmapped') === 'unavailable')
  const first = t.askApproval()
  await sleep(50)
  check('a second request while one is pending fails closed', await t.askApproval() === 'unavailable')
  t.transport.deliver(t.transport.message({ text: '허용' }))
  check('and the first one still resolves', await first === 'allowed-once')
  t.done()
}

// 14. An unrelated message while an approval is pending is still a turn.
{
  const t = boot({ state: { sessions: { 'C_ALLOWED:t1': 'slack-abc' } } })
  await sleep(60)
  const pending = t.askApproval()
  await sleep(100)
  t.transport.deliver(t.transport.message({ text: '이거 말고 다른 걸 해줘' }))
  await sleep(250)
  check('a message that is not a decision still becomes a turn', t.transport.historyCalls.length === 1, `${t.transport.historyCalls.length} turn(s)`)
  check('and the approval is still pending', t.transport.posted.filter((p) => /허용했습니다|거부했습니다/.test(p.text)).length === 0)
  t.transport.deliver(t.transport.message({ text: '거부' }))
  check('until it is answered', await pending === 'rejected')
  t.done()
}

// 15. A request nobody answers is cancelled, not left waiting forever.
{
  const t = boot({ state: { sessions: { 'C_ALLOWED:t1': 'slack-abc' } }, config: { approvalTimeoutMs: 150 } })
  await sleep(60)
  const outcome = await t.askApproval()
  check('an unanswered approval is cancelled', outcome === 'cancelled', outcome)
  check('and the timeout is logged', t.logs.some((l) => /approval in C_ALLOWED:t1 timed out/.test(l)))
  t.done()
}

// 16. The gate asks for destructive commands, and only where a human can answer.
{
  const t = boot({ state: { sessions: { 'C_ALLOWED:t1': 'slack-abc' } } })
  await sleep(60)
  const exec = (command, sessionId = 'slack-abc', name = 'bash') => ({ name, arguments: { command }, agent: { session: { header: { id: sessionId } } } })
  const asked = t.gate(exec('rm -rf memory'))
  check('a destructive command is gated', asked?.kind === 'ask', JSON.stringify(asked))
  check('the gate says what it saw', /rm -rf/.test(String(asked?.reason)), String(asked?.reason).slice(0, 80))
  check('an ordinary command is not gated', t.gate(exec('ls -la')) === 'delegated')
  check('another tool is not gated', t.gate(exec('rm -rf x', 'slack-abc', 'grep')) === 'delegated')
  check('no conversation means no pretend question', t.gate(exec('rm -rf x', 'slack-unmapped')) === 'delegated')
  check('the deferral is logged', t.logs.some((l) => /no conversation to ask in/.test(l)))
  check('asking is logged', t.logs.some((l) => /asking for approval: "rm /.test(l)), t.logs.filter((l) => /asking/.test(l)).join(' | '))
  t.done()
}

// 17. The file tools cannot read outside the workspace, and writes are unaffected.
{
  const t = boot({ state: { sessions: { 'C_ALLOWED:t1': 'slack-abc' } } })
  await sleep(80)
  const exec = (name, args, sessionId = 'slack-abc') => ({ name, arguments: args, agent: { session: { header: { id: sessionId } } } })
  const home = process.cwd()
  check('a read inside the workspace is allowed', t.gate(exec('read', { file_path: join(home, 'README.md') })) === 'delegated')
  check('a relative read is resolved against the workspace', t.gate(exec('read', { file_path: 'index.ts' })) === 'delegated')
  const denied = t.gate(exec('read', { file_path: `${process.env.HOME}/.hermes/profiles/miku/.env` }))
  check('a read outside is denied', denied?.kind === 'deny', JSON.stringify(denied))
  check('and the denial says what to do instead', /put the file there|paste its contents/.test(String(denied?.reason)), String(denied?.reason).slice(0, 90))
  check('the denial is logged', t.logs.some((l) => /read outside the sandbox denied/.test(l)))
  check('a read in temp is allowed', t.gate(exec('read', { file_path: '/tmp/some-file.txt' })) === 'delegated')
  check('grep with an outside path is denied', t.gate(exec('grep', { pattern: 'token', path: '/etc' }))?.kind === 'deny')
  check('glob with an absolute outside pattern is denied', t.gate(exec('glob', { pattern: '/etc/**' }))?.kind === 'deny')
  check('writes are not affected by the read scope', t.gate(exec('write', { file_path: `${process.env.HOME}/outside.txt`, content: 'x' })) === 'delegated')
  check('an unnamed tool is not covered', t.gate(exec('todo_write', { file_path: '/etc/hosts' })) === 'delegated')
  t.done()
}

// 18. Buttons, where the transport can render them: the same decision, made in place.
{
  const t = boot({ state: { sessions: { 'C_ALLOWED:t1': 'slack-abc' } }, config: { fake: { supportsButtons: true } } })
  await sleep(60)
  const outcome = t.askApproval()
  await sleep(100)
  const withButtons = t.transport.posted.find((p) => p.buttons !== null)
  check('an approval on a button-capable transport posts buttons', withButtons?.buttons?.length === 2, JSON.stringify(withButtons?.buttons))
  check('the buttons carry what they mean', withButtons?.buttons?.[0]?.id === 'approval:allow:C_ALLOWED:t1', String(withButtons?.buttons?.[0]?.id))
  check('and the label is not an instruction to type', !/허용.*거부.*답해주세요/.test(String(withButtons?.text)) || /버튼으로 결정/.test(String(withButtons?.text)), String(withButtons?.text).slice(-60))
  t.transport.press('approval:allow:C_ALLOWED:t1')
  check('pressing 허용 allows the action once', await outcome === 'allowed-once', await outcome)
  check('the press is logged as a decision by button', t.logs.some((l) => /answered by button: allowed-once/.test(l)))
  check('and a confirmation is posted', t.transport.posted.some((p) => /허용했습니다/.test(p.text)))
  t.done()
}

// 19. A button for a request that is already settled says so rather than doing nothing.
{
  const t = boot({ state: { sessions: { 'C_ALLOWED:t1': 'slack-abc' } }, config: { fake: { supportsButtons: true } } })
  await sleep(60)
  t.transport.press('approval:allow:C_ALLOWED:t1')
  await sleep(150)
  check('a stale button is answered', t.transport.posted.some((p) => /이미 처리된 요청/.test(p.text)), JSON.stringify(t.transport.posted.map((p) => p.text.slice(0, 24))))
  check('and it is logged', t.logs.some((l) => /nothing is pending/.test(l)))
  check('an unknown action id is logged, not swallowed', (() => { t.transport.press('something-else'); return t.logs.some((l) => /unhandled action id/.test(l)) })())
  t.done()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
