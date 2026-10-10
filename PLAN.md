# deepbot — plan

Companion to [SPEC.md](SPEC.md). Milestones are ordered by dependency, not by
enthusiasm: nothing is built before the thing it stands on.

## Working rules

These exist because the first few days were a loop of *owner tests by hand → a
symptom appears → patch → owner tests again*. That loop is expensive for the
owner and hides design problems.

1. **Definition before code.** Each milestone below states its acceptance
   criteria first. A change that does not serve a criterion does not ship.
2. **The owner tests at milestone boundaries, not per fix.** Between boundaries
   the work is verified by tests.
3. **Automate the verification before doing the work.** M1 exists for exactly
   this reason and comes before the feature work it enables.
4. **A fix requires a regression test** when it fixes something that was observed
   failing (the reconnect loop has one; incidents get one).
5. **Say what is unverified.** The README and SPEC carry explicit "not verified"
   markers, and they are updated in the same commit that changes the claim.
6. **Production stays up.** The live instance is a company Slack bot. Changes are
   applied by restarting a supervised service with an auto-rollback, and every
   milestone must leave it working.

---

## M0 — Presence and instructions ✅ done

**Goal:** a supervised agent that answers in Slack and knows its own instructions.

- Socket Mode adapter, `channel:thread → sessionId`, chunked replies, dedupe.
- launchd service: auto-start, restart on exit, TCC-safe runtime path.
- Reconnect forever + watchdog; startup also retries. Regression-tested.
- Instruction injection from `AGENTS.md` / `CLAUDE.md` / `memory/*.md`.

**Evidence:** 608 ms round trip; correct recall of an 18-hour-old message across
three process restarts; 5/5 on `test/reconnect.test.mjs`; measured injection of
2469 chars where the system prompt previously carried none of it.

---

## M1 — A test harness for the agent path ✅ done

**Goal:** stop verifying memory by hand. Nothing in M2 is trustworthy until this
exists.

**Design:** reuse the path that is already verified. Extend the plugin's
diagnostic mode from a single prompt to a **scenario file**:

```json
{
  "stateDir": ".test/state",
  "turns": [
    { "session": "A", "say": "내가 좋아하는 음식은 국밥이야" },
    { "session": "B", "say": "내가 좋아하는 음식이 뭐였지?", "expectContains": "국밥" },
    { "session": "B", "say": "내가 싫어하는 음식이 뭐였지?", "expectNotContains": "국밥" }
  ]
}
```

It runs real turns against the real services in a **separate profile**
(`agent-test`) with its own state dir and its own FTS index path, so it can run
while the live gateway is up.

**Acceptance criteria:**
- `node test/run-scenario.mjs test/scenarios/recall.json` exits non-zero when an
  expectation fails, zero when it passes, and prints each turn's answer.
- The scenario above passes end-to-end **including the host-side index rebuild
  step**, which is currently missing from the loop.
- The same runner can restart the plugin mid-scenario to test continuity.
- CI-able locally: one command, no manual Slack poking.

**Risks:** the test profile must not collide with the live one (index ownership,
ports, session store bucket).

---

## M2 — Memory that actually works ✅ done

**Goal:** SPEC S1 and S2. This is the reason the project exists.

**Work, in order:**
1. **Write path.** The agent must *save* facts: `memory/*.md`, one dated fact per
   line. Instructions exist; nothing enforces or verifies them. Add a curator
   pass (a scheduled turn that reviews recent conversations and updates notes)
   rather than relying on the agent to remember to write.
2. **Read path.** Make recall demonstrably work: index freshness immediately
   after a turn (not up to 10 minutes later), and a scripted assertion that a
   fact from session A is found from session B.
3. **Recall quality.** Keyword search first, then evaluate. If keyword misses
   paraphrases in practice, add an embedding index — a decision to make with
   evidence, not now.
4. **Decide recall delivery** (SPEC §5): automatic injection vs agent-initiated.

