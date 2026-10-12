/**
 * Gen-8 fee routing worker (D1 = A, design 3.4; audit 4.5 / 10.2 / V13). The accrual rows are written by the ingest
 * loop (evmGen8Pool.ts); this worker claims, plans and (only in send mode) sends MwzFeeSplitter.route().
 *
 * Claim-first (MwzFeeSplitter V13, build/evm-gen8 aac801d5): route(runId, expectedPaid, ...) never claims and reverts
 * PaidMismatch unless hook.routerPaid(splitter).amount == expectedPaid. The hook moves its whole bucket with its
 * bonding / graduation counters in one step and emits RouterClaimed(router, amount, bondingFees, gradFees): by
 * claimRouter() (permissionless) or by the A4 flush in executeTreasuryRouter (a failed flush emits RouterFlushFailed and
 * moves nothing). So a run is exactly the HookFee / Graduated rows between two claims:
 *   1. If nothing paid to the splitter is waiting to be routed and the hook holds a bucket, send claimRouter() (send
 *      mode) and stop; the next pass continues once the ingest has indexed the claim.
 *   2. P = routerPaid(splitter).amount, read at the block the ingest is complete through. The claim that brought the
 *      cumulative RouterClaimed amount (router = splitter) to P is the run's cut; the run's rows are the unrouted
 *      accrual rows before that log. Fees after the claim stay in the hook and belong to the next run, in full.
 *   3. Those rows must add up to exactly what the splitter received since the last run (pending(): total, B, G).
 *      Otherwise nothing is planned and a critical alert is raised (it should never fire).
 *   4. Amounts by the step-2 aggregate rule with bands(B, G) read from the splitter (checked against the local copy).
 *   5. Dry run (default): the plan is written as 'dry_run'. Send mode: staticCall, then route(runs + 1, P, ...). A
 *      PaidMismatch (someone claimed in between) is recorded and the next pass re-plans from step 2.
 * A run is confirmed only by its Routed event (recordRoutedRun): its rows are the unrouted rows before the claim whose
 * cumulative amount equals the cumulative routed amount, i.e. the same cut the plan used.
 */
import { ethers } from "ethers";
import { configuredGen8Chains, intEnv, truthyEnv, type Gen8ChainConfig } from "./evmGen8Config.js";
import { GEN8_HOOK_IFACE, GEN8_SPLITTER_ABI } from "./evmGen8Abi.js";
import {
  addToSums,
  aggregateRunAmounts,
  emptyProfileSums,
  gen8LeafHash,
  merkleRoot,
  splitterBands,
  type Gen8Leaf,
  type Gen8Profile,
} from "./evmGen8Fees.js";
import type { Gen8Event } from "./evmGen8Decode.js";
import type { Queryable } from "./evmGen8Store.js";

export const GEN8_ROUTING_ALERT_TYPE = "gen8_splitter";

type RoutedEvent = Extract<Gen8Event, { kind: "Routed" }>;
type Alert = (a: { severity: "critical" | "warning" | "info"; kind: string; chainId: number; subject?: string; title: string; message: string }) => Promise<unknown>;

const big = (v: unknown) => BigInt(String(v ?? "0").split(".")[0] || "0");

/**
 * Wallets allowed to call hook.claimRouter() (audit C-M1 / F11 foreign-claim alert): the splitter operator as indexed
 * from its OperatorUpdated events, plus EVM_GEN8_ROUTER_CLAIMERS_<id> (the Safe, a backup operator).
 */
export async function gen8KnownClaimers(db: Queryable, chainId: number, splitter: string | null, env: NodeJS.ProcessEnv = process.env): Promise<Set<string>> {
  const out = new Set<string>(
    String(env[`EVM_GEN8_ROUTER_CLAIMERS_${chainId}`] || "")
      .split(/[\s,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => /^0x[0-9a-f]{40}$/.test(s)),
  );
  if (splitter) {
    const r = await db.query(
      `select args->>'next' as next from public.evm_campaign_events
        where chain_id = $1 and contract_address = $2 and event_name = 'OperatorUpdated'
        order by block_number desc, log_index desc limit 1`,
      [chainId, splitter],
    );
    const op = String(r.rows[0]?.next || "").toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(op) && op !== "0x0000000000000000000000000000000000000000") out.add(op);
  }
  return out;
}

export type Gen8Claim = { blockNumber: number; logIndex: number; txHash: string; amount: bigint; bondingFees: bigint; gradFees: bigint; cumulative: bigint };

/** RouterClaimed events paying the splitter (claimRouter or the A4 flush), in order, with the cumulative amount. */
export async function claimsToSplitter(db: Queryable, cfg: Gen8ChainConfig, upToBlock?: number): Promise<Gen8Claim[]> {
  if (!cfg.splitter) return [];
  // F10: only claims at or below the money head count (the contract events table is written by the display pass).
  const { rows } = await db.query(
    `select block_number, log_index, tx_hash, args from public.evm_campaign_events
      where chain_id = $1 and contract_address = $2 and event_name = 'RouterClaimed' and lower(args->>'router') = $3
        and ($4::bigint is null or block_number <= $4::bigint)
      order by block_number, log_index`,
    [cfg.chainId, cfg.hook.address, cfg.splitter.address, upToBlock ?? null],
  );
  let cumulative = 0n;
  return rows.map((r) => {
    const a = typeof r.args === "string" ? JSON.parse(r.args) : r.args || {};
    cumulative += big(a.amount);
    return { blockNumber: Number(r.block_number), logIndex: Number(r.log_index), txHash: String(r.tx_hash), amount: big(a.amount), bondingFees: big(a.bondingFees), gradFees: big(a.gradFees), cumulative };
  });
}

