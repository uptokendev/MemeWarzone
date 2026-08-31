import { createHash } from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

import {
  ARENA_CLAIM_MWL,
  ARENA_CLAIM_PROTOCOL,
  ARENA_KIND_BATTLE,
  ARENA_PROGRAM_ID,
  buildArenaOperatorClaimInstruction,
  buildArenaResolveInstructions,
  sendArenaOperatorV0,
} from "./arena-operator-v0.mjs";

export const ARENA_STATE_LIVE = 1;
export const ARENA_STATE_RESOLVED = 2;
export const ARENA_SIDE_A = 1;
export const ARENA_SIDE_B = 2;
export const ARENA_RESULT_WINNER = 1;
export const ARENA_KIND_BATTLE_CODE = 0;
export const OUTCOME_HASH_DOMAIN = "MWZ_ARENA_OUTCOME_V1";

function ident(value) {
  return String(value || "").trim();
}

function walletsEqual(left, right) {
  const a = ident(left);
  const b = ident(right);
  return Boolean(a && b && a === b);
}

function fail(reason, extra = {}) {
  return { ok: false, action: "block", reason, ...extra };
}

export function battleOutcomeHash(settlement) {
  return createHash("sha256")
    .update(OUTCOME_HASH_DOMAIN)
    .update(ident(settlement.battleId || settlement.id))
    .update(ident(settlement.money_winner_token || settlement.moneyWinnerToken))
    .update(ident(settlement.mwl_result || settlement.mwlResult))
    .update(String(settlement.challenger_end_mcap_usd ?? settlement.leftEndMcap ?? ""))
    .update(String(settlement.defender_end_mcap_usd ?? settlement.rightEndMcap ?? ""))
    .update(String(settlement.settlement_version ?? settlement.settlementVersion ?? 1))
    .digest();
}

function moneyWinnerSide(pool, moneyWinnerToken) {
  if (walletsEqual(moneyWinnerToken, pool.assetA || pool.asset_a)) {
    return {
      winnerSide: ARENA_SIDE_A,
      winnerAsset: ident(pool.assetA || pool.asset_a),
      winnerWallet: ident(pool.ownerA || pool.owner_a),
    };
  }
  if (walletsEqual(moneyWinnerToken, pool.assetB || pool.asset_b)) {
    return {
      winnerSide: ARENA_SIDE_B,
      winnerAsset: ident(pool.assetB || pool.asset_b),
      winnerWallet: ident(pool.ownerB || pool.owner_b),
    };
  }
  return null;
}

