import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.ABLY_API_KEY ||= "test:key";
process.env.SOLANA_RPC_HTTP ||= "http://127.0.0.1:8899";

const {
  compensationDue,
  expectedMigrationFee,
  expectedPartnerMigrationFee,
  finalizeProfileBps,
  finalizeRouteTotals,
  finalizeSlicesConserve,
  isPlatformFeeChoice,
  payCompensation,
  splitDbcFinalizeFee,
  splitPlatformLpFees,
} = await import("../dbc/dbcGraduationSplit.js");
const {
  CREATOR_WITHDRAW_BIT,
  PARTNER_WITHDRAW_BIT,
  VIRTUAL_POOL_DISCRIMINATOR,
  curveComplete,
  jobFromRow,
  lockerNeeded,
  nextGraduationStep,
  partnerWithdrawn,
  readConfigSnapshot,
  readPoolSnapshot,
  solanaGraduationMeta,
} = await import("../dbc/dbcGraduationState.js");
const { buildRouteTransfers } = await import("../dbc/dbcFeeRouter.js");
const { resolveSignature } = await import("../dbc/dbcFeePending.js");

const threshold = 1_500_000_000n;

function pool(over: Record<string, unknown> = {}) {
  return readPoolSnapshot({
    isMigrated: 0,
    migrationProgress: 0,
    migrationFeeWithdrawStatus: 0,
    quoteReserve: threshold,
    protocolMigrationQuoteFeeAmount: 0,
    protocolMigrationBaseFeeAmount: 0,
    creator: "Creator11111111111111111111111111111111111",
    baseMint: "Mint11111111111111111111111111111111111111",
    config: "Config11111111111111111111111111111111111",
    quoteVault: "QuoteVault1111111111111111111111111111111",
    baseVault: "BaseVault11111111111111111111111111111111",
    ...over,
  })!;
}

function config(over: Record<string, unknown> = {}) {
  return readConfigSnapshot({
    migrationQuoteThreshold: threshold,
    lockedVestingConfig: { totalLockedVestingAmount: 20_000_000_000_000n },
    quoteMint: "So11111111111111111111111111111111111111112",
    ...over,
  })!;
}

const idleJob = jobFromRow(null);

test("kind-1 finalize split: linked 15/2.5, OG 17.5/2.5, unlinked airdrop 17.5, no league", () => {
  const fee = 2_200_000n;
  const linked = splitDbcFinalizeFee(fee, "standard_linked");
  const og = splitDbcFinalizeFee(fee, "og_linked");
  const unlinked = splitDbcFinalizeFee(fee, "standard_unlinked");
  assert.equal(linked.recruiter, 330_000n);
  assert.equal(linked.squad, 55_000n);
  assert.equal(linked.airdrop, 0n);
  assert.equal(linked.protocol, fee - 330_000n - 55_000n);
  assert.equal(og.recruiter, 385_000n);
  assert.equal(og.squad, 55_000n);
  assert.equal(unlinked.recruiter, 0n);
  assert.equal(unlinked.squad, 0n);
  assert.equal(unlinked.airdrop, 385_000n);
  for (const row of [linked, og, unlinked]) {
    assert.equal(finalizeSlicesConserve(row), true);
    assert.equal(row.remaining, fee);
    const totals = finalizeRouteTotals(row);
    assert.equal(totals.leagueWeekly, 0n);
    assert.equal(totals.leagueMonthly, 0n);
    assert.equal(totals.creatorPool, 0n);
    assert.equal(totals.routed, fee);
  }
  assert.deepEqual(finalizeProfileBps("standard_linked"), { recruiter: 1500n, squad: 250n, airdrop: 0n });
});

