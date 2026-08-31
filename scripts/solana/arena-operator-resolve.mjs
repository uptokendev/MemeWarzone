import { createHash } from "node:crypto";
import { createRequire } from "node:module";
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

const require = createRequire(import.meta.url);
const ED25519_PROGRAM_ID = "Ed25519SigVerify111111111111111111111111111";

export const ARENA_STATE_LIVE = 1;
export const ARENA_STATE_RESOLVED = 2;
export const ARENA_SIDE_A = 1;
export const ARENA_SIDE_B = 2;
export const ARENA_RESULT_WINNER = 1;
export const ARENA_KIND_BATTLE_CODE = 0;
export const OUTCOME_HASH_DOMAIN = "MWZ_ARENA_OUTCOME_V1";
export const MWL_RESULT = Object.freeze({
  LEFT_WIN: "left_win",
  RIGHT_WIN: "right_win",
  DRAW: "draw",
});

function keccak256Utf8(text) {
  const bytes = Buffer.from(String(text), "utf8");
  try {
    const { keccak_256 } = require("@noble/hashes/sha3");
    return Buffer.from(keccak_256(bytes));
  } catch {
    const { keccak256 } = require("ethers");
    return Buffer.from(String(keccak256(bytes)).replace(/^0x/i, ""), "hex");
  }
}

/** Same as frontend battlePoolId / ethers.id(`arena-battle:${id}`). */
export function canonicalBattlePoolIdBytes(battleId) {
  const id = ident(battleId);
  if (!id) throw new Error("battle id is required");
  return keccak256Utf8(`arena-battle:${id}`);
}

function poolIdBytes(value) {
  if (!value && value !== 0) return null;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return value.length === 32 ? Buffer.from(value) : null;
  }
  const raw = ident(value);
  const hex = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Buffer.from(hex, "hex");
}

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

function settlementConsistency(settlement) {
  const moneyWinnerToken = ident(settlement?.money_winner_token || settlement?.moneyWinnerToken);
  if (!moneyWinnerToken) return fail("missing-money-winner");
  const result = ident(settlement?.mwl_result || settlement?.mwlResult);
  if (result !== MWL_RESULT.LEFT_WIN && result !== MWL_RESULT.RIGHT_WIN && result !== MWL_RESULT.DRAW) {
    return fail("invalid-mwl-result");
  }
  const drawFlag = settlement?.mwl_draw ?? settlement?.mwlDraw;
  if (drawFlag === true && result !== MWL_RESULT.DRAW) return fail("mwl-draw-flag-mismatch");
  if (drawFlag === false && result === MWL_RESULT.DRAW) return fail("mwl-draw-flag-mismatch");
  const mwlWinner = ident(settlement?.mwl_winner_token || settlement?.mwlWinnerToken);
  if (result === MWL_RESULT.DRAW) {
    if (mwlWinner) return fail("draw-has-mwl-winner");
    return { ok: true, moneyWinnerToken, mwlResult: result, draw: true };
  }
  if (!mwlWinner) return fail("missing-mwl-winner");
  if (!walletsEqual(mwlWinner, moneyWinnerToken)) return fail("mwl-money-mismatch");
  return { ok: true, moneyWinnerToken, mwlResult: result, draw: false };
}