/** The claim whose cumulative paid amount equals `paid` (the run's cut), or null when it is not indexed (yet). */
export function claimCut(claims: Gen8Claim[], paid: bigint): Gen8Claim | null {
  if (paid === 0n) return null;
  return claims.find((c) => c.cumulative === paid) ?? null;
}

async function unroutedRowsBefore(db: Queryable, cfg: Gen8ChainConfig, cut: { blockNumber: number; logIndex: number }) {
  const { rows } = await db.query(
    `select id, tx_hash, log_index, block_number, kind, phase, trader, profile, fee, router_amount, league_weekly, league_monthly, recruiter, squad, airdrop, protocol
       from public.evm_gen8_fee_accruals
      where chain_id = $1 and hook_address = $2 and run_id is null
        and (block_number < $3 or (block_number = $3 and log_index < $4))
      order by block_number, log_index`,
    [cfg.chainId, cfg.hook.address, cut.blockNumber, cut.logIndex],
  );
  return rows;
}

function sumRows(rows: any[]) {
  let B = 0n;
  let G = 0n;
  let T = 0n;
  for (const r of rows) {
    if (r.kind === "graduation") G += big(r.fee);
    else if (r.phase === "bonding") B += big(r.fee);
    T += big(r.router_amount);
  }
  return { B, G, T };
}

const RUN_FIELDS = [
  ["total", "total"], ["bonding_fees", "bondingFees"], ["grad_fees", "gradFees"], ["weekly_league", "weeklyLeague"], ["monthly_league", "monthlyLeague"],
  ["recruiter", "recruiter"], ["squad", "squad"], ["airdrop", "airdrop"], ["protocol", "protocol"],
] as const;

/**
 * F11 (audit C-L3): what a Routed event did differently from the run we planned (amounts, accrualRoot, caller).
 * `planned` is the evm_gen8_route_runs row before the event (null: no plan at all). `operators` are the wallets that
 * may call route() for us (the plan's caller, else the indexed splitter operator / EVM_GEN8_ROUTER_CLAIMERS_<id>).
 */
export function routedPlanDifferences(planned: Record<string, any> | null | undefined, e: Pick<RoutedEvent, "run" | "accrualRoot" | "caller">, operators: Set<string>): string[] {
  if (!planned || planned.status === "confirmed") return planned ? [] : ["no plan for this run"];
  const diffs: string[] = [];
  for (const [col, key] of RUN_FIELDS) {
    const want = planned[col];
    const got = e.run[key];
    if (want === null || want === undefined || big(want) !== got) diffs.push(`${col} planned ${want ?? "none"} routed ${got}`);
  }
  if (String(planned.accrual_root || "").toLowerCase() !== e.accrualRoot.toLowerCase()) diffs.push(`accrualRoot planned ${planned.accrual_root ?? "none"} routed ${e.accrualRoot}`);
  const expected = planned.caller ? new Set([String(planned.caller).toLowerCase()]) : operators;
  if (!expected.has(e.caller.toLowerCase())) diffs.push(`caller ${e.caller} is not ${expected.size ? [...expected].join(" / ") : "a known operator"}`);
  return diffs;
}

