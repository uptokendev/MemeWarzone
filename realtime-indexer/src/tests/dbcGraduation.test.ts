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
  finalizeAfterCompensation,
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
    lockedVestingConfig: { amountPerPeriod: 1_000_000n, numberOfPeriod: 1n, cliffUnlockAmount: 19_999_999_000_000n },
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

test("D7 is paid from the protocol slice after splitting the whole partner fee", () => {
  const partnerFee = 2_200_000n;
  const uncompensated = splitDbcFinalizeFee(partnerFee, "standard_linked");
  const due = 500_000n;
  const applied = finalizeAfterCompensation(partnerFee, "standard_linked", due);
  assert.equal(applied.slices.recruiter, uncompensated.recruiter);
  assert.equal(applied.slices.squad, uncompensated.squad);
  assert.equal(applied.slices.airdrop, uncompensated.airdrop);
  assert.equal(applied.paid, due);
  assert.equal(applied.shortfall, 0n);
  assert.equal(applied.slices.protocol, uncompensated.protocol - due);
  assert.equal(applied.slices.remaining, partnerFee - due);
  assert.equal(finalizeSlicesConserve(applied.slices), true);

  const tooMuch = uncompensated.protocol + 185_000n;
  const short = finalizeAfterCompensation(partnerFee, "standard_linked", tooMuch);
  assert.equal(short.paid, uncompensated.protocol);
  assert.equal(short.shortfall, 185_000n);
  assert.equal(short.slices.protocol, 0n);
  assert.equal(short.slices.recruiter, uncompensated.recruiter);
  assert.equal(short.slices.squad, uncompensated.squad);
  assert.equal(short.slices.airdrop, uncompensated.airdrop);
  assert.equal(finalizeSlicesConserve(short.slices), true);
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

test("state machine: locker, migrate, mark, withdraw, compensate, route, done", () => {
  const cfg = config();
  assert.equal(nextGraduationStep(pool({ quoteReserve: threshold - 1n }), cfg, idleJob), "not_complete");
  assert.equal(curveComplete(pool({ quoteReserve: threshold }), cfg), true);
  assert.equal(lockerNeeded(pool({ migrationProgress: 1 }), cfg), true);
  assert.equal(nextGraduationStep(pool({ migrationProgress: 1, quoteReserve: threshold }), cfg, idleJob), "locker");
  assert.equal(nextGraduationStep(pool({ migrationProgress: 2, quoteReserve: threshold }), cfg, idleJob), "migrate");

  const meteoraFirst = pool({ isMigrated: 1, migrationProgress: 3, quoteReserve: threshold });
  assert.equal(lockerNeeded(meteoraFirst, cfg), false);
  assert.equal(nextGraduationStep(meteoraFirst, cfg, idleJob), "mark");

  const marked = { ...idleJob, marked: true };
  assert.equal(nextGraduationStep(meteoraFirst, cfg, marked), "withdraw");

  const withdrawn = pool({
    isMigrated: 1,
    migrationProgress: 3,
    migrationFeeWithdrawStatus: PARTNER_WITHDRAW_BIT,
  });
  assert.equal(partnerWithdrawn(withdrawn), true);
  assert.equal(nextGraduationStep(withdrawn, cfg, marked), "compensate");
  assert.equal(
    nextGraduationStep(withdrawn, cfg, { ...marked, compensationPaid: true }),
    "route",
  );
  assert.equal(
    nextGraduationStep(withdrawn, cfg, { ...marked, compensationPaid: true, routed: true }),
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
    assert.equal(step, "mark", `progress ${progress}`);
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

test("production graduation migration does not create notification_outbox", () => {
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations/20260929_000007_dbc_graduation.sql"), "utf8");
  assert.doesNotMatch(sql, /notification_outbox/);
  assert.match(sql, /lp_signature/);
  assert.match(sql, /'locker', 'migrate', 'mark', 'withdraw', 'compensate', 'route', 'done'/);
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

test("second position NFT is looked up under the collector", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../dbc/dbcGraduationKeeper.ts"), "utf8");
  assert.match(source, /getUserPositionByPool\(new PublicKey\(dammPool\), partnerOwner\)/);
  assert.match(source, /input\.collector\?\.publicKey/);
  assert.doesNotMatch(source, /partnerOwner = String\(input\.row\.creator/);
});

test("worker subscribes per pool, not the whole DBC program", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../dbcGraduationWorker.ts"), "utf8");
  assert.match(source, /onAccountChange/);
  assert.match(source, /listWatchPools/);
  assert.match(source, /runDbcLpClaimsOnce/);
  assert.doesNotMatch(source, /onProgramAccountChange/);
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
  assert.match(source, /heldCreatorPoolSum/);
  assert.match(source, /listOpenGraduationPools/);
  assert.match(source, /runDbcLpClaimsOnce/);
  assert.doesNotMatch(source, /break;/);
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

test("LP claim rows: what moved is recorded, the rest of the protocol share goes to the router", async () => {
  const { lpClaimRows } = await import("../dbc/dbcGraduationKeeper.js");
  // keep coin: all of our position's fees are protocol; 900 sent, 100 arrived after the read
  assert.deepEqual(lpClaimRows(1_000n, 900n, false), { creatorPool: 0n, transferred: 900n, leftover: 100n });
  // platform coin: 80% creator pool, protocol share 20% of what was claimed
  assert.deepEqual(lpClaimRows(10_000n, 1_800n, true), { creatorPool: 8_000n, transferred: 1_800n, leftover: 200n });
  assert.deepEqual(lpClaimRows(9_999n, 2_000n, true), { creatorPool: 7_999n, transferred: 2_000n, leftover: 0n });
  // sending more than the protocol share would spend someone else's money on the collector
  assert.throws(() => lpClaimRows(1_000n, 300n, true), /exceeds the protocol share/);
});

test("the creator reserve is read from the vesting schedule, so the locker is not skipped", async () => {
  const { readConfigSnapshot, lockerNeeded } = await import("../dbc/dbcGraduationState.js");
  // shape of a real devnet PoolConfig (2026-09-29), snake_case as the IDL decodes it
  const config = readConfigSnapshot({
    migration_quote_threshold: 250_170_318n,
    locked_vesting_config: { amount_per_period: 1_000_000n, number_of_period: 1n, cliff_unlock_amount: 19_999_999_000_000n },
    quote_mint: "So11111111111111111111111111111111111111112",
  } as any)!;
  assert.equal(config.lockedVestingAmount, 20_000_000_000_000n);
  assert.equal(lockerNeeded({ isMigrated: 0, migrationProgress: 1 } as any, config), true);
});

test("bound D7 is TransferChecked; graduation route and LP claims swap first", () => {
  const keeper = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../dbc/dbcGraduationKeeper.ts"), "utf8");
  assert.match(keeper, /buildD7CompensationIxs/);
  assert.match(keeper, /swapClaimedQuoteIfNeeded/);
  assert.match(keeper, /leftoverAlreadySol/);
  assert.match(keeper, /isNativeQuoteMint\(quotePk\.toBase58\(\)\)/);
  const transfers = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../dbc/dbcQuoteTransfers.ts"), "utf8");
  assert.match(transfers, /createTransferCheckedInstruction/);
  assert.match(transfers, /SystemProgram\.transfer/);
  const router = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../dbc/dbcFeeRouter.ts"), "utf8");
  assert.match(router, /splitSolFromQuoteSwap/);
  assert.match(router, /swapClaimedQuoteIfNeeded/);
});
