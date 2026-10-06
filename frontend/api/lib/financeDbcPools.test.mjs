import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:pass@127.0.0.1:1/none";

const {
  DBC_POOLS_SQL,
  DBC_POOLS_SNAPSHOT_KEY,
  DBC_PROGRAM_ID,
  WSOL_MINT,
  atomicDisplay,
  buildDbcPools,
  configFieldsFrom,
  dbcPoolItems,
  dbcPoolTotals,
  expectedMigrationSplit,
  poolFieldsFrom,
} = await import("./financeDbcPools.js");

const COLLECTOR = "3NWtsXixUR3eJjPSNTSVJ62eVxTD4ExHyvdop6TURorY";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Production 2026-10-06: DAZILLA (real), DONOTBUY + MWZDONOTBUY (hidden test coins).
const ROWS = [
  { pool: "CAfqxMHTZc4YHdApxgxbMbUpV6U8CTKo8uoixa92DcaS", mint: "6VJn", name: "DAZILLA", symbol: "DAZILLA", creator_address: "7MQw", config: "6GdL", quote_mint: WSOL_MINT, quote_symbol: "SOL", quote_decimals: "9", fee_choice: "keep", test_coin: false, trades: 185, collector_total: "2765934977", referral_total: "116121567", protocol_total: "814166593", unrouted: 0, last_at: "2026-10-06T12:46:01.321Z" },
  { pool: "GkFy", mint: "12a4", name: "DONOTBUY", symbol: "DNB", creator_address: "CSdC", config: "CKqC", quote_mint: WSOL_MINT, quote_decimals: "9", test_coin: true, trades: 4, collector_total: "5217798", referral_total: "280526", protocol_total: "1535889", unrouted: 0 },
  { pool: "GRAD", mint: "MG", name: "Graduated", symbol: "GRD", creator_address: "CG", config: "CFGG", quote_mint: WSOL_MINT, quote_decimals: "9", test_coin: false, graduated_at_chain: "2026-10-05T00:00:00Z", migrated_pool: "DAMM1", job_step: "done", job_status: "done", job_damm_pool: "DAMM1", job_partner_fee: "2736984726", job_compensation: "12000000", job_shortfall: "0", job_lp_claimed: "500000", trades: 0 },
  { pool: "USDCPOOL", mint: "MU", name: "Bound", symbol: "BND", creator_address: "CU", config: "CFGU", quote_mint: USDC, quote_symbol: "USDC", quote_decimals: "6", test_coin: false, trades: 1, collector_total: "1000000", referral_total: "0", protocol_total: "0", unrouted: 1 },
];

const POOLS = new Map([
  ["CAfqxMHTZc4YHdApxgxbMbUpV6U8CTKo8uoixa92DcaS", { config: "6GdL", quoteReserve: "32149493558", partnerQuoteFee: "7540038", partnerBaseFee: "0", creatorQuoteFee: "208756091", creatorBaseFee: "0", isMigrated: false, migrationFeeWithdrawStatus: 0 }],
  ["GkFy", { config: "CKqC", quoteReserve: "11", partnerQuoteFee: "1000", partnerBaseFee: "0", creatorQuoteFee: "392736", creatorBaseFee: "0", isMigrated: false, migrationFeeWithdrawStatus: 0 }],
  ["GRAD", { config: "CFGG", quoteReserve: "0", partnerQuoteFee: "0", partnerBaseFee: "0", creatorQuoteFee: "0", creatorBaseFee: "0", isMigrated: true, migrationFeeWithdrawStatus: 0b110 }],
  ["USDCPOOL", { config: "CFGU", quoteReserve: "5000000", partnerQuoteFee: "250000", partnerBaseFee: "0", creatorQuoteFee: "0", creatorBaseFee: "0", isMigrated: false, migrationFeeWithdrawStatus: 0 }],
]);
const cfg = (threshold, quoteMint = WSOL_MINT) => ({ quoteMint, feeClaimer: COLLECTOR, leftoverReceiver: COLLECTOR, migrationQuoteThreshold: threshold, migrationFeePercentage: 22, creatorMigrationFeePercentage: 90, creatorTradingFeePercentage: 7 });
const CONFIGS = new Map([["6GdL", cfg("124408396605")], ["CKqC", cfg("126896564327")], ["CFGG", cfg("124408396605")], ["CFGU", cfg("750000000", USDC)]]);

