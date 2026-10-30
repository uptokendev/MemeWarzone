/**
 * Barkswap fee attribution (DogeOS 6281971; barkswap spec section 3 "Money flow" 1-5 and "Attribution for D1", B10,
 * B11): which swap every wei credited to the launcher's router bucket came from, so a route run's rows add up to
 * routerPaid to the wei.
 *
 * On V4 the hook credits the router bucket at the swap. On Barkswap fees accrue to our positions and reach the launcher
 * later, and a sell's fee is paid in coins:
 *   - collect(coin) (FeesCollected) books what the positions gave, per book [creator bonding, router bonding, creator
 *     post, router post] (MwzBarkFeeBooks.apportion over the plugin's per-book totals since the previous collect).
 *     WDOGE is credited now; coins wait in the pending coin books. Algebra rounds (a few wei / coin units either way);
 *     apportion puts the creators first (capped at their plugin amounts), router bonding at most its plugin amount,
 *     and any surplus or shortfall in router post.
 *   - convert(coin) (CoinFeesConverted) sells min(pending, cap) coins at 0 fee, drawing the same fraction
 *     coinsIn / pending from every pending book (MwzBarkFeeBooks.draw) and crediting each book's DOGE.
 *   - GraduationFeeTaken credits the graduation book.
 * So the money unit here is a CREDIT: the DOGE one launcher log credited to a router book, split by source swap:
 *   - buys are final at the swap (their accrual row, evm_gen8_fee_accruals, written by evmGen8Bark.ts); the collect
 *     that covers them credits each its plugin router amount; a shortfall comes off the latest covered rows (never
 *     below 0), a router-post surplus is a credit of its own (no trader, protocol);
 *   - a sell's row (evm_gen8_bark_sell_fees) is written at the swap with its coin fee and an expected value (fill
 *     price, display only). Its collect books its router coins (shortfall off the latest, router-post surplus as a
 *     pending entry of its own); each conversion then converts every pending entry of a router book by that book's
 *     draw fraction and values it at that book's DOGE (the conversion's average price): one credit per entry and
 *     conversion. A sell is routable only for what is converted; the remainder counts when (and in the epoch in
 *     which) it converts: a credit's block_time is its conversion's.
 * Per log, the credits of each router book add up to that log's book amount exactly; leftovers of the floors go to the
 * latest entries, as in the contract. The replay also re-runs the contract's apportion and draw on its own state and
 * reports any difference (an anomaly: a missing row or a contract change; it should never happen).
 *
 * B11 (decision, t19): a credit's fee IS its slice base, the net DOGE credited to the router bucket; bonding credits
 * take gen-8's league / recruiter / squad / airdrop bps of it, post-graduation credits are protocol, the graduation fee
 * takes the graduation bps. MwzBarkFeeSplitter.bands(B, G) read B = the router bonding book = the sum of the bonding
 * credits, so a run planned from the credits (evmGen8FeeRouting.ts, aggregate rule) is inside the bands and matches
 * expectedPaid, B and G exactly. The swap-time accrual rows of buys take the same base (evmGen8Fees.ts
 * gen8RouterBaseSlices) for reward_events.
 *
 * Idempotency: the replay is a pure function of rows written at or below the money head (buys, sells, the launcher's
 * FeesCollected / CoinFeesConverted in evm_campaign_events), so a re-scanned range writes the same credits (insert on
 * conflict do nothing) and the same absolute sell states.
 */
import { gen8GraduationSlices, gen8TradeSlices, type Gen8Profile, type Gen8Slices } from "./evmGen8Fees.js";
import type { Gen8BarkChainConfig } from "./evmGen8Config.js";
import type { Gen8PoolRow, Queryable } from "./evmGen8Store.js";

export type BarkPhase = "bonding" | "post";
export type BarkRouterBook = "router_bonding" | "router_post";
export type BarkBook = BarkRouterBook | "graduation";

type SourceBase = { token: string; txHash: string; logIndex: number; blockNumber: number; phase: BarkPhase; trader: string | null; swapSender: string | null; profile: Gen8Profile | null };
/** A buy's accrual row: router = net fee - creator amount (WDOGE wei), what the plugin booked to the router book. */
export type BarkBuySource = SourceBase & { router: bigint; creator: bigint };
/** A sell's row: router coins = net fee - creator amount (coin units). */
export type BarkSellSource = SourceBase & { routerCoins: bigint; creatorCoins: bigint };