test("D7 compensation is quote cut plus base cut at migration price; shortfall is recorded", () => {
  const quoteCut = 2_340_000n;
  const baseCut = 1_000_000n;
  const vaultQuote = 1_167_660_000n;
  const vaultBase = 499_000_000n;
  const due = compensationDue({
    protocolMigrationQuoteFeeAmount: quoteCut,
    protocolMigrationBaseFeeAmount: baseCut,
    dammQuoteVault: vaultQuote,
    dammBaseVault: vaultBase,
  });
  assert.equal(due.quoteCut, quoteCut);
  assert.equal(due.baseCut, baseCut);
  assert.equal(due.baseAsSol, (baseCut * (vaultQuote + quoteCut)) / (vaultBase + baseCut));
  assert.equal(due.due, due.quoteCut + due.baseAsSol);
  const covered = payCompensation(due.due, due.due + 10n);
  assert.equal(covered.paid, due.due);
  assert.equal(covered.shortfall, 0n);
  const short = payCompensation(due.due, 100n);
  assert.equal(short.paid, 100n);
  assert.equal(short.shortfall, due.due - 100n);
  assert.equal(short.remaining, 0n);
});

test("platform LP fees are 80% creator_pool, remainder to protocol", () => {
  assert.deepEqual(splitPlatformLpFees(100n), { creatorPool: 80n, protocol: 20n });
  assert.deepEqual(splitPlatformLpFees(101n), { creatorPool: 80n, protocol: 21n });
  assert.deepEqual(splitPlatformLpFees(1n), { creatorPool: 0n, protocol: 1n });
  assert.deepEqual(splitPlatformLpFees(0n), { creatorPool: 0n, protocol: 0n });
  assert.equal(isPlatformFeeChoice("holders"), true);
  assert.equal(isPlatformFeeChoice("split"), true);
  assert.equal(isPlatformFeeChoice("buyback"), true);
  assert.equal(isPlatformFeeChoice("keep"), false);
});

test("partner migration fee is 10% of the 22% (2.2% of threshold)", () => {
  const fee = expectedMigrationFee(threshold);
  const partner = expectedPartnerMigrationFee(threshold);
  const intoPool = (threshold * 78n + 99n) / 100n;
  assert.equal(fee, threshold - intoPool);
  assert.equal(partner, fee - (fee * 90n) / 100n);
});

test("state machine: not complete, locker, migrate, Meteora-first, partial withdraw, compensate, route, mark, lp", () => {
  const cfg = config();
  assert.equal(nextGraduationStep(pool({ quoteReserve: threshold - 1n }), cfg, idleJob), "not_complete");
  assert.equal(curveComplete(pool({ quoteReserve: threshold }), cfg), true);
  assert.equal(lockerNeeded(pool({ migrationProgress: 1 }), cfg), true);
  assert.equal(nextGraduationStep(pool({ migrationProgress: 1, quoteReserve: threshold }), cfg, idleJob), "locker");
  assert.equal(nextGraduationStep(pool({ migrationProgress: 2, quoteReserve: threshold }), cfg, idleJob), "migrate");

  const meteoraFirst = pool({ isMigrated: 1, migrationProgress: 3, quoteReserve: threshold });
  assert.equal(lockerNeeded(meteoraFirst, cfg), false);
  assert.equal(nextGraduationStep(meteoraFirst, cfg, idleJob), "withdraw");

  const withdrawn = pool({
    isMigrated: 1,
    migrationProgress: 3,
    migrationFeeWithdrawStatus: PARTNER_WITHDRAW_BIT,
  });
  assert.equal(partnerWithdrawn(withdrawn), true);
  assert.equal(nextGraduationStep(withdrawn, cfg, idleJob), "compensate");
  assert.equal(
    nextGraduationStep(withdrawn, cfg, { ...idleJob, compensationPaid: true }),
    "route",
  );
  assert.equal(
    nextGraduationStep(withdrawn, cfg, { ...idleJob, compensationPaid: true, routed: true }),
    "mark",
  );
  assert.equal(
    nextGraduationStep(withdrawn, cfg, { ...idleJob, compensationPaid: true, routed: true, marked: true }),
    "lp",
  );
  assert.equal(
    nextGraduationStep(withdrawn, cfg, { ...idleJob, compensationPaid: true, routed: true, marked: true, lpDone: true }),
    "done",
  );
  assert.equal(CREATOR_WITHDRAW_BIT, 0b010);
});

