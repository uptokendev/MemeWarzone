import assert from "node:assert/strict";
import test from "node:test";

import {
  PAYOUT_CODE_MONTHLY_FALLBACK,
  buildPayouts,
  buildPayoutsAllChains,
  classifyLeagueRows,
  classifyRecruiterLedger,
  classifyRewardLedger,
  coverage,
  explorerTxUrl,
  financePayouts,
  nextSchedule,
  payoutsDays,
} from "./financePayouts.js";

const NOW = "2026-10-04T12:00:00.000Z";
const SINCE = "2026-09-04T12:00:00.000Z";
const SOL_SIG = "38BCzRSpfFvRgCEzjBVeVkNfWRam2YPFNmymC5yiJgR1G7SMpnxUzrpgioghCzYhVXrV5s4u8m3Qw8XzQcstLe1h";

// ---------------------------------------------------------------------------
// Pure helpers

test("coverage: covered, short by the difference, nothing owed, unreadable vault, owed unknown", () => {
  assert.deepEqual(coverage({ owedRaw: "100", balanceRaw: "150" }), { status: "covered", shortByRaw: "0" });
  assert.deepEqual(coverage({ owedRaw: "100", balanceRaw: "100" }), { status: "covered", shortByRaw: "0" });
  assert.deepEqual(coverage({ owedRaw: "100", balanceRaw: "40" }), { status: "short", shortByRaw: "60" });
  assert.deepEqual(coverage({ owedRaw: "0", balanceRaw: null }), { status: "nothing_owed", shortByRaw: "0" });
  assert.deepEqual(coverage({ owedRaw: "5", balanceRaw: null }), { status: "unknown", shortByRaw: null });
  assert.deepEqual(coverage({ owedRaw: null, balanceRaw: "5" }), { status: "not_applicable", shortByRaw: null });
  // 18-decimal amounts stay exact.
  assert.deepEqual(coverage({ owedRaw: "12321428573942", balanceRaw: "0" }), { status: "short", shortByRaw: "12321428573942" });
});

test("explorer links only for real transaction hashes", () => {
  assert.equal(explorerTxUrl(101, SOL_SIG), `https://solscan.io/tx/${SOL_SIG}`);
  // A wallet message signature (base64) is not a transaction.
  assert.equal(explorerTxUrl(101, "AnJM+DGaUmj1gxhn5JTcCP0UuQlBMmaxXxb1DKD2oJGLvEDQVVVSueZDio/Lp+l6kEF+UMMq4VMKezeFgtk5Dw=="), null);
  assert.equal(explorerTxUrl(56, `0x${"a".repeat(64)}`), `https://bscscan.com/tx/0x${"a".repeat(64)}`);
  assert.equal(explorerTxUrl(4663, `0x${"b".repeat(64)}`), `https://explorer.chain.robinhood.com/tx/0x${"b".repeat(64)}`);
  assert.equal(explorerTxUrl(56, null), null);
  assert.equal(explorerTxUrl(97, `0x${"a".repeat(64)}`), null);
});

test("schedule: next Monday 00:00 UTC, next month, next quarter, Monday 00:15 airdrop", () => {
  const s = nextSchedule(NOW); // a Sunday
  assert.equal(s.weekEnd, "2026-10-05T00:00:00.000Z");
  assert.equal(s.monthEnd, "2026-11-01T00:00:00.000Z");
  assert.equal(s.quarterEnd, "2027-01-01T00:00:00.000Z");
  assert.equal(s.airdropRun, "2026-10-05T00:15:00.000Z");
  assert.equal(nextSchedule("2026-10-05T00:00:00.000Z").weekEnd, "2026-10-12T00:00:00.000Z");
});

test("days: default 30, capped, junk falls back", () => {
  assert.equal(payoutsDays(undefined), 30);
  assert.equal(payoutsDays("7"), 7);
  assert.equal(payoutsDays("99999"), 3650);
  assert.equal(payoutsDays("abc"), 30);
});

// ---------------------------------------------------------------------------
// Classification and test-coin exclusion