/** Called by the ingest loop for every Routed log of the splitter. Idempotent. */
export async function recordRoutedRun(db: Queryable, cfg: Gen8ChainConfig, e: RoutedEvent, _at: Date, alert?: Alert, env: NodeJS.ProcessEnv = process.env) {
  if (!cfg.splitter) return;
  const splitter = cfg.splitter.address;
  const runId = Number(e.runId);
  const r = e.run;
  const prior = await db.query(
    `select status, leaves, accrual_root, total, bonding_fees, grad_fees, weekly_league, monthly_league, recruiter, squad, airdrop, protocol, caller, tx_hash
       from public.evm_gen8_route_runs where chain_id = $1 and splitter_address = $2 and run_id = $3`,
    [cfg.chainId, splitter, runId],
  );
  const planned = prior.rows[0];
  // F11: every Routed is compared with our plan; a run nobody planned, or one that differs, is a critical alert (a
  // stolen operator key or the Safe routing by hand). A re-scan of an already confirmed run compares nothing.
  if (!planned || planned.status !== "confirmed") {
    const diffs = routedPlanDifferences(planned, e, await gen8KnownClaimers(db, cfg.chainId, splitter, env));
    if (diffs.length) {
      await alert?.({
        severity: "critical", kind: "gen8_routed_differs_from_plan", chainId: cfg.chainId, subject: `${runId}:${e.txHash}`,
        title: `Gen-8 run ${runId} was routed differently from our plan on chain ${cfg.chainId}`,
        message: `Routed in ${e.txHash} by ${e.caller}: ${diffs.join("; ")}.`,
      });
    }
  }
  await db.query(
    `insert into public.evm_gen8_route_runs(
       chain_id, splitter_address, run_id, status, total, bonding_fees, grad_fees, weekly_league, monthly_league, recruiter, squad, airdrop, protocol,
       accrual_root, tx_hash, routed_block, routed_log_index, caller, updated_at
     ) values ($1,$2,$3,'confirmed',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now())
     on conflict (chain_id, splitter_address, run_id) do update set
       status = 'confirmed', total = excluded.total, bonding_fees = excluded.bonding_fees, grad_fees = excluded.grad_fees,
       weekly_league = excluded.weekly_league, monthly_league = excluded.monthly_league, recruiter = excluded.recruiter,
       squad = excluded.squad, airdrop = excluded.airdrop, protocol = excluded.protocol, accrual_root = excluded.accrual_root,
       tx_hash = excluded.tx_hash, routed_block = excluded.routed_block, routed_log_index = excluded.routed_log_index,
       caller = excluded.caller, error = null, updated_at = now()`,
    [
      cfg.chainId, splitter, runId, r.total.toString(), r.bondingFees.toString(), r.gradFees.toString(), r.weeklyLeague.toString(), r.monthlyLeague.toString(),
      r.recruiter.toString(), r.squad.toString(), r.airdrop.toString(), r.protocol.toString(), e.accrualRoot, e.txHash, e.blockNumber, e.logIndex, e.caller,
    ],
  );
  // The run routed everything paid up to cumulative = sum of all run totals so far: the same claim cut as the plan.
  const routed = await db.query(
    `select coalesce(sum(total), 0)::text as t from public.evm_gen8_route_runs where chain_id = $1 and splitter_address = $2 and status = 'confirmed' and run_id <= $3`,
    [cfg.chainId, splitter, runId],
  );
  const cut = claimCut(await claimsToSplitter(db, cfg, e.blockNumber), big(routed.rows[0]?.t));
  if (!cut) {
    await alert?.({ severity: "critical", kind: "gen8_run_without_claim", chainId: cfg.chainId, subject: String(runId), title: `Gen-8 run ${runId} has no matching claim on chain ${cfg.chainId}`, message: `No indexed RouterClaimed brings the splitter's cumulative paid to ${routed.rows[0]?.t}. Rows not assigned; should never happen.` });
    return;
  }
  const rows = await unroutedRowsBefore(db, cfg, cut);
  const sums = sumRows(rows);
  if (sums.B !== r.bondingFees || sums.G !== r.gradFees || sums.T !== r.total) {
    await alert?.({ severity: "critical", kind: "gen8_run_rows_mismatch", chainId: cfg.chainId, subject: String(runId), title: `Gen-8 run ${runId}: indexed rows differ from the run on chain ${cfg.chainId}`, message: `rows B ${sums.B} G ${sums.G} T ${sums.T}; Routed B ${r.bondingFees} G ${r.gradFees} T ${r.total}. Should never happen.` });
  }
  if (planned && Array.isArray(planned.leaves) && String(planned.accrual_root || "").toLowerCase() === e.accrualRoot.toLowerCase()) {
    const plannedKeys = new Set(planned.leaves.filter((l: any) => l.kind !== 3).map((l: any) => `${String(l.txHash).toLowerCase()}:${Number(l.logIndex)}`));
    const actualKeys = new Set(rows.map((x) => `${String(x.tx_hash).toLowerCase()}:${Number(x.log_index)}`));
    if (plannedKeys.size !== actualKeys.size || [...actualKeys].some((k) => !plannedKeys.has(k))) {
      await alert?.({ severity: "critical", kind: "gen8_run_rows_mismatch", chainId: cfg.chainId, subject: `${runId}:root`, title: `Gen-8 run ${runId}: covered rows differ from its accrualRoot`, message: `planned ${plannedKeys.size} rows, covered ${actualKeys.size}. Should never happen.` });
    }
  }
  for (const row of rows) await db.query(`update public.evm_gen8_fee_accruals set run_id = $2 where id = $1 and run_id is null`, [row.id, runId]);
}

export type Gen8RouteState = {
  runs: bigint;
  paid: bigint;
  pendingTotal: bigint;
  pendingBonding: bigint;
  pendingGrad: bigint;
  routerOwed: bigint;
  treasuryRouter: string;
  operator: string;
  bands: (b: bigint, g: bigint) => Promise<{ weekly: bigint; monthly: bigint; rsaMin: bigint; rsaMax: bigint; squadMax: bigint }>;
};

