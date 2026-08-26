import { randomBytes } from "crypto";

import { pool } from "../server/db.js";
import { badMethod, getQuery, json, normalizeWalletFlexible, readJson } from "../server/http.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";
import { requireAdminOrOps } from "./lib/apiAuth.js";

function mapPublic(row, entryCount = 0) {
  const status = String(row.status || "upcoming");
  return {
    id: String(row.id),
    type: "tournament",
    title: String(row.name),
    status: status === "upcoming" ? "scheduled" : status === "finished" ? "completed" : status,
    startsAt: row.starts_at ? new Date(row.starts_at).toISOString() : new Date().toISOString(),
    endsAt: row.ends_at ? new Date(row.ends_at).toISOString() : new Date(Date.now() + 86400000).toISOString(),
    participantCount: Number(entryCount || 0),
    summary: String(row.terms || "").slice(0, 280),
    buyInNative: Number(row.buy_in_native || 0),
    nativeSymbol: String(row.native_symbol || "BNB"),
    cap: Number(row.cap || 16),
    registrationMode: String(row.registration_mode || "open"),
    origin: String(row.origin || "custom"),
    chainId: Number(row.chain_id),
  };
}

async function entryCount(id) {
  const result = await pool.query(`select count(*)::int as count from public.arena_tournament_entries where tournament_id = $1`, [id]);
  return Number(result.rows[0]?.count || 0);
}

async function handleList(_req, res) {
  const result = await pool.query(`select * from public.arena_tournaments where status <> 'cancelled' order by starts_at asc`);
  const events = [];
  const archivedEvents = [];
  for (const row of result.rows) {
    const count = await entryCount(row.id);
    const mapped = mapPublic(row, count);
    if (row.status === "finished") archivedEvents.push({ ...mapped, completedAt: mapped.endsAt });
    else events.push(mapped);
  }
  return json(res, 200, { events, archivedEvents, updatedAt: new Date().toISOString() });
}

async function handleDetail(req, res, id) {
  const result = await pool.query(`select * from public.arena_tournaments where id = $1 limit 1`, [id]);
  if (!result.rows[0]) return json(res, 404, { error: "Tournament not found" });
  const count = await entryCount(id);
  return json(res, 200, { event: mapPublic(result.rows[0], count), tournament: result.rows[0] });
}

async function handleOptIn(req, res, id) {
  const body = await readJson(req);
  const row = (await pool.query(`select * from public.arena_tournaments where id = $1 limit 1`, [id])).rows[0];
  if (!row) return json(res, 404, { ok: false, error: "Tournament not found" });
  if (row.status !== "upcoming") return json(res, 409, { ok: false, error: "Registration is closed" });
  const token = String(body.tokenId || body.tokenAddress || "").trim();
  const wallet = normalizeWalletFlexible(body.walletAddress || body.auth?.walletAddress || "");
  if (!token || !wallet) return json(res, 400, { ok: false, error: "tokenId and wallet are required" });
  const verified = await requireWalletActionAuth({
    res,
    pool,
    auth: body.auth || body,
    expectedWallet: wallet,
    chainId: Number(row.chain_id),
    action: "arena_tournament_opt_in",
    routeLabel: "arena/tournaments/opt-in",
    extraLines: [`Tournament: ${id}`, `Token: ${token}`],
  });
  if (!verified) return;
  const count = await entryCount(id);
  if (count >= Number(row.cap || 16)) return json(res, 409, { ok: false, error: "Tournament is full" });
  await pool.query(
    `insert into public.arena_tournament_entries (tournament_id, token_address, owner_wallet, buy_in_intent)
     values ($1,$2,$3,true)
     on conflict (tournament_id, token_address) do update set buy_in_intent = true, updated_at = now()`,
    [id, token, wallet],
  );
  return json(res, 200, { ok: true, event: mapPublic(row, count + 1) });
}

async function handleAdminCreate(req, res) {
  const admin = await requireAdminOrOps(req, res, { routeLabel: "admin/arena/tournaments", allowOps: true });
  if (!admin) return;
  const body = await readJson(req);
  const name = String(body.name || "").trim();
  const chainId = Number(body.chainId || 56);
  const startsAt = body.startsAt || body.starts_at;
  if (!name || !startsAt) return json(res, 400, { error: "name and startsAt are required" });
  const id = `tourney-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const inserted = await pool.query(
    `insert into public.arena_tournaments (
        id, chain_id, name, status, origin, registration_mode, buy_in_native, native_symbol, terms, starts_at, ends_at, cap, created_by
      ) values ($1,$2,$3,'upcoming',$4,$5,$6,$7,$8,$9,$10,$11,$12)
      returning *`,
    [
      id,
      chainId,
      name,
      body.origin === "quarter_finals" ? "quarter_finals" : "custom",
      ["invite_only", "open", "invite_plus_open"].includes(body.registrationMode) ? body.registrationMode : "open",
      Number(body.buyInNative || 0),
      String(body.nativeSymbol || (chainId === 101 ? "SOL" : "BNB")),
      String(body.terms || ""),
      new Date(startsAt).toISOString(),
      body.endsAt ? new Date(body.endsAt).toISOString() : null,
      Math.max(2, Number(body.cap || 16)),
      String(admin.mode || "ops"),
    ],
  );
  const invites = Array.isArray(body.invites) ? body.invites : [];
  for (const invite of invites) {
    const token = String(invite.tokenAddress || invite || "").trim();
    if (!token) continue;
    await pool.query(
      `insert into public.arena_tournament_invites (tournament_id, token_address, owner_wallet)
       values ($1,$2,$3)
       on conflict (tournament_id, token_address) do nothing`,
      [id, token, invite.ownerWallet || null],
    );
  }
  return json(res, 200, { ok: true, item: inserted.rows[0] });
}

export default async function handler(req, res) {
  const method = String(req.method || "GET").toUpperCase();
  const path = String(req.path || new URL(req.url, "http://localhost").pathname);
  try {
    if (path.startsWith("/admin/arena/tournaments") || path.startsWith("/api/admin/arena/tournaments")) {
      if (method === "POST" && /\/admin\/arena\/tournaments$/.test(path)) return handleAdminCreate(req, res);
      if (method === "GET") return handleList(req, res);
      return json(res, 404, { error: "Unknown admin tournament route" });
    }
    if (method === "GET" && path === "/arena/tournaments") return handleList(req, res);
    const optIn = path.match(/^\/arena\/tournaments\/([^/]+)\/opt-in$/);
    if (optIn) return method === "POST" ? handleOptIn(req, res, decodeURIComponent(optIn[1])) : badMethod(res);
    const detail = path.match(/^\/arena\/tournaments\/([^/]+)$/);
    if (detail) return method === "GET" ? handleDetail(req, res, decodeURIComponent(detail[1])) : badMethod(res);
    return json(res, 404, { error: `Unknown arena tournaments route: ${path}` });
  } catch (error) {
    console.error("[api/arenaTournaments]", error);
    return json(res, 503, { ok: false, error: "Tournament storage is unavailable", detail: String(error?.message || error) });
  }
}
