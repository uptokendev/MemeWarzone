import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildPayouts } from "./financePayouts.js";
import {
  CREATOR_FEE_CLAIMED_DISCRIMINATOR,
  clearCreatorClaimHistoryCache,
  creatorFeeClaimsFromTransaction,
  decodeCreatorFeeClaimedEvents,
  decodeCreatorFeeVault,
  readCreatorClaimHistory,
  reconcileCreatorFees,
} from "./solanaCreatorFeeClaims.js";
import { computeCreatorFeeClaimable, SOLANA_LAUNCHPAD_PROGRAM_ID } from "./solanaCreatorFeeMath.js";
import { V2_EVENT_TOPICS, decodeV2Log, encodeAddressGetter, mergeV2Rows, summarizeV2Events } from "./evmCreatorFeeClaims.js";

// Real mainnet transactions and accounts (K88), saved 2026-10-05.
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/k88-creator-fee-claims-mainnet.json", import.meta.url), "utf8"));
const K88 = "Hsa3rJRQHVs8hB9psXipLjRz66kKr9Nhcrc8wGmH9edA";
// K88 mint (public on-chain address).
const K88_MINT = "4VPtpo5qQmmbva9JHYU2eiH9UY6Xf32nCbKKB5ZeYb77";
const VAULT = "EGEoimrus23swhWgXEkzxdw7nP6h121rnVTMM73wwuRz";
const CREATOR = "8doLGRWZsKTGcAYg84PGo8agW4WaDdqQynByMnbtwG4R";
const NOW = "2026-10-05T12:00:00.000Z";
const tx = (prefix) => FIXTURE.transactions.find((t) => t.signature.startsWith(prefix));

// ---------------------------------------------------------------------------
// Parser (real transactions)

test("claim parser: the three K88 claims, exact lamports, running total, vault and creator", () => {
  const claims = ["3Scw1xQw5E", "48xkFpp5ow", "3giWhf2Cu1"].flatMap((p) => creatorFeeClaimsFromTransaction(tx(p), { signature: tx(p).signature }));
  assert.equal(claims.length, 3);
  assert.deepEqual(claims.map((c) => c.amountLamports), [53_990_213n, 5_685_143n, 2_265_956n]);
  assert.deepEqual(claims.map((c) => c.totalClaimedLamports), [53_990_213n, 59_675_356n, 61_941_312n]);
  for (const c of claims) {
    assert.equal(c.campaign, K88);
    assert.equal(c.creatorFeeVault, VAULT);
    assert.equal(c.creator, CREATOR);
  }
  assert.equal(claims[0].blockTime, "2026-09-27T07:03:54.000Z");
  assert.equal(claims[2].signature, tx("3giWhf2Cu1").signature);
});

test("claim parser: a buy and a treasury league claim are not creator fee claims", () => {
  assert.deepEqual(creatorFeeClaimsFromTransaction(tx("z4cY1KQgL9")), []);
  assert.deepEqual(creatorFeeClaimsFromTransaction(tx("2P2Y6TcgDz")), []);
  // A failed transaction pays nothing even if its logs carried the event.
  assert.deepEqual(creatorFeeClaimsFromTransaction({ ...tx("3Scw1xQw5E"), meta: { ...tx("3Scw1xQw5E").meta, err: { InstructionError: [1, "Custom"] } } }), []);
});

test("claim parser: the event only counts when the launchpad itself logged it", () => {
  const data = tx("3Scw1xQw5E").meta.logMessages.find((l) => l.startsWith("Program data: ") && Buffer.from(l.slice(14), "base64").subarray(0, 8).equals(CREATOR_FEE_CLAIMED_DISCRIMINATOR));
  const other = "11111111111111111111111111111111";
  const spoof = [`Program ${other} invoke [1]`, data, `Program ${other} success`];
  assert.equal(decodeCreatorFeeClaimedEvents(spoof).length, 0);
  const real = [`Program ${SOLANA_LAUNCHPAD_PROGRAM_ID} invoke [1]`, data, `Program ${SOLANA_LAUNCHPAD_PROGRAM_ID} success`];
  assert.equal(decodeCreatorFeeClaimedEvents(real).length, 1);
  // Inside a CPI from the launchpad to another program, the line is that program's.
  const nested = [`Program ${SOLANA_LAUNCHPAD_PROGRAM_ID} invoke [1]`, `Program ${other} invoke [2]`, data, `Program ${other} success`, `Program ${SOLANA_LAUNCHPAD_PROGRAM_ID} success`];
  assert.equal(decodeCreatorFeeClaimedEvents(nested).length, 0);
});

