/**
 * A transport that talks to nothing.
 *
 * This is the point of the transport seam: the core — thread→session mapping, the
 * channel allowlist, de-duplication, the history delta, progress replacement, the
 * failure paths — can be exercised in CI with no platform account and no network.
 * The Slack transport is exercised the same way by the reconnect and delivery
 * suites, which mock fetch and the websocket.
 *
 * Every interaction is recorded so a test can assert on what the core asked for
 * rather than on what a platform happened to reply.
 */
export function createFakeTransport(options = {}) {
  const posted = []
  const historyCalls = []
  const attachmentCalls = []
  let onMessage = null
  let closed = 0
  let socket = true

  return {
    // ── recorded interactions ───────────────────────────────────────────────
    posted,
    historyCalls,
    attachmentCalls,
    get closed() { return closed },
    /** Push an inbound message as if the platform had delivered it. */
    deliver(message) {
      if (onMessage === null) throw new Error('fake transport is not connected')
      onMessage(message)
    },
    /** A platform-shaped message, with the boring fields filled in. */
    message(overrides = {}) {
      return {
        eventId: `evt-${posted.length}-${historyCalls.length}-${Math.random().toString(36).slice(2, 8)}`,
        target: { channel: 'C_ALLOWED', threadTs: 't1' },
        ts: '1000.1',
        text: 'hello',
        user: 'U_USER',
        addressed: true,
        files: [],
        raw: {},
        ...overrides,
      }
    },

    // ── the Transport interface ─────────────────────────────────────────────
    async identity() { return { name: 'fakebot', id: 'U_FAKE', team: 'T_FAKE' } },
    async connect(handlers) { onMessage = handlers.onMessage },
    async post(target, text, opts = {}) {
      posted.push({ target, text, replace: opts.replace ?? null })
      return { channel: target.channel, ts: `ts-${posted.length}` }
    },
    async fetchHistory(target, opts) {
      historyCalls.push({ target, ...opts })
      return options.history ?? { text: '', lastTs: null }
    },
    async fetchAttachments(message, stamp) {
      attachmentCalls.push({ message, stamp })
      return options.attachments ?? { text: '' }
    },
    async close() { closed++; socket = false; return true },
    hasSocket() { return socket },
    async authenticate() {},
    ready() { return true },
  }
}
