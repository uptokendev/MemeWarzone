import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:pass@127.0.0.1:1/none";

const {
  accountingChecks,
  lpReadSummary,
  modulesFromChecks,
  openPastMonths,
  reconciliationChecks,
  revenueChecks,
  rewardChecks,
  walletChecks,
  ACCOUNTING_MODULES,
  STATUS_MODULES,
} = await import("./financeStatus.js");
const { dbcReferralFromEnv, lpProtocolTreasuryFrom, solanaFeeRoutingRegistry, deriveSolanaTreasuryPdas } = await import("./financeFeeRoutingSolana.js");
const { upvoteRevenueAddresses, readNativeUpvoteRevenue } = await import("./financeVoteRevenue.js");
const { laneDefinitions, upvoteNote } = await import("./financeRevenueLanes.js");
const { buildOverviewScope, FINANCE_MAINNETS } = await import("../admin/finance.js");

const SOL = { chainId: 101, chain: "solana", asset: "SOL", decimals: 9, environment: "production", cluster: "mainnet-beta" };
const BNB = { chainId: 56, chain: "bnb", asset: "BNB", decimals: 18, environment: "mainnet" };
const WSOL = "So11111111111111111111111111111111111111112";
const REFERRAL = "AYQNtghqVvzCUHr8Nkuap2Gpe6FZTuB42P7HvTy8K1tS";

test("every revenue lane carries its chain (the dashboard rejected rows without it)", () => {
  for (const network of FINANCE_MAINNETS) {
    for (const def of laneDefinitions(network, { includeCore: true })) assert.equal(def.chain, network.chain, def.id);
  }
});

test("DBC referral: the JSON map of the live env gives the WSOL account; single and comma forms still work", () => {
  const map = JSON.stringify({ [WSOL]: REFERRAL, EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "3EfnXQ9TtdPNicKy4HEtL9B9qSwvbbaoSqSZZFCTzbbK" });
  assert.equal(dbcReferralFromEnv({ DBC_REFERRAL_TOKEN_ACCOUNTS: map }), REFERRAL);
  assert.equal(dbcReferralFromEnv({ VITE_DBC_REFERRAL_TOKEN_ACCOUNTS: map }), REFERRAL);
  assert.equal(dbcReferralFromEnv({ DBC_REFERRAL_TOKEN_ACCOUNT: REFERRAL, DBC_REFERRAL_TOKEN_ACCOUNTS: "{bad" }), REFERRAL);
  assert.equal(dbcReferralFromEnv({ DBC_REFERRAL_TOKEN_ACCOUNTS: `${REFERRAL},x` }), REFERRAL);
  assert.equal(dbcReferralFromEnv({ DBC_REFERRAL_TOKEN_ACCOUNTS: "{bad" }), "");
  const registry = solanaFeeRoutingRegistry({ DBC_REFERRAL_TOKEN_ACCOUNTS: map });
  assert.equal(registry.destinations.find((d) => d.id === "dbc_referral").address, REFERRAL);
});

test("LP protocol treasury: env first, then what the indexer reports; same as the protocol vault is labelled so", () => {
  const pda = deriveSolanaTreasuryPdas();
  assert.deepEqual(lpProtocolTreasuryFrom({}, pda.protocol), { address: pda.protocol, source: "indexer" });
  assert.deepEqual(lpProtocolTreasuryFrom({ SOLANA_PROTOCOL_TREASURY_ADDRESS: REFERRAL }, pda.protocol), { address: REFERRAL, source: "env" });
  assert.deepEqual(lpProtocolTreasuryFrom({}, "not-a-key"), { address: "", source: null });
  const lp = solanaFeeRoutingRegistry({}, { indexerLpTreasury: pda.protocol }).destinations.find((d) => d.id === "lp_protocol_treasury");
  assert.equal(lp.address, pda.protocol);
  assert.match(lp.label, /the protocol vault/);
});

test("UP vote revenue on BNB / Robinhood uses the deployment record when the env is not set", async () => {
  const none = () => "";
  assert.deepEqual(upvoteRevenueAddresses(BNB, { readEnv: none }), { voteTreasury: "0xF6AA6eD33030F1179B57658f45dd48E31a60E70f", protocolRevenueVault: "0xc2d4E6f846446f3921a34A34e007295dbc19Bc4c" });
  assert.equal(upvoteRevenueAddresses({ chainId: 4663 }, { readEnv: none }).protocolRevenueVault, "0x632061cA786f7B585Bbd46A792FDA92B02f70671");
  const denied = await readNativeUpvoteRevenue(BNB, { readFeeReceiver: async () => "0x000000000000000000000000000000000000dEaD" });
  assert.equal(denied.approved, false);
  assert.equal(denied.reason, "FEE_RECEIVER_NOT_PROTOCOL_REVENUE_VAULT");
  assert.match(upvoteNote(BNB, denied), /^BNB UP votes are left out of revenue: the UP vote treasury 0x.* pays 0x.*dead, not the protocol revenue vault .*\(FEE_RECEIVER_NOT_PROTOCOL_REVENUE_VAULT\)\.$/i);
});