test("migration fee split: production DAZILLA config (124.408396605 SOL) gives 2.736984726 SOL partner", () => {
  const split = expectedMigrationSplit("124408396605");
  assert.equal(split.fee.toString(), "27369847253");
  assert.equal(split.creator.toString(), "24632862527");
  assert.equal(split.partner.toString(), "2736984726");
  assert.equal(split.creator + split.partner, split.fee);
  // Same rounding as realtime-indexer expectedPartnerMigrationFee: pool keeps ceil(78%).
  const tiny = expectedMigrationSplit(101n);
  assert.equal(tiny.fee, 101n - 79n);
  assert.equal(atomicDisplay("2736984726", 9), "2.736984726");
  assert.equal(atomicDisplay("0", 9), "0");
});

test("items: fee counters, recorded claims, migration fee, DAMM partner position, test coin flag", () => {
  const damm = new Map([["GRAD", { position: "POS1", unclaimedQuote: "4200000", unclaimedBase: "77" }]]);
  const items = dbcPoolItems(ROWS, { pools: POOLS, configs: CONFIGS, damm, collector: COLLECTOR });
  const [daz, test, grad, bound] = items;
  assert.equal(daz.stage, "curve");
  assert.equal(daz.testCoin, false);
  assert.equal(daz.partner, COLLECTOR);
  assert.equal(daz.partnerIsCollector, true);
  assert.equal(daz.unclaimed.partnerQuote, "0.007540038");
  assert.equal(daz.unclaimed.creatorQuote, "0.208756091");
  assert.equal(daz.recorded.referral, "0.116121567");
  assert.equal(daz.recorded.collectorClaimed, "2.765934977");
  assert.equal(daz.migrationFee.partner, "2.736984726");
  assert.equal(daz.migrationFee.progressPct, 25.84);
  assert.equal(daz.migrationFee.partnerWithdrawn, false);
  assert.equal(daz.damm, null);
  assert.equal(test.testCoin, true);
  assert.equal(grad.stage, "migrated");
  assert.equal(grad.migrationFee.partnerWithdrawn, true);
  assert.equal(grad.migration.partnerFee, "2.736984726");
  assert.equal(grad.migration.compensation, "0.012");
  assert.equal(grad.damm.unclaimedQuote, "0.0042");
  assert.equal(grad.damm.position, "POS1");
  assert.equal(bound.quote.symbol, "USDC");
  assert.equal(bound.unclaimed.partnerQuote, "0.25");
  assert.equal(bound.recorded.unrouted, 1);
  for (const item of items) assert.deepEqual(item.errors, []);
});

test("totals: SOL only, test coins and bound-quote coins left out; migration fee pending only before migration", () => {
  const damm = new Map([["GRAD", { position: "POS1", unclaimedQuote: "4200000", unclaimedBase: "0" }]]);
  const totals = dbcPoolTotals(dbcPoolItems(ROWS, { pools: POOLS, configs: CONFIGS, damm }));
  assert.equal(totals.asset, "SOL");
  assert.equal(totals.partnerUnclaimed, "0.007540038", "test coin's 1000 lamports and USDC 0.25 left out");
  assert.equal(totals.creatorUnclaimed, "0.208756091");
  assert.equal(totals.dammPartnerUnclaimed, "0.0042");
  assert.equal(totals.migrationFeePartnerPending, "2.736984726", "graduated pool's fee is not pending");
});