**Acceptance criteria:**
- S1: a scripted test states a fact in one thread and recalls it in another.
- S2: a question about something never stated returns "not found", with no
  invention (adversarial scenario, run with the fact absent).
- Notes written to `memory/` are injected on the *next* turn without a restart.
- No secret ever reaches `memory/` or the log (S5 scan in the test suite).

---

## M3 — Never silently dead ✅ done

**Goal:** SPEC S3. The outage that motivated this went unnoticed for 57 minutes.

- A health probe that distinguishes *running* from *connected*, checking the
  plugin's own state rather than the process.
- On failure: restart the service; if it fails again, tell the owner in Slack or
  another channel.
- A forced-disconnect test (block the socket, assert recovery and alert).

**Acceptance criteria:** deliberate test that kills connectivity recovers within
one probe interval and produces one alert, not a storm of them.

**Evidence:** the probe was installed and driven against a deliberately injected
unhealthy state: `unhealthy — not connected (disconnected 1023s ago)` →
`restart requested` → `recovered after restart`. The alert path was verified by
sending one labelled test DM. A real 57-minute outage would now self-heal inside
the probe interval.

---

## M4 — Autonomy (scheduled + conditional alerts) ✅ done

**Goal:** SPEC G4 and the decided autonomy level: reminders and watches, with
unprompted posts only for a watch the owner asked for.

- Scheduled reminders delivered into the original conversation.
- **A watch primitive**: "tell me when X changes". Needs a condition, a check
  cadence, a change detector, and — critically — a **noise budget** so a flapping
  condition does not become spam.
- Long objectives that survive restarts.
- Every autonomous action is logged, and the owner can see what it did and why.

**Acceptance criteria:** a watch fires exactly once when its condition changes and
stays silent when it does not; a noisy condition is rate-limited and says so.

**Depends on:** M2 (an agent that acts but cannot remember why is a nuisance) and
M3 (a watch that cannot tell you it went blind is worse than no watch).

**Reminder path, verified without a human:** `test/scenarios/reminder.json` 4/4 —
the agent creates a reminder, it fires on the wall clock, and the schedule wakes
the agent on its own. The adapter does NOT drive that turn (the schedule owns the
session while it delivers, which the adapter now retries around rather than
failing), so the assertion is made against the session log through
`sessionQuery.observeSession`. Delivery of that turn's message into Slack is
covered by `test/delivery.test.mjs`.

**Evidence:** `test/watch.test.mjs` 16/16 — the first observation is a baseline and
does not alert; a change alerts exactly once; no change stays silent; a change
inside the rate-limit window is suppressed and the next alert reports how many
were suppressed; a broken config exits 2 while a missing one is simply nothing to
do; and a watch authored by the agent in `<home>/watches/` is loaded and reports
to its own channel. Reminder delivery is covered by `test/delivery.test.mjs` 8/8:
an assistant message on a mapped session that the adapter is not driving goes to
that thread.

---

### Success criteria that are now tested

| SPEC | Test |
|---|---|
| S1 fact recalled across conversations, with its date | `test/scenarios/recall.json` 5/5 |
| S2 a never-stated fact is not invented | same scenario, final step |
| S3 never silently disconnected | health probe: injected unhealthy state → restart → recovered |
| S4 a restart preserves thread→session continuity | `test/scenarios/restart-{1,2}.json` — phase 2 is a NEW process resuming phase 1's session id, and it recalls phase 1's message |
| S5 no secret in memory or logs | `test/secrets.test.mjs` — pattern scan over the agent home and state dir, and over the repo in CI |
| S6 installable by someone else | profile built from `profile/` alone + one install command → recall scenario 5/5 |

## M5 — Distribution (decided: it is a real project) ✅ done

**Goal:** SPEC S6 — someone else can install it from the repository.