test("wallet checks: a missing address says which env to set; unread watch-only wallets do not count", () => {
  const checks = walletChecks(SOL, {
    destinations: [
      { id: "protocol_vault", label: "Protocol vault", balances: [{ status: "ok" }] },
      { id: "dbc_referral", label: "Meteora DBC referral token account", balances: [{ status: "not_configured", error: "DBC_REFERRAL_TOKEN_ACCOUNT is not set on this API." }] },
      { id: "deployer", label: "Deployer", flags: ["watch"], ownership: "watch", balances: [{ status: "unknown", error: "x" }] },
    ],
  });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].status, "attention");
  assert.match(checks[0].title, /Solana: Meteora DBC referral token account address is not set/);
  assert.match(checks[0].action, /DBC_REFERRAL_TOKEN_ACCOUNT/);
  const ok = walletChecks(SOL, { destinations: [{ id: "a", label: "A", balances: [{ status: "ok" }] }] });
  assert.equal(ok[0].status, "ok");
  assert.equal(walletChecks(SOL, null, "boom")[0].status, "blocked");
});

test("LP read: hidden test coins are ignored, real errors stand out", () => {
  const payload = { items: [
    { campaignAddress: "C3xHVp98JQ7eoRKtnNE9TwKqg4NLKcpvmFpy6XASwGd5", symbol: "C3xH", fees: { registered: true, error: "Position account: 2Xnd not found" } },
    { campaignAddress: "zE3TmesLT9ajajSTHk8HxSQ5Du5obDpXkQNUvuJAuaJ", symbol: "zE3T", fees: { registered: true, error: "Position account: 5NAA not found" } },
    { campaignAddress: "Real111111111111111111111111111111111111111", symbol: "REAL", fees: { registered: true, error: "Position account: 9 not found" } },
  ] };
  const lp = lpReadSummary(payload, ["C3xHVp98JQ7eoRKtnNE9TwKqg4NLKcpvmFpy6XASwGd5", "zE3TmesLT9ajajSTHk8HxSQ5Du5obDpXkQNUvuJAuaJ"], { solana: true });
  assert.equal(lp.errors.length, 1);
  assert.equal(lp.testCoinErrors.length, 2);
  assert.equal(lp.registered, 1);
  const checks = revenueChecks(SOL, { lp });
  assert.equal(checks.filter((c) => c.status === "attention").length, 1);
  assert.match(checks.find((c) => c.status === "attention").title, /REAL/);
  assert.ok(checks.some((c) => c.status === "ok" && /2 test coins/.test(c.title)));
  const onlyTest = revenueChecks(SOL, { lp: lpReadSummary(payload, ["C3xHVp98JQ7eoRKtnNE9TwKqg4NLKcpvmFpy6XASwGd5", "zE3TmesLT9ajajSTHk8HxSQ5Du5obDpXkQNUvuJAuaJ", "Real111111111111111111111111111111111111111"], { solana: true }) });
  assert.ok(onlyTest.every((c) => c.status === "ok"));
  const opsKey = revenueChecks(BNB, { lpError: "Ops key required for non-testnet fee reads." });
  assert.match(opsKey[0].action, /DASHBOARD_OPS_KEY/);
});

test("reward checks: a short vault is named with the amounts; covered is ok", () => {
  const short = rewardChecks(BNB, { payouts: { types: [{ id: "monthly_league", label: "Monthly league prizes", asset: "BNB", coverage: { status: "short", owedAmount: "0.0000123", vaultAmount: "0", shortByAmount: "0.0000123" } }, { id: "weekly_league", coverage: { status: "covered" } }] } });
  assert.equal(short.length, 1);
  assert.match(short[0].title, /BNB: Monthly league prizes vault is short by 0.0000123 BNB/);
  const ok = rewardChecks(BNB, { payouts: { types: [{ id: "weekly_league", coverage: { status: "covered" } }] } });
  assert.equal(ok[0].status, "ok");
});