test("league rows: paid / claimable / waiting / expired; test coins kept out of paid and owed but in the vault check", () => {
  const rows = [
    { period: "weekly", category: "top_earner", amount_raw: "100", claimed_at: "2026-10-01T10:00:00Z", paid_at: "2026-10-01T10:00:05Z", pay_tx: SOL_SIG, root_at: "2026-09-28T00:15:00Z", test_coin: false },
    { period: "weekly", category: "top_earner", amount_raw: "40", claimed_at: null, root_at: "2026-09-28T00:15:00Z", test_coin: false },
    { period: "weekly", category: "biggest_hit", amount_raw: "7", claimed_at: null, root_at: null, test_coin: false },
    { period: "weekly", category: "crowd_favorite", amount_raw: "900", claimed_at: null, root_at: "2026-09-28T00:15:00Z", test_coin: true },
    { period: "weekly", category: "crowd_favorite", amount_raw: "500", claimed_at: "2026-10-02T00:00:00Z", test_coin: true },
    { period: "weekly", category: "top_earner", amount_raw: "3", claimed_at: null, expires_at: "2026-09-01T00:00:00Z", test_coin: false },
    { period: "quarterly", category: "championship", amount_raw: "8", claimed_at: null, root_at: "2026-10-02T22:15:00Z", test_coin: false },
  ];
  const out = classifyLeagueRows(rows, { since: SINCE, now: NOW });
  const w = out.weekly_league;
  assert.equal(w.paidAll.raw, 100n);
  assert.equal(w.paidAll.lastTx, SOL_SIG);
  assert.equal(w.paidAll.lastAt, "2026-10-01T10:00:05.000Z");
  assert.equal(w.claimable.raw, 40n);
  assert.equal(w.pending.raw, 7n);
  assert.equal(w.expired.raw, 3n);
  assert.equal(w.testOwed.raw, 900n);
  assert.equal(w.testPaid.raw, 500n);
  // The vault has to pay the test-coin prize too.
  assert.equal(w.owedAllRaw, 40n + 7n + 900n);
  assert.equal(out.mwl.claimable.raw, 8n);
});

test("recruiter rows: test-coin earnings are kept apart; claimable vs waiting", () => {
  const out = classifyRecruiterLedger([
    { status: "claimable", amount_raw: "10", test_coin: false },
    { status: "pending_finality", amount_raw: "5", test_coin: false },
    { status: "claimable", amount_raw: "1000", test_coin: true },
    { status: "claimed", amount_raw: "20", updated_at: "2026-10-01T00:00:00Z", tx_hash: SOL_SIG, test_coin: false },
    { status: "failed", amount_raw: "99", test_coin: false },
  ], { since: SINCE });
  assert.equal(out.claimable.raw, 10n);
  assert.equal(out.pending.raw, 5n);
  assert.equal(out.testOwed.raw, 1000n);
  assert.equal(out.owedAllRaw, 1015n);
  assert.equal(out.paidAll.raw, 20n);
  assert.equal(out.paidPeriod.raw, 20n);
});

test("airdrop rows: claim deadline in the past counts as expired, not owed", () => {
  const nowSec = Math.floor(Date.parse(NOW) / 1000);
  const out = classifyRewardLedger([
    { status: "claimable", amount_raw: "121555159", claim_deadline: String(nowSec + 86_400) },
    { status: "claimable", amount_raw: "50", claim_deadline: String(nowSec - 10) },
    { status: "claimed", amount_raw: "121555160", claimed_at: "2026-09-29T04:48:20Z", claim_tx_hash: SOL_SIG },
  ], { since: SINCE, now: NOW });
  assert.equal(out.claimable.raw, 121555159n);
  assert.equal(out.expired.raw, 50n);
  assert.equal(out.paidAll.raw, 121555160n);
  assert.equal(out.nextDeadline, new Date((nowSec + 86_400) * 1000).toISOString());
});

// ---------------------------------------------------------------------------
// Full build with a fake database, fee-routing payload, readers and prices

