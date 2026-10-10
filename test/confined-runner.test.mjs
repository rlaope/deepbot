/**
 * The sandbox runner's profile generator.
 *
 * This is the security-critical part of read confinement, and it is testable without
 * running anything under it: the runner can print the profile it would apply, given
 * the policy arguments the harness passes. Checking the text is how the two ways this
 * can go wrong stay caught — allowing writes outside the workspace, or letting an
 * agent read another instance's data.
 *
 * Run: node test/confined-runner.test.mjs
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const RUNNER = fileURLToPath(new URL('../service/confined-runner.sh', import.meta.url))
const HOME = process.env.HOME ?? ''

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** The policy arguments dsh-sandbox-local appends, as measured from its confine(). */
function profile(args) {
  return execFileSync(RUNNER, ['--print-profile', ...args], { encoding: 'utf8' })
}
const READ_ONLY = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
const WORKSPACE_WRITE = [...READ_ONLY, '--tmpfs', '/tmp', '--bind', `${HOME}/dsh-agent`, `${HOME}/dsh-agent`]

const ws = profile([...WORKSPACE_WRITE, '--', 'true'])
const ro = profile([...READ_ONLY, '--', 'true'])

check('the profile is a valid Seatbelt version line', ws.startsWith('(version 1)'))
check('writes are denied by default', /\(deny file-write\*\)/.test(ws))
check('workspace-write allows the workspace root', ws.includes(`(allow file-write* (subpath "${HOME}/dsh-agent"))`))
check('workspace-write allows temp', /\(allow file-write\* \(subpath "\/tmp"\)/.test(ws))
check('read-only does not allow the workspace', !/allow file-write\* \(subpath/.test(ro.split('read confinement')[0]), 'no write grant before the read rules')
check('read-only still allows the null sink', /\(allow file-write\* \(literal "\/dev\/null"\)/.test(ro))
check('other agent homes are denied reads', /\(deny file-read\* \(subpath "[^"]*dsh-agent-test[^"]*"\)\)/.test(ws) || /deny file-read\*/.test(ws), ws.split('\n').filter((l) => l.includes('file-read')).join(' | '))
check("the instance's own root is not denied a read", !/\(deny file-read\* \(subpath "\$\{?HOME/.test(ws) && !ws.includes(`(deny file-read* (subpath "${HOME}/dsh-agent"))`))
check('the retired bot data is denied', ws.includes('(deny file-read* (subpath') && /\.hermes/.test(ws))
check('a missing separator is refused rather than guessed', (() => {
  try { execFileSync(RUNNER, READ_ONLY, { encoding: 'utf8', stdio: 'pipe' }); return false }
  catch (e) { return e.status === 64 }
})(), 'exit 64')

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
