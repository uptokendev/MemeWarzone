const EVM = /^0x[a-fA-F0-9]{40}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const LONG_ID = /^\d{10,}$/

function looksLikeSolana(segment: string): boolean {
  if (!SOLANA.test(segment)) return false
  return /[0-9]/.test(segment) && /[A-Z]/.test(segment)
}

export function templatePath(pathname: string): string {
  const raw = String(pathname || '/')
  const path = raw.split('?')[0] || '/'
  const parts = path.split('/').map((segment) => {
    if (!segment) return segment
    let decoded = segment
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      decoded = segment
    }
    if (EVM.test(decoded) || looksLikeSolana(decoded)) return ':address'
    if (UUID.test(decoded) || LONG_ID.test(decoded)) return ':id'
    return decoded
  })
  const joined = parts.join('/')
  return joined.startsWith('/') ? joined : `/${joined}`
}

export function parseUtm(search: string): Record<string, string> | undefined {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const utm: Record<string, string> = {}
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
    const value = params.get(key)?.trim()
    if (value) utm[key.replace('utm_', '')] = value
  }
  return Object.keys(utm).length ? utm : undefined
}
