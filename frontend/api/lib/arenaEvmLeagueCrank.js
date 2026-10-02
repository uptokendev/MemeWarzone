// BNB / Robinhood: move each resolved battle's league share into the league treasury.
//
// ArenaWarPoolTreasuryV2.claimLeague(poolId, monthlyEpoch, quarterlyEpoch) is permissionless and
// nothing in the app sent it, so the league pots only grew when someone did it by hand. This sends
// it for every Resolved pool that still holds an unclaimed league share.
//
// The caller chooses the epoch. A wrong one cannot move money anywhere else
// (PostGradLeagueTreasuryV2 pays fixed receivers), but it files the money under the wrong month,
// so the month is the battle's settlement month (the month its MWL points went to), never "now".
//
// Off unless ARENA_EVM_LEAGUE_CRANK is "dry" (read and log) or "send". Key:
// ARENA_LEAGUE_CRANK_PK, else RECRUITER_PAYOUT_OPERATOR_PK (any funded key works; it only pays gas).
// Run one instance: sends are sequential and nonces are not coordinated across processes.
import { ethers } from "ethers";

import { WAR_POOL_GENERATION_V2, WAR_POOL_V2_ABI, battlePoolId, tournamentPoolId, warPoolGeneration, warPoolTreasuryAddress } from "./arenaWarPoolEscrow.js";

export const LEAGUE_CRANK_CHAIN_IDS = Object.freeze([56, 4663, 97, 46630]);
const STATE_RESOLVED = 2n;
const STATE_CANCELLED = 3n;

export function leagueCrankMode(env = process.env) {
  const raw = String(env.ARENA_EVM_LEAGUE_CRANK || "").trim().toLowerCase();
  return raw === "send" || raw === "dry" ? raw : "off";
}

/** Epochs for the UTC month a battle settled in: keccak("YYYY-MM") and keccak("YYYY-Qn"). */
export function leagueEpochsFor(settledAt) {
  const date = settledAt instanceof Date ? settledAt : new Date(settledAt);
  if (!Number.isFinite(date.getTime())) throw new Error("LEAGUE_EPOCH_DATE_INVALID");
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const monthKey = `${year}-${String(month).padStart(2, "0")}`;
  const quarterKey = `${year}-Q${Math.floor((month - 1) / 3) + 1}`;
  return { monthKey, quarterKey, monthlyEpoch: ethers.id(monthKey), quarterlyEpoch: ethers.id(quarterKey) };
}

/** What to do with one pool, from its on-chain record. Terminal outcomes are never re-read. */
export function classifyLeaguePool(pool) {
  if (!pool) return { action: "skip", terminal: false, reason: "unreadable" };
  const state = BigInt(pool.state);
  if (state === STATE_CANCELLED) return { action: "skip", terminal: true, reason: "cancelled" };
  if (state !== STATE_RESOLVED) return { action: "skip", terminal: false, reason: "not-resolved" };
  if (pool.claimedLeague) return { action: "skip", terminal: true, reason: "already-claimed" };
  if (BigInt(pool.pendingLeague) === 0n) return { action: "skip", terminal: true, reason: "no-league-share" };
  return { action: "claim", terminal: false, amount: BigInt(pool.pendingLeague) };
}