export type Gen8RouteChain = {
  readState(blockTag: number | "latest"): Promise<Gen8RouteState>;
  /** hook.claimRouter() from the operator key, waits for the receipt; returns its hash and block. Send mode only. */
  sendClaim(): Promise<{ hash: string; blockNumber: number }>;
  /** Simulate then send route(runId, expectedPaid, ...); returns the tx hash. Send mode only. */
  sendRoute(args: { runId: bigint; expectedPaid: bigint; recruiter: bigint; squad: bigint; airdrop: bigint; root: string }): Promise<string>;
  waitReceipt(hash: string): Promise<{ status: number } | null>;
  headBlock(): Promise<number>;
  /** F11: true while the node still knows the transaction (mined or in its mempool), false once it is dropped. */
  txKnown?(hash: string): Promise<boolean>;
};

export function ethersRouteChain(cfg: Gen8ChainConfig, provider: ethers.JsonRpcProvider, signer: ethers.Signer | null): Gen8RouteChain {
  if (!cfg.splitter) throw new Error("gen8 routing: no splitter");
  const splitterAddr = cfg.splitter.address;
  const splitterRead = new ethers.Contract(splitterAddr, GEN8_SPLITTER_ABI as unknown as string[], provider) as any;
  const hook = new ethers.Contract(cfg.hook.address, GEN8_HOOK_IFACE, provider) as any;
  return {
    async readState(blockTag) {
      const o = { blockTag };
      const [runs, pending, paid, routerOwed, router, operator] = await Promise.all([
        splitterRead.runs(o), splitterRead.pending(o), hook.routerPaid(splitterAddr, o), hook.routerOwed(o), hook.treasuryRouter(o), splitterRead.operator(o),
      ]);
      return {
        runs: BigInt(runs), paid: BigInt(paid[0]), pendingTotal: BigInt(pending[0]), pendingBonding: BigInt(pending[1]), pendingGrad: BigInt(pending[2]),
        routerOwed: BigInt(routerOwed), treasuryRouter: String(router).toLowerCase(), operator: String(operator).toLowerCase(),
        bands: async (b, g) => {
          const r = await splitterRead.bands(b, g);
          return { weekly: BigInt(r[0]), monthly: BigInt(r[1]), rsaMin: BigInt(r[2]), rsaMax: BigInt(r[3]), squadMax: BigInt(r[4]) };
        },
      };
    },
    async sendClaim() {
      if (!signer) throw new Error("gen8 routing: no operator key");
      const tx = await (hook.connect(signer) as any).claimRouter();
      const rc = await tx.wait();
      if (!rc || Number(rc.status) !== 1) throw new Error(`claimRouter reverted: ${tx.hash}`);
      return { hash: String(tx.hash), blockNumber: Number(rc.blockNumber) };
    },
    async sendRoute(a) {
      if (!signer) throw new Error("gen8 routing: no operator key");
      const c = splitterRead.connect(signer) as any;
      await c.route.staticCall(a.runId, a.expectedPaid, a.recruiter, a.squad, a.airdrop, a.root);
      const tx = await c.route(a.runId, a.expectedPaid, a.recruiter, a.squad, a.airdrop, a.root);
      return String(tx.hash);
    },
    async waitReceipt(hash) {
      const r = await provider.waitForTransaction(hash, 1, 120_000);
      return r ? { status: Number(r.status) } : null;
    },
    headBlock: () => provider.getBlockNumber(),
    async txKnown(hash) {
      return (await provider.getTransaction(hash)) !== null;
    },
  };
}

export type Gen8RoutePass =
  | { status: "skipped"; reason: string; detail?: Record<string, unknown> }
  | { status: "claimed"; txHash: string; blockNumber: number }
  | { status: "planned" | "sent"; runId: string; expectedPaid: string; total: string; bondingFees: string; gradFees: string; recruiter: string; squad: string; airdrop: string; rounding: string; root: string; leaves: number; txHash?: string };

/** PaidMismatch(uint256,uint256) selector (MwzFeeSplitter V13). */
export const PAID_MISMATCH_SELECTOR = "0x3897fc19";

/**
 * One pass (claim, or plan and in send mode send). `alert` is raiseAlert bound to reward_alerts.
 */