test("missing or failed chain reads are named per pool, never shown as zero", () => {
  const items = dbcPoolItems(ROWS.slice(0, 2), { pools: new Map([["GkFy", { error: "boom" }]]), configs: new Map() });
  assert.equal(items[0].unclaimed, null);
  assert.match(items[0].errors[0], /not found/);
  assert.equal(items[1].unclaimed, null);
  assert.match(items[1].errors[0], /boom/);
  assert.equal(items[0].migrationFee, null);
});

test("decoders: camelCase SDK and snake_case IDL shapes", () => {
  const bn = (v) => ({ toString: () => String(v) });
  const pk = (v) => ({ toBase58: () => v });
  const fromSdk = poolFieldsFrom({ poolState: { config: pk("C"), creator: pk("K"), baseMint: pk("M"), quoteReserve: bn(5), partnerQuoteFee: bn(7), partnerBaseFee: bn(0), creatorQuoteFee: bn(3), creatorBaseFee: bn(0), isMigrated: 1, migrationFeeWithdrawStatus: 4 } });
  assert.deepEqual([fromSdk.config, fromSdk.partnerQuoteFee, fromSdk.creatorQuoteFee, fromSdk.isMigrated, fromSdk.migrationFeeWithdrawStatus], ["C", "7", "3", true, 4]);
  const fromIdl = poolFieldsFrom({ config: "C", partner_quote_fee: "9", is_migrated: 0, migration_fee_withdraw_status: 0 });
  assert.equal(fromIdl.partnerQuoteFee, "9");
  assert.equal(fromIdl.isMigrated, false);
  const c = configFieldsFrom({ quote_mint: pk(WSOL_MINT), fee_claimer: pk(COLLECTOR), migration_quote_threshold: bn(100), migration_fee_percentage: 22, creator_migration_fee_percentage: 90 });
  assert.equal(c.feeClaimer, COLLECTOR);
  assert.equal(c.migrationQuoteThreshold, "100");
});

test("SQL: DBC campaigns on chain 101 with the hidden flag, keeper job and accrual totals", () => {
  assert.match(DBC_POOLS_SQL, /c\.chain_id = 101/);
  assert.match(DBC_POOLS_SQL, /coalesce\(c\.launch_type, 'launchpad'\) = 'dbc'/);
  assert.match(DBC_POOLS_SQL, /meta->>'publicHidden'/);
  assert.match(DBC_POOLS_SQL, /public\.dbc_graduation_jobs/);
  assert.match(DBC_POOLS_SQL, /public\.dbc_fee_accruals/);
  assert.match(DBC_POOLS_SQL, /limit \$1/);
  assert.doesNotMatch(DBC_POOLS_SQL, /\b(insert|update|delete)\b/i);
});

function fakeDb(rows) {
  const calls = [];
  return { calls, async query(text, params) { calls.push({ text, params }); return { rows }; } };
}

test("build: reads pools then configs, DAMM only for migrated pools with the config's fee claimer; no harvest", async () => {
  const reads = [];
  const dammReads = [];
  const accounts = new Map([...POOLS.keys(), ...CONFIGS.keys()].map((a) => [a, { owner: DBC_PROGRAM_ID, bytes: Buffer.from(a) }]));
  const result = await buildDbcPools({
    db: fakeDb(ROWS),
    env: { DBC_FEE_COLLECTOR: COLLECTOR },
    readAccounts: async (addresses) => { reads.push(addresses); return new Map(addresses.map((a) => [a, accounts.get(a) || null])); },
    decodePool: (bytes) => POOLS.get(bytes.toString()),
    decodeConfig: (bytes) => CONFIGS.get(bytes.toString()),
    readDammPartner: async (input) => { dammReads.push(input); return { position: "POS1", unclaimedQuote: "1", unclaimedBase: "0" }; },
    now: () => new Date("2026-10-06T13:00:00Z"),
  });
  assert.equal(reads.length, 2);
  assert.deepEqual(reads[0], ROWS.map((r) => r.pool));
  assert.deepEqual(reads[1].sort(), ["6GdL", "CFGG", "CFGU", "CKqC"]);
  assert.deepEqual(dammReads, [{ dammPool: "DAMM1", owner: COLLECTOR, quoteMint: WSOL_MINT }]);
  assert.equal(result.ok, true);
  assert.equal(result.chainId, 101);
  assert.equal(result.harvest.available, false);
  assert.equal(result.items.length, 4);
  assert.equal(result.totals.partnerUnclaimed, "0.007540038");
  assert.equal(result.updatedAt, "2026-10-06T13:00:00.000Z");
  assert.equal(DBC_POOLS_SNAPSHOT_KEY, "dbc-pools:101:mainnet-beta");
});

