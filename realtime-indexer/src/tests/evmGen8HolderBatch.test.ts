import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { holderBatchId } from "../evm/evmCreatorChoice.js";
import { GEN8_APPROVE_HOLDER_BATCH_SELECTOR } from "../evm/evmGen8Abi.js";
import { GEN8_HOLDER_PROGRAM, gen8ClaimDeadline, planGen8HolderWeek } from "../evm/evmGen8HolderBatch.js";
import { evaluateGen8VaultWatch } from "../evm/evmGen8VaultWatch.js";
import { EVM_GEN7_HOLDER_PROGRAM } from "../evm/evmGen7Fees.js";
import { watchdogConfig } from "../evm/payoutWatchdogConfig.js";

const NOW = 1_700_000_000;
const DELAY = 24 * 3600;
const DAY = 86_400;
const VAULT = "0x13537C6273dF312067cE775AAf9635c217A931fd";
const DIST = "0x00000000000000000000000000000000000000d1";
const H1 = "0x00000000000000000000000000000000000000a1";
const H2 = "0x00000000000000000000000000000000000000a2";
const POOL_A = `0x${"11".repeat(32)}`;
const POOL_B = `0x${"22".repeat(32)}`;

function plan(over: Partial<Parameters<typeof planGen8HolderWeek>[0]> = {}) {
  return planGen8HolderWeek({
    chainId: 46630,
    vault: VAULT,
    holderDistributor: DIST,
    weekId: "2026-10-05",
    nowSec: NOW,
    holderBatchDelaySec: DELAY,
    claimWindowDays: 60,
    minPayoutWei: 1n,
    roomWei: 10n ** 18n,
    authCapWei: 10n ** 18n,
    pots: new Map([[POOL_A, 100n], [POOL_B, 300n]]),
    holders: new Map([
      [POOL_A, [{ owner: H1, amount: 1n }]],
      [POOL_B, [{ owner: H1, amount: 1n }, { owner: H2, amount: 2n }]],
    ]),
    ...over,
  });
}

test("gen-8 claim deadline stays inside the vault window", () => {
  const deadline = gen8ClaimDeadline(NOW, DELAY, 60);
  const executableAt = NOW + DELAY;
  assert.ok(deadline >= executableAt + 7 * DAY);
  assert.ok(deadline <= NOW + 365 * DAY);
  assert.equal(deadline, executableAt + 60 * DAY);
  assert.throws(() => gen8ClaimDeadline(NOW, DELAY, 6), /outside/);
  assert.throws(() => gen8ClaimDeadline(NOW, DELAY, 365), /outside/);
});

test("gen-8 holder plan uses pool ids, a separate batch id, and does not execute", () => {
  const built = plan();
  assert.equal(built.sends.length, 0);
  assert.equal(built.file?.program, GEN8_HOLDER_PROGRAM);
  assert.equal(built.file?.batchId, holderBatchId(46630, "2026-10-05", GEN8_HOLDER_PROGRAM));
  assert.notEqual(built.file?.batchId, holderBatchId(46630, "2026-10-05", EVM_GEN7_HOLDER_PROGRAM));
  assert.deepEqual(built.file?.pools.map((pool) => pool.poolId), [POOL_A, POOL_B]);
  assert.equal(built.file?.pools.every((pool) => pool.poolId.length === 66), true);
  assert.equal(built.safe?.applied, false);
  assert.equal(built.safe?.executes, false);
  assert.deepEqual(built.safe?.calls.map((call) => call.fn), ["approveHolderBatch", "authorizeBatch"]);
  assert.equal(built.safe?.calls[0].args.length, 4);
  assert.equal(built.safe?.calls[0].data.slice(0, 10), GEN8_APPROVE_HOLDER_BATCH_SELECTOR);
  assert.equal(built.safe?.calls.some((call) => call.fn === "executeHolderBatch"), false);
  assert.equal(built.propose?.fn, "proposeHolderBatch");
  assert.equal(built.propose?.args[3].every((id) => id.length === 66), true);
  const again = plan();
  assert.equal(again.file?.root, built.file?.root);
  assert.equal(built.file?.total, "400");
});

test("gen-8 holder plan refuses an empty week and a cap of zero", () => {
  assert.match(plan({ pots: new Map() }).reason, /no holder balance/);
  assert.match(plan({ roomWei: 0n }).reason, /cap is used up/);
  assert.match(plan({ claimWindowDays: 6 }).reason, /outside/);
});

test("gen-8 vault watch alerts on a short balance, a wrong router, and a foreign claim", () => {
  const vault = VAULT.toLowerCase();
  const splitter = "0x00000000000000000000000000000000000000e1";
  const other = "0x00000000000000000000000000000000000000e2";
  const base = {
    chainId: 46630,
    vault,
    balanceWei: 10n,
    totalLiabilitiesWei: 10n,
    treasuryRouter: splitter,
    expectedRouter: splitter,
    foreignClaims: [],
  };
  assert.equal(evaluateGen8VaultWatch(base).length, 0);
  const short = evaluateGen8VaultWatch({ ...base, balanceWei: 9n });
  assert.equal(short[0].kind, "gen8_vault_short");
  assert.equal(short[0].severity, "critical");
  assert.equal(short[0].rewardType, "gen8_choice_vault");
  const excess = evaluateGen8VaultWatch({ ...base, balanceWei: 11n });
  assert.equal(excess[0].kind, "gen8_vault_excess");
  const router = evaluateGen8VaultWatch({ ...base, treasuryRouter: other });
  assert.equal(router[0].kind, "gen8_router_changed");
  assert.equal(router[0].rewardType, "gen8_hook");
  const foreign = evaluateGen8VaultWatch({
    ...base,
    foreignClaims: [{ txHash: "0xabc", from: "0x00000000000000000000000000000000000000f1", amount: 5n }],
  });
  assert.equal(foreign[0].kind, "gen8_foreign_router_claim");
  assert.equal(foreign[0].subject, "0xabc");
});

test("watchdog config keeps the gen-8 vault off the 3-arg vault list", () => {
  const gen8 = "0x00000000000000000000000000000000000008aa";
  const cfg = watchdogConfig(46630, {
    EVM_CREATOR_VAULT_V2_46630: "0x00000000000000000000000000000000000006aa@10",
    EVM_GEN8_CHOICE_VAULT_46630: `${gen8}@133622263`,
    EVM_GEN8_HOOK_46630: "0xb18105cb239885aad85Fbf9e62cEe56b6415A8eC@133622263",
    EVM_GEN8_SPLITTER_46630: "0xe0f9d33c5538cA0D04d305F0B9aa24057eDC3B02",
  });
  assert.deepEqual(cfg.vaults.map((lane) => lane.label), ["gen-6"]);
  assert.equal(cfg.gen8Vaults?.length, 1);
  assert.equal(cfg.gen8Vaults?.[0].vault, ethers.getAddress(gen8));
  assert.equal(cfg.gen8Vaults?.[0].program, GEN8_HOLDER_PROGRAM);
  assert.equal(cfg.gen8Vaults?.[0].startBlock, 133622263);
  assert.equal(cfg.vaults.some((lane) => lane.vault === ethers.getAddress(gen8)), false);
});
