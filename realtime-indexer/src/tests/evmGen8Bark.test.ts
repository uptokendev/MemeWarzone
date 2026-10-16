/**
 * Barkswap ingestion (DogeOS 6281971; barkswap plan t18, spec section 4 Indexer, section 3 per-swap event fields, B7),
 * no RPC and no Postgres: the recorded Chikyu-fork fixture (test/fixtures/dogeos/barkSwapEvent.json, t8) and the
 * recorded V4 fixture (src/tests/fixtures/gen8-logs.json) run through the real ingest code against the in-memory seams
 * of src/tests/gen8/gen8FakeChain.ts. Proves:
 *   - a recorded Bark swap writes the same row shape as a recorded V4 swap (venue gen8, execution_source gen8_v4);
 *   - D14: curve_trades up to and including the crossing swap, dex_trades after;
 *   - swap kinds: a conversion writes no trade, accrual or activity row (its price still feeds stats and candles);
 *     escrow buys and buybacks are league_excluded; the launcher's first buy is first_buy;
 *   - money rows (buy accruals, the graduation fee) only up to the money head (latest - 20 on 6281971);
 *   - getLogs never spans more than 10,000 blocks on DogeOS;
 *   - the V4 path writes exactly what it wrote before the venue seam (src/tests/fixtures/gen8-v4-ingest-writes.json,
 *     recorded from the code before t18 with MWZ_RECORD_GEN8_V4_WRITES=1).
 */
import "./gen8/gen8TestEnv.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ethers } from "ethers";
import v4fx from "./fixtures/gen8-logs.json" with { type: "json" };
import { evmGen8BarkConfig, evmGen8Config, type Gen8BarkChainConfig } from "../evm/evmGen8Config.js";
import { runGen8ChainOnce } from "../evm/evmGen8Pool.js";
import { sqrtAtTick } from "../evm/evmGen8Math.js";
import { FakeGen8Db, FakeGen8Provider, fakeGen8Sinks, plain, type RecordedLog, type SinkCall } from "./gen8/gen8FakeChain.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const barkFx = JSON.parse(fs.readFileSync(path.join(ROOT, "test/fixtures/dogeos/barkSwapEvent.json"), "utf8"));
const V4_SNAPSHOT = path.join(HERE, "fixtures/gen8-v4-ingest-writes.json");
const lc = (s: string) => s.toLowerCase();
const DOGE = 6281971;
const T0 = 1_791_990_000;

// ------------------------------------------------------------------ V4 run (the reference)

async function runV4() {
  const logs: RecordedLog[] = [];
  const txs = new Map<string, { from: string; to: string | null }>();
  for (const s of v4fx.steps) {
    txs.set(lc(s.txHash), { from: lc(s.from), to: null });
    for (const l of s.logs as any[]) logs.push({ address: l.address, topics: l.topics, data: l.data, blockNumber: Number(l.blockNumber), transactionHash: l.transactionHash, index: Number(l.index ?? l.logIndex) });
  }
  const last = Math.max(...logs.map((l) => l.blockNumber));
  const A = v4fx.addresses;
  const env: NodeJS.ProcessEnv = {
    EVM_GEN8_LAUNCHER_97: `${A.launcher}@1`, EVM_GEN8_HOOK_97: `${A.hook}@1`, EVM_GEN8_POOL_MANAGER_97: A.poolManager,
    EVM_GEN8_SPLITTER_97: `${A.splitter}@1`, EVM_GEN8_CHOICE_VAULT_97: A.choiceVault, EVM_GEN8_ESCROW_97: A.escrow,
    EVM_GEN8_DISPLAY_HEAD_TAG_97: "latest", EVM_GEN8_MONEY_HEAD_TAG_97: "latest", EVM_GEN8_CONFIRMATIONS: "0", EVM_GEN8_LOG_CHUNK: "5000",
  };
  const cfg = evmGen8Config(97, env).config!;
  const db = new FakeGen8Db();
  const calls: SinkCall[] = [];
  const provider = new FakeGen8Provider(logs, last + 1, txs, (n) => T0 + n * 2);
  const ctx = { cfg, db, provider, sinks: fakeGen8Sinks(calls), env };
  for (let i = 0; i < 10; i += 1) if (!(await runGen8ChainOnce(ctx))) break;
  return { db, calls, cfg };
}

