/**
 * Swap widget usage and build tracking (2026-10-23). Observation only.
 *
 * trackWidget(spec, handler) wraps a widget route handler (server.mjs, /api/widget/*). The handler runs exactly as
 * before and answers the widget first; only after that, on the next tick, the wrapper looks at what was answered and
 * writes, best effort:
 *   - one upsert into widget_usage_daily (day, chain, partner, website, event), and
 *   - for a swap build that handed out a transaction, one row in widget_swap_builds with the same fingerprint the
 *     partner attribution records (importSwapFingerprint.js), so the fee scanner can mark landed widget swaps.
 * A tracking error is logged and swallowed: it never changes, delays or fails a widget answer. The swap itself is
 * never touched (the wrapper only reads the response the handler already sent). Missing tables (42P01 / 42703, the
 * SQL not applied yet) switch tracking off quietly for a few minutes.
 *
 * Privacy (docs/widget/SWAP_WIDGET.md): no cookies, no IP address, no visitor id. The website is the hostname of the
 * request's Origin (else Referer). Wallets only in widget_swap_builds, for the builds the wallet asked for.
 */
import { evmFingerprint, solanaFingerprintFromBuilt } from "./importSwapFingerprint.js";
import { recordWidgetBuild } from "./widgetSwapLedger.js";

export const WIDGET_EVENTS = Object.freeze(["load", "quote", "build", "approval", "bonding_trade"]);
export const WIDGET_TRACK_CHAINS = Object.freeze([101, 56, 4663, 97, 46630]);
export const WIDGET_HOST_CAP = 500;
const PARTNER_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const HOST_MAX = 120;
const OFF_MS = 5 * 60_000;
const PARTNER_TTL_MS = 60_000;

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

const partnerCache = new Map();

/** The partner id when that partner row exists and is active on this chain, else ''. Cached a minute. Never throws. */
export async function activeWidgetPartner(db, value, chainId, { now = Date.now() } = {}) {
  const id = widgetPartnerId(value);
  if (!id || !db) return "";
  const key = `${Number(chainId)}:${id}`;
  const hit = partnerCache.get(key);
  if (hit && now - hit.at < PARTNER_TTL_MS) return hit.active ? id : "";
  let active = false;
  try {
    const { rows } = await db.query("select 1 from public.import_fee_partners where id = $1 and chain_id = $2 and active limit 1", [id, Number(chainId)]);
    active = rows.length > 0;
  } catch (error) {
    if (!isSchemaMissing(error)) console.warn("[widget-tracking] partner lookup failed", String(error?.message || error));
  }
  if (partnerCache.size > 1000) partnerCache.clear();
  partnerCache.set(key, { at: now, active });
  return active ? id : "";
}

export function resetWidgetTrackingState() {
  partnerCache.clear();
  usageOffUntil = 0;
}

// One statement per request: the day is the database's UTC day; a new website on a (day, chain) that already has
// WIDGET_HOST_CAP named websites is counted as 'other'.
const USAGE_SQL = `
  insert into public.widget_usage_daily as u (day, chain_id, partner_id, host, event, count)
  select d.day, $1::int, $2::text,
         case when $3::text in ('', 'other')
                or exists (select 1 from public.widget_usage_daily x where x.day = d.day and x.chain_id = $1::int and x.host = $3::text)
                or (select count(distinct x.host) from public.widget_usage_daily x
                     where x.day = d.day and x.chain_id = $1::int and x.host not in ('', 'other')) < $5::int
              then $3::text else 'other' end,
         $4::text, 1
    from (select (now() at time zone 'utc')::date as day) d
  on conflict (day, chain_id, partner_id, host, event) do update set count = u.count + 1`;

let usageOffUntil = 0;

/** +1 for this (today, chain, partner, website, event). Returns true when written. Never throws. */
export async function recordWidgetUsage(db, { chainId, partnerId = "", host = "", event }, { now = Date.now(), cap = WIDGET_HOST_CAP } = {}) {
  if (!db || !WIDGET_EVENTS.includes(event) || !WIDGET_TRACK_CHAINS.includes(Number(chainId))) return false;
  if (now < usageOffUntil) return false;
  try {
    await db.query(USAGE_SQL, [Number(chainId), widgetPartnerId(partnerId), String(host || "").slice(0, HOST_MAX), event, cap]);
    return true;
  } catch (error) {
    if (isSchemaMissing(error)) {
      if (!usageOffUntil) console.warn("[widget-tracking] widget_usage_daily is missing: apply database/prod_apply_widget_analytics.sql; usage is not counted");
      usageOffUntil = now + OFF_MS;
      return false;
    }
    console.warn("[widget-tracking] usage not counted", String(error?.message || error));
    return false;
  }
}

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
    partnerId: partnerId || null,
    host,
    feeBps: feeBpsOf(payload, body),
    nativeRaw: nativeRawOf(payload, body, side),
  };
}

async function defaultDb() {
  try {
    return (await import("../../server/db.js")).pool || null;
  } catch {
    return null;
  }
}

/**
 * What one answered widget request counts as. spec: { event, chainId? (fixed chain), kind? ('gen8' build route) }.
 * Only status 200 answers count. A build answer counts 'approval' when it is an allowance step and 'build' (plus a
 * ledger row) when it handed out a transaction; anything else on a build route counts nothing.
 */
export async function observeWidgetRequest({ spec, req, status, payload }, deps = {}) {
  if (Number(status) !== 200) return null;
  const db = deps.db !== undefined ? deps.db : await defaultDb();
  if (!db) return null;
  const query = requestQuery(req);
  const body = String(req?.method || "GET").toUpperCase() === "GET" ? {} : plainObject(req?.body);
  const chainId = Number(spec.chainId ?? body.chainId ?? query.chainId);
  if (!WIDGET_TRACK_CHAINS.includes(chainId)) return null;
  const host = widgetHost(req);
  const partnerId = await activeWidgetPartner(db, body.partner ?? query.partner, chainId);
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
  await (deps.recordUsage || recordWidgetUsage)(db, { chainId, partnerId, host, event });
  if (record) await (deps.recordBuild || recordWidgetBuild)(db, record);
  return { event, chainId, partnerId, host, record };
}

/**
 * Wraps a widget route handler. The handler is called unchanged with the same req / res; for a build route the
 * wrapper keeps a reference to the body the handler sent (res.end's chunk) to read the fingerprint afterwards.
 * Tracking runs after the answer, on setImmediate, and its errors are swallowed.
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
    try {
      return await handler(req, res);
    } finally {
      const status = res?.statusCode;
      const schedule = deps.schedule || setImmediate;
      schedule(() => {
        Promise.resolve()
          .then(() => observeWidgetRequest({ spec, req, status, payload: sent }, deps))
          .catch((error) => console.warn("[widget-tracking] not recorded", String(error?.message || error)));
      });
    }
  };
}