// ---------------------------------------------------------------------------
// Accounts and reconciliation (real accounts)

function account(a) {
  return { lamports: BigInt(a.lamports), owner: a.owner, data: Buffer.from(a.dataBase64, "base64") };
}

test("vault decode: K88's running total is the sum of its three claims", () => {
  const vault = decodeCreatorFeeVault(account(FIXTURE.vaultAccount).data);
  assert.equal(vault.campaign, K88);
  assert.equal(vault.creator, CREATOR);
  assert.equal(vault.totalClaimedLamports, 61_941_312n);
  assert.equal(vault.pendingLamports, 0n);
  assert.equal(decodeCreatorFeeVault(Buffer.alloc(10)), null);
});

test("reconciliation: K88 earned (reward_events 63,996,466) = paid 61,941,312 + claimable 2,055,154, to the lamport", () => {
  const computed = computeCreatorFeeClaimable({
    escrow: account(FIXTURE.escrowAccount),
    vault: account(FIXTURE.vaultAccount),
    escrowRent: FIXTURE.rentExemptMinimum["106"],
    vaultRent: FIXTURE.rentExemptMinimum["98"],
    programId: SOLANA_LAUNCHPAD_PROGRAM_ID,
  });
  assert.equal(computed.claimableLamports, 2_055_154n);
  // FeeEscrow.total_received is every fee lamport the coin paid; the creator's slice is 5% of it.
  const escrowData = account(FIXTURE.escrowAccount).data;
  assert.equal(escrowData.readBigUInt64LE(88), 1_279_930_139n);
  const r = reconcileCreatorFees({ earnedRaw: "63996466", paidRaw: 61_941_312n, claimableRaw: computed.claimableLamports });
  assert.equal(r.status, "balanced");
  assert.equal(r.gapRaw, "0");
});

test("reconciliation: a gap is reported in the right direction; a missing input is unknown", () => {
  assert.equal(reconcileCreatorFees({ earnedRaw: "100", paidRaw: "60", claimableRaw: "30" }).status, "earned_more");
  assert.equal(reconcileCreatorFees({ earnedRaw: "100", paidRaw: "60", claimableRaw: "50" }).gapRaw, "-10");
  assert.equal(reconcileCreatorFees({ earnedRaw: "100", paidRaw: "60", claimableRaw: "39", toleranceRaw: 1n }).status, "balanced");
  assert.equal(reconcileCreatorFees({ earnedRaw: null, paidRaw: "1", claimableRaw: "1" }).status, "unknown");
});

// ---------------------------------------------------------------------------
// Chain history read (fake RPC answering with the real transactions)

function fakeSolanaRpc() {
  const calls = [];
  const sigs = [
    // newest first, as getSignaturesForAddress answers
    { signature: tx("3giWhf2Cu1").signature, err: null },
    { signature: tx("48xkFpp5ow").signature, err: null },
    { signature: tx("3Scw1xQw5E").signature, err: null },
    { signature: "5KJvoRUmefFailedInitSig", err: { InstructionError: [0, "x"] } },
  ];
  const rpc = async (method, params) => {
    calls.push(method);
    if (method === "getSignaturesForAddress") return sigs;
    if (method === "getTransaction") return FIXTURE.transactions.find((t) => t.signature === params[0]) || null;
    throw new Error(`unexpected ${method}`);
  };
  return { rpc, calls };
}