test("V4 path unchanged: the recorded V4 lifecycle writes exactly the recorded statements and sink calls", async () => {
  const { db, calls } = await runV4();
  // SQL as its first words plus a hash of the whole normalised statement (keeps the snapshot small and exact).
  const got = plain({ queries: db.log.map((q) => ({ sql: `${q.sql.slice(0, 60)}#${createHash("sha256").update(q.sql).digest("hex").slice(0, 16)}`, params: q.params })), sinks: calls });
  if (process.env.MWZ_RECORD_GEN8_V4_WRITES === "1") {
    fs.writeFileSync(V4_SNAPSHOT, `${JSON.stringify(got, null, 1)}\n`);
    return;
  }
  const want = JSON.parse(fs.readFileSync(V4_SNAPSHOT, "utf8"));
  assert.equal(db.writes("insert into public.curve_trades(").length, 6, "launch first buy + four bonding swaps + the crossing");
  assert.equal(db.writes("insert into public.dex_trades(").length, 2);
  assert.deepEqual(got, want);
});

// ------------------------------------------------------------------ Barkswap run (the recorded Chikyu-fork lifecycle)

const BC = barkFx.contracts as Record<string, string>;
const COIN = lc(barkFx.coin);
const POOL = lc(barkFx.pool);
const barkLogs = (): RecordedLog[] =>
  (barkFx.logs as any[]).map((l) => ({ address: l.address, topics: l.topics, data: l.data, blockNumber: Number(l.blockNumber), transactionHash: l.transactionHash, index: Number(l.logIndex) }));
const barkLog = (step: string, event: string) => (barkFx.logs as any[]).find((l) => l.step === step && l.event === event)!;
const BARK_START = Number(barkFx.logs[0].blockNumber);
const BARK_LAST = Math.max(...(barkFx.logs as any[]).map((l) => Number(l.blockNumber)));

function barkEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    EVM_GEN8_LAUNCHER_6281971: `${BC.MwzBarkLauncher}@${BARK_START}`, EVM_GEN8_PLUGIN_6281971: `${BC.MwzBarkPlugin}@${BARK_START}`,
    EVM_GEN8_SPLITTER_6281971: `${BC.MwzBarkFeeSplitter}@${BARK_START}`, EVM_GEN8_CHOICE_VAULT_6281971: BC.MwzBarkCreatorChoiceVault,
    EVM_GEN8_RESERVE_LOCK_6281971: BC.MwzBarkReserveLock, EVM_GEN8_ESCROW_6281971: BC.MwzBarkCreatorEscrow, EVM_GEN8_LOG_CHUNK: "5000",
    ...extra,
  };
}

async function runBark(opts: { head?: number; env?: NodeJS.ProcessEnv; logs?: RecordedLog[]; usd?: { priceUsd: number; healthy: boolean; updatedAt: Date | null; error: string | null } } = {}) {
  const bark = await import("../evm/evmGen8Bark.js");
  const env = barkEnv(opts.env);
  const cfg = evmGen8BarkConfig(DOGE, env).config as Gen8BarkChainConfig;
  assert.ok(cfg, "barkswap config");
  const txs = new Map<string, { from: string; to: string | null }>();
  for (const l of barkFx.logs as any[]) txs.set(lc(l.transactionHash), { from: lc(l.txFrom), to: lc(l.txTo) });
  const times = new Map<number, number>((barkFx.logs as any[]).map((l) => [Number(l.blockNumber), Number(l.blockTimestamp)]));
  const db = new FakeGen8Db();
  const calls: SinkCall[] = [];
  const provider = new FakeGen8Provider(opts.logs ?? barkLogs(), opts.head ?? BARK_LAST + 25, txs, (n) => times.get(n) ?? T0 + n);
  const ctx = { cfg, db, provider, sinks: fakeGen8Sinks(calls), env, usdReference: async () => opts.usd ?? null };
  for (let i = 0; i < 20; i += 1) if (!(await bark.runGen8BarkChainOnce(ctx))) break;
  return { db, calls, cfg, provider, bark };
}

