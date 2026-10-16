/**
 * Barkswap fee attribution, sell conversion and route runs (DogeOS 6281971; barkswap plan t19, spec section 3 "Money
 * flow" 1-5 and "Attribution for D1", B10, B11). No RPC, no Postgres: the recorded Chikyu-fork money flow
 * (test/fixtures/dogeos/barkMoneyFlow.json, t9: two coins, buys, sells, a graduation with its inline fee, collects with
 * Algebra rounding, a partial and a full conversion, claimRouter, claimCreator, one route run) runs through
 *   - the pure attribution (evmGen8BarkAttribution.ts barkAttribute), and
 *   - the real money ingest (ingestGen8BarkRange, money mode), the route pass (runGen8RoutePass) and the Routed
 *     reconciliation (recordRoutedRun) against an in-memory DB,
 * and reconciles to the wei with the launcher's books (FeesCollected / CoinFeesConverted / read-backs), routerPaid and
 * the splitter's pending() and Routed run.
 */
import "./gen8/gen8TestEnv.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import {
  applyBarkAttributionAt,
  barkAttribute,
  barkCreditSlices,
  barkMoneyLogFromEvent,
  ensureBarkAttributionBackfill,
  GEN8_BARK_ATTRIBUTION_MARKER,
  type BarkBuySource,
  type BarkMoneyLog,
  type BarkSellSource,
} from "../evm/evmGen8BarkAttribution.js";
import { barkBuyAccrual, barkPoolId, decodeBarkLog, ingestGen8BarkRange, type BarkSwapEvent } from "../evm/evmGen8Bark.js";
import { evmGen8BarkConfig, type Gen8BarkChainConfig } from "../evm/evmGen8Config.js";
import { BARK_LAUNCHER_ROUTER_FRAGMENTS, ethersRouteChain, recordRoutedRun, runGen8RoutePass, type Gen8RouteChain } from "../evm/evmGen8FeeRouting.js";
import { gen8TradeSlices, splitterBands, LEAGUE_BPS, BPS } from "../evm/evmGen8Fees.js";
import { upsertGen8Pool } from "../evm/evmGen8Store.js";
import { FakeGen8Db, FakeGen8Provider, fakeGen8Sinks, type RecordedLog, type SinkCall } from "./gen8/gen8FakeChain.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const fx = JSON.parse(fs.readFileSync(path.join(ROOT, "test/fixtures/dogeos/barkMoneyFlow.json"), "utf8"));
const lc = (s: string) => s.toLowerCase();
const DOGE = 6281971;
const C = Object.fromEntries(Object.entries(fx.contracts as Record<string, string>).map(([k, v]) => [k, lc(v)]));
const X = lc(fx.coins[0].coin);
const Y = lc(fx.coins[1].coin);
const big = (v: unknown) => BigInt(String(v));
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
const step = (name: string) => fx.steps.find((s: any) => s.step === name);
const claimStep = step("claimRouter (operator)");
const RP = fx.routePlan;

const env: NodeJS.ProcessEnv = {
  [`EVM_GEN8_LAUNCHER_${DOGE}`]: `${C.MwzBarkLauncher}@8578700`,
  [`EVM_GEN8_PLUGIN_${DOGE}`]: `${C.MwzBarkPlugin}@8578700`,
  [`EVM_GEN8_SPLITTER_${DOGE}`]: `${C.MwzBarkFeeSplitter}@8578700`,
};
const cfg = evmGen8BarkConfig(DOGE, env).config as Gen8BarkChainConfig;
const addrs = { launcher: C.MwzBarkLauncher, plugin: C.MwzBarkPlugin, splitter: C.MwzBarkFeeSplitter, choiceVault: null, reserveLock: null };

// The launch transaction of X (creator first buy) is before the recording; its plugin totals are initialReadBack's.
const XFIRST = fx.initialReadBack.coins[fx.coins[0].coin].pluginTotals.native.map(big) as bigint[];
const FIRST_BUY_TX = `0x${"f1".repeat(32)}`;
const FIRST_BUY_BLOCK = 8578740;

function recordedLogs(): Array<RecordedLog & { txFrom: string; blockTimestamp: number }> {
  return fx.logs.map((l: any) => ({
    address: l.address, topics: l.topics, data: l.data, blockNumber: Number(l.blockNumber), transactionHash: l.transactionHash, index: Number(l.logIndex),
    txFrom: lc(l.txFrom), blockTimestamp: Number(l.blockTimestamp),
  }));
}

/** The pure inputs from the recorded logs (what the DB rows hold): buys, sells, collects and conversions. */
function pureInputs() {
  const buys: BarkBuySource[] = [{
    token: X, txHash: FIRST_BUY_TX, logIndex: 5, blockNumber: FIRST_BUY_BLOCK, phase: "bonding", trader: lc(fx.coins[0].creator), swapSender: C.MwzBarkLauncher,
    profile: "standard_unlinked", router: XFIRST[1], creator: XFIRST[0],
  }];
  const sells: BarkSellSource[] = [];
  const logs: BarkMoneyLog[] = [];
  for (const l of recordedLogs()) {
    const e = decodeBarkLog(l, addrs) as any;
    if (!e) continue;
    const at = new Date(l.blockTimestamp * 1000);
    if (e.kind === "BarkSwap" && e.swapKind === 0) {
      const s = e as BarkSwapEvent;
      const base = { token: s.coin, txHash: s.txHash, logIndex: s.logIndex, blockNumber: s.blockNumber, phase: s.phase === 1 ? ("post" as const) : ("bonding" as const), trader: l.txFrom, swapSender: s.sender, profile: s.phase === 1 ? null : ("standard_unlinked" as const) };
      if (s.buy) buys.push({ ...base, router: s.netFee - s.creatorAmount, creator: s.creatorAmount });
      else sells.push({ ...base, routerCoins: s.netFee - s.creatorAmount, creatorCoins: s.creatorAmount });
    }
    const m = barkMoneyLogFromEvent(e.kind, e, { txHash: e.txHash, logIndex: e.logIndex, blockNumber: e.blockNumber, blockTime: at });
    if (m) logs.push(m);
  }
  return { buys, sells, logs };
}

