/**
 * The transport seam.
 *
 * A platform supplies inbound events, outbound messages, history, attachments and
 * its own identity. Everything else — thread→session mapping, the turn loop, the
 * recall refresh, standing-context gating, watches, reminders, health — is core and
 * must not know which platform it is serving.
 *
 * This is a type rather than prose because the compiler is what enforces it across
 * transports. The Slack transport does not satisfy it yet: its functions still take
 * a token as the first argument, because the first extraction step was deliberately
 * mechanical. Reshaping it is the next step, and this file is the target.
 */

/**
 * A file the platform told us about. Deliberately neutral: how to fetch it is the
 * transport's business, and the fields every platform has are the ones here.
 */
export interface AttachmentRef {
  id?: string
  name?: string
  mimetype?: string
  size?: number
}

/** A conversation, in the transport's own terms. */
export interface Target {
  /** Where the message goes: a channel, chat, or guild id. */
  channel: string
  /**
   * The thread or reply chain. null on a platform without threads (a Telegram
   * chat), which makes the session per conversation rather than per thread.
   */
  threadTs: string | null
}

export interface InboundMessage {
  /** Stable identity for de-duplication across reconnects. */
  eventId: string
  target: Target
  /** The platform timestamp of this message. */
  ts: string
  text: string
  /** Who wrote it, in platform terms. */
  user: string
  /** True when the agent was addressed directly rather than observing chatter. */
  addressed: boolean
  files: AttachmentRef[]
  /** The platform's own payload, for a transport that needs to look deeper. */
  raw: unknown
}

/** A rendered message the transport has already sent, so it can be replaced. */
export interface PostedMessage {
  channel: string
  ts: string
}

export interface AttachmentManifest {
  /** Prompt-ready text describing what was fetched, or '' when there was nothing. */
  text: string
}

export interface TransportStatus {
  connected: boolean
  detail?: string
}

export interface Transport {
  /** Human-readable name and the platform's own id for this bot. */
  identity(): Promise<{ name: string; id: string; team?: string }>

  /** Start receiving. Resolves once the connection is up. */
  connect(handlers: {
    onMessage: (message: InboundMessage) => void
    onStatus: (status: TransportStatus) => void
  }): Promise<void>

  /** Send, or replace a message already sent (progress turning into the answer). */
  post(target: Target, text: string, options?: { replace?: string | null }): Promise<PostedMessage | null>

  /**
   * Messages newer than `sinceTs`, so the adapter can send a delta instead of the
   * whole thread every turn. Returns the newest timestamp it included.
   */
  fetchHistory(target: Target, options: { currentTs: string; sinceTs: string | null; limit: number; maxChars: number }): Promise<{ text: string; lastTs: string | null }>

  /** Download a message's files into the agent home and describe them. */
  fetchAttachments(message: InboundMessage, stamp: string): Promise<AttachmentManifest>

  /** Stop receiving and release the connection. */
  close(): Promise<void>
}