type LogPos = { txHash: string; logIndex: number; blockNumber: number; blockTime: Date };
export type BarkCollectLog = LogPos & { kind: "collect"; coin: string; native: bigint; coins: bigint; nativeBooks: bigint[]; coinBooks: bigint[] };
export type BarkConvertLog = LogPos & { kind: "convert"; coin: string; pending: bigint; coinsIn: bigint; nativeOut: bigint; coins: bigint[]; native: bigint[] };
export type BarkMoneyLog = BarkCollectLog | BarkConvertLog;

export type BarkCredit = {
  token: string;
  /** The crediting launcher log. */
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTime: Date;
  creditKind: "collect" | "convert";
  book: BarkRouterBook;
  /** The swap whose fee it is; for a surplus the log that produced it (the collect, or this log). */
  sourceTxHash: string;
  sourceLogIndex: number;
  kind: "trade";
  phase: BarkPhase;
  side: "buy" | "sell" | null;
  trader: string | null;
  swapSender: string | null;
  profile: Gen8Profile | null;
  /** convert: coins drawn from the source's pending entry. */
  coins: bigint;
  /** DOGE wei credited (the slice base, B11). */
  fee: bigint;
  /** convert: the entry's pending coins before this conversion (0 for collect credits). */
  sourcePendingBefore: bigint;
};

export type BarkSellState = { bookedCoins: bigint | null; collectTxHash: string | null; collectLogIndex: number | null; convertedCoins: bigint; convertedNative: bigint; remainingCoins: bigint; changedAt: string[] };
export type BarkAnomaly = { txHash: string; logIndex: number; message: string };
export type BarkAttribution = {
  credits: BarkCredit[];
  /** Sell states by `${txHash}:${logIndex}`. */
  sells: Map<string, BarkSellState>;
  /** Per coin, the pending coin books after the replay, in MwzBarkFeeBooks order. */
  coinBooks: Map<string, bigint[]>;
  anomalies: BarkAnomaly[];
};

const ROUTER_BOOKS: Array<{ i: 1 | 3; book: BarkRouterBook; phase: BarkPhase }> = [
  { i: 1, book: "router_bonding", phase: "bonding" },
  { i: 3, book: "router_post", phase: "post" },
];

// ------------------------------------------------------------------ the contract's book maths (MwzBarkFeeBooks.sol)

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
const mulDiv = (a: bigint, b: bigint, d: bigint) => (a * b) / d;

/** MwzBarkFeeBooks.apportion, integer for integer. */
export function barkApportion(amount: bigint, d: bigint[]): bigint[] {
  const b = [0n, 0n, 0n, 0n];
  let rest = amount;
  b[0] = d[0]! < rest ? d[0]! : rest;
  rest -= b[0];
  b[2] = d[2]! < rest ? d[2]! : rest;
  rest -= b[2];
  const dR = d[1]! + d[3]!;
  b[1] = rest >= dR ? d[1]! : mulDiv(rest, d[1]!, dR);
  b[3] = rest - b[1];
  return b;
}

/** MwzBarkFeeBooks.draw, integer for integer. */
export function barkDraw(books: bigint[], used: bigint, pending: bigint, out: bigint): { taken: bigint[]; got: bigint[] } {
  const taken = books.map((x) => (used === pending ? x : mulDiv(x, used, pending)));
  let left = used - sum(taken);
  for (let i = 3; left !== 0n && i >= 0; i -= 1) {
    const room = books[i]! - taken[i]!;
    const add = room < left ? room : left;
    taken[i] = taken[i]! + add;
    left -= add;
  }
  const got = [0n, 0n, 0n, 0n];
  if (used !== 0n) for (let i = 0; i < 4; i += 1) got[i] = mulDiv(out, taken[i]!, used);
  got[3] = got[3]! + (out - sum(got));
  return { taken, got };
}

/** `total` over `amounts` (each capped at its amount): a shortfall comes off the latest, a surplus is returned. */
function coverLatestFirst(amounts: bigint[], total: bigint): { out: bigint[]; surplus: bigint } {
  const out = [...amounts];
  const s = sum(amounts);
  if (total >= s) return { out, surplus: total - s };
  let short = s - total;
  for (let i = out.length - 1; i >= 0 && short > 0n; i -= 1) {
    const take = out[i]! < short ? out[i]! : short;
    out[i] = out[i]! - take;
    short -= take;
  }
  return { out, surplus: 0n };
}

