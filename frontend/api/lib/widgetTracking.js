/**
 * Swap widget usage and build tracking (2026-10-23). Observation only.
 *
 * trackWidget(spec, handler) wraps a widget route handler (server.mjs, /api/widget/*). The handler runs exactly as
 * before and answers the widget. Only a request the handler answered with status 200 (response ended, no throw) is
 * counted, and counting touches no database on the request path: it adds 1 to an in-memory counter per
 * (day, chain, partner, website, event) and, for a swap build that handed out a transaction, queues one ledger row
 * (widget_swap_builds) with the same fingerprint the partner attribution records (importSwapFingerprint.js).
 *
 * Every 15 seconds (and best effort on SIGTERM) flushWidgetTracking writes what was counted: one batched upsert into
 * widget_usage_daily and one batched insert into widget_swap_builds. Partners are checked at flush time against the
 * active partner ids per chain, read with one query at most once a minute. A flush is skipped while the API's pool has
 * requests waiting for a connection (the swap path comes first), and once an hour it deletes widget builds older than
 * 30 days that never matched a landed swap. A tracking error is logged and dropped: it never changes, delays or fails
 * a widget answer. Missing tables (42P01 / 42703, the SQL not applied yet) switch writing off quietly for 5 minutes.
 *
 * Privacy (docs/widget/SWAP_WIDGET.md): no cookies, no IP address, no visitor id. The website is the hostname of the
 * request's Origin (else Referer). Wallets only in widget_swap_builds, to match the landed swap.
 */
import { evmFingerprint, solanaFingerprintFromBuilt } from "./importSwapFingerprint.js";
import { deleteUnmatchedWidgetBuilds, recordWidgetBuilds } from "./widgetSwapLedger.js";

export const WIDGET_EVENTS = Object.freeze(["load", "quote", "build", "approval", "bonding_trade"]);
export const WIDGET_TRACK_CHAINS = Object.freeze([101, 56, 4663, 97, 46630]);
export const WIDGET_HOST_CAP = 500;
export const WIDGET_FLUSH_MS = 15_000;
export const WIDGET_BUILD_QUEUE_MAX = 5_000;
export const WIDGET_USAGE_KEYS_MAX = 20_000;
const PARTNER_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const HOST_MAX = 120;
const OFF_MS = 5 * 60_000;
const PARTNER_TTL_MS = 60_000;
const RETENTION_EVERY_MS = 60 * 60_000;

function isSchemaMissing(error) {
  return error?.code === "42P01" || error?.code === "42703";
}

/**
 * The embedding website from a URL (Origin or Referer): its hostname, lower case, without "www." and a trailing dot,
 * at most 120 characters. '' when there is none (no header, "null" from a sandboxed frame, not a URL). An IP literal
 * becomes "ip-address": the promise is no IP addresses stored, whoever's they are.
 */
export function normalizeWidgetHost(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.toLowerCase() === "null") return "";
  let host;
  try {
    host = new URL(raw).hostname;
  } catch {
    return "";
  }
  host = String(host || "").toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  if (!host) return "";
  if (host.startsWith("[") || host.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return "ip-address";
  if (!/^[a-z0-9.-]+$/.test(host)) return "";
  return host.slice(0, HOST_MAX);
}

/** The embedding website of a widget request: Origin, else Referer. */
export function widgetHost(req) {
  const headers = req?.headers || {};
  return normalizeWidgetHost(headers.origin) || normalizeWidgetHost(headers.referer || headers.referrer);
}

/** A partner id as the widget sends it, checked like readPartner (api/importSwap.js), else ''. */
export function widgetPartnerId(value) {
  const id = String(value ?? "").trim().toLowerCase();
  return id && PARTNER_RE.test(id) ? id : "";
}

// ------------------------------------------------------------------ in-memory state

const state = {
  usage: new Map(), // "day|chain|partner|host|event" -> { day, chainId, partnerId, host, event, n }
  builds: [],
  droppedBuilds: 0,
  droppedUsage: 0,
  partners: { at: 0, active: new Set() }, // "chain:id"
  usageOffUntil: 0,
  buildsOffUntil: 0,
  lastRetention: 0,
  timer: null,
  flushing: null,
  sigterm: false,
};

