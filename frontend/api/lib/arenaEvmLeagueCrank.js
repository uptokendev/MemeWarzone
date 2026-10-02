// BNB / Robinhood war pool crank: resolve finished pools and move their protocol and league shares.
//
// On EVM a pool only became Resolved when the winner pressed Claim (the button submits the
// server-signed result), and its protocol / league shares only moved when someone called
// claimProtocol / claimLeague. Nothing did either, so an unclaimed win left both shares in the pool,
// and a pool nobody resolved before its resolveDeadline could only be refunded. This crank:
//   1. Live pool whose battle/tournament finished in the DB -> submits the resolver-signed result
//      (resolve / resolvePlaces, from the same claim-intent the Claim button uses). Permissionless:
//      the contract checks the resolver's signature over the winner, so this changes no payout.
//   2. Resolved pool -> claimProtocol (operator up to its cap, rest to the protocol receiver) and
//      claimLeague (league treasury). Both permissionless, fixed receivers.
// The winner still collects their own prize with the Claim button (claimWinner pays msg.sender).
//
// claimLeague's epoch is chosen by the caller. A wrong one cannot move money anywhere else
// (PostGradLeagueTreasuryV2 pays fixed receivers), but it files the money under the wrong month,
// so the month is the battle's settlement month (the month its MWL points went to), never "now".
//
// Off unless ARENA_EVM_LEAGUE_CRANK is "dry" (read and log) or "send". Key:
// ARENA_LEAGUE_CRANK_PK, else RECRUITER_PAYOUT_OPERATOR_PK (any funded key works; it only pays gas).
// Run one instance: sends are sequential and nonces are not coordinated across processes.
import { ethers } from "ethers";

import { recordLeagueShare } from "./arenaLeagueShareLedger.js";
import { WAR_POOL_GENERATION_V2, WAR_POOL_V2_ABI, battlePoolId, tournamentPoolId, warPoolGeneration, warPoolTreasuryAddress } from "./arenaWarPoolEscrow.js";

export const LEAGUE_CRANK_CHAIN_IDS = Object.freeze([56, 4663, 97, 46630]);
const STATE_LIVE = 1n;
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

/**
 * Every step a pool still needs, in order. resolve only for a Live pool; the two share claims only
 * once Resolved. `terminal` means nothing will ever be needed again for this pool.
 */
export function planWarPoolSteps(pool) {
  if (!pool) return { steps: [], terminal: false, reason: "unreadable" };
  const state = BigInt(pool.state);
  if (state === STATE_CANCELLED) return { steps: [], terminal: true, reason: "cancelled" };
  if (state === STATE_LIVE) return { steps: ["resolve"], terminal: false, reason: "live" };
  if (state !== STATE_RESOLVED) return { steps: [], terminal: false, reason: "not-live" };
  const steps = [];
  if (!pool.claimedProtocol && BigInt(pool.pendingProtocol) > 0n) steps.push("claimProtocol");
  if (classifyLeaguePool(pool).action === "claim") steps.push("claimLeague");
  return { steps, terminal: steps.length === 0, reason: steps.length ? "resolved" : "settled" };
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
        and coalesce(b.source, '') <> 'tournament'
        and coalesce(b.settled_at, b.finished_at) >= now() - ($2::text || ' days')::interval
     union all
     select 'tournament' as kind, t.id, t.chain_id, max(coalesce(b.settled_at, b.finished_at)) as settled_at
       from public.arena_tournaments t
       join public.arena_battles b on b.tournament_id = t.id and b.state = 'finished'
      where t.chain_id = any($1::int[]) and t.status = 'finished'
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
  resolutionFor = defaultResolutionFor,
  recordShare = recordLeagueShare,
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

    // At most resolve, protocol, league, then one last read that marks the pool done.
    for (let round = 0; round < 4; round += 1) {
      let pool;
      try {
        pool = await c.contract.pools(poolId);
      } catch (error) {
        outcomes.push({ chainId, subject: row.id, kind: row.kind, poolId, step: "read", status: "read-failed", reason: error?.shortMessage || error?.message || String(error) });
        break;
      }
      const plan = planWarPoolSteps(pool);
      if (plan.terminal) { terminal.add(key); break; }
      if (!plan.steps.length) break;
      const step = plan.steps[0];
      const outcome = { chainId, subject: row.id, kind: row.kind, poolId, step };
      outcomes.push(outcome);
      let call;
      try {
        call = await buildStepCall(step, { row, pool, poolId, resolutionFor });
      } catch (error) {
        outcome.status = "blocked";
        outcome.reason = error?.message || String(error);
        log(outcome);
        break;
      }
      Object.assign(outcome, call.describe);
      if (mode !== "send") { outcome.status = "dry-run"; log(outcome); break; }
      if (!c.wallet) { outcome.status = "no-key"; log(outcome); break; }
      if (step === "claimLeague") {
        // Record the share for the MWL payout before it moves (see arenaLeagueShareLedger.js). A
        // failed write holds the claim: a share must never reach the vault unrecorded.
        try {
          await recordShare(db, { chainId, subjectKind: row.kind, subjectId: row.id, grossRaw: BigInt(pool.pendingLeague), settledAt: row.settled_at, source: "evm_claim_league" });
        } catch (error) {
          outcome.status = "blocked";
          outcome.reason = `ledger write failed: ${error?.message || error}`;
          log(outcome);
          break;
        }
      }
      try {
        const balance = await c.provider.getBalance(c.wallet.address);
        if (balance === 0n) { outcome.status = "no-gas"; outcome.sender = c.wallet.address; log(outcome); break; }
        // Simulate first: a pool someone else just resolved / claimed reverts here, not on chain.
        await c.contract[call.method].staticCall(...call.args);
        const tx = await c.contract[call.method](...call.args);
        outcome.txHash = tx.hash;
        const receipt = await tx.wait();
        outcome.status = receipt?.status === 1 ? "sent" : "reverted";
      } catch (error) {
        outcome.status = "send-failed";
        outcome.reason = error?.shortMessage || error?.message || String(error);
      }
      log(outcome);
      if (outcome.status !== "sent") break;
    }
  }
  return outcomes;
}

