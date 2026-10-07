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

## M6 — Beyond Slack

Only if a second platform is actually wanted. Discord and Telegram are new
adapters of the same shape, not a refactor — the adapter is already isolated.

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