export function resetWidgetTrackingState() {
  stopWidgetTrackingFlush();
  state.usage = new Map();
  state.builds = [];
  state.droppedBuilds = 0;
  state.droppedUsage = 0;
  state.partners = { at: 0, active: new Set() };
  state.usageOffUntil = 0;
  state.buildsOffUntil = 0;
  state.lastRetention = 0;
  state.flushing = null;
}

/** What is waiting for the next flush (tests and diagnostics). */
export function widgetTrackingPending() {
  return { usage: [...state.usage.values()].map((u) => ({ ...u })), builds: state.builds.map((b) => ({ ...b })), droppedBuilds: state.droppedBuilds, droppedUsage: state.droppedUsage };
}

const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/** +1 in memory for (today UTC, chain, partner as sent, website, event). No database. Returns true when counted. */
export function queueWidgetUsage({ chainId, partnerId = "", host = "", event }, { now = Date.now(), loop = true } = {}) {
  if (!WIDGET_EVENTS.includes(event) || !WIDGET_TRACK_CHAINS.includes(Number(chainId))) return false;
  const entry = { day: utcDay(now), chainId: Number(chainId), partnerId: widgetPartnerId(partnerId), host: String(host || "").slice(0, HOST_MAX), event };
  const key = `${entry.day}|${entry.chainId}|${entry.partnerId}|${entry.host}|${entry.event}`;
  const hit = state.usage.get(key);
  if (hit) hit.n += 1;
  else if (state.usage.size >= WIDGET_USAGE_KEYS_MAX) {
    state.droppedUsage += 1;
    return false;
  } else state.usage.set(key, { ...entry, n: 1 });
  if (loop) ensureFlushLoop();
  return true;
}

/** Queues one widget build for the next flush. No database. A full queue drops the row (counted, logged at flush). */
export function queueWidgetBuild(record, { loop = true } = {}) {
  if (!record?.fingerprint || !record?.wallet) return false;
  if (state.builds.length >= WIDGET_BUILD_QUEUE_MAX) {
    state.droppedBuilds += 1;
    return false;
  }
  state.builds.push({ ...record });
  if (loop) ensureFlushLoop();
  return true;
}

// ------------------------------------------------------------------ flush

/** Active partner ids per chain ("chain:id"), refreshed with one query at most once a minute. */
async function activePartners(db, now) {
  if (state.partners.at && now - state.partners.at < PARTNER_TTL_MS) return state.partners.active;
  let active = new Set();
  try {
    const { rows } = await db.query("select id, chain_id from public.import_fee_partners where active");
    active = new Set(rows.map((r) => `${Number(r.chain_id)}:${String(r.id)}`));
  } catch (error) {
    if (!isSchemaMissing(error)) {
      console.warn("[widget-tracking] partner list not read; partners count as none this round", String(error?.message || error));
      return state.partners.active;
    }
  }
  state.partners = { at: now, active };
  return active;
}

