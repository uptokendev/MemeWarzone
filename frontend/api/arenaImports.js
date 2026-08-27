import { pool } from "../server/db.js";
import {
  badMethod,
  getQuery,
  isAddress,
  isSolanaAddress,
  isSolanaChain,
  json,
  normalizeWalletFlexible,
  readJson,
} from "../server/http.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";
import { scanEvm, scanSolana } from "./lib/arenaImportScan.js";

function ident(value, chainId) {
  const raw = String(value || "").trim();
  if (isSolanaChain(chainId) || isSolanaAddress(raw)) return raw;
  return isAddress(raw) ? raw.toLowerCase() : "";
}

function mapImport(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    chainId: Number(row.chain_id),
    tokenAddress: String(row.token_address),
    ownerWallet: String(row.owner_wallet),
    name: row.name || null,
    symbol: row.symbol || null,
    status: String(row.status),
    scan: row.scan_json && typeof row.scan_json === "object" ? row.scan_json : {},
    reviewRequestedAt: row.review_requested_at || null,
    reviewReason: row.review_reason || null,
    reviewer: row.reviewer || null,
    reviewedAt: row.reviewed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function nativeExists(chainId, token) {
  const result = await pool.query(
    `select campaign_address from public.campaigns
      where chain_id = $1 and (lower(token_address::text) = lower($2) or lower(campaign_address::text) = lower($2))
      limit 1`,
    [chainId, token],
  );
  return Boolean(result.rows[0]);
}

async function scanToken(chainId, token) {
  return isSolanaChain(chainId) ? scanSolana(token) : scanEvm(chainId, token);
}

async function findById(id) {
  const result = await pool.query(`select * from public.arena_token_imports where id = $1::uuid limit 1`, [id]);
  return result.rows[0] || null;
}

async function handleList(req, res) {
  const query = getQuery(req);
  const wallet = normalizeWalletFlexible(query.wallet || query.owner || "");
  const chainId = Number(query.chainId);
  const values = [];
  const where = [];
  if (wallet) {
    values.push(wallet);
    where.push(`lower(owner_wallet) = lower($${values.length})`);
  }
  if (Number.isFinite(chainId) && chainId > 0) {
    values.push(chainId);
    where.push(`chain_id = $${values.length}`);
  }
  const sql = `select * from public.arena_token_imports ${where.length ? `where ${where.join(" and ")}` : ""} order by created_at desc limit 100`;
  const result = await pool.query(sql, values);
  return json(res, 200, { items: result.rows.map(mapImport), updatedAt: new Date().toISOString() });
}

async function handleLookup(req, res) {
  const query = getQuery(req);
  const requestedChain = Number(query.chainId || 0);
  const tokenHint = String(query.token || query.tokenAddress || query.address || "").trim();
  const token = ident(tokenHint, requestedChain || (isSolanaAddress(tokenHint) ? 101 : 56));
  if (!token) return json(res, 400, { error: "token is required" });
  const params = [token];
  let sql = `select * from public.arena_token_imports where lower(token_address) = lower($1)`;
  if (Number.isFinite(requestedChain) && requestedChain > 0) {
    params.push(requestedChain);
    sql += ` and chain_id = $2`;
  }
  sql += ` order by case when status = 'passed' then 0 else 1 end, created_at desc limit 1`;
  const result = await pool.query(sql, params);
  const item = mapImport(result.rows[0]);
  return item ? json(res, 200, { item }) : json(res, 404, { error: "Import not found" });
}

async function handleCreate(req, res) {
  const body = await readJson(req);
  const chainId = Number(body.chainId || 56);
  const token = ident(body.tokenAddress || body.tokenId || body.token, chainId);
  const owner = normalizeWalletFlexible(body.walletAddress || body.auth?.walletAddress || body.auth?.address || "");
  if (!token) return json(res, 400, { ok: false, error: "tokenAddress is required" });
  if (!owner) return json(res, 400, { ok: false, error: "wallet is required" });

  const verified = await requireWalletActionAuth({
    res,
    pool,
    auth: body.auth || body,
    expectedWallet: owner,
    chainId,
    action: "arena_import_token",
    routeLabel: "arena/imports",
    extraLines: [`Token: ${token}`],
  });
  if (!verified) return;

  if (await nativeExists(chainId, token)) {
    return json(res, 409, { ok: false, error: "This token already launched on MemeWarzone.", reason: "already_native" });
  }

  const existing = await pool.query(
    `select * from public.arena_token_imports where chain_id = $1 and lower(token_address) = lower($2) limit 1`,
    [chainId, token],
  );
  if (existing.rows[0]) {
    return json(res, 200, { ok: true, item: mapImport(existing.rows[0]), existing: true });
  }

  const scan = await scanToken(chainId, token);
  const inserted = await pool.query(
    `insert into public.arena_token_imports (chain_id, token_address, owner_wallet, name, symbol, status, scan_json)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb)
     returning *`,
    [chainId, token, owner, scan.name, scan.symbol, scan.status, JSON.stringify(scan.scan || {})],
  );
  return json(res, 200, { ok: true, item: mapImport(inserted.rows[0]) });
}

async function handleRequestReview(req, res, id) {
  const body = await readJson(req);
  const row = await findById(id);
  if (!row) return json(res, 404, { ok: false, error: "Import not found" });
  const owner = normalizeWalletFlexible(row.owner_wallet);
  const verified = await requireWalletActionAuth({
    res,
    pool,
    auth: body.auth || body,
    expectedWallet: owner,
    chainId: Number(row.chain_id),
    action: "arena_import_request_review",
    routeLabel: "arena/imports/request-review",
    extraLines: [`Import: ${id}`],
  });
  if (!verified) return;
  if (row.status !== "declined" && row.status !== "needs_review") {
    return json(res, 409, { ok: false, error: "Only declined or review-needed imports can request manual review." });
  }
  const updated = await pool.query(
    `update public.arena_token_imports
        set review_requested_at = now(), review_reason = coalesce($2, review_reason), updated_at = now()
      where id = $1::uuid
      returning *`,
    [id, String(body.reason || "").trim().slice(0, 500) || null],
  );
  return json(res, 200, { ok: true, item: mapImport(updated.rows[0]) });
}

export default async function handler(req, res) {
  const method = String(req.method || "GET").toUpperCase();
  const path = String(req.path || new URL(req.url, "http://localhost").pathname);
  try {
    if (method === "GET" && path === "/arena/imports") return handleList(req, res);
    if (method === "GET" && path === "/arena/imports/lookup") return handleLookup(req, res);
    if (method === "POST" && path === "/arena/imports") return handleCreate(req, res);
    const review = path.match(/^\/arena\/imports\/([^/]+)\/request-review$/);
    if (review) return method === "POST" ? handleRequestReview(req, res, decodeURIComponent(review[1])) : badMethod(res);
    return json(res, 404, { error: `Unknown arena imports route: ${path}` });
  } catch (error) {
    console.error("[api/arenaImports]", error);
    return json(res, 503, { ok: false, error: "Import storage is unavailable", detail: String(error?.message || error) });
  }
}