export function planBattleResolve({ settlement, pool, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  if (Number(pool?.kind) !== ARENA_KIND_BATTLE_CODE) {
    return fail("tournament-deferred-to-4c");
  }
  const battleId = ident(settlement?.battleId || settlement?.id);
  if (!battleId) return fail("missing-battle-id");
  const expectedPoolId = canonicalBattlePoolIdBytes(battleId);
  const actualPoolId = poolIdBytes(pool?.poolId || pool?.pool_id);
  if (!actualPoolId) return fail("missing-pool-id");
  if (!actualPoolId.equals(expectedPoolId)) return fail("pool-id-mismatch");

  const consistency = settlementConsistency(settlement);
  if (!consistency.ok) return consistency;
  const { moneyWinnerToken } = consistency;

  const mapped = moneyWinnerSide(pool, moneyWinnerToken);
  if (!mapped || !mapped.winnerWallet) return fail("money-winner-not-in-pool");

  const state = Number(pool.state);
  if (state === ARENA_STATE_RESOLVED) {
    const onchainAsset = ident(pool.winnerAsset || pool.winner_asset);
    const onchainWallet = ident(pool.winnerWallet || pool.winner_wallet);
    if (!onchainAsset) return fail("resolved-winner-missing");
    if (!walletsEqual(onchainAsset, moneyWinnerToken)) return fail("resolved-winner-mismatch");
    if (!onchainWallet) return fail("resolved-wallet-missing");
    if (!walletsEqual(onchainWallet, mapped.winnerWallet)) return fail("resolved-wallet-mismatch");
    return {
      ok: true,
      action: "skip",
      reason: "already-resolved",
      moneyWinnerToken,
      winnerAsset: mapped.winnerAsset,
      winnerWallet: mapped.winnerWallet,
    };
  }
  if (state !== ARENA_STATE_LIVE) return fail("pool-not-live");

  const resolveDeadline = Number(pool.resolveDeadline ?? pool.resolve_deadline ?? 0);
  if (!Number.isFinite(resolveDeadline) || resolveDeadline <= nowSec) return fail("resolve-deadline-passed");
  const deadline = BigInt(resolveDeadline);
  const nonce = BigInt(pool.actionNonce ?? pool.action_nonce ?? 0);

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
    poolId: expectedPoolId,
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

export function assertEd25519Adjacency(instructions) {
  if (!Array.isArray(instructions) || instructions.length < 2) {
    throw new Error("resolve requires Ed25519 immediately followed by resolve_pool_v2");
  }
  if (instructions[0].programId.toBase58() !== ED25519_PROGRAM_ID) {
    throw new Error("Ed25519 verify must be first");
  }
  if (!instructions[1].programId.equals(ARENA_PROGRAM_ID)) {
    throw new Error("resolve_pool_v2 must immediately follow Ed25519");
  }
}

export function buildPlannedResolveInstructions(plan, resolver) {
  if (!plan?.ok || plan.action !== "resolve") throw new Error(plan?.reason || "resolve is not actionable");
  const built = buildArenaResolveInstructions({ ...plan, resolver });
  const instructions = [built.verifyIx, built.resolveIx];
  assertEd25519Adjacency(instructions);
  return {
    instructions,
    verifyIx: built.verifyIx,
    resolveIx: built.resolveIx,
    message: built.message,
    pool: built.pool,
  };
}

function configReceiver(config, bucket) {
  if (bucket === ARENA_CLAIM_PROTOCOL) return ident(config?.protocolReceiver || config?.protocol_receiver);
  if (bucket === ARENA_CLAIM_MWL) return ident(config?.mwlReceiver || config?.mwl_receiver);
  return "";
}

export function planOperatorClaim({ pool, config, bucket, receiver } = {}) {
  if (bucket !== ARENA_CLAIM_PROTOCOL && bucket !== ARENA_CLAIM_MWL) return fail("unsupported-claim-bucket");
  if (Number(pool?.kind) !== ARENA_KIND_BATTLE_CODE) return fail("tournament-deferred-to-4c");
  if (Number(pool?.state) !== ARENA_STATE_RESOLVED) return fail("pool-not-resolved");
  const expected = configReceiver(config, bucket);
  if (!expected) return fail("missing-config-receiver");
  const requested = ident(receiver);
  if (requested && !walletsEqual(requested, expected)) return fail("receiver-mismatch");
  const claimed = bucket === ARENA_CLAIM_PROTOCOL
    ? Boolean(pool.claimedProtocol ?? pool.claimed_protocol)
    : Boolean(pool.claimedMwl ?? pool.claimed_mwl);
  if (claimed) return { ok: true, action: "skip", reason: "already-claimed", bucket, receiver: expected };
  const pending = bucket === ARENA_CLAIM_PROTOCOL
    ? BigInt(pool.pendingProtocol ?? pool.pending_protocol ?? 0)
    : BigInt(pool.pendingMwl ?? pool.pending_mwl ?? 0);
  if (pending <= 0n) return fail("nothing-to-claim");
  return {
    ok: true,
    action: "claim",
    reason: "ok",
    bucket,
    receiver: expected,
    amount: pending,
    poolId: pool.poolId || pool.pool_id,
  };
}

export async function sendPlannedResolve(connection, payer, plan, resolver) {
  const built = buildPlannedResolveInstructions(plan, resolver);
  assertEd25519Adjacency(built.instructions);
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
  node scripts/solana/arena-operator-resolve.mjs claim-plan --pool-json <file> --config-json <file> --bucket protocol|mwl [--receiver <pubkey>]
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
      const plan = planOperatorClaim({
        pool: readJsonFlag(argv, "--pool-json"),
        config: readJsonFlag(argv, "--config-json"),
        bucket,
        receiver,
      });
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
