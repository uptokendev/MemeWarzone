import { pool } from "../server/db.js";
import { badMethod, isAddress, json, readJson } from "../server/http.js";
import { requireInternalAuth } from "./lib/apiAuth.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";
import { getServerReadProvider } from "./lib/getServerReadProvider.js";
import { battleBoostTreasuryV2Address } from "./lib/arenaBoostChainVerification.mjs";
import {
  DEFAULT_QUOTE_TTL_SECONDS,
  randomBoostNonce,
  readBoostPricingConfig,
  serializeSignedBoostQuote,
  signBoostQuote,
} from "./lib/arenaBoostQuote.mjs";
import { validateConfirmedBoost } from "./lib/arenaBoostRuntime.mjs";
import {
  findTournamentVoteMatch,
  resolveTournamentVoteMatch,
  tournamentVoteTokensEqual,
} from "./lib/arenaTournamentVoteRuntime.mjs";
import {
  tournamentBoostMatchId,
  tournamentBoostPoolId,
  verifyTournamentBoostPayment,
} from "./lib/arenaTournamentBoostVerification.mjs";

function safeId(value) {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{1,180}$/.test(id) ? id : "";
}

function routeInfo(req) {
  const path = String(req.path || new URL(req.url, "http://localhost").pathname);
  const match = path.match(/^\/arena\/tournaments\/([^/]+)\/matches\/([^/]+)\/boosts(?:\/(quote|confirm))?$/);
  if (!match) return null;
  return {
    tournamentId: safeId(decodeURIComponent(match[1])),
    matchRef: safeId(decodeURIComponent(match[2])),
    action: match[3] || "read",
  };
}

function safeBoostUnits(value) {
  try {
    const units = BigInt(String(value));
    return units > 0n && units <= 1_000_000n ? units : null;
  } catch {
    return null;
  }
}

function safeTxHash(value) {
  const hash = String(value || "").trim().toLowerCase();
  return /^0x[a-f0-9]{64}$/.test(hash) ? hash : "";
}

function safeLogIndex(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 1_000_000 ? n : null;
}

function quoteTtlSeconds() {
  const n = Number(process.env.ARENA_BOOST_QUOTE_TTL_SECONDS || DEFAULT_QUOTE_TTL_SECONDS);
  return Number.isInteger(n) && n >= 30 && n <= 600 ? n : DEFAULT_QUOTE_TTL_SECONDS;
}

async function loadTournament(id) {
  const result = await pool.query(
    `select id, chain_id, status, bracket, battle_mode, round_duration_hours, competition_generation
       from public.arena_tournaments where id = $1 limit 1`,
    [id],
  );
  return result.rows[0] || null;
}

async function loadBattle(id) {
  const result = await pool.query(
    `select id, chain_id, state, source, tournament_id, battle_mode, ends_at, competition_generation
       from public.arena_battles where id = $1 limit 1`,
    [id],
  );
  return result.rows[0] || null;
}

function sideForToken(match, token) {
  if (tournamentVoteTokensEqual(token, match.tokenA)) return "left";
  if (tournamentVoteTokensEqual(token, match.tokenB)) return "right";
  return null;
}

function validateVoteTournament(tournament, chainId) {
  if (!tournament) return "Tournament not found";
  if (Number(tournament.chain_id) !== Number(chainId)) return "Tournament Boost chain mismatch";
  if (tournament.battle_mode !== "vote") return "Tournament is not Vote mode";
  if (Number(tournament.round_duration_hours) !== 24) return "Vote Tournament round duration is invalid";
  if (String(tournament.competition_generation || "") !== "arena_competition_v2") return "Tournament is not on Arena competition V2";
  return null;
}

async function activeMatchForQuote(route, tournament, selectedToken) {
  if (tournament.status !== "live") return { error: "Tournament is not live" };
  const match = resolveTournamentVoteMatch({ tournament, matchRef: route.matchRef, selectedToken });
  if (!match.ok) return { error: `Tournament matchup is not Boost-active: ${match.reason}` };
  const battle = await loadBattle(match.battleId);
  if (!battle || battle.state !== "live" || battle.battle_mode !== "vote" || battle.source !== "tournament") {
    return { error: "Vote Tournament battle is not live" };
  }
  if (!battle.ends_at || new Date(battle.ends_at).getTime() <= Date.now()) return { error: "Vote Tournament regulation has ended" };
  const tiebreak = await pool.query(`select battle_id from public.arena_vote_tiebreaks where battle_id = $1 limit 1`, [match.battleId]);
  if (tiebreak.rows[0]) return { error: "Boost is disabled during Final Salvo" };
  return { match, battle };
}