const txOf = (q: { params: unknown[] }, i: number) => String(q.params[i]);

test("Bark ABI: every event the indexer reads has the topic0 of the exported t7 ABI (reserve lock and choice vault included)", async () => {
  const bark = await import("../evm/evmGen8Bark.js");
  const abiDir = path.join(ROOT, "contracts/dogeos/barkswap/abi");
  const exported = new Map<string, string>();
  for (const file of fs.readdirSync(abiDir)) {
    const iface = new ethers.Interface(JSON.parse(fs.readFileSync(path.join(abiDir, file), "utf8")));
    iface.forEachEvent((ev) => exported.set(`${file.replace(".abi.json", "")}.${ev.name}`, ev.topicHash));
  }
  const ours: Array<[string, readonly string[]]> = [
    ["MwzBarkLauncher", bark.BARK_LAUNCHER_EVENTS], ["MwzBarkPlugin", bark.BARK_PLUGIN_EVENTS],
    ["MwzBarkReserveLock", bark.BARK_RESERVE_LOCK_EVENTS], ["MwzBarkCreatorChoiceVault", bark.BARK_CHOICE_VAULT_EVENTS], ["MwzBarkFeeSplitter", bark.BARK_SPLITTER_EVENTS],
  ];
  let n = 0;
  for (const [contract, sigs] of ours) {
    const iface = new ethers.Interface(sigs as unknown as string[]);
    iface.forEachEvent((ev) => {
      assert.equal(ev.topicHash, exported.get(`${contract}.${ev.name}`), `${contract}.${ev.name}`);
      n += 1;
    });
  }
  assert.ok(n >= 35, `${n} events pinned`);
  assert.equal(bark.BARK_TOPICS.ReserveLocked, ethers.id("ReserveLocked(address,uint256)"));
  assert.equal(bark.BARK_TOPICS.ReserveReleased, ethers.id("ReserveReleased(address,address,uint256)"));
});