function logArgs(event: string, coin?: string) {
  return fx.logs.filter((l: any) => l.event === event && (!coin || lc(l.args.coin) === coin)).map((l: any) => ({ ...l, args: l.args }));
}

test("B11: a Bark buy's accrual keeps fee = the net fee and the creator amount (B10) and takes gen-8's percentages of the router part", () => {
  const raw = logArgs("BarkSwap", X)[0];
  const e = decodeBarkLog({ ...raw, index: raw.logIndex }, addrs) as BarkSwapEvent;
  const row = barkBuyAccrual(cfg, { poolId: barkPoolId(fx.coins[0].pool), token: X }, e, lc(raw.txFrom), new Date(0), "standard_linked");
  const routerPart = e.netFee - e.creatorAmount;
  assert.equal(row.slices.fee, e.netFee, "fee column: the net fee (what reached our positions)");
  assert.equal(row.slices.creatorShare, e.creatorAmount);
  assert.equal(row.slices.routerAmount, routerPart);
  const league = (routerPart * LEAGUE_BPS) / BPS;
  assert.equal(row.slices.leagueWeekly + row.slices.leagueMonthly, league, "league = 37.5% of the router part (B11), not of the whole fee");
  const onRouter = gen8TradeSlices({ fee: routerPart, creatorShare: 0n, graduated: false, profile: "standard_linked" });
  assert.deepEqual([row.slices.recruiter, row.slices.squad, row.slices.airdrop, row.slices.protocol], [onRouter.recruiter, onRouter.squad, onRouter.airdrop, onRouter.protocol]);
  // the V4 convention is untouched: bps of the whole fee
  const v4 = gen8TradeSlices({ fee: e.netFee, creatorShare: e.creatorAmount, graduated: false, profile: "standard_linked" });
  assert.equal(v4.leagueWeekly + v4.leagueMonthly, (e.netFee * LEAGUE_BPS) / BPS);
});

test("pure attribution: per crediting log the credits of each router book equal the launcher's book amount to the wei", () => {
  const { buys, sells, logs } = pureInputs();
  const a = barkAttribute({ buys, sells, logs });
  assert.deepEqual(a.anomalies, []);
  for (const raw of [...logArgs("FeesCollected"), ...logArgs("CoinFeesConverted")]) {
    const at = a.credits.filter((c) => c.txHash === lc(raw.transactionHash) && c.logIndex === raw.logIndex);
    const books = (raw.event === "FeesCollected" ? raw.args.nativeBooks : raw.args.native).map(big);
    assert.equal(sum(at.filter((c) => c.book === "router_bonding").map((c) => c.fee)), books[1], `${raw.step} router bonding`);
    assert.equal(sum(at.filter((c) => c.book === "router_post").map((c) => c.fee)), books[3], `${raw.step} router post`);
    assert.ok(at.every((c) => c.fee >= 0n && c.coins >= 0n));
  }
});

test("pure attribution: buys are final at the swap, covered by their collect; Algebra's rounding comes off the latest row", () => {
  const { buys, sells, logs } = pureInputs();
  const a = barkAttribute({ buys, sells, logs });
  const collectX = logArgs("FeesCollected", X)[0];
  const covered = a.credits.filter((c) => c.txHash === lc(collectX.transactionHash) && c.book === "router_bonding");
  const xBondingBuys = buys.filter((b) => b.token === X && b.phase === "bonding" && b.blockNumber < collectX.blockNumber);
  assert.deepEqual(covered.map((c) => `${c.sourceTxHash}:${c.sourceLogIndex}`), xBondingBuys.map((b) => `${b.txHash}:${b.logIndex}`), "every buy before the collect, in order");
  const deficit = sum(xBondingBuys.map((b) => b.router)) - big(collectX.args.nativeBooks[1]);
  assert.equal(deficit, 1n, "the recorded collect is 1 wei short (Algebra Q128 floor)");
  assert.deepEqual(covered.map((c) => c.fee), xBondingBuys.map((b, i) => (i === xBondingBuys.length - 1 ? b.router - deficit : b.router)));
  assert.ok(covered.every((c) => c.side === "buy" && c.kind === "trade" && c.phase === "bonding" && c.creditKind === "collect"));
});