**Verified:** a profile built from this repository's `profile/` directory alone,
plus one `dsh plugin add <repo>` and a model route, passes the recall scenario
5/5 on a fresh agent home. CI runs the harness-free tests on every push.

- Fresh-clone install from the README, verified on a clean machine or user.
- Config entirely in the profile, no machine-specific paths in the repo.
- Version pinning against the harness, plus a documented upgrade procedure for
  the non-public APIs the plugin relies on.

---

## Documents (added after M5, driven by the product need)

The product ships documents to users, so the bot must produce files, and it could
not. `dsh-skill-office` is a plain package mounted by no shipped bundle, and the
profile inserted nothing: the agent could describe a document and not create one.

Fixed: the profile inserts `dsh-skill-office` (which registers office-docx,
office-pptx and office-xlsx and appends the absolute LibreOffice Kit paths) and
`dsh-tool-workspace-dependencies` (which locates the bundled Python carrying
python-docx/pptx/openpyxl). The second row is required for the first to be usable.

Verified by `test/scenarios/document.json` 5/5, asserting on the artifacts: ZIP
magic plus an inner OOXML path. A model describing a document it never wrote reads
exactly like one that did.

## M6 — Beyond Slack: one core, several transports

The earlier version of this section said a second platform would be "a new adapter
of the same shape, not a refactor, because the adapter is already isolated". That
was wrong. The adapter is ~700 lines of Slack inside `index.js`: thread→session
mapping, delta history, attachment download, progress replacement and mention
matching are all written against Slack's payloads. A second platform today means a
second copy of that logic.

**Transport interface** — what a platform supplies, and nothing more:

| Method | Purpose |
|---|---|
| `connect({onMessage, onAction, onStatus})` | inbound events; `onStatus` reports connection health |
| `post(target, text, {replace})` | send, or replace a message already sent (progress → answer) |
| `fetchHistory(target, sinceTs)` | messages after a point, for a delta |
| `fetchAttachments(message, stamp)` | download into the agent home, return a manifest |
| `identity()` | bot name and team, for the startup line and mention matching |

The core keeps what is already proven: thread→session mapping, the turn loop, the
recall refresh, digest-gated standing context, watches, reminders, health.

### M6.1 Extract the seam with no behaviour change ✅ done
Slack becomes `transports/slack.ts` — the Web API layer, then the Socket Mode connection,
event parsing and rendering. The core no longer knows what a Slack event looks like.
**Acceptance:** every existing test and scenario passes unchanged, and the live
gateway restarts with the same log lines.

### M6.2 A fake transport, so the core is testable without a platform ✅ done
`test/fake-transport.mjs` drives the core in-process.
**Acceptance:** tests cover mapping, delta history, progress replacement, attachment
manifests and failure paths with no network and no account. This is the real reason
to do the extraction; the second platform is the excuse.

### M6.3 Telegram ✅ implemented (live round trip pending a bot token)
Long polling — no websocket, no app-token dance. The cheapest second transport, and
the one that proves the interface. Telegram has no threads, so a reply chain or a
per-chat session key stands in.
**Acceptance:** a live round trip — message, answer, attachment, and a reminder
delivered back into the same chat.

### M6.4 Discord
Gateway websocket with the message-content intent, native threads, attachments via
CDN, buttons for approvals.
**Acceptance:** the same round trip, plus a button action answered.

### M6.5 Interactive approvals
The policy is `never` today, so nothing hangs — but a user also cannot approve an
escalation. The approval seam takes an answerer and each transport supplies one
(Slack block actions, Discord buttons, Telegram callback queries).
**Acceptance:** an escalation request appears in the chat; approving runs the
command, denying is reported to the model as a rejection rather than a hang.

---

## M7 — What is still missing to be a full agent

Ordered by what blocks real use. Each row is a milestone, not a wish.

