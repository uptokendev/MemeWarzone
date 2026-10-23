/**
 * EVM Boost backstop (2026-10-15). A BNB / Robinhood Boost is paid on chain and recorded when the
 * browser reports its transaction (POST /arena/boosts/evm-payment, or the tournament equivalent).
 * If the browser never reports (tab closed, network drop), this run, every minute in the realtime
 * worker, records it from the quote reservation (arenaBoostRules.js):
 *
 *   1. unrecorded reservations whose quote deadline has passed (the payment, if any, is final)
 *   2. treasury usedBoostNonces(wallet, nonce): false -> void (never paid, the treasury refuses it
 *      from now on); true -> paid
 *   3. find the BattleBoosted / TournamentBoosted log by its indexed topics in the few blocks between
 *      quote and deadline, then record it through the same function the routes use, which verifies
 *      every field against the chain event again
 *
 * A payment the record function refuses for good (battle no longer live, outside regulation) is
 * marked recorded with record_note so it is not retried every minute. RPC and server errors retry.
 */
import { Contract, getAddress, id, toBeHex, zeroPadValue } from "ethers";

import { recordBattleBoostPayment } from "../arenaBoosts.js";
import { recordTournamentBoostPayment } from "../arenaTournamentBoosts.js";
import { expectedBattleBoostPoolId, decodeBattleBoostLog } from "./arenaBoostChainVerification.mjs";
import { expectedBoostSplit } from "./arenaBoostRuntime.mjs";
import { EVM_RESERVATION_SETTLE_GRACE_MS } from "./arenaBoostRules.js";
import { decodeTournamentBoostLog, tournamentBoostMatchId, tournamentBoostPoolId } from "./arenaTournamentBoostVerification.mjs";
import { getServerReadProvider } from "./getServerReadProvider.js";

export const BATTLE_BOOSTED_TOPIC = id("BattleBoosted(bytes32,address,address,uint256,uint256,uint256,uint256,uint256,uint256)");
export const TOURNAMENT_BOOSTED_TOPIC = id("TournamentBoosted(bytes32,bytes32,uint256,address,address,uint256,uint256,uint256,uint256,uint256,uint256)");

const USED_BOOST_NONCES_ABI = ["function usedBoostNonces(address,uint256) view returns (bool)"];
const LOG_CHUNK_BLOCKS = 2_000;
const BLOCK_TIME_SAMPLE = 1_000;
const RANGE_MARGIN_SECONDS = 180;

export function reconcileEnabled(env = process.env) {
  return !/^(0|false|no|off)$/i.test(String(env.ARENA_EVM_BOOST_RECONCILE ?? "").trim());
}

function ms(value) {
  return value instanceof Date ? value.getTime() : Date.parse(String(value));
}

/** Block range that holds every block mined between `fromMs` and `toMs`, with margin both ways. */
export async function blockRangeFor(provider, fromMs, toMs) {
  const latest = Number(await provider.getBlockNumber());
  const sampleStart = Math.max(0, latest - BLOCK_TIME_SAMPLE);
  const [head, sample] = await Promise.all([provider.getBlock(latest), provider.getBlock(sampleStart)]);
  const headTime = Number(head?.timestamp);
  const sampleTime = Number(sample?.timestamp);
  if (!Number.isFinite(headTime) || !Number.isFinite(sampleTime) || latest === sampleStart) throw new Error("block timestamps unavailable");
  const secondsPerBlock = Math.max(0.05, (headTime - sampleTime) / (latest - sampleStart));
  const blocksBack = (seconds) => Math.max(0, seconds) / secondsPerBlock;
  // Wide on both ends: block times drift, and a mined block's timestamp can trail wall clock.
  const fromBlock = Math.max(0, latest - Math.ceil(blocksBack(headTime - fromMs / 1000 + RANGE_MARGIN_SECONDS) * 1.5));
  const toBlock = Math.min(latest, Math.max(fromBlock, latest - Math.floor(blocksBack(headTime - toMs / 1000 - RANGE_MARGIN_SECONDS) * 0.5)));
  return { fromBlock, toBlock };
}

function logTopics(row) {
  const wallet = zeroPadValue(getAddress(String(row.wallet)), 32);
  if (row.tournament_id) {
    return [
      TOURNAMENT_BOOSTED_TOPIC,
      tournamentBoostPoolId(row.tournament_id),
      tournamentBoostMatchId({ tournamentId: row.tournament_id, roundNumber: Number(row.round_number), matchId: row.match_id }),
      zeroPadValue(toBeHex(BigInt(row.round_number)), 32),
    ];
  }
  return [BATTLE_BOOSTED_TOPIC, expectedBattleBoostPoolId(row.battle_id), wallet];
}

