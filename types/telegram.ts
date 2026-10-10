/**
 * Telegram Bot API payloads, as far as this transport uses them.
 *
 * The transport file keeps its own interfaces for brevity; this module exists so the
 * exported shapes have a home that is not a comment inside an implementation.
 */
export interface TelegramApiResponse<T> {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
}