test("reconciliation: wiring mismatch, critical alert blocked, info skipped, duplicates and short vaults not repeated", () => {
  const checks = reconciliationChecks(BNB, {
    feeRouting: {
      wiring: [{ id: "a", label: "router.protocol()", status: "match" }, { id: "b", label: "router.weekly()", status: "mismatch", actual: "0x1", expected: "0x2" }],
      alerts: [{ level: "info", message: "Only info." }, { level: "warning", message: "router.weekly() reads 0x1 on chain; the deployment record says 0x2." }],
    },
    payouts: { warnings: [], types: [
      { warnings: [{ level: "critical", message: "Vault mismatch: the fee router sends monthly league money to 0xA, but claims use 0xB. More detail here." }] },
      { warnings: [{ level: "critical", message: "Monthly league prizes: the vault is short by 1 BNB of what is owed." }] },
      { warnings: [{ level: "critical", message: "Vault mismatch: the fee router sends monthly league money to 0xA, but claims use 0xB. More detail here." }] },
    ] },
  });
  assert.equal(checks.length, 2);
  assert.equal(checks[0].status, "attention");
  assert.match(checks[0].title, /router.weekly\(\) reads 0x1 on chain, the record says 0x2/);
  assert.equal(checks[1].status, "blocked");
  assert.equal(checks[1].title, "BNB: Vault mismatch: the fee router sends monthly league money to 0xA, but claims use 0xB.");
  assert.equal(checks[1].detail, "More detail here.");
});

test("accounting checks: specific and actionable; nothing is 'disabled'", () => {
  const checks = accountingChecks({ costCount: 0, taxIsDefault: true, openMonths: ["2026-09"], activeMonths: 2, distribution: { isDefault: true, shares: [{ name: "Patrick", evmAddress: "", solanaAddress: "" }, { name: "Dough", evmAddress: "0x1", solanaAddress: "" }] } });
  assert.deepEqual(checks.map((c) => c.module), ["costs", "taxReserves", "close", "distributions"]);
  assert.ok(checks.every((c) => c.status === "attention"));
  assert.equal(checks[2].title, "Not closed yet: September 2026");
  assert.equal(checks[3].detail, "Patrick: EVM and Solana; Dough: Solana");
  const done = accountingChecks({ costCount: 3, taxIsDefault: false, openMonths: [], activeMonths: 2, distribution: { isDefault: false, shares: [{ name: "P", evmAddress: "0x1", solanaAddress: "S" }] } });
  assert.ok(done.every((c) => c.status === "ok"));
  assert.ok(accountingChecks({ tablesMissing: true, migration: "m.sql" }).every((c) => c.status === "blocked" && /m\.sql/.test(c.action)));
  assert.deepEqual(openPastMonths(["2026-08", "2026-09", "2026-10", "2026-09"], ["2026-08"], "2026-10"), ["2026-09"]);
});

test("modules: worst status of their checks; every module key, none disabled", () => {
  const modules = modulesFromChecks([{ module: "revenue", status: "attention" }, { module: "reconciliation", status: "blocked" }, { module: "reconciliation", status: "attention" }], STATUS_MODULES);
  assert.equal(modules.length, 8);
  assert.ok(modules.every((m) => ["ready", "attention", "blocked"].includes(m.status)));
  const recon = modules.find((m) => m.key === "reconciliation");
  assert.equal(recon.status, "blocked");
  assert.equal(recon.blockerCount, 1);
  assert.equal(recon.warningCount, 1);
});

test("overview scope: accounting checks once for all chains, from every chain's revenue months", async () => {
  const seen = [];
  const build = async (n) => ({ schemaVersion: "finance-overview-v1", generatedAt: "2026-10-04T00:00:00.000Z", source: "dashboard-api", modules: modulesFromChecks([{ module: "inventory", status: "attention" }], ["inventory", "revenue", "rewards", "reconciliation"]), checks: [{ module: "inventory", status: "attention", chainId: n.chainId }], revenueMonths: n.chainId === 101 ? ["2026-09"] : ["2026-08"], totals: {}, prices: [] });
  const accounting = async ({ revenueMonths }) => { seen.push([...revenueMonths].sort()); return accountingChecks({ costCount: 1, taxIsDefault: false, openMonths: ["2026-08"], activeMonths: 2, distribution: { shares: [] } }); };
  const all = await buildOverviewScope({ all: true, networks: FINANCE_MAINNETS.map((n) => ({ ...n })) }, { build, accounting });
  assert.deepEqual(seen[0], ["2026-08", "2026-09"]);
  assert.deepEqual(all.modules.map((m) => m.key), ["inventory", "revenue", "rewards", "reconciliation", ...ACCOUNTING_MODULES]);
  assert.equal(all.modules.find((m) => m.key === "inventory").warningCount, 3, "chain modules add up across the three chains");
  assert.equal(all.modules.find((m) => m.key === "close").warningCount, 1, "accounting counted once");
  const one = await buildOverviewScope({ all: false, networks: [{ ...FINANCE_MAINNETS[1] }] }, { build, accounting, readRevenueMonths: async (n) => (n.chainId === 101 ? ["2026-09"] : []) });
  assert.deepEqual(seen[1], ["2026-08", "2026-09"], "a single-chain overview still closes months of every chain");
  assert.equal(one.modules.length, 8);
});