/** `total` pro rata to `weights` (floor), the leftover one unit at a time to the latest entries with weight. */
function proRataLatestFirst(weights: bigint[], total: bigint, caps?: bigint[]): bigint[] {
  const W = sum(weights);
  if (W === 0n) return weights.map(() => 0n);
  const out = weights.map((w) => (total === W ? w : mulDiv(w, total, W)));
  let left = total - sum(out);
  if (caps) {
    // coins: never more than an entry holds (the contract's draw: room = book - taken)
    for (let i = out.length - 1; i >= 0 && left > 0n; i -= 1) {
      const room = caps[i]! - out[i]!;
      const add = room < left ? room : left;
      out[i] = out[i]! + add;
      left -= add;
    }
    return out;
  }
  while (left > 0n) {
    let moved = false;
    for (let i = out.length - 1; i >= 0 && left > 0n; i -= 1) {
      if (weights[i]! === 0n) continue;
      out[i] = out[i]! + 1n;
      left -= 1n;
      moved = true;
    }
    if (!moved) break;
  }
  return out;
}

// ------------------------------------------------------------------ the replay

type Entry = { key: string; sell: BarkSellSource | null; sourceTxHash: string; sourceLogIndex: number; remaining: bigint };
type CoinState = {
  buys: Record<1 | 3, BarkBuySource[]>;
  sells: Record<1 | 3, BarkSellSource[]>;
  /** the plugin's per-book totals booked since the last collect, as the rows give them (MwzBarkFeeBooks order) */
  dN: bigint[];
  dC: bigint[];
  entries: Record<1 | 3, Entry[]>;
  creatorCoins: [bigint, bigint];
};

const posKey = (txHash: string, logIndex: number) => `${txHash}:${logIndex}`;

function cmpPos(a: { blockNumber: number; logIndex: number }, b: { blockNumber: number; logIndex: number }) {
  return a.blockNumber - b.blockNumber || a.logIndex - b.logIndex;
}

/**
 * Replays one or more coins' money history (rows and launcher logs, any order; sorted here by block and log index)
 * and returns every router credit, the sells' conversion states, the pending coin books and any anomaly.
 */