function rpcUrl(chainId, env) {
  const perChain = String(env[`ROBINHOOD_RPC_HTTP_${chainId}`] || env[`BSC_RPC_HTTP_${chainId}`] || env[`VITE_PUBLIC_RPC_${chainId}`] || "").trim();
  if (perChain) return perChain.split(",")[0].trim();
  if (chainId === 4663) return String(env.ROBINHOOD_MAINNET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com").trim();
  if (chainId === 46630) return String(env.ROBINHOOD_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com").trim();
  if (chainId === 56) return String(env.BSC_RPC_HTTP || "https://bsc-dataseed.binance.org").trim();
  return "";
}

function defaultContractFor(chainId, env) {
  if (warPoolGeneration(chainId, env) !== WAR_POOL_GENERATION_V2) return null;
  const address = warPoolTreasuryAddress(chainId, env);
  const url = rpcUrl(chainId, env);
  if (!address || !url) return null;
  const network = ethers.Network.from(chainId);
  const provider = new ethers.JsonRpcProvider(url, network, { staticNetwork: network, batchMaxCount: 1 });
  const pk = String(env.ARENA_LEAGUE_CRANK_PK || env.RECRUITER_PAYOUT_OPERATOR_PK || "").trim();
  const wallet = pk ? new ethers.Wallet(pk, provider) : null;
  return { address, provider, wallet, contract: new ethers.Contract(address, WAR_POOL_V2_ABI, wallet || provider) };
}

/** Battles and tournaments whose pool can hold a league share, with the month they settled in. */
export async function leagueCrankCandidates(db, chainIds, lookbackDays) {
  const result = await db.query(
    `select 'battle' as kind, b.id, b.chain_id, coalesce(b.settled_at, b.finished_at) as settled_at
       from public.arena_battles b
      where b.chain_id = any($1::int[]) and b.state = 'finished' and b.tournament_id is null
        and coalesce(b.settled_at, b.finished_at) >= now() - ($2::text || ' days')::interval
     union all
     select 'tournament' as kind, t.id, t.chain_id, max(coalesce(b.settled_at, b.finished_at)) as settled_at
       from public.arena_tournaments t
       join public.arena_battles b on b.tournament_id = t.id and b.state = 'finished'
      where t.chain_id = any($1::int[])
      group by t.id, t.chain_id
     having max(coalesce(b.settled_at, b.finished_at)) >= now() - ($2::text || ' days')::interval
      order by settled_at asc`,
    [chainIds, String(lookbackDays)],
  );
  return (result.rows || []).filter((row) => row.settled_at);
}

/**
 * One pass. `terminal` (a Set of "chainId:poolId") persists across passes so finished pools are not
 * re-read. Returns one outcome per pool that was acted on or failed.
 */
export async function crankLeagueShares({
  db,
  env = process.env,
  mode = leagueCrankMode(env),
  lookbackDays = Number(env.ARENA_EVM_LEAGUE_CRANK_LOOKBACK_DAYS || 120),
  terminal = new Set(),
  contractFor = (chainId) => defaultContractFor(chainId, env),
  log = () => {},
} = {}) {
  if (mode === "off") return [];
  const contracts = new Map();
  for (const chainId of LEAGUE_CRANK_CHAIN_IDS) {
    const c = contractFor(chainId);
    if (c) contracts.set(chainId, c);
  }
  if (!contracts.size) return [];

  const outcomes = [];
  const rows = await leagueCrankCandidates(db, [...contracts.keys()], lookbackDays);
  for (const row of rows) {
    const chainId = Number(row.chain_id);
    const c = contracts.get(chainId);
    if (!c) continue;
    const poolId = row.kind === "tournament" ? tournamentPoolId(row.id) : battlePoolId(row.id);
    const key = `${chainId}:${poolId}`;
    if (terminal.has(key)) continue;
    let decision;
    try {
      decision = classifyLeaguePool(await c.contract.pools(poolId));
    } catch (error) {
      outcomes.push({ chainId, subject: row.id, poolId, status: "read-failed", reason: error?.shortMessage || error?.message || String(error) });
      continue;
    }
    if (decision.terminal) terminal.add(key);
    if (decision.action !== "claim") continue;

    const epochs = leagueEpochsFor(row.settled_at);
    const outcome = { chainId, subject: row.id, kind: row.kind, poolId, amountWei: decision.amount.toString(), month: epochs.monthKey, quarter: epochs.quarterKey };
    outcomes.push(outcome);
    if (mode !== "send") { outcome.status = "dry-run"; continue; }
    if (!c.wallet) { outcome.status = "no-key"; continue; }
    try {
      const balance = await c.provider.getBalance(c.wallet.address);
      if (balance === 0n) { outcome.status = "no-gas"; outcome.sender = c.wallet.address; continue; }
      // Simulate first: a pool someone else just claimed reverts here instead of costing gas.
      await c.contract.claimLeague.staticCall(poolId, epochs.monthlyEpoch, epochs.quarterlyEpoch);
      const tx = await c.contract.claimLeague(poolId, epochs.monthlyEpoch, epochs.quarterlyEpoch);
      outcome.txHash = tx.hash;
      const receipt = await tx.wait();
      outcome.status = receipt?.status === 1 ? "claimed" : "reverted";
      if (outcome.status === "claimed") terminal.add(key);
    } catch (error) {
      outcome.status = "send-failed";
      outcome.reason = error?.shortMessage || error?.message || String(error);
    }
    log(outcome);
  }
  return outcomes;
}
