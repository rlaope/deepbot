/**
 * Token shapes, in one place so the repository scan and the persona check agree.
 *
 * A persona file is injected into every prompt, so a secret that lands there is a
 * secret in every request and every session log.
 */
export const PATTERNS = [
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/xapp-[A-Za-z0-9-]{10,}/, 'Slack app token'],
  [/sk-[A-Za-z0-9]{20,}/, 'API key'],
  [/gh[pous]_[A-Za-z0-9]{20,}/, 'GitHub token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, 'JWT'],
]

// Placeholders are not leaks. Documentation legitimately contains things like
// `xoxb-REPLACE_ME`, and flagging that makes every doc edit look like an incident.
const PLACEHOLDER = /(your|replace|example|sample|placeholder|redacted|xxx|todo|\.\.\.)/i
const NEGATIVE = /xox[baprs]-(REPLACE|redact)|<your-|…/

export function isPlaceholder(match) {
  return PLACEHOLDER.test(match) || NEGATIVE.test(match)
}

/** Every non-placeholder match in `text`, as `{ label, sample }`. */
export function findSecrets(text) {
  const hits = []
  for (const [pattern, label] of PATTERNS) {
    const match = text.match(pattern)
    if (match && !isPlaceholder(match[0])) hits.push({ label, sample: `${match[0].slice(0, 12)}…` })
  }
  return hits
}