test("history read: every claim of the vault, oldest first, complete when it adds up; cached while the total is unchanged", async () => {
  clearCreatorClaimHistoryCache();
  const { rpc, calls } = fakeSolanaRpc();
  const t0 = Date.parse(NOW);
  const first = await readCreatorClaimHistory({ rpc, vault: VAULT, totalClaimedLamports: 61_941_312n, nowMs: t0 });
  assert.equal(first.complete, true);
  assert.equal(first.cached, false);
  assert.deepEqual(first.claims.map((c) => c.amountLamports), [53_990_213n, 5_685_143n, 2_265_956n]);
  // Failed signatures are never fetched.
  assert.equal(calls.filter((m) => m === "getTransaction").length, 3);

  const again = await readCreatorClaimHistory({ rpc, vault: VAULT, totalClaimedLamports: 61_941_312n, nowMs: t0 + 86_400_000 });
  assert.equal(again.cached, true);
  assert.equal(calls.length, 4);

  // A new claim (total moved) within 10 minutes of the last read: the old list is served, flagged incomplete.
  const soon = await readCreatorClaimHistory({ rpc, vault: VAULT, totalClaimedLamports: 61_941_313n, nowMs: t0 + 60_000 });
  assert.equal(soon.cached, true);
  assert.equal(soon.complete, false);
  // After 10 minutes it is read again.
  const later = await readCreatorClaimHistory({ rpc, vault: VAULT, totalClaimedLamports: 61_941_313n, nowMs: t0 + 11 * 60_000 });
  assert.equal(later.cached, false);
  assert.equal(later.complete, false);
});

// ---------------------------------------------------------------------------
// Full Solana build: public coin, hidden test coin, indexed rows vs chain fallback

function priceService() {
  return {
    async valueAtSpot(_a, amount) { return amount == null ? { amountUsd: null } : { amountUsd: Number(amount) * 100, priceUsd: 100, priceSource: "test", priceAt: NOW, priceBasis: "current" }; },
    async valueEvents(_a, buckets, decimals) { return { amountUsd: buckets.reduce((s, b) => s + Number(b.raw) / 10 ** decimals, 0) * 100, priceUsd: 100, priceSource: "test", priceAt: NOW, priceBasis: "event_time" }; },
    async spotTable(assets) { return assets.map((asset) => ({ asset, priceUsd: 100 })); },
  };
}

function fakeDb(handlers) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      seen.push(sql);
      for (const [pattern, rows] of handlers) if (pattern.test(sql)) {
        if (rows instanceof Error) throw rows;
        return { rows: typeof rows === "function" ? rows(sql, params) : rows };
      }
      return { rows: [] };
    },
  };
}

const SOLANA = { chainId: 101, chain: "solana", environment: "production", cluster: "mainnet-beta", nativeSymbol: "SOL", nativeDecimals: 9 };
const TEST_COIN = "Bmp1sVCkv749fnRi8p8SjzUE9EJypSXamKJtKoYZe192";

function solanaHandlers({ recorded } = {}) {
  return [
    [/from public\.campaigns\s+where chain_id = 101/, [
      { campaign_address: K88, token_address: K88_MINT, name: "KAIJU88", symbol: "K88", test_coin: false },
      { campaign_address: TEST_COIN, token_address: null, name: "Kaiju88", symbol: "K88OLD", test_coin: true },
    ]],
    [/from public\.reward_events r/, [
      { campaign_address: K88, hour: "2026-09-26T10:00:00Z", test_coin: false, creator: "60000000" },
      { campaign_address: K88, hour: "2026-10-04T13:00:00Z", test_coin: false, creator: "3996466" },
      { campaign_address: TEST_COIN, hour: "2026-09-19T15:00:00Z", test_coin: true, creator: "500" },
    ]],
    [/from public\.creator_fee_claims/, recorded instanceof Error ? recorded : (recorded || [])],
  ];
}

const SOLANA_READERS = (history) => ({
  readSolanaAccountData: async () => { throw new Error("offline"); },
  readSolanaCreatorClaimable: async (_ctx, campaigns) => ({
    status: "ok", raw: "2056154", coins: campaigns.length, coinsWithFees: 2,
    perCoin: [
      { campaign: K88, creatorFeeVault: VAULT, vaultInitialized: true, claimableRaw: "2055154", totalClaimedRaw: "61941312", creator: CREATOR },
      { campaign: TEST_COIN, creatorFeeVault: "TestVault1111111111111111111111111111111111", vaultInitialized: true, claimableRaw: "1000", totalClaimedRaw: "909650", creator: CREATOR },
    ],
  }),
  readSolanaCreatorClaimHistory: history,
});