test("pure attribution: every conversion converts each pending sell by the same fraction at the conversion's average price", () => {
  const { buys, sells, logs } = pureInputs();
  const a = barkAttribute({ buys, sells, logs });
  const conv = logArgs("CoinFeesConverted", X)[0];
  const coinsIn = big(conv.args.coinsIn);
  const pending = big(conv.args.pending);
  const nativeOut = big(conv.args.nativeOut);
  const parts = a.credits.filter((c) => c.txHash === lc(conv.transactionHash) && c.creditKind === "convert");
  for (const c of parts) {
    const pendingBefore = c.sourcePendingBefore;
    // drawn = the conversion's fraction of what was pending (floor, the few leftover coins on the latest entries)
    const exact = (pendingBefore * coinsIn) / pending;
    assert.ok(c.coins >= exact && c.coins <= exact + 3n, `${c.sourceTxHash} drawn ${c.coins} vs ${exact}`);
    // valued at the conversion's average price nativeOut / coinsIn (floor; the book's leftover wei on the latest entries)
    const value = (c.coins * nativeOut) / coinsIn;
    assert.ok(c.fee >= value - 1n && c.fee <= value + 2n, `${c.sourceTxHash} native ${c.fee} vs ${value}`);
  }
  // the X bonding sell is the only entry of the router bonding book: it converts exactly the book's draw
  const xSell = sells.find((s) => s.token === X && s.phase === "bonding")!;
  const sx = a.sells.get(`${xSell.txHash}:${xSell.logIndex}`)!;
  assert.equal(sx.convertedCoins, big(conv.args.coins[1]));
  assert.equal(sx.convertedNative, big(conv.args.native[1]));
  assert.equal(sx.bookedCoins, xSell.routerCoins, "booked exactly what the plugin booked");
  // Y converts in full: its sell is converted whole, the 29-coin surplus of its collect brings the 1 wei of router post
  const ySell = sells.find((s) => s.token === Y)!;
  const sy = a.sells.get(`${ySell.txHash}:${ySell.logIndex}`)!;
  assert.equal(sy.convertedCoins, sy.bookedCoins);
  assert.equal(sy.remainingCoins, 0n);
  const yConv = logArgs("CoinFeesConverted", Y)[0];
  const ySurplus = a.credits.filter((c) => c.txHash === lc(yConv.transactionHash) && c.book === "router_post");
  assert.equal(ySurplus.length, 1);
  assert.equal(ySurplus[0]!.side, null, "surplus: no trader");
  assert.equal(ySurplus[0]!.coins, 29n);
  assert.equal(ySurplus[0]!.fee, 1n);
  // the remaining pending books equal the launcher's coinFees read-back after the conversions, book by book
  for (const coin of [fx.coins[0].coin, fx.coins[1].coin]) {
    assert.deepEqual(a.coinBooks.get(lc(coin))!.map(String), step("Y: convert").readBack.coins[coin].coinFees, `${coin} coin books`);
  }
});

test("pure attribution: the credits before the claim are exactly routerPaid (amount, bonding, graduation) once the graduation fee is added", () => {
  const { buys, sells, logs } = pureInputs();
  const a = barkAttribute({ buys, sells, logs });
  const grad = big(logArgs("GraduationFeeTaken")[0].args.amount);
  const paid = claimStep.readBack.routerPaid;
  assert.equal(sum(a.credits.map((c) => c.fee)) + grad, big(paid.amount));
  assert.equal(sum(a.credits.filter((c) => c.phase === "bonding").map((c) => c.fee)), big(paid.bondingFees));
  assert.equal(grad, big(paid.gradFees));
  assert.equal(big(paid.amount), big(RP.expectedPaid));
  assert.deepEqual([RP.pending.total, RP.pending.bondingFees, RP.pending.gradFees], [paid.amount, paid.bondingFees, paid.gradFees]);
});

test("credit slices: bonding credits take gen-8's percentages of the credited DOGE (B11); post credits are protocol", () => {
  const b = barkCreditSlices({ kind: "trade", phase: "bonding", profile: "og_linked", fee: 1_000_000n });
  assert.equal(b.leagueWeekly + b.leagueMonthly, 375_000n);
  assert.equal(b.fee, 1_000_000n);
  assert.equal(b.routerAmount, 1_000_000n);
  assert.equal(b.creatorShare, 0n);
  assert.equal(b.leagueWeekly + b.leagueMonthly + b.recruiter + b.squad + b.airdrop + b.protocol, 1_000_000n);
  const p = barkCreditSlices({ kind: "trade", phase: "post", profile: null, fee: 777n });
  assert.deepEqual([p.leagueWeekly, p.leagueMonthly, p.recruiter, p.squad, p.airdrop, p.protocol], [0n, 0n, 0n, 0n, 0n, 777n]);
  // a profile-less bonding credit (a surplus; alerts, should never happen) is protocol only, as the aggregate rule sums it
  const s = barkCreditSlices({ kind: "trade", phase: "bonding", profile: null, fee: 555n });
  assert.deepEqual([s.leagueWeekly, s.leagueMonthly, s.recruiter, s.squad, s.airdrop, s.protocol], [0n, 0n, 0n, 0n, 0n, 555n]);
});

// ------------------------------------------------------------------ the real ingest + route pass on an in-memory DB

type Row = Record<string, any>;
const pos = (r: Row) => [Number(r.block_number), Number(r.log_index)] as const;
const before = (r: Row, b: number, l: number, incl = false) => Number(r.block_number) < b || (Number(r.block_number) === b && (incl ? Number(r.log_index) <= l : Number(r.log_index) < l));
const byPos = (a: Row, b: Row) => pos(a)[0] - pos(b)[0] || pos(a)[1] - pos(b)[1];

/**
 * FakeGen8Db (which already keeps the accruals, sell fees and contract events the replay reads) plus the sell-state
 * updates, the credits, the route runs and the RouterClaimed read of the route pass.
 */
