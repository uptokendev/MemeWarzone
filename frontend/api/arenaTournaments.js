import { randomBytes } from "crypto";

import { pool } from "../server/db.js";
import { badMethod, json, normalizeWalletFlexible, readJson } from "../server/http.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";
import { requireAdminOrOps } from "./lib/apiAuth.js";
import { tokenEligible as tokenIsEligible } from "./lib/arenaEligibility.js";
import { isSolanaChainId, nativeSymbolFor } from "./lib/chainNative.js";
import { readAuthoritativeBuyInReceipt, readSolanaArenaPool } from "./lib/solanaArenaPoolRead.js";

function ident(value) {
  return normalizeWalletFlexible(value) || String(value || "").trim();
}

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
    nativeSymbol: String(row.native_symbol || nativeSymbolFor(row.chain_id)),
    cap: Number(row.cap || 16),
    registrationMode: String(row.registration_mode || "open"),
    origin: String(row.origin || "custom"),
    chainId: Number(row.chain_id),
    bracket: row.bracket || [],
    winnerToken: row.winner_token || null,
  };
}

function mapAdmin(row, entryCount = 0) {
  return {
    ...mapPublic(row, entryCount),
    terms: String(row.terms || ""),
    createdBy: row.created_by || null,
    createdAt: row.created_at,
  };
}

async function entryCount(id) {
  const result = await pool.query(`select count(*)::int as count from public.arena_tournament_entries where tournament_id = $1`, [id]);
  return Number(result.rows[0]?.count || 0);
}

async function listEntries(id) {
  const result = await pool.query(
    `select token_address, owner_wallet, buy_in_intent, buy_in_paid, created_at
       from public.arena_tournament_entries where tournament_id = $1 order by created_at asc`,
    [id],
  );
  return result.rows.map((row) => ({
    tokenAddress: String(row.token_address),
    ownerWallet: String(row.owner_wallet),
    buyInIntent: Boolean(row.buy_in_intent),
    buyInPaid: Boolean(row.buy_in_paid),
  }));
}

async function listInvites(id) {
  const result = await pool.query(
    `select token_address, owner_wallet, status from public.arena_tournament_invites where tournament_id = $1`,
    [id],
  );
  return result.rows.map((row) => ({
    tokenAddress: String(row.token_address),
    ownerWallet: row.owner_wallet || null,
    status: String(row.status || "pending"),
  }));
}

async function tokenEligible(chainId, token) {
  return tokenIsEligible(pool, chainId, token);
}

async function coinSnapshot(chainId, token) {
  const address = ident(token);
  const native = await pool.query(
    `select name, symbol, token_address, campaign_address, creator_address, ts.marketcap_bnb
       from public.campaigns c
       left join public.token_stats ts on ts.chain_id = c.chain_id and ts.campaign_address = c.campaign_address
      where c.chain_id = $1
        and (lower(coalesce(c.token_address::text, '')) = lower($2) or lower(c.campaign_address::text) = lower($2))
      limit 1`,
    [chainId, address],
  );
  if (native.rows[0]) {
    const row = native.rows[0];
    return {
      tokenId: ident(row.token_address || row.campaign_address),
      tokenAddress: ident(row.token_address || row.campaign_address),
      campaignAddress: ident(row.campaign_address) || "",
      tokenName: String(row.name || row.symbol || "Unknown"),
      symbol: String(row.symbol || "---"),
      ownerWallet: ident(row.creator_address),
      marketCapUsd: Number(row.marketcap_bnb || 0),
    };
  }
  const imported = await pool.query(
    `select name, symbol, token_address, owner_wallet from public.arena_token_imports
      where chain_id = $1 and lower(token_address) = lower($2) limit 1`,
    [chainId, address],
  );
  const row = imported.rows[0];
  if (!row) {
    return {
      tokenId: address,
      tokenAddress: address,
      campaignAddress: "",
      tokenName: address.slice(0, 8),
      symbol: "TBD",
      ownerWallet: "",
      marketCapUsd: 0,
    };
  }
  return {
    tokenId: ident(row.token_address),
    tokenAddress: ident(row.token_address),
    campaignAddress: "",
    tokenName: String(row.name || row.symbol || "Unknown"),
    symbol: String(row.symbol || "---"),
    ownerWallet: ident(row.owner_wallet),
    marketCapUsd: 0,
  };
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
  const row = result.rows[0];
  const entries = await listEntries(id);
  return json(res, 200, {
    event: mapPublic(row, entries.length),
    tournament: row,
    entries,
    invites: await listInvites(id),
    bracket: row.bracket || [],
  });
}

