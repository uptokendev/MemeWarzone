import { randomBytes } from "crypto";
import { parseUnits } from "ethers";

import { pool } from "../server/db.js";
import { badMethod, getQuery, json, normalizeAddress, readJson } from "../server/http.js";
import { requireAdminOrOps } from "./lib/apiAuth.js";
import { getServerReadProvider } from "./lib/getServerReadProvider.js";
import { isSolanaChainId, nativeSymbolFor } from "./lib/chainNative.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";
import { readAuthoritativeBuyInReceipt, readSolanaArenaPool } from "./lib/solanaArenaPoolRead.js";
import {
  arenaWarPoolTreasuryV2Address,
  readTournamentBuyInPricing,
  tournamentNativeDecimals,
  tournamentPoolIdV2,
  verifyEvmTournamentBuyInV2,
} from "./lib/arenaTournamentBuyInV2.mjs";

function ident(value) {
  return String(value || "").trim();
}

function routePath(req) {
  return String(req.path || new URL(req.url, "http://localhost").pathname);
}

function publicQuote(pricing, chainId, tournamentId = null) {
  const base = {
    chainId: Number(chainId),
    buyInUsd: "0.25",
    buyInUsdMicros: pricing.usdMicros.toString(),
    buyInNative: pricing.buyInNative,
    buyInNativeRaw: pricing.buyInNativeRaw.toString(),
    nativeDecimals: pricing.nativeDecimals,
    pricingVersion: pricing.pricingVersion.toString(),
    oracleTimestamp: pricing.oracleTimestamp.toString(),
  };
  if (!tournamentId) return base;
  return { ...base, tournamentId, poolId: tournamentPoolIdV2(tournamentId) };
}

async function handleQuote(req, res) {
  const query = getQuery(req);
  const chainId = Number(query.chainId || query.chain_id || 56);
  try {
    const pricing = readTournamentBuyInPricing(chainId);
    const payload = publicQuote(pricing, chainId);
    if (!isSolanaChainId(chainId)) payload.treasuryAddress = arenaWarPoolTreasuryV2Address(chainId);
    res.setHeader("cache-control", "no-store");
    return json(res, 200, {
      ok: true,
      generation: "arena_competition_v2",
      scoringVersion: "vote_tournament_v1",
      battleMode: "vote",
      roundDurationHours: 24,
      quote: payload,
    });
  } catch (error) {
    return json(res, 503, {
      ok: false,
      error: "Vote Tournament buy-in quote is unavailable",
      code: "VOTE_TOURNAMENT_QUOTE_UNAVAILABLE",
      detail: String(error?.message || error),
    });
  }
}

