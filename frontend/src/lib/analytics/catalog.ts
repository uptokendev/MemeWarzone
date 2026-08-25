export const ANALYTICS_APPS = ['public', 'admin'] as const
export type AnalyticsApp = (typeof ANALYTICS_APPS)[number]

export const RESERVED_EVENT_NAMES = [
  '$pageview',
  '$pageleave',
  '$identify',
  '$heartbeat',
  '$web_vital',
  '$function',
] as const

export const PUBLIC_EVENT_NAMES = [
  'wallet_connect_started',
  'wallet_connect_succeeded',
  'wallet_connect_failed',
  'page_cta_clicked',
  'token_page_viewed',
  'token_create_started',
  'token_create_succeeded',
  'token_create_failed',
  'draft_created_started',
  'draft_created_succeeded',
  'draft_created_failed',
  'buy_started',
  'buy_submitted',
  'buy_failed',
  'sell_started',
  'sell_submitted',
  'sell_failed',
  'graduation_viewed',
  'recruiter_link_landed',
  'sponsorship_apply_started',
  'sponsorship_apply_submitted',
  'sponsorship_apply_failed',
  'reward_claim_started',
  'reward_claim_succeeded',
  'reward_claim_failed',
] as const

export const ADMIN_EVENT_NAMES = [
  'admin_signed_in',
  'admin_sign_in_failed',
  'admin_note_added',
  'admin_sponsorship_status_changed',
  'admin_promotor_refreshed',
  'admin_recruiter_updated',
] as const

export const CATALOG_EVENT_NAMES = [
  ...RESERVED_EVENT_NAMES,
  ...PUBLIC_EVENT_NAMES,
  ...ADMIN_EVENT_NAMES,
] as const

export type CatalogEventName = (typeof CATALOG_EVENT_NAMES)[number]

const CATALOG_SET = new Set<string>(CATALOG_EVENT_NAMES)

export function isCatalogEventName(name: string): name is CatalogEventName {
  return CATALOG_SET.has(name)
}

export const SESSION_TIMEOUT_MS = 30 * 60 * 1000
export const HEARTBEAT_MS = 30_000
export const FLUSH_INTERVAL_MS = 2_000
export const FLUSH_AT = 10
export const MAX_BATCH = 50
export const MAX_PROPERTY_KEYS = 16
export const MAX_STRING = 256