function priceService({ price = 100 } = {}) {
  const usd = (native) => (price == null ? null : Math.round(native * price * 1e6) / 1e6);
  return {
    async valueAtSpot(_asset, amount) {
      if (amount == null || price == null) return { amountUsd: null, priceUsd: null, priceSource: null, priceAt: null, priceBasis: null };
      return { amountUsd: usd(Number(amount)), priceUsd: price, priceSource: "test spot", priceAt: NOW, priceBasis: "current" };
    },
    async valueEvents(_asset, buckets, decimals) {
      if (price == null) return { amountUsd: null, priceUsd: null, priceSource: null, priceAt: null, priceBasis: null };
      const native = buckets.reduce((s, b) => s + Number(b.raw) / 10 ** decimals, 0);
      return { amountUsd: usd(native), priceUsd: price, priceSource: "test history", priceAt: NOW, priceBasis: "event_time" };
    },
    async spotTable(assets) {
      return assets.map((asset) => ({ asset, priceUsd: price, source: "test", at: NOW }));
    },
  };
}

function bal(raw, asset = "BNB") {
  return [{ asset, decimals: 18, raw, amount: String(Number(raw) / 1e18), status: "ok", source: "rpc:test", asOf: NOW, amountUsd: null }];
}

function evmFeeRouting() {
  const d = (id, address, raw) => ({ id, label: id, address, flags: [], balances: bal(raw) });
  return {
    destinations: [
      d("weekly_league", "0xC9286EE3390A4dC642340bd703396E6B7b2521d5", "1000"),
      d("monthly_league", "0x42D254A7451808Bb01df879d71BcAfDC5D605A38", "5000"),
      d("monthly_league_old", PAYOUT_CODE_MONTHLY_FALLBACK[56], "0"),
      d("recruiter_vault", "0x40ac5cD71bdB42cCF542b7f96C2083cDABa41e78", "77"),
      d("creator_vault_v2", "0x6Cb44e3dB907801a04FA7A056Fbe79799298AF66", "300"),
      d("creator_vault_v1", "0x72A963682B261195EB43F8f75e0515ab279EbD14", "0"),
      d("mwl_monthly", "0xC46D33FCce7030627254278716d4AEb536Cf46FF", "0"),
      d("mwl_quarterly", "0xa83d8194C367f2d3eA7B3963f50d579efD8a2218", "0"),
      d("post_grad_league", "0xD9E381408A4e361C66D8b1e657583bdE6c52402d", "0"),
      d("airdrop_distributor", "0xF170a2C97953754c2C1105E2AcC522Bc8e764D75", "0"),
      d("community_vault", "0xB6ccAc81f84F125Ecdc8dFaB2e019c42EAc5486e", "9"),
      d("war_pool", "0xe69a6a41363a48179beaB9b1E6122885bbFe8C65", "0"),
      d("event_prize", "0xDc77CAACDEB6affA0a5791f62BBB958D99Edc58B", "0"),
      d("protocol_vault", "0xc2d4E6f846446f3921a34A34e007295dbc19Bc4c", "0"),
      d("protocol_operator", "0x4CB68C7e131Ef7855b2ceEe1B99Cc163DFD47810", "164"),
    ],
    wiring: [
      { id: "v4_weeklyLeagueVault", status: "match", actual: "0xc9286ee3390a4dc642340bd703396e6b7b2521d5" },
      { id: "v4_monthlyLeagueTreasury", status: "match", actual: "0x42d254a7451808bb01df879d71bcafdc5d605a38" },
      { id: "pg_monthly", status: "match", actual: "0xc46d33fcce7030627254278716d4aeb536cf46ff" },
      { id: "pg_quarterly", status: "match", actual: "0xa83d8194c367f2d3ea7b3963f50d579efd8a2218" },
    ],
  };
}

function fakeDb(handlers) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      seen.push({ sql, params });
      for (const [pattern, rows] of handlers) if (pattern.test(sql)) return { rows: typeof rows === "function" ? rows(sql, params) : rows };
      return { rows: [] };
    },
  };
}

const EVM_READERS = {
  // ProtocolRevenueVault getters: every call answers $10,000 (18 decimals); enough for the shape.
  async readEvmCall() { return { hex: `0x${(10_000n * 10n ** 18n).toString(16)}`, rpc: "test" }; },
  async readEvmNative() { return { raw: "0", rpc: "test" }; },
  // CreatorRewardsVaultV2 logs read from the chain: none, read to the head.
  async readEvmCreatorV2Logs() { return { rows: [], complete: true, head: 1, scannedTo: 1 }; },
};