const chainHistory = async () => ({
  claims: ["3Scw1xQw5E", "48xkFpp5ow", "3giWhf2Cu1"].flatMap((p) => creatorFeeClaimsFromTransaction(tx(p), { signature: tx(p).signature })),
  complete: true, sumLamports: 61_941_312n, cached: false, readAt: NOW,
});

test("Solana build: K88 paid from the chain with every claim and link; test coin kept apart; earned = paid + claimable", async () => {
  let historyCalls = 0;
  const out = await buildPayouts({
    network: SOLANA, days: 30, db: fakeDb(solanaHandlers({ recorded: Object.assign(new Error("relation does not exist"), { code: "42P01" }) })),
    env: { SOLANA_CLUSTER: "mainnet-beta" }, feeRouting: { destinations: [], wiring: [] },
    readers: SOLANA_READERS(async (...args) => { historyCalls += 1; return chainHistory(...args); }), prices: priceService(), now: () => NOW,
  });
  const t = out.types.find((x) => x.id === "creator_fees");
  assert.equal(t.paid.recorded, true);
  assert.equal(t.paid.allTime.raw, "61941312");
  assert.equal(t.paid.allTime.count, 3);
  assert.equal(t.paid.lastPayout.txUrl, `https://solscan.io/tx/${tx("3giWhf2Cu1").signature}`);
  // Test coin: its claims and claimable are left out and shown apart.
  assert.equal(t.paid.testCoinsLeftOut, "0.00090965");
  assert.equal(t.owed.claimable.raw, "2055154");
  assert.equal(t.owed.testCoins.raw, "1000");
  assert.equal(t.earned.allTime.raw, "63996466");
  const coin = t.creatorFees.coins[0];
  assert.equal(t.creatorFees.coins.length, 1);
  assert.equal(coin.symbol, "K88");
  assert.equal(coin.claims.length, 3);
  assert.equal(coin.claims[0].amount, "0.053990213");
  assert.equal(coin.claimsComplete, true);
  assert.equal(coin.reconciliation.status, "balanced");
  assert.equal(t.creatorFees.reconciliation.gap, "0");
  assert.equal(t.creatorFees.testCoins.count, 1);
  assert.equal(t.creatorFees.testCoins.paid.raw, "909650");
  assert.equal(historyCalls, 1, "only the public coin's history is read");
  assert.ok(!t.warnings.length);
  // Totals that use Payouts now include the creator claims.
  assert.equal(out.totals.paid.byChain[0].assets[0].amountNative, "0.061941312");
});

test("Solana build: indexed rows that add up to the vault total are used and the chain is not read", async () => {
  const recorded = [
    { campaign_address: K88, creator_wallet: CREATOR, amount_raw: "53990213", tx_signature: tx("3Scw1xQw5E").signature, log_index: 9, block_time: "2026-09-27T07:03:54Z" },
    { campaign_address: K88, creator_wallet: CREATOR, amount_raw: "5685143", tx_signature: tx("48xkFpp5ow").signature, log_index: 9, block_time: "2026-09-29T04:48:54Z" },
    { campaign_address: K88, creator_wallet: CREATOR, amount_raw: "2265956", tx_signature: tx("3giWhf2Cu1").signature, log_index: 9, block_time: "2026-10-01T12:21:57Z" },
  ];
  const out = await buildPayouts({
    network: SOLANA, days: 30, db: fakeDb(solanaHandlers({ recorded })), env: {}, feeRouting: { destinations: [], wiring: [] },
    readers: SOLANA_READERS(async () => { throw new Error("must not read the chain"); }), prices: priceService(), now: () => NOW,
  });
  const coin = out.types.find((x) => x.id === "creator_fees").creatorFees.coins[0];
  assert.equal(coin.claimsSource, "db:creator_fee_claims");
  assert.equal(coin.claims.length, 3);
});