/** The log that paid this reservation (matched by booster and nonce), or null. */
export async function findReservationLog(provider, row) {
  const { fromBlock, toBlock } = await blockRangeFor(provider, ms(row.created_at), ms(row.deadline));
  const topics = logTopics(row);
  const decode = row.tournament_id ? decodeTournamentBoostLog : decodeBattleBoostLog;
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK_BLOCKS) {
    const end = Math.min(toBlock, start + LOG_CHUNK_BLOCKS - 1);
    const logs = await provider.getLogs({ address: row.treasury_address, topics, fromBlock: start, toBlock: end });
    for (const log of logs || []) {
      let event;
      try { event = decode(log, { treasuryAddress: row.treasury_address }); } catch { continue; }
      if (event.booster.toLowerCase() !== String(row.wallet).toLowerCase()) continue;
      if (event.nonce.toString() !== String(row.nonce)) continue;
      return { txHash: String(log.transactionHash).toLowerCase(), logIndex: Number(log.index ?? log.logIndex), event };
    }
  }
  return null;
}

async function loadTournament(db, tournamentId) {
  return (await db.query(
    `select id, chain_id, status, bracket, battle_mode, round_duration_hours, competition_generation
       from public.arena_tournaments where id = $1 limit 1`,
    [tournamentId],
  )).rows[0] || null;
}

function recordBody(row, found) {
  const split = expectedBoostSplit(found.event.grossNativeRaw);
  return {
    chainId: Number(row.chain_id),
    battleId: row.battle_id,
    txHash: found.txHash,
    logIndex: found.logIndex,
    wallet: found.event.booster.toLowerCase(),
    targetToken: found.event.sideToken.toLowerCase(),
    boostUnits: found.event.boostUnits.toString(),
    grossNativeRaw: split.gross.toString(),
    poolNativeRaw: split.pool.toString(),
    protocolNativeRaw: split.protocol.toString(),
  };
}

const defaultRecorders = {
  battle: recordBattleBoostPayment,
  tournament: recordTournamentBoostPayment,
};

export async function reconcileEvmBoostPayments({
  db,
  nowMs = Date.now(),
  limit = 25,
  getProvider = getServerReadProvider,
  recorders = defaultRecorders,
  readNonceUsed = null,
  logger = console,
} = {}) {
  const rows = (await db.query(
    `select id, chain_id, battle_id, tournament_id, round_number, match_id, wallet, nonce::text as nonce,
            treasury_address, deadline, created_at, status
       from public.arena_boost_quote_reservations
      where recorded_at is null and status in ('pending', 'paid') and deadline < $1
      order by created_at asc
      limit $2`,
    [new Date(nowMs).toISOString(), limit],
  )).rows || [];
  const providers = new Map();
  const providerFor = async (chainId) => {
    if (!providers.has(chainId)) providers.set(chainId, await getProvider(chainId));
    return providers.get(chainId);
  };
  const summary = { checked: rows.length, recorded: 0, voided: 0, refused: 0, pending: 0, errors: [] };

  for (const row of rows) {
    const chainId = Number(row.chain_id);
    try {
      const provider = await providerFor(chainId);
      const used = readNonceUsed
        ? await readNonceUsed(row)
        : Boolean(await new Contract(row.treasury_address, USED_BOOST_NONCES_ABI, provider).usedBoostNonces(row.wallet, BigInt(row.nonce)));
      if (!used) {
        if (ms(row.deadline) + EVM_RESERVATION_SETTLE_GRACE_MS < nowMs) {
          await db.query(
            `update public.arena_boost_quote_reservations set status = 'void', resolved_at = now() where id = $1 and status = 'pending' and recorded_at is null`,
            [row.id],
          );
          summary.voided += 1;
        } else {
          summary.pending += 1;
        }
        continue;
      }

      const found = await findReservationLog(provider, row);
      if (!found) {
        summary.pending += 1;
        logger.warn?.(`[arenaEvmBoostReconcile] reservation ${row.id} nonce used on chain but its log was not found yet`);
        continue;
      }

      const body = recordBody(row, found);
      let result;
      if (row.tournament_id) {
        const tournament = await loadTournament(db, row.tournament_id);
        if (!tournament) result = { status: 404, body: { ok: false, error: "Tournament not found" } };
        else result = await recorders.tournament({ route: { tournamentId: String(row.tournament_id), matchRef: String(row.match_id) }, tournament, body, provider });
      } else {
        result = await recorders.battle(body, { provider });
      }

      if (result.status === 200 || result.status === 201) {
        summary.recorded += 1;
      } else if (result.status >= 400 && result.status < 500) {
        // Paid, but the record function refuses it for good: stop retrying and leave the reason.
        await db.query(
          `update public.arena_boost_quote_reservations
              set status = 'paid', resolved_at = coalesce(resolved_at, now()), tx_hash = $2, log_index = $3,
                  recorded_at = now(), record_note = $4
            where id = $1 and recorded_at is null`,
          [row.id, found.txHash, found.logIndex, String(result.body?.error || `status ${result.status}`).slice(0, 300)],
        );
        summary.refused += 1;
        logger.warn?.(`[arenaEvmBoostReconcile] reservation ${row.id} paid in ${found.txHash} but earned no points: ${result.body?.error || result.status}`);
      } else {
        summary.errors.push(`reservation ${row.id}: ${result.body?.error || `status ${result.status}`}`);
      }
    } catch (error) {
      summary.errors.push(`reservation ${row.id}: ${error?.message || error}`);
    }
  }
  return summary;
}
