/**
 * In-memory stand-ins for the gen-8 ingest seams, so a recorded log fixture can be driven through the real
 * ingest code without Postgres or an RPC:
 *   - FakeGen8Db implements Queryable.query (evmGen8Store.ts): every statement is logged (whitespace-normalised SQL
 *     and its parameters) and the few tables the ingest reads back (indexer_state, evm_gen8_pools,
 *     campaign_market_state, evm_gen8_swaps, the census token list, the idempotent inserts, and the rows the Barkswap
 *     attribution replay reads: accruals, sell fees, launcher money logs) are emulated; every other statement returns no rows.
 *   - FakeGen8Provider implements Gen8Provider (evmGen8Pool.ts) over a list of recorded logs.
 *   - fakeGen8Sinks implements Gen8Sinks (evmGen8Pool.ts) and records every call.
 * The write log is what the tests compare: the V4 path against its recorded snapshot, a Barkswap swap against a V4 swap.
 */
import type { Queryable } from "../../evm/evmGen8Store.js";
import type { Gen8Provider, Gen8Sinks } from "../../evm/evmGen8Pool.js";
import type { LogLike } from "../../evm/evmGen8Decode.js";

export type LoggedQuery = { sql: string; params: unknown[] };

const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();

export function plain(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, plain(x)]));
  return v;
}

const POOL_COLUMNS = [
  "chain_id", "pool_id", "token_address", "hook_address", "launcher_address", "pool_manager_address", "creator_address",
  "hook_creator_address", "creator_profile", "fee_choice", "fee_creator_pct", "target_usd", "market_cap_native", "virtual_native",
  "virtual_token", "tick_start", "tick_grad", "liq_a", "liq_b", "fees", "display_pair", "first_buy_in", "first_buy_out", "launch_tx",
  "launch_block", "launch_time", "metadata", "open_at",
];

export class FakeGen8Db implements Queryable {
  log: LoggedQuery[] = [];
  cursors = new Map<string, number>();
  pools = new Map<string, Record<string, any>>();
  stages = new Map<string, string>();
  /** evm_gen8_swaps (the display swap ledger), for lastGen8Swap / loadGen8SwapsSince. */
  swaps: Array<Record<string, any>> = [];
  /** What the Barkswap attribution replay reads back (evmGen8BarkAttribution.ts): buy accruals, sell fees, launcher money logs. */
  barkReplay = { accruals: [] as Array<Record<string, any>>, sells: [] as Array<Record<string, any>>, events: [] as Array<Record<string, any>> };
  private keys = new Set<string>();