test("Solana build: a row missing from the table falls back to the chain; an unreadable chain keeps the vault total", async () => {
  const partial = [{ campaign_address: K88, creator_wallet: CREATOR, amount_raw: "53990213", tx_signature: tx("3Scw1xQw5E").signature, log_index: 9, block_time: "2026-09-27T07:03:54Z" }];
  const out = await buildPayouts({
    network: SOLANA, days: 30, db: fakeDb(solanaHandlers({ recorded: partial })), env: {}, feeRouting: { destinations: [], wiring: [] },
    readers: SOLANA_READERS(async () => { throw new Error("rpc down"); }), prices: priceService(), now: () => NOW,
  });
  const t = out.types.find((x) => x.id === "creator_fees");
  assert.equal(t.paid.recorded, true);
  // The total is the vault's counter even without the transaction list.
  assert.equal(t.paid.allTime.raw, "61941312");
  assert.match(t.creatorFees.coins[0].note, /could not be read/);
});

test("Solana build: fee accounts that do not read make paid and owed unknown, never zero", async () => {
  const out = await buildPayouts({
    network: SOLANA, days: 30, db: fakeDb(solanaHandlers()), env: {}, feeRouting: { destinations: [], wiring: [] },
    readers: { readSolanaAccountData: async () => { throw new Error("offline"); }, readSolanaCreatorClaimable: async () => { throw new Error("rpc down"); } },
    prices: priceService(), now: () => NOW,
  });
  const t = out.types.find((x) => x.id === "creator_fees");
  assert.equal(t.paid.recorded, false);
  assert.equal(t.paid.allTime.amount, null);
  assert.equal(t.owed.known, false);
});

// ---------------------------------------------------------------------------
// EVM

const BNB = { chainId: 56, chain: "bnb", environment: "mainnet", nativeSymbol: "BNB", nativeDecimals: 18 };
const V1 = "0x72A963682B261195EB43F8f75e0515ab279EbD14";
const V2 = "0x6Cb44e3dB907801a04FA7A056Fbe79799298AF66";
const PUBLIC_EVM = "0x1111111111111111111111111111111111111111";
const TEST_EVM = "0x49ac80f9ccb0b4b88c2d98671a04cb146c0c6eb3";
const word = (n) => `0x${BigInt(n).toString(16).padStart(64, "0")}`;

test("EVM helpers: getter encoding, log decode, merge without double counting", () => {
  assert.equal(encodeAddressGetter("creatorBalance", PUBLIC_EVM).length, 10 + 64);
  const log = {
    address: V2, topics: [V2_EVENT_TOPICS.CreatorFeesClaimed, `0x${"0".repeat(24)}${PUBLIC_EVM.slice(2)}`, `0x${"0".repeat(24)}${"ab".repeat(20)}`],
    data: word(5000), transactionHash: `0x${"c".repeat(64)}`, logIndex: "0x3", blockNumber: "0x10",
  };
  const row = decodeV2Log(log);
  assert.equal(row.event_name, "CreatorFeesClaimed");
  assert.equal(row.args.amount, "5000");
  assert.equal(row.campaign_address, PUBLIC_EVM);
  const merged = mergeV2Rows([{ ...row, block_time: "2026-10-02T00:00:00Z" }], [row]);
  assert.equal(merged.length, 1);
  const s = summarizeV2Events([...merged, { contract_address: V2.toLowerCase(), campaign_address: PUBLIC_EVM, event_name: "TradeFeeAccrued", args: { toCreator: "9000" }, tx_hash: "0x1", log_index: 0 }], { vault: V2 });
  assert.equal(s.get(PUBLIC_EVM).claimedRaw, 5000n);
  assert.equal(s.get(PUBLIC_EVM).earnedRaw, 9000n);
});

function evmRouting() {
  const d = (id, address, raw) => ({ id, label: id, address, flags: [], balances: [{ asset: "BNB", decimals: 18, raw, amount: String(Number(raw) / 1e18), status: "ok", source: "rpc:test", asOf: NOW }] });
  return { destinations: [d("creator_vault_v2", V2, "6000"), d("creator_vault_v1", V1, "0")], wiring: [] };
}