export function barkAttribute(input: { buys: BarkBuySource[]; sells: BarkSellSource[]; logs: BarkMoneyLog[] }): BarkAttribution {
  type Item = { t: "buy"; v: BarkBuySource } | { t: "sell"; v: BarkSellSource } | { t: "log"; v: BarkMoneyLog };
  const items: Item[] = [
    ...input.buys.map((v) => ({ t: "buy" as const, v })),
    ...input.sells.map((v) => ({ t: "sell" as const, v })),
    ...input.logs.map((v) => ({ t: "log" as const, v })),
  ].sort((a, b) => cmpPos(a.v, b.v));
  const coins = new Map<string, CoinState>();
  const stateOf = (token: string) => {
    let s = coins.get(token);
    if (!s) {
      s = { buys: { 1: [], 3: [] }, sells: { 1: [], 3: [] }, dN: [0n, 0n, 0n, 0n], dC: [0n, 0n, 0n, 0n], entries: { 1: [], 3: [] }, creatorCoins: [0n, 0n] };
      coins.set(token, s);
    }
    return s;
  };
  const credits: BarkCredit[] = [];
  const sells = new Map<string, BarkSellState>();
  const anomalies: BarkAnomaly[] = [];
  const anomaly = (l: LogPos, message: string) => anomalies.push({ txHash: l.txHash, logIndex: l.logIndex, message });

  for (const it of items) {
    if (it.t === "buy") {
      const s = stateOf(it.v.token);
      const post = it.v.phase === "post";
      s.buys[post ? 3 : 1].push(it.v);
      s.dN[post ? 2 : 0] = s.dN[post ? 2 : 0]! + it.v.creator;
      s.dN[post ? 3 : 1] = s.dN[post ? 3 : 1]! + it.v.router;
      continue;
    }
    if (it.t === "sell") {
      const s = stateOf(it.v.token);
      const post = it.v.phase === "post";
      s.sells[post ? 3 : 1].push(it.v);
      s.dC[post ? 2 : 0] = s.dC[post ? 2 : 0]! + it.v.creatorCoins;
      s.dC[post ? 3 : 1] = s.dC[post ? 3 : 1]! + it.v.routerCoins;
      sells.set(posKey(it.v.txHash, it.v.logIndex), { bookedCoins: null, collectTxHash: null, collectLogIndex: null, convertedCoins: 0n, convertedNative: 0n, remainingCoins: 0n, changedAt: [] });
      continue;
    }
    const l = it.v;
    const s = stateOf(l.coin);
    const at = posKey(l.txHash, l.logIndex);
    const credit = (c: Omit<BarkCredit, "token" | "txHash" | "logIndex" | "blockNumber" | "blockTime" | "kind">) =>
      credits.push({ token: l.coin, txHash: l.txHash, logIndex: l.logIndex, blockNumber: l.blockNumber, blockTime: l.blockTime, kind: "trade", ...c });

    if (l.kind === "collect") {
      // the contract books apportion(received, plugin totals since the last collect); the rows give those totals
      const wantN = barkApportion(l.native, s.dN);
      const wantC = barkApportion(l.coins, s.dC);
      if (wantN.some((x, i) => x !== l.nativeBooks[i]) || wantC.some((x, i) => x !== l.coinBooks[i])) {
        anomaly(l, `FeesCollected books (native ${l.nativeBooks.join("/")}, coins ${l.coinBooks.join("/")}) differ from apportion over the indexed rows (native ${wantN.join("/")}, coins ${wantC.join("/")})`);
      }
      for (const { i, book, phase } of ROUTER_BOOKS) {
        // WDOGE: credited now, to the buys it covers
        const rows = s.buys[i];
        const n = coverLatestFirst(rows.map((r) => r.router), l.nativeBooks[i]!);
        rows.forEach((r, k) => credit({ creditKind: "collect", book, sourceTxHash: r.txHash, sourceLogIndex: r.logIndex, phase, side: "buy", trader: r.trader, swapSender: r.swapSender, profile: r.profile, coins: 0n, fee: n.out[k]!, sourcePendingBefore: 0n }));
        if (n.surplus > 0n) {
          if (i === 1) anomaly(l, `router bonding WDOGE above the indexed buys by ${n.surplus}`);
          credit({ creditKind: "collect", book, sourceTxHash: l.txHash, sourceLogIndex: l.logIndex, phase, side: null, trader: null, swapSender: null, profile: null, coins: 0n, fee: n.surplus, sourcePendingBefore: 0n });
        }
        s.buys[i] = [];
        // coins: booked to the sells they came from, pending until converted
        const sl = s.sells[i];
        const c = coverLatestFirst(sl.map((r) => r.routerCoins), l.coinBooks[i]!);
        sl.forEach((r, k) => {
          const st = sells.get(posKey(r.txHash, r.logIndex))!;
          Object.assign(st, { bookedCoins: c.out[k]!, collectTxHash: l.txHash, collectLogIndex: l.logIndex, remainingCoins: c.out[k]! });
          st.changedAt.push(at);
          if (c.out[k]! > 0n) s.entries[i].push({ key: posKey(r.txHash, r.logIndex), sell: r, sourceTxHash: r.txHash, sourceLogIndex: r.logIndex, remaining: c.out[k]! });
        });
        if (c.surplus > 0n) {
          if (i === 1) anomaly(l, `router bonding coins above the indexed sells by ${c.surplus}`);
          s.entries[i].push({ key: at, sell: null, sourceTxHash: l.txHash, sourceLogIndex: l.logIndex, remaining: c.surplus });
        }
        s.sells[i] = [];
      }
      s.creatorCoins = [s.creatorCoins[0] + l.coinBooks[0]!, s.creatorCoins[1] + l.coinBooks[2]!];
      s.dN = [0n, 0n, 0n, 0n];
      s.dC = [0n, 0n, 0n, 0n];
      continue;
    }

    // convert: the same fraction of every pending book; each entry's draw valued at its book's DOGE
    const books = [s.creatorCoins[0], sum(s.entries[1].map((e) => e.remaining)), s.creatorCoins[1], sum(s.entries[3].map((e) => e.remaining))];
    if (sum(books) !== l.pending) anomaly(l, `CoinFeesConverted pending ${l.pending}, indexed pending books ${books.join("/")}`);
    else {
      const want = barkDraw(books, l.coinsIn, l.pending, l.nativeOut);
      if (want.taken.some((x, i) => x !== l.coins[i]) || want.got.some((x, i) => x !== l.native[i])) {
        anomaly(l, `CoinFeesConverted books (coins ${l.coins.join("/")}, native ${l.native.join("/")}) differ from draw over the indexed books (coins ${want.taken.join("/")}, native ${want.got.join("/")})`);
      }
    }
    for (const { i, book, phase } of ROUTER_BOOKS) {
      const entries = s.entries[i];
      const taken = l.coins[i]!;
      const got = l.native[i]!;
      const held = sum(entries.map((e) => e.remaining));
      if (taken > held) anomaly(l, `${book}: ${taken} coins drawn, ${held} indexed`);
      const draws = proRataLatestFirst(entries.map((e) => e.remaining), taken > held ? held : taken, entries.map((e) => e.remaining));
      const values = proRataLatestFirst(draws, got);
      entries.forEach((e, k) => {
        if (draws[k]! === 0n && values[k]! === 0n) return;
        credit({
          creditKind: "convert", book, sourceTxHash: e.sourceTxHash, sourceLogIndex: e.sourceLogIndex, phase: e.sell ? e.sell.phase : phase, side: e.sell ? "sell" : null,
          trader: e.sell?.trader ?? null, swapSender: e.sell?.swapSender ?? null, profile: e.sell?.profile ?? null, coins: draws[k]!, fee: values[k]!, sourcePendingBefore: e.remaining,
        });
        e.remaining -= draws[k]!;
        if (e.sell) {
          const st = sells.get(e.key)!;
          st.convertedCoins += draws[k]!;
          st.convertedNative += values[k]!;
          st.remainingCoins = e.remaining;
          st.changedAt.push(at);
        }
      });
      const valued = sum(values);
      if (valued < got) {
        // DOGE with no coins drawn from this book (the contract's floor leftovers land in router post)
        if (i === 1) anomaly(l, `router bonding DOGE without coins drawn: ${got - valued}`);
        credit({ creditKind: "convert", book, sourceTxHash: l.txHash, sourceLogIndex: l.logIndex, phase, side: null, trader: null, swapSender: null, profile: null, coins: 0n, fee: got - valued, sourcePendingBefore: 0n });
      }
      s.entries[i] = entries.filter((e) => e.remaining > 0n);
    }
    s.creatorCoins = [s.creatorCoins[0] - l.coins[0]!, s.creatorCoins[1] - l.coins[2]!];
    if (s.creatorCoins[0] < 0n || s.creatorCoins[1] < 0n) {
      anomaly(l, "creator coin books below zero");
      s.creatorCoins = [s.creatorCoins[0] < 0n ? 0n : s.creatorCoins[0], s.creatorCoins[1] < 0n ? 0n : s.creatorCoins[1]];
    }
  }

  const coinBooks = new Map<string, bigint[]>();
  for (const [token, s] of coins) coinBooks.set(token, [s.creatorCoins[0], sum(s.entries[1].map((e) => e.remaining)), s.creatorCoins[1], sum(s.entries[3].map((e) => e.remaining))]);
  return { credits, sells, coinBooks, anomalies };
}