class MoneyDb extends FakeGen8Db {
  credits: Row[] = [];
  runs: Row[] = [];
  private seq = 0;
  get accruals() {
    return this.barkReplay.accruals;
  }
  get sellFees() {
    return this.barkReplay.sells;
  }

  override async query(sqlIn: string, params: unknown[] = []) {
    const sql = sqlIn.replace(/\s+/g, " ").trim();
    const p = params as any[];
    const done = (rows: any[]) => ({ rows, rowCount: rows.length });
    if (sql.startsWith("update public.evm_gen8_bark_sell_fees set")) {
      const r = this.sellFees.find((x) => x.chain_id === p[0] && x.tx_hash === p[1] && x.log_index === p[2]);
      if (r) Object.assign(r, { booked_coins: p[3], collect_tx_hash: p[4], collect_log_index: p[5], converted_coins: p[6], converted_native: p[7] });
      return done([]);
    }
    if (sql.startsWith("insert into public.evm_gen8_bark_credits(")) {
      const cols = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(",").map((c) => c.trim());
      const row = Object.fromEntries(cols.map((c, i) => [c, p[i]]));
      const key = (r: Row) => [r.tx_hash, r.log_index, r.book, r.source_tx_hash, r.source_log_index].join(":");
      if (!this.credits.some((r) => key(r) === key(row))) this.credits.push({ ...row, id: ++this.seq, run_id: null });
      return done([]);
    }
    if (sql.startsWith("insert into public.evm_gen8_route_runs(")) {
      const existing = this.runs.find((r) => r.run_id === Number(p[2]));
      const confirmed = sql.includes("'confirmed'");
      const row = confirmed
        ? { run_id: Number(p[2]), status: "confirmed", total: p[3], bonding_fees: p[4], grad_fees: p[5], weekly_league: p[6], monthly_league: p[7], recruiter: p[8], squad: p[9], airdrop: p[10], protocol: p[11], accrual_root: p[12], tx_hash: p[13], caller: p[16] }
        : { run_id: Number(p[2]), status: p[3], plan_block: p[4], total: p[5], bonding_fees: p[6], grad_fees: p[7], weekly_league: p[8], monthly_league: p[9], recruiter: p[10], squad: p[11], airdrop: p[12], protocol: p[13], rounding_airdrop: p[14], accrual_root: p[16], leaf_count: p[17], leaves: JSON.parse(String(p[18])), tx_hash: p[19], caller: p[20] };
      if (existing) Object.assign(existing, row);
      else this.runs.push(row);
      return done([]);
    }
    // reads
    if (sql.startsWith("select block_number, log_index, tx_hash, args from public.evm_campaign_events")) {
      return done(this.barkReplay.events.filter((r) => r.chain_id === p[0] && r.contract_address === p[1] && r.event_name === "RouterClaimed" && lc(r.args.router) === p[2] && (p[3] === null || r.block_number <= p[3])).sort(byPos));
    }
    if (sql.startsWith("select id, source_tx_hash as tx_hash")) {
      return done(this.credits.filter((r) => r.chain_id === p[0] && r.hook_address === p[1] && r.run_id === null && before(r, p[2], p[3]))
        .sort((a, b) => byPos(a, b) || a.id - b.id)
        .map((r) => ({ ...r, tx_hash: r.source_tx_hash, log_index: r.source_log_index })));
    }
    if (sql.startsWith("select 1 from public.evm_gen8_bark_credits where")) {
      return done(this.credits.filter((r) => r.chain_id === p[0] && r.hook_address === p[1] && r.run_id === p[2]).slice(0, 1).map(() => ({ "?column?": 1 })));
    }
    if (sql.startsWith("update public.evm_gen8_bark_credits set run_id")) {
      const r = this.credits.find((x) => x.id === p[0] && x.run_id === null);
      if (r) r.run_id = p[1];
      return done([]);
    }
    if (sql.startsWith("update public.evm_gen8_fee_accruals a set run_id")) {
      for (const c of this.credits.filter((x) => x.chain_id === p[0] && x.hook_address === p[1] && x.run_id === p[2])) {
        const a = this.accruals.find((x) => x.tx_hash === c.source_tx_hash && x.log_index === c.source_log_index && x.run_id === null);
        if (a) a.run_id = p[2];
      }
      return done([]);
    }
    if (sql.startsWith("select status, leaves, accrual_root")) return done(this.runs.filter((r) => r.run_id === Number(p[2])));
    if (sql.startsWith("select coalesce(sum(total), 0)::text as t from public.evm_gen8_route_runs")) {
      return done([{ t: String(sum(this.runs.filter((r) => r.status === "confirmed" && r.run_id <= Number(p[2])).map((r) => big(r.total)))) }]);
    }
    if (sql.startsWith("select coalesce(max(run_id), 0) as last")) return done([{ last: Math.max(0, ...this.runs.filter((r) => r.status === "confirmed").map((r) => r.run_id)) }]);
    return super.query(sqlIn, params);
  }
}

