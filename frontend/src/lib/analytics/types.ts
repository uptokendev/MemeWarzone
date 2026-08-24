import type { AnalyticsApp, CatalogEventName } from './catalog'

export type AnalyticsPrimitive = string | number | boolean | null

export type AnalyticsProperties = Record<string, AnalyticsPrimitive>

export type AnalyticsEvent = {
  event_id: string
  name: CatalogEventName | string
  ts: string
  app: AnalyticsApp
  anonymous_id: string
  session_id: string
  user_id?: string
  page: {
    path: string
    title?: string
    referrer?: string
    search?: string
  }
  context: {
    locale?: string
    viewport?: { w: number; h: number }
    utm?: Record<string, string>
    device?: 'mobile' | 'desktop' | 'tablet'
    browser?: string
    os?: string
  }
  properties: AnalyticsProperties
}

export type AnalyticsOverview = {
  schemaMissing?: boolean
  from: string
  to: string
  app: string
  dau: number
  sessions: number
  pageviews: number
  bounceRate: number
  liveUsers: number
  topPages: Array<{ path: string; views: number; uniques: number }>
  topEvents: Array<{ name: string; count: number }>
  vitals: Array<{ metric: string; p75: number | null }>
  series: Array<{ bucket: string; pageviews: number; sessions: number }>
}

export type AnalyticsPageRow = {
  path: string
  views: number
  uniques: number
  avgDurationMs: number | null
}

export type AnalyticsEventRow = {
  name: string
  count: number
}

export type AnalyticsFunctionRow = {
  fn: string
  n: number
  okN: number
  errorRate: number
  p50Ms: number | null
  p95Ms: number | null
}

export type AnalyticsVitalRow = {
  metric: string
  p50: number | null
  p75: number | null
  p95: number | null
  n: number
}

export type AnalyticsRealtime = {
  schemaMissing?: boolean
  liveUsers: number
  pages: Array<{ path: string; users: number }>
  recent: Array<{
    ts: string
    name: string
    path: string | null
    userId: string | null
    app: string
  }>
}

export type AnalyticsSessionRow = {
  sessionId: string
  app: string
  anonymousId: string
  userId: string | null
  startedAt: string
  lastSeenAt: string
  entryPath: string | null
  exitPath: string | null
  pageviewCount: number
  eventCount: number
}

export type AnalyticsSessionDetail = AnalyticsSessionRow & {
  events: Array<{
    eventId: string
    ts: string
    name: string
    path: string | null
    properties: AnalyticsProperties
  }>
}