/**
 * The per-credit slices (B11): bonding on the credited DOGE by the source's profile, post = protocol, graduation bps.
 * A credit with no profile (a surplus: no trader; in the bonding book it should never happen and alerts) is protocol
 * only, like a post credit: the run's aggregate rule (addToSums) gives a profile-less row no recruiter / squad /
 * airdrop share either.
 */
export function barkCreditSlices(c: { kind: "trade" | "graduation"; phase: BarkPhase; profile: Gen8Profile | null; fee: bigint }): Gen8Slices {
  if (c.kind === "graduation") return gen8GraduationSlices({ gradFee: c.fee, profile: c.profile || "standard_unlinked" });
  return gen8TradeSlices({ fee: c.fee, creatorShare: 0n, graduated: c.phase === "post" || !c.profile, profile: c.profile || "standard_unlinked" });
}

const big = (v: unknown) => BigInt(String(v ?? "0"));
const bigs = (v: unknown) => Array.from((v ?? []) as ArrayLike<unknown>, big);

/** FeesCollected / CoinFeesConverted (decoded event or its evm_campaign_events args) as a replay log; null otherwise. */
export function barkMoneyLogFromEvent(eventName: string, a: Record<string, any>, pos: LogPos): BarkMoneyLog | null {
  const coin = String(a.coin ?? "").toLowerCase();
  if (eventName === "FeesCollected") return { ...pos, kind: "collect", coin, native: big(a.native), coins: big(a.coins), nativeBooks: bigs(a.nativeBooks), coinBooks: bigs(a.coinBooks) };
  if (eventName === "CoinFeesConverted") return { ...pos, kind: "convert", coin, pending: big(a.pending), coinsIn: big(a.coinsIn), nativeOut: big(a.nativeOut), coins: bigs(a.coins), native: bigs(a.native) };
  return null;
}

