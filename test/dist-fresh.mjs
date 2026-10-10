/**
 * Refuse to test a stale build.
 *
 * The tests load `dist/`, and `tsc --noEmit` after an edit leaves it behind. That
 * mistake has cost two debugging cycles in this repository — each time the symptom was
 * a feature that appeared not to work while the source was correct. Importing this
 * first turns it into one clear sentence.
 */
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dist = fileURLToPath(new URL('../dist/index.js', import.meta.url))
const source = fileURLToPath(new URL('../index.ts', import.meta.url))
try {
  if (statSync(dist).mtimeMs + 1 < statSync(source).mtimeMs) {
    console.error('\n  dist/index.js is older than index.ts — run: pnpm run build\n')
    process.exit(1)
  }
} catch {
  console.error('\n  dist/index.js is missing — run: pnpm run build\n')
  process.exit(1)
}
