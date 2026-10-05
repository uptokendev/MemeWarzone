import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:pass@127.0.0.1:1/none";

const { createFinanceAccountingHandler } = await import("./financeAccounting.js");
const { createFakeAccountingDb } = await import("./financeAccountingFakeDb.mjs");
const T = await import("../lib/financeTreasury.js");
const D = await import("../lib/financeTreasuryDetect.js");
const E = await import("../lib/financeEntity.js");

// The K88 support buy (founder 2026-10-05): operator wallet, launchpad program, 28 Sep 14:48:37 UTC.
const NOW = Date.parse("2026-10-05T12:00:00Z");
const OPERATOR = "2AMfRaxS9182AESwWRz2TrvUxPqXaUot4wV1oAvjsTrB";
const SQUADS = "fk5YYWb4ppwbFqME8YRugirMSaNfhGgPP3GjfMbbfGv";
const K88_TX = "5BL9dL7L65d7fpZrQW5bbsmRvdg58ceyVqVNuoXN7QLWyVb9A4Aod4AcDhmWvJYAbz4jbPpf2rSP7Dat9294Cmji";
const K88_AT = "2026-09-28T14:48:37.000Z";
const K88_MINT = "4VPtpo5qQmmbva9JHYU2eiH9UY6Xf32nCbKKB5ZeYb77";
const K88_CAMPAIGN = "Hsa3rJRQHVs8hB9psXipLjRz66kKr9Nhcrc8wGmH9edA";
const CURVE_VAULT = "Fv3MeMMrnqP1tuDP91mP9XTfc9utRuqxvCAMyMDhypS2";
const LAUNCHPAD = "3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt";
const SOL_CLOSE_1400 = 118.07; // Binance SOLUSDT 1h close, 2026-09-28 14:00 UTC
const ECB_0928 = 1.1378; // ECB USD per EUR, 2026-09-28
const VIEWER = { authUserId: "u-view", email: "viewer@example.com", permissions: ["dashboard.view", "finance.view"] };
const MANAGER = { authUserId: "u-man", email: "manager@example.com", permissions: ["dashboard.view", "finance.view", "finance.manage"] };
const SIG = (c) => c.repeat(88);
const near = (a, b, msg, eps = 0.011) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} vs ${b}`);

const market = {
  campaigns: [{ chain_id: 101, campaign_address: K88_CAMPAIGN, token_address: K88_MINT, name: "KAIJU88", symbol: "K88" }],
  curveTrades: [{ chain_id: 101, campaign_address: K88_CAMPAIGN, tx_hash: K88_TX, log_index: 1, block_time: K88_AT, side: "buy", wallet: OPERATOR, token_amount: "432322.801031", bnb_amount: "0.1", price_bnb: "0.00000023130864197197279" }],
  marketStats: [{ chain_id: 101, campaign_address: K88_CAMPAIGN, last_price_usd: "0.000026747596222050792", valuation_source: "spot:cached", valuation_healthy: true, updated_at: "2026-10-05T11:59:00.000Z" }],
};

const fakeFx = { rate: async (date) => ({ usdPerEur: date === "2026-09-28" ? ECB_0928 : 1.1, date: date || "2026-10-05", source: `ECB test ${date || "latest"}` }) };
const H1400 = Date.parse("2026-09-28T14:00:00Z");
const fakePrices = {
  spot: async (asset) => (asset === "SOL" ? { priceUsd: 130, source: "spot test" } : null),
  hourly: async (asset, hours) => new Map(asset === "SOL" ? hours.filter((h) => h === H1400).map((h) => [h, SOL_CLOSE_1400]) : []),
  spotTable: async () => [],
  valueEvents: async () => ({ amountUsd: 0 }),
};

function setup({ cryptoCostsInstalled = true, unmatched } = {}) {
  const db = createFakeAccountingDb({ cryptoCostsInstalled, market });
  // 55 SOL of fee revenue on 22 September, 11,000 USD = 10,000 EUR: 181.82 EUR per SOL.
  const dayRows = { "2026-09-22": { totalUsd: 11000, lanes: [{ laneId: "dbc-referral:101", lane: "DBC referral", asset: "SOL", nativeAmount: "55", amountUsd: 11000 }] } };
  const handler = createFinanceAccountingHandler({
    db,
    prices: fakePrices,
    fx: fakeFx,
    nowMs: () => NOW,
    revenue: async ({ fromMonth, toMonth }) => {
      const months = {};
      for (let m = fromMonth; m <= toMonth; m = m.endsWith("-12") ? `${Number(m.slice(0, 4)) + 1}-01` : `${m.slice(0, 5)}${String(Number(m.slice(5)) + 1).padStart(2, "0")}`) months[m] = { totalUsd: m === "2026-09" ? 11000 : 0, lanes: m === "2026-09" ? [{ amountUsd: 11000 }] : [] };
      return { months, notes: [] };
    },
    dailyRevenue: async () => ({ days: dayRows, notes: [] }),
    balances: async () => ({ chains: [{ chainId: 101, chain: "solana", asset: "SOL", decimals: 9, multisigAddress: SQUADS, multisigUsd: 5000, multisigRaw: "1", priceUsd: 130, operator: { address: OPERATOR, status: "ok", amount: "1", amountUsd: 130 } }], operatorUsd: 130, errors: [] }),
    unmatchedOutflows: unmatched,
  });
  async function call(method, path, { principal = MANAGER, body, query = {} } = {}) {
    let statusCode = 200;
    let payload;
    const res = { headersSent: false, setHeader() {}, status(code) { statusCode = code; return this; }, json(value) { payload = value; this.headersSent = true; return this; }, send() { this.headersSent = true; return this; } };
    await handler({ method, path, url: path, query, body, dashboardPrincipal: principal, headers: {} }, res);
    return { status: statusCode, body: payload };
  }
  return { db, call };
}

async function addOperator(call) {
  const out = await call("POST", "/api/admin/finance/treasury/accounts", { body: { name: "Operator wallet Solana", kind: "operator_wallet", chainId: 101, address: OPERATOR, currency: "SOL" } });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.account.id;
}

const K88_BOOK = (accountId) => ({ accountId, txHash: K88_TX, occurredAt: K88_AT, asset: "SOL", amount: "0.10317872", category: "marketing", vendor: "KAIJU88 (K88) support buy", description: "Buy of K88 through the launchpad: 432322.801031 K88" });

// ------------------------------------------------------------------ validation

test("crypto_payment: from a wallet only, out leg in crypto only, needs a cost; costId fits bank and crypto payments only", () => {
  const ok = (body) => T.validateMovementInput({ occurredAt: K88_AT, ...body }, { nowMs: NOW });
  const m = ok({ kind: "crypto_payment", fromAccountId: "2", assetOut: "SOL", amountOut: "0.10317872", costId: "5", txHash: K88_TX });
  assert.equal(m.kind, "crypto_payment");
  assert.equal(m.occurredAt, K88_AT, "the chain's time is kept");
  assert.throws(() => ok({ kind: "crypto_payment", fromAccountId: "2", assetOut: "SOL", amountOut: "1" }), /pays a cost/);
  assert.throws(() => ok({ kind: "crypto_payment", fromAccountId: "2", assetOut: "EUR", amountOut: "1", costId: "5" }), /bank payment/);
  assert.throws(() => ok({ kind: "crypto_payment", fromAccountId: "2", toAccountId: "3", assetOut: "SOL", amountOut: "1", costId: "5" }), /from account only/);
  assert.throws(() => ok({ kind: "crypto_payment", fromAccountId: "2", assetOut: "SOL", amountOut: "1", assetIn: "SOL", amountIn: "1", costId: "5" }), /out leg only/);
  assert.throws(() => ok({ kind: "fee", fromAccountId: "2", assetOut: "SOL", amountOut: "1", costId: "5" }), /bank payment or a crypto payment/);
  const accounts = new Map([["2", { id: "2", name: "Operator", kind: "operator_wallet", chainId: 101 }], ["3", { id: "3", name: "Bunq", kind: "bank" }], ["4", { id: "4", name: "Kraken", kind: "exchange" }]]);
  assert.doesNotThrow(() => T.checkMovementAccounts(m, accounts));
  assert.throws(() => T.checkMovementAccounts({ ...m, fromAccountId: "4" }, accounts), /leaves one of our wallets/);
  assert.throws(() => T.checkMovementAccounts({ ...m, fromAccountId: "3" }, accounts), /leaves one of our wallets/);
});

test("token legs: any symbol with its address, one token leg per movement, never in a bank, address fits the wallet's chain", () => {
  const ok = (body) => T.validateMovementInput({ occurredAt: K88_AT, ...body }, { nowMs: NOW });
  const conv = ok({ kind: "conversion", fromAccountId: "2", toAccountId: "2", assetOut: "SOL", amountOut: "0.10317872", assetIn: "k88", amountIn: "432322.801031", assetAddress: K88_MINT, txHash: K88_TX });
  assert.deepEqual(conv.in, { asset: "K88", amount: "432322.801031", address: K88_MINT });
  assert.equal(conv.out.address, undefined, "SOL stays a core asset");
  assert.throws(() => ok({ kind: "conversion", fromAccountId: "2", toAccountId: "2", assetOut: "SOL", amountOut: "1", assetIn: "K88", amountIn: "1" }), /token symbol with its address/);
  assert.throws(() => ok({ kind: "conversion", fromAccountId: "2", toAccountId: "2", assetOut: "SOL", amountOut: "1", assetIn: "EUR", amountIn: "1", assetAddress: K88_MINT }), /exactly one/);
  assert.throws(() => ok({ kind: "conversion", fromAccountId: "2", toAccountId: "2", assetOut: "SOL", amountOut: "1", assetIn: "K 88", amountIn: "1", assetAddress: K88_MINT }), /letters, digits/);
  assert.throws(() => ok({ kind: "opening_balance", toAccountId: "2", assetIn: "K88", amountIn: "1", assetAddress: "not-an-address" }), /Solana mint or an EVM/);
  assert.throws(() => ok({ kind: "fee", fromAccountId: "2", assetOut: "K88", amountOut: "1", assetAddress: K88_MINT }), /core asset/);
  assert.throws(() => ok({ kind: "bank_receipt", toAccountId: "3", assetIn: "K88", amountIn: "1", assetAddress: K88_MINT }), /EUR or USD/);
  const accounts = new Map([["2", { id: "2", name: "Operator", kind: "operator_wallet", chainId: 101 }], ["5", { id: "5", name: "Safe BNB", kind: "multisig", chainId: 56 }], ["3", { id: "3", name: "Bunq", kind: "bank" }]]);
  assert.doesNotThrow(() => T.checkMovementAccounts(conv, accounts));
  assert.throws(() => T.checkMovementAccounts({ ...conv, fromAccountId: "5", toAccountId: "5" }, accounts), /not a BNB Chain token/);
  assert.throws(() => T.checkMovementAccounts(ok({ kind: "opening_balance", toAccountId: "3", assetIn: "K88", amountIn: "1", assetAddress: K88_MINT }), accounts), /bank account/);
  // A buy of a token is valued at what was paid for it.
  assert.equal(T.valuationLeg(conv), conv.out);
  assert.equal(T.tokenChainOf(conv, accounts), 101);
});

// ------------------------------------------------------------------ FIFO and lots

test("FIFO on SOL spent: a crypto payment takes the oldest SOL out; gain = market value at the time - FIFO cost; the linked SOL cost is not disposed twice", () => {
  const value = Math.round(((0.10317872 * SOL_CLOSE_1400) / ECB_0928) * 100) / 100;
  const movements = [{ id: "9", kind: "crypto_payment", occurredAt: K88_AT, fromAccountId: "2", out: { asset: "SOL", amount: "0.10317872" }, valueEur: value, costId: "7" }];
  const costs = [{ costId: "7", date: "2026-09-28", month: "2026-09", recurring: "none", currency: "SOL", amount: "0.10317872", amountUsd: 0.10317872 * SOL_CLOSE_1400, eurUsdRate: ECB_0928 }];
  const ev = T.treasuryLotEvents({ movements, costs });
  assert.deepEqual(ev.disposals.map((d) => [d.kind, d.asset, d.amount, d.ref]), [["crypto_payment", "SOL", 0.10317872, "movement 9"]], "one disposal, from the movement");
  const unlinked = T.treasuryLotEvents({ movements: [], costs });
  assert.equal(unlinked.disposals.length, 1, "without the payment the SOL cost itself disposes, as before");
  const lots = T.runLots({
    acquisitions: [{ date: "2026-09-01", asset: "SOL", amount: 1, eur: 150 }, { date: "2026-09-22", asset: "SOL", amount: 1, eur: 200 }],
    disposals: ev.disposals,
  });
  near(lots.disposals[0].costEur, 0.10317872 * 150, "the oldest lot (150 per SOL) goes first");
  near(lots.disposals[0].gainEur, value - 0.10317872 * 150, "gain = market value - FIFO cost");
  near(lots.holdings.SOL.amount, 2 - 0.10317872, "SOL left", 1e-9);
  // Cash: the SOL leaves the operator wallet.
  near(T.cashPerAccount(movements).get("2").get("SOL"), -0.10317872, "operator cash", 1e-9);
  // A paid cost is not open any more (one-off: any time).
  assert.equal(T.paidOccurrence(costs[0], movements), true);
  assert.equal(T.bankPaidOccurrence(costs[0], movements), true, "the earlier name covers crypto payments too");
  assert.equal(T.paidOccurrence(costs[0], [{ ...movements[0], deletedAt: "2026-10-01" }]), false);
});

test("token lots are kept per address; cash per account keys tokens by symbol and address", () => {
  const other = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  const movements = [
    { id: "1", kind: "conversion", occurredAt: K88_AT, fromAccountId: "2", toAccountId: "2", out: { asset: "SOL", amount: "0.1" }, in: { asset: "K88", amount: "432322.801031", address: K88_MINT }, valueEur: 10.71 },
    { id: "2", kind: "opening_balance", occurredAt: "2026-09-01T12:00:00.000Z", toAccountId: "2", in: { asset: "K88", amount: "5", address: other }, valueEur: 1 },
    { id: "3", kind: "conversion", occurredAt: "2026-10-01T12:00:00.000Z", fromAccountId: "2", toAccountId: "2", out: { asset: "K88", amount: "100000", address: K88_MINT }, in: { asset: "SOL", amount: "0.03" }, valueEur: 3 },
  ];
  const ev = T.treasuryLotEvents({ movements });
  const lots = T.runLots({ acquisitions: [{ date: "2026-09-01", asset: "SOL", amount: 1, eur: 150 }, ...ev.acquisitions], disposals: ev.disposals });
  const key = `K88@${K88_MINT}`;
  near(lots.holdings[key].amount, 332322.801031, "K88 left", 1e-6);
  near(lots.holdings[key].costEur, 10.71 * (332322.801031 / 432322.801031), "K88 at its cost (what was paid for it)");
  near(lots.holdings[`K88@${other}`].amount, 5, "a coin with the same symbol never mixes", 1e-9);
  const sale = lots.disposals.find((d) => d.asset === key);
  near(sale.gainEur, 3 - 10.71 * (100000 / 432322.801031), "gain on the K88 sold");
  const cash = T.cashPerAccount(movements).get("2");
  near(cash.get(key), 332322.801031, "token cash", 1e-6);
  assert.deepEqual(T.splitAssetKey(key), { asset: "K88", address: K88_MINT });
});

// ------------------------------------------------------------------ handler: book as cost

test("book as cost: the cost row and the crypto_payment movement in one transaction, each audit logged; EUR = market value at the time; SOL leaves FIFO", async () => {
  const { call, db } = setup();
  const op = await addOperator(call);
  assert.equal((await call("POST", "/api/admin/finance/treasury/crypto-costs", { principal: VIEWER, body: K88_BOOK(op) })).status, 403);
  const before = await call("GET", "/api/admin/finance/weekly", { principal: VIEWER });
  assert.equal(before.status, 200, JSON.stringify(before.body));

  const out = await call("POST", "/api/admin/finance/treasury/crypto-costs", { body: K88_BOOK(op) });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const usd = Math.round(0.10317872 * SOL_CLOSE_1400 * 1e6) / 1e6;
  const eur = Math.round((0.10317872 * SOL_CLOSE_1400 / ECB_0928) * 100) / 100;
  assert.equal(out.body.cost.category, "marketing");
  assert.equal(out.body.cost.currency, "SOL");
  assert.equal(out.body.cost.amount, "0.10317872");
  assert.equal(out.body.cost.incurredOn, "2026-09-28");
  near(out.body.cost.amountUsd, usd, "cost in USD at the 14:00 close", 1e-6);
  assert.equal(out.body.cost.fxRate, SOL_CLOSE_1400);
  assert.equal(out.body.cost.eurUsdRate, ECB_0928);
  assert.match(out.body.cost.description, new RegExp(`tx ${K88_TX}`));
  near(out.body.costEur, eur, "cost EUR = market value at the time");
  assert.equal(out.body.movement.kind, "crypto_payment");
  assert.equal(out.body.movement.costId, out.body.cost.id);
  assert.equal(out.body.movement.valueEur, eur);
  assert.match(out.body.movement.valueSource, /Binance SOLUSDT 1h close 2026-09-28T14:00 UTC; ECB test 2026-09-28/);
  const audit = db.state.audit.slice(-2).map((a) => [a.action, a.entityType, a.actorEmail]);
  assert.deepEqual(audit, [["cost.create", "finance_cost", "manager@example.com"], ["movement.create", "finance_treasury_movement", "manager@example.com"]]);

  // Twice: refused, and the second cost row is rolled back with it.
  const again = await call("POST", "/api/admin/finance/treasury/crypto-costs", { body: K88_BOOK(op) });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(db.state.costs.length, 1, "no cost without its movement");
  assert.equal(db.state.audit.filter((a) => a.action === "cost.create").length, 1);

  // The books: one SOL disposal at the FIFO cost of the revenue lot (181.82 EUR per SOL); the cost is not open.
  const tr = await call("GET", "/api/admin/finance/treasury", { principal: VIEWER });
  assert.equal(tr.status, 200, JSON.stringify(tr.body));
  const disposals = tr.body.realized.disposals.filter((d) => d.asset === "SOL");
  assert.equal(disposals.length, 1, JSON.stringify(disposals));
  assert.equal(disposals[0].kind, "crypto_payment");
  near(disposals[0].costEur, 0.10317872 * (10000 / 55), "FIFO cost");
  near(disposals[0].gainEur, eur - 0.10317872 * (10000 / 55), "realized loss on the SOL spent");
  near(tr.body.holdings.find((h) => h.asset === "SOL").amount, 55 - 0.10317872, "SOL held", 1e-6);
  near(tr.body.accounts.find((a) => a.id === op).recorded.find((l) => l.asset === "SOL").amount, -0.10317872, "operator cash", 1e-6);
  assert.equal(tr.body.warnings.length, 0, JSON.stringify(tr.body.warnings));
  assert.ok(tr.body.kinds.some((k) => k.key === "crypto_payment" && k.label === "Cost paid in crypto"));
  const weekly = await call("GET", "/api/admin/finance/weekly", { principal: VIEWER });
  near(weekly.body.decision.openCostsEur, 0, "paid in crypto: not open for the multisig");
  const w40 = weekly.body.weeks.find((w) => w.week === "2026-W40");
  near(w40.realizedGainEur, eur - 0.10317872 * (10000 / 55), "the loss is in the week it was spent");
});

test("book as cost: checks the account, category, hash and closed months; a manual EUR value is labelled", async () => {
  const { call, db } = setup();
  const op = await addOperator(call);
  const bank = (await call("POST", "/api/admin/finance/treasury/accounts", { body: { name: "Bunq", kind: "bank", currency: "EUR" } })).body.account.id;
  const book = (body, status) => call("POST", "/api/admin/finance/treasury/crypto-costs", { body }).then((r) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; });
  assert.match((await book({ ...K88_BOOK(op), category: "snacks" }, 400)).error, /category/);
  assert.match((await book({ ...K88_BOOK(op), txHash: "" }, 400)).error, /txHash is required/);
  assert.match((await book({ ...K88_BOOK(op), txHash: `0x${"a".repeat(64)}` }, 400)).error, /not a Solana transaction/);
  assert.match((await book({ ...K88_BOOK(bank) }, 400)).error, /wallets/);
  assert.match((await book({ ...K88_BOOK(op), extra: 1 }, 400)).error, /Unknown field/);
  db.state.closes.set("2026-09-01", { month: "2026-09-01", status: "closed", snapshot: { revenue: { totalUsd: 0 }, costs: { totalUsd: 0, occurrences: [] }, profitUsd: 0 } });
  assert.equal((await book(K88_BOOK(op), 409)).code, "MONTH_CLOSED");
  db.state.closes.delete("2026-09-01");
  const manual = await book({ ...K88_BOOK(op), txHash: SIG("m"), occurredAt: "2026-10-02T09:00:00Z", amount: "0.5", valueEur: "50", category: "servers", vendor: "Hosting" }, 201);
  assert.equal(manual.movement.valueEur, 50);
  assert.equal(manual.movement.valueSource, "entered by manager@example.com");
  near(manual.cost.amountUsd, 55, "50 EUR at 1.1");
  assert.equal(manual.cost.fxRate, 110);
  assert.equal(db.state.costs.length, 1);
});

test("before 20261005_000003: the treasury still reads; booking and the BV status answer 503 with the file; nothing half-written", async () => {
  const { call, db } = setup({ cryptoCostsInstalled: false });
  const op = await addOperator(call);
  const tr = await call("GET", "/api/admin/finance/treasury", { principal: VIEWER });
  assert.equal(tr.status, 200, JSON.stringify(tr.body));
  assert.equal(tr.body.entity.status, "in_formation");
  assert.equal(tr.body.entity.installed, false);
  const moved = await call("POST", "/api/admin/finance/treasury/movements", { body: { kind: "transfer_internal", occurredAt: "2026-10-01", fromAccountId: op, toAccountId: op, assetOut: "SOL", amountOut: "1", assetIn: "SOL", amountIn: "1" } });
  assert.equal(moved.status, 400, "same account");
  const vault = (await call("POST", "/api/admin/finance/treasury/accounts", { body: { name: "Squads", kind: "multisig", chainId: 101, address: SQUADS, currency: "SOL" } })).body.account.id;
  const transfer = await call("POST", "/api/admin/finance/treasury/movements", { body: { kind: "transfer_internal", occurredAt: "2026-10-01", fromAccountId: vault, toAccountId: op, assetOut: "SOL", amountOut: "1", assetIn: "SOL", amountIn: "1", valueEur: "100" } });
  assert.equal(transfer.status, 201, "core movements keep working before the migration");
  assert.equal((await call("DELETE", `/api/admin/finance/treasury/movements/${transfer.body.movement.id}`)).status, 200);
  const book = await call("POST", "/api/admin/finance/treasury/crypto-costs", { body: K88_BOOK(op) });
  assert.equal(book.status, 503, JSON.stringify(book.body));
  assert.equal(book.body.code, "FINANCE_CRYPTO_COSTS_NOT_INSTALLED");
  assert.match(book.body.error, /20261005_000003_finance_crypto_costs\.sql/);
  assert.equal(db.state.costs.length, 0, "the cost was rolled back with the movement");
  const ent = await call("PUT", "/api/admin/finance/entity", { body: { status: "registered" } });
  assert.equal(ent.status, 503);
  const tax = await call("GET", "/api/admin/finance/tax", { principal: VIEWER });
  assert.equal(tax.body.entity.label, "BV in formation");
});

test("a token movement: SOL to K88 is valued at the SOL paid; K88 is held at cost or lower market (market_stats)", async () => {
  const { call } = setup();
  const op = await addOperator(call);
  const conv = await call("POST", "/api/admin/finance/treasury/movements", { body: { kind: "conversion", occurredAt: K88_AT, fromAccountId: op, toAccountId: op, assetOut: "SOL", amountOut: "0.10317872", assetIn: "K88", amountIn: "432322.801031", assetAddress: K88_MINT, txHash: K88_TX } });
  assert.equal(conv.status, 201, JSON.stringify(conv.body));
  assert.deepEqual(conv.body.movement.in, { asset: "K88", amount: "432322.801031", address: K88_MINT });
  const eur = Math.round((0.10317872 * SOL_CLOSE_1400 / ECB_0928) * 100) / 100;
  assert.equal(conv.body.movement.valueEur, eur);
  const tr = await call("GET", "/api/admin/finance/treasury", { principal: VIEWER });
  const k88 = tr.body.holdings.find((h) => h.asset === "K88");
  assert.equal(k88.address, K88_MINT);
  near(k88.costEur, eur, "cost = SOL paid");
  const market = (432322.801031 * 0.000026747596222050792) / 1.1;
  near(k88.marketEur, market, "market from market_stats now");
  near(k88.bookEur, Math.min(eur, market), "the lower of cost and market");
  assert.match(k88.source, /K88 (curve price|market_stats)/);
  const line = tr.body.accounts.find((a) => a.id === op).recorded.find((l) => l.asset === "K88");
  assert.equal(line.address, K88_MINT);
  // An opening balance in a token is priced from the curve at that time (last trade before it).
  const ob = await call("POST", "/api/admin/finance/treasury/movements", { body: { kind: "opening_balance", occurredAt: "2026-09-28T14:50:00Z", toAccountId: op, assetIn: "K88", amountIn: "1000", assetAddress: K88_MINT } });
  assert.equal(ob.status, 201, JSON.stringify(ob.body));
  near(ob.body.movement.priceUsd, 0.00000023130864197197279 * SOL_CLOSE_1400, "curve price x SOL close", 1e-12);
  assert.match(ob.body.movement.valueSource, /curve price of the last trade/);
  // No market data for an unknown token: entered by hand.
  const unknown = await call("POST", "/api/admin/finance/treasury/movements", { body: { kind: "opening_balance", occurredAt: "2026-09-01", toAccountId: op, assetIn: "WIF", amountIn: "10", assetAddress: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm" } });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /Enter the EUR value by hand/);
});

// ------------------------------------------------------------------ unmatched outflows

test("unmatched: a launchpad buy of one of our coins by the operator wallet is named from curve_trades and suggested as a marketing cost", async () => {
  const reader = async ({ accounts }) => ({
    wallets: [], note: "n",
    unmatched: [
      { accountId: accounts[0].id, account: accounts[0].name, accountKind: "operator_wallet", chainId: 101, asset: "SOL", amount: "0.10317872", txHash: K88_TX, at: K88_AT, to: CURVE_VAULT, toAccountId: null, toAccount: null, source: "test", programs: [LAUNCHPAD], tokensIn: [{ mint: K88_MINT, amount: "432322.801031" }], viaLaunchpad: true, prefill: {} },
      { accountId: accounts[0].id, account: accounts[0].name, accountKind: "operator_wallet", chainId: 101, asset: "SOL", amount: "2", txHash: SIG("z"), at: "2026-10-01T00:00:00.000Z", to: "So1anaExchangeDeposit1111111111111111111111", toAccountId: null, toAccount: null, source: "test", programs: [], tokensIn: [], viaLaunchpad: false, prefill: {} },
    ],
  });
  const { call } = setup({ unmatched: reader });
  const op = await addOperator(call);
  const out = await call("GET", "/api/admin/finance/treasury/unmatched", { principal: VIEWER });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const k = out.body.unmatched.find((u) => u.txHash === K88_TX);
  assert.equal(k.description, "Buy of K88 through the launchpad");
  assert.deepEqual([k.token.symbol, k.token.address, k.token.amount, k.token.platformCoin], ["K88", K88_MINT, "432322.801031", true]);
  assert.equal(k.suggestion.label, "Book as marketing cost");
  assert.deepEqual(k.bookCost, { accountId: op, txHash: K88_TX, occurredAt: K88_AT, asset: "SOL", amount: "0.10317872", category: "marketing", vendor: "KAIJU88 (K88) support buy", description: "Buy of K88 through the launchpad: 432322.801031 K88" });
  assert.equal(k.conversionPrefill.assetIn, "K88");
  assert.equal(k.conversionPrefill.assetAddress, K88_MINT);
  const plain = out.body.unmatched.find((u) => u.txHash === SIG("z"));
  assert.equal(plain.suggestion, null);
  assert.equal(plain.bookCost.category, "", "the user picks the category");
  assert.ok(out.body.costCategories.some((c) => c.key === "marketing"));
  // The prefill books exactly as shown.
  const booked = await call("POST", "/api/admin/finance/treasury/crypto-costs", { body: k.bookCost });
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
});

test("solana tx details: programs called and tokens the wallet received (the K88 buy shape)", () => {
  const tx = {
    transaction: { message: { instructions: [{ programId: "ComputeBudget111111111111111111111111111111" }, { programId: "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95" }, { programId: LAUNCHPAD }] } },
    meta: {
      preTokenBalances: [{ mint: K88_MINT, owner: K88_CAMPAIGN, uiTokenAmount: { amount: "734600651641559", decimals: 6 } }],
      postTokenBalances: [{ mint: K88_MINT, owner: OPERATOR, uiTokenAmount: { amount: "432322801031", decimals: 6 } }, { mint: K88_MINT, owner: K88_CAMPAIGN, uiTokenAmount: { amount: "734168328840528", decimals: 6 } }],
    },
  };
  const d = D.solanaTxDetails(tx, OPERATOR);
  assert.equal(d.viaLaunchpad, true);
  assert.deepEqual(d.tokensIn, [{ mint: K88_MINT, amount: "432322.801031" }]);
  assert.ok(!d.programs.includes("ComputeBudget111111111111111111111111111111"));
  assert.equal(D.solanaTxDetails(tx, K88_CAMPAIGN).tokensIn.length, 0, "the curve's balance went down");
});

// ------------------------------------------------------------------ BV in formation

test("BV status: in formation by default, a label only; finance.manage sets it registered with a date, audit logged", async () => {
  assert.deepEqual(E.effectiveEntity(null), { status: "in_formation", registeredOn: null, label: "BV in formation", inFormation: true, taxNote: "Run as if registered: deadlines are planning dates until the BV is registered.", isDefault: true });
  assert.throws(() => E.validateEntityInput({ status: "in_formation", registeredOn: "2026-10-01" }, { today: "2026-10-05" }), /only for a registered/);
  assert.throws(() => E.validateEntityInput({ status: "registered", registeredOn: "2026-11-01" }, { today: "2026-10-05" }), /future/);
  assert.throws(() => E.validateEntityInput({ status: "gone" }, { today: "2026-10-05" }), /in_formation or registered/);
  const { call, db } = setup();
  const get = await call("GET", "/api/admin/finance/entity", { principal: VIEWER });
  assert.equal(get.status, 200, JSON.stringify(get.body));
  assert.equal(get.body.entity.label, "BV in formation");
  assert.equal(get.body.entity.installed, true);
  assert.equal((await call("PUT", "/api/admin/finance/entity", { principal: VIEWER, body: { status: "registered" } })).status, 403);
  const weeklyBefore = await call("GET", "/api/admin/finance/weekly", { principal: VIEWER });
  const put = await call("PUT", "/api/admin/finance/entity", { body: { status: "registered", registeredOn: "2026-10-02" } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.entity.label, "BV registered");
  assert.equal(put.body.entity.taxNote, null);
  assert.deepEqual(db.state.audit.at(-1).after, { status: "registered", registeredOn: "2026-10-02" });
  assert.equal(db.state.audit.at(-1).action, "settings.entity");
  const tax = await call("GET", "/api/admin/finance/tax", { principal: VIEWER });
  assert.equal(tax.body.entity.registeredOn, "2026-10-02");
  const weeklyAfter = await call("GET", "/api/admin/finance/weekly", { principal: VIEWER });
  assert.deepEqual(weeklyAfter.body.weeks, weeklyBefore.body.weeks, "no calculation reads it");
  assert.deepEqual(weeklyAfter.body.decision, weeklyBefore.body.decision);
  const hist = await call("GET", "/api/admin/finance/entity", { principal: VIEWER });
  assert.deepEqual(hist.body.history[0].changes, ["BV in formation to BV registered", "registration date none to 2026-10-02"]);
});
