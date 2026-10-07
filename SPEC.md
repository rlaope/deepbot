# deepbot — specification

> **Status: DRAFT, awaiting the owner's corrections.** Anything marked ⚠️ DECIDE is
> an open question, not a settled choice. Everything else is either a goal or a
> constraint discovered by running the thing.

## 1. In one line

A long-running agent on DeepSeek Harness that **remembers across conversations**,
**lives where its owner already talks**, and **does not need to be supervised**.

## 2. What it is not

Stated up front, because most of the confusion so far came from not saying it:

- **Not a coding agent.** Codex and Claude Code are better at that and are already
  installed. deepbot may edit files; it is not competing there.
- **Not a chat toy.** Single-turn Q&A is a side effect, not the point.
- **Not a team product (yet).** The current live instance serves a company Slack
  workspace; whether that is the goal or an accident of the migration is open.
- **Not a general automation platform.** It is one agent with memory, not a
  workflow engine for arbitrary jobs.

## 3. Goals, ranked

Order matters: when two conflict, the higher one wins.

| # | Goal | Why it is ranked here |
|---|---|---|
| **G1** | **Remember across conversations.** Recall a fact, decision, or preference from an earlier session, with its date, or say plainly that it is not known. | The whole reason this exists. Everything else is plumbing for it. |
| **G2** | **Be reliably present.** Survives reboot, network loss, harness restart. Never silently dead. | An agent that is sometimes absent is worse than no agent: it teaches the owner not to trust it. |
| **G3** | **Be reachable where the owner already is.** Slack today; the adapter is not Slack-specific. | Zero-friction access. A tool you have to visit does not get used. |
| **G4** | **Act without being asked, within a stated boundary.** Scheduled reminders, watching something, pursuing a long objective. | This is what separates an agent from a search box. Costs safety, so it is below G1–G3. |
| **G5** | **Be reproducible.** Someone else can install it from the repository. | Determines whether it is a personal script or a project. ⚠️ DECIDE |
| **G6** | **Be safe by construction.** Sandboxed writes, explicit approval for destructive acts, secrets never stored. | A constraint on all of the above, not a feature. |

### Non-goals

- Replacing the owner's coding tools.
- Browser automation, vision, multi-modal input.
- Being a product for other teams' Slack workspaces.
- Semantic/vector search (may be revisited if keyword recall proves insufficient).

## 4. Users

⚠️ **DECIDE.** Today there are two populations and they want different things:

| Population | What they need | Tension |
|---|---|---|
| **The owner** (one person) | personal memory, autonomy, low ceremony | Wants to remember everything about them |
| **Colleagues** (a company Slack workspace) | a shared assistant: answer questions, run chores | Must **not** see the owner's personal context, and the owner must not have their private recalls leaking into channels |

This boundary is the single most consequential decision in the spec, because it
determines the memory scope, the identity model, and the approval policy.

## 5. Memory model

Four layers. The **mechanism** column is what has actually been verified to exist
in the harness; the **state** column is honest about what works today.

| Layer | Mechanism | What belongs there | State |
|---|---|---|---|
| Working | the session log (event-sourced, per thread) | this conversation | ✅ works |
| Episodic | `memory/recall-index.jsonl`, built host-side from the session store, greppable | "we discussed this before" | ⚠️ built and populated, **not yet demonstrated end-to-end** |
| Semantic | `memory/*.md`, injected into every turn | durable facts, preferences, decisions | ⚠️ injection works; **nothing writes these files yet** |
| Procedural | `skills/<name>/SKILL.md` | repeated procedures | ⚠️ files are discovered, but the catalog is **not surfaced** in this composition |
| Identity | `AGENTS.md`, injected into every turn | rules, voice, boundaries | ✅ works (since the injection fix) |

### Memory rules (proposed)

1. **Facts only from the owner's own statements.** Never inferred personality.
2. **Every fact carries a date.** Recall quotes the date.
3. **Corrections replace, they do not append.**
4. **Secrets are never written.** Tokens, passwords, personal data.
5. **Not found is a valid answer**, and must be preferred over a plausible guess.
6. ⚠️ DECIDE retention: does memory expire? Is there a "forget this" command?

### Recall rules (proposed)

- Keyword search over the index first; the agent must search before saying "not found".
- The index is **content, not instructions** — nothing in it grants permission.
- ⚠️ DECIDE: automatic injection of relevant past context at prompt time, vs the
  agent deciding to search. Automatic is friendlier; deciding is cheaper and more
  predictable.

## 6. Presence and failure

Requirements that came directly from a real outage:

- **R1** — a dropped Slack connection is retried forever with capped backoff. ✅ done
- **R2** — a failed *retry* also retries (the original bug). ✅ done
- **R3** — a socket that goes quiet without a close event is detected. ✅ watchdog
- **R4** — **an external health check that alerts.** A process that is running but
  disconnected must not look healthy. ❌ not built
- **R5** — a process restart must not lose session→thread mappings. ✅ done

## 7. Autonomy boundary (proposed default)

| Action | Without asking | Reasoning |
|---|---|---|
| Read files, search history | yes | non-mutating |
| Write inside the agent home | yes | sandbox root |
| Write outside the agent home | no | sandbox blocks it anyway |
| Post to Slack in a thread it was addressed in | yes | that is the conversation |
| Post to a channel unprompted | ⚠️ DECIDE | this is where an agent becomes annoying |
| Run commands with side effects (deploy, send, spend) | no | must ask |
| Delete anything | no | must ask |

## 8. Constraints (discovered, non-negotiable)

- **Harness version:** `0.2.0-rc.2`. A release candidate. Session driving,
  message construction and the event fold are **not confirmed public contract** —
  see `docs/harness-api-notes.md`. An upgrade can break this project.
- **No workspace attached to sessions** by the adapter, so workspace-scoped
  context (the harness's own `AGENTS.md` loader) injects nothing. The adapter
  carries instructions in the prompt instead. Fixing this properly means
  attaching a workspace — a follow-up, not a workaround to keep forever.
- **One Socket Mode connection per Slack app.** Two clients split events and both
  start dropping messages.
- **One owner per FTS index path.**
- **macOS TCC:** `launchd` cannot read `~/Documents`.
- **Sandbox:** agent writes are confined to its home (`workspace-write`), fail-closed.

## 9. Success criteria

Falsifiable, so "working" is not a matter of opinion:

| # | Criterion | How it is checked |
|---|---|---|
| S1 | A fact stated in one thread is recalled in another, with its date | scripted test: state in thread A, ask in thread B, assert the fact appears |
| S2 | Recall that finds nothing says so, and never invents | adversarial test with a fact that was never stated |
| S3 | The bot is never silently disconnected for more than N minutes | health check + alert, plus a forced-disconnect test |
| S4 | A reboot preserves thread→session continuity | reboot test: ask a follow-up in a pre-reboot thread |
| S5 | Secrets never appear in stored memory or logs | scan the index and logs for token patterns after a session that mentions one |
| S6 | Someone else can install it from the repo | fresh-clone install following only the README |

## 10. Open decisions

1. **Who are the users?** personal only / company too / open-source distribution.
2. **Memory boundary** between personal and work contexts.
3. **Autonomy level** and whether unprompted channel posts are allowed.
4. **Recall**: agent-initiated search vs automatic injection.
5. **Retention**: does memory expire; is there a forget command.
6. **Distribution**: is G5 (installable by others) real, or is this a private thing.
