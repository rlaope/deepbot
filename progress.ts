/**
 * The in-place progress message.
 *
 * A turn can run for minutes, and a single static "working on it" tells the user
 * nothing. What they want to know is that it is still moving. This tracks one
 * message per conversation, updates it in place as the agent works, and hands the
 * message id back at the end so the answer can replace it rather than arrive as a
 * second message.
 *
 * It is a separate module because it is the part with rules worth testing — create
 * once, throttle the rest, never leave a message behind — and none of those rules
 * need an agent, a platform, or a turn to exercise.
 */

export interface ProgressTarget {
  channel: string
  threadTs: string | null
}

export interface ProgressPoster {
  /** Sends, or replaces `replace` when given. Resolves to the message id, or null. */
  post(target: ProgressTarget, text: string, options?: { replace?: string | null }): Promise<{ ts: string } | null>
}

export interface ProgressOptions {
  post: ProgressPoster['post']
  /** Everything but the first update waits at least this long between edits. */
  throttleMs: number
  /** Prefix for the message, e.g. "⏳ 작업 중입니다…". */
  label: string
  now?: () => number
  log?: (...parts: unknown[]) => void
}

interface Entry {
  target: ProgressTarget
  ts: string | null
  lastUpdate: number
  tools: string[]
  startedAt: number
}

export function createProgressTracker(options: ProgressOptions) {
  const entries = new Map<string, Entry>()
  const now = options.now ?? (() => Date.now())
  const log = options.log ?? (() => {})

  /** "2개 도구 · 34s" — enough to see it is moving, short enough to read. */
  function summary(entry: Entry): string {
    const parts: string[] = []
    if (entry.tools.length > 0) {
      const last = entry.tools[entry.tools.length - 1]
      parts.push(`${entry.tools.length}개 도구 (${last})`)
    }
    const seconds = Math.round((now() - entry.startedAt) / 1000)
    if (seconds >= 5) parts.push(`${seconds}s`)
    return parts.length === 0 ? options.label : `${options.label} — ${parts.join(' · ')}`
  }

  async function render(key: string, entry: Entry): Promise<void> {
    entry.lastUpdate = now()
    const text = summary(entry)
    if (entry.ts === null) {
      const posted = await options.post(entry.target, text)
      entry.ts = posted?.ts ?? null
      return
    }
    await options.post(entry.target, text, { replace: entry.ts })
  }

  return {
    /**
     * Record activity. Creates the message the first time, edits it afterwards,
     * and skips edits that would land inside the throttle window.
     */
    async note(key: string, target: ProgressTarget, toolName?: string): Promise<void> {
      let entry = entries.get(key)
      if (entry === undefined) {
        entry = { target, ts: null, lastUpdate: 0, tools: [], startedAt: now() }
        entries.set(key, entry)
      }
      if (toolName !== undefined) entry.tools.push(toolName)
      const first = entry.ts === null
      if (!first && now() - entry.lastUpdate < options.throttleMs) return
      await render(key, entry)
    },

    /** Create or edit now, ignoring the throttle: used when a turn turns slow. */
    async force(key: string, target: ProgressTarget): Promise<void> {
      let entry = entries.get(key)
      if (entry === undefined) {
        entry = { target, ts: null, lastUpdate: 0, tools: [], startedAt: now() }
        entries.set(key, entry)
      }
      await render(key, entry)
    },

    /** The message to replace with the answer, if one was posted. Clears the entry. */
    take(key: string): { ts: string | null; target: ProgressTarget } | null {
      const entry = entries.get(key)
      if (entry === undefined) return null
      entries.delete(key)
      return { ts: entry.ts, target: entry.target }
    },

    /** Whether a message already exists for this conversation. */
    has(key: string): boolean { return entries.get(key)?.ts !== null && entries.get(key) !== undefined },

    /** Drop tracking without posting anything, for a turn that produced no message. */
    forget(key: string): void { entries.delete(key) },

    /** How many conversations are being tracked, for tests and diagnostics. */
    size(): number { return entries.size },
  }
}