async function readBoostSummary(res, route, tournament) {
  const match = findTournamentVoteMatch({ tournament, matchRef: route.matchRef });
  if (!match.ok) return json(res, 404, { ok: false, error: "Tournament matchup not found", reason: match.reason });
  const result = await pool.query(
    `select side,
            coalesce(sum(boost_units),0)::bigint as boost_units,
            coalesce(sum(points),0)::bigint as boost_points,
            coalesce(sum(gross_native_raw),0)::bigint as gross_native_raw,
            coalesce(sum(pool_native_raw),0)::bigint as pool_native_raw,
            coalesce(sum(protocol_native_raw),0)::bigint as protocol_native_raw
       from public.arena_contest_actions
      where tournament_id = $1 and battle_id = $2 and round_number = $3
        and coalesce(match_id,battle_id) = $4
        and phase = 'regulation' and action_type = 'boost' and confirmed_at is not null
      group by side`,
    [route.tournamentId, match.battleId, match.roundNumber, match.matchId],
  );
  const summary = {
    left: { boostUnits: "0", boostPoints: "0", grossNativeRaw: "0", prizeNativeRaw: "0", protocolNativeRaw: "0" },
    right: { boostUnits: "0", boostPoints: "0", grossNativeRaw: "0", prizeNativeRaw: "0", protocolNativeRaw: "0" },
  };
  for (const row of result.rows || []) {
    if (!summary[row.side]) continue;
    summary[row.side] = {
      boostUnits: String(row.boost_units || 0),
      boostPoints: String(row.boost_points || 0),
      grossNativeRaw: String(row.gross_native_raw || 0),
      prizeNativeRaw: String(row.pool_native_raw || 0),
      protocolNativeRaw: String(row.protocol_native_raw || 0),
    };
  }
  return json(res, 200, {
    ok: true,
    tournamentId: route.tournamentId,
    roundNumber: match.roundNumber,
    matchId: match.matchId,
    battleId: match.battleId,
    usdPerBoost: 1,
    pointsPerBoost: 2,
    split: { prizeBps: 9000, protocolBps: 1000, leagueBps: 0 },
    summary,
    finalSalvoBoostAllowed: false,
    updatedAt: new Date().toISOString(),
  });
}

