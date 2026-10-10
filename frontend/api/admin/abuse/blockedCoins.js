/**
 * Command Center -> Abuse -> Blocked coins (founder 2026-10-10).
 *
 *   GET  /api/admin/abuse/blocked-coins?status=active|released|all   abuse.view    -> { coins }
 *   GET  /api/admin/abuse/blocked-coins/lookup?chainId=&address=     abuse.view    -> { coin, activeBlock }
 *   POST /api/admin/abuse/blocked-coins                              abuse.manage  -> { coin }   (409 when blocked)
 *   POST /api/admin/abuse/blocked-coins/:id/release                  abuse.admin   -> { coin }
 *
 * A block and a release each run in one transaction: the blocked_coins row, the side effects
 * (lib/blockedCoins.js applyBlockSideEffects / undoBlockSideEffects) and the abuse audit event commit
 * together or not at all. No money moves and campaigns is never written.
 */
import { getQuery, readJson } from "../../../server/http.js";
import { ABUSE_PERMISSIONS, isUuid } from "../../lib/abuseAuth.js";
import {
  BLOCK_KINDS,
  BLOCK_MODES,
  applyBlockSideEffects,
  blockedAddressKey,
  clearBlockedCoinCache,
  findActiveBlock,
  listBlocks,
  lookupCoin,
  mapBlockedCoin,
  undoBlockSideEffects,
} from "../../lib/blockedCoins.js";
import { probeBlockedCoinsTable } from "../../lib/publicHiddenSql.js";

const REASON_MIN = 3;
const REASON_MAX = 500;

function requestPath(req) {
  return String(req.originalUrl || req.url || req.path || "").split("?")[0].replace(/\/+$/, "");
}

function routeOf(req) {
  const rest = requestPath(req).replace(/^.*\/admin\/abuse\/blocked-coins/, "");
  if (rest === "") return { name: "root" };
  if (rest === "/lookup") return { name: "lookup" };
  const release = rest.match(/^\/([^/]+)\/release$/);
  if (release) return { name: "release", id: decodeURIComponent(release[1]) };
  return { name: "unknown" };
}

function bad(res, status, error, code, extra = {}) {
  return res.status(status).json({ ok: false, error, code, ...extra });
}

function schemaMissing(res) {
  return bad(res, 503, "Blocked coins are not set up yet (migration 20261010_000020_blocked_coins.sql).", "BLOCKED_COINS_SCHEMA_MISSING");
}

function cleanReason(value) {
  const reason = String(value ?? "").trim();
  return reason.length >= REASON_MIN && reason.length <= REASON_MAX ? reason : "";
}

async function auditInTx(client, event) {
  await client.query(
    `insert into public.abuse_audit_events
       (event_type, actor_type, actor_id, actor_email, subject_id, subject_email, old_value, new_value, metadata)
     values ($1, 'admin', $2, $3, $4, null, $5, $6, $7::jsonb)`,
    [event.eventType, event.actorId || null, event.actorEmail || null, event.subjectId, event.oldValue ?? null, event.newValue ?? null, JSON.stringify(event.metadata || {})],
  );
}