const BNB = { chainId: 56, chain: "bnb", environment: "mainnet", nativeSymbol: "BNB", nativeDecimals: 18 };

test("EVM build: monthly claims use the current vault (#505 resolver); short vault warns; test coins left out; USD at the given price", async () => {
  const db = fakeDb([
    [/from public\.league_epoch_winners w/, [
      { period: "monthly", category: "top_earner", amount_raw: "4711134454742", claimed_at: null, root_at: null, test_coin: false },
      { period: "monthly", category: "crowd_favorite", amount_raw: "2899159664458", claimed_at: null, root_at: null, test_coin: true },
      { period: "weekly", category: "top_earner", amount_raw: "500", claimed_at: null, root_at: "2026-10-01T02:20:04Z", test_coin: false },
    ]],
  ]);
  const out = await buildPayouts({ network: BNB, days: 30, db, env: {}, feeRouting: evmFeeRouting(), readers: EVM_READERS, prices: priceService(), now: () => NOW });
  const monthly = out.types.find((t) => t.id === "monthly_league");
  assert.equal(monthly.owed.pending.raw, "4711134454742");
  assert.equal(monthly.owed.testCoins.raw, "2899159664458");
  assert.equal(monthly.coverage.status, "short");
  assert.equal(monthly.coverage.shortByAmount, "0.0000076102941142");
  assert.equal(monthly.vaults[0].address.toLowerCase(), "0x42d254a7451808bb01df879d71bcafdc5d605a38");
  assert.ok(!monthly.warnings.some((w) => /Vault mismatch/.test(w.message)));
  assert.ok(out.warnings.some((w) => w.typeId === "monthly_league" && /short by/.test(w.message)));

  const weekly = out.types.find((t) => t.id === "weekly_league");
  assert.equal(weekly.coverage.status, "covered");
  assert.equal(weekly.owed.claimable.raw, "500");
  assert.ok(weekly.warnings.some((w) => /TREASURY_VAULT_V2_ADDRESS_56 is not set/.test(w.message)));

  const recruiter = out.types.find((t) => t.id === "recruiter");
  assert.ok(recruiter.warnings.some((w) => /no recruiter rewards are recorded/.test(w.message)));

  const creator = out.types.find((t) => t.id === "creator_fees");
  assert.equal(creator.owed.total.raw, "300");
  assert.equal(creator.coverage.status, "covered");
  // Claims are read (vault logs + getters): nothing claimed is "0 recorded", not "not recorded".
  assert.equal(creator.paid.recorded, true);
  assert.equal(creator.paid.allTime.raw, "0");

  // Operator fill is protocol revenue, not a user payout: out of the totals.
  assert.equal(out.types.find((t) => t.id === "operator_fill").excludedFromTotals, true);
  assert.equal(out.schemaVersion, "finance-payouts-v1");
  // Every query that reads winners or recruiter rows applies the hidden-coin rule.
  const winnerSql = db.seen.find((q) => /league_epoch_winners w/.test(q.sql)).sql;
  assert.match(winnerSql, /publicHidden/);
  const recruiterSql = db.seen.find((q) => /recruiter_reward_ledger l/.test(q.sql)).sql;
  assert.match(recruiterSql, /publicHidden/);
  assert.match(recruiterSql, /metadata->>'campaign'/);
});

test("env address that matches the router clears the mismatch", async () => {
  const out = await buildPayouts({
    network: BNB, days: 30, db: fakeDb([]),
    env: { MONTHLY_LEAGUE_TREASURY_ADDRESS_56: "0x42D254A7451808Bb01df879d71BcAfDC5D605A38", TREASURY_VAULT_V2_ADDRESS_56: "0xC9286EE3390A4dC642340bd703396E6B7b2521d5" },
    feeRouting: evmFeeRouting(), readers: EVM_READERS, prices: priceService(), now: () => NOW,
  });
  const monthly = out.types.find((t) => t.id === "monthly_league");
  assert.equal(monthly.warnings.length, 0);
  assert.equal(monthly.vaults.length, 1);
  assert.equal(monthly.coverage.status, "nothing_owed");
  assert.equal(out.types.find((t) => t.id === "weekly_league").warnings.length, 0);
});