test("build: an RPC failure marks every pool unread and keeps the DB figures", async () => {
  const result = await buildDbcPools({
    db: fakeDb(ROWS.slice(0, 1)),
    env: {},
    readAccounts: async () => { throw new Error("429 Too Many Requests"); },
    decodePool: () => ({}), decodeConfig: () => ({}),
    readDammPartner: async () => { throw new Error("not called"); },
  });
  assert.match(result.chainError, /429/);
  assert.equal(result.items[0].unclaimed, null);
  assert.match(result.items[0].errors[0], /429/);
  assert.equal(result.items[0].recorded.referral, "0.116121567");
});

test("build: a pool owned by another program is refused, not decoded", async () => {
  const result = await buildDbcPools({
    db: fakeDb(ROWS.slice(0, 1)),
    env: {},
    readAccounts: async (addresses) => new Map(addresses.map((a) => [a, { owner: "Other111", bytes: Buffer.from(a) }])),
    decodePool: () => { throw new Error("must not decode"); }, decodeConfig: () => { throw new Error("must not decode"); },
  });
  assert.match(result.items[0].errors[0], /not the DBC program/);
});

test("LP fee read: DBC pools attached for the Solana mainnet admin read only", async () => {
  const { attachDbcPools } = await import("../dashboard/lp-fees.js");
  const body = { ok: true, chainId: 101, items: [] };
  const read = async () => ({ ok: true, items: [{ pool: "P" }] });
  const main = { chainId: "101", environment: "production", solanaCluster: "mainnet-beta" };
  const out = await attachDbcPools(main, { mode: "admin" }, body, { read });
  assert.deepEqual(out.dbcPools.items, [{ pool: "P" }]);
  assert.deepEqual(out.items, [], "launchpad LP items unchanged: no harvest button for DBC");
  assert.equal((await attachDbcPools(main, { mode: "ops-key" }, body, { read })).dbcPools.ok, true);
  assert.equal(await attachDbcPools(main, { mode: "creator-self", creator: "x" }, body, { read }), body);
  assert.equal(await attachDbcPools({ ...main, campaign: "C" }, { mode: "admin" }, body, { read }), body);
  assert.equal(await attachDbcPools({ chainId: "101", environment: "staging", solanaCluster: "devnet" }, { mode: "admin" }, body, { read }), body);
  assert.equal(await attachDbcPools({ chainId: "56" }, { mode: "admin" }, body, { read }), body);
  const failed = await attachDbcPools(main, { mode: "admin" }, body, { read: async () => { throw new Error("rpc down"); } });
  assert.equal(failed.dbcPools.ok, false);
  assert.match(failed.dbcPools.error, /rpc down/);
  assert.deepEqual(failed.items, []);
});

test("snapshot job: the DBC pool step is wired for Solana only", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./financeSnapshotJobs.js", import.meta.url), "utf8");
  assert.match(source, /network\.chain !== "solana"[\s\S]*?else if \(refreshDbcPools\)[\s\S]*?DBC_POOLS_SNAPSHOT_KEY/);
});
