import {
  FLUSH_AT,
  FLUSH_INTERVAL_MS,
  HEARTBEAT_MS,
  MAX_BATCH,
  MAX_PROPERTY_KEYS,
  MAX_STRING,
  SESSION_TIMEOUT_MS,
  type AnalyticsApp,
  isCatalogEventName,
} from './catalog'
import { isForbiddenEventName, stripForbiddenProperties } from './denylist'
import { parseUtm, templatePath } from './paths'
import type { AnalyticsEvent, AnalyticsPrimitive, AnalyticsProperties } from './types'

const AID_KEY = 'mw_aid'
const SID_KEY = 'mw_sid'
const SID_AT_KEY = 'mw_sid_at'
const UID_KEY = 'mw_uid'

export type AnalyticsInitOptions = {
  endpoint: string
  writeKey: string
  app: AnalyticsApp
  getAuthToken?: () => Promise<string | null>
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const n = Math.random() * 16 | 0
    const v = ch === 'x' ? n : (n & 0x3) | 0x8
    return v.toString(16)
  })
}

function clampString(value: unknown): string {
  return String(value ?? '').slice(0, MAX_STRING)
}

function readStorage(key: string): string {
  try { return String(localStorage.getItem(key) || '') } catch { return '' }
}

function writeStorage(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* ignore quota / private mode */ }
}

function deviceFromViewport(width: number): 'mobile' | 'tablet' | 'desktop' {
  if (width < 768) return 'mobile'
  if (width < 1024) return 'tablet'
  return 'desktop'
}

function trimProperties(input: AnalyticsProperties): AnalyticsProperties {
  const out: AnalyticsProperties = {}
  let count = 0
  for (const [key, value] of Object.entries(input)) {
    if (count >= MAX_PROPERTY_KEYS) break
    if (typeof value === 'string') out[clampString(key)] = clampString(value)
    else out[clampString(key)] = value
    count += 1
  }
  return out
}

export class AnalyticsClient {
  private options: AnalyticsInitOptions | null = null
  private queue: AnalyticsEvent[] = []
  private flushTimer: number | null = null
  private heartbeatTimer: number | null = null
  private pageEnteredAt = 0
  private lastPath = ''
  private flushing = false
  private identifiedUser: string | null = null