/** The contract call for one step. resolve takes the server-signed result from claim-intent. */
export async function buildStepCall(step, { row, pool, poolId, resolutionFor }) {
  if (step === "claimProtocol") {
    return { method: "claimProtocol", args: [poolId], describe: { amountWei: BigInt(pool.pendingProtocol).toString() } };
  }
  if (step === "claimLeague") {
    const epochs = leagueEpochsFor(row.settled_at);
    return {
      method: "claimLeague",
      args: [poolId, epochs.monthlyEpoch, epochs.quarterlyEpoch],
      describe: { amountWei: BigInt(pool.pendingLeague).toString(), month: epochs.monthKey, quarter: epochs.quarterKey },
    };
  }
  if (step === "resolve") {
    const { status, body } = await resolutionFor(row.id);
    const signed = body?.resolve;
    if (status !== 200 || !body?.ok || !signed?.signature) {
      throw new Error(`resolution unavailable (${status}${body?.code ? ` ${body.code}` : ""}${body?.error ? `: ${body.error}` : ""})`);
    }
    if (String(body.poolId || "").toLowerCase() !== String(poolId).toLowerCase()) throw new Error("resolution is for a different pool");
    if (signed.version === "2-places") {
      return {
        method: "resolvePlaces",
        args: [poolId, signed.payouts, signed.bps, signed.deadline, signed.signature],
        describe: { payouts: signed.payouts.join(",") },
      };
    }
    if (signed.version !== "2") throw new Error(`unsupported resolution version ${signed.version}`);
    return { method: "resolve", args: [poolId, signed.winnerPayout, signed.deadline, signed.signature], describe: { winner: signed.winnerPayout } };
  }
  throw new Error(`unknown step ${step}`);
}

async function defaultResolutionFor(subjectId) {
  const { claimIntentFor } = await import("../arenaWarPools.js");
  return claimIntentFor(subjectId);
}

// ---------------------------------------------------------------------------------------------
// Major War League sweep: PostGradLeagueTreasuryV2 -> the MWL payout vaults.
//
// claimLeague files each share under its battle's month and quarter (pendingMonthlyByEpoch /
// pendingQuarterlyByEpoch). Once a month (quarter) is over, claimMonthly(epoch) / claimQuarterly(epoch)
// (permissionless) pays it to the treasury's fixed receiver. This sends them, but ONLY when that
// receiver is the configured MWL vault for the period: before the Safe points the receivers at the
// vaults they are the Safe, and sweeping then would move winners' money out of the payout path.
// The epochs to look at come from the share ledger (every share recorded before it was claimed).
// ---------------------------------------------------------------------------------------------
const LEAGUE_TREASURY_ABI = [
  "function monthlyReceiver() view returns (address)",
  "function quarterlyReceiver() view returns (address)",
  "function pendingMonthlyByEpoch(bytes32) view returns (uint256)",
  "function pendingQuarterlyByEpoch(bytes32) view returns (uint256)",
  "function claimMonthly(bytes32 epoch)",
  "function claimQuarterly(bytes32 epoch)",
];
const WAR_POOL_LEAGUE_ABI = ["function postGradLeagueTreasury() view returns (address)"];

