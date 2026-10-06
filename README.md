# deepbot

**A standalone, always-on agent built on [DeepSeek Harness](https://github.com/deepseek-ai).**
The harness ships the runtime; this is the *agent edition* of it — a long-running
process that lives in Slack, keeps durable sessions, remembers across
conversations, and can speak first.

```
                        ┌──────────────────────────────────────────┐
   Slack  ──Socket Mode──▶  DSH gateway process                    │
                        │                                          │
                        │  deepbot  (this repo, index.js)   │
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

## Status: early, and honest about it

| Area | State |
|---|---|
| In-process session create + **resume** (multi-turn) | ✅ verified on a live workspace |
| Slack Socket Mode receive/reply, threads, chunking | ✅ verified |
| Duplicate-event suppression, reconnect with backoff | ✅ implemented (dup path unit-checked) |
| Live one-to-one replacement of a production bot | ✅ done once, end to end |
| Cross-session **FTS recall** | ⚠️ configured, **not verified** — see [docs/limitations.md](docs/limitations.md) |
| Attachments / images from Slack | ❌ not implemented |
| Streaming progress into Slack | ❌ posts the finished turn only |

Built and tested against DeepSeek Harness `0.2.0-rc.2`. The plugin calls a few
services whose public-contract status is uncertain — see
[docs/harness-api-notes.md](docs/harness-api-notes.md).

---

## What it actually is

Three layers, all in this repo:

1. **`index.js`** — a Slack platform adapter as a DSH *bundle plugin*. It owns the
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

```bash
# 1) create the gateway profile
cp -r profile "$DSH_HOME/profiles/agent"       # $DSH_HOME defaults to ~/.dsh
#    and register the bundles in a fresh profile package.json if you renamed it

# 2) install this repo as a bundle into that profile
dsh plugin --profile agent add /absolute/path/to/deepbot

# 3) provide credentials (chosen by the credential service, never by this code)
cat >> "$DSH_HOME/.env" <<'EOF'
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_APP_TOKEN=xapp-your-token
EOF
chmod 600 "$DSH_HOME/.env"

# 4) set the channels this agent may answer in
$EDITOR /absolute/path/to/deepbot/cordis.patch.yml   # targetChannels

# 5) run it
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
| Episodic | SQLite FTS5 over past sessions | **the switch this repo flips** |
| Semantic | `memory/` files in the agent home | convention, see `agent/AGENTS.md` |
| Procedural | `SKILL.md` bundles, watched and reloaded | via `dsh-base` |
| Identity | `AGENTS.md` chain | via `dsh-base` |

The one-line version: `dsh-base` ships session search *off*
(`path: ':memory:'`, `openAt: never`). `profile/cordis.patch.yml` opens it on a
real file at startup. That single change is what makes "remember last week"
possible at all — and it is also the part still marked unverified above, because
the index is rebuilt lazily and should be checked against your own history.

## Layout

```
index.js                    the Slack adapter plugin (zero dependencies)
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