test("Bark decode: every recorded log decodes to its event with the recorded arguments; synthetic reserve-lock, Restored, CoinRegistered", async () => {
  const bark = await import("../evm/evmGen8Bark.js");
  const cfg = evmGen8BarkConfig(DOGE, barkEnv()).config!;
  const addrs = bark.barkAddresses(cfg);
  const norm = (x: unknown): unknown => (Array.isArray(x) ? x.map(norm) : typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x) ? x.toLowerCase() : String(x));
  for (const l of barkFx.logs as any[]) {
    const e = bark.decodeBarkLog({ ...l, index: l.logIndex }, addrs);
    if (l.contract === "MwzBarkCreatorEscrow") {
      assert.equal(e, null, "the escrow is read as on gen-8 (exclusions), not ingested");
      continue;
    }
    assert.ok(e, `${l.event} decodes`);
    assert.equal(e!.kind, l.event);
    for (const [k, v] of Object.entries(l.args as Record<string, unknown>)) {
      // `kind` is the event name on every decoded event; BarkSwap's swap kind is `swapKind`.
      const got = (e as any)[l.event === "BarkSwap" && k === "kind" ? "swapKind" : k];
      assert.ok(got !== undefined, `${l.event}.${k} present`);
      assert.deepEqual(norm(got), norm(v), `${l.event}.${k}`);
    }
  }
  const at = (address: string, sigs: readonly string[], name: string, args: unknown[]) => {
    const iface = new ethers.Interface(sigs as unknown as string[]);
    const enc = iface.encodeEventLog(iface.getEvent(name)!, args);
    return bark.decodeBarkLog({ address, topics: enc.topics, data: enc.data, blockNumber: 9, transactionHash: "0x01", index: 0 }, addrs) as any;
  };
  const locked = at(BC.MwzBarkReserveLock, bark.BARK_RESERVE_LOCK_EVENTS, "ReserveLocked", [COIN, 20n * 10n ** 24n]);
  assert.deepEqual([locked.kind, locked.coin, locked.amount], ["ReserveLocked", COIN, 20n * 10n ** 24n]);
  const to = "0x00000000000000000000000000000000000000aa";
  const released = at(BC.MwzBarkReserveLock, bark.BARK_RESERVE_LOCK_EVENTS, "ReserveReleased", [COIN, to, 5n]);
  assert.deepEqual([released.kind, released.coin, released.to, released.amount], ["ReserveReleased", COIN, to, 5n]);
  const r = at(BC.MwzBarkLauncher, bark.BARK_LAUNCHER_EVENTS, "Restored", [COIN, POOL, true, false, true]);
  assert.deepEqual([r.kind, r.coin, r.pool, r.pluginReset, r.feeReset, r.configReset], ["Restored", COIN, POOL, true, false, true]);
  const c = at(BC.MwzBarkCreatorChoiceVault, bark.BARK_CHOICE_VAULT_EVENTS, "CoinRegistered", [COIN, to, 3, 40]);
  assert.deepEqual([c.kind, c.token, c.creator, c.choice, c.creatorPct], ["CoinRegistered", COIN, to, 3, 40]);
});

test("pool id representation: the Barkswap pool address left-padded to bytes32 (what gen8FieldsFromRow and the holder batch accept)", async () => {
  const bark = await import("../evm/evmGen8Bark.js");
  const id = bark.barkPoolId(barkFx.pool);
  assert.match(id, /^0x[0-9a-f]{64}$/, "campaigns-base.js gen8FieldsFromRow only takes a 32-byte pool id");
  assert.equal(id, `0x${"0".repeat(24)}${POOL.slice(2)}`);
  assert.equal(bark.barkPoolAddress(id), POOL);
  assert.throws(() => bark.barkPoolAddress(`0x${"1".repeat(64)}`), /not a Barkswap pool id/);
});

test("Bark price maths equal the API's (frontend/shared/evmGen8Bark.mjs) on the recorded prices", async () => {
  const bark = await import("../evm/evmGen8Bark.js");
  const shared: any = await import(pathToFileURL(path.join(ROOT, "frontend/shared/evmGen8Bark.mjs")).href);
  const L = barkFx.launch;
  const pool = { liqA: BigInt(L.liqA), tickStart: Number(L.tickStart), tickGrad: Number(L.tickGrad) };
  const prices = (barkFx.logs as any[]).filter((l) => l.event === "BarkSwap").map((l) => BigInt(l.args.sqrtPriceAfter));
  assert.ok(prices.length >= 7);
  for (const s of [BigInt(L.sqrtStart), ...prices, BigInt(L.sqrtGrad)]) {
    assert.equal(bark.barkNativePerCoinWei(s), shared.barkPriceNativeWeiPerCoin(s));
    const mine = bark.barkProgress({ ...pool, sqrtPriceX96: s });
    const theirs = shared.barkProgress({ ...pool, sqrtPriceX96: s });
    assert.deepEqual([mine.soldRaw, mine.capacityRaw, mine.bps, mine.complete], [theirs.soldRaw, theirs.capacityRaw, theirs.bps, theirs.complete]);
    assert.equal(bark.barkPricePhase(pool, s) === "post", shared.barkPostPhase(s, pool.tickGrad));
    const t = bark.barkTickAtSqrt(s);
    assert.ok(sqrtAtTick(t) <= s && sqrtAtTick(t + 1) > s, "tick = the floor tick of the price");
  }
  const full = bark.barkProgress({ ...pool, sqrtPriceX96: BigInt(L.sqrtGrad) });
  assert.equal(full.complete, true);
  assert.ok(full.capacityRaw > 849_000_000n * 10n ** 18n && full.capacityRaw <= 850_000_000n * 10n ** 18n, String(full.capacityRaw));
});