async function inTransaction(db, fn) {
  const client = await db.connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function createBlockedCoinsHandlers({ pool: db, auth }) {
  async function list(req, res) {
    const status = String(getQuery(req).status || "active").toLowerCase();
    if (!["active", "released", "all"].includes(status)) return bad(res, 400, "status must be active, released or all.", "BLOCKED_COINS_BAD_STATUS");
    if (!(await probeBlockedCoinsTable(db))) return res.status(200).json({ ok: true, coins: [] });
    const rows = await listBlocks(db, status);
    return res.status(200).json({ ok: true, coins: rows.map(mapBlockedCoin) });
  }

  async function lookup(req, res) {
    const q = getQuery(req);
    const chainId = Number(q.chainId);
    const address = blockedAddressKey(chainId, q.address);
    if (!Number.isInteger(chainId) || chainId <= 0 || !address) {
      return bad(res, 400, "chainId and a valid campaign or token address are required.", "BLOCKED_COINS_BAD_INPUT");
    }
    const coin = await lookupCoin(db, chainId, address);
    const activeBlock =
      (coin ? await findActiveBlock(db, chainId, coin.campaignAddress || coin.tokenAddress) : null) ||
      (coin?.tokenAddress ? await findActiveBlock(db, chainId, coin.tokenAddress) : null) ||
      (await findActiveBlock(db, chainId, address));
    return res.status(200).json({ ok: true, coin, activeBlock: mapBlockedCoin(activeBlock) });
  }

  async function block(req, res, actor) {
    const body = await readJson(req);
    const chainId = Number(body.chainId);
    const address = blockedAddressKey(chainId, body.address);
    const kind = String(body.kind || "").trim().toLowerCase();
    const mode = String(body.mode || "").trim().toLowerCase();
    const reason = cleanReason(body.reason);
    const abuseReportId = body.abuseReportId == null || body.abuseReportId === "" ? null : String(body.abuseReportId).trim();

    if (!Number.isInteger(chainId) || chainId <= 0 || !address) {
      return bad(res, 400, "chainId and a valid campaign or token address are required.", "BLOCKED_COINS_BAD_INPUT");
    }
    if (!BLOCK_KINDS.includes(kind)) return bad(res, 400, "kind must be test or abuse.", "BLOCKED_COINS_BAD_KIND");
    if (!BLOCK_MODES.includes(mode)) return bad(res, 400, "mode must be hide or remove.", "BLOCKED_COINS_BAD_MODE");
    if (!reason) return bad(res, 400, `reason is required (${REASON_MIN} to ${REASON_MAX} characters).`, "BLOCKED_COINS_BAD_REASON");
    if (abuseReportId && !isUuid(abuseReportId)) return bad(res, 400, "abuseReportId must be a report id.", "BLOCKED_COINS_BAD_REPORT");
    if (!(await probeBlockedCoinsTable(db))) return schemaMissing(res);

    const coin = await lookupCoin(db, chainId, address);
    if (!coin) return bad(res, 404, "No coin with this address on this chain.", "BLOCKED_COINS_COIN_NOT_FOUND");

    const existing =
      (coin.campaignAddress ? await findActiveBlock(db, chainId, coin.campaignAddress) : null) ||
      (coin.tokenAddress ? await findActiveBlock(db, chainId, coin.tokenAddress) : null);
    if (existing) {
      return bad(res, 409, "This coin already has an active block.", "COIN_ALREADY_BLOCKED", { activeBlock: mapBlockedCoin(existing) });
    }

    let row;
    try {
      row = await inTransaction(db, async (client) => {
        const inserted = await client.query(
          `insert into public.blocked_coins
             (chain_id, campaign_address, token_address, name, symbol, kind, mode, reason, abuse_report_id, created_by, created_by_email)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           returning id`,
          [
            chainId,
            coin.campaignAddress,
            coin.tokenAddress,
            coin.name,
            coin.symbol,
            kind,
            mode,
            reason,
            abuseReportId,
            isUuid(actor.id) ? actor.id : null,
            actor.email || null,
          ],
        );
        const id = String(inserted.rows[0].id);
        const sideEffects = await applyBlockSideEffects(client, coin);
        const { rows } = await client.query(
          `update public.blocked_coins set side_effects = $2::jsonb where id = $1
           returning id, chain_id, campaign_address, token_address, name, symbol, kind, mode, reason, abuse_report_id,
                     created_by, created_by_email, created_at, released_at, released_by, released_by_email, release_reason, side_effects`,
          [id, JSON.stringify(sideEffects)],
        );
        await auditInTx(client, {
          eventType: "COIN_BLOCKED",
          actorId: actor.id,
          actorEmail: actor.email,
          subjectId: `blocked_coin:${id}`,
          newValue: `${kind}:${mode}`,
          metadata: {
            chainId,
            campaignAddress: coin.campaignAddress,
            tokenAddress: coin.tokenAddress,
            reason,
            abuseReportId,
            hiddenPosts: sideEffects.socialPostIds.length,
            readNotifications: sideEffects.notificationIds.length,
          },
        });
        return rows[0];
      });
    } catch (error) {
      if (error?.code === "23505") {
        const raced =
          (coin.campaignAddress ? await findActiveBlock(db, chainId, coin.campaignAddress) : null) ||
          (coin.tokenAddress ? await findActiveBlock(db, chainId, coin.tokenAddress) : null);
        return bad(res, 409, "This coin already has an active block.", "COIN_ALREADY_BLOCKED", { activeBlock: mapBlockedCoin(raced) });
      }
      if (error?.code === "23503") return bad(res, 400, "abuseReportId does not match a report.", "BLOCKED_COINS_BAD_REPORT");
      throw error;
    }
    clearBlockedCoinCache();
    return res.status(200).json({ ok: true, coin: mapBlockedCoin(row) });
  }

  async function release(req, res, actor, idParam) {
    const id = String(idParam || "").trim();
    if (!/^\d{1,18}$/.test(id)) return bad(res, 400, "Unknown block id.", "BLOCKED_COINS_BAD_ID");
    const body = await readJson(req);
    const reason = cleanReason(body.reason);
    if (!reason) return bad(res, 400, `reason is required (${REASON_MIN} to ${REASON_MAX} characters).`, "BLOCKED_COINS_BAD_REASON");
    if (!(await probeBlockedCoinsTable(db))) return schemaMissing(res);

    const outcome = await inTransaction(db, async (client) => {
      const { rows } = await client.query(
        `select id, chain_id, campaign_address, token_address, kind, mode, released_at, side_effects
           from public.blocked_coins where id = $1 for update`,
        [id],
      );
      const current = rows[0];
      if (!current) return { status: 404 };
      if (current.released_at) return { status: 409 };
      const undone = await undoBlockSideEffects(client, current.side_effects);
      const sideEffects = { ...(current.side_effects || {}), restoredPostIds: undone.restoredPostIds };
      const updated = await client.query(
        `update public.blocked_coins
            set released_at = now(), released_by = $2, released_by_email = $3, release_reason = $4, side_effects = $5::jsonb
          where id = $1 and released_at is null
          returning id, chain_id, campaign_address, token_address, name, symbol, kind, mode, reason, abuse_report_id,
                    created_by, created_by_email, created_at, released_at, released_by, released_by_email, release_reason, side_effects`,
        [id, isUuid(actor.id) ? actor.id : null, actor.email || null, reason, JSON.stringify(sideEffects)],
      );
      await auditInTx(client, {
        eventType: "COIN_BLOCK_RELEASED",
        actorId: actor.id,
        actorEmail: actor.email,
        subjectId: `blocked_coin:${id}`,
        oldValue: `${current.kind}:${current.mode}`,
        newValue: "released",
        metadata: {
          chainId: Number(current.chain_id),
          campaignAddress: current.campaign_address,
          tokenAddress: current.token_address,
          reason,
          restoredPosts: undone.restoredPostIds.length,
        },
      });
      return { status: 200, row: updated.rows[0] };
    });

    if (outcome.status === 404) return bad(res, 404, "Block not found.", "BLOCKED_COINS_NOT_FOUND");
    if (outcome.status === 409) return bad(res, 409, "This block is already released.", "BLOCKED_COINS_ALREADY_RELEASED");
    clearBlockedCoinCache();
    return res.status(200).json({ ok: true, coin: mapBlockedCoin(outcome.row) });
  }

  return async function blockedCoins(req, res) {
    const method = String(req.method || "").toUpperCase();
    const route = routeOf(req);
    const needs =
      route.name === "release"
        ? ABUSE_PERMISSIONS.ADMIN
        : route.name === "root" && method === "POST"
          ? ABUSE_PERMISSIONS.MANAGE
          : ABUSE_PERMISSIONS.VIEW;
    const actor = await auth.requireAbusePermission(req, res, needs);
    if (!actor) return;

    try {
      if (route.name === "lookup") {
        if (method !== "GET") return bad(res, 405, "Method not allowed");
        return await lookup(req, res);
      }
      if (route.name === "release") {
        if (method !== "POST") return bad(res, 405, "Method not allowed");
        return await release(req, res, actor, route.id);
      }
      if (route.name === "root") {
        if (method === "GET") return await list(req, res);
        if (method === "POST") return await block(req, res, actor);
        return bad(res, 405, "Method not allowed");
      }
      return bad(res, 404, "Not found", "BLOCKED_COINS_UNKNOWN_ROUTE");
    } catch (error) {
      if (error?.code === "42P01") return schemaMissing(res);
      console.error("[abuse/blocked-coins]", error?.message || error);
      return bad(res, 503, "Blocked coins are unavailable.", "BLOCKED_COINS_UNAVAILABLE");
    }
  };
}

export default createBlockedCoinsHandlers;
