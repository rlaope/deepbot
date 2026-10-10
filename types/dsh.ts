/**
 * Hand-written declarations for the DeepSeek Harness services this plugin uses.
 *
 * The distribution ships no `.d.ts` files — the only type sources are JSDoc inside
 * `lib/types/*.js`, the package READMEs, and the runtime itself. Without these,
 * `ctx.get('agents')` is `any` and every call on it is unchecked: a wrong method name, a
 * wrong arity, or a wrong assumption about sync versus async all compile.
 *
 * They were written from the shipped documentation and from what this repository learned
 * by running against the real services (see docs/harness-api-notes.md and the notes beside
 * each call). Writing them from the documentation rather than from the call sites is the
 * point: the compiler then reports where this plugin disagrees with what the harness says,
 * which is how the transport interface found three mismatches, one of them a real bug.
 *
 * Scope: only what is used, declared loosely enough to be honest about the rest.
 */

/** Opaque to this plugin: passed back to the service that made it. */
export type Opaque = unknown

export interface SessionHeader {
  id: string
  cwd?: string
  [key: string]: unknown
}

/** One durable log event, read by sequence. */
export interface SessionEvent {
  type: string
  data?: Record<string, any>
}

export interface Session {
  header: SessionHeader
  seq: number
  eventAt(seq: number): SessionEvent | undefined
}

export interface Agent {
  session: Session
  /** Queue an ordinary next-turn prompt and wake the driver. */
  followup(message: Opaque): void
  /** Submit steering input to a running turn, when the composition supports it. */
  steer?(message: Opaque): void
  /** Inject model-facing context without making it a user message. */
  inject?(message: Opaque): void
  /**
   * Abort the in-flight turn. Clears the inbox by default; `keepInbox` keeps queued work.
   * Documented as `cancel()` on the Agent, and used here with a cause string.
   */
  cancel?(cause?: string | { kind: string }, options?: { keepInbox?: boolean }): void
  /** Resolves when the agent has nothing left to do. */
  whenIdle(): Promise<void>
  /** The agent's own Cordis context, when the composition exposes one. */
  ctx?: unknown
}

export interface AgentHandle {
  agent: Agent
  dispose?(): Promise<void> | void
}

export interface AgentsService {
  create(options: {
    sessionId?: string
    meta?: Record<string, unknown>
    agentOptions?: unknown
    setup?: (ctx: unknown) => Promise<void> | void
  }): Promise<AgentHandle>
  resume(options: {
    resumeSessionId: string
    agentOptions?: unknown
    setup?: (ctx: unknown) => Promise<void> | void
  }): Promise<AgentHandle>
}

export interface SessionsService {
  /** Commit buffered session events to the durable log. */
  flush(session: Session): Promise<void>
}

export interface AgentPresetsService {
  /** Throws `agent-preset/not-found` for an unknown id; no argument means the default. */
  resolve(id?: string): Promise<{ id: string; [key: string]: unknown }>
  /**
   * Retain a preset scope for a session's lifetime. The returned value is an
   * `AsyncDisposable` and has NO `dispose()` method — this plugin assumed one once.
   */
  acquireScope(id?: string): { key: unknown } & AsyncDisposable
  /** Mount the preset's plugins into an agent's context; this is what gives it tools. */
  mount(ctx: unknown, id?: string): Promise<void>
}

export interface PermissionPresetSpec {
  sandbox: string
  approval: string
  name?: string
  description?: string
}

export interface PermissionPresetsService {
  /** Synchronous, and throws for an unknown name. */
  resolve(name: string): PermissionPresetSpec
  /** Synchronous durable write of both knobs for one session. */
  set(session: Session, name: string): void
  readonly defaultPreset: string
}

export interface CredentialsService {
  /**
   * Resolves a reference to a secret. The result is a wrapper, not a bare string — the
   * first version of this declaration said `Promise<string>` and the compiler pointed at
   * `r?.value` in the caller, which was right and the declaration was wrong.
   */
  resolve(ref: string): Promise<{ value: string } | undefined>
}

export interface WorkspaceEntity {
  path?: string
  /** Compares the realpath of the session header's cwd against the workspace path. */
  attachSession(sessionId: string): Promise<void>
}

export interface WorkspaceRegistryService {
  create(path: string, title?: string): Promise<WorkspaceEntity | undefined>
}

export interface SessionProjectionsService {
  /** `values` holds the registered client-visible units, e.g. `tokenUsage`. */
  snapshot(session: Session, keys?: unknown): { asOfSeq?: number; values: Record<string, any> }
}

/** The attachment seam: images are admitted here before a prompt carries them. */
export interface AttachmentsService {
  saveImages(inputs: Array<{ data: Uint8Array; mediaType: string; name?: string }>): Promise<unknown[]>
}

/**
 * The model default for new sessions. Only the fields this plugin reads are declared —
 * it never sets a default, it reports what the deployment chose.
 */
export interface AgentDefaultModelService {
  /** Read the current default selection; detached, and the same one create and resume use. */
  currentSelection(): { provider?: string; model?: string; reasoningEffort?: string }
}

/** Query surface over the durable session log; used loosely for reporting. */
export interface SessionQueryService {
  [key: string]: any
}

/** The filesystem seam, used only to discover the session directory. */
export interface FileSystemService {
  [key: string]: any
}