test("a recorded Bark swap writes the same row shape as a recorded V4 swap (venue gen8, execution_source gen8_v4, wallet = tx.from)", async () => {
  const v4 = await runV4();
  const { db } = await runBark();
  const v4Curve = v4.db.writes("insert into public.curve_trades(");
  const bkCurve = db.writes("insert into public.curve_trades(");
  const v4Dex = v4.db.writes("insert into public.dex_trades(");
  const bkDex = db.writes("insert into public.dex_trades(");
  const shape = (q: { sql: string; params: unknown[] }) => ({ sql: q.sql, types: q.params.map((p) => (p === null ? "null" : typeof p)) });
  const sw = barkLog("router buy (bonding)", "BarkSwap");
  const buy = bkCurve.find((q) => txOf(q, 2) === lc(sw.transactionHash))!;
  const v4Buy = v4Curve.find((q) => txOf(q, 2) === lc(v4fx.steps.find((s) => s.label === "buy_exact_in")!.txHash))!;
  assert.deepEqual(shape(buy), shape(v4Buy), "curve_trades: same statement, same column types");
  assert.equal(buy.params[13], "gen8");
  assert.equal(buy.params[13], v4Buy.params[13]);
  assert.equal(buy.params[7], lc(sw.txFrom), "trader = tx.from");
  assert.deepEqual([buy.params[6], buy.params[8], buy.params[9], buy.params[14], buy.params[15]], ["buy", sw.args.coinAmount, sw.args.curveAmount, sw.args.grossFee, Number(sw.args.rateBps)], "coins out, curve (gen-7 volume), gross fee, rate");
  const postBuy = bkDex.find((q) => txOf(q, 3) === lc(barkLog("router buy (post-graduation)", "BarkSwap").transactionHash))!;
  assert.deepEqual(shape(postBuy), shape(v4Dex[0]!), "dex_trades: same statement, same column types");
  assert.equal(postBuy.params.at(-1), "gen8_v4", "execution_source gen8_v4 (row identity)");
  assert.equal(postBuy.params[2], POOL, "pair_address = the Barkswap pool");
  assert.equal(postBuy.params[16], "0xf6bdb158a5ddf77f1b83bc9074f6a472c58d78ae", "quote = WDOGE");
  // a sell's fee is charged in coins: the row's native fee is its value at the swap's own fill price
  const s = barkLog("router sell (bonding)", "BarkSwap");
  const sell = bkCurve.find((q) => txOf(q, 2) === lc(s.transactionHash))!;
  assert.equal(sell.params[6], "sell");
  assert.equal(sell.params[8], s.args.coinAmount, "coins in, fee included");
  assert.equal(sell.params[9], s.args.curveAmount, "curve = the WDOGE payout");
  assert.equal(sell.params[14], ((BigInt(s.args.grossFee) * BigInt(s.args.curveAmount)) / (BigInt(s.args.coinAmount) - BigInt(s.args.grossFee))).toString());
});

