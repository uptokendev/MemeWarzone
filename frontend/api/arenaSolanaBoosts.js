import { PublicKey } from "@solana/web3.js";

import { pool } from "../server/db.js";
import { badMethod, json, readJson } from "../server/http.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";
import { battlePoolId } from "./lib/arenaWarPoolEscrow.js";
import { tournamentPoolIdV2 } from "./lib/arenaTournamentBuyInV2.mjs";
import { findTournamentVoteMatch, resolveTournamentVoteMatch, tournamentVoteTokensEqual } from "./lib/arenaTournamentVoteRuntime.mjs";
import { boostSummary, serializeBoostSummary } from "./lib/arenaBoostRuntime.mjs";
import { readCompetitionPoolV2 } from "./lib/solanaArenaMoneyV2Read.js";
import {
  assertSolanaPubkey,
  buildSolanaBoostInstructionRequirements,
  quoteSolanaBoost,
  randomMoneyId32,
  verifySolanaBoostPayment,
} from "./lib/solanaArenaMoneyV2Runtime.mjs";

const QUOTE_TTL_SECONDS = 300;

function routeInfo(req) {
  const path = String(req.path || new URL(req.url, "http://localhost").pathname);
  let m = path.match(/^\/arena\/boosts\/([^/]+)\/(solana-quote|solana-payment)$/);
  if (m) return { product: "normal_battle", battleId: decodeURIComponent(m[1]), action: m[2] };
  m = path.match(/^\/arena\/tournaments\/([^/]+)\/matches\/([^/]+)\/boosts\/(solana-quote|solana-payment)$/);
  if (m) return { product: "vote_tournament", tournamentId: decodeURIComponent(m[1]), matchRef: decodeURIComponent(m[2]), action: m[3] };
  return null;
}

function positiveUnits(value) {
  try { const n = BigInt(String(value)); return n > 0n && n <= 1_000_000n ? n : null; } catch { return null; }
}

function exactSolanaSide(participants, token) {
  if (!Array.isArray(participants) || participants.length < 2) return null;
  const idOf = (p) => String(p?.tokenId || p?.tokenAddress || p?.campaignAddress || "").trim();
  if (idOf(participants[0]) === token) return "left";
  if (idOf(participants[1]) === token) return "right";
  return null;
}

async function loadBattle(id, lockClient = null) {
  const db = lockClient || pool;
  const suffix = lockClient ? " for update" : "";
  return (await db.query(
    `select id, chain_id, state, source, tournament_id, battle_mode, ends_at, competition_generation, participants
       from public.arena_battles where id = $1${suffix}`,
    [id],
  )).rows[0] || null;
}

async function loadTournament(id) {
  return (await pool.query(
    `select id, chain_id, status, bracket, battle_mode, round_duration_hours, competition_generation
       from public.arena_tournaments where id = $1 limit 1`,
    [id],
  )).rows[0] || null;
}

function validateSolanaChain(chainId) {
  return [101, 102].includes(Number(chainId));
}

async function normalContext(route, targetToken) {
  const battle = await loadBattle(route.battleId);
  if (!battle) return { error: "Battle not found", status: 404 };
  const chainId = Number(battle.chain_id);
  if (!validateSolanaChain(chainId)) return { error: "Battle is not on a Solana Arena chain", status: 409 };
  if (battle.state !== "live" || String(battle.battle_mode || "normal") !== "normal" || battle.source === "tournament") return { error: "Normal Battle Boost is not live", status: 409 };
  if (battle.competition_generation !== "arena_competition_v2") return { error: "Battle is not Arena competition V2", status: 409 };
  let token;
  try { token = assertSolanaPubkey(targetToken, "targetToken"); } catch (error) { return { error: error.message, status: 400 }; }
  const side = exactSolanaSide(battle.participants, token);
  if (!side) return { error: "Boost target is not a Battle combatant", status: 409 };
  const competitionId = battlePoolId(route.battleId);
  const onchain = await readCompetitionPoolV2(chainId, competitionId);
  if (!onchain.live || !onchain.opened || ![0, 1].includes(Number(onchain.pool?.state)) || Number(onchain.pool?.kind) !== 0) return { error: "Solana CompetitionPoolV2 is not active", status: 503, code: "SOLANA_COMPETITION_POOL_NOT_ACTIVE" };
  if (onchain.pool.assetA !== token && onchain.pool.assetB !== token) return { error: "On-chain competition does not contain the selected combatant", status: 409 };
  return { battle, chainId, targetToken: token, side, competitionId, onchain, pointsPerBoost: 1 };
}