// ------------------------------------------------------------------ rows

export type BarkSellFeeRow = {
  chainId: number; hook: string; txHash: string; logIndex: number; poolId: string; token: string; blockNumber: number; blockTime: Date; phase: BarkPhase;
  trader: string | null; swapSender: string | null; profile: Gen8Profile | null;
  grossFeeCoins: bigint; netFeeCoins: bigint; creatorCoins: bigint; routerCoins: bigint; expectedNative: bigint;
};

/** A sell's row at the swap (idempotent on the swap log). Returns whether it is new (gates the activity counter). */
export async function insertBarkSellFee(db: Queryable, r: BarkSellFeeRow): Promise<boolean> {
  const res = await db.query(
    `insert into public.evm_gen8_bark_sell_fees(chain_id, hook_address, tx_hash, log_index, pool_id, token_address, block_number, block_time, phase, trader, swap_sender, profile, gross_fee_coins, net_fee_coins, creator_coins, router_coins, expected_native)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     on conflict (chain_id, tx_hash, log_index) do nothing
     returning 1`,
    [
      r.chainId, r.hook, r.txHash, r.logIndex, r.poolId, r.token, r.blockNumber, r.blockTime, r.phase, r.trader, r.swapSender, r.profile,
      r.grossFeeCoins.toString(), r.netFeeCoins.toString(), r.creatorCoins.toString(), r.routerCoins.toString(), r.expectedNative.toString(),
    ],
  );
  return (res.rowCount ?? res.rows.length) > 0;
}

type CreditRow = {
  chainId: number; hook: string; poolId: string; token: string; txHash: string; logIndex: number; blockNumber: number; blockTime: Date;
  creditKind: "collect" | "convert" | "graduation"; book: BarkBook; sourceTxHash: string; sourceLogIndex: number; kind: "trade" | "graduation"; phase: BarkPhase;
  side: "buy" | "sell" | null; trader: string | null; swapSender: string | null; profile: Gen8Profile | null; coins: bigint; fee: bigint;
};

async function insertCredit(db: Queryable, c: CreditRow) {
  const s = barkCreditSlices(c);
  await db.query(
    `insert into public.evm_gen8_bark_credits(chain_id, hook_address, pool_id, token_address, tx_hash, log_index, block_number, block_time, credit_kind, book, source_tx_hash, source_log_index, kind, phase, side, trader, swap_sender, profile, coins, fee, router_amount, league_weekly, league_monthly, recruiter, squad, airdrop, protocol)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
     on conflict (chain_id, tx_hash, log_index, book, source_tx_hash, source_log_index) do nothing`,
    [
      c.chainId, c.hook, c.poolId, c.token, c.txHash, c.logIndex, c.blockNumber, c.blockTime, c.creditKind, c.book, c.sourceTxHash, c.sourceLogIndex, c.kind, c.phase,
      c.side, c.trader, c.swapSender, c.profile, c.coins.toString(), s.fee.toString(), s.routerAmount.toString(), s.leagueWeekly.toString(), s.leagueMonthly.toString(),
      s.recruiter.toString(), s.squad.toString(), s.airdrop.toString(), s.protocol.toString(),
    ],
  );
}

