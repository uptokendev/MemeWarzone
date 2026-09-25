/**
 * Request coalescing + 2 s micro-cache for the hot token-page GETs.
 *
 * On 2026-09-25 KAIJU88 was the first launch with real traffic. Every viewer's token page polls
 * ~7 indexer endpoints (summary, trades, candles with limit 5000, market-state/-trades/-summary,
 * canonical candles) every few seconds, each an independent DB read against a 12-connection pool.
 * Requests queued past connectionTimeoutMillis and every endpoint -- and /health -- answered
 * "timeout exceeded when trying to connect"; retries made it worse. Identical concurrent GETs now
 * share one handler run, and a 200 answer is reused for TOKEN_RESPONSE_CACHE_MS (default 2000),
 * shorter than the page's own poll. Errors are coalesced but never cached.
 */
import type { NextFunction, Request, Response } from "express";

export const HOT_TOKEN_ROUTE = /^\/api\/token\/[^/]+\/(summary|trades|candles|market-state|market-trades|market-summary|canonical-market-candles)$/;

type Captured = { status: number; contentType: string | null; body: unknown; at: number };

export function createTokenResponseCache(options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
  const ttlMs = Math.max(0, Number(options.ttlMs ?? process.env.TOKEN_RESPONSE_CACHE_MS ?? 2000));
  const maxEntries = Math.max(50, Number(options.maxEntries ?? 2000));
  const now = options.now ?? Date.now;
  const cache = new Map<string, Captured>();
  const inflight = new Map<string, Promise<Captured>>();
  const stats = { hits: 0, coalesced: 0, misses: 0 };

  const replay = (res: Response, entry: Captured) => {
    if (entry.contentType) res.setHeader("Content-Type", entry.contentType);
    res.setHeader("X-Token-Cache", "hit");
    res.status(entry.status).send(entry.body as any);
  };

  function middleware(req: Request, res: Response, next: NextFunction) {
    if (req.method !== "GET" || !HOT_TOKEN_ROUTE.test(req.path) || ttlMs === 0) return next();
    const key = req.originalUrl;
    const cached = cache.get(key);
    if (cached && now() - cached.at < ttlMs) {
      stats.hits += 1;
      return replay(res, cached);
    }
    const pending = inflight.get(key);
    if (pending) {
      stats.coalesced += 1;
      pending.then((entry) => replay(res, entry), () => next());
      return;
    }
    stats.misses += 1;
    let settle!: (entry: Captured) => void;
    let fail!: (error: unknown) => void;
    const promise = new Promise<Captured>((resolve, reject) => { settle = resolve; fail = reject; });
    promise.catch(() => undefined);
    inflight.set(key, promise);

    const originalSend = res.send.bind(res);
    let captured = false;
    res.send = ((body?: any) => {
      if (!captured) {
        captured = true;
        const entry: Captured = { status: res.statusCode, contentType: String(res.getHeader("Content-Type") || "") || null, body, at: now() };
        if (entry.status === 200) {
          cache.set(key, entry);
          if (cache.size > maxEntries) cache.delete(cache.keys().next().value as string);
        }
        inflight.delete(key);
        settle(entry);
      }
      return originalSend(body);
    }) as Response["send"];
    res.on("close", () => {
      if (!captured) {
        inflight.delete(key);
        fail(new Error("response closed before send"));
      }
    });
    next();
  }

  return { middleware, stats, cache, inflight };
}