// One statement for the whole batch: the incoming rows, the named websites each (day, chain) already has, and a
// rank for the new ones so a (day, chain) never passes $7 named websites; the rest is counted as 'other'.
const USAGE_FLUSH_SQL = `
  with input as (
    select * from unnest($1::date[], $2::int[], $3::text[], $4::text[], $5::text[], $6::bigint[]) as t(day, chain_id, partner_id, host, event, n)
  ), slots as (
    select distinct day, chain_id from input
  ), known as (
    select distinct w.day, w.chain_id, w.host
      from public.widget_usage_daily w join slots s on s.day = w.day and s.chain_id = w.chain_id
     where w.host not in ('', 'other')
  ), named as (
    select day, chain_id, count(*) as n from known group by 1, 2
  ), fresh as (
    select distinct i.day, i.chain_id, i.host from input i
     where i.host not in ('', 'other')
       and not exists (select 1 from known k where k.day = i.day and k.chain_id = i.chain_id and k.host = i.host)
  ), allowed as (
    select f.day, f.chain_id, f.host
      from (select f.*, row_number() over (partition by f.day, f.chain_id order by f.host) as rn from fresh f) f
      left join named c on c.day = f.day and c.chain_id = f.chain_id
     where coalesce(c.n, 0) + f.rn <= $7::int
  ), resolved as (
    select i.day, i.chain_id, i.partner_id,
           case when i.host in ('', 'other')
                  or exists (select 1 from known k where k.day = i.day and k.chain_id = i.chain_id and k.host = i.host)
                  or exists (select 1 from allowed a where a.day = i.day and a.chain_id = i.chain_id and a.host = i.host)
                then i.host else 'other' end as host,
           i.event, i.n
      from input i
  )
  insert into public.widget_usage_daily as u (day, chain_id, partner_id, host, event, count)
  select day, chain_id, partner_id, host, event, sum(n)::bigint from resolved group by 1, 2, 3, 4, 5
  on conflict (day, chain_id, partner_id, host, event) do update set count = u.count + excluded.count`;

async function flushUsage(db, entries, active, cap) {
  const merged = new Map();
  for (const e of entries) {
    const partnerId = e.partnerId && active.has(`${e.chainId}:${e.partnerId}`) ? e.partnerId : "";
    const key = `${e.day}|${e.chainId}|${partnerId}|${e.host}|${e.event}`;
    const hit = merged.get(key);
    if (hit) hit.n += e.n;
    else merged.set(key, { ...e, partnerId });
  }
  const rows = [...merged.values()];
  if (!rows.length) return 0;
  const col = (k) => rows.map((r) => r[k]);
  await db.query(USAGE_FLUSH_SQL, [col("day"), col("chainId"), col("partnerId"), col("host"), col("event"), rows.map((r) => String(r.n)), cap]);
  return rows.length;
}

function poolBusy(db) {
  return Number(db?.waitingCount || 0) > 0;
}

/**
 * Writes what was counted since the last flush: one usage upsert, one builds insert, and (at most once an hour) the
 * 30-day retention of unmatched builds. Skipped while the pool has waiting requests (the buffers are kept). Never
 * throws. Returns { usageRows, builds, retention, skipped }.
 */
export async function flushWidgetTracking({ db, now = Date.now(), cap = WIDGET_HOST_CAP, force = false } = {}) {
  if (state.flushing) return state.flushing;
  const run = (async () => {
    const out = { usageRows: 0, builds: 0, retention: 0, skipped: null };
    if (!db) return { ...out, skipped: "no database" };
    if (!force && poolBusy(db)) return { ...out, skipped: "pool busy" };
    const usage = [...state.usage.values()];
    const builds = state.builds;
    state.usage = new Map();
    state.builds = [];
    if (state.droppedBuilds || state.droppedUsage) {
      console.warn("[widget-tracking] queue full; dropped", { builds: state.droppedBuilds, usageKeys: state.droppedUsage });
      state.droppedBuilds = 0;
      state.droppedUsage = 0;
    }
    const retentionDue = now - state.lastRetention >= RETENTION_EVERY_MS && now >= state.buildsOffUntil;
    if (!usage.length && !builds.length && !retentionDue) return out;
    const active = usage.length || builds.length ? await activePartners(db, now) : state.partners.active;
    if (usage.length && now >= state.usageOffUntil) {
      try {
        out.usageRows = await flushUsage(db, usage, active, cap);
      } catch (error) {
        if (isSchemaMissing(error)) {
          if (!state.usageOffUntil) console.warn("[widget-tracking] widget_usage_daily is missing: apply database/prod_apply_widget_analytics.sql; usage is not counted");
          state.usageOffUntil = now + OFF_MS;
        } else console.warn("[widget-tracking] usage not written; dropped", { rows: usage.length, error: String(error?.message || error) });
      }
    }
    if (builds.length && now >= state.buildsOffUntil) {
      const resolved = builds.map((b) => ({ ...b, partnerId: b.partnerId && active.has(`${b.chainId}:${b.partnerId}`) ? b.partnerId : null }));
      const written = await recordWidgetBuilds(db, resolved);
      if (written === null) state.buildsOffUntil = now + OFF_MS;
      else out.builds = written;
    }
    if (retentionDue && now >= state.buildsOffUntil) {
      state.lastRetention = now;
      out.retention = (await deleteUnmatchedWidgetBuilds(db)) ?? 0;
    }
    return out;
  })()
    .catch((error) => {
      console.warn("[widget-tracking] flush failed", String(error?.message || error));
      return { usageRows: 0, builds: 0, retention: 0, skipped: "error" };
    })
    .finally(() => {
      state.flushing = null;
    });
  state.flushing = run;
  return run;
}

