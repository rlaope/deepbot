# Limitations

Written to be read by whoever inherits this repo, including future me. Nothing
here is hypothetical — each item is either observed behaviour or an explicit
decision with a cost.

## Not implemented

| Missing | Consequence | Where to fix |
|---|---|---|
| Slack attachments and images | The agent sees text only; a dropped file is invisible to it | `handleEvent`: fetch `url_private_download` with the bot token and pass it as an attachment |
| Progress streaming into Slack | The thread is silent until the turn finishes. Fine at ~1 s, wrong for a five-minute job | Post a placeholder message, then `chat.update` it; or emit `agent/assistant-stream` frames into a throttled edit |
| A "working on it" acknowledgement | Same as above — no feedback for slow turns | Do it together with the placeholder above |
| Queue-depth feedback | Beyond `maxConcurrency`, work waits silently | Report queue position after N seconds of waiting |
| `memory/` maintenance | Semantic memory is a *convention* in `AGENTS.md`, not code. Nothing extracts facts after a conversation, prunes stale ones, or injects them at prompt time | A curator plugin: schedule a pass over recent sessions, write dated facts, and add a recall step |
| Vector / embedding recall | Recall is FTS5 + whatever the model reads, not semantic similarity. Paraphrased questions may miss | Embed and index externally, or accept keyword recall |
| Cross-platform adapters | Slack only | The adapter is self-contained; a Discord or Telegram sibling is a new plugin with the same shape |

## Verified partially, or not at all

- **Cross-session recall does not exist.** Diagnosed, not merely unverified:
  - the session logs are present (one zstd-compressed `session.v4.jsonl.zstd` per
    session, bucketed by working directory);
  - the FTS index opens but holds **0 rows**;
  - the shipped model-facing tool set contains **no session search**, and the
    query service's consumers (the web client, the `@session` reference source)
    are both UI-driven.

  So the index is a substrate with no consumer in the agent plane. Recall has to
  be built: a plugin that queries `ctx.sessionQuery` and either exposes it as a
  tool or injects bounded hits before a turn. Configuration cannot fix this.
- **Duplicate-event suppression.** The rule is implemented and the code path was
  exercised, but no real Slack redelivery was observed, so the end-to-end path is
  untested.
- **Reconnect behaviour.** Backoff and `disconnect` handling are implemented from
  the Socket Mode protocol; no live network interruption was induced.
- **Attachment/thread edge cases.** Only plain threaded text has been exercised.

- **Reads are not sandboxed, and wrapping the gateway does not fix it.** Writes are
  confined to the agent home; reads are not. A parallel Seatbelt profile around the
  gateway did stop the reads and then broke everything else: macOS refuses nested
  `sandbox-exec`, so the harness's sandbox probe found no usable backend, refused
  to run bash at all, and the agent asked to escalate to `danger-full-access` —
  which hung, because no approval answerer exists. Reverted. A sandbox provider
  plugin or per-instance OS separation is the real fix; neither is built.

## Design risks

- **Non-public harness APIs.** Session driving, message construction, and the
  event fold are recovered from the shipped implementation. There are no type
  declarations to confirm they are public contract. A harness upgrade can break
  this plugin without a deprecation notice. Pin your harness version, and treat
  `docs/harness-api-notes.md` as the list of things to re-check on upgrade.
- **`installModelSelection` is not called.** The shipped runners pin the model
  selection inside `setup`; this plugin passes `agentOptions` only, because the
  helper is not importable from a profile-installed bundle. It works in the
  configuration tested, but this is the most likely source of a subtle
  model-selection failure.
- **The harness is a release candidate** (`0.2.0-rc.2` at the time of writing).
  Bundles, patch grammar, and service names can change.
- **One FTS index owner per path.** Running two gateways against the same index
  file is a documented constraint of that component, not something this plugin
  guards against.
- **One Socket Mode connection per Slack app.** Two clients on one app token make
  Slack split events across them and both sides start dropping messages. Never
  run a migration in parallel on the same app unless you intend the cutover.

## Operational caveats

- **`launchd` cannot read `~/Documents`** (macOS TCC). A job whose wrapper lives
  there dies with `getcwd: Operation not permitted`. `service/install-service.sh`
  copies the wrapper under `$HOME` for exactly this reason — do not "simplify" it
  away.
- **Session resume is bound to the working directory.** Moving the agent home
  orphans every existing thread's session. Threads keep accepting messages, but
  each one starts fresh, which looks like amnesia rather than an error.
- **`targetChannels: ['*']` answers in every channel the bot has joined.** The
  plugin refuses to start with an empty list, but `'*'` is a deliberate act: an
  invited bot plus `'*'` plus `replyMode: all` will answer every human message in
  those channels.
- **Token handling.** Credentials are read through the harness credential service;
  they are never written into plugin state. The plugin redacts `xox…`/`xapp…`
  patterns from its own log lines, but the log is still a plain file under
  `$DSH_HOME/slack-state/`. Treat it as sensitive.
- **Session logs are the memory substrate.** Deleting a session log deletes the
  memory of that conversation; the FTS index is derived and will simply follow.

## Verifying recall

```bash
DB="$DSH_HOME/session-index.db"
sqlite3 "$DB" "select count(*) from persisted_sessions;"
sqlite3 "$DB" "select count(*) from persisted_docs;"
sqlite3 "$DB" "select count(*) from persisted_docs where persisted_docs match 'some phrase you said';"
```

If the counts stay at zero after the gateway has handled and flushed turns, the
index is not reconciling (see the note in `docs/harness-api-notes.md` about how it
opens) — ask the agent to search its own history and see whether it can.