async function seedPools(db: MoneyDb) {
  for (const c of fx.coins) {
    await upsertGen8Pool(db, {
      chainId: DOGE, poolId: barkPoolId(c.pool), token: lc(c.coin), hook: C.MwzBarkPlugin, launcher: C.MwzBarkLauncher, poolManager: lc(c.pool), creator: lc(c.creator),
      hookCreator: lc(c.creator), creatorProfile: "standard_unlinked", feeChoice: 0, feeCreatorPct: 0, targetUsd: 150n, marketCapNative: 0n, virtualNative: 0n, virtualToken: 0n,
      tickStart: c.tickStart, tickGrad: c.tickGrad, liqA: big(c.liqA), liqB: big(c.liqB), fees: { bondingBps: 200, postBps: 100, creatorPostBps: 50, sniperStartBps: 9000, creatorBondingBps: 560 },
      display: null, firstBuyIn: null, firstBuyOut: null, launchTx: FIRST_BUY_TX, launchBlock: FIRST_BUY_BLOCK, launchTime: new Date(0), openAt: new Date(Number(c.openAt) * 1000), metadata: {},
    });
  }
  // X's launch-transaction first buy (before the recording; initialReadBack's plugin totals): its accrual row as the ingest writes it
  const row = { chain_id: DOGE, hook_address: C.MwzBarkPlugin, pool_id: barkPoolId(fx.coins[0].pool), token_address: X, tx_hash: FIRST_BUY_TX, log_index: 5, swap_log_index: 5, block_number: FIRST_BUY_BLOCK, block_time: new Date(0), kind: "trade", phase: "bonding", trader: lc(fx.coins[0].creator), swap_sender: C.MwzBarkLauncher, referrer: null, side: "buy", profile: "standard_unlinked", fee: String(XFIRST[0] + XFIRST[1]), creator_share: String(XFIRST[0]), router_amount: String(XFIRST[1]) };
  db.accruals.push({ ...row, id: 0, run_id: null });
}

function moneyCtx(db: MoneyDb, calls: SinkCall[]) {
  const logs = recordedLogs();
  const txs = new Map<string, { from: string; to: string | null }>(logs.map((l) => [lc(l.transactionHash), { from: l.txFrom, to: null }]));
  const times = new Map(logs.map((l) => [l.blockNumber, l.blockTimestamp]));
  const last = Math.max(...logs.map((l) => l.blockNumber));
  const provider = new FakeGen8Provider(logs, last + 30, txs, (n) => times.get(n) ?? 1_791_990_000 + n - 8578700);
  return { cfg, db, provider, sinks: fakeGen8Sinks(calls), env: { ...env, EVM_GEN8_CONFIRMATIONS: "0" } };
}

function fakeRouteChain(readBack: any, head: number): Gen8RouteChain & { claims: number } {
  const chain = {
    claims: 0,
    async readState() {
      return {
        runs: big(readBack.splitterRouted.runs), paid: big(readBack.routerPaid.amount), pendingTotal: big(readBack.splitterPending.total),
        pendingBonding: big(readBack.splitterPending.bondingFees), pendingGrad: big(readBack.splitterPending.gradFees), routerOwed: big(readBack.routerOwed),
        parked: 0n, parkedOwed: big(readBack.parkedOwed), treasuryRouter: C.MwzBarkFeeSplitter, operator: lc(fx.steps.at(-1).from),
        bands: async (b: bigint, g: bigint) => splitterBands(b, g),
      };
    },
    async sendClaim() {
      chain.claims += 1;
      return { hash: "0x", blockNumber: 0 };
    },
    async sendRoute() {
      throw new Error("dry run only");
    },
    async waitReceipt() {
      return null;
    },
    headBlock: async () => head,
  };
  return chain;
}

const CLAIM_BLOCK = Number(claimStep.blockNumber);
const LAST_BLOCK = Math.max(...recordedLogs().map((l) => l.blockNumber));
const activityMarks = (calls: SinkCall[]) => calls.filter((c) => c.name === "recordTradeActivity").length;
const alertKinds = (calls: SinkCall[]) => calls.filter((c) => c.name === "raiseAlert").map((c) => (c.args[0] as any).kind as string);

/** Money ingest up to the claim, then the route pass's dry-run plan of run 1. */
async function ingestAndPlan() {
  const db = new MoneyDb();
  const calls: SinkCall[] = [];
  await seedPools(db);
  const ctx = moneyCtx(db, calls);
  await ingestGen8BarkRange(ctx, 8578740, CLAIM_BLOCK, "money");
  db.cursors.set(`${DOGE}:gen8-money:${C.MwzBarkPlugin}`, CLAIM_BLOCK + 1);
  const pass = await runGen8RoutePass({ db, cfg, chain: fakeRouteChain(claimStep.readBack, CLAIM_BLOCK + 30), send: false, alert: async (a) => void calls.push({ name: "alert", args: [a] }) });
  return { db, calls, ctx, pass, plan: db.runs.find((r) => r.run_id === 1)! };
}