| # | Gap | Why it matters | Approach | Acceptance |
|---|---|---|---|---|
| 1 | **Read isolation** | Two instances under one OS user can read each other's data; a B2B blocker | A sandbox *provider* plugin (its own profile and enforcement), or one OS user per instance | The isolation scenario passes and bash still works. Do not repeat the Seatbelt wrap: macOS refuses nested `sandbox-exec` |
| 2 | **Vision** | Users send screenshots; the file arrives and the model cannot see it | Verify the model route accepts image parts, then send images as image content instead of a path | A screenshot question is answered from the image, not the filename |
| 3 | **Interrupt** | A long turn cannot be stopped | `agent.cancel()` wired to a chat command and to the approval seam | A turn stops mid-flight and the chat says so |
| 4 | **Real progress** | One static placeholder; the user cannot tell what is happening | Stream step boundaries and tool names into the placeholder, throttled | A long turn shows what it is doing, updated in place |
| 5 | **Browser / computer use** | Many asks are "open this and check"; Hermes has it, DSH ships nothing | A tool plugin over a local headless browser (CDP), sandboxed to the agent home | A page is opened, read, and quoted with a source link |
| 6 | **Cost per user** | Spend is invisible; the projection exists and is unused | Read `tokenUsage` per session, aggregate per channel and user, add a report command | `@bot usage` answers with tokens, cache ratio, and turns |
| 7 | **Semantic memory** | Keyword grep misses paraphrases | An embedding index over `memory/` and the recall log, grep as fallback | A paraphrased question finds the original fact |
| 8 | **Note hygiene** | Notes duplicate until the budget silently truncates them | Dedupe and expiry pass, plus the existing budget check | The persona check stays clean across a week of use |
| 9 | **Multi-tenant memory** | One instance = one memory; B2B needs per-org separation | Session and memory scoping per channel or workspace entity | Two channels cannot see each other's notes |
| 10 | **Ops** | Log rotation, backup/restore, crash-loop detection, a Linux/systemd install | Service-layer additions | A restore reproduces a home; the installer works on Linux |
| 11 | **Prompt-injection defence** | Fetched material is framed as content and nothing enforces it | Keep the framing, flag instruction-like content in fetched material | A channel message saying "ignore your instructions" does not change behaviour |
| 12 | **Releases** | No version, no changelog, no artifact | Semver, CHANGELOG, a tag per milestone | A tagged release installs from a clean clone |

### Non-goals

Video and audio, per-user billing, a web UI of our own, enterprise workspace
governance. Not planned.

### An unverified reference point

"OpenClaw-level" is not something this repository can check. The comparison behind
this table uses what was measured on this machine — the Hermes profile's plugin
inventory (browser, computer_use, image and video generation, google_meet, kanban,
observability, memory, cron, delegation) — plus the gaps hit while building this. If
OpenClaw has specific must-haves, name them and the table gets corrected.

---

## Two instances, one codebase

Decided in SPEC §4: the company bot and the personal agent are separate
instances.

| | company instance | personal instance |
|---|---|---|
| Slack app | existing `@hermes` | its own app, its own identity |
| profile | `agent` | `agent-personal` |
| agent home | `~/dsh-agent` | separate |
| memory + recall index | its own | its own |
| service label | `ai.deepbot.gateway` | its own |

This repository ships the code for both. A shared `agent-test` profile with its
own state directory and index path exists for the test harness, so tests never
touch either live instance.

## Sequencing summary

```
M0 presence ✅ ──▶ M1 test harness ✅ ──▶ M2 memory ✅ ──▶ M4 autonomy ✅
                                          │
M3 health ✅ (independent, small) ─────────┘
M5 distribution 🚧 in progress (CI ✅, docs ✅, fresh-install check pending)
```

## What we are deliberately not doing now

- Multi-platform, before memory works.
- Browser automation or vision.
- Semantic search, before keyword recall is measured.
- Attaching a workspace to sessions (the proper fix for instruction injection) —
  it removes the workaround, but it needs API work whose payoff is currently
  cosmetic. Revisit when touching session creation for another reason.