async function createQuote(req, res, route, tournament) {
  const body = await readJson(req);
  const chainId = Number(tournament.chain_id);
  const wallet = String(body.wallet || body.walletAddress || body.auth?.walletAddress || "").trim().toLowerCase();
  const targetToken = String(body.targetToken || body.tokenAddress || "").trim().toLowerCase();
  const boostUnits = safeBoostUnits(body.boostUnits);
  if (!Number.isInteger(chainId) || chainId <= 0 || chainId === 101 || chainId === 102) {
    return json(res, 400, { ok: false, error: "Tournament Boost quotes currently require an active EVM money path" });
  }
  if (!isAddress(wallet) || !isAddress(targetToken) || !boostUnits) return json(res, 400, { ok: false, error: "Invalid Tournament Boost quote request" });
  const tournamentError = validateVoteTournament(tournament, chainId);
  if (tournamentError) return json(res, 409, { ok: false, error: tournamentError });
  const active = await activeMatchForQuote(route, tournament, targetToken);
  if (active.error) return json(res, 409, { ok: false, error: active.error });

  const auth = await requireWalletActionAuth({
    res,
    pool,
    auth: body.auth,
    expectedWallet: wallet,
    chainId,
    action: "arena_tournament_boost_quote",
    routeLabel: "arena_tournament_boost_quote",
    extraLines: [
      `Tournament: ${route.tournamentId}`,
      `Round: ${active.match.roundNumber}`,
      `Match: ${active.match.matchId}`,
      `Target: ${targetToken}`,
      `Boost Units: ${boostUnits}`,
    ],
  });
  if (!auth || auth.legacy) {
    if (auth?.legacy) return json(res, 401, { ok: false, error: "Tournament Boost quotes require signed wallet authentication" });
    return;
  }

  try {
    const config = readBoostPricingConfig(chainId);
    const now = Math.floor(Date.now() / 1000);
    const deadline = now + quoteTtlSeconds();
    const signed = await signBoostQuote(config, {
      poolId: tournamentBoostPoolId(route.tournamentId),
      matchId: tournamentBoostMatchId({ tournamentId: route.tournamentId, roundNumber: active.match.roundNumber, matchId: active.match.matchId }),
      roundNumber: active.match.roundNumber,
      booster: wallet,
      sideToken: targetToken,
      boostUnits,
      nonce: randomBoostNonce(),
      deadline,
    });
    res.setHeader("cache-control", "no-store");
    return json(res, 200, {
      ok: true,
      tournamentId: route.tournamentId,
      roundNumber: active.match.roundNumber,
      matchId: active.match.matchId,
      battleId: active.match.battleId,
      side: sideForToken(active.match, targetToken),
      usdPerBoostMicros: "1000000",
      pointsPerBoost: 2,
      split: { prizeBps: 9000, protocolBps: 1000, leagueBps: 0 },
      quote: serializeSignedBoostQuote(signed),
      expiresAt: new Date(deadline * 1000).toISOString(),
    });
  } catch (error) {
    console.error("[api/arenaTournamentBoosts] quote failed", error?.message || error);
    return json(res, 503, { ok: false, error: "Tournament Boost pricing is unavailable" });
  }
}