test("ingest + route pass: the operator's plan from the credits matches routerPaid and pending() to the wei; Routed assigns every credit", async () => {
  const db = new MoneyDb();
  const calls: SinkCall[] = [];
  await seedPools(db);
  const ctx = moneyCtx(db, calls);
  const claimBlock = CLAIM_BLOCK;
  await ingestGen8BarkRange(ctx, 8578740, claimBlock, "money");

  // sell rows at the swap with their coin fee and an expected value; no accrual row for a sell
  const sellLogs = logArgs("BarkSwap").filter((l: any) => l.args.buy === false && l.args.kind === "0");
  assert.equal(db.sellFees.length, sellLogs.length);
  for (const l of sellLogs) {
    const r = db.sellFees.find((x) => x.tx_hash === lc(l.transactionHash))!;
    assert.equal(r.router_coins, String(big(l.args.netFee) - big(l.args.creatorAmount)));
    assert.equal(r.net_fee_coins, l.args.netFee);
    assert.ok(big(r.expected_native) > 0n, "expected value at the fill price");
    assert.ok(!db.accruals.some((a) => a.tx_hash === lc(l.transactionHash)));
  }
  // the credits up to the claim are routerPaid, the graduation fee included
  const paid = claimStep.readBack.routerPaid;
  assert.equal(sum(db.credits.map((c) => big(c.fee))), big(paid.amount));
  assert.equal(sum(db.credits.filter((c) => c.kind === "trade" && c.phase === "bonding").map((c) => big(c.fee))), big(paid.bondingFees));
  assert.equal(sum(db.credits.filter((c) => c.kind === "graduation").map((c) => big(c.fee))), big(paid.gradFees));
  assert.ok(!calls.some((c) => c.name === "raiseAlert"), JSON.stringify(calls.filter((c) => c.name === "raiseAlert")));
  // every non-buyback trade marked once (buys and sells; the conversions are not trades)
  const marks = activityMarks(calls);
  assert.equal(marks, logArgs("BarkSwap").filter((l: any) => l.args.kind === "0").length);
  // re-running the range writes nothing new (idempotent): same credits, same sell states, no second activity mark
  const credits = JSON.stringify(db.credits);
  const sellStates = JSON.stringify(db.sellFees);
  assert.ok(db.sellFees.every((r) => r.booked_coins !== null && big(r.converted_coins) > 0n && big(r.converted_native) > 0n), "every sell booked and (partly) converted");
  await ingestGen8BarkRange(ctx, 8578740, claimBlock, "money");
  assert.equal(JSON.stringify(db.credits), credits);
  assert.equal(JSON.stringify(db.sellFees), sellStates, "sell states restated to the same absolute values");
  assert.equal(activityMarks(calls), marks, "a second money pass over the same range does not count a trade again");

  // the route pass plans run 1 against expectedPaid = routerPaid(splitter).amount
  db.cursors.set(`${DOGE}:gen8-money:${C.MwzBarkPlugin}`, claimBlock + 1);
  const pass = await runGen8RoutePass({ db, cfg, chain: fakeRouteChain(claimStep.readBack, claimBlock + 30), send: false, alert: async (a) => void calls.push({ name: "alert", args: [a] }) });
  assert.equal(pass.status, "planned", JSON.stringify(pass));
  if (pass.status !== "planned") return;
  assert.equal(pass.expectedPaid, RP.expectedPaid);
  assert.deepEqual([pass.total, pass.bondingFees, pass.gradFees], [RP.pending.total, RP.pending.bondingFees, RP.pending.gradFees]);
  const bands = splitterBands(big(RP.pending.bondingFees), big(RP.pending.gradFees));
  assert.deepEqual(Object.fromEntries(Object.entries(bands).map(([k, v]) => [k, String(v)])), RP.bands, "local bands = the recorded splitter's bands(B, G)");
  const rsa = big(pass.recruiter) + big(pass.squad) + big(pass.airdrop);
  assert.ok(rsa >= bands.rsaMin && rsa <= bands.rsaMax, "inside the splitter's band: route() would not revert OutOfBand");
  assert.ok(big(pass.squad) <= bands.squadMax);
  const plan = db.runs.find((r) => r.run_id === 1)!;
  assert.equal(plan.status, "dry_run");
  assert.equal(big(plan.total) - big(plan.weekly_league) - big(plan.monthly_league) - rsa, big(plan.protocol));
  assert.equal(plan.leaf_count, db.credits.length + 1, "one leaf per credit plus the totals leaf");

  // the recorded Routed (run 1): every credit and every covered buy / graduation accrual gets run 1, no mismatch
  await ingestGen8BarkRange(ctx, claimBlock + 1, Math.max(...recordedLogs().map((l) => l.blockNumber)), "money");
  assert.ok(db.credits.every((c) => c.run_id === 1), "every credit routed in run 1");
  assert.ok(db.accruals.every((a) => a.run_id === 1), "every buy and the graduation fee covered by run 1");
  const alerts = calls.filter((c) => c.name === "raiseAlert").map((c) => (c.args[0] as any).kind);
  assert.ok(!alerts.includes("gen8_run_rows_mismatch") && !alerts.includes("gen8_run_without_claim"), alerts.join(","));
  // the fork test's operator routed at the top of the band (not the aggregate rule), so the plan comparison reports it
  assert.ok(alerts.includes("gen8_routed_differs_from_plan"));
  const confirmed = db.runs.find((r) => r.run_id === 1)!;
  assert.equal(confirmed.status, "confirmed");
  assert.deepEqual([confirmed.total, confirmed.bonding_fees, confirmed.grad_fees], [plan.total, plan.bonding_fees, plan.grad_fees]);
  assert.deepEqual([confirmed.weekly_league, confirmed.monthly_league], [plan.weekly_league, plan.monthly_league]);

  // a re-scan of the confirmed Routed (crash mid-range, backfill rewind) is skipped: no false mismatch, nothing moves
  const before = alertKinds(calls).length;
  await ingestGen8BarkRange(ctx, claimBlock + 1, LAST_BLOCK, "money");
  assert.deepEqual(alertKinds(calls).slice(before).filter((k) => k.startsWith("gen8_run")), []);
  assert.ok(db.credits.every((c) => c.run_id === 1));
});