/** GraduationFeeTaken: the whole amount to the graduation book (creator 0%), by the creator's profile stored at launch. */
export async function insertBarkGraduationCredit(db: Queryable, cfg: Gen8BarkChainConfig, pool: Pick<Gen8PoolRow, "poolId" | "token" | "creator">, g: { txHash: string; logIndex: number; blockNumber: number; amount: bigint }, at: Date, profile: Gen8Profile) {
  await insertCredit(db, {
    chainId: cfg.chainId, hook: cfg.plugin.address, poolId: pool.poolId, token: pool.token, txHash: g.txHash, logIndex: g.logIndex, blockNumber: g.blockNumber, blockTime: at,
    creditKind: "graduation", book: "graduation", sourceTxHash: g.txHash, sourceLogIndex: g.logIndex, kind: "graduation", phase: "bonding", side: null, trader: pool.creator,
    swapSender: null, profile, coins: 0n, fee: g.amount,
  });
}

type Alert = (a: { severity: "critical" | "warning" | "info"; kind: string; chainId: number; subject?: string; title: string; message: string }) => Promise<unknown>;

/**
 * The money pass at a FeesCollected / CoinFeesConverted (`log`) of `pool`'s coin: replays the coin's history (rows and
 * the earlier logs from evm_campaign_events, plus this one) up to and including the log, writes the log's credits and
 * the sell states it changed. Rows above the log are not read, so the result never depends on later blocks.
 */
export async function applyBarkAttributionAt(db: Queryable, cfg: Gen8BarkChainConfig, pool: Pick<Gen8PoolRow, "poolId" | "token">, log: BarkMoneyLog, alert?: Alert) {
  const hook = cfg.plugin.address;
  const args = [cfg.chainId, hook, pool.token, log.blockNumber, log.logIndex];
  const [buyRows, sellRows, logRows] = await Promise.all([
    db.query(
      `select tx_hash, log_index, block_number, phase, trader, swap_sender, profile, router_amount, creator_share from public.evm_gen8_fee_accruals
        where chain_id = $1 and hook_address = $2 and token_address = $3 and kind = 'trade' and side = 'buy'
          and (block_number < $4 or (block_number = $4 and log_index < $5))
        order by block_number, log_index`,
      args,
    ),
    db.query(
      `select tx_hash, log_index, block_number, phase, trader, swap_sender, profile, router_coins, creator_coins from public.evm_gen8_bark_sell_fees
        where chain_id = $1 and hook_address = $2 and token_address = $3
          and (block_number < $4 or (block_number = $4 and log_index < $5))
        order by block_number, log_index`,
      args,
    ),
    db.query(
      `select tx_hash, log_index, block_number, block_time, event_name, args from public.evm_campaign_events
        where chain_id = $1 and contract_address = $2 and campaign_address = $3 and event_name in ('FeesCollected', 'CoinFeesConverted')
          and (block_number < $4 or (block_number = $4 and log_index <= $5))
        order by block_number, log_index`,
      [cfg.chainId, cfg.launcher.address, pool.token, log.blockNumber, log.logIndex],
    ),
  ]);
  const src = (r: any) => ({
    token: pool.token, txHash: String(r.tx_hash), logIndex: Number(r.log_index), blockNumber: Number(r.block_number), phase: (r.phase === "post" ? "post" : "bonding") as BarkPhase,
    trader: r.trader ? String(r.trader) : null, swapSender: r.swap_sender ? String(r.swap_sender) : null, profile: (r.profile as Gen8Profile) || null,
  });
  const buys: BarkBuySource[] = buyRows.rows.map((r) => ({ ...src(r), router: big(r.router_amount), creator: big(r.creator_share) }));
  const sells: BarkSellSource[] = sellRows.rows.map((r) => ({ ...src(r), routerCoins: big(r.router_coins), creatorCoins: big(r.creator_coins) }));
  const logs = logRows.rows
    .map((r) => barkMoneyLogFromEvent(String(r.event_name), typeof r.args === "string" ? JSON.parse(r.args) : r.args || {}, { txHash: String(r.tx_hash), logIndex: Number(r.log_index), blockNumber: Number(r.block_number), blockTime: new Date(r.block_time) }))
    .filter((l): l is BarkMoneyLog => l !== null && !(l.txHash === log.txHash && l.logIndex === log.logIndex))
    .map((l) => ({ ...l, coin: pool.token }));
  const a = barkAttribute({ buys, sells, logs: [...logs, { ...log, coin: pool.token }] });
  const at = posKey(log.txHash, log.logIndex);
  for (const c of a.credits.filter((x) => x.txHash === log.txHash && x.logIndex === log.logIndex)) {
    await insertCredit(db, { ...c, chainId: cfg.chainId, hook, poolId: pool.poolId, kind: "trade" });
  }
  for (const [key, st] of a.sells) {
    if (!st.changedAt.includes(at)) continue;
    const [txHash, logIndex] = [key.slice(0, key.lastIndexOf(":")), Number(key.slice(key.lastIndexOf(":") + 1))];
    await db.query(
      `update public.evm_gen8_bark_sell_fees set booked_coins = $4, collect_tx_hash = $5, collect_log_index = $6, converted_coins = $7, converted_native = $8, updated_at = now()
        where chain_id = $1 and tx_hash = $2 and log_index = $3`,
      [cfg.chainId, txHash, logIndex, st.bookedCoins === null ? null : st.bookedCoins.toString(), st.collectTxHash, st.collectLogIndex, st.convertedCoins.toString(), st.convertedNative.toString()],
    );
  }
  for (const x of a.anomalies.filter((y) => y.txHash === log.txHash && y.logIndex === log.logIndex)) {
    await alert?.({
      severity: "critical", kind: "gen8_bark_attribution_mismatch", chainId: cfg.chainId, subject: `${x.txHash}:${x.logIndex}`,
      title: `Barkswap fee attribution differs from the launcher's books on chain ${cfg.chainId}`,
      message: `${pool.token} at ${x.txHash}:${x.logIndex}: ${x.message}. Should never happen; the next route run will not match until resolved.`,
    });
  }
  return a;
}

