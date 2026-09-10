import { randomBytes } from "crypto";

import { pool } from "../server/db.js";
import { badMethod, getQuery, json, readJson } from "../server/http.js";
import { requireAdminOrOps } from "./lib/apiAuth.js";
import { isSolanaChainId, nativeSymbolFor } from "./lib/chainNative.js";
import {
  arenaWarPoolTreasuryV2Address,
  tournamentBuyInNativeRaw,
  tournamentNativeDecimals,
  tournamentPoolIdV2,
} from "./lib/arenaTournamentBuyInV2.mjs";

function ident(value) {
  return String(value || "").trim();
}

function routePath(req) {
  return String(req.path || new URL(req.url, "http://localhost").pathname);
}

function publicQuote({ chainId, tournamentId, buyInNative }) {
  const raw = tournamentBuyInNativeRaw({ chainId, buyInNative });
  const payload = {
    tournamentId,
    poolId: tournamentPoolIdV2(tournamentId),
    chainId: Number(chainId),
    buyInNative: String(buyInNative),
    buyInNativeRaw: raw.toString(),
    nativeDecimals: tournamentNativeDecimals(chainId),
    paymentAuthority: "arena_tournaments.buy_in_native",
  };
  if (!isSolanaChainId(chainId)) payload.treasuryAddress = arenaWarPoolTreasuryV2Address(chainId);
  return payload;
}

async function handleQuote(req, res) {
  const query = getQuery(req);
  const tournamentId = ident(query.tournamentId || query.tournament_id);
  const requestedChainId = Number(query.chainId || query.chain_id || 0);
  if (!tournamentId) {
    return json(res, 400, { ok: false, error: "tournamentId is required", code: "TOURNAMENT_ID_REQUIRED" });
  }
  const tournament = (await pool.query(
    `select id, chain_id, buy_in_native, native_symbol, battle_mode, competition_generation
       from public.arena_tournaments where id=$1 limit 1`,
    [tournamentId],
  )).rows[0];
  if (!tournament) return json(res, 404, { ok: false, error: "Tournament not found", code: "TOURNAMENT_NOT_FOUND" });
  if (requestedChainId && requestedChainId !== Number(tournament.chain_id)) {
    return json(res, 404, { ok: false, error: "Tournament not found on requested chain", code: "TOURNAMENT_CHAIN_MISMATCH" });
  }
  try {
    const quote = publicQuote({
      chainId: Number(tournament.chain_id),
      tournamentId: tournament.id,
      buyInNative: tournament.buy_in_native,
    });
    res.setHeader("cache-control", "no-store");
    return json(res, 200, {
      ok: true,
      generation: String(tournament.competition_generation || "arena_competition_v2"),
      scoringVersion: "vote_tournament_v1",
      battleMode: "vote",
      roundDurationHours: 24,
      quote,
    });
  } catch (error) {
    return json(res, 503, { ok: false, error: "Vote Tournament buy-in is unavailable", code: "VOTE_TOURNAMENT_QUOTE_UNAVAILABLE", detail: String(error?.message || error) });
  }
}

async function handleCreate(req, res) {
  const admin = await requireAdminOrOps(req, res, { routeLabel: "arena/tournaments/v2/create", allowOps: true });
  if (!admin) return;
  const body = await readJson(req);
  const name = ident(body.name);
  const chainId = Number(body.chainId || body.chain_id || 56);
  const startsAt = body.startsAt || body.starts_at;
  const buyInNative = ident(body.buyInNative ?? body.buy_in_native);
  if (!name || !startsAt || !buyInNative) {
    return json(res, 400, { ok: false, error: "name, startsAt and buyInNative are required", code: "VOTE_TOURNAMENT_CREATE_INPUT_REQUIRED" });
  }

  let buyInRaw;
  let treasuryAddress = null;
  try {
    buyInRaw = tournamentBuyInNativeRaw({ chainId, buyInNative });
    if (!isSolanaChainId(chainId)) treasuryAddress = arenaWarPoolTreasuryV2Address(chainId);
  } catch (error) {
    return json(res, 400, {
      ok: false,
      error: "Tournament native buy-in or treasury authority is invalid",
      code: "VOTE_TOURNAMENT_BUY_IN_INVALID",
      detail: String(error?.message || error),
    });
  }

  const id = `vote-tourney-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const registrationMode = ["invite_only", "open", "invite_plus_open"].includes(body.registrationMode)
    ? body.registrationMode
    : "open";
  const client = await pool.connect();
  let tournament;
  try {
    await client.query("begin");
    const inserted = await client.query(
      `insert into public.arena_tournaments (
         id, chain_id, name, status, origin, registration_mode, buy_in_native, native_symbol, terms,
         starts_at, ends_at, cap, created_by, battle_mode, round_duration_hours,
         contest_scoring_version, competition_generation
       ) values ($1,$2,$3,'upcoming',$4,$5,$6,$7,$8,$9,$10,$11,$12,'vote',24,'vote_tournament_v1','arena_competition_v2')
       returning *`,
      [
        id,
        chainId,
        name,
        body.origin === "quarter_finals" ? "quarter_finals" : "custom",
        registrationMode,
        buyInNative,
        String(body.nativeSymbol || nativeSymbolFor(chainId)),
        String(body.terms || ""),
        new Date(startsAt).toISOString(),
        body.endsAt ? new Date(body.endsAt).toISOString() : null,
        Math.max(2, Number(body.cap || 16)),
        String(admin.mode || "ops"),
      ],
    );
    tournament = inserted.rows[0];

    const invites = Array.isArray(body.invites) ? body.invites : [];
    for (const invite of invites) {
      const token = ident(invite?.tokenAddress || invite);
      if (!token) continue;
      await client.query(
        `insert into public.arena_tournament_invites (tournament_id, token_address, owner_wallet)
         values ($1,$2,$3)
         on conflict (tournament_id, token_address) do nothing`,
        [id, token, ident(invite?.ownerWallet) || null],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const quote = publicQuote({ chainId, tournamentId: id, buyInNative: tournament.buy_in_native });
  const poolOpen = isSolanaChainId(chainId)
    ? {
        execution: "solana-arena-program",
        tournamentId: id,
        buyInLamports: buyInRaw.toString(),
        note: "Open the Arena tournament pool through the existing Solana Arena program/ops path before accepting registrations.",
      }
    : {
        execution: "ArenaWarPoolTreasuryV2.openTournamentPool",
        treasuryAddress,
        poolId: quote.poolId,
        buyInAmountRaw: buyInRaw.toString(),
        note: "Pool opening is an explicit authorized ops/wallet transaction; the API does not hold the creator signing key.",
      };

  return json(res, 201, {
    ok: true,
    tournament,
    generation: "arena_competition_v2",
    scoringVersion: "vote_tournament_v1",
    battleMode: "vote",
    roundDurationHours: 24,
    paymentAuthority: "arena_tournaments.buy_in_native",
    quote,
    poolOpen,
  });
}

export default async function handler(req, res) {
  const path = routePath(req);
  const method = String(req.method || "GET").toUpperCase();
  try {
    if (path === "/arena/tournaments/v2/buy-in-quote") return method === "GET" ? handleQuote(req, res) : badMethod(res);
    if (path === "/arena/tournaments/v2/create") return method === "POST" ? handleCreate(req, res) : badMethod(res);
    return json(res, 404, { ok: false, error: "Unknown V2 Vote Tournament setup route" });
  } catch (error) {
    console.error("[api/arenaVoteTournamentSetup]", error);
    return json(res, 503, { ok: false, error: "V2 Vote Tournament setup is unavailable", detail: String(error?.message || error) });
  }
}