test("missing price: USD is null and counted as missing, never 0", async () => {
  const db = fakeDb([[/from public\.league_epoch_winners w/, [{ period: "weekly", category: "top_earner", amount_raw: "500", claimed_at: null, root_at: "2026-10-01T00:00:00Z", test_coin: false }]]]);
  const out = await buildPayouts({ network: BNB, days: 30, db, env: {}, feeRouting: evmFeeRouting(), readers: EVM_READERS, prices: priceService({ price: null }), now: () => NOW });
  const weekly = out.types.find((t) => t.id === "weekly_league");
  assert.equal(weekly.owed.total.amount, "0.0000000000000005");
  assert.equal(weekly.owed.total.amountUsd, null);
  assert.ok(out.totals.owed.missingPriceCount > 0);
  assert.equal(out.totals.owed.amountUsd, null);
});

test("a vault that could not be read makes cover unknown, not covered", async () => {
  const routing = evmFeeRouting();
  routing.destinations.find((d) => d.id === "weekly_league").balances = [{ asset: "BNB", status: "unknown", raw: null, amount: null, error: "timeout" }];
  const db = fakeDb([[/from public\.league_epoch_winners w/, [{ period: "weekly", category: "top_earner", amount_raw: "500", claimed_at: null, root_at: "2026-10-01T00:00:00Z", test_coin: false }]]]);
  const out = await buildPayouts({ network: BNB, days: 30, db, env: {}, feeRouting: routing, readers: EVM_READERS, prices: priceService(), now: () => NOW });
  assert.equal(out.types.find((t) => t.id === "weekly_league").coverage.status, "unknown");
});

test("Solana on a devnet API: no database rows, a notice, balances still shown", async () => {
  const db = fakeDb([[/league_epoch_winners/, () => { throw new Error("must not read devnet rows as mainnet"); }]]);
  const routing = { destinations: [{ id: "league_weekly", address: "FAKPndjQa3XppkNdk8SDGGWbZG2cPWJWhsDR2EWE9yWK", flags: [], balances: bal("218338314", "SOL").map((b) => ({ ...b, decimals: 9, amount: "0.218338314" })) }], wiring: [] };
  const out = await buildPayouts({
    network: { chainId: 101, chain: "solana", environment: "production", cluster: "mainnet-beta", nativeSymbol: "SOL", nativeDecimals: 9 },
    days: 30, db, env: { SOLANA_CLUSTER: "devnet" }, feeRouting: routing,
    readers: { readSolanaAccountData: async () => { throw new Error("offline"); }, readSolanaCreatorClaimable: async () => ({ status: "ok", raw: "0", coins: 0, coinsWithFees: 0 }) },
    prices: priceService(), now: () => NOW,
  });
  assert.match(out.notice, /devnet/);
  assert.equal(db.seen.length, 0);
  assert.equal(out.types.find((t) => t.id === "weekly_league").vaults[0].balance.amount, "0.218338314");
});

// ---------------------------------------------------------------------------
// Route

function res() {
  const r = { statusCode: 0, headers: {}, body: null };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (code) => { r.statusCode = code; return r; };
  r.json = (body) => { r.body = body; return r; };
  return r;
}