// ------------------------------------------------------------------ one-time backfill (t18 passed sells without rows)

/** indexer_state cursor recording that the money cursor was rewound once for the t19 attribution. */
export const GEN8_BARK_ATTRIBUTION_MARKER = "gen8-bark-attribution-v1";

/**
 * t18's money pass wrote no sell rows. Once per plugin, before the first pass with this code, the money cursor goes
 * back to the start block, so every sell (and every collect / conversion) it already passed is attributed. What the
 * re-scan writes again: accruals, sell rows, events and credits insert on conflict do nothing; reward_events and sell
 * states are upserted / restated as absolute values; the trade-activity counter (markWalletActivityDb tradeDelta 1, not
 * idempotent) is marked only for a swap whose money row is new AND at or above the marker's block (t18 already marked
 * every swap below the money cursor it had reached, sells included, whose rows are new now; evmGen8Bark.ts
 * applyBarkSwap); a Routed already confirmed with its credits assigned is skipped (recordRoutedRun).
 * Returns the marker: the first block whose trades the old money pass had not marked (startBlock when nothing was).
 */
export async function ensureBarkAttributionBackfill(db: Queryable, cfg: Gen8BarkChainConfig): Promise<number> {
  const marker = `${GEN8_BARK_ATTRIBUTION_MARKER}:${cfg.plugin.address}`;
  const read = async (cursor: string) => {
    const r = await db.query(`select last_indexed_block from public.indexer_state where chain_id = $1 and cursor = $2`, [cfg.chainId, cursor]);
    return r.rows[0] ? Number(r.rows[0].last_indexed_block) : null;
  };
  const set = (cursor: string, next: number) =>
    db.query(
      `insert into public.indexer_state(chain_id, cursor, last_indexed_block) values ($1,$2,$3)
       on conflict (chain_id, cursor) do update set last_indexed_block = excluded.last_indexed_block, updated_at = now()`,
      [cfg.chainId, cursor, next],
    );
  const done = await read(marker);
  if (done !== null) return done;
  const moneyCursor = `gen8-money:${cfg.plugin.address}`;
  const money = await read(moneyCursor);
  const rewound = money !== null && money > cfg.startBlock;
  const activityFrom = rewound ? money : cfg.startBlock;
  if (!rewound) {
    await set(marker, activityFrom);
    return activityFrom;
  }
  // one statement: the rewind never happens without its activity boundary, nor the marker without the rewind
  await db.query(
    `insert into public.indexer_state(chain_id, cursor, last_indexed_block) values ($1,$2,$3),($1,$4,$5)
     on conflict (chain_id, cursor) do update set last_indexed_block = excluded.last_indexed_block, updated_at = now()`,
    [cfg.chainId, marker, activityFrom, moneyCursor, cfg.startBlock],
  );
  return activityFrom;
}