async function confirmBoost(req, res, route, tournament) {
  if (!requireInternalAuth(req, res, { routeLabel: "arena_tournament_boost_confirm" })) return;
  const body = await readJson(req);
  const chainId = Number(tournament.chain_id);
  const txHash = safeTxHash(body.txHash);
  const logIndex = safeLogIndex(body.logIndex);
  const wallet = String(body.wallet || "").trim().toLowerCase();
  const targetToken = String(body.targetToken || body.tokenAddress || "").trim().toLowerCase();
  if (!txHash || logIndex == null || !isAddress(wallet) || !isAddress(targetToken)) return json(res, 400, { ok: false, error: "Invalid confirmed Tournament Boost identity" });
  const tournamentError = validateVoteTournament(tournament, chainId);
  if (tournamentError) return json(res, 409, { ok: false, error: tournamentError });
  const match = findTournamentVoteMatch({ tournament, matchRef: route.matchRef });
  if (!match.ok || !sideForToken(match, targetToken)) return json(res, 409, { ok: false, error: "Tournament Boost target or matchup is invalid" });
  const battle = await loadBattle(match.battleId);
  if (!battle || battle.battle_mode !== "vote" || battle.source !== "tournament" || String(battle.tournament_id) !== route.tournamentId) {
    return json(res, 409, { ok: false, error: "Tournament Boost battle binding is invalid" });
  }

  let split;
  try {
    split = validateConfirmedBoost({
      boostUnits: body.boostUnits,
      grossNativeRaw: body.grossNativeRaw,
      poolNativeRaw: body.poolNativeRaw,
      protocolNativeRaw: body.protocolNativeRaw,
    });
  } catch (error) {
    return json(res, 400, { ok: false, error: error?.message || "Invalid Tournament Boost split" });
  }

  let proof;
  try {
    const provider = await getServerReadProvider(chainId);
    proof = await verifyTournamentBoostPayment({
      provider,
      treasuryAddress: battleBoostTreasuryV2Address(chainId),
      txHash,
      logIndex,
      tournamentId: route.tournamentId,
      roundNumber: match.roundNumber,
      matchId: match.matchId,
      wallet,
      targetToken,
      boostUnits: split.boostUnits,
      grossNativeRaw: split.gross,
    });
  } catch (error) {
    console.error("[api/arenaTournamentBoosts] payment proof failed", error?.message || error);
    return json(res, 409, { ok: false, error: "Tournament Boost payment could not be verified on-chain", code: "TOURNAMENT_BOOST_PAYMENT_UNVERIFIED" });
  }
  if (!proof.confirmedAt || !battle.ends_at || new Date(proof.confirmedAt).getTime() >= new Date(battle.ends_at).getTime()) {
    return json(res, 409, { ok: false, error: "Tournament Boost was not confirmed during regulation", code: "TOURNAMENT_BOOST_OUTSIDE_REGULATION" });
  }

  const side = sideForToken(match, targetToken);
  const points = split.boostUnits * 2n;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const inserted = await client.query(
      `insert into public.arena_contest_actions (
         chain_id, tournament_id, match_id, battle_id, round_number, phase, salvo_index,
         side, wallet, action_type, boost_units, points,
         gross_native_raw, pool_native_raw, protocol_native_raw,
         tx_hash, log_index, confirmed_at
       ) values ($1,$2,$3,$4,$5,'regulation',null,$6,$7,'boost',$8,$9,$10,$11,$12,$13,$14,$15)
       on conflict (chain_id, tx_hash, log_index) where tx_hash is not null and log_index is not null
       do nothing returning *`,
      [
        chainId, route.tournamentId, match.matchId, match.battleId, match.roundNumber,
        side, wallet, split.boostUnits.toString(), points.toString(), split.gross.toString(),
        split.pool.toString(), split.protocol.toString(), txHash, logIndex, proof.confirmedAt,
      ],
    );
    if (!inserted.rows[0]) {
      const existing = await client.query(
        `select * from public.arena_contest_actions where chain_id=$1 and tx_hash=$2 and log_index=$3 limit 1`,
        [chainId, txHash, logIndex],
      );
      await client.query("rollback");
      const row = existing.rows[0];
      const same = row && String(row.tournament_id) === route.tournamentId && String(row.battle_id) === match.battleId && String(row.match_id) === match.matchId && Number(row.round_number) === Number(match.roundNumber) && row.side === side && String(row.wallet).toLowerCase() === wallet && String(row.boost_units) === split.boostUnits.toString() && String(row.points) === points.toString();
      if (!same) return json(res, 409, { ok: false, error: "Transaction log is already bound to another contest action" });
      return json(res, 200, { ok: true, confirmed: true, idempotent: true, actionId: String(row.id), pointsAdded: String(row.points) });
    }
    await client.query("commit");
    return json(res, 201, {
      ok: true,
      confirmed: true,
      idempotent: false,
      actionId: String(inserted.rows[0].id),
      tournamentId: route.tournamentId,
      roundNumber: match.roundNumber,
      matchId: match.matchId,
      battleId: match.battleId,
      side,
      boostUnits: split.boostUnits.toString(),
      pointsAdded: points.toString(),
      grossNativeRaw: split.gross.toString(),
      prizeNativeRaw: split.pool.toString(),
      protocolNativeRaw: split.protocol.toString(),
      split: { prizeBps: 9000, protocolBps: 1000, leagueBps: 0 },
    });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    console.error("[api/arenaTournamentBoosts] confirm failed", error);
    return json(res, 500, { ok: false, error: "Failed to confirm Tournament Boost" });
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  const route = routeInfo(req);
  if (!route?.tournamentId || !route?.matchRef) return json(res, 404, { ok: false, error: "Unknown Tournament Boost route" });
  const method = String(req.method || "GET").toUpperCase();
  try {
    const tournament = await loadTournament(route.tournamentId);
    if (!tournament) return json(res, 404, { ok: false, error: "Tournament not found" });
    if (route.action === "read") return method === "GET" ? readBoostSummary(res, route, tournament) : badMethod(res);
    if (route.action === "quote") return method === "POST" ? createQuote(req, res, route, tournament) : badMethod(res);
    if (route.action === "confirm") return method === "POST" ? confirmBoost(req, res, route, tournament) : badMethod(res);
    return json(res, 404, { ok: false, error: "Unknown Tournament Boost route" });
  } catch (error) {
    console.error("[api/arenaTournamentBoosts]", error);
    return json(res, 503, { ok: false, error: "Tournament Boost runtime is unavailable", detail: String(error?.message || error) });
  }
}