test("Meteora-first is idempotent: already migrated never asks for locker or migrate", () => {
  const cfg = config();
  for (const progress of [0, 1, 2, 3]) {
    const step = nextGraduationStep(
      pool({ isMigrated: 1, migrationProgress: progress, migrationFeeWithdrawStatus: 0 }),
      cfg,
      idleJob,
    );
    assert.equal(step, "withdraw", `progress ${progress}`);
  }
});

test("jobFromRow does not treat a stored compensation amount as paid (pending send)", () => {
  const snap = jobFromRow({ step: "compensate", compensation: "123", partner_fee: "9" });
  assert.equal(snap.compensationPaid, false);
  assert.equal(snap.partnerFee, 9n);
  assert.equal(jobFromRow({ step: "route" }).compensationPaid, true);
});

test("solanaGraduation meta is what the meteora swap indexer reads", () => {
  const meta = solanaGraduationMeta({
    dammPool: "DammPool111111111111111111111111111111111",
    slot: 502512217,
    locker: "Locker11111111111111111111111111111111111",
    firstPositionNft: "PosA",
    secondPositionNft: "PosB",
  });
  assert.equal(meta.solanaGraduation.dex, "meteora-damm-v2");
  assert.equal(meta.solanaGraduation.pool, "DammPool111111111111111111111111111111111");
  assert.equal(meta.solanaGraduation.slot, "502512217");
  assert.equal(meta.solanaGraduation.quoteMint, "So11111111111111111111111111111111111111112");
  assert.equal(meta.dbcMigration.locker, "Locker11111111111111111111111111111111111");
  assert.equal(meta.dbcMigration.positions.creator, "PosA");
  const indexer = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../meteoraSwapIndexer.ts"), "utf8");
  assert.match(indexer, /meta #>> '\{solanaGraduation,pool\}'/);
  assert.match(indexer, /meta #>> '\{solanaGraduation,dex\}' = 'meteora-damm-v2'/);
});

test("VirtualPool discriminator is the IDL bytes", () => {
  assert.deepEqual([...VIRTUAL_POOL_DISCRIMINATOR], [213, 224, 5, 209, 98, 69, 119, 92]);
});

test("finalize route transfers skip league and never send creator pool", () => {
  const collector = Keypair.generate().publicKey;
  const slices = splitDbcFinalizeFee(1_000_000n, "og_linked");
  const built = buildRouteTransfers({ collector, totals: finalizeRouteTotals(slices) });
  assert.ok(!built.destinations.some((item) => item.seed.includes("league")));
  assert.ok(built.destinations.some((item) => item.seed === "recruiter_vault"));
  assert.ok(built.instructions.every((ix) => ix.programId.equals(SystemProgram.programId)));
});

test("an unseen graduation signature expires by block height, never by slot", async () => {
  const conn = (height: number) => ({
    async getSignatureStatuses() { return { value: [null] }; },
    async getSlot() { return 370_000_000; },
    async getBlockHeight() { return height; },
  }) as any;
  assert.equal(await resolveSignature(conn(348_000_000), "sig", 348_000_150), "pending");
  assert.equal(await resolveSignature(conn(348_000_151), "sig", 348_000_150), "expired");
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../dbc/dbcGraduationKeeper.ts"), "utf8");
  assert.match(source, /resolveSignature/);
  assert.match(source, /status = 'sending'/);
  assert.match(source, /Never reset a send that may have landed/);
  assert.match(source, /last_valid_block_height/);
});

test("snake_case pool layout still reads", () => {
  const snap = readPoolSnapshot({
    is_migrated: 1,
    migration_progress: 3,
    migration_fee_withdraw_status: PARTNER_WITHDRAW_BIT,
    quote_reserve: "12",
    protocol_migration_quote_fee_amount: "3",
    protocol_migration_base_fee_amount: "4",
    creator: new PublicKey("11111111111111111111111111111111"),
    base_mint: "Mint",
    config: "Cfg",
    quote_vault: "Q",
    base_vault: "B",
  });
  assert.equal(snap?.isMigrated, 1);
  assert.equal(snap?.protocolMigrationQuoteFeeAmount, 3n);
});