  init(options: AnalyticsInitOptions) {
    this.options = options
    this.anonymousId()
    this.sessionId()
    if (this.flushTimer == null && typeof window !== 'undefined') {
      this.flushTimer = window.setInterval(() => { void this.flush() }, FLUSH_INTERVAL_MS)
      window.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') void this.flush()
      })
      window.addEventListener('pagehide', () => { void this.flush() })
    }
    this.startHeartbeat()
  }

  anonymousId(): string {
    let id = readStorage(AID_KEY)
    if (!id) {
      id = uuid()
      writeStorage(AID_KEY, id)
    }
    return id
  }

  sessionId(): string {
    const now = Date.now()
    const existing = readStorage(SID_KEY)
    const last = Number(readStorage(SID_AT_KEY) || 0)
    if (existing && now - last < SESSION_TIMEOUT_MS) {
      writeStorage(SID_AT_KEY, String(now))
      return existing
    }
    const next = uuid()
    writeStorage(SID_KEY, next)
    writeStorage(SID_AT_KEY, String(now))
    return next
  }

  identify(userId: string | null | undefined) {
    const id = String(userId || '').trim()
    if (!id || this.identifiedUser === id) return
    this.identifiedUser = id
    writeStorage(UID_KEY, id)
    this.enqueue('$identify', { user_id: id })
  }

  page(path?: string) {
    const nextPath = path || (typeof window !== 'undefined' ? window.location.pathname : '/')
    if (this.lastPath && this.lastPath !== nextPath && this.pageEnteredAt) {
      this.enqueue('$pageleave', {
        path: templatePath(this.lastPath),
        duration_ms: Math.max(0, Date.now() - this.pageEnteredAt),
      })
    }
    this.lastPath = nextPath
    this.pageEnteredAt = Date.now()
    this.enqueue('$pageview', { path: templatePath(nextPath) })
  }

  track(name: string, properties: Record<string, unknown> = {}) {
    this.enqueue(name, stripForbiddenProperties(properties))
  }

  async measure<T>(fnName: string, properties: Record<string, unknown>, work: () => Promise<T> | T): Promise<T> {
    const started = Date.now()
    try {
      const result = await work()
      this.enqueue('$function', { fn: fnName, duration_ms: Date.now() - started, ok: true, ...stripForbiddenProperties(properties) })
      return result
    } catch (error) {
      const err = error as { code?: string; message?: string }
      this.enqueue('$function', {
        fn: fnName,
        duration_ms: Date.now() - started,
        ok: false,
        error_code: clampString(err?.code || 'error'),
        ...stripForbiddenProperties(properties),
      })
      throw error
    }
  }

  observeWebVitals() {
    if (typeof PerformanceObserver === 'undefined') return
    const sent = new Set<string>()
    const send = (metric: string, value: number) => {
      if (sent.has(metric) && metric !== 'CLS' && metric !== 'INP') return
      if (metric !== 'CLS' && metric !== 'INP') sent.add(metric)
      this.enqueue('$web_vital', {
        metric,
        value: Math.round(value * (metric === 'CLS' ? 1000 : 1)) / (metric === 'CLS' ? 1000 : 1),
        rating: rateVital(metric, value),
      })
    }

    try {
      const lcp = new PerformanceObserver((list) => {
        const entry = list.getEntries().at(-1)
        if (entry) send('LCP', entry.startTime)
      })
      lcp.observe({ type: 'largest-contentful-paint', buffered: true })
    } catch { /* unsupported */ }

    try {
      const cls = new PerformanceObserver((list) => {
        let total = 0
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number }
          if (!shift.hadRecentInput) total += Number(shift.value || 0)
        }
        if (total) send('CLS', total)
      })
      cls.observe({ type: 'layout-shift', buffered: true })
    } catch { /* unsupported */ }

    try {
      const inp = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const ev = entry as PerformanceEntry & { duration?: number }
          send('INP', Number(ev.duration || 0))
        }
      })
      inp.observe({ type: 'event', buffered: true, durationThreshold: 40 } as PerformanceObserverInit)
    } catch { /* unsupported */ }

    try {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
      if (nav) send('TTFB', nav.responseStart)
    } catch { /* unsupported */ }
  }

  async flush() {
    if (this.flushing || !this.options || this.queue.length === 0) return
    const batch = this.queue.splice(0, MAX_BATCH)
    this.flushing = true
    try {
      const body = JSON.stringify({ writeKey: this.options.writeKey, events: batch })
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-analytics-key': this.options.writeKey,
      }
      if (this.options.getAuthToken) {
        const token = await this.options.getAuthToken()
        if (token) headers.authorization = `Bearer ${token}`
      }
      const response = await fetch(this.options.endpoint, {
        method: 'POST', headers, body, keepalive: true, cache: 'no-store',
      })
      if (!response.ok) this.queue.unshift(...batch)
    } catch {
      this.queue.unshift(...batch)
    } finally {
      this.flushing = false
    }
  }

  private startHeartbeat() {
    if (this.heartbeatTimer != null || typeof window === 'undefined') return
    this.heartbeatTimer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      this.enqueue('$heartbeat', { path: templatePath(window.location.pathname) })
    }, HEARTBEAT_MS)
  }

  private enqueue(name: string, properties: Record<string, AnalyticsPrimitive>) {
    if (!this.options?.endpoint || !this.options.writeKey) return
    if (!isCatalogEventName(name) || isForbiddenEventName(name)) return
    const pagePath = typeof window !== 'undefined' ? window.location.pathname : '/'
    const search = typeof window !== 'undefined' ? window.location.search : ''
    const storedUser = this.identifiedUser || readStorage(UID_KEY) || undefined
    const event: AnalyticsEvent = {
      event_id: uuid(),
      name,
      ts: new Date().toISOString(),
      app: this.options.app,
      anonymous_id: this.anonymousId(),
      session_id: this.sessionId(),
      user_id: storedUser,
      page: {
        // Preserve the actual route. The API stores this as path_raw and derives
        // path_template server-side for safe aggregation (for example /token/:address).
        path: clampString(pagePath),
        title: typeof document !== 'undefined' ? clampString(document.title) : undefined,
        referrer: typeof document !== 'undefined' ? clampString(document.referrer) : undefined,
        search: search ? clampString(search) : undefined,
      },
      context: {
        locale: typeof navigator !== 'undefined' ? navigator.language : undefined,
        viewport: typeof window !== 'undefined' ? { w: window.innerWidth, h: window.innerHeight } : undefined,
        utm: parseUtm(search),
        device: typeof window !== 'undefined' ? deviceFromViewport(window.innerWidth) : undefined,
      },
      properties: trimProperties(properties),
    }
    this.queue.push(event)
    if (this.queue.length >= FLUSH_AT) void this.flush()
  }
}

function rateVital(metric: string, value: number): string {
  if (metric === 'LCP') return value <= 2500 ? 'good' : value <= 4000 ? 'needs-improvement' : 'poor'
  if (metric === 'INP') return value <= 200 ? 'good' : value <= 500 ? 'needs-improvement' : 'poor'
  if (metric === 'CLS') return value <= 0.1 ? 'good' : value <= 0.25 ? 'needs-improvement' : 'poor'
  if (metric === 'TTFB') return value <= 800 ? 'good' : value <= 1800 ? 'needs-improvement' : 'poor'
  return 'unknown'
}

export const analytics = new AnalyticsClient()
