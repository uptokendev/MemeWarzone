import { pool } from "../server/db.js";
import { badMethod, json, readJson } from "../server/http.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";
import { battlePoolId } from "./lib/arenaWarPoolEscrow.js";
import { tournamentPoolIdV2 } from "./lib/arenaTournamentBuyInV2.mjs";
import { resolveTournamentVoteMatch, tournamentVoteTokensEqual } from "./lib/arenaTournamentVoteRuntime.mjs";
import { boostSummary, serializeBoostSummary } from "./lib/arenaBoostRuntime.mjs";
import { connectionForArenaMoneyV2, readCompetitionPoolV2 } from "./lib/solanaArenaMoneyV2Read.js";
import {
  assertSolanaPubkey,
  buildSolanaBoostInstructionRequirements,
  quoteSolanaBoost,
  randomMoneyId32,
  verifySolanaBoostPayment,
} from "./lib/solanaArenaMoneyV2Runtime.mjs";

const QUOTE_TTL_SECONDS = 300;
const UNRESOLVED = new Set(["submitted", "confirming", "recovering", "verifying"]);
const TERMINAL_RETRYABLE = new Set(["failed", "expired"]);

function routeInfo(req) {
  const path = String(req.path || new URL(req.url, "http://localhost").pathname);
  let m = path.match(/^\/arena\/boosts\/([^/]+)\/(solana-quote|solana-submission|solana-state|solana-expire|solana-payment)$/);
  if (m) return { product: "normal_battle", battleId: decodeURIComponent(m[1]), action: m[2] };
  m = path.match(/^\/arena\/tournaments\/([^/]+)\/matches\/([^/]+)\/boosts\/(solana-quote|solana-submission|solana-state|solana-expire|solana-payment)$/);
  if (m) return { product: "vote_tournament", tournamentId: decodeURIComponent(m[1]), matchRef: decodeURIComponent(m[2]), action: m[3] };
  return null;
}

function queryOf(req) { return new URL(req.url, "http://localhost").searchParams; }
function positiveUnits(value) { try { const n = BigInt(String(value)); return n > 0n && n <= 1_000_000n ? n : null; } catch { return null; } }
function validateSolanaChain(chainId) { return [101, 102].includes(Number(chainId)); }
function exactSolanaSide(participants, token) {
  if (!Array.isArray(participants) || participants.length < 2) return null;
  const idOf = (p) => String(p?.tokenId || p?.tokenAddress || p?.campaignAddress || "").trim();
  if (idOf(participants[0]) === token) return "left";
  if (idOf(participants[1]) === token) return "right";
  return null;
}

async function loadBattle(id, db = pool) {
  return (await db.query(`select id,chain_id,state,source,tournament_id,battle_mode,ends_at,competition_generation,participants from public.arena_battles where id=$1 limit 1`, [id])).rows[0] || null;
}
async function loadTournament(id, db = pool) {
  return (await db.query(`select id,chain_id,status,bracket,battle_mode,round_duration_hours,competition_generation from public.arena_tournaments where id=$1 limit 1`, [id])).rows[0] || null;
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
  const salvo = (await pool.query(`select battle_id from public.arena_vote_tiebreaks where battle_id=$1 limit 1`, [match.battleId])).rows[0];
  if (salvo) return { error: "Boost is disabled during Final Salvo", status: 409, code: "FINAL_SALVO_BOOST_DISABLED" };
  const side = tournamentVoteTokensEqual(token, match.tokenA) ? "left" : tournamentVoteTokensEqual(token, match.tokenB) ? "right" : null;
  if (!side) return { error: "Boost target is not in this matchup", status: 409 };
  const competitionId = tournamentPoolIdV2(route.tournamentId);
  const onchain = await readCompetitionPoolV2(chainId, competitionId);
  if (!onchain.live || !onchain.opened || ![0, 1].includes(Number(onchain.pool?.state)) || Number(onchain.pool?.kind) !== 1) return { error: "Solana Tournament CompetitionPoolV2 is not active", status: 503, code: "SOLANA_COMPETITION_POOL_NOT_ACTIVE" };
  return { tournament, battle, match, chainId, targetToken: token, side, competitionId, onchain, pointsPerBoost: 2 };
}