/** Epoch keys whose period is over at `now` ("2026-09" ended at Oct 1 00:00 UTC; "2026-Q3" at Oct 1). */
export function periodKeyEnded(key, now = new Date()) {
  const month = /^(\d{4})-(\d{2})$/.exec(key);
  const quarter = /^(\d{4})-Q([1-4])$/.exec(key);
  let end;
  if (month) end = Date.UTC(Number(month[1]), Number(month[2]), 1);
  else if (quarter) end = Date.UTC(Number(quarter[1]), Number(quarter[2]) * 3, 1);
  else return false;
  return now.getTime() >= end;
}

export async function sweepMwlEpochs({
  db,
  env = process.env,
  mode = leagueCrankMode(env),
  now = new Date(),
  contractFor = (chainId) => defaultContractFor(chainId, env),
  vaultFor = async (period, chainId) => {
    const { mwlVaultAddress } = await import("./mwlPayoutVaults.js");
    return mwlVaultAddress(period, chainId, env);
  },
  log = () => {},
} = {}) {
  if (mode === "off") return [];
  const outcomes = [];
  for (const chainId of LEAGUE_CRANK_CHAIN_IDS) {
    const c = contractFor(chainId);
    if (!c) continue;
    const keys = await db.query(
      `select distinct month_key as key, 'monthly' as kind from public.arena_league_share_ledger where chain_id = $1
       union
       select distinct quarter_key as key, 'quarterly' as kind from public.arena_league_share_ledger where chain_id = $1`,
      [chainId],
    );
    if (!keys.rows.length) continue;
    let treasury;
    try {
      const warPool = c.leagueTreasuryResolver ? null : new ethers.Contract(c.contract.target ?? c.contract.address, WAR_POOL_LEAGUE_ABI, c.provider);
      const address = c.leagueTreasuryResolver ? await c.leagueTreasuryResolver() : await warPool.postGradLeagueTreasury();
      treasury = c.leagueTreasury || new ethers.Contract(address, LEAGUE_TREASURY_ABI, c.wallet || c.provider);
    } catch (error) {
      outcomes.push({ chainId, step: "sweep", status: "read-failed", reason: error?.shortMessage || error?.message || String(error) });
      continue;
    }
    for (const row of keys.rows) {
      const key = String(row.key);
      if (!periodKeyEnded(key, now)) continue;
      const monthly = row.kind === "monthly";
      const epoch = ethers.id(key);
      const outcome = { chainId, step: monthly ? "claimMonthly" : "claimQuarterly", key };
      try {
        const pending = BigInt(await (monthly ? treasury.pendingMonthlyByEpoch(epoch) : treasury.pendingQuarterlyByEpoch(epoch)));
        if (pending === 0n) continue;
        outcome.amountWei = pending.toString();
        const receiver = String(await (monthly ? treasury.monthlyReceiver() : treasury.quarterlyReceiver())).toLowerCase();
        const vault = String(await vaultFor(monthly ? "mwl_monthly" : "quarterly", chainId) || "").toLowerCase();
        if (!vault || receiver !== vault) {
          outcome.status = "held";
          outcome.reason = `receiver ${receiver} is not the MWL ${monthly ? "monthly" : "quarterly"} vault ${vault || "(not configured)"}`;
          outcomes.push(outcome);
          log(outcome);
          continue;
        }
        outcomes.push(outcome);
        if (mode !== "send") { outcome.status = "dry-run"; log(outcome); continue; }
        if (!c.wallet) { outcome.status = "no-key"; log(outcome); continue; }
        const method = monthly ? "claimMonthly" : "claimQuarterly";
        await treasury[method].staticCall(epoch);
        const tx = await treasury[method](epoch);
        outcome.txHash = tx.hash;
        const receipt = await tx.wait();
        outcome.status = receipt?.status === 1 ? "sent" : "reverted";
      } catch (error) {
        outcome.status = "send-failed";
        outcome.reason = error?.shortMessage || error?.message || String(error);
        if (!outcomes.includes(outcome)) outcomes.push(outcome);
      }
      log(outcome);
    }
  }
  return outcomes;
}
