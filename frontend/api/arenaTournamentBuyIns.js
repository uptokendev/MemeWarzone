import { pool } from "../server/db.js";
import { badMethod, getQuery, json, normalizeWalletFlexible, readJson } from "../server/http.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";
import { getServerReadProvider } from "./lib/getServerReadProvider.js";
import { isSolanaChainId } from "./lib/chainNative.js";
import { readAuthoritativeBuyInReceipt, readSolanaArenaPool } from "./lib/solanaArenaPoolRead.js";
import {
  arenaWarPoolTreasuryV2Address,
  readEvmTournamentPoolV2,
  tournamentBuyInNativeRaw,
  tournamentNativeDecimals,
  tournamentPoolIdV2,
  verifyEvmTournamentBuyInV2,
} from "./lib/arenaTournamentBuyInV2.mjs";

function pathOf(req) {
  return String(req.path || new URL(req.url, "http://localhost").pathname);
}

function ident(value, chainId) {
  const normalized = normalizeWalletFlexible(value);
  if (normalized) return normalized;
  const raw = String(value || "").trim();
  return isSolanaChainId(Number(chainId)) ? raw : raw.toLowerCase();
}

function sameIdentity(left, right, chainId) {
  const a = ident(left, chainId);
  const b = ident(right, chainId);
  return Boolean(a && b && (isSolanaChainId(Number(chainId)) ? a === b : a.toLowerCase() === b.toLowerCase()));
}

async function loadTournament(id, requestedChainId = null) {
  const row = (await pool.query(
    `select id, chain_id, status, origin, battle_mode, competition_generation, contest_scoring_version,
            buy_in_native, native_symbol
       from public.arena_tournaments where id = $1 limit 1`,
    [id],
  )).rows[0] || null;
  if (!row) return { row: null, chainMismatch: false };
  if (requestedChainId != null && Number(requestedChainId) !== Number(row.chain_id)) return { row: null, chainMismatch: true };
  return { row, chainMismatch: false };
}

function entryIdentitySql(chainId) {
  return isSolanaChainId(Number(chainId))
    ? { token: "token_address = $2", wallet: "owner_wallet = $3" }
    : { token: "lower(token_address) = lower($2)", wallet: "lower(owner_wallet) = lower($3)" };
}

async function loadEntry(tournamentId, token, wallet, chainId) {
  const identity = entryIdentitySql(chainId);
  return (await pool.query(
    `select token_address, owner_wallet, buy_in_intent, buy_in_paid
       from public.arena_tournament_entries
      where tournament_id = $1 and ${identity.token} and ${identity.wallet}
      limit 1`,
    [tournamentId, token, wallet],
  )).rows[0] || null;
}