async function buildContext(route, targetToken) { return route.product === "normal_battle" ? normalContext(route, targetToken) : tournamentContext(route, targetToken); }

async function tournamentPaymentContext(route, quote) {
  const tournament = await loadTournament(route.tournamentId);
  if (!tournament) return { error: "Tournament not found", status: 404 };
  const chainId = Number(tournament.chain_id);
  if (!validateSolanaChain(chainId) || tournament.battle_mode !== "vote" || Number(tournament.round_duration_hours) !== 24 || tournament.competition_generation !== "arena_competition_v2") return { error: "Stored Tournament Boost no longer matches Vote Tournament authority", status: 409, code: "SOLANA_BOOST_STATE_CHANGED" };
  let token;
  try { token = assertSolanaPubkey(quote.target_token, "targetToken"); } catch (error) { return { error: error.message, status: 400 }; }
  const match = resolveTournamentVoteMatch({ tournament, matchRef: route.matchRef, selectedToken: token });
  if (!match.ok || String(match.matchId) !== String(quote.match_id) || Number(match.roundNumber) !== Number(quote.round_number) || String(match.battleId) !== String(quote.battle_id)) return { error: "Stored Tournament Boost quote no longer matches its authoritative matchup", status: 409, code: "SOLANA_BOOST_STATE_CHANGED" };
  const battle = await loadBattle(match.battleId);
  if (!battle || battle.battle_mode !== "vote" || battle.source !== "tournament" || String(battle.tournament_id || "") !== String(route.tournamentId) || battle.competition_generation !== "arena_competition_v2") return { error: "Stored Tournament Boost battle no longer matches tournament authority", status: 409, code: "SOLANA_BOOST_STATE_CHANGED" };
  const side = tournamentVoteTokensEqual(token, match.tokenA) ? "left" : tournamentVoteTokensEqual(token, match.tokenB) ? "right" : null;
  const competitionId = tournamentPoolIdV2(route.tournamentId);
  if (!side || side !== quote.side || competitionId.toLowerCase() !== String(quote.competition_id).toLowerCase()) return { error: "Stored Tournament Boost authority changed", status: 409, code: "SOLANA_BOOST_STATE_CHANGED" };
  return { tournament, battle, match, chainId, targetToken: token, side, competitionId, pointsPerBoost: 2 };
}
async function paymentContext(route, quote) { return route.product === "vote_tournament" ? tournamentPaymentContext(route, quote) : normalContext(route, quote.target_token); }

function sameQuote(row, route) {
  if (!row || row.product_kind !== route.product) return false;
  return route.product === "normal_battle" ? String(row.battle_id) === route.battleId : String(row.tournament_id) === route.tournamentId;
}

function publicBoostState(row) {
  if (!row) return { exists: false, unresolved: false, status: "none", newPaymentAllowed: true, confirmed: false, retryable: true };
  const status = String(row.payment_status || (row.consumed_at ? "confirmed" : row.signature_reference ? "submitted" : "pending"));
  const unresolved = UNRESOLVED.has(status);
  return {
    exists: true,
    unresolved,
    status,
    newPaymentAllowed: !unresolved && (status === "confirmed" || status === "pending" || TERMINAL_RETRYABLE.has(status)),
    confirmed: status === "confirmed",
    retryable: TERMINAL_RETRYABLE.has(status) || status === "pending",
    quoteId: String(row.id),
    paymentId: String(row.funding_id),
    signature: row.signature_reference || null,
    receiptPda: row.receipt_pda || null,
    submittedAt: row.submitted_at || null,
    expiresAt: row.expires_at || null,
    reason: row.status_reason || null,
    operation: {
      product: row.product_kind,
      tournamentId: row.tournament_id || null,
      battleId: row.battle_id,
      matchId: row.match_id || null,
      roundNumber: Number(row.round_number || 0),
      wallet: row.wallet,
      targetToken: row.target_token,
      side: row.side,
      boostUnits: String(row.boost_units),
      pointsPerBoost: Number(row.points_per_boost),
      chainId: Number(row.chain_id),
    },
    recovery: row.signature_reference ? {
      signature: row.signature_reference,
      blockhash: row.signature_blockhash,
      lastValidBlockHeight: Number(row.signature_last_valid_block_height),
      chainId: Number(row.chain_id),
      wallet: row.wallet,
      programId: null,
      metadata: { quoteId: String(row.id), tournamentId: row.tournament_id || "", matchRef: row.match_id || "", targetToken: row.target_token },
      createdAt: row.submitted_at || row.created_at,
    } : null,
  };
}

