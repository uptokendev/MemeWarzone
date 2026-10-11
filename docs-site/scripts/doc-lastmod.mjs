import { execFileSync } from 'node:child_process'
import path from 'node:path'

let cached = null

// Last commit date (YYYY-MM-DD) of each content source. Netlify clones shallow, which would stamp
// every page with the same date, so on CI (or with DOCS_LASTMOD_UNSHALLOW=1) the history is fetched
// first. If the history stays shallow, no dates are returned rather than wrong ones.
export function sourceLastModified(contentDir, sources) {
  const run = (args, opts = {}) => execFileSync('git', args, { cwd: contentDir, encoding: 'utf8', ...opts }).trim()
  if (!cached) {
    cached = { shallow: true }
    try {
      let shallow = run(['rev-parse', '--is-shallow-repository']) === 'true'
      const allowFetch = process.env.NETLIFY === 'true' || process.env.CI === 'true' || process.env.DOCS_LASTMOD_UNSHALLOW === '1'
      if (shallow && allowFetch) {
        try {
          run(['fetch', '--unshallow', '--quiet'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 })
          shallow = run(['rev-parse', '--is-shallow-repository']) === 'true'
        } catch (error) {
          console.warn(`lastmod: could not fetch full git history (${error.message.split('\n')[0]})`)
        }
      }
      cached = { shallow }
    } catch {
      cached = { shallow: true }
    }
    if (cached.shallow) console.warn('lastmod: git history is shallow or missing, sitemap dates left out')
  }
  if (cached.shallow) return {}

  const dates = {}
  for (const source of sources) {
    try {
      const date = run(['log', '-1', '--format=%cs', '--', path.join(contentDir, source)])
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) dates[source] = date
    } catch {
      // untracked file: no date
    }
  }
  return dates
}