test("route: GET only, finance.view bearer only, mainnets only, all chains merged", async () => {
  const canView = (p) => p.permissions.includes("finance.view");
  const build = async ({ network }) => ({ schemaVersion: "finance-payouts-v1", network, prices: [], totals: { paid: null, owed: null, vaults: null } });

  let r = res();
  await financePayouts({ method: "POST", query: {} }, r, { build, canView });
  assert.equal(r.statusCode, 405);

  r = res();
  await financePayouts({ method: "GET", query: {} }, r, { build, canView });
  assert.equal(r.statusCode, 401);

  r = res();
  await financePayouts({ method: "GET", query: {}, dashboardPrincipal: { permissions: ["operations.view"] } }, r, { build, canView });
  assert.equal(r.statusCode, 401);

  const principal = { permissions: ["finance.view"] };
  for (const query of [{ chainId: "97" }, { chainId: "46630" }, { chainId: "101" }, { chainId: "101", environment: "staging", solanaCluster: "devnet" }]) {
    r = res();
    await financePayouts({ method: "GET", query, dashboardPrincipal: principal }, r, { build, canView });
    assert.equal(r.statusCode, 400, JSON.stringify(query));
  }

  r = res();
  await financePayouts({ method: "GET", query: { chainId: "56" }, dashboardPrincipal: principal }, r, { build, canView });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.network.chainId, 56);

  r = res();
  await financePayouts({ method: "GET", query: { chainId: "all" }, dashboardPrincipal: principal }, r, { build, canView });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.schemaVersion, "finance-all-chains-v1");
  assert.equal(r.body.page, "payouts");
  assert.deepEqual(r.body.networks.map((n) => n.chainId), [101, 56, 4663]);
});

test("all chains: a failing chain is reported, the others still load", async () => {
  const out = await buildPayoutsAllChains(
    [{ chainId: 101, chain: "solana", environment: "production", cluster: "mainnet-beta" }, { chainId: 56, chain: "bnb", environment: "mainnet" }],
    async (network) => {
      if (network.chainId === 101) throw new Error("rpc down");
      return { prices: [{ asset: "BNB", priceUsd: 1 }], totals: { paid: null, owed: null, vaults: null }, testCoinsNote: "x" };
    },
  );
  assert.equal(out.networks[0].status, "error");
  assert.equal(out.networks[1].status, "ok");
  assert.equal(out.prices.length, 1);
});

test("arena prizes: read from each pool on chain (ArenaWarPoolTreasuryV2.pools), not from the deposits table", async () => {
  const db = fakeDb([
    [/'battle' as kind/, [{ kind: "battle", id: "arena-bnb-1", chain_id: 56, app_state: "live", created_at: "2026-10-01T05:05:28Z", test_coin: false }]],
    [/'deposit' as source/, [{ source: "deposit", ref: "x", purpose: "stake", n: 1, raw: "200000000000000000" }]],
  ]);
  const word = (v) => BigInt(v).toString(16).padStart(64, "0");
  const owner = "1".repeat(64);
  // Live battle: both stakes of 0.2 BNB in, 0.01 BNB of boosts.
  const live = [0, 1, owner, owner, 2n * 10n ** 17n, 0, 2n * 10n ** 17n, 2n * 10n ** 17n, 0, 10n ** 16n, 0, 0, 0, 0, 1, 1790000000, 0, 0, 0, 0, 0].map((v) => (v === owner ? v : word(v))).join("");
  const readers = { ...EVM_READERS, async readEvmCall({ data }) { return data.startsWith("0xb5217bb4") ? { hex: `0x${live}`, rpc: "test" } : EVM_READERS.readEvmCall(); } };
  const out = await buildPayouts({ network: BNB, days: 30, db, env: {}, feeRouting: evmFeeRouting(), readers, prices: priceService(), now: () => NOW });
  const arena = out.types.find((t) => t.id === "arena_prizes");
  assert.equal(arena.arena.counts.live, 1);
  assert.equal(arena.arena.totals.held, "0.41");
  assert.equal(arena.owed.total.amount, "0");
  assert.equal(arena.paidIn.allTime.raw, "410000000000000000");
  assert.equal(arena.coverage.status, "short"); // the fake war pool holds 0
});

test("monthly league: a superseded vault in MONTHLY_LEAGUE_TREASURY_ADDRESS_<id> is reported as refused claims, not a mismatch", async () => {
  const { monthlyLeagueTreasuryAddress } = await import("./evmMonthlyLeagueTreasury.js");
  assert.throws(() => monthlyLeagueTreasuryAddress(56, { MONTHLY_LEAGUE_TREASURY_ADDRESS_56: PAYOUT_CODE_MONTHLY_FALLBACK[56] }), /superseded/);
  assert.equal(monthlyLeagueTreasuryAddress(56, {}).toLowerCase(), "0x42d254a7451808bb01df879d71bcafdc5d605a38");
});
