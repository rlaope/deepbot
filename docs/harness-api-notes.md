# Harness API notes

What this plugin relies on, and how confident we are in each piece. Everything
here was established by reading the shipped `0.2.0-rc.2` distribution and by
running it, not from published documentation — the distribution ships no type
declarations, so contracts were recovered from the code and confirmed by
execution.

Legend: **verified** = exercised end to end here. **code-read** = established
from the shipped implementation, not exercised by this project. **uncertain** =
no way to confirm from the distribution.

---

## 1. Plugin bundle manifest

`package.json` fields the loader actually reads:

| Field | Meaning | Notes |
|---|---|---|
| `dsh.bundle.patch` | path (or ordered list) to this bundle's patch file | Being present is what makes the package a *bundle*. Without it the loader skips the package with `declares no dsh.bundle in its package.json`. |
| `dsh.client` | browser-half declaration | Not used here — this plugin has no UI half. If you do declare it, `exports` must expose `"./client"`. |
| `dsh.profile.bundles` | ordered bundle list for a profile | Used by `profile/package.json`. |

- `dsh.manifestVersion` is documented but **no reader validates it** — a scan of
  the distribution found zero packages declaring it. This repo omits it.
- Compatibility preflight only inspects `@deepseek-ai/dsh*` entries in
  `peerDependencies`. Do **not** declare them: a mismatch disables the row (or
  skips the whole bundle), and the shipped packages are resolved by the host
  installation anyway. This repo declares none.
- **code-read**: `exports` must expose `"."`; exposing `"./package.json"` lets the
  host read plugin metadata for display.

## 2. Patch grammar (`cordis.patch.yml`)

- A patch file is a **top-level array** of rows. A file with only comments fails
  to boot; use `[]` for "no patch".
- `- insert:` appends rows to the root (or into a group row's config when the
  group row is addressed by `id`). Rows inserted by an earlier layer can be
  overridden by an `id`-targeted row in a later layer.
- `- id: <row>` with fields patches that row. **`config` is replaced wholesale —
  there is no deep merge.** To change one field you must restate the whole config.
- A truthy `name` on an id-targeted row is an *assertion*, not a rename: if it
  does not match the existing row, the patch is skipped.
- `disabled:` accepts a boolean, `null`, or an expression. Expressions are
  re-evaluated on every activation decision.
- Layer order: bundle patches (in `dsh.profile.bundles` order) → the profile's own
  patch → `$DSH_HOME/cordis.patch.yml` → any `--patch` overlay.
- **code-read**: row-level `inject: [...]` merges into that row's fiber inject map
  and therefore controls activation order. This repo uses it so the adapter waits
  for `agents` / `sessions` / `sessionQuery`.

## 3. Driving a session in process — **verified**

The sequence below is what the shipped one-shot runner and the in-process
subagent driver both do, and what this plugin does (turn 1 and turn 2 confirmed
against a live gateway):

```
selection   = ctx.get('agentDefaultModel').currentSelection()
agentOptions= { provider: selection.provider, model: selection.model }

handle = existingSessionId
  ? await ctx.get('agents').resume({ resumeSessionId, agentOptions, setup })
  : await ctx.get('agents').create({ sessionId, meta: { cwd }, agentOptions, setup })

await handle.agent.whenIdle()
const firstSeq = handle.agent.session.seq
handle.agent.followup(userMessage)          // admission commit point
await handle.agent.whenIdle()
await ctx.get('sessions').flush(handle.agent.session)
const text = readLastAssistantText(handle.agent.session, firstSeq)
await handle.dispose()
```

Details that matter:

- **`setup` must pin the model selection.** Both shipped drivers call
  `installModelSelection(agentCtx, { current: selection, assembled: undefined })`
  inside `setup`. This plugin cannot import that helper (see §5) and passes only
  `agentOptions`. It works in the configuration tested here, but if you hit a
  "no model selected" class of failure, this is the first suspect.
- **A user message needs a stable `id`.** The shipped constructor is
  `deepFreeze(structuredClone({ ...input, id: brandString(randomUUID()) }))`, plus
  `role: 'user'`. Omit the `id` and the log fails validation on the next read
  with `session event at seq N lacks an identified message` — a failure that only
  appears on the *second* turn.
- **Resume is bound to the recorded working directory**, and the session must be
  adoptable (not a subagent or forked session, and not already live in the
  process). Resolve the cwd once and keep it stable.
- **Final text is not a return value.** Read it from the session log over the
  interval you own; the assistant text is the last non-empty assistant message in
  that interval, and the outcome is the `turn/end` reason
  (`{ kind: 'completed' | 'error' | … }`).
- **uncertain**: whether `create` / `resume` / `followup` / `whenIdle` are a
  *public* contract. Three first-party packages rely on them, but there are no
  type declarations in the distribution to confirm intent.

## 4. Services and credentials

- Services are resolved by name: `ctx.get('<name>')`. Names used here:
  `agents`, `sessions`, `agentDefaultModel`, `credentials`, `sessionQuery`,
  `sessionPersistence`, `fs`.
- `await ctx.credentials.resolve(ref) → { value, source } | undefined`. An empty
  value means "absent" everywhere. Layer precedence, highest first:
  `process.env` → `$DSH_HOME/.credentials.yaml` → `<cwd>/.env` → `$DSH_HOME/.env`.
  `$DSH_HOME` defaults to `~/.dsh`. A ref must match `[A-Za-z_][A-Za-z0-9_]*`.
- **verified**: the `.env` layer is what this repo documents, and `resolve` works
  for a plain string ref.

## 5. Why this plugin imports nothing

First-party plugins import helpers from `@deepseek-ai/dsh-*`. Those packages live
inside the application archive, and a *profile* has no `node_modules` of its own,
so a third-party bundle that imports the same specifiers has no guaranteed
resolution path. Everything this plugin needs is therefore inlined:

| Shipped helper | Inlined replacement |
|---|---|
| `createUserMessage(input)` | `deepFreeze(structuredClone({ ...input, role: 'user', id: randomUUID() }))` |
| `brandString(s)` | a plain string (the runtime brand is a tag) |
| `SessionSeq(n)` | a plain number |
| the runner's summary fold | the same walk over `session.eventAt(seq)` |

`installModelSelection` is the one helper that cannot be inlined; see §3.

If you are writing a plugin that *does* live inside a host installation, importing
the helpers directly is cleaner and strictly better.

## 6. Lifecycle

`ctx.effect(() => { start(); return () => stop() }, 'label')` ties a resource to
the plugin's lifetime: the returned function runs on unload. This plugin starts
the Socket Mode connection there and closes the socket on disposal.