export function planBattleResolve({ settlement, pool, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  if (Number(pool?.kind) !== ARENA_KIND_BATTLE_CODE) {
    return fail("tournament-deferred-to-4c");
  }
  const moneyWinnerToken = ident(settlement?.money_winner_token || settlement?.moneyWinnerToken);
  if (!moneyWinnerToken) return fail("missing-money-winner");
  const draw = settlement?.mwl_draw === true || settlement?.mwlDraw === true
    || ident(settlement?.mwl_result || settlement?.mwlResult) === "draw";
  const mwlWinner = ident(settlement?.mwl_winner_token || settlement?.mwlWinnerToken);
  if (!draw && mwlWinner && !walletsEqual(mwlWinner, moneyWinnerToken)) return fail("mwl-money-mismatch");

  const state = Number(pool.state);
  if (state === ARENA_STATE_RESOLVED) {
    const onchainWinner = ident(pool.winnerAsset || pool.winner_asset);
    if (onchainWinner && !walletsEqual(onchainWinner, moneyWinnerToken)) return fail("resolved-winner-mismatch");
    return { ok: true, action: "skip", reason: "already-resolved", moneyWinnerToken };
  }
  if (state !== ARENA_STATE_LIVE) return fail("pool-not-live");

  const mapped = moneyWinnerSide(pool, moneyWinnerToken);
  if (!mapped || !mapped.winnerWallet) return fail("money-winner-not-in-pool");

  const resolveDeadline = Number(pool.resolveDeadline ?? pool.resolve_deadline ?? 0);
  if (!Number.isFinite(resolveDeadline) || resolveDeadline <= nowSec) return fail("resolve-deadline-passed");
  const deadline = BigInt(resolveDeadline);
  const nonce = BigInt(pool.actionNonce ?? pool.action_nonce ?? 0);
  const poolId = pool.poolId || pool.pool_id;
  if (!poolId) return fail("missing-pool-id");

  return {
    ok: true,
    action: "resolve",
    reason: "ok",
    moneyWinnerToken,
    winnerSide: mapped.winnerSide,
    winnerAsset: mapped.winnerAsset,
    winnerWallet: mapped.winnerWallet,
    resultType: ARENA_RESULT_WINNER,
    kind: ARENA_KIND_BATTLE,
    poolId,
    version: 2,
    assetA: ident(pool.assetA || pool.asset_a),
    assetB: ident(pool.assetB || pool.asset_b),
    ownerA: ident(pool.ownerA || pool.owner_a),
    ownerB: ident(pool.ownerB || pool.owner_b),
    stakeA: BigInt(pool.depositedStakeA ?? pool.deposited_stake_a ?? 0),
    stakeB: BigInt(pool.depositedStakeB ?? pool.deposited_stake_b ?? 0),
    supportTotal: BigInt(pool.supportTotal ?? pool.support_total ?? 0),
    prizeBoostTotal: BigInt(pool.prizeBoostTotal ?? pool.prize_boost_total ?? 0),
    buyInTotal: BigInt(pool.buyInTotal ?? pool.buy_in_total ?? 0),
    outcomeHash: battleOutcomeHash({ ...settlement, money_winner_token: moneyWinnerToken }),
    deadline,
    nonce,
  };
}

export function buildPlannedResolveInstructions(plan, resolver) {
  if (!plan?.ok || plan.action !== "resolve") throw new Error(plan?.reason || "resolve is not actionable");
  const built = buildArenaResolveInstructions({ ...plan, resolver });
  return {
    instructions: [built.verifyIx, built.resolveIx],
    verifyIx: built.verifyIx,
    resolveIx: built.resolveIx,
    message: built.message,
    pool: built.pool,
  };
}

export function planOperatorClaim({ pool, bucket, receiver } = {}) {
  if (bucket !== ARENA_CLAIM_PROTOCOL && bucket !== ARENA_CLAIM_MWL) return fail("unsupported-claim-bucket");
  if (Number(pool?.kind) !== ARENA_KIND_BATTLE_CODE) return fail("tournament-deferred-to-4c");
  if (Number(pool?.state) !== ARENA_STATE_RESOLVED) return fail("pool-not-resolved");
  const claimed = bucket === ARENA_CLAIM_PROTOCOL
    ? Boolean(pool.claimedProtocol ?? pool.claimed_protocol)
    : Boolean(pool.claimedMwl ?? pool.claimed_mwl);
  if (claimed) return { ok: true, action: "skip", reason: "already-claimed", bucket };
  const pending = bucket === ARENA_CLAIM_PROTOCOL
    ? BigInt(pool.pendingProtocol ?? pool.pending_protocol ?? 0)
    : BigInt(pool.pendingMwl ?? pool.pending_mwl ?? 0);
  if (pending <= 0n) return fail("nothing-to-claim");
  const dest = ident(receiver);
  if (!dest) return fail("missing-receiver");
  return {
    ok: true,
    action: "claim",
    reason: "ok",
    bucket,
    receiver: dest,
    amount: pending,
    poolId: pool.poolId || pool.pool_id,
  };
}

export async function sendPlannedResolve(connection, payer, plan, resolver) {
  const built = buildPlannedResolveInstructions(plan, resolver);
  return sendArenaOperatorV0(connection, payer, built.instructions, "Arena resolve_pool_v2");
}

export async function sendPlannedClaim(connection, payer, plan, caller) {
  if (!plan?.ok || plan.action !== "claim") throw new Error(plan?.reason || "claim is not actionable");
  const built = buildArenaOperatorClaimInstruction({
    caller,
    poolId: plan.poolId,
    bucket: plan.bucket,
    receiver: plan.receiver,
  });
  return sendArenaOperatorV0(connection, payer, [built.instruction], plan.bucket === ARENA_CLAIM_MWL ? "Arena claim_mwl" : "Arena claim_protocol");
}

export function publicPlan(plan) {
  const out = { ...plan };
  for (const [key, value] of Object.entries(out)) {
    if (typeof value === "bigint") out[key] = value.toString();
    else if (value instanceof Uint8Array) out[key] = Buffer.from(value).toString("hex");
  }
  return out;
}

function runningAsCli() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

function readJsonFlag(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || !argv[index + 1]) return null;
  return JSON.parse(fs.readFileSync(argv[index + 1], "utf8"));
}

function printUsage() {
  console.error(`Arena operator resolve is server-side only. Never route this through Phantom.

Usage:
  node scripts/solana/arena-operator-resolve.mjs plan --settlement-json <file> --pool-json <file>
  node scripts/solana/arena-operator-resolve.mjs claim-plan --pool-json <file> --bucket protocol|mwl --receiver <pubkey>
`);
}

if (runningAsCli()) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  try {
    if (cmd === "plan") {
      const plan = planBattleResolve({
        settlement: readJsonFlag(argv, "--settlement-json"),
        pool: readJsonFlag(argv, "--pool-json"),
      });
      console.log(JSON.stringify(publicPlan(plan), null, 2));
      process.exit(plan.ok ? 0 : 1);
    }
    if (cmd === "claim-plan") {
      const bucketName = argv.includes("--bucket") ? argv[argv.indexOf("--bucket") + 1] : "";
      const bucket = bucketName === "mwl" ? ARENA_CLAIM_MWL : bucketName === "protocol" ? ARENA_CLAIM_PROTOCOL : -1;
      const receiver = argv.includes("--receiver") ? argv[argv.indexOf("--receiver") + 1] : "";
      const plan = planOperatorClaim({ pool: readJsonFlag(argv, "--pool-json"), bucket, receiver });
      console.log(JSON.stringify(publicPlan(plan), null, 2));
      process.exit(plan.ok ? 0 : 1);
    }
    printUsage();
    process.exit(2);
  } catch (error) {
    console.error(String(error?.message || error));
    process.exit(1);
  }
}
