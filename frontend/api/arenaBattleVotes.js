/**
 * GET  /arena/battles/:id/votes   tally + this wallet's vote for a Vote Battle
 * POST /arena/battles/:id/votes   one free vote per wallet (signed wallet action)
 *
 * Same rules and storage as the Vote Tournament round votes
 * (arenaTournamentVotes.js), scoped to a standalone battle.
 */
import { pool } from "../server/db.js";
import { badMethod, getQuery, json, normalizeAddress, readJson } from "../server/http.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";
import { optionalChainId } from "./lib/arenaBattleChainIdentity.js";
import {
  listVoteBattleVotes,
  loadVoteBattle,
  loadVoteBattleTiebreak,
  recordVoteBattleFreeVote,
  voteBattleAvailability,
  voteBattlePayload,
  voteBattleScore,
  voteBattleSideFor,
  walletVoteToken,
} from "./lib/arenaBattleVoteRuntime.js";

function parseRoute(req) {
  const path = String(req.path || new URL(req.url, "http://localhost").pathname);
  const match = path.match(/^\/arena\/battles\/([^/]+)\/votes$/);
  if (!match) return null;
  return { battleId: decodeURIComponent(match[1]) };
}

function chainMismatch(res, battle, requestedChainId) {
  if (requestedChainId == null || Number(battle.chain_id) === Number(requestedChainId)) return false;
  json(res, 409, { ok: false, error: "Battle is not on the requested chain", code: "BATTLE_CHAIN_MISMATCH" });
  return true;
}

function unavailable(res, availability) {
  return json(res, availability.status, { ok: false, error: availability.error, code: availability.code });
}

async function handleGet(req, res, route) {
  const query = getQuery(req);
  let requestedChainId;
  try {
    requestedChainId = optionalChainId(query.chainId);
  } catch (error) {
    return json(res, 400, { ok: false, error: error.message, code: "INVALID_CHAIN" });
  }
  const battle = await loadVoteBattle((text, params) => pool.query(text, params), route.battleId);
  if (!battle) return json(res, 404, { ok: false, error: "Battle not found", code: "BATTLE_NOT_FOUND" });
  if (chainMismatch(res, battle, requestedChainId)) return;
  const tiebreak = await loadVoteBattleTiebreak((text, params) => pool.query(text, params), battle.id);
  const availability = voteBattleAvailability(battle, { tiebreak });
  if (!availability.ok && !["VOTE_BATTLE_REGULATION_ENDED", "FINAL_SALVO_ACTIVE", "VOTE_BATTLE_NOT_LIVE"].includes(availability.code)) {
    return unavailable(res, availability);
  }
  const chainId = Number(battle.chain_id);
  const [rows, score] = await Promise.all([
    listVoteBattleVotes((text, params) => pool.query(text, params), battle),
    voteBattleScore((text, params) => pool.query(text, params), battle),
  ]);
  const wallet = normalizeAddress(query.walletAddress || query.wallet || "", chainId);
  const payload = voteBattlePayload({
    battle,
    rows,
    score,
    walletVote: walletVoteToken(rows, wallet, availability.match || { tokenA: battle.challenger_token, tokenB: battle.defender_token }, (value) => normalizeAddress(value || "", chainId)),
  });
  res.setHeader("cache-control", "no-store");
  return json(res, 200, {
    ...payload,
    votingLive: availability.ok,
    finalSalvo: tiebreak ? { state: tiebreak.state } : null,
    unavailableReason: availability.ok ? null : availability.code,
  });
}

async function handlePost(req, res, route) {
  const body = await readJson(req);
  let requestedChainId;
  try {
    requestedChainId = optionalChainId(body?.chainId ?? body?.auth?.chainId);
  } catch (error) {
    return json(res, 400, { ok: false, error: error.message, code: "INVALID_CHAIN" });
  }
  const battle = await loadVoteBattle((text, params) => pool.query(text, params), route.battleId);
  if (!battle) return json(res, 404, { ok: false, error: "Battle not found", code: "BATTLE_NOT_FOUND" });
  if (chainMismatch(res, battle, requestedChainId)) return;
  const chainId = Number(battle.chain_id);
  const wallet = normalizeAddress(body.walletAddress || body.auth?.walletAddress || "", chainId);
  const selectedToken = String(body.tokenAddress || body.tokenId || body.selectedToken || "").trim();
  if (!wallet || !selectedToken) {
    return json(res, 400, { ok: false, error: "walletAddress and tokenAddress are required", code: "VOTE_INPUT_REQUIRED" });
  }

  const preTiebreak = await loadVoteBattleTiebreak((text, params) => pool.query(text, params), battle.id);
  const preflight = voteBattleAvailability(battle, { tiebreak: preTiebreak });
  if (!preflight.ok) return unavailable(res, preflight);
  const side = voteBattleSideFor(battle, selectedToken);
  if (!side) return json(res, 409, { ok: false, error: "Selected token is not in this battle.", code: "VOTE_TOKEN_NOT_IN_BATTLE" });

  const verified = await requireWalletActionAuth({
    res,
    pool,
    auth: body.auth || body,
    expectedWallet: wallet,
    chainId,
    action: "arena_battle_vote",
    routeLabel: "arena/battles/votes",
    extraLines: [`Battle: ${battle.id}`, "Phase: regulation", `Token: ${selectedToken}`],
  });
  if (!verified) return;

  const client = await pool.connect();
  try {
    await client.query("begin");
    const query = (text, params) => client.query(text, params);
    const locked = await loadVoteBattle(query, battle.id, { forUpdate: true });
    const tiebreak = await loadVoteBattleTiebreak(query, battle.id);
    const availability = voteBattleAvailability(locked, { tiebreak });
    if (!availability.ok) {
      await client.query("rollback");
      return unavailable(res, availability);
    }
    const lockedSide = voteBattleSideFor(locked, selectedToken);
    if (!lockedSide) {
      await client.query("rollback");
      return json(res, 409, { ok: false, error: "Selected token is not in this battle.", code: "VOTE_TOKEN_NOT_IN_BATTLE" });
    }
    const recorded = await recordVoteBattleFreeVote(query, locked, { wallet, side: lockedSide });
    if (!recorded.inserted) {
      await client.query("rollback");
      const existingSide = recorded.existingSide;
      return json(res, 409, {
        ok: false,
        error: "This wallet already used its free vote for this battle.",
        code: "BATTLE_VOTE_ALREADY_USED",
        existingToken: existingSide === "left" ? availability.match.tokenA : existingSide === "right" ? availability.match.tokenB : null,
      });
    }
    const rows = await listVoteBattleVotes(query, locked);
    const score = await voteBattleScore(query, locked);
    await client.query("commit");
    res.setHeader("cache-control", "no-store");
    return json(res, 201, {
      ...voteBattlePayload({ battle: locked, rows, score, walletVote: selectedToken }),
      selectedToken,
      pointsAdded: 1,
    });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  const route = parseRoute(req);
  if (!route) return json(res, 404, { ok: false, error: "Unknown battle vote route" });
  const method = String(req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") return badMethod(res);
  try {
    if (method === "GET") return await handleGet(req, res, route);
    return await handlePost(req, res, route);
  } catch (error) {
    console.error("[api/arenaBattleVotes]", error);
    if (error?.code === "42P01") {
      return json(res, 503, { ok: false, error: "Battle contest-action schema is not installed.", code: "BATTLE_VOTE_SCHEMA_MISSING" });
    }
    return json(res, 500, { ok: false, error: "Battle vote request failed" });
  }
}