export async function runGen8RoutePass(opts: {
  db: Queryable;
  cfg: Gen8ChainConfig;
  chain: Gen8RouteChain;
  send: boolean;
  operatorAddress?: string | null;
  minWei?: bigint;
  alert?: Alert;
  mismatchMemory?: Map<string, number>;
  /** F11: consecutive PaidMismatch re-plans per chain; an alert after `paidMismatchAlertAfter` (3) in a row. */
  paidMismatchStreak?: Map<string, number>;
  paidMismatchAlertAfter?: number;
  /** F11: a sent route() with no receipt for this long is checked: dropped -> re-planned and re-sent, else alerted. */
  dropAfterMs?: number;
  now?: () => number;
}): Promise<Gen8RoutePass> {
  const { db, cfg, chain } = opts;
  if (!cfg.splitter) return { status: "skipped", reason: "no-splitter" };
  const splitter = cfg.splitter.address;
  // F10: the money cursor (accruals, Routed runs, claims at or below the safe / finalized block).
  const cursor = await db.query(`select last_indexed_block from public.indexer_state where chain_id = $1 and cursor = $2`, [cfg.chainId, `gen8-money:${cfg.hook.address}`]);
  const indexedThrough = Number(cursor.rows[0]?.last_indexed_block || 0) - 1;
  if (indexedThrough < cfg.startBlock) return { status: "skipped", reason: "not-indexed-yet" };
  const n = Math.min(indexedThrough, await chain.headBlock());

  // A sent run waiting for its Routed event (or that failed) blocks a new plan.
  const open = await db.query(`select run_id, tx_hash, updated_at from public.evm_gen8_route_runs where chain_id = $1 and splitter_address = $2 and status = 'sent' order by run_id desc limit 1`, [cfg.chainId, splitter]);
  if (open.rows[0]) {
    const sentTx = open.rows[0].tx_hash ? String(open.rows[0].tx_hash) : null;
    const receipt = sentTx ? await chain.waitReceipt(sentTx).catch(() => null) : null;
    const setFailed = (why: string) =>
      db.query(`update public.evm_gen8_route_runs set status = 'failed', error = $4, updated_at = now() where chain_id = $1 and splitter_address = $2 and run_id = $3 and status = 'sent'`, [cfg.chainId, splitter, open.rows[0].run_id, why]);
    const ageMs = open.rows[0].updated_at ? (opts.now ?? Date.now)() - new Date(open.rows[0].updated_at).getTime() : 0;
    const dropAfter = opts.dropAfterMs ?? 15 * 60_000;
    if (receipt && receipt.status === 0) {
      await setFailed("reverted");
    } else if (!receipt && sentTx && ageMs > dropAfter && chain.txKnown) {
      // F11 (audit C-L5): a route() transaction that never got a receipt. Dropped from the mempool: mark it failed
      // and re-plan now (route() takes runs + 1 and expectedPaid, so a late copy of the old one can only revert).
      // Still pending: alert, keep waiting.
      const known = await chain.txKnown(sentTx).catch(() => true);
      if (known) {
        await opts.alert?.({ severity: "warning", kind: "gen8_route_stuck", chainId: cfg.chainId, subject: sentTx, title: `Gen-8 route() pending for ${Math.round(ageMs / 60_000)} minutes on chain ${cfg.chainId}`, message: `Run ${open.rows[0].run_id}: ${sentTx} has no receipt yet and is still known to the node. Check the operator's gas price.` });
        return { status: "skipped", reason: "run-sent-awaiting-routed", detail: { runId: String(open.rows[0].run_id), tx: sentTx, stuck: true } };
      }
      await setFailed("dropped");
      await opts.alert?.({ severity: "warning", kind: "gen8_route_dropped", chainId: cfg.chainId, subject: sentTx, title: `Gen-8 route() transaction dropped on chain ${cfg.chainId}`, message: `Run ${open.rows[0].run_id}: ${sentTx} had no receipt after ${Math.round(ageMs / 60_000)} minutes and the node no longer knows it. The run is re-planned and re-sent.` });
    } else {
      return { status: "skipped", reason: "run-sent-awaiting-routed", detail: { runId: String(open.rows[0].run_id), tx: sentTx } };
    }
  }

  const s = await chain.readState(n);
  const confirmed = await db.query(`select coalesce(max(run_id), 0) as last from public.evm_gen8_route_runs where chain_id = $1 and splitter_address = $2 and status = 'confirmed'`, [cfg.chainId, splitter]);
  if (BigInt(confirmed.rows[0]?.last ?? 0) !== s.runs) return { status: "skipped", reason: "routed-events-not-indexed", detail: { chainRuns: s.runs.toString(), indexedRuns: String(confirmed.rows[0]?.last ?? 0) } };
  if (s.treasuryRouter !== splitter) {
    // After a router change only what was already paid to the splitter (incl. the A4 flush) is still routed here.
    await opts.alert?.({ severity: "critical", kind: "gen8_router_not_splitter", chainId: cfg.chainId, subject: s.treasuryRouter, title: `Gen-8 hook pays another router on chain ${cfg.chainId}`, message: `hook.treasuryRouter() is ${s.treasuryRouter}, the configured splitter is ${splitter}.` });
  }
  const minWei = opts.minWei ?? 0n;

  // 1. Claim first, only when nothing paid to the splitter is still waiting (so constant trading cannot starve runs).
  if (s.pendingTotal === 0n) {
    if (s.routerOwed === 0n || s.routerOwed < minWei || s.treasuryRouter !== splitter) return { status: "skipped", reason: "nothing-to-claim", detail: { routerOwed: s.routerOwed.toString() } };
    if (!opts.send) return { status: "skipped", reason: "dry-run-would-claim", detail: { routerOwed: s.routerOwed.toString() } };
    if (opts.operatorAddress && opts.operatorAddress.toLowerCase() !== s.operator) {
      await opts.alert?.({ severity: "critical", kind: "gen8_operator_mismatch", chainId: cfg.chainId, title: "Gen-8 operator key is not the splitter operator", message: `key ${opts.operatorAddress}, splitter.operator() ${s.operator}` });
      return { status: "skipped", reason: "operator-key-is-not-the-splitter-operator" };
    }
    const c = await chain.sendClaim();
    return { status: "claimed", txHash: c.hash, blockNumber: c.blockNumber };
  }

  // 2. The run's cut: the claim that brought cumulative paid to P.
  const P = s.paid;
  const cut = claimCut(await claimsToSplitter(db, cfg, n), P);
  if (!cut) return { status: "skipped", reason: "claim-not-indexed-yet", detail: { paid: P.toString() } };
  const rows = await unroutedRowsBefore(db, cfg, cut);

  // 3. The rows must be exactly what the splitter received since the last run.
  const sums = sumRows(rows);
  const B = s.pendingBonding;
  const G = s.pendingGrad;
  const T = s.pendingTotal;
  if (sums.B !== B || sums.G !== G || sums.T !== T) {
    opts.mismatchMemory?.set(`${cfg.chainId}`, (opts.mismatchMemory.get(`${cfg.chainId}`) ?? 0) + 1);
    await opts.alert?.({
      severity: "critical", kind: "gen8_accrual_mismatch", chainId: cfg.chainId, subject: `${P}`,
      title: `Gen-8 fee accruals differ from the claimed bucket on chain ${cfg.chainId}`,
      message: `Up to the claim in ${cut.txHash}: indexed B ${sums.B} G ${sums.G} T ${sums.T}; splitter pending() B ${B} G ${G} T ${T}. No run planned. Should never happen.`,
    });
    return { status: "skipped", reason: "accruals-do-not-match-claim", detail: { claim: cut.txHash, indexed: { B: sums.B.toString(), G: sums.G.toString(), T: sums.T.toString() }, chain: { B: B.toString(), G: G.toString(), T: T.toString() } } };
  }
  opts.mismatchMemory?.delete(`${cfg.chainId}`);
  if (T < minWei) {
    // Audit C-M2 (off-chain part of F4): a foreign claim of a dust bucket would otherwise park the worker for good
    // (pending dust < minimum, and claim-first never claims while something is pending). When the hook holds enough
    // to reach the minimum, claim it too: the next pass plans one run over both claims.
    if (opts.send && s.routerOwed > 0n && T + s.routerOwed >= minWei && s.treasuryRouter === splitter && (!opts.operatorAddress || opts.operatorAddress.toLowerCase() === s.operator)) {
      const c = await chain.sendClaim();
      return { status: "claimed", txHash: c.hash, blockNumber: c.blockNumber };
    }
    return { status: "skipped", reason: "below-minimum", detail: { total: T.toString(), minWei: minWei.toString() } };
  }

  // 4. Amounts (step-2 aggregate rule) within bands(B, G).
  const agg = emptyProfileSums();
  for (const r of rows) addToSums(agg, { kind: r.kind, phase: r.phase, profile: (r.profile as Gen8Profile) || null, fee: big(r.fee) });
  const bands = await s.bands(B, G);
  const local = splitterBands(B, G);
  if (bands.rsaMin !== local.rsaMin || bands.rsaMax !== local.rsaMax || bands.squadMax !== local.squadMax || bands.weekly !== local.weekly || bands.monthly !== local.monthly) {
    await opts.alert?.({ severity: "critical", kind: "gen8_bands_mismatch", chainId: cfg.chainId, title: "MwzFeeSplitter.bands differs from the indexer copy", message: `bands(${B}, ${G}) on chain ${JSON.stringify(bands, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}` });
    return { status: "skipped", reason: "bands-mismatch" };
  }
  const plan = aggregateRunAmounts(agg, bands);

  const runId = s.runs + 1n;
  const leaves: Gen8Leaf[] = rows.map((r) => ({
    chainId: cfg.chainId, splitter, runId, txHash: String(r.tx_hash), logIndex: Number(r.log_index),
    kind: r.kind === "graduation" ? 1 : r.phase === "bonding" ? 0 : 2, trader: r.trader ? String(r.trader) : ethers.ZeroAddress,
    profile: (r.profile as Gen8Profile) || null, fee: big(r.fee), weekly: big(r.league_weekly), monthly: big(r.league_monthly),
    recruiter: big(r.recruiter), squad: big(r.squad), airdrop: big(r.airdrop), protocol: big(r.protocol),
  }));
  // The run's totals leaf: the root also commits to the amounts route() is given.
  leaves.push({ chainId: cfg.chainId, splitter, runId, txHash: ethers.ZeroHash, logIndex: 0, kind: 3, trader: ethers.ZeroAddress, profile: null, fee: B + G, weekly: bands.weekly, monthly: bands.monthly, recruiter: plan.recruiter, squad: plan.squad, airdrop: plan.airdrop, protocol: plan.rounding });
  const root = merkleRoot(leaves.map(gen8LeafHash));
  const leavesJson = leaves.map((l) => ({ ...l, runId: l.runId.toString(), fee: l.fee.toString(), weekly: l.weekly.toString(), monthly: l.monthly.toString(), recruiter: l.recruiter.toString(), squad: l.squad.toString(), airdrop: l.airdrop.toString(), protocol: l.protocol.toString() }));
  const protocol = T - bands.weekly - bands.monthly - plan.recruiter - plan.squad - plan.airdrop;
  const planned: Gen8RoutePass = {
    status: "planned", runId: runId.toString(), expectedPaid: P.toString(), total: T.toString(), bondingFees: B.toString(), gradFees: G.toString(),
    recruiter: plan.recruiter.toString(), squad: plan.squad.toString(), airdrop: plan.airdrop.toString(), rounding: plan.rounding.toString(), root, leaves: leaves.length,
  };
  const writePlan = async (status: "dry_run" | "sent", txHash: string | null) => {
    await db.query(
      `insert into public.evm_gen8_route_runs(
         chain_id, splitter_address, run_id, status, plan_block, total, bonding_fees, grad_fees, weekly_league, monthly_league,
         recruiter, squad, airdrop, protocol, rounding_airdrop, carried, accrual_root, leaf_count, leaves, tx_hash, caller, error, updated_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19::jsonb,$20,$21,null,now())
       on conflict (chain_id, splitter_address, run_id) do update set
         status = excluded.status, plan_block = excluded.plan_block, total = excluded.total, bonding_fees = excluded.bonding_fees,
         grad_fees = excluded.grad_fees, weekly_league = excluded.weekly_league, monthly_league = excluded.monthly_league,
         recruiter = excluded.recruiter, squad = excluded.squad, airdrop = excluded.airdrop, protocol = excluded.protocol,
         rounding_airdrop = excluded.rounding_airdrop, carried = excluded.carried, accrual_root = excluded.accrual_root,
         leaf_count = excluded.leaf_count, leaves = excluded.leaves, tx_hash = excluded.tx_hash, caller = excluded.caller, error = null, updated_at = now()
       where public.evm_gen8_route_runs.status in ('dry_run', 'failed')`,
      [
        cfg.chainId, splitter, runId.toString(), status, n, T.toString(), B.toString(), G.toString(), bands.weekly.toString(), bands.monthly.toString(),
        plan.recruiter.toString(), plan.squad.toString(), plan.airdrop.toString(), protocol.toString(), plan.rounding.toString(),
        JSON.stringify({}),
        root, leaves.length, JSON.stringify(leavesJson), txHash,
        // F11: the wallet expected to send route(); recordRoutedRun compares Routed.caller with it.
        opts.operatorAddress ? opts.operatorAddress.toLowerCase() : null,
      ],
    );
  };
  if (!opts.send) {
    await writePlan("dry_run", null);
    return planned;
  }
  if (opts.operatorAddress && opts.operatorAddress.toLowerCase() !== s.operator) {
    await opts.alert?.({ severity: "critical", kind: "gen8_operator_mismatch", chainId: cfg.chainId, title: "Gen-8 operator key is not the splitter operator", message: `key ${opts.operatorAddress}, splitter.operator() ${s.operator}` });
    return { status: "skipped", reason: "operator-key-is-not-the-splitter-operator" };
  }
  let hash: string;
  try {
    hash = await chain.sendRoute({ runId, expectedPaid: P, recruiter: plan.recruiter, squad: plan.squad, airdrop: plan.airdrop, root });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const data = String((error as any)?.data ?? (error as any)?.info?.error?.data ?? "");
    const paidMismatch = data.startsWith(PAID_MISMATCH_SELECTOR) || /PaidMismatch|3897fc19/.test(msg);
    await writePlan("dry_run", null);
    if (paidMismatch && opts.paidMismatchStreak) {
      // F11: one PaidMismatch is a race; several in a row means someone keeps claiming between our plan and route.
      const streak = (opts.paidMismatchStreak.get(`${cfg.chainId}`) ?? 0) + 1;
      opts.paidMismatchStreak.set(`${cfg.chainId}`, streak);
      if (streak >= (opts.paidMismatchAlertAfter ?? 3)) {
        await opts.alert?.({ severity: "critical", kind: "gen8_paid_mismatch_repeated", chainId: cfg.chainId, subject: `${runId}:${streak}`, title: `Gen-8 route() hit PaidMismatch ${streak} times in a row on chain ${cfg.chainId}`, message: `Run ${runId}: every route() since the last success reverted PaidMismatch (a claim landed between plan and route). Look for foreign claimRouter() calls (gen8_foreign_router_claim).` });
      }
    }
    await db.query(`update public.evm_gen8_route_runs set error = $4 where chain_id = $1 and splitter_address = $2 and run_id = $3`, [cfg.chainId, splitter, runId.toString(), msg.slice(0, 500)]);
    // PaidMismatch: someone claimed after our read; the next pass re-plans up to the newer claim.
    return { status: "skipped", reason: paidMismatch ? "paid-mismatch-replan" : "route-simulation-or-send-failed", detail: { error: msg.slice(0, 300) } };
  }
  await writePlan("sent", hash);
  opts.paidMismatchStreak?.delete(`${cfg.chainId}`);
  return { ...planned, status: "sent", txHash: hash };
}