async function latestOperationQuote(route, wallet, targetToken, db = pool) {
  const params = [route.product, wallet, targetToken];
  let scope;
  if (route.product === "vote_tournament") { params.push(route.tournamentId); scope = `tournament_id=$4`; }
  else { params.push(route.battleId); scope = `battle_id=$4`; }
  return (await db.query(`select * from public.arena_solana_boost_quotes where product_kind=$1 and wallet=$2 and target_token=$3 and ${scope} order by created_at desc limit 1`, params)).rows[0] || null;
}

async function markFromChainIfTerminal(row) {
  if (!row?.signature_reference || !UNRESOLVED.has(String(row.payment_status))) return row;
  const connection = connectionForArenaMoneyV2(Number(row.chain_id));
  try {
    const [statusResult, height] = await Promise.all([
      connection.getSignatureStatuses([row.signature_reference], { searchTransactionHistory: true }),
      connection.getBlockHeight("confirmed"),
    ]);
    const status = statusResult?.value?.[0] || null;
    if (status?.err) {
      return (await pool.query(`update public.arena_solana_boost_quotes set payment_status='failed',status_reason='signature_failed',updated_at=now() where id=$1 returning *`, [row.id])).rows[0];
    }
    if (status) {
      await pool.query(`update public.arena_solana_boost_quotes set payment_status='confirming',updated_at=now() where id=$1 and payment_status in ('submitted','recovering')`, [row.id]);
      return { ...row, payment_status: "confirming" };
    }
    if (Number.isFinite(Number(row.signature_last_valid_block_height)) && Number(height) > Number(row.signature_last_valid_block_height)) {
      const tx = await connection.getTransaction(row.signature_reference, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
      if (!tx) return (await pool.query(`update public.arena_solana_boost_quotes set payment_status='expired',status_reason='blockheight_expired_non_landed',updated_at=now() where id=$1 returning *`, [row.id])).rows[0];
    }
  } catch {
    // RPC ambiguity is not terminal. Keep the durable signature unresolved.
  }
  return row;
}

async function handleState(req, res, route) {
  const query = queryOf(req);
  let wallet, targetToken;
  try {
    wallet = assertSolanaPubkey(query.get("wallet") || query.get("walletAddress"), "wallet");
    targetToken = assertSolanaPubkey(query.get("targetToken"), "targetToken");
  } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
  let row = await latestOperationQuote(route, wallet, targetToken);
  if (row?.signature_reference) {
    const action = (await pool.query(`select * from public.arena_contest_actions where chain_id=$1 and signature_reference=$2 limit 1`, [row.chain_id, row.signature_reference])).rows[0];
    if (action) row = (await pool.query(`update public.arena_solana_boost_quotes set payment_status='confirmed',consumed_at=coalesce(consumed_at,$2),updated_at=now() where id=$1 returning *`, [row.id, action.confirmed_at || new Date().toISOString()])).rows[0];
    else row = await markFromChainIfTerminal(row);
  } else if (row && new Date(row.expires_at).getTime() <= Date.now()) {
    row = (await pool.query(`update public.arena_solana_boost_quotes set payment_status='expired',status_reason='unsigned_quote_expired',updated_at=now() where id=$1 returning *`, [row.id])).rows[0];
  }
  res.setHeader("cache-control", "no-store");
  return json(res, 200, { ok: true, payment: publicBoostState(row) });
}

async function createQuote(req, res, route) {
  const body = await readJson(req);
  const units = positiveUnits(body.boostUnits);
  if (!units) return json(res, 400, { ok: false, error: "boostUnits must be a positive integer" });
  const context = await buildContext(route, body.targetToken);
  if (context.error) return json(res, context.status, { ok: false, error: context.error, code: context.code });
  let wallet;
  try { wallet = assertSolanaPubkey(body.wallet || body.walletAddress || body.auth?.walletAddress, "wallet"); } catch (error) { return json(res, 400, { ok: false, error: error.message }); }

  let prior = await latestOperationQuote(route, wallet, context.targetToken);
  prior = await markFromChainIfTerminal(prior);
  const priorState = publicBoostState(prior);
  if (priorState.unresolved) return json(res, 409, { ok: false, error: "A Solana Boost payment for this operation is still unresolved", code: "SOLANA_BOOST_PAYMENT_UNRESOLVED", payment: priorState });

  const auth = await requireWalletActionAuth({
    res, pool, auth: body.auth || body, expectedWallet: wallet, chainId: context.chainId,
    action: route.product === "normal_battle" ? "arena_battle_boost_quote" : "arena_tournament_boost_quote",
    routeLabel: route.product === "normal_battle" ? "arena/boosts/solana-quote" : "arena/tournaments/boosts/solana-quote",
    extraLines: [route.product === "normal_battle" ? `Battle: ${route.battleId}` : `Tournament: ${route.tournamentId}`,
      ...(context.match ? [`Round: ${context.match.roundNumber}`, `Match: ${context.match.matchId}`] : []), `Target: ${context.targetToken}`, `Boost Units: ${units}`],
  });
  if (!auth || auth.legacy) return auth?.legacy ? json(res, 401, { ok: false, error: "Signed wallet authentication is required" }) : undefined;

  let money;
  try { money = quoteSolanaBoost({ chainId: context.chainId, boostUnits: units }); }
  catch (error) { return json(res, 503, { ok: false, error: "SOL Boost pricing is unavailable", detail: String(error?.message || error) }); }
  const fundingId = randomMoneyId32();
  const requirements = buildSolanaBoostInstructionRequirements({ competitionId: context.competitionId, fundingId, wallet, grossLamports: money.gross });
  const expiresAt = new Date(Date.now() + QUOTE_TTL_SECONDS * 1000).toISOString();
  const inserted = (await pool.query(
    `insert into public.arena_solana_boost_quotes (chain_id,product_kind,battle_id,tournament_id,match_id,round_number,competition_id,funding_id,wallet,target_token,side,boost_units,points_per_boost,gross_lamports,prize_lamports,protocol_lamports,native_usd_micros,pricing_version,oracle_timestamp,receipt_pda,expires_at,payment_status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,to_timestamp($19),$20,$21,'pending') returning id`,
    [context.chainId, route.product, context.battle.id, route.tournamentId || null, context.match?.matchId || null, context.match?.roundNumber || 0, context.competitionId, fundingId, wallet, context.targetToken, context.side, units.toString(), context.pointsPerBoost, money.gross.toString(), money.prize.toString(), money.protocol.toString(), money.nativeUsdMicros.toString(), money.pricingVersion.toString(), money.oracleTimestamp.toString(), requirements.receiptPda, expiresAt],
  )).rows[0];
  res.setHeader("cache-control", "no-store");
  return json(res, 201, { ok: true, quoteId: inserted.id, product: route.product, chainId: context.chainId, battleId: context.battle.id, tournamentId: route.tournamentId || null, matchId: context.match?.matchId || null, roundNumber: context.match?.roundNumber || 0, side: context.side, targetToken: context.targetToken, boostUnits: units.toString(), pointsPerBoost: context.pointsPerBoost, usdPerBoostMicros: "1000000", grossLamports: money.gross.toString(), prizeLamports: money.prize.toString(), protocolLamports: money.protocol.toString(), split: { prizeBps: 9000, protocolBps: 1000, leagueBps: 0 }, competitionId: context.competitionId, fundingId, transaction: requirements, expiresAt, newPaymentAllowed: true, battlePointsV3: { boostCurveVersion: "boost_hyperbolic_100_v1", scoringActive: false, boostPoints: null } });
}

async function handleSubmission(req, res, route) {
  const body = await readJson(req);
  const quoteId = String(body.quoteId || "").trim();
  const signature = String(body.signature || "").trim();
  const blockhash = String(body.blockhash || "").trim();
  const lastValidBlockHeight = Number(body.lastValidBlockHeight);
  if (!quoteId || !signature || !blockhash || !Number.isFinite(lastValidBlockHeight)) return json(res, 400, { ok: false, error: "quoteId, signature, blockhash and lastValidBlockHeight are required" });
  const client = await pool.connect();
  try {
    await client.query("begin");
    const quote = (await client.query(`select * from public.arena_solana_boost_quotes where id=$1 for update`, [quoteId])).rows[0];
    if (!sameQuote(quote, route)) { await client.query("rollback"); return json(res, 404, { ok: false, error: "Solana Boost quote not found for this route" }); }
    if (quote.signature_reference && quote.signature_reference !== signature) { await client.query("rollback"); return json(res, 409, { ok: false, error: "Boost quote is already bound to another signature", code: "SOLANA_BOOST_SIGNATURE_BOUND" }); }
    const auth = await requireWalletActionAuth({ res, pool: client, auth: body.auth || body, expectedWallet: quote.wallet, chainId: Number(quote.chain_id), action: route.product === "normal_battle" ? "arena_battle_boost_submission" : "arena_tournament_boost_submission", routeLabel: "arena/solana-boost-submission", extraLines: [`Quote: ${quote.id}`, `Funding: ${quote.funding_id}`] });
    if (!auth || auth.legacy) { await client.query("rollback"); return auth?.legacy ? json(res, 401, { ok: false, error: "Signed wallet authentication is required" }) : undefined; }
    const row = (await client.query(`update public.arena_solana_boost_quotes set signature_reference=$2,signature_blockhash=$3,signature_last_valid_block_height=$4,payment_status=case when payment_status='confirmed' then 'confirmed' else 'submitted' end,submitted_at=coalesce(submitted_at,now()),status_reason=null,updated_at=now() where id=$1 returning *`, [quote.id, signature, blockhash, lastValidBlockHeight])).rows[0];
    await client.query("commit");
    return json(res, 200, { ok: true, payment: publicBoostState(row) });
  } catch (error) { await client.query("rollback").catch(() => {}); throw error; } finally { client.release(); }
}

async function handleExpire(req, res, route) {
  const body = await readJson(req);
  const quoteId = String(body.quoteId || "").trim();
  const signature = String(body.signature || "").trim();
  const row = (await pool.query(`select * from public.arena_solana_boost_quotes where id=$1`, [quoteId])).rows[0];
  if (!sameQuote(row, route) || row.signature_reference !== signature) return json(res, 404, { ok: false, error: "Durable Boost payment not found" });
  const connection = connectionForArenaMoneyV2(Number(row.chain_id));
  const [statuses, height, tx] = await Promise.all([
    connection.getSignatureStatuses([signature], { searchTransactionHistory: true }),
    connection.getBlockHeight("confirmed"),
    connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null),
  ]);
  if (statuses?.value?.[0] || tx || Number(height) <= Number(row.signature_last_valid_block_height)) return json(res, 409, { ok: false, error: "Original signature is not proven expired/non-landed", code: "SOLANA_BOOST_STILL_UNRESOLVED" });
  const updated = (await pool.query(`update public.arena_solana_boost_quotes set payment_status='expired',status_reason='blockheight_expired_non_landed',updated_at=now() where id=$1 and signature_reference=$2 returning *`, [quoteId, signature])).rows[0];
  return json(res, 200, { ok: true, payment: publicBoostState(updated) });
}