async function tournamentContext(route, targetToken) {
  const tournament = await loadTournament(route.tournamentId);
  if (!tournament) return { error: "Tournament not found", status: 404 };
  const chainId = Number(tournament.chain_id);
  if (!validateSolanaChain(chainId)) return { error: "Tournament is not on a Solana Arena chain", status: 409 };
  if (tournament.status !== "live" || tournament.battle_mode !== "vote" || Number(tournament.round_duration_hours) !== 24 || tournament.competition_generation !== "arena_competition_v2") return { error: "Vote Tournament regulation is not active", status: 409 };
  let token;
  try { token = assertSolanaPubkey(targetToken, "targetToken"); } catch (error) { return { error: error.message, status: 400 }; }
  const match = resolveTournamentVoteMatch({ tournament, matchRef: route.matchRef, selectedToken: token });
  if (!match.ok) return { error: `Tournament matchup is not Boost-active: ${match.reason}`, status: 409 };
  const battle = await loadBattle(match.battleId);
  if (!battle || battle.state !== "live" || battle.battle_mode !== "vote" || battle.source !== "tournament") return { error: "Vote Tournament battle is not live", status: 409 };
  if (!battle.ends_at || new Date(battle.ends_at).getTime() <= Date.now()) return { error: "Vote Tournament regulation has ended", status: 409 };
  const salvo = (await pool.query(`select battle_id from public.arena_vote_tiebreaks where battle_id = $1 limit 1`, [match.battleId])).rows[0];
  if (salvo) return { error: "Boost is disabled during Final Salvo", status: 409, code: "FINAL_SALVO_BOOST_DISABLED" };
  const side = tournamentVoteTokensEqual(token, match.tokenA) ? "left" : tournamentVoteTokensEqual(token, match.tokenB) ? "right" : null;
  if (!side) return { error: "Boost target is not in this matchup", status: 409 };
  const competitionId = tournamentPoolIdV2(route.tournamentId);
  const onchain = await readCompetitionPoolV2(chainId, competitionId);
  if (!onchain.live || !onchain.opened || ![0, 1].includes(Number(onchain.pool?.state)) || Number(onchain.pool?.kind) !== 1) return { error: "Solana Tournament CompetitionPoolV2 is not active", status: 503, code: "SOLANA_COMPETITION_POOL_NOT_ACTIVE" };
  return { tournament, battle, match, chainId, targetToken: token, side, competitionId, onchain, pointsPerBoost: 2 };
}

async function buildContext(route, targetToken) {
  return route.product === "normal_battle" ? normalContext(route, targetToken) : tournamentContext(route, targetToken);
}

async function createQuote(req, res, route) {
  const body = await readJson(req);
  const units = positiveUnits(body.boostUnits);
  if (!units) return json(res, 400, { ok: false, error: "boostUnits must be a positive integer" });
  const context = await buildContext(route, body.targetToken);
  if (context.error) return json(res, context.status, { ok: false, error: context.error, code: context.code });
  let wallet;
  try { wallet = assertSolanaPubkey(body.wallet || body.walletAddress || body.auth?.walletAddress, "wallet"); } catch (error) { return json(res, 400, { ok: false, error: error.message }); }

  const auth = await requireWalletActionAuth({
    res,
    pool,
    auth: body.auth || body,
    expectedWallet: wallet,
    chainId: context.chainId,
    action: route.product === "normal_battle" ? "arena_battle_boost_quote" : "arena_tournament_boost_quote",
    routeLabel: route.product === "normal_battle" ? "arena/boosts/solana-quote" : "arena/tournaments/boosts/solana-quote",
    extraLines: [
      route.product === "normal_battle" ? `Battle: ${route.battleId}` : `Tournament: ${route.tournamentId}`,
      ...(context.match ? [`Round: ${context.match.roundNumber}`, `Match: ${context.match.matchId}`] : []),
      `Target: ${context.targetToken}`,
      `Boost Units: ${units}`,
    ],
  });
  if (!auth || auth.legacy) return auth?.legacy ? json(res, 401, { ok: false, error: "Signed wallet authentication is required" }) : undefined;

  let money;
  try { money = quoteSolanaBoost({ chainId: context.chainId, boostUnits: units }); }
  catch (error) { return json(res, 503, { ok: false, error: "SOL Boost pricing is unavailable", detail: String(error?.message || error) }); }
  const fundingId = randomMoneyId32();
  const requirements = buildSolanaBoostInstructionRequirements({ competitionId: context.competitionId, fundingId, wallet, grossLamports: money.gross });
  const expiresAt = new Date(Date.now() + QUOTE_TTL_SECONDS * 1000).toISOString();
  const inserted = (await pool.query(
    `insert into public.arena_solana_boost_quotes (
       chain_id, product_kind, battle_id, tournament_id, match_id, round_number, competition_id, funding_id,
       wallet, target_token, side, boost_units, points_per_boost, gross_lamports, prize_lamports,
       protocol_lamports, native_usd_micros, pricing_version, oracle_timestamp, receipt_pda, expires_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,to_timestamp($19),$20,$21)
     returning id`,
    [context.chainId, route.product, context.battle.id, route.tournamentId || null, context.match?.matchId || null, context.match?.roundNumber || 0,
      context.competitionId, fundingId, wallet, context.targetToken, context.side, units.toString(), context.pointsPerBoost,
      money.gross.toString(), money.prize.toString(), money.protocol.toString(), money.nativeUsdMicros.toString(), money.pricingVersion.toString(), money.oracleTimestamp.toString(), requirements.receiptPda, expiresAt],
  )).rows[0];
  res.setHeader("cache-control", "no-store");
  return json(res, 201, {
    ok: true,
    quoteId: inserted.id,
    product: route.product,
    chainId: context.chainId,
    battleId: context.battle.id,
    tournamentId: route.tournamentId || null,
    matchId: context.match?.matchId || null,
    roundNumber: context.match?.roundNumber || 0,
    side: context.side,
    targetToken: context.targetToken,
    boostUnits: units.toString(),
    pointsPerBoost: context.pointsPerBoost,
    usdPerBoostMicros: "1000000",
    grossLamports: money.gross.toString(),
    prizeLamports: money.prize.toString(),
    protocolLamports: money.protocol.toString(),
    split: { prizeBps: 9000, protocolBps: 1000, leagueBps: 0 },
    competitionId: context.competitionId,
    fundingId,
    transaction: requirements,
    expiresAt,
    battlePointsV3: { boostCurveVersion: "founder_pending", scoringActive: false, boostPoints: null },
  });
}