test("D14 and swap kinds: crossing in curve_trades, later swaps in dex_trades; a conversion writes no row; first buy and escrow marked", async () => {
  const { db, calls } = await runBark();
  const curveTx = db.writes("insert into public.curve_trades(").map((q) => txOf(q, 2));
  const dexTx = db.writes("insert into public.dex_trades(").map((q) => txOf(q, 3));
  const tx = (step: string) => lc(barkLog(step, "BarkSwap").transactionHash);
  assert.deepEqual(curveTx, [tx("launch with creator first buy"), tx("router buy (bonding)"), tx("router sell (bonding)"), tx("router buy crossing graduation")]);
  assert.deepEqual(dexTx, [tx("router buy (post-graduation)"), tx("router sell (post-graduation)"), tx("escrow buy (creator)")]);
  const conv = tx("convert (coin fees to DOGE)");
  for (const q of db.log.filter((x) => x.params.includes(conv))) {
    assert.ok(!/^insert into public\.(curve_trades|dex_trades|evm_gen8_fee_accruals|evm_gen8_swaps|reward_events)/.test(q.sql), `conversion wrote ${q.sql.slice(0, 50)}`);
  }
  assert.ok(!calls.some((c) => c.name === "insertActivityEvent" && JSON.stringify(c.args).includes(conv)), "no BUY/SELL activity for a conversion");
  const convSwap = barkLog("convert (coin fees to DOGE)", "BarkSwap");
  assert.ok(db.writes("update public.evm_gen8_pools set last_sqrt_price_x96").some((q) => q.params[2] === convSwap.args.sqrtPriceAfter), "the conversion's price still moves the pool price");
  const convCandles = db.writes("insert into public.token_candles(").filter((q) => q.params.includes(convSwap.blockNumber));
  assert.ok(convCandles.length > 0, "the conversion's price feeds the candles");
  assert.ok(convCandles.every((q) => !q.sql.includes("trades_count + 1") && !q.sql.includes("volume_bnb + excluded")), "price only: no trade and no volume counted");
  const curve = db.writes("insert into public.curve_trades(");
  const first = curve.find((q) => txOf(q, 2) === tx("launch with creator first buy"))!;
  assert.deepEqual([first.params[17], first.params[18]], ["first_buy", true], "the launcher's first buy: first_buy, league excluded");
  assert.deepEqual([curve.find((q) => txOf(q, 2) === tx("router buy (bonding)"))!.params[17], curve.find((q) => txOf(q, 2) === tx("router buy (bonding)"))!.params[18]], [null, false]);
  const escrowRow = db.writes("insert into public.dex_trades(").find((q) => txOf(q, 3) === tx("escrow buy (creator)"))!;
  assert.equal(escrowRow.params[9], lc(BC.MwzBarkCreatorEscrow), "sender_address = the escrow (gen-8 league exclusion by swap sender)");
  // Graduated (plugin) latches the campaign once, with the Barkswap market label (never WBNB).
  assert.deepEqual(calls.filter((c) => c.name === "raiseAlert").map((c) => (c.args[0] as any).kind), [], "the recorded lifecycle raises no anomaly or config alert");
  const grads = calls.filter((c) => c.name === "markEvmCampaignGraduated");
  assert.equal(grads.length, 1);
  assert.deepEqual((grads[0]!.args[1] as any).market, { venue: "barkswap_algebra_plugin", pair: POOL, quoteAsset: "DOGE" });
});

