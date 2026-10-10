# Changelog

Notable changes, newest first. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the caveat about version numbers is at the bottom.

## 0.2.0 — 2026-10-10

M6 and M7 from [PLAN.md](PLAN.md), plus the release work: TypeScript, three transports,
confined reads, images, interruptible turns, and approvals over chat.

### Added

- **Transports.** Slack behind a seam (`transports/slack.ts`), then Telegram (long polling)
  and Discord (gateway websocket + REST). One core, one transport per platform; the core is
  driven in tests by `test/fake-transport.mjs` with no platform account at all.
- **Vision.** An attached image reaches the model as a picture, admitted through the
  harness's attachment service. Verified by a scenario that asks for the colour of a
  solid-colour fixture — a fact nothing in the prompt reveals.
- **Interrupt.** `그만` / `중단` / `취소` / `stop` cancels a running turn, and the same path
  serves the turn timeout, which until then stopped only the waiting.
- **Progress.** One message per conversation, edited in place with tool names and elapsed
  time, replaced by the answer.
- **Approvals over chat.** A request is posted into the conversation and `허용` / `거부`
  settles it. Destructive commands inside the workspace (where the sandbox permits deletion)
  ask first.
- **Read confinement.** Commands run under `service/confined-runner.sh`; the file tools are
  fenced by a `tools/pre-execute` read scope over `read`, `read_image`, `grep` and `glob`.
- **TypeScript.** Build toolchain and CI typecheck, hand-written declarations for the DSH
  services this plugin uses (`types/dsh.ts`), and the transport seam as a type.
- `init.sh` for a one-command persona and profile setup, `tools/persona-check.mjs` for
  checking the injected files before they are silently truncated, `npm run persona`.

### Fixed

- A turn that needs an approval no longer waits forever for an answerer that does not exist.
- Standing context is injected once instead of every turn: the persona files are delegated
  to `dsh-agent-instructions`, which appends them as one durable baseline and is written so
  new content does not invalidate the prompt cache.
- The recall index is refreshed after every turn rather than by a ten-minute timer, and no
  longer indexes the adapter's own injected preamble.
- Reconnection retries forever instead of once, with a watchdog: a single retry that failed
  left the bot alive and silent for 57 minutes.
- The document scenario asserts the document's text rather than its byte size. The size
  floor rejected a valid 1 KB docx that a run had built by hand.
- Defects found by running rather than reading: a missing `readdirSync` import that made the
  note index fail silently, a `fetchHistoryConfig` path returning two different types, a
  `mktemp` template BSD could not expand, a stale `dist` being tested, and a profile edit
  that deleted the sandbox row and switched read confinement off for two rounds without
  saying so.

### Security

- An agent's commands cannot read another instance's home or a retired bot's data.
- The file tools refuse reads outside the workspace, temp and read-only tooling.
- A repository-wide secret scan and a persona check run in CI; both fail the build.

### Known limitations

- The read scope is a policy boundary, not a kernel one: the tool list has to grow with the
  composition. One OS user per instance remains the stronger answer, and is not built.
- Images require the model route to declare `input: [text, image]`; text-only deployments
  degrade to a filename.
- One instance is one memory. Multi-tenancy is not built.
- No voice, video, or browser automation.

## 0.1.0 — 2026-10-06

The starting point: a Slack Socket Mode adapter as a DSH bundle plugin with a gateway
profile and a durable thread→session mapping. M0–M5 — presence, a scenario harness, working
memory, health, autonomy and distribution — were built on top of it during the same week,
before this file existed; [PLAN.md](PLAN.md) is the record of those milestones.

## Versioning

These numbers describe this plugin's own surface. Its dependency is DeepSeek Harness
`0.2.0-rc.2`, and a release candidate can change underneath it: the distribution ships no
`.d.ts`, so `types/dsh.ts` is read from the shipped JSDoc and verified by running the real
services. Expect 0.x while the harness is pre-release.