function requestedChainId(req, body = null) {
  const query = getQuery(req);
  const raw = body?.chainId ?? body?.chain_id ?? query.chainId ?? query.chain_id;
  if (raw == null || String(raw).trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("INVALID_CHAIN");
  return parsed;
}

async function authoritativeState({ tournament, token, wallet, txHash = "" }) {
  const chainId = Number(tournament.chain_id);
  const expectedRaw = tournamentBuyInNativeRaw({ chainId, buyInNative: tournament.buy_in_native });
  if (isSolanaChainId(chainId)) {
    const onchain = await readSolanaArenaPool(chainId, tournament.id, "tournament");
    if (!onchain.configured || !onchain.live || !onchain.opened) {
      return { ok: false, code: "WAR_POOL_NOT_OPEN", reason: "Tournament escrow is not open yet", expectedRaw, onchain };
    }
    if (BigInt(String(onchain.buyInLamports || 0)) !== expectedRaw) {
      return { ok: false, code: "BUY_IN_AMOUNT_MISMATCH", reason: "Solana tournament pool buy-in differs from arena_tournaments.buy_in_native", expectedRaw, onchain };
    }
    const receipt = await readAuthoritativeBuyInReceipt(chainId, onchain.poolId, token, wallet, expectedRaw.toString());
    if (!receipt.ok) return { ok: false, code: "BUY_IN_NOT_FOUND", reason: receipt.reason, expectedRaw, onchain, receipt };
    return {
      ok: true,
      kind: "solana_receipt_pda",
      expectedRaw,
      amountRaw: expectedRaw.toString(),
      poolId: onchain.poolId,
      treasury: onchain.programId || onchain.treasury,
      receipt: receipt.pda,
      chainPaid: true,
    };
  }

  try {
    const provider = await getServerReadProvider(chainId);
    const proof = txHash
      ? await verifyEvmTournamentBuyInV2({ provider, chainId, tournamentId: tournament.id, wallet, expectedBuyInRaw: expectedRaw, txHash })
      : await readEvmTournamentPoolV2({ provider, chainId, tournamentId: tournament.id, wallet, expectedBuyInRaw: expectedRaw });
    const paid = txHash ? BigInt(proof.paid) : BigInt(proof.paid || 0);
    if (paid !== expectedRaw) {
      return {
        ok: false,
        code: "BUY_IN_NOT_FOUND",
        reason: "ArenaWarPoolTreasuryV2 buyIns(poolId,wallet) does not contain the exact configured buy-in",
        expectedRaw,
        proof,
      };
    }
    return {
      ok: true,
      kind: "evm_arena_war_pool_v2",
      expectedRaw,
      amountRaw: expectedRaw.toString(),
      poolId: proof.poolId,
      treasury: proof.treasuryAddress,
      runtimeHash: proof.treasuryRuntimeHash || proof.runtimeHash,
      txProof: proof.txProof || null,
      chainPaid: true,
    };
  } catch (error) {
    return { ok: false, code: "BUY_IN_NOT_FOUND", reason: String(error?.message || error), expectedRaw };
  }
}

async function handleStatus(req, res, tournamentId) {
  let chainId;
  try { chainId = requestedChainId(req); } catch { return json(res, 400, { ok: false, code: "INVALID_CHAIN", error: "Invalid Arena chain id" }); }
  const loaded = await loadTournament(tournamentId, chainId);
  if (loaded.chainMismatch) return json(res, 404, { ok: false, code: "TOURNAMENT_CHAIN_MISMATCH", error: "Tournament not found on requested chain" });
  const tournament = loaded.row;
  if (!tournament) return json(res, 404, { ok: false, code: "TOURNAMENT_NOT_FOUND", error: "Tournament not found" });
  chainId = Number(tournament.chain_id);
  const query = getQuery(req);
  const token = ident(query.tokenAddress || query.tokenId || "", chainId);
  const wallet = ident(query.walletAddress || query.wallet || "", chainId);
  if (!token || !wallet) return json(res, 400, { ok: false, code: "BUY_IN_INPUT_REQUIRED", error: "tokenAddress and walletAddress are required" });
  const entry = await loadEntry(tournamentId, token, wallet, chainId);
  if (!entry || !entry.buy_in_intent || !sameIdentity(entry.owner_wallet, wallet, chainId)) {
    return json(res, 409, { ok: false, code: "TOURNAMENT_ENTRY_NOT_FOUND", error: "Token is not opted into this tournament for this owner wallet" });
  }
  const expectedRaw = tournamentBuyInNativeRaw({ chainId, buyInNative: tournament.buy_in_native });
  if (entry.buy_in_paid) {
    return json(res, 200, {
      ok: true,
      buyInPaid: true,
      chainPaid: true,
      dbPaid: true,
      chainId,
      amountNative: String(tournament.buy_in_native),
      amountRaw: expectedRaw.toString(),
      nativeDecimals: tournamentNativeDecimals(chainId),
      poolId: tournamentPoolIdV2(tournamentId),
      treasury: isSolanaChainId(chainId) ? null : arenaWarPoolTreasuryV2Address(chainId),
    });
  }
  const state = await authoritativeState({ tournament, token, wallet });
  return json(res, 200, {
    ok: true,
    buyInPaid: false,
    dbPaid: false,
    chainPaid: state.ok === true,
    chainId,
    amountNative: String(tournament.buy_in_native),
    amountRaw: expectedRaw.toString(),
    nativeDecimals: tournamentNativeDecimals(chainId),
    poolId: state.poolId || tournamentPoolIdV2(tournamentId),
    treasury: state.treasury || (isSolanaChainId(chainId) ? null : arenaWarPoolTreasuryV2Address(chainId)),
    proofKind: state.kind || null,
    recoveryAvailable: state.ok === true,
    reason: state.ok ? null : state.reason,
  });
}

async function handleReceipt(req, res, tournamentId) {
  const body = await readJson(req);
  let chainId;
  try { chainId = requestedChainId(req, body); } catch { return json(res, 400, { ok: false, code: "INVALID_CHAIN", error: "Invalid Arena chain id" }); }
  const loaded = await loadTournament(tournamentId, chainId);
  if (loaded.chainMismatch) return json(res, 404, { ok: false, code: "TOURNAMENT_CHAIN_MISMATCH", error: "Tournament not found on requested chain" });
  const tournament = loaded.row;
  if (!tournament) return json(res, 404, { ok: false, code: "TOURNAMENT_NOT_FOUND", error: "Tournament not found" });
  chainId = Number(tournament.chain_id);
  if (String(tournament.status) !== "upcoming") return json(res, 409, { ok: false, code: "TOURNAMENT_REGISTRATION_CLOSED", error: "Tournament registration is closed" });

  const token = ident(body.tokenAddress || body.tokenId || "", chainId);
  const wallet = ident(body.walletAddress || body.auth?.walletAddress || "", chainId);
  const txHash = String(body.txHash || "").trim();
  if (!token || !wallet) return json(res, 400, { ok: false, code: "BUY_IN_INPUT_REQUIRED", error: "tokenAddress and walletAddress are required" });
  if (isSolanaChainId(chainId) && !txHash) return json(res, 400, { ok: false, code: "BUY_IN_TX_REQUIRED", error: "Solana buy-in transaction signature is required" });

  const verified = await requireWalletActionAuth({
    res,
    pool,
    auth: body.auth || body,
    expectedWallet: wallet,
    chainId,
    action: "arena_tournament_buy_in",
    routeLabel: "arena/tournaments/buy-in-receipt",
    extraLines: [`Tournament: ${tournamentId}`, `Token: ${token}`, txHash ? `Tx: ${txHash}` : "Reconcile: authoritative chain state"].filter(Boolean),
  });
  if (!verified) return;

  const entry = await loadEntry(tournamentId, token, wallet, chainId);
  if (!entry || !entry.buy_in_intent || !sameIdentity(entry.owner_wallet, wallet, chainId)) {
    return json(res, 409, { ok: false, code: "TOURNAMENT_ENTRY_NOT_FOUND", error: "Token is not opted into this tournament for this owner wallet" });
  }
  if (entry.buy_in_paid) return json(res, 200, { ok: true, idempotent: true, buyInPaid: true, chainId });

  const proof = await authoritativeState({ tournament, token, wallet, txHash });
  if (!proof.ok) {
    return json(res, proof.code === "WAR_POOL_NOT_OPEN" ? 503 : 409, {
      ok: false,
      code: proof.code || "BUY_IN_RECEIPT_INVALID",
      error: "Authoritative tournament buy-in is not confirmed",
      reason: proof.reason,
    });
  }

  const identity = entryIdentitySql(chainId);
  const updated = await pool.query(
    `update public.arena_tournament_entries
        set buy_in_paid = true, updated_at = now()
      where tournament_id = $1 and ${identity.token} and ${identity.wallet}
        and buy_in_intent = true and buy_in_paid = false
      returning token_address, owner_wallet, buy_in_paid`,
    [tournamentId, token, wallet],
  );
  if (!updated.rows[0]) {
    const raced = await loadEntry(tournamentId, token, wallet, chainId);
    if (raced?.buy_in_paid) {
      return json(res, 200, { ok: true, idempotent: true, buyInPaid: true, chainId, proof });
    }
    return json(res, 409, { ok: false, code: "TOURNAMENT_ENTRY_RACE", error: "Tournament entry changed before receipt reconciliation" });
  }
  return json(res, 200, {
    ok: true,
    idempotent: false,
    buyInPaid: true,
    chainId,
    amountNative: String(tournament.buy_in_native),
    amountRaw: proof.amountRaw,
    proof,
  });
}

export default async function handler(req, res) {
  const path = pathOf(req);
  const method = String(req.method || "GET").toUpperCase();
  const status = path.match(/^\/arena\/tournaments\/([^/]+)\/buy-in-status$/);
  if (status) return method === "GET" ? handleStatus(req, res, decodeURIComponent(status[1])) : badMethod(res);
  const receipt = path.match(/^\/arena\/tournaments\/([^/]+)\/(?:v2-buy-in-receipt|buy-in-receipt)$/);
  if (receipt) return method === "POST" ? handleReceipt(req, res, decodeURIComponent(receipt[1])) : badMethod(res);
  return json(res, 404, { ok: false, error: "Unknown tournament buy-in route" });
}
