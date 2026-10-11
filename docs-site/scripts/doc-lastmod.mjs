import { execFileSync } from 'node:child_process'
import path from 'node:path'

// Last commit date (YYYY-MM-DD) of each content source. Empty when git history is shallow or
// missing, because a shallow clone would stamp every page with the same date.
export function sourceLastModified(contentDir, sources) {
  const run = (args) => execFileSync('git', args, { cwd: contentDir, encoding: 'utf8' }).trim()
  try {
    if (run(['rev-parse', '--is-shallow-repository']) === 'true') return {}
  } catch {
    return {}
  }
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