/** Backlog alert: router money waiting longer than EVM_GEN8_ROUTE_BACKLOG_HOURS without a confirmed run. */
export async function checkGen8Backlog(db: Queryable, cfg: Gen8ChainConfig, hours: number, alert: (a: any) => Promise<unknown>) {
  const r = await db.query(
    `select min(block_time) as oldest, coalesce(sum(router_amount), 0)::text as amount
       from public.evm_gen8_fee_accruals where chain_id = $1 and hook_address = $2 and run_id is null`,
    [cfg.chainId, cfg.hook.address],
  );
  const oldest = r.rows[0]?.oldest ? new Date(r.rows[0].oldest) : null;
  if (oldest && Date.now() - oldest.getTime() > hours * 3_600_000 && big(r.rows[0].amount) > 0n) {
    await alert({ severity: "warning", kind: "gen8_splitter_backlog", chainId: cfg.chainId, title: `Gen-8 router money waiting on chain ${cfg.chainId}`, message: `${r.rows[0].amount} wei accrued since ${oldest.toISOString()} without a confirmed splitter run.` });
    return true;
  }
  return false;
}

function loadOperator(chainId: number, env: NodeJS.ProcessEnv, provider: ethers.JsonRpcProvider): ethers.Wallet | null {
  const raw = String(env[`EVM_GEN8_OPERATOR_KEY_${chainId}`] || env.EVM_GEN8_OPERATOR_KEY || "").trim();
  if (!raw) return null;
  return new ethers.Wallet(raw.startsWith("0x") ? raw : `0x${raw}`, provider);
}