test("Routed equal to our plan: the covered rows match the planned leaves as (key, fee) multisets; one moved wei is caught", async () => {
  for (const tamper of [false, true]) {
    const { db, calls, plan } = await ingestAndPlan();
    if (tamper) {
      // same keys, same sums (B, G, T unchanged), but 1 wei moved between two bonding credits: only a multiset of
      // (key, fee) sees it (a deduplicated key set would not)
      const [a, b] = db.credits.filter((c) => c.kind === "trade" && c.phase === "bonding" && big(c.fee) > 0n);
      a!.fee = String(big(a!.fee) - 1n);
      b!.fee = String(big(b!.fee) + 1n);
    }
    const claim = logArgs("RouterClaimed")[0];
    const caller = lc(fx.steps.at(-1).from);
    await recordRoutedRun(db, cfg, {
      kind: "Routed", address: C.MwzBarkFeeSplitter, blockNumber: LAST_BLOCK, txHash: `0x${"9a".repeat(32)}`, logIndex: 2, runId: 1n, accrualRoot: plan.accrual_root, caller,
      run: { total: big(plan.total), bondingFees: big(plan.bonding_fees), gradFees: big(plan.grad_fees), weeklyLeague: big(plan.weekly_league), monthlyLeague: big(plan.monthly_league), recruiter: big(plan.recruiter), squad: big(plan.squad), airdrop: big(plan.airdrop), protocol: big(plan.protocol) },
    }, new Date(), async (x) => void calls.push({ name: "raiseAlert", args: [x] }), { [`EVM_GEN8_ROUTER_CLAIMERS_${DOGE}`]: caller });
    assert.equal(big(claim.args.amount), big(plan.total));
    const kinds = alertKinds(calls);
    if (tamper) assert.deepEqual(kinds, ["gen8_run_rows_mismatch"]);
    else assert.deepEqual(kinds, [], "a Routed that is exactly our plan raises nothing");
    assert.ok(db.credits.every((c) => c.run_id === 1));
  }
});

test("a FeesCollected that the indexed rows cannot explain raises a critical attribution alert", async () => {
  const db = new MoneyDb();
  const calls: SinkCall[] = [];
  await seedPools(db);
  const ctx = moneyCtx(db, calls);
  const collect = logArgs("FeesCollected", X)[0];
  await ingestGen8BarkRange(ctx, 8578740, collect.blockNumber - 1, "money");
  // the recorded collect, with 5 wei more booked to router bonding than the buys before it add up to
  const native = big(collect.args.native) + 5n;
  const nativeBooks = collect.args.nativeBooks.map(big);
  nativeBooks[1] += 5n;
  const pool = { poolId: barkPoolId(fx.coins[0].pool), token: X };
  await applyBarkAttributionAt(db, cfg, pool, { kind: "collect", coin: X, txHash: lc(collect.transactionHash), logIndex: collect.logIndex, blockNumber: collect.blockNumber, blockTime: new Date(), native, coins: big(collect.args.coins), nativeBooks, coinBooks: collect.args.coinBooks.map(big) }, async (a) => void calls.push({ name: "raiseAlert", args: [a] }));
  const alerts = calls.filter((c) => c.name === "raiseAlert").map((c) => c.args[0] as any);
  assert.equal(alerts.length, 2, "apportion differs, and router bonding WDOGE above the indexed buys");
  assert.ok(alerts.every((a) => a.kind === "gen8_bark_attribution_mismatch" && a.severity === "critical"));
  // the credits still add up to the book (the surplus is a credit of its own), so a run stays exact
  const atLog = db.credits.filter((c) => c.tx_hash === lc(collect.transactionHash) && c.book === "router_bonding");
  assert.equal(sum(atLog.map((c) => big(c.fee))), nativeBooks[1]);
});

test("sell backfill: the money cursor goes back to the start block once; trades the old pass marked are not marked again", async () => {
  const db = new FakeGen8Db();
  const money = `${DOGE}:gen8-money:${C.MwzBarkPlugin}`;
  const marker = `${DOGE}:${GEN8_BARK_ATTRIBUTION_MARKER}:${C.MwzBarkPlugin}`;
  db.cursors.set(money, 8_600_000);
  assert.equal(await ensureBarkAttributionBackfill(db, cfg), 8_600_000, "activity is marked again only from where the old pass stopped");
  assert.equal(db.cursors.get(money), cfg.startBlock);
  assert.equal(db.cursors.get(marker), 8_600_000);
  db.cursors.set(money, 8_700_000);
  assert.equal(await ensureBarkAttributionBackfill(db, cfg), 8_600_000);
  assert.equal(db.cursors.get(money), 8_700_000, "only once");
  const fresh = new FakeGen8Db();
  assert.equal(await ensureBarkAttributionBackfill(fresh, cfg), cfg.startBlock);
  assert.equal(fresh.cursors.get(money), undefined, "a chain never indexed starts at its start block anyway");

  // the rewound pass: swaps below the boundary (already counted by the old pass) are not counted again, sells get rows
  const mdb = new MoneyDb();
  const calls: SinkCall[] = [];
  await seedPools(mdb);
  const boundary = Number(logArgs("BarkSwap", Y)[0].blockNumber);
  await ingestGen8BarkRange({ ...moneyCtx(mdb, calls), activityFromBlock: boundary } as any, 8578740, LAST_BLOCK, "money");
  const trades = logArgs("BarkSwap").filter((l: any) => l.args.kind === "0");
  assert.equal(activityMarks(calls), trades.filter((l: any) => l.blockNumber >= boundary).length);
  assert.equal(mdb.sellFees.length, trades.filter((l: any) => l.args.buy === false).length, "every sell has its row, below the boundary too");
});

