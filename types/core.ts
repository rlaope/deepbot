/**
 * Shapes the core passes around.
 *
 * These were previously inferred, which meant a caller reading `.sessionId` off a
 * turn result compiled as long as nothing else forced a check — and the two bugs
 * TypeScript found on the first run were exactly this class: a function returning
 * `string` on one path and an object on another, and a property that was written
 * but never declared.
 */

/** Why a turn ended. `kind` is 'completed' for a normal finish. */
export interface TurnReason {
  kind: string
  [key: string]: unknown
}

/** What one turn produced, read back out of the session log. */
export interface TurnSummary {
  text: string
  reason: TurnReason | null
  toolsUsed: string[]
}

/** The same, plus the session it happened in. */
export interface TurnOutcome extends TurnSummary {
  sessionId: string
}

/** Where a message came from: the transport's idea of a conversation. */
export interface Origin {
  channel: string
  threadTs: string
}