test("money rows: buy accruals on the net fee, the graduation fee from GraduationFeeTaken; none for sells (t19) or the conversion; only up to latest - 20", async () => {
  const { db } = await runBark({ head: BARK_LAST + 25 });
  const acc = db.writes("insert into public.evm_gen8_fee_accruals(");
  const tx = (step: string, ev = "BarkSwap") => lc(barkLog(step, ev).transactionHash);
  const byTx = (t: string) => acc.filter((q) => txOf(q, 4) === t);
  for (const step of ["launch with creator first buy", "router buy (bonding)", "router buy crossing graduation", "router buy (post-graduation)", "escrow buy (creator)"]) {
    const rows = byTx(tx(step));
    assert.equal(rows.length, step === "router buy crossing graduation" ? 2 : 1, step);
    const trade = rows.find((q) => q.params[9] === "trade")!;
    const a = barkLog(step, "BarkSwap").args;
    assert.equal(trade.params[1], lc(BC.MwzBarkPlugin), "hook_address = the plugin");
    assert.equal(trade.params[2], `0x${"0".repeat(24)}${POOL.slice(2)}`);
    assert.equal(trade.params[17], a.netFee, "B11: the accrual base is the net fee");
    assert.equal(trade.params[19], a.creatorAmount);
    assert.equal(trade.params[10], a.phase === "1" ? "post" : "bonding");
  }
  for (const step of ["router sell (bonding)", "router sell (post-graduation)", "convert (coin fees to DOGE)"]) assert.equal(byTx(tx(step)).length, 0, step);
  const grad = acc.find((q) => q.params[9] === "graduation")!;
  const g = barkLog("router buy crossing graduation", "GraduationFeeTaken");
  assert.deepEqual([grad.params[4], grad.params[5], grad.params[17]], [lc(g.transactionHash), g.logIndex, g.args.amount]);
  // money head: latest - 20 on 6281971; the display pass reads to the head
  const shallow = await runBark({ head: BARK_LAST + 10 });
  const shallowAcc = shallow.db.writes("insert into public.evm_gen8_fee_accruals(");
  assert.ok(shallowAcc.every((q) => Number(q.params[7]) <= BARK_LAST + 10 - 20), "no money row above latest - 20");
  assert.ok(shallowAcc.length < acc.length);
  assert.equal(shallow.db.writes("insert into public.dex_trades(").length, 3, "display rows are not held back");
});

test("windowing: getLogs never spans more than 10,000 blocks on DogeOS, whatever EVM_GEN8_LOG_CHUNK says", async () => {
  const { provider, db, bark } = await runBark({ head: BARK_LAST + 31_000, env: { EVM_GEN8_LOG_CHUNK: "50000" } });
  assert.equal(bark.GEN8_BARK_MAX_LOG_SPAN, 10_000);
  assert.ok(provider.getLogsCalls.length >= 4);
  for (const c of provider.getLogsCalls) assert.ok(c.toBlock - c.fromBlock + 1 <= 10_000, `${c.fromBlock}..${c.toBlock}`);
  assert.equal(db.writes("insert into public.curve_trades(").length, 4);
});

test("holder exclusions on 6281971: each pool, launcher, plugin, reserve lock, escrow, choice vault, Barkswap community vault", async () => {
  const { gen8HolderExclusions, runGen8HolderCensusOnce } = await import("../evm/evmGen8Holders.js");
  const cfg = evmGen8BarkConfig(DOGE, barkEnv()).config!;
  const x = new Map(gen8HolderExclusions(cfg).map((e) => [e.wallet, e.reason]));
  assert.equal(x.get(lc(BC.MwzBarkLauncher)), "launcher");
  assert.equal(x.get(lc(BC.MwzBarkPlugin)), "plugin");
  assert.equal(x.get(lc(BC.MwzBarkReserveLock)), "reserve_lock");
  assert.equal(x.get(lc(BC.MwzBarkCreatorEscrow)), "escrow");
  assert.equal(x.get(lc(BC.MwzBarkCreatorChoiceVault)), "choice_vault");
  assert.equal(x.get("0xa305f8bdf7eaa3233b3918a39d1e0867c6116c83"), "barkswap_community_vault");
  assert.equal(x.get("0x000000000000000000000000000000000000dead"), "dead");
  assert.ok(![...x.values()].includes("pool_manager") && ![...x.values()].includes("hook"), "no V4 contracts");
  // each coin's own pool: the census excludes evm_gen8_pools.pool_manager_address (the pool contract on Barkswap)
  const db = new FakeGen8Db();
  await runGen8HolderCensusOnce({ db, cfg, provider: { getBlockNumber: async () => 100, getBlock: async () => ({ number: 100 }), getLogs: async () => [] }, env: {} });
  assert.ok(db.log.some((q) => q.sql.includes("'barkswap_pool'") && q.sql.includes("pool_manager_address")), "pool exclusion insert");
  assert.ok(db.log.some((q) => q.sql.includes("p.hook_address = $2") && q.params[1] === lc(BC.MwzBarkPlugin)), "the census selects the plugin's coins");
  const v4 = evmGen8Config(97, { EVM_GEN8_LAUNCHER_97: `${v4fx.addresses.launcher}@1`, EVM_GEN8_HOOK_97: `${v4fx.addresses.hook}@1`, EVM_GEN8_POOL_MANAGER_97: v4fx.addresses.poolManager }).config!;
  assert.deepEqual(gen8HolderExclusions(v4).map((e) => e.reason), ["pool_manager", "hook", "dead", "launcher"], "V4 unchanged");
});