test("route chain on Barkswap: reads routerPaid / routerOwed / parked from the launcher and sends claimRouter there with the operator key", async () => {
  const launcherAbi = JSON.parse(fs.readFileSync(path.join(ROOT, "contracts/dogeos/barkswap/abi/MwzBarkLauncher.abi.json"), "utf8"));
  const real = new ethers.Interface(launcherAbi.abi ?? launcherAbi);
  const ours = new ethers.Interface(BARK_LAUNCHER_ROUTER_FRAGMENTS as unknown as string[]);
  ours.forEachFunction((f) => assert.ok(real.getFunction(f.selector), `${f.format()} is a MwzBarkLauncher function`));
  const splitterAbi = JSON.parse(fs.readFileSync(path.join(ROOT, "contracts/dogeos/barkswap/abi/MwzBarkFeeSplitter.abi.json"), "utf8"));
  const splitterIface = new ethers.Interface(splitterAbi.abi ?? splitterAbi);
  const rb = claimStep.readBack;
  const answers: Record<string, () => string> = {
    [ours.getFunction("routerPaid")!.selector]: () => ours.encodeFunctionResult("routerPaid", [rb.routerPaid.amount, rb.routerPaid.bondingFees, rb.routerPaid.gradFees]),
    [ours.getFunction("routerOwed")!.selector]: () => ours.encodeFunctionResult("routerOwed", [rb.routerOwed]),
    [ours.getFunction("treasuryRouter")!.selector]: () => ours.encodeFunctionResult("treasuryRouter", [C.MwzBarkFeeSplitter]),
    [ours.getFunction("routerParked")!.selector]: () => ours.encodeFunctionResult("routerParked", [0, 0, 0]),
    [ours.getFunction("parkedOwed")!.selector]: () => ours.encodeFunctionResult("parkedOwed", [0]),
    [splitterIface.getFunction("runs")!.selector]: () => splitterIface.encodeFunctionResult("runs", [0]),
    [splitterIface.getFunction("pending")!.selector]: () => splitterIface.encodeFunctionResult("pending", [rb.splitterPending.total, rb.splitterPending.bondingFees, rb.splitterPending.gradFees]),
    [splitterIface.getFunction("operator")!.selector]: () => splitterIface.encodeFunctionResult("operator", [fx.steps.at(-1).from]),
  };
  const seen: string[] = [];
  const provider = new ethers.JsonRpcProvider("http://127.0.0.1:1", DOGE, { staticNetwork: true });
  const answer = async (tx: { to: string; data: string }) => {
    seen.push(`${lc(tx.to)}:${tx.data.slice(0, 10)}`);
    const a = answers[tx.data.slice(0, 10)];
    if (!a) throw new Error(`unexpected call ${tx.data.slice(0, 10)}`);
    return a();
  };
  // no RPC: eth_call is answered here (ethers v6 AbstractProvider routes every call through _perform)
  (provider as any)._perform = async (req: { method: string; transaction?: any }) => {
    if (req.method === "call") return answer(req.transaction);
    if (req.method === "getBlockNumber") return "0x9";
    if (req.method === "getTransactionReceipt") {
      return {
        transactionHash: `0x${"ab".repeat(32)}`, blockHash: `0x${"cd".repeat(32)}`, blockNumber: "0x9", transactionIndex: "0x0", from: lc(fx.steps.at(-1).from), to: C.MwzBarkLauncher,
        contractAddress: null, gasUsed: "0x1", cumulativeGasUsed: "0x1", effectiveGasPrice: "0x1", logsBloom: `0x${"00".repeat(256)}`, logs: [], status: "0x1", type: "0x2",
      };
    }
    throw new Error(`unexpected RPC ${req.method}`);
  };
  const sent: Array<{ to: string; data: string }> = [];
  const signer = {
    provider,
    getAddress: async () => lc(fx.steps.at(-1).from),
    call: (tx: any) => answer(tx),
    estimateGas: async () => 100_000n,
    resolveName: async (n: string) => n,
    sendTransaction: async (tx: any) => {
      sent.push({ to: lc(tx.to), data: tx.data });
      return new ethers.TransactionResponse({ ...tx, hash: `0x${"ab".repeat(32)}`, blockNumber: null, blockHash: null, index: 0, type: 2, from: lc(fx.steps.at(-1).from), nonce: 0, gasLimit: 100_000n, gasPrice: 1n, maxPriorityFeePerGas: 1n, maxFeePerGas: 1n, maxFeePerBlobGas: null, value: 0n, chainId: BigInt(DOGE), signature: ethers.Signature.from(`0x${"11".repeat(64)}1b`), accessList: [], blobVersionedHashes: null, authorizationList: null } as any, provider);
    },
  } as unknown as ethers.Signer;
  const chain = ethersRouteChain(cfg, provider, signer);
  const s = await chain.readState(100);
  assert.equal(s.paid, big(rb.routerPaid.amount));
  assert.equal(s.treasuryRouter, C.MwzBarkFeeSplitter);
  for (const sel of ["routerPaid", "routerOwed", "treasuryRouter", "routerParked", "parkedOwed"].map((n) => ours.getFunction(n)!.selector)) {
    assert.ok(seen.includes(`${C.MwzBarkLauncher}:${sel}`), `${sel} read from the launcher`);
  }
  await chain.sendClaim();
  assert.deepEqual(sent, [{ to: C.MwzBarkLauncher, data: ours.getFunction("claimRouter")!.selector }], "claimRouter on the launcher, from the operator signer");
});