  async query(sqlIn: string, params: unknown[] = []): Promise<{ rows: any[]; rowCount?: number | null }> {
    const sql = norm(sqlIn);
    this.log.push({ sql, params: params.map(plain) });
    const p = params as any[];
    const done = (rows: any[]) => ({ rows, rowCount: rows.length });
    if (sql.startsWith("select last_indexed_block from public.indexer_state")) {
      const v = this.cursors.get(`${p[0]}:${p[1]}`);
      return done(v === undefined ? [] : [{ last_indexed_block: v }]);
    }
    if (sql.startsWith("insert into public.indexer_state(chain_id, cursor, last_indexed_block) values ($1,$2,$3),($1,$4,$5)")) {
      this.cursors.set(`${p[0]}:${p[1]}`, Number(p[2]));
      this.cursors.set(`${p[0]}:${p[3]}`, Number(p[4]));
      return done([]);
    }
    if (sql.startsWith("insert into public.indexer_state")) {
      const key = `${p[0]}:${p[1]}`;
      const next = Number(p[2]);
      this.cursors.set(key, sql.includes("greatest(") ? Math.max(this.cursors.get(key) ?? next, next) : next);
      return done([]);
    }
    if (sql.startsWith("insert into public.evm_gen8_pools(")) {
      const row = Object.fromEntries(POOL_COLUMNS.map((c, i) => [c, p[i]]));
      const key = String(row.pool_id);
      if (!this.pools.has(key)) this.pools.set(key, { ...row, fees: JSON.parse(String(row.fees)), graduated_block: null, last_phase: null, last_sqrt_price_x96: null, last_swap_block: null, last_swap_log_index: null });
      return done([]);
    }
    if (sql.startsWith("select p.*, c.name, c.symbol from public.evm_gen8_pools p")) {
      const all = [...this.pools.values()].filter((r) => r.chain_id === p[0]);
      const pick = sql.includes("p.hook_address = $2") ? all.filter((r) => r.hook_address === p[1])
        : sql.includes("p.pool_id = $2") ? all.filter((r) => r.pool_id === p[1])
          : sql.includes("p.token_address = $2") ? all.filter((r) => r.token_address === p[1]) : all;
      return done(pick.map((r) => ({ ...r, name: null, symbol: null })));
    }
    if (sql.startsWith("update public.evm_gen8_pools set last_sqrt_price_x96")) {
      const r = this.pools.get(String(p[1]));
      if (r && (r.last_swap_block === null || r.last_swap_block < p[5] || (r.last_swap_block === p[5] && (r.last_swap_log_index ?? -1) < p[6]))) {
        Object.assign(r, { last_sqrt_price_x96: p[2], last_tick: p[3], last_liquidity: p[4], last_swap_block: p[5], last_swap_log_index: p[6], last_phase: p[7] });
      }
      return done([]);
    }
    if (sql.startsWith("update public.evm_gen8_pools set graduated_block")) {
      const r = this.pools.get(String(p[1]));
      if (r && r.graduated_block === null) Object.assign(r, { graduated_block: p[2] });
      return done([]);
    }
    if (sql.startsWith("insert into public.evm_gen8_swaps(")) {
      const key = `${p[0]}:${p[4]}:${p[5]}`;
      if (!this.swaps.some((r) => r.key === key)) {
        this.swaps.push({ key, chain_id: p[0], hook_address: p[1], pool_id: p[2], token_address: p[3], tx_hash: p[4], log_index: p[5], block_number: p[6], block_time: p[7], phase: p[8], side: p[9], sqrt_price_x96: p[10], price: p[11], mcap: p[12], volume: p[13], sold_raw: p[14] });
      }
      return done([]);
    }
    if (sql.startsWith("select max(block_time) as t from public.evm_gen8_swaps")) {
      const times = this.swaps.filter((r) => r.chain_id === p[0] && r.token_address === p[1]).map((r) => (r.block_time as Date).getTime());
      return done([{ t: times.length ? new Date(Math.max(...times)) : null }]);
    }
    if (sql.startsWith("select * from public.evm_gen8_swaps where chain_id = $1 and token_address = $2 and block_time >= $3")) {
      const since = (p[2] as Date).getTime();
      return done(this.swaps.filter((r) => r.chain_id === p[0] && r.token_address === p[1] && (r.block_time as Date).getTime() >= since)
        .sort((a, b) => a.block_number - b.block_number || a.log_index - b.log_index));
    }
    if (sql.startsWith("select p.token_address, p.launch_block, s.last_block from public.evm_gen8_pools p")) {
      return done([...this.pools.values()].filter((r) => r.chain_id === p[0] && r.hook_address === p[1]).map((r) => ({ token_address: r.token_address, launch_block: r.launch_block, last_block: null })));
    }
    if (sql.startsWith("select market_stage from public.campaign_market_state")) {
      const s = this.stages.get(`${p[0]}:${p[1]}`);
      return done(s ? [{ market_stage: s }] : []);
    }
    if (sql.startsWith("insert into public.campaign_market_state(")) {
      const stage = sql.includes("'DEX_ACTIVE'") ? "DEX_ACTIVE" : "BONDING";
      this.stages.set(`${p[0]}:${p[1]}`, stage);
      return done([]);
    }
    if (sql.startsWith("update public.campaign_market_state set market_stage")) {
      this.stages.set(`${p[0]}:${p[1]}`, String(p[2]));
      return done([]);
    }
    const upTo = (r: Record<string, any>, incl: boolean) => Number(r.block_number) < Number(p[3]) || (Number(r.block_number) === Number(p[3]) && (incl ? Number(r.log_index) <= Number(p[4]) : Number(r.log_index) < Number(p[4])));
    const inOrder = (a: Record<string, any>, b: Record<string, any>) => Number(a.block_number) - Number(b.block_number) || Number(a.log_index) - Number(b.log_index);
    const seen = (rows: Array<Record<string, any>>, tx: unknown, li: unknown) => rows.some((r) => r.tx_hash === tx && r.log_index === li);
    const columns = () => Object.fromEntries(sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(",").map((c, i) => [c.trim(), p[i]]));
    if (sql.startsWith("insert into public.evm_gen8_fee_accruals(") && !seen(this.barkReplay.accruals, p[4], p[5])) this.barkReplay.accruals.push({ ...columns(), run_id: null });
    if (sql.startsWith("insert into public.evm_gen8_bark_sell_fees(") && !seen(this.barkReplay.sells, p[2], p[3])) this.barkReplay.sells.push({ ...columns(), booked_coins: null, converted_coins: "0", converted_native: "0" });
    if (sql.startsWith("insert into public.evm_campaign_events(") && !seen(this.barkReplay.events, p[5], p[6])) {
      this.barkReplay.events.push({ chain_id: p[0], contract_address: p[1], campaign_address: p[3], event_name: p[4], tx_hash: p[5], log_index: p[6], block_number: p[7], block_time: p[8], args: JSON.parse(String(p[9])) });
    }
    if (sql.startsWith("select tx_hash, log_index, block_number, phase, trader, swap_sender, profile, router_amount, creator_share from public.evm_gen8_fee_accruals")) {
      return done(this.barkReplay.accruals.filter((r) => r.chain_id === p[0] && r.hook_address === p[1] && r.token_address === p[2] && r.kind === "trade" && r.side === "buy" && upTo(r, false)).sort(inOrder));
    }
    if (sql.startsWith("select tx_hash, log_index, block_number, phase, trader, swap_sender, profile, router_coins, creator_coins from public.evm_gen8_bark_sell_fees")) {
      return done(this.barkReplay.sells.filter((r) => r.chain_id === p[0] && r.hook_address === p[1] && r.token_address === p[2] && upTo(r, false)).sort(inOrder));
    }
    if (sql.startsWith("select tx_hash, log_index, block_number, block_time, event_name, args from public.evm_campaign_events")) {
      return done(this.barkReplay.events.filter((r) => r.chain_id === p[0] && r.contract_address === p[1] && r.campaign_address === p[2] && ["FeesCollected", "CoinFeesConverted"].includes(r.event_name) && upTo(r, true)).sort(inOrder));
    }
    if (sql.includes("on conflict (chain_id, tx_hash, log_index) do nothing returning 1")) {
      const table = sql.slice("insert into public.".length).split(/[ (]/)[0];
      const key = `${table}:${p[0]}:${table === "evm_gen8_fee_accruals" ? `${p[4]}:${p[5]}` : table === "evm_campaign_events" ? `${p[5]}:${p[6]}` : table === "dex_trades" ? `${p[3]}:${p[4]}` : `${p[2]}:${p[3]}`}`;
      if (this.keys.has(key)) return done([]);
      this.keys.add(key);
      return done([{ "?column?": 1 }]);
    }
    if (sql.startsWith("insert into public.token_candles(")) {
      return done([{ timeframe: p[2], bucket_start: p[3], o: p[4], h: p[4], l: p[4], c: p[4], volume_bnb: p[5], trades_count: 1, mcap_o: p[13], mcap_h: p[13], mcap_l: p[13], mcap_c: p[13] }]);
    }
    if (sql.startsWith("insert into public.epochs(")) {
      return done([{ id: 1, chain_id: p[0], epoch_type: "weekly", start_at: p[1], end_at: p[2], status: p[3], created_at: new Date(0), finalized_at: null }]);
    }
    if (sql.startsWith("select coalesce(sum(bnb_amount), 0) as vol")) return done([{ vol: 0 }]);
    if (sql.startsWith("select count(distinct s)::int as n")) return done([{ n: 1 }]);
    if (sql.startsWith("select last_price_bnb, market_cap_bnb")) return done([{ last_price_bnb: 1, market_cap_bnb: 1, liquidity_bnb: 1, trades_24h: 0, buys_24h: 0, sells_24h: 0, last_trade_at: null, market_stage: "DEX_ACTIVE" }]);
    return done([]);
  }

  /** Every statement whose SQL starts with `prefix` (after whitespace normalisation). */
  writes(prefix: string): LoggedQuery[] {
    return this.log.filter((q) => q.sql.startsWith(prefix));
  }
}

export type RecordedLog = LogLike & { blockHash?: string | null };

export class FakeGen8Provider implements Gen8Provider {
  getLogsCalls: Array<{ address?: string | string[]; topics?: Array<string | string[] | null>; fromBlock: number; toBlock: number }> = [];
  constructor(
    private logs: RecordedLog[],
    private head: number,
    private txs: Map<string, { from: string; to: string | null }>,
    private timeOf: (n: number) => number,
  ) {}
  async getBlockNumber() {
    return this.head;
  }
  async getLogs(filter: { address?: string | string[]; topics?: Array<string | string[] | null>; fromBlock: number; toBlock: number }) {
    this.getLogsCalls.push(filter);
    const addrs = filter.address === undefined ? null : new Set((Array.isArray(filter.address) ? filter.address : [filter.address]).map((a) => a.toLowerCase()));
    const match = (want: string | string[] | null | undefined, got: string | undefined) => {
      if (want === null || want === undefined) return true;
      const list = (Array.isArray(want) ? want : [want]).map((t) => t.toLowerCase());
      return got !== undefined && list.includes(got.toLowerCase());
    };
    return this.logs.filter((l) => l.blockNumber >= filter.fromBlock && l.blockNumber <= filter.toBlock && (!addrs || addrs.has(l.address.toLowerCase()))
      && (filter.topics ?? []).every((t, i) => match(t, l.topics[i])));
  }
  async getBlock(n: number | "finalized" | "safe" | "latest") {
    const num = typeof n === "number" ? n : this.head;
    return { timestamp: this.timeOf(num), hash: `0x${num.toString(16).padStart(64, "0")}`, number: num };
  }
  async getTransaction(hash: string) {
    return this.txs.get(hash.toLowerCase()) ?? null;
  }
}

export type SinkCall = { name: string; args: unknown[] };

/** Gen8Sinks that record each call. `ts` (wall clock) is dropped from published payloads so a log is reproducible. */
export function fakeGen8Sinks(calls: SinkCall[]): Gen8Sinks {
  const rec = (name: string) => async (...args: unknown[]) => {
    calls.push({ name, args: plain(args.map((a) => (a && typeof a === "object" && "ts" in (a as any) ? { ...(a as any), ts: "<now>" } : a))) as unknown[] });
  };
  return {
    upsertCampaign: async (...args: unknown[]) => {
      calls.push({ name: "upsertCampaign", args: plain(args) as unknown[] });
      return true;
    },
    insertActivityEvent: rec("insertActivityEvent") as any,
    markEvmCampaignGraduated: rec("markEvmCampaignGraduated") as any,
    publishTrade: rec("publishTrade") as any,
    publishStats: rec("publishStats") as any,
    publishCandle: rec("publishCandle") as any,
    publishTokenEvent: rec("publishTokenEvent") as any,
    publishLeague: rec("publishLeague") as any,
    leagueFeed: {
      queueRaisedDelta: (...args: unknown[]) => void calls.push({ name: "queueRaisedDelta", args: plain(args) as unknown[] }),
      queueActivity: (...args: unknown[]) => void calls.push({ name: "queueActivity", args: plain(args) as unknown[] }),
      queueStats: (...args: unknown[]) => void calls.push({ name: "queueStats", args: plain(args) as unknown[] }),
    },
    recordTradeActivity: rec("recordTradeActivity") as any,
    checkMilestones: async (chainId: number, campaign: string, progressFor: (c: number, a: string) => Promise<{ progressPct: number } | null>) => {
      calls.push({ name: "checkMilestones", args: [chainId, campaign, await progressFor(chainId, campaign)] });
    },
    raiseAlert: rec("raiseAlert") as any,
    candlePayload: (tf: string, bucketSec: number, row: any) => ({ tf, bucketSec, close: plain(row?.c) }),
    timeframes: [
      { tf: "1m", bucketStart: (s: number) => s - (s % 60) },
      { tf: "1h", bucketStart: (s: number) => s - (s % 3600) },
    ],
  };
}
