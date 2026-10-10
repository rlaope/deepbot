# deepbot

**A standalone, always-on agent built on [DeepSeek Harness](https://github.com/deepseek-ai).**
The harness ships the runtime; this is the *agent edition* of it — a long-running
process that lives in Slack, keeps durable sessions, remembers across
conversations, and can speak first.

```
                        ┌──────────────────────────────────────────┐
   Slack  ──Socket Mode──▶  DSH gateway process                    │
                        │                                          │
                        │  deepbot  (this repo, index.ts)   │
                        │      │  agents.create / agents.resume    │
                        │      ▼                                   │
                        │  agents  ──▶  session log (event-sourced)│
                        │                │                         │
                        │                ├─▶ FTS index  (recall)   │
                        │                ├─▶ projections           │
                        │                └─▶ skills, memory/,      │
                        │                    AGENTS.md             │
                        └──────────────────────────────────────────┘
```

No process is spawned per message: the adapter drives the gateway's already-running
`agents` service, so a turn is a session call, not a CLI invocation.

---

## Direction

- **[SPEC.md](SPEC.md)** — what this is, who it is for, and what it must never do.
- **[PLAN.md](PLAN.md)** — milestones in dependency order, each with acceptance
  criteria, and the working rules that keep this from becoming a loop of manual
  testing and symptom patching.

Both are drafts until their open decisions are answered.

## Status: early, and honest about it

| Area | State |
|---|---|
| In-process session create + **resume** (multi-turn) | ✅ verified live |
| Slack Socket Mode receive/reply, threads, chunking | ✅ verified live |
| Duplicate-event suppression, reconnect with backoff | ✅ retries forever; regression tested |
| **Cross-session memory** (write notes, recall with dates, admit ignorance) | ✅ verified by `test/run-scenario.mjs` — 5/5, cold, on a fresh home |
| **Never silently dead** (health probe, self-heal, alert) | ✅ verified by injecting an unhealthy state: restart → recovered |
| **Scheduled reminders delivered to Slack** | ✅ delivery path unit-tested (8/8) |
| **Watches** ("tell me when this changes") | ✅ 16/16 unit, verified live with a real DM |
| Sessions composed with an agent preset (the agent has tools) | ✅ verified — this was missing and made every other failure look like a memory bug |
| Install from the repository alone | ✅ verified: profile from `profile/` + one install command → 5/5 |
| **Reading the conversation it was mentioned in** | ✅ live: a real meeting thread is fetched, paged, name-resolved and injected as content |
| Attachments / images from Slack | ❌ not implemented |
| Streaming progress into Slack | ❌ posts the finished turn only |
| Read-scope isolation between instances | ❌ reads are not sandboxed; see [SPEC.md](SPEC.md) §8 |

Built and tested against DeepSeek Harness `0.2.0-rc.2`. The plugin calls a few
services whose public-contract status is uncertain — see
[docs/harness-api-notes.md](docs/harness-api-notes.md).

---

## What it actually is

Three layers, all in this repo:

1. **`index.ts`** (built to `dist/index.js`) — a Slack platform adapter as a DSH *bundle plugin*. It owns the
   Socket Mode connection, maps `channel:thread → sessionId`, drives one agent
   turn per message, and posts the answer back into the thread.
2. **`profile/`** — the gateway profile. `dsh-base` + `dsh-web-app` +
   the schedule bundle + this plugin. The only opinionated change is turning on
   the session FTS index, which the base composition leaves off.
3. **`service/`** — a supervisor wrapper and a launchd installer, because an
   always-on agent should survive logout and reboot.

## Requirements

- DeepSeek Harness (the `dsh` CLI). On macOS it ships inside the desktop app;
  pass the path via `DSH_BIN`.
- Node.js 22+ (the adapter uses the built-in `fetch` and `WebSocket`; zero
  dependencies).
- A Slack app using **Socket Mode**. No public URL is needed.

## Slack app setup

1. Create an app at <https://api.slack.com/apps>.
2. **Socket Mode** → on → generate an app-level token with `connections:write`
   (`xapp-…`).
3. **OAuth & Permissions** → bot scopes:
   `app_mentions:read`, `chat:write`, `channels:read`, and `channels:history`
   if you want it to read channel history.
4. **Event Subscriptions** → subscribe to `app_mention`.
5. Install to the workspace → bot token (`xoxb-…`).
6. `/invite` the bot into every channel it should serve. **A bot cannot see a
   channel it has not been invited to** — this is the most common silent failure.

> One Socket Mode connection per app. Opening a second one makes Slack split
> events across them, and both clients start dropping messages. If you are
> migrating from another bot, stop the old process before starting this one.

## Install

Tests that need no harness (run these first; CI runs them too):

```bash
npm test                      # reconnect 5/5, delivery 8/8, watches 16/16
node test/run-scenario.mjs    # boots a real profile; needs a model credential
```

The sources are TypeScript. `init.sh` builds them; to do it by hand:

```bash
pnpm install                    # typescript and @types/node
pnpm run build                  # tsc -> dist/
pnpm run typecheck              # no emit
```

The profile loads `dist/index.js`, so a checkout without `dist/` cannot start. The
service wrapper rebuilds when `dist/` is missing or older than the sources, and if
a build fails it starts with the existing `dist/` rather than taking a working bot
down — refusing only when there is nothing to load.

```bash
# 1) create the agent home (persona files) and the gateway profile
./init.sh                       # add --dry-run to see what it would do first
#    ~/dsh-agent/  <- SOUL.md AGENTS.md USER.md MEMORY.md, memory/ state/
#    ~/.dsh/profiles/agent/  <- the profile, with this repo registered as a bundle
#    Re-running it keeps every file that already exists.

# 2) provide credentials (chosen by the credential service, never by this code)
cat >> "$DSH_HOME/.env" <<'EOF'
SLACK_BOT_TOKEN=xoxb-<your-bot-token>
SLACK_APP_TOKEN=xapp-<your-app-token>
EOF
chmod 600 "$DSH_HOME/.env"

# 3) set the channels this agent may answer in
$EDITOR /absolute/path/to/deepbot/cordis.patch.yml   # targetChannels

# 4) run it
dsh --profile agent --port 19500 --no-open
```

`targetChannels` accepts explicit channel IDs or `'*'` for *every channel the bot
was invited to*. It refuses to start with an empty list, so a misconfiguration
cannot turn the bot loose everywhere.

Then, to make it survive reboots:

```bash
service/install-service.sh            # launchd; auto-start + restart on exit
service/install-service.sh --status
```

## Persona and memory

Four files in the agent home decide who the agent is and what it remembers. All
four are read at the start of **every** turn, in this order:

| File | What it holds | Budget | Changes |
|---|---|---|---|
| `SOUL.md` | identity and voice | 6,000 chars | rarely |
| `AGENTS.md` | operating rules | 12,000 chars | when a rule is wrong |
| `USER.md` | durable facts about the user | 4,000 chars | as you learn them |
| `MEMORY.md` | durable facts about the work | 4,000 chars | as you learn them |

Topical notes that outgrow a line belong in `memory/<topic>.md`, which is injected
in full as well.

```bash
./init.sh --home ~/my-agent            # scaffold all four from agent/*.md
$EDITOR ~/my-agent/SOUL.md             # make it yours — this one matters most
npm run persona -- ~/my-agent          # check it
```

```
   SOUL.md      1879 /   6000  persona
   AGENTS.md    3934 /  12000  operating rules
   USER.md      1528 /   4000  facts about the user
   MEMORY.md     296 /   4000  facts about the work

  injected total    7637 /  26000
```

`npm run persona` exists because an over-budget file is **truncated silently**: the
tail simply stops being part of the prompt, with nothing logged. It reports the
exact overflow, warns when the same fact is written into two files (it would be
injected twice), warns about undated lines, and refuses on a secret — a token in a
persona file would otherwise be in every prompt and every session log.

```
Problems
  - USER.md: 5120 chars against a 4000 budget — the last 1120 characters are cut
    from every prompt. Trim it or move detail into memory/<topic>.md.
```

## Prompt caching, and what gets injected

Prompt caching reuses a stable prefix, so anything that changes early in the prompt
throws away everything after it — and anything repeated every turn is paid for
every turn. Two rules follow, and this adapter is built around them.

**Standing context goes in once.** `SOUL.md`, `AGENTS.md`, `USER.md` and `MEMORY.md`
are injected by `dsh-agent-instructions`, which appends them as one durable baseline,
adds only deltas afterwards, and is written so new content does not invalidate
existing KV cache entries. Do not re-inject them per turn: doing that duplicated
`AGENTS.md` (measured: 7,625 characters per turn on top of the harness's own 3,634)
and left a copy of every file in every historical turn.

**Only the changing part is dynamic.** The adapter's own block — where this
conversation is, which directory is writable, which topic notes exist — is
digest-gated per session and sent only when its content changes. Thread messages are
sent as a delta: only what has not been delivered yet, never the whole thread again.

The budgets described above apply because all of it is re-sent or retained:

```
tokens: input 13416 (0% cache-read) uncached 13416 output 112
tokens: input 29458 (45% cache-read) uncached 16146 output 131
tokens: input 48031 (61% cache-read) uncached 18847 output 139
```

Three turns of one conversation. Each turn adds about 2.7K uncached tokens; the
whole prefix before it is served from cache. The numbers come from the
`tokenUsage` session projection — the raw session log carries no usage events, so
this is where to look. They are printed after every turn.

```
context injection: standing block 217 chars; instruction files present: SOUL.md, AGENTS.md, USER.md, MEMORY.md
```

A home with none of those files logs a warning, because then the agent has no
standing context at all — which is silent otherwise.

## Drive the agent without Slack (diagnostic)

The plugin has a mode that exercises session create **and** resume in the gateway
without opening a socket. Use it to verify the profile before wiring Slack:

```yaml
# cordis.patch.yml
      config:
        targetChannels: ['*']
        selfTest: "Say hello in one line."
```

Boot the profile and read `$DSH_HOME/slack-state/deepbot.log`:

```
selfTest turn 1: reason=completed session=slack-… text="Hello!"
selfTest turn 2 (resumed): reason=completed text="You asked me to say hello."
selfTest result: session create + resume both succeeded
```

## How a turn works

```
Socket Mode envelope (events_api)
  ├─ ack within 3s                       (Slack drops unacknowledged events)
  ├─ allowlist + bot/subtype/edit filter
  ├─ dedupe by event_id                  (Slack redelivers)
  ├─ key = channel:thread_ts             → sessionId (persisted)
  └─ background:
       agents.resume(sessionId) | agents.create(...)
         → followup(userMessage(prompt))
         → whenIdle()
         → sessions.flush()              (durability barrier)
         → read last assistant text from the log
         → chat.postMessage(thread_ts)
```

`reason.kind === 'completed'` decides success. Anything else is reported into the
thread — a failed turn never looks like a silent one.

## Memory

The harness gives memory a real substrate: an append-only, event-sourced session
log with format migrations, projections, and search. This repo wires up the parts
it does not turn on by default:

| Layer | Mechanism | Included here |
|---|---|---|
| Working | the session itself + compaction | via `dsh-base` |
| Episodic | SQLite FTS5 over past sessions | substrate only — the index is opened here, but **nothing queries it on the agent's behalf yet** |
| Semantic | `memory/` files in the agent home | convention, see `agent/AGENTS.md` |
| Procedural | `SKILL.md` bundles, watched and reloaded | via `dsh-base` |
| Identity | `AGENTS.md` chain | via `dsh-base` |

Two separate things have to be true before the agent can remember, and only the
first one is a configuration change:

1. **Substrate.** `dsh-base` ships session search *off* (`path: ':memory:'`,
   `openAt: never`). `profile/cordis.patch.yml` opens it on a real file at
   startup.
2. **A consumer.** The search service is consumed by the web UI and by the
   `@session` reference source, both of which are UI-driven. The agent plane gets
   **no tool and no injected context** from it — a grep of the shipped tool set
   finds nothing session-related.

So opening the index is necessary but not sufficient. Until a recall plugin exists
(see [docs/limitations.md](docs/limitations.md)), threads remember their own
history and nothing else.

## Layout

```
index.ts                    the Slack adapter plugin (built to dist/, zero runtime dependencies)
cordis.patch.yml            its bundle patch (inserts the adapter row)
profile/                    gateway profile: bundle list + the memory switch
agent/AGENTS.md             identity and operating rules template
service/run-gateway.sh      supervisor-safe wrapper (strips DSH session vars)
service/install-service.sh  launchd installer, TCC-aware
docs/harness-api-notes.md   the harness contracts this plugin relies on
docs/limitations.md         what is not implemented, and what is risky
```

## Gotchas worth knowing before you debug for an hour

- `apps.connections.open` needs the **app-level** token (`xapp-`) and is
  **POST-only**. A bot token gives `not_allowed_token_type`; a GET gives
  `insecure_request`.
- A user message needs a stable `id`. Without it the persisted log fails
  validation on the next read (`lacks an identified message`) and resume breaks —
  which only shows up on the *second* turn.
- Session resume is bound to the recorded working directory. Change the gateway's
  cwd and old threads stop resuming.
- `launchd` does not inherit your shell's privacy permissions. A job whose script
  lives in `~/Documents` dies with `getcwd: Operation not permitted`. The
  installer copies the wrapper under `$HOME` for this reason.
- The FTS index has **one owning process per path**. Do not point two gateways at
  the same index file.

## License

MIT — see [LICENSE](LICENSE).