function sameQuote(row, route) {
  if (!row) return false;
  if (row.product_kind !== route.product) return false;
  if (route.product === "normal_battle") return String(row.battle_id) === route.battleId;
  return String(row.tournament_id) === route.tournamentId;
}

async function confirmPayment(req, res, route) {
  const body = await readJson(req);
  const quoteId = String(body.quoteId || "").trim();
  const signature = String(body.signature || body.txSignature || "").trim();
  if (!quoteId || !signature) return json(res, 400, { ok: false, error: "quoteId and signature are required" });
  const client = await pool.connect();
  try {
    await client.query("begin");
    const quote = (await client.query(`select * from public.arena_solana_boost_quotes where id = $1 for update`, [quoteId])).rows[0];
    if (!sameQuote(quote, route)) { await client.query("rollback"); return json(res, 404, { ok: false, error: "Solana Boost quote not found for this route" }); }
    if (quote.signature_reference) {
      const existing = (await client.query(`select * from public.arena_contest_actions where chain_id=$1 and signature_reference=$2 limit 1`, [quote.chain_id, quote.signature_reference])).rows[0];
      await client.query("rollback");
      return json(res, 200, { ok: true, confirmed: true, idempotent: true, signature: quote.signature_reference, action: existing || null });
    }
    const auth = await requireWalletActionAuth({
      res,
      pool: client,
      auth: body.auth || body,
      expectedWallet: quote.wallet,
      chainId: Number(quote.chain_id),
      action: route.product === "normal_battle" ? "arena_battle_boost_payment" : "arena_tournament_boost_payment",
      routeLabel: "arena/solana-boost-payment",
      extraLines: [`Quote: ${quote.id}`, `Signature: ${signature}`],
    });
    if (!auth || auth.legacy) { await client.query("rollback"); return auth?.legacy ? json(res, 401, { ok: false, error: "Signed wallet authentication is required" }) : undefined; }

    const context = await buildContext(route, quote.target_token);
    if (context.error || String(context.battle.id) !== String(quote.battle_id) || context.side !== quote.side || context.competitionId.toLowerCase() !== String(quote.competition_id).toLowerCase()) {
      await client.query("rollback");
      return json(res, 409, { ok: false, error: context.error || "Boost quote no longer matches authoritative Arena state", code: context.code || "SOLANA_BOOST_STATE_CHANGED" });
    }
    let proof;
    try {
      proof = await verifySolanaBoostPayment({ chainId: quote.chain_id, signature, competitionId: quote.competition_id, fundingId: quote.funding_id, funder: quote.wallet, grossLamports: quote.gross_lamports, prizeLamports: quote.prize_lamports, protocolLamports: quote.protocol_lamports });
    } catch (error) {
      await client.query("rollback");
      return json(res, 409, { ok: false, error: "Solana Boost payment is not authoritative", code: "SOLANA_BOOST_PAYMENT_UNVERIFIED", reason: String(error?.message || error) });
    }
    const receiptMs = Number(proof.receipt.createdAt) * 1000;
    if (receiptMs > new Date(quote.expires_at).getTime()) { await client.query("rollback"); return json(res, 409, { ok: false, error: "Boost payment was created after quote expiry", code: "SOLANA_BOOST_QUOTE_EXPIRED" }); }
    if (route.product === "vote_tournament" && (!context.battle.ends_at || receiptMs >= new Date(context.battle.ends_at).getTime())) { await client.query("rollback"); return json(res, 409, { ok: false, error: "Tournament Boost was not paid during regulation", code: "TOURNAMENT_BOOST_OUTSIDE_REGULATION" }); }

    const points = route.product === "vote_tournament" ? BigInt(quote.boost_units) * 2n : 0n;
    const inserted = (await client.query(
      `insert into public.arena_contest_actions (
         chain_id, tournament_id, battle_id, match_id, round_number, phase, salvo_index, side, wallet,
         action_type, boost_units, points, gross_native_raw, pool_native_raw, protocol_native_raw,
         tx_hash, log_index, signature_reference, confirmed_at
       ) values ($1,$2,$3,$4,$5,'regulation',null,$6,$7,'boost',$8,$9,$10,$11,$12,$13,0,$13,to_timestamp($14))
       on conflict (chain_id, signature_reference) where signature_reference is not null do nothing returning *`,
      [quote.chain_id, quote.tournament_id, quote.battle_id, quote.match_id, quote.round_number, quote.side, quote.wallet, quote.boost_units,
       points.toString(), quote.gross_lamports, quote.prize_lamports, quote.protocol_lamports, signature, proof.receipt.createdAt],
    )).rows[0];
    if (!inserted) {
      const existing = (await client.query(`select * from public.arena_contest_actions where chain_id=$1 and signature_reference=$2 limit 1`, [quote.chain_id, signature])).rows[0];
      const same = existing && String(existing.battle_id) === String(quote.battle_id) && String(existing.wallet) === String(quote.wallet) && String(existing.boost_units) === String(quote.boost_units);
      await client.query("rollback");
      return same ? json(res, 200, { ok: true, confirmed: true, idempotent: true, signature, action: existing }) : json(res, 409, { ok: false, error: "Signature is already bound to another Arena action" });
    }

    await client.query(`update public.arena_solana_boost_quotes set consumed_at=now(), signature_reference=$2, updated_at=now() where id=$1`, [quote.id, signature]);
    if (route.product === "normal_battle") {
      await client.query(
        `insert into public.arena_battle_points_v3 (battle_id, token_id, side, boost_units, boost_gross_native_raw, boost_pool_native_raw, boost_protocol_native_raw)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (battle_id, side) do update set
           boost_units=public.arena_battle_points_v3.boost_units+excluded.boost_units,
           boost_gross_native_raw=public.arena_battle_points_v3.boost_gross_native_raw+excluded.boost_gross_native_raw,
           boost_pool_native_raw=public.arena_battle_points_v3.boost_pool_native_raw+excluded.boost_pool_native_raw,
           boost_protocol_native_raw=public.arena_battle_points_v3.boost_protocol_native_raw+excluded.boost_protocol_native_raw,
           metrics_updated_at=now(), updated_at=now()`,
        [quote.battle_id, quote.target_token, quote.side, quote.boost_units, quote.gross_lamports, quote.prize_lamports, quote.protocol_lamports],
      );
    }
    await client.query("commit");
    const rows = (await pool.query(`select side,boost_units,gross_native_raw,pool_native_raw,protocol_native_raw from public.arena_contest_actions where battle_id=$1 and action_type='boost' and phase='regulation' and confirmed_at is not null`, [quote.battle_id])).rows;
    return json(res, 201, {
      ok: true, confirmed: true, idempotent: false, signature, receiptPda: proof.receiptPda,
      action: inserted, summary: serializeBoostSummary(boostSummary(rows)), pointsPerBoost: Number(quote.points_per_boost),
      battlePointsV3: { boostCurveVersion: "founder_pending", scoringActive: false, boostPoints: null },
    });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    console.error("[api/arenaSolanaBoosts] payment failed", error);
    return json(res, 500, { ok: false, error: "Failed to confirm Solana Boost" });
  } finally { client.release(); }
}

export default async function handler(req, res) {
  const route = routeInfo(req);
  if (!route) return json(res, 404, { ok: false, error: "Unknown Solana Boost route" });
  if (String(req.method || "POST").toUpperCase() !== "POST") return badMethod(res);
  return route.action === "solana-quote" ? createQuote(req, res, route) : confirmPayment(req, res, route);
}