async function handleCreate(req, res) {
  const admin = await requireAdminOrOps(req, res, { routeLabel: "arena/tournaments/v2/create", allowOps: true });
  if (!admin) return;
  const body = await readJson(req);
  const name = ident(body.name);
  const chainId = Number(body.chainId || body.chain_id || 56);
  const startsAt = body.startsAt || body.starts_at;
  if (!name || !startsAt) {
    return json(res, 400, { ok: false, error: "name and startsAt are required", code: "VOTE_TOURNAMENT_CREATE_INPUT_REQUIRED" });
  }

  let pricing;
  try {
    pricing = readTournamentBuyInPricing(chainId);
  } catch (error) {
    return json(res, 503, {
      ok: false,
      error: "Founder-locked $0.25 buy-in pricing is unavailable",
      code: "VOTE_TOURNAMENT_QUOTE_UNAVAILABLE",
      detail: String(error?.message || error),
    });
  }

  const id = `vote-tourney-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const registrationMode = ["invite_only", "open", "invite_plus_open"].includes(body.registrationMode)
    ? body.registrationMode
    : "open";
  const inserted = await pool.query(
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
      pricing.buyInNative,
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
    const token = ident(invite?.tokenAddress || invite);
    if (!token) continue;
    await pool.query(
      `insert into public.arena_tournament_invites (tournament_id, token_address, owner_wallet)
       values ($1,$2,$3)
       on conflict (tournament_id, token_address) do nothing`,
      [id, token, ident(invite?.ownerWallet) || null],
    );
  }

  const quote = publicQuote(pricing, chainId, id);
  const poolOpen = isSolanaChainId(chainId)
    ? {
        execution: "solana-arena-program",
        tournamentId: id,
        buyInLamports: pricing.buyInNativeRaw.toString(),
        note: "Open the Arena tournament pool through the existing Solana Arena program/ops path before accepting registrations.",
      }
    : {
        execution: "ArenaWarPoolTreasuryV2.openTournamentPool",
        treasuryAddress: arenaWarPoolTreasuryV2Address(chainId),
        poolId: quote.poolId,
        buyInAmountRaw: pricing.buyInNativeRaw.toString(),
        note: "Pool opening is an explicit authorized ops/wallet transaction; the API does not hold the creator signing key.",
      };

  return json(res, 201, {
    ok: true,
    tournament: inserted.rows[0],
    generation: "arena_competition_v2",
    scoringVersion: "vote_tournament_v1",
    battleMode: "vote",
    roundDurationHours: 24,
    quote,
    poolOpen,
  });
}

function entryIdentitySql(chainId) {
  return isSolanaChainId(chainId)
    ? { token: "token_address = $2", wallet: "owner_wallet = $3" }
    : { token: "lower(token_address) = lower($2)", wallet: "lower(owner_wallet) = lower($3)" };
}

async function handleBuyInReceipt(req, res, tournamentId) {
  const body = await readJson(req);
  const tournament = (await pool.query(
    `select id, chain_id, status, battle_mode, round_duration_hours, contest_scoring_version,
            competition_generation, buy_in_native
       from public.arena_tournaments where id = $1 limit 1`,
    [tournamentId],
  )).rows[0];
  if (!tournament) return json(res, 404, { ok: false, error: "Tournament not found", code: "TOURNAMENT_NOT_FOUND" });
  if (
    tournament.battle_mode !== "vote" ||
    tournament.contest_scoring_version !== "vote_tournament_v1" ||
    tournament.competition_generation !== "arena_competition_v2" ||
    Number(tournament.round_duration_hours) !== 24
  ) {
    return json(res, 409, { ok: false, error: "This receipt route only accepts V2 Vote Tournaments", code: "VOTE_TOURNAMENT_V2_REQUIRED" });
  }
  if (tournament.status !== "upcoming") {
    return json(res, 409, { ok: false, error: "Tournament registration is closed", code: "VOTE_TOURNAMENT_REGISTRATION_CLOSED" });
  }

  const chainId = Number(tournament.chain_id);
  const token = ident(body.tokenAddress || body.tokenId);
  const wallet = normalizeAddress(body.walletAddress || body.auth?.walletAddress || "", chainId);
  if (!token || !wallet) {
    return json(res, 400, { ok: false, error: "tokenAddress and walletAddress are required", code: "VOTE_TOURNAMENT_BUY_IN_INPUT_REQUIRED" });
  }

  const verified = await requireWalletActionAuth({
    res,
    pool,
    auth: body.auth || body,
    expectedWallet: wallet,
    chainId,
    action: "arena_tournament_buy_in_v2",
    routeLabel: "arena/tournaments/v2-buy-in-receipt",
    extraLines: [`Tournament: ${tournamentId}`, `Token: ${token}`],
  });
  if (!verified) return;

  const identity = entryIdentitySql(chainId);
  const entry = (await pool.query(
    `select token_address, owner_wallet, buy_in_intent, buy_in_paid
       from public.arena_tournament_entries
      where tournament_id = $1 and ${identity.token} and ${identity.wallet}
      limit 1`,
    [tournamentId, token, wallet],
  )).rows[0];
  if (!entry || !entry.buy_in_intent) {
    return json(res, 409, { ok: false, error: "Token is not opted into this tournament for this wallet", code: "VOTE_TOURNAMENT_ENTRY_NOT_FOUND" });
  }
  if (entry.buy_in_paid) return json(res, 200, { ok: true, idempotent: true, buyInPaid: true });

  const decimals = tournamentNativeDecimals(chainId);
  const expectedRaw = parseUnits(String(tournament.buy_in_native), decimals);
  let proof;
  if (isSolanaChainId(chainId)) {
    const onchain = await readSolanaArenaPool(chainId, tournamentId, "tournament");
    if (!onchain.configured || !onchain.live || !onchain.opened) {
      return json(res, 503, { ok: false, error: "Tournament escrow is not open yet", code: "WAR_POOL_NOT_OPEN" });
    }
    if (BigInt(String(onchain.buyInLamports || 0)) !== expectedRaw) {
      return json(res, 409, {
        ok: false,
        error: "On-chain buy-in does not match the founder-locked tournament amount",
        code: "VOTE_TOURNAMENT_BUY_IN_AMOUNT_MISMATCH",
      });
    }
    const receipt = await readAuthoritativeBuyInReceipt(chainId, onchain.poolId, token, wallet, expectedRaw.toString());
    if (!receipt.ok) {
      return json(res, 409, {
        ok: false,
        error: "Buy-in receipt PDA is not an authoritative paid registration",
        code: "BUY_IN_RECEIPT_INVALID",
        reason: receipt.reason,
      });
    }
    proof = { kind: "solana_receipt_pda", poolId: onchain.poolId, receipt: receipt.pda, amountRaw: expectedRaw.toString() };
  } else {
    try {
      proof = await verifyEvmTournamentBuyInV2({
        provider: getServerReadProvider(chainId),
        chainId,
        tournamentId,
        wallet,
        expectedBuyInRaw: expectedRaw,
      });
    } catch (error) {
      return json(res, 409, {
        ok: false,
        error: "On-chain V2 tournament buy-in is not authoritative",
        code: "BUY_IN_RECEIPT_INVALID",
        reason: String(error?.message || error),
      });
    }
  }

  const updated = await pool.query(
    `update public.arena_tournament_entries
        set buy_in_paid = true, updated_at = now()
      where tournament_id = $1
        and ${identity.token}
        and ${identity.wallet}
        and buy_in_intent = true
      returning token_address, owner_wallet, buy_in_paid`,
    [tournamentId, token, wallet],
  );
  if (!updated.rows[0]) {
    return json(res, 409, { ok: false, error: "Tournament entry changed before receipt confirmation", code: "VOTE_TOURNAMENT_ENTRY_RACE" });
  }
  return json(res, 200, {
    ok: true,
    buyInPaid: true,
    buyInUsd: "0.25",
    amountNative: String(tournament.buy_in_native),
    amountRaw: expectedRaw.toString(),
    proof,
  });
}

export default async function handler(req, res) {
  const path = routePath(req);
  const method = String(req.method || "GET").toUpperCase();
  try {
    if (path === "/arena/tournaments/v2/buy-in-quote") return method === "GET" ? handleQuote(req, res) : badMethod(res);
    if (path === "/arena/tournaments/v2/create") return method === "POST" ? handleCreate(req, res) : badMethod(res);
    const receipt = path.match(/^\/arena\/tournaments\/([^/]+)\/v2-buy-in-receipt$/);
    if (receipt) return method === "POST" ? handleBuyInReceipt(req, res, decodeURIComponent(receipt[1])) : badMethod(res);
    return json(res, 404, { ok: false, error: "Unknown V2 Vote Tournament setup route" });
  } catch (error) {
    console.error("[api/arenaVoteTournamentSetup]", error);
    return json(res, 503, { ok: false, error: "V2 Vote Tournament setup is unavailable", detail: String(error?.message || error) });
  }
}