async function handleOptIn(req, res, id) {
  const body = await readJson(req);
  const row = (await pool.query(`select * from public.arena_tournaments where id = $1 limit 1`, [id])).rows[0];
  if (!row) return json(res, 404, { ok: false, error: "Tournament not found" });
  if (row.status !== "upcoming") return json(res, 409, { ok: false, error: "Registration is closed" });
  const token = ident(body.tokenId || body.tokenAddress || "");
  const wallet = ident(body.walletAddress || body.auth?.walletAddress || "");
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
  if (!(await tokenEligible(row.chain_id, token))) {
    return json(res, 409, { ok: false, error: "Token is not an Arena-eligible graduated or approved-import coin" });
  }
  if (row.registration_mode === "invite_only") {
    const invite = await pool.query(
      `select 1 from public.arena_tournament_invites
        where tournament_id = $1 and lower(token_address) = lower($2) limit 1`,
      [id, token],
    );
    if (!invite.rows[0]) return json(res, 403, { ok: false, error: "This tournament is invite-only" });
  }
  const count = await entryCount(id);
  if (count >= Number(row.cap || 16)) return json(res, 409, { ok: false, error: "Tournament is full" });
  await pool.query(
    `insert into public.arena_tournament_entries (tournament_id, token_address, owner_wallet, buy_in_intent)
     values ($1,$2,$3,true)
     on conflict (tournament_id, token_address) do update set buy_in_intent = true, owner_wallet = excluded.owner_wallet, updated_at = now()`,
    [id, token, wallet],
  );
  if (row.registration_mode !== "open") {
    await pool.query(
      `update public.arena_tournament_invites set status = 'accepted', updated_at = now()
        where tournament_id = $1 and lower(token_address) = lower($2)`,
      [id, token],
    );
  }
  return json(res, 200, { ok: true, event: mapPublic(row, count + 1) });
}

async function handleBuyInReceipt(req, res, id) {
  const body = await readJson(req);
  const row = (await pool.query(`select * from public.arena_tournaments where id = $1 limit 1`, [id])).rows[0];
  if (!row) return json(res, 404, { ok: false, error: "Tournament not found" });
  const chainId = Number(row.chain_id);
  if (!isSolanaChainId(chainId)) return json(res, 400, { ok: false, error: "On-chain buy-in is Solana-only in this cut." });
  const token = ident(body.tokenAddress || body.tokenId || "", chainId);
  const wallet = ident(body.walletAddress || body.auth?.walletAddress || "", chainId);
  const txHash = String(body.txHash || "").trim();
  if (!token || !wallet || !txHash) return json(res, 400, { ok: false, error: "tokenAddress, walletAddress and txHash are required" });
  const verified = await requireWalletActionAuth({
    res,
    pool,
    auth: body.auth || body,
    expectedWallet: wallet,
    chainId,
    action: "arena_tournament_buy_in",
    routeLabel: "arena/tournaments/buy-in-receipt",
    extraLines: [`Tournament: ${id}`, `Token: ${token}`, `Tx: ${txHash}`],
  });
  if (!verified) return;
  const onchain = await readSolanaArenaPool(chainId, id, "tournament");
  if (!onchain.configured || !onchain.live || !onchain.opened) {
    return json(res, 503, { ok: false, error: "Tournament escrow is not open yet.", code: "WAR_POOL_NOT_OPEN" });
  }
  const receipt = await readAuthoritativeBuyInReceipt(
    chainId,
    onchain.poolId,
    token,
    wallet,
    onchain.buyInLamports || "0",
  );
  if (!receipt.ok) {
    return json(res, 409, {
      ok: false,
      error: "Buy-in receipt PDA is not an authoritative paid registration.",
      code: "BUY_IN_RECEIPT_INVALID",
      reason: receipt.reason,
    });
  }
  await pool.query(
    `update public.arena_tournament_entries
        set buy_in_paid = true, updated_at = now()
      where tournament_id = $1 and token_address = $2 and owner_wallet = $3`,
    [id, token, wallet],
  );
  return json(res, 200, { ok: true, buyInPaid: true, receipt: receipt.pda });
}