test("EVM build: per-coin paid from V2 claims (with links) plus V1 running totals; hidden coins apart; nothing claimed is 0 recorded", async () => {
  const db = fakeDb([
    [/from public\.campaigns\s+where chain_id = \$1/, [
      { campaign_address: PUBLIC_EVM, token_address: null, name: "Pub", symbol: "PUB", test_coin: false },
      { campaign_address: TEST_EVM, token_address: null, name: "MWZDONOTBUY", symbol: "MWZBNB", test_coin: true },
    ]],
    [/from public\.evm_campaign_events/, [
      { contract_address: V2.toLowerCase(), campaign_address: PUBLIC_EVM, event_name: "TradeFeeAccrued", args: { toCreator: "9000" }, tx_hash: "0xa", log_index: 1, block_time: "2026-10-02T00:00:00Z" },
      { contract_address: V2.toLowerCase(), campaign_address: PUBLIC_EVM, event_name: "CreatorFeesClaimed", args: { creator: "0xabc", amount: "5000" }, tx_hash: `0x${"d".repeat(64)}`, log_index: 2, block_time: "2026-10-03T00:00:00Z" },
      { contract_address: V2.toLowerCase(), campaign_address: TEST_EVM, event_name: "CreatorFeesClaimed", args: { creator: "0xdef", amount: "7" }, tx_hash: `0x${"e".repeat(64)}`, log_index: 0, block_time: "2026-10-03T00:00:00Z" },
    ]],
    [/from public\.indexer_state/, [{ last_indexed_block: "125760521", updated_at: NOW }]],
  ]);
  const out = await buildPayouts({
    network: BNB, days: 30, db, env: {}, feeRouting: evmRouting(), prices: priceService(), now: () => NOW,
    readers: {
      async readEvmCall() { return { hex: word(0), rpc: "test" }; },
      async readEvmNative() { return { raw: "0", rpc: "test" }; },
      async readEvmCreatorV2Logs() { return { rows: [], complete: true, head: 2, scannedTo: 2 }; },
      async readEvmCreatorCoins(_ctx, { campaigns }) {
        return campaigns.map((campaign) => ({ campaign, v1: campaign === PUBLIC_EVM ? { earnedRaw: "100", claimedRaw: "40", claimableRaw: "60" } : { earnedRaw: "0", claimedRaw: "0", claimableRaw: "0" }, v2: { claimableRaw: campaign === PUBLIC_EVM ? "4000" : "1" } }));
      },
    },
  });
  const t = out.types.find((x) => x.id === "creator_fees");
  assert.equal(t.paid.recorded, true);
  assert.equal(t.paid.allTime.raw, "5040");
  assert.equal(t.paid.lastPayout.txUrl, `https://bscscan.com/tx/0x${"d".repeat(64)}`);
  assert.equal(t.paid.testCoinsLeftOut, "0.000000000000000007");
  assert.equal(t.earned.allTime.raw, "9100");
  const coin = t.creatorFees.coins[0];
  assert.equal(coin.paid.raw, "5040");
  assert.equal(coin.claimable.raw, "4060");
  assert.equal(coin.reconciliation.status, "balanced");
  assert.match(coin.note, /older CreatorRewardsVault/);
  assert.equal(t.creatorFees.testCoins.paid.raw, "7");
  // Owed stays the vault balances (the liability check), unchanged.
  assert.equal(t.owed.total.raw, "6000");
});

test("EVM build: V2 claims unknown (no indexer cursor, logs unreadable) is not recorded, never 0", async () => {
  const out = await buildPayouts({
    network: BNB, days: 30, db: fakeDb([]), env: {}, feeRouting: evmRouting(), prices: priceService(), now: () => NOW,
    readers: {
      async readEvmCall() { return { hex: word(0), rpc: "test" }; },
      async readEvmNative() { return { raw: "0", rpc: "test" }; },
      async readEvmCreatorV2Logs() { return { rows: [], complete: false, error: "limit exceeded" }; },
    },
  });
  const t = out.types.find((x) => x.id === "creator_fees");
  assert.equal(t.paid.recorded, false);
  assert.match(t.paid.note, /limit exceeded/);
});