test("holder batch on Barkswap: bytes32 pool ids internally, the Bark vault's proposeHolderBatch takes coin addresses", async () => {
  const { planGen8HolderWeek } = await import("../evm/evmGen8HolderBatch.js");
  const bark = await import("../evm/evmGen8Bark.js");
  const id = bark.barkPoolId(POOL);
  const h1 = "0x00000000000000000000000000000000000000b1";
  const base = {
    chainId: DOGE, vault: BC.MwzBarkCreatorChoiceVault, holderDistributor: "0x00000000000000000000000000000000000000d1", weekId: "2026-W42",
    nowSec: 1_800_000_000, holderBatchDelaySec: 86_400, claimWindowDays: 30, minPayoutWei: 1n, roomWei: 10n ** 18n, authCapWei: 10n ** 18n,
    pots: new Map([[id, 1000n]]), holders: new Map([[id, [{ owner: h1, amount: 5n }]]]),
  };
  const plan = planGen8HolderWeek({ ...base, barkswapCoins: new Map([[id, COIN]]) });
  assert.equal(plan.reason, "built");
  assert.deepEqual(plan.file!.pools, [{ poolId: id, coin: COIN, amount: "1000" }]);
  const vault = new ethers.Interface(JSON.parse(fs.readFileSync(path.join(ROOT, "contracts/dogeos/barkswap/abi/MwzBarkCreatorChoiceVault.abi.json"), "utf8")));
  const decoded = vault.decodeFunctionData("proposeHolderBatch", plan.propose!.data);
  assert.deepEqual(decoded[3].map((a: string) => lc(a)), [COIN], "the Bark vault is keyed by coin");
  assert.equal(plan.safe!.calls[0]!.contract, "MwzBarkCreatorChoiceVault");
  assert.throws(() => planGen8HolderWeek({ ...base, barkswapCoins: new Map() }), /no coin for Barkswap pool id/);
  const v4 = planGen8HolderWeek(base);
  assert.deepEqual(v4.file!.pools, [{ poolId: id, amount: "1000" }], "V4 leaf file unchanged");
});

test("graduatedMarketFor never announces WBNB (or any gen-7 market) for 6281971", async () => {
  const chains = await import("../evmIndexerChains.js");
  assert.throws(() => chains.graduatedMarketFor(DOGE), /DogeOS graduates only through gen-8/);
  assert.deepEqual(chains.graduatedMarketFor(97), { venue: "topaz", quoteAsset: "WBNB" });
});

test("DOGE/USD: market_stats USD columns of a graduated coin from the DogeOS oracle reference; nothing without one", async () => {
  const none = await runBark();
  assert.equal(none.db.writes("update public.market_stats set last_price_usd").length, 0);
  const at = new Date("2026-10-15T00:00:00Z");
  const { db } = await runBark({ usd: { priceUsd: 0.25, healthy: true, updatedAt: at, error: null } });
  const usd = db.writes("update public.market_stats set last_price_usd");
  // post-graduation buy, sell, escrow buy and the post-phase conversion
  assert.equal(usd.length, 4);
  for (const q of usd) assert.deepEqual(q.params.slice(2), [0.25, at.toISOString(), true, null]);
  assert.ok(usd.every((q) => q.params[1] === COIN));
});