async function handleAdminList(_req, res) {
  const result = await pool.query(`select * from public.arena_tournaments order by created_at desc`);
  const items = [];
  for (const row of result.rows) {
    items.push(mapAdmin(row, await entryCount(row.id)));
  }
  return json(res, 200, { items, updatedAt: new Date().toISOString() });
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
      String(body.nativeSymbol || nativeSymbolFor(chainId)),
      String(body.terms || ""),
      new Date(startsAt).toISOString(),
      body.endsAt ? new Date(body.endsAt).toISOString() : null,
      Math.max(2, Number(body.cap || 16)),
      String(admin.mode || "ops"),
    ],
  );
  const invites = Array.isArray(body.invites) ? body.invites : [];
  for (const invite of invites) {
    const token = ident(invite.tokenAddress || invite);
    if (!token) continue;
    await pool.query(
      `insert into public.arena_tournament_invites (tournament_id, token_address, owner_wallet)
       values ($1,$2,$3)
       on conflict (tournament_id, token_address) do nothing`,
      [id, token, ident(invite.ownerWallet) || null],
    );
  }
  return json(res, 200, { ok: true, item: inserted.rows[0] });
}

async function insertTournamentBattle({ chainId, tournamentId, left, right, nativeSymbol }) {
  const id = `arena-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const leftSnap = await coinSnapshot(chainId, left);
  const rightSnap = await coinSnapshot(chainId, right);
  const participants = [
    { ...leftSnap, score: leftSnap.marketCapUsd, priceChangePct: 0, volumeUsd: 0, uniqueTraders: 0, holderCount: 0, holdersDelta: 0 },
    { ...rightSnap, score: rightSnap.marketCapUsd, priceChangePct: 0, volumeUsd: 0, uniqueTraders: 0, holderCount: 0, holdersDelta: 0 },
  ];
  await pool.query(
    `insert into public.arena_battles (
        id, chain_id, state, source, stake_native, native_symbol, challenger_token, defender_token, tournament_id,
        participants, challenger_start_mcap_usd, defender_start_mcap_usd, started_at, ends_at, creator_address
      ) values ($1,$2,'live','tournament',0,$3,$4,$5,$6,$7::jsonb,$8,$9,now(), now() + interval '12 hours', $10)`,
    [
      id,
      chainId,
      nativeSymbol,
      leftSnap.tokenAddress,
      rightSnap.tokenAddress,
      tournamentId,
      JSON.stringify(participants),
      leftSnap.marketCapUsd,
      rightSnap.marketCapUsd,
      leftSnap.ownerWallet || null,
    ],
  );
  return id;
}

async function handleAdminStart(req, res, id) {
  const admin = await requireAdminOrOps(req, res, { routeLabel: "admin/arena/tournaments/start", allowOps: true });
  if (!admin) return;
  const row = (await pool.query(`select * from public.arena_tournaments where id = $1 limit 1`, [id])).rows[0];
  if (!row) return json(res, 404, { error: "Tournament not found" });
  if (row.status !== "upcoming") return json(res, 409, { error: "Tournament is not upcoming" });
  const entries = await listEntries(id);
  if (entries.length < 2) return json(res, 409, { error: "Need at least 2 opted-in coins to start" });
  const matches = [];
  for (let i = 0; i < entries.length; i += 2) {
    const a = entries[i];
    const b = entries[i + 1];
    if (!b) {
      matches.push({ id: `m${i / 2 + 1}`, tokenA: a.tokenAddress, tokenB: null, battleId: null, winner: a.tokenAddress, bye: true });
      continue;
    }
    const battleId = await insertTournamentBattle({
      chainId: row.chain_id,
      tournamentId: id,
      left: a.tokenAddress,
      right: b.tokenAddress,
      nativeSymbol: row.native_symbol || nativeSymbolFor(row.chain_id),
    });
    matches.push({ id: `m${i / 2 + 1}`, tokenA: a.tokenAddress, tokenB: b.tokenAddress, battleId, winner: null, bye: false });
  }
  const bracket = { rounds: [{ round: 1, matches }] };
  await pool.query(
    `update public.arena_tournaments set status = 'live', bracket = $2::jsonb, updated_at = now() where id = $1`,
    [id, JSON.stringify(bracket)],
  );
  return json(res, 200, { ok: true, item: mapAdmin({ ...row, status: "live", bracket }, entries.length), bracket });
}

export async function advanceTournamentFromBattle(row) {
  const tournamentId = row?.tournament_id;
  const winner = ident(row?.winner_token);
  if (!tournamentId || !winner) return null;
  const result = await pool.query(`select * from public.arena_tournaments where id = $1 limit 1`, [tournamentId]);
  const tournament = result.rows[0];
  if (!tournament || tournament.status !== "live") return null;
  const bracket = tournament.bracket && typeof tournament.bracket === "object" ? tournament.bracket : { rounds: [] };
  const rounds = Array.isArray(bracket.rounds) ? bracket.rounds : [];
  let found = false;
  for (const round of rounds) {
    for (const match of round.matches || []) {
      if (String(match.battleId || "") === String(row.id)) {
        match.winner = winner;
        found = true;
      }
    }
  }
  if (!found) return null;
  const last = rounds[rounds.length - 1];
  const matches = last?.matches || [];
  const winners = matches.map((match) => ident(match.winner)).filter(Boolean);
  if (winners.length === matches.length && matches.length > 0) {
    if (winners.length === 1) {
      await pool.query(
        `update public.arena_tournaments
            set status = 'finished', ends_at = now(), winner_token = $3, bracket = $2::jsonb, updated_at = now()
          where id = $1`,
        [tournamentId, JSON.stringify({ rounds }), winners[0]],
      );
      try {
        await pool.query(
          `update public.arena_war_pools set state = 'locked', updated_at = now() where battle_id = $1 and state = 'open'`,
          [tournamentId],
        );
      } catch (error) {
        console.warn("[api/arenaTournaments] lock support pool failed", error?.message || error);
      }
      return { finished: true, winner: winners[0] };
    }
    const nextMatches = [];
    for (let i = 0; i < winners.length; i += 2) {
      const a = winners[i];
      const b = winners[i + 1];
      if (!b) {
        nextMatches.push({
          id: `r${(last.round || 1) + 1}-m${nextMatches.length + 1}`,
          tokenA: a,
          tokenB: null,
          battleId: null,
          winner: a,
          bye: true,
        });
        continue;
      }
      const battleId = await insertTournamentBattle({
        chainId: tournament.chain_id,
        tournamentId,
        left: a,
        right: b,
        nativeSymbol: tournament.native_symbol || nativeSymbolFor(tournament.chain_id),
      });
      nextMatches.push({
        id: `r${(last.round || 1) + 1}-m${nextMatches.length + 1}`,
        tokenA: a,
        tokenB: b,
        battleId,
        winner: null,
        bye: false,
      });
    }
    rounds.push({ round: (last.round || 1) + 1, matches: nextMatches });
    const nextWinners = nextMatches.map((match) => ident(match.winner)).filter(Boolean);
    if (nextWinners.length === nextMatches.length && nextWinners.length === 1) {
      await pool.query(
        `update public.arena_tournaments
            set status = 'finished', ends_at = now(), winner_token = $3, bracket = $2::jsonb, updated_at = now()
          where id = $1`,
        [tournamentId, JSON.stringify({ rounds }), nextWinners[0]],
      );
      try {
        await pool.query(
          `update public.arena_war_pools set state = 'locked', updated_at = now() where battle_id = $1 and state = 'open'`,
          [tournamentId],
        );
      } catch (error) {
        console.warn("[api/arenaTournaments] lock support pool failed", error?.message || error);
      }
      return { finished: true, winner: nextWinners[0] };
    }
  }
  await pool.query(
    `update public.arena_tournaments set bracket = $2::jsonb, updated_at = now() where id = $1`,
    [tournamentId, JSON.stringify({ rounds })],
  );
  return { finished: false };
}

export default async function handler(req, res) {
  const method = String(req.method || "GET").toUpperCase();
  const path = String(req.path || new URL(req.url, "http://localhost").pathname);
  try {
    if (path.startsWith("/admin/arena/tournaments") || path.startsWith("/api/admin/arena/tournaments")) {
      const start = path.match(/\/admin\/arena\/tournaments\/([^/]+)\/start$/);
      if (start) return method === "POST" ? handleAdminStart(req, res, decodeURIComponent(start[1])) : badMethod(res);
      if (method === "POST" && /\/admin\/arena\/tournaments$/.test(path)) return handleAdminCreate(req, res);
      if (method === "GET") return handleAdminList(req, res);
      return json(res, 404, { error: "Unknown admin tournament route" });
    }
    if (method === "GET" && path === "/arena/tournaments") return handleList(req, res);
    const optIn = path.match(/^\/arena\/tournaments\/([^/]+)\/opt-in$/);
    if (optIn) return method === "POST" ? handleOptIn(req, res, decodeURIComponent(optIn[1])) : badMethod(res);
    const buyIn = path.match(/^\/arena\/tournaments\/([^/]+)\/buy-in-receipt$/);
    if (buyIn) return method === "POST" ? handleBuyInReceipt(req, res, decodeURIComponent(buyIn[1])) : badMethod(res);
    const detail = path.match(/^\/arena\/tournaments\/([^/]+)$/);
    if (detail) return method === "GET" ? handleDetail(req, res, decodeURIComponent(detail[1])) : badMethod(res);
    return json(res, 404, { error: `Unknown arena tournaments route: ${path}` });
  } catch (error) {
    console.error("[api/arenaTournaments]", error);
    return json(res, 503, { ok: false, error: "Tournament storage is unavailable", detail: String(error?.message || error) });
  }
}