async function confirmPayment(req, res, route) {
  const body = await readJson(req);
  const quoteId = String(body.quoteId || "").trim();
  const signature = String(body.signature || body.txSignature || "").trim();
  if (!quoteId || !signature) return json(res, 400, { ok: false, error: "quoteId and signature are required" });
  const client = await pool.connect();
  try {
    await client.query("begin");
    const quote = (await client.query(`select * from public.arena_solana_boost_quotes where id=$1 for update`, [quoteId])).rows[0];
    if (!sameQuote(quote, route)) { await client.query("rollback"); return json(res, 404, { ok: false, error: "Solana Boost quote not found for this route" }); }
    if (quote.signature_reference && quote.signature_reference !== signature) { await client.query("rollback"); return json(res, 409, { ok: false, error: "Boost quote is bound to another signature" }); }
    const existing = (await client.query(`select * from public.arena_contest_actions where chain_id=$1 and signature_reference=$2 limit 1`, [quote.chain_id, signature])).rows[0];
    if (existing) {
      await client.query(`update public.arena_solana_boost_quotes set payment_status='confirmed',consumed_at=coalesce(consumed_at,$2),signature_reference=$3,updated_at=now() where id=$1`, [quote.id, existing.confirmed_at || new Date().toISOString(), signature]);
      await client.query("commit");
      return json(res, 200, { ok: true, confirmed: true, idempotent: true, signature, action: existing });
    }
    const auth = await requireWalletActionAuth({ res, pool: client, auth: body.auth || body, expectedWallet: quote.wallet, chainId: Number(quote.chain_id), action: route.product === "normal_battle" ? "arena_battle_boost_payment" : "arena_tournament_boost_payment", routeLabel: "arena/solana-boost-payment", extraLines: [`Quote: ${quote.id}`, `Signature: ${signature}`] });
    if (!auth || auth.legacy) { await client.query("rollback"); return auth?.legacy ? json(res, 401, { ok: false, error: "Signed wallet authentication is required" }) : undefined; }
    await client.query(`update public.arena_solana_boost_quotes set signature_reference=$2,payment_status='verifying',submitted_at=coalesce(submitted_at,now()),updated_at=now() where id=$1`, [quote.id, signature]);
    const context = await paymentContext(route, quote);
    if (context.error || String(context.battle.id) !== String(quote.battle_id) || context.side !== quote.side || context.competitionId.toLowerCase() !== String(quote.competition_id).toLowerCase()) { await client.query("rollback"); return json(res, context.status || 409, { ok: false, error: context.error || "Boost quote no longer matches authoritative Arena state", code: context.code || "SOLANA_BOOST_STATE_CHANGED" }); }
    let proof;
    try { proof = await verifySolanaBoostPayment({ chainId: quote.chain_id, signature, competitionId: quote.competition_id, fundingId: quote.funding_id, funder: quote.wallet, grossLamports: quote.gross_lamports, prizeLamports: quote.prize_lamports, protocolLamports: quote.protocol_lamports }); }
    catch (error) { await client.query(`update public.arena_solana_boost_quotes set payment_status='recovering',status_reason=$2,updated_at=now() where id=$1`, [quote.id, String(error?.message || error)]); await client.query("commit"); return json(res, 409, { ok: false, error: "Solana Boost payment is not authoritative yet", code: "SOLANA_BOOST_PAYMENT_UNVERIFIED", reason: String(error?.message || error), payment: publicBoostState({ ...quote, signature_reference: signature, payment_status: "recovering" }) }); }
    const receiptMs = Number(proof.receipt.createdAt) * 1000;
    if (receiptMs > new Date(quote.expires_at).getTime()) { await client.query(`update public.arena_solana_boost_quotes set payment_status='failed',status_reason='receipt_after_quote_expiry',updated_at=now() where id=$1`, [quote.id]); await client.query("commit"); return json(res, 409, { ok: false, error: "Boost payment was created after quote expiry", code: "SOLANA_BOOST_QUOTE_EXPIRED" }); }
    if (route.product === "vote_tournament" && (!context.battle.ends_at || receiptMs >= new Date(context.battle.ends_at).getTime())) { await client.query(`update public.arena_solana_boost_quotes set payment_status='failed',status_reason='outside_regulation',updated_at=now() where id=$1`, [quote.id]); await client.query("commit"); return json(res, 409, { ok: false, error: "Tournament Boost was not paid during regulation", code: "TOURNAMENT_BOOST_OUTSIDE_REGULATION" }); }
    const points = route.product === "vote_tournament" ? BigInt(quote.boost_units) * 2n : 0n;
    const inserted = (await client.query(`insert into public.arena_contest_actions (chain_id,tournament_id,battle_id,match_id,round_number,phase,salvo_index,side,wallet,action_type,boost_units,points,gross_native_raw,pool_native_raw,protocol_native_raw,tx_hash,log_index,signature_reference,confirmed_at) values ($1,$2,$3,$4,$5,'regulation',null,$6,$7,'boost',$8,$9,$10,$11,$12,$13,0,$13,to_timestamp($14)) on conflict (chain_id,signature_reference) where signature_reference is not null do nothing returning *`, [quote.chain_id,quote.tournament_id,quote.battle_id,quote.match_id,quote.round_number,quote.side,quote.wallet,quote.boost_units,points.toString(),quote.gross_lamports,quote.prize_lamports,quote.protocol_lamports,signature,proof.receipt.createdAt])).rows[0];
    if (!inserted) { const row = (await client.query(`select * from public.arena_contest_actions where chain_id=$1 and signature_reference=$2 limit 1`, [quote.chain_id,signature])).rows[0]; await client.query(`update public.arena_solana_boost_quotes set payment_status='confirmed',consumed_at=coalesce(consumed_at,now()),updated_at=now() where id=$1`, [quote.id]); await client.query("commit"); return json(res, 200, { ok: true, confirmed: true, idempotent: true, signature, action: row || null }); }
    await client.query(`update public.arena_solana_boost_quotes set consumed_at=now(),signature_reference=$2,payment_status='confirmed',status_reason=null,updated_at=now() where id=$1`, [quote.id,signature]);
    if (route.product === "normal_battle") await client.query(`insert into public.arena_battle_points_v3 (battle_id,token_id,side,boost_units,boost_gross_native_raw,boost_pool_native_raw,boost_protocol_native_raw) values ($1,$2,$3,$4,$5,$6,$7) on conflict (battle_id,side) do update set boost_units=public.arena_battle_points_v3.boost_units+excluded.boost_units,boost_gross_native_raw=public.arena_battle_points_v3.boost_gross_native_raw+excluded.boost_gross_native_raw,boost_pool_native_raw=public.arena_battle_points_v3.boost_pool_native_raw+excluded.boost_pool_native_raw,boost_protocol_native_raw=public.arena_battle_points_v3.boost_protocol_native_raw+excluded.boost_protocol_native_raw,metrics_updated_at=now(),updated_at=now()`, [quote.battle_id,quote.target_token,quote.side,quote.boost_units,quote.gross_lamports,quote.prize_lamports,quote.protocol_lamports]);
    await client.query("commit");
    const rows = (await pool.query(`select side,boost_units,gross_native_raw,pool_native_raw,protocol_native_raw from public.arena_contest_actions where battle_id=$1 and action_type='boost' and phase='regulation' and confirmed_at is not null`, [quote.battle_id])).rows;
    return json(res, 201, { ok: true, confirmed: true, idempotent: false, signature, receiptPda: proof.receiptPda, action: inserted, summary: serializeBoostSummary(boostSummary(rows)), pointsPerBoost: Number(quote.points_per_boost), battlePointsV3: { boostCurveVersion: "boost_hyperbolic_100_v1", scoringActive: false, boostPoints: null } });
  } catch (error) { await client.query("rollback").catch(() => {}); console.error("[api/arenaSolanaBoosts] payment failed", error); return json(res, 500, { ok: false, error: "Failed to confirm Solana Boost" }); } finally { client.release(); }
}

export default async function handler(req, res) {
  const route = routeInfo(req);
  if (!route) return json(res, 404, { ok: false, error: "Unknown Solana Boost route" });
  const method = String(req.method || "GET").toUpperCase();
  if (route.action === "solana-state") return method === "GET" ? handleState(req, res, route) : badMethod(res);
  if (method !== "POST") return badMethod(res);
  if (route.action === "solana-quote") return createQuote(req, res, route);
  if (route.action === "solana-submission") return handleSubmission(req, res, route);
  if (route.action === "solana-expire") return handleExpire(req, res, route);
  return confirmPayment(req, res, route);
}