async function defaultDb() {
  try {
    return (await import("../../server/db.js")).pool || null;
  } catch {
    return null;
  }
}

function ensureFlushLoop() {
  if (state.timer) return;
  state.timer = setInterval(() => {
    defaultDb().then((db) => flushWidgetTracking({ db }));
  }, WIDGET_FLUSH_MS);
  state.timer.unref?.();
  if (!state.sigterm) {
    state.sigterm = true;
    // Best effort on shutdown: flush (at most 3 s), then let SIGTERM do what it did before (exit) when nothing else
    // listens for it.
    process.once("SIGTERM", () => {
      const done = () => {
        if (process.listenerCount("SIGTERM") === 0) process.kill(process.pid, "SIGTERM");
      };
      Promise.race([defaultDb().then((db) => flushWidgetTracking({ db, force: true })), new Promise((r) => setTimeout(r, 3000))]).finally(done);
    });
  }
}

export function stopWidgetTrackingFlush() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

// ------------------------------------------------------------------ request side (no database)

function plainObject(value) {
  if (value && typeof value === "object" && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)) return value;
  if (typeof value === "string" || Buffer.isBuffer(value) || value instanceof Uint8Array) {
    try {
      const parsed = JSON.parse(Buffer.from(value).toString("utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function requestQuery(req) {
  if (req?.query && typeof req.query === "object") return req.query;
  try {
    return Object.fromEntries(new URL(String(req?.url || ""), "http://x").searchParams);
  } catch {
    return {};
  }
}

const digits = (value) => (value != null && /^\d+$/.test(String(value)) ? String(value) : null);

/** The fee rate the build carries: the API's quote (EVM import 4663, gen-8), Jupiter's platformFee, Kyber's extraFee. */
function feeBpsOf(payload, body) {
  const quote = payload?.quote && typeof payload.quote === "object" ? payload.quote : {};
  const sent = body?.quote && typeof body.quote === "object" ? body.quote : {};
  const candidates = [quote.feeBps, sent.platformFee?.feeBps, sent.extraFee?.isInBps === true ? sent.extraFee?.feeAmount : null, sent.feeBps];
  for (const c of candidates) {
    const n = Number(c);
    if (c != null && c !== "" && Number.isInteger(n) && n >= 0 && n <= 10_000) return n;
  }
  return null;
}

/** The native leg of the build (buy: native in; sell: native out as quoted). Only a fallback for volume. */
function nativeRawOf(payload, body, side) {
  const quote = payload?.quote && typeof payload.quote === "object" ? payload.quote : body?.quote && typeof body.quote === "object" ? body.quote : {};
  return side === "buy" ? digits(quote.amountIn ?? quote.inAmount) : side === "sell" ? digits(quote.amountOut ?? quote.outAmount) : null;
}

/**
 * The ledger row of a widget build answer, or null when the answer is not a transaction (an allowance step, an
 * error). The fingerprint is computed exactly as the partner attribution computes it from what the API built:
 * Solana sha256(wallet : Jupiter instruction data) of transactionBase64; EVM keccak(to : data : value).
 */
export function widgetBuildRecord({ chainId, kind = "import", payload, body, host = "", partnerId = "" }) {
  if (!payload || typeof payload !== "object" || payload.ok === false || payload.needsAllowance) return null;
  const chain = Number(chainId);
  const evm = chain !== 101;
  const wallet = String(body?.wallet ?? "").trim();
  if (!wallet) return null;
  let fingerprint = null;
  try {
    fingerprint = evm ? evmFingerprint(payload.to, payload.data, payload.value) : payload.transactionBase64 ? solanaFingerprintFromBuilt(payload.transactionBase64, wallet) : null;
  } catch {
    fingerprint = null;
  }
  if (!fingerprint) return null;
  const side = ["buy", "sell"].includes(String(body?.side || "").toLowerCase()) ? String(body.side).toLowerCase() : null;
  const tokenRaw = String(body?.token ?? body?.tokenAddress ?? "").trim();
  return {
    fingerprint,
    chainId: chain,
    kind: kind === "gen8" ? "gen8" : "import",
    wallet: evm ? wallet.toLowerCase() : wallet,
    token: tokenRaw ? (evm ? tokenRaw.toLowerCase() : tokenRaw).slice(0, 64) : null,
    side,
    partnerId: widgetPartnerId(partnerId) || null,
    host,
    feeBps: feeBpsOf(payload, body),
    nativeRaw: nativeRawOf(payload, body, side),
  };
}

/**
 * What one answered widget request counts as (in memory). spec: { event, chainId? (fixed chain), kind? ('gen8' build
 * route) }. Only status 200 counts. A build answer counts 'approval' for an allowance step and 'build' (plus a queued
 * ledger row) when it handed out a transaction; anything else on a build route counts nothing.
 */
export function observeWidgetRequest({ spec, req, status, payload }, deps = {}) {
  if (Number(status) !== 200) return null;
  const query = requestQuery(req);
  const body = String(req?.method || "GET").toUpperCase() === "GET" ? {} : plainObject(req?.body);
  const chainId = Number(spec.chainId ?? body.chainId ?? query.chainId);
  if (!WIDGET_TRACK_CHAINS.includes(chainId)) return null;
  const host = widgetHost(req);
  const partnerId = widgetPartnerId(body.partner ?? query.partner);
  let event = spec.event;
  let record = null;
  if (spec.event === "build") {
    const answer = plainObject(payload);
    if (answer.ok === false) return null;
    if (answer.needsAllowance) event = "approval";
    else {
      record = widgetBuildRecord({ chainId, kind: spec.kind, payload: answer, body, host, partnerId });
      if (!record) return null;
    }
  }
  (deps.queueUsage || queueWidgetUsage)({ chainId, partnerId, host, event });
  if (record) (deps.queueBuild || queueWidgetBuild)(record);
  return { event, chainId, partnerId, host, record };
}

/**
 * Wraps a widget route handler. The handler is called unchanged with the same req / res; for a build route the
 * wrapper keeps a reference to the body the handler sent (res.end's chunk) to read the fingerprint afterwards. Counted
 * only when the handler returned without throwing and the response ended with status 200. The counting itself runs on
 * setImmediate, in memory; its errors are swallowed.
 */
export function trackWidget(spec, handler, deps = {}) {
  return async function trackedWidgetRoute(req, res) {
    let sent = null;
    if (spec.event === "build" && res && typeof res.end === "function") {
      const end = res.end;
      res.end = function trackedEnd(chunk, ...rest) {
        if (sent == null && chunk != null && typeof chunk !== "function") sent = chunk;
        return end.call(this, chunk, ...rest);
      };
    }
    const result = await handler(req, res);
    // Reached only when the handler did not throw. The answer must be complete and a success.
    const answered = Boolean(res?.writableEnded ?? res?.headersSent);
    const status = res?.statusCode;
    if (answered && Number(status) === 200) {
      const schedule = deps.schedule || setImmediate;
      schedule(() => {
        try {
          observeWidgetRequest({ spec, req, status, payload: sent }, deps);
        } catch (error) {
          console.warn("[widget-tracking] not counted", String(error?.message || error));
        }
      });
    }
    return result;
  };
}
