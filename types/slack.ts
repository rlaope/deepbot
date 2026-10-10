/**
 * Slack Web API payloads, as far as this adapter uses them.
 *
 * These exist because the alternative is `unknown`. Without them every response
 * field access is an error, and with a blanket `any` every typo in a field name
 * compiles — the failure mode that already produced two runtime bugs in this
 * repository (`botUserId` and a dropped binding). Declaring the envelope means
 * `r.ok`, `r.error` and `r.messages` are checked, and a misspelled field is a
 * compile error instead of `undefined` at runtime.
 *
 * Only the fields actually read are declared. Slack sends much more; the index
 * signature keeps that honest without pretending to model it.
 */

export interface SlackResponse {
  ok: boolean
  error?: string
  [key: string]: unknown
}

export interface SlackFile {
  id?: string
  name?: string
  mimetype?: string
  size?: number
  url_private?: string
  url_private_download?: string
}

export interface SlackMessage {
  ts: string
  user?: string
  bot_id?: string
  text?: string
  subtype?: string
  files?: SlackFile[]
}

export interface SlackHistoryResponse extends SlackResponse {
  messages?: SlackMessage[]
  has_more?: boolean
}

export interface SlackMember {
  id: string
  name?: string
  real_name?: string
  profile?: { display_name?: string }
}

export interface SlackMembersResponse extends SlackResponse {
  members?: SlackMember[]
  response_metadata?: { next_cursor?: string }
}

export interface SlackUserInfoResponse extends SlackResponse {
  user?: SlackMember
}

export interface SlackPostResponse extends SlackResponse {
  ts?: string
  channel?: string
}

export interface SlackAuthTestResponse extends SlackResponse {
  user?: string
  user_id?: string
  team?: string
}

/** `apps.connections.open` hands back the Socket Mode websocket URL. */
export interface SlackConnectionResponse extends SlackResponse {
  url?: string
}

/** The Socket Mode envelope, whose payload is either an event or a disconnect. */
export interface SlackEnvelope {
  type?: string
  envelope_id?: string
  payload?: {
    event?: SlackEvent
    event_id?: string
    type?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface SlackEvent {
  type?: string
  channel?: string
  channel_type?: string
  thread_ts?: string
  ts?: string
  text?: string
  user?: string
  bot_id?: string
  subtype?: string
  files?: SlackFile[]
  [key: string]: unknown
}