let started = false;

export function startEvmGen8FeeRoutingWorker(opts: { db: Queryable; providerFor: (chainId: number) => ethers.JsonRpcProvider | null; env?: NodeJS.ProcessEnv }) {
  if (started) return;
  started = true;
  const env = opts.env || process.env;
  if (!truthyEnv(env.EVM_GEN8_FEE_ROUTING_ENABLED)) {
    console.log("[gen8-fee] routing off (set EVM_GEN8_FEE_ROUTING_ENABLED=true)");
    return;
  }
  const chains = configuredGen8Chains(env).filter((c) => c.splitter);
  if (!chains.length) {
    console.log("[gen8-fee] routing off (no EVM_GEN8_SPLITTER_<chainId>)");
    return;
  }
  const send = truthyEnv(env.EVM_GEN8_FEE_ROUTING_SEND);
  const ms = intEnv(env.EVM_GEN8_FEE_ROUTING_INTERVAL_MS, 3_600_000, 60_000);
  const backlogHours = intEnv(env.EVM_GEN8_ROUTE_BACKLOG_HOURS, 48, 1);
  let minWei = 10n ** 15n;
  try {
    if (String(env.EVM_GEN8_ROUTE_MIN_WEI || "").trim()) minWei = BigInt(String(env.EVM_GEN8_ROUTE_MIN_WEI).trim());
  } catch {
    // keep default
  }
  const mismatchMemory = new Map<string, number>();
  const paidMismatchStreak = new Map<string, number>();
  const paidMismatchAlertAfter = intEnv(env.EVM_GEN8_PAID_MISMATCH_ALERT_AFTER, 3, 1);
  const dropAfterMs = intEnv(env.EVM_GEN8_ROUTE_DROP_MINUTES, 15, 1) * 60_000;
  void (async () => {
    const watchdog = await import("./payoutWatchdogWorker.js");
    const alert = (a: any) => watchdog.raiseAlert(opts.db as any, { ...a, rewardType: GEN8_ROUTING_ALERT_TYPE });
    for (const cfg of chains) {
      const provider = opts.providerFor(cfg.chainId);
      if (!provider) continue;
      let operator: ethers.Wallet | null = null;
      try {
        operator = send ? loadOperator(cfg.chainId, env, provider) : null;
      } catch (error) {
        console.warn("[gen8-fee] operator key unreadable", { chainId: cfg.chainId, error: error instanceof Error ? error.message : String(error) });
      }
      if (send && !operator) {
        console.warn("[gen8-fee] send mode without EVM_GEN8_OPERATOR_KEY_<chainId>; dry run only", { chainId: cfg.chainId });
      }
      const chain = ethersRouteChain(cfg, provider, operator);
      console.log("[gen8-fee] routing on", { chainId: cfg.chainId, splitter: cfg.splitter!.address, send: Boolean(send && operator), intervalMs: ms });
      let running = false;
      const tick = async () => {
        if (running) return;
        running = true;
        try {
          const r = await runGen8RoutePass({ db: opts.db, cfg, chain, send: Boolean(send && operator), operatorAddress: operator ? await operator.getAddress() : null, minWei, alert, mismatchMemory, paidMismatchStreak, paidMismatchAlertAfter, dropAfterMs });
          console.log("[gen8-fee] pass", { chainId: cfg.chainId, ...r });
          await checkGen8Backlog(opts.db, cfg, backlogHours, alert);
        } catch (error) {
          console.error("[gen8-fee] pass failed", { chainId: cfg.chainId, error: error instanceof Error ? error.message : String(error) });
        } finally {
          running = false;
        }
      };
      const first = setTimeout(() => void tick(), 20_000);
      first.unref?.();
      const timer = setInterval(() => void tick(), ms);
      timer.unref?.();
    }
  })().catch((error) => console.error("[gen8-fee] start failed", error));
}
