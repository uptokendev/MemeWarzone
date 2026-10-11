/**
 * Gen-8 fee routing worker (D1 = A, design 3.4; audit 4.5 / 10.2). The accrual rows are written by the ingest loop
 * (evmGen8Pool.ts); this worker plans and (only in send mode) sends MwzFeeSplitter.route().
 *
 * One pass, per chain with EVM_GEN8_SPLITTER_<id>:
 *   1. Read, at the last block the gen-8 ingest has fully indexed (N): splitter.runs(), splitter.pending(), and the
 *      hook's routerOwed / pendingBondingFees / pendingGradFees / treasuryRouter. What route() will move if sent now:
 *      total T = pending.total + routerOwed, B = pending.B + pendingBondingFees, G = pending.G + pendingGradFees.
 *   2. The accrual rows not yet covered by a run, up to N, must add up to exactly T, B and G. Otherwise the indexer is
 *      missing logs and nothing is planned (alert after repeated mismatches).
 *   3. Amounts from the rows of this run only (since the last Routed), one floor per pot on their summed numerators,
 *      clamped into bands(B, G) read from the splitter (and checked against the local copy): aggregateRunAmounts.
 *   4. accrualRoot over the planned rows (leaf format in evmGen8Fees.ts), stored with the plan.
 *   5. Dry run (default): the plan is written as status 'dry_run' and logged. Send mode (EVM_GEN8_FEE_ROUTING_SEND=1
 *      and EVM_GEN8_OPERATOR_KEY_<id>): staticCall first, then route(runs + 1, ...), status 'sent' with the hash.
 * A run is confirmed only by its Routed event (recordRoutedRun, called by the ingest loop): the run's actual amounts are
 * written from the event and every uncovered accrual row before the Routed log is assigned to it (rows the run's claim
 * swept in after the plan are flagged run_late: covered by the money, not in that run's root; their recruiter / squad /
 * airdrop share stayed in protocol for that run, which the run_late flag makes visible for a manual true-up).
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

/** Called by the ingest loop for every Routed log of the splitter. Idempotent. */
export async function recordRoutedRun(db: Queryable, cfg: Gen8ChainConfig, e: RoutedEvent, at: Date) {
  if (!cfg.splitter) return;
  const splitter = cfg.splitter.address;
  const runId = Number(e.runId);
  const r = e.run;
  const prior = await db.query(`select status, leaves, accrual_root from public.evm_gen8_route_runs where chain_id = $1 and splitter_address = $2 and run_id = $3`, [cfg.chainId, splitter, runId]);
  const planned = prior.rows[0];
  const plannedKeys = new Set<string>(
    planned && String(planned.accrual_root || "").toLowerCase() === e.accrualRoot.toLowerCase() && Array.isArray(planned.leaves)
      ? planned.leaves.filter((l: any) => l.kind !== 3).map((l: any) => `${String(l.txHash).toLowerCase()}:${Number(l.logIndex)}`)
      : [],
  );
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
  const rows = await db.query(
    `select id, tx_hash, log_index from public.evm_gen8_fee_accruals
      where chain_id = $1 and hook_address = $2 and run_id is null
        and (block_number < $3 or (block_number = $3 and log_index < $4))`,
    [cfg.chainId, cfg.hook.address, e.blockNumber, e.logIndex],
  );
  for (const row of rows.rows) {
    const late = !plannedKeys.has(`${String(row.tx_hash).toLowerCase()}:${Number(row.log_index)}`);
    await db.query(`update public.evm_gen8_fee_accruals set run_id = $2, run_late = $3 where id = $1 and run_id is null`, [row.id, runId, late]);
  }
  void at;
}

export type Gen8RouteState = {
  runs: bigint;
  pendingTotal: bigint;
  pendingBonding: bigint;
  pendingGrad: bigint;
  routerOwed: bigint;
  hookPendingBonding: bigint;
  hookPendingGrad: bigint;
  treasuryRouter: string;
  operator: string;
  bands: (b: bigint, g: bigint) => Promise<{ weekly: bigint; monthly: bigint; rsaMin: bigint; rsaMax: bigint; squadMax: bigint }>;
};

export type Gen8RouteChain = {
  readState(blockTag: number): Promise<Gen8RouteState>;
  /** Simulate then send route(); returns the tx hash. Never called in dry-run mode. */
  sendRoute(args: { runId: bigint; recruiter: bigint; squad: bigint; airdrop: bigint; root: string }): Promise<string>;
  waitReceipt(hash: string): Promise<{ status: number } | null>;
  headBlock(): Promise<number>;
};

export function ethersRouteChain(cfg: Gen8ChainConfig, provider: ethers.JsonRpcProvider, signer: ethers.Signer | null): Gen8RouteChain {
  if (!cfg.splitter) throw new Error("gen8 routing: no splitter");
  const splitterRead = new ethers.Contract(cfg.splitter.address, GEN8_SPLITTER_ABI as unknown as string[], provider) as any;
  const hook = new ethers.Contract(cfg.hook.address, GEN8_HOOK_IFACE, provider) as any;
  return {
    async readState(blockTag) {
      const o = { blockTag };
      const [runs, pending, routerOwed, hb, hg, router, operator] = await Promise.all([
        splitterRead.runs(o), splitterRead.pending(o), hook.routerOwed(o), hook.pendingBondingFees(o), hook.pendingGradFees(o), hook.treasuryRouter(o), splitterRead.operator(o),
      ]);
      return {
        runs: BigInt(runs), pendingTotal: BigInt(pending[0]), pendingBonding: BigInt(pending[1]), pendingGrad: BigInt(pending[2]),
        routerOwed: BigInt(routerOwed), hookPendingBonding: BigInt(hb), hookPendingGrad: BigInt(hg),
        treasuryRouter: String(router).toLowerCase(), operator: String(operator).toLowerCase(),
        bands: async (b, g) => {
          const r = await splitterRead.bands(b, g);
          return { weekly: BigInt(r[0]), monthly: BigInt(r[1]), rsaMin: BigInt(r[2]), rsaMax: BigInt(r[3]), squadMax: BigInt(r[4]) };
        },
      };
    },
    async sendRoute(a) {
      if (!signer) throw new Error("gen8 routing: no operator key");
      const c = splitterRead.connect(signer) as any;
      await c.route.staticCall(a.runId, a.recruiter, a.squad, a.airdrop, a.root);
      const tx = await c.route(a.runId, a.recruiter, a.squad, a.airdrop, a.root);
      return String(tx.hash);
    },
    async waitReceipt(hash) {
      const r = await provider.waitForTransaction(hash, 1, 120_000);
      return r ? { status: Number(r.status) } : null;
    },
    headBlock: () => provider.getBlockNumber(),
  };
}

export type Gen8RoutePass =
  | { status: "skipped"; reason: string; detail?: Record<string, unknown> }
  | { status: "planned" | "sent"; runId: string; total: string; bondingFees: string; gradFees: string; recruiter: string; squad: string; airdrop: string; roundingAirdrop: string; root: string; leaves: number; txHash?: string };

const big = (v: unknown) => BigInt(String(v ?? "0").split(".")[0] || "0");

/**
 * One planning (and in send mode, sending) pass. `alert` is raiseAlert bound to reward_alerts.
 */
export async function runGen8RoutePass(opts: {
  db: Queryable;
  cfg: Gen8ChainConfig;
  chain: Gen8RouteChain;
  send: boolean;
  operatorAddress?: string | null;
  minWei?: bigint;
  alert?: (a: { severity: "critical" | "warning" | "info"; kind: string; chainId: number; subject?: string; title: string; message: string }) => Promise<unknown>;
  mismatchMemory?: Map<string, number>;
}): Promise<Gen8RoutePass> {
  const { db, cfg, chain } = opts;
  if (!cfg.splitter) return { status: "skipped", reason: "no-splitter" };
  const splitter = cfg.splitter.address;
  const cursor = await db.query(`select last_indexed_block from public.indexer_state where chain_id = $1 and cursor = $2`, [cfg.chainId, `gen8:${cfg.hook.address}`]);
  const indexedThrough = Number(cursor.rows[0]?.last_indexed_block || 0) - 1;
  if (indexedThrough < cfg.startBlock) return { status: "skipped", reason: "not-indexed-yet" };
  const n = Math.min(indexedThrough, await chain.headBlock());

  // A sent run waiting for its Routed event (or that failed) blocks a new plan.
  const open = await db.query(`select run_id, tx_hash from public.evm_gen8_route_runs where chain_id = $1 and splitter_address = $2 and status = 'sent' order by run_id desc limit 1`, [cfg.chainId, splitter]);
  if (open.rows[0]) {
    const receipt = open.rows[0].tx_hash ? await chain.waitReceipt(String(open.rows[0].tx_hash)).catch(() => null) : null;
    if (receipt && receipt.status === 0) {
      await db.query(`update public.evm_gen8_route_runs set status = 'failed', error = 'reverted', updated_at = now() where chain_id = $1 and splitter_address = $2 and run_id = $3 and status = 'sent'`, [cfg.chainId, splitter, open.rows[0].run_id]);
    } else {
      return { status: "skipped", reason: "run-sent-awaiting-routed", detail: { runId: String(open.rows[0].run_id), tx: open.rows[0].tx_hash } };
    }
  }

  const s = await chain.readState(n);
  if (s.treasuryRouter !== splitter) {
    await opts.alert?.({ severity: "critical", kind: "gen8_router_not_splitter", chainId: cfg.chainId, subject: s.treasuryRouter, title: `Gen-8 hook pays another router on chain ${cfg.chainId}`, message: `hook.treasuryRouter() is ${s.treasuryRouter}, the configured splitter is ${splitter}. No run planned.` });
    return { status: "skipped", reason: "treasury-router-is-not-the-splitter" };
  }
  const confirmed = await db.query(
    `select coalesce(max(run_id), 0) as last, coalesce(sum(recruiter), 0)::text as r, coalesce(sum(squad), 0)::text as q, coalesce(sum(airdrop), 0)::text as a, max(updated_at) as at
       from public.evm_gen8_route_runs where chain_id = $1 and splitter_address = $2 and status = 'confirmed'`,
    [cfg.chainId, splitter],
  );
  const lastConfirmed = BigInt(confirmed.rows[0]?.last ?? 0);
  if (lastConfirmed !== s.runs) return { status: "skipped", reason: "routed-events-not-indexed", detail: { chainRuns: s.runs.toString(), indexedRuns: lastConfirmed.toString() } };

  const T = s.pendingTotal + s.routerOwed;
  const B = s.pendingBonding + s.hookPendingBonding;
  const G = s.pendingGrad + s.hookPendingGrad;
  const minWei = opts.minWei ?? 0n;
  if (T === 0n || T < minWei) return { status: "skipped", reason: "below-minimum", detail: { total: T.toString(), minWei: minWei.toString() } };

  const rowsRes = await db.query(
    `select tx_hash, log_index, block_number, kind, phase, trader, profile, fee, router_amount, league_weekly, league_monthly, recruiter, squad, airdrop, protocol
       from public.evm_gen8_fee_accruals
      where chain_id = $1 and hook_address = $2 and run_id is null and block_number <= $3
      order by block_number, log_index`,
    [cfg.chainId, cfg.hook.address, n],
  );
  const rows = rowsRes.rows;
  let sumB = 0n;
  let sumG = 0n;
  let sumRouter = 0n;
  for (const r of rows) {
    if (r.kind === "graduation") sumG += big(r.fee);
    else if (r.phase === "bonding") sumB += big(r.fee);
    sumRouter += big(r.router_amount);
  }
  if (sumB !== B || sumG !== G || sumRouter !== T) {
    // Read at the block the indexer is complete through, so any difference is a real gap (step-2 rule: alert on it).
    opts.mismatchMemory?.set(`${cfg.chainId}`, (opts.mismatchMemory.get(`${cfg.chainId}`) ?? 0) + 1);
    await opts.alert?.({
      severity: "critical", kind: "gen8_accrual_mismatch", chainId: cfg.chainId,
      title: `Gen-8 fee accruals differ from the hook ledger on chain ${cfg.chainId}`,
      message: `At block ${n}: indexed B ${sumB} G ${sumG} T ${sumRouter}; hook + splitter (pendingBondingFees / pendingGradFees / routerOwed + pending()) B ${B} G ${G} T ${T}. No run planned.`,
    });
    return { status: "skipped", reason: "accruals-do-not-match-chain", detail: { block: n, indexed: { B: sumB.toString(), G: sumG.toString(), T: sumRouter.toString() }, chain: { B: B.toString(), G: G.toString(), T: T.toString() } } };
  }
  opts.mismatchMemory?.delete(`${cfg.chainId}`);

  // The run covers exactly the rows since the last Routed event (step-2 rule); one floor per pot on their sums.
  const sums = emptyProfileSums();
  for (const r of rows) addToSums(sums, { kind: r.kind, phase: r.phase, profile: (r.profile as Gen8Profile) || null, fee: big(r.fee) });

  const bands = await s.bands(B, G);
  const local = splitterBands(B, G);
  if (bands.rsaMin !== local.rsaMin || bands.rsaMax !== local.rsaMax || bands.squadMax !== local.squadMax || bands.weekly !== local.weekly || bands.monthly !== local.monthly) {
    await opts.alert?.({ severity: "critical", kind: "gen8_bands_mismatch", chainId: cfg.chainId, title: "MwzFeeSplitter.bands differs from the indexer copy", message: `bands(${B}, ${G}) on chain ${JSON.stringify(bands, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}` });
    return { status: "skipped", reason: "bands-mismatch" };
  }
  const plan = aggregateRunAmounts(sums, bands);

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
    status: "planned", runId: runId.toString(), total: T.toString(), bondingFees: B.toString(), gradFees: G.toString(),
    recruiter: plan.recruiter.toString(), squad: plan.squad.toString(), airdrop: plan.airdrop.toString(), roundingAirdrop: plan.rounding.toString(), root, leaves: leaves.length,
  };
  const writePlan = async (status: "dry_run" | "sent", txHash: string | null) => {
    await db.query(
      `insert into public.evm_gen8_route_runs(
         chain_id, splitter_address, run_id, status, plan_block, total, bonding_fees, grad_fees, weekly_league, monthly_league,
         recruiter, squad, airdrop, protocol, rounding_airdrop, carried, accrual_root, leaf_count, leaves, tx_hash, error, updated_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19::jsonb,$20,null,now())
       on conflict (chain_id, splitter_address, run_id) do update set
         status = excluded.status, plan_block = excluded.plan_block, total = excluded.total, bonding_fees = excluded.bonding_fees,
         grad_fees = excluded.grad_fees, weekly_league = excluded.weekly_league, monthly_league = excluded.monthly_league,
         recruiter = excluded.recruiter, squad = excluded.squad, airdrop = excluded.airdrop, protocol = excluded.protocol,
         rounding_airdrop = excluded.rounding_airdrop, carried = excluded.carried, accrual_root = excluded.accrual_root,
         leaf_count = excluded.leaf_count, leaves = excluded.leaves, tx_hash = excluded.tx_hash, error = null, updated_at = now()
       where public.evm_gen8_route_runs.status in ('dry_run', 'failed')`,
      [
        cfg.chainId, splitter, runId.toString(), status, n, T.toString(), B.toString(), G.toString(), bands.weekly.toString(), bands.monthly.toString(),
        plan.recruiter.toString(), plan.squad.toString(), plan.airdrop.toString(), protocol.toString(), plan.rounding.toString(),
        JSON.stringify({}),
        root, leaves.length, JSON.stringify(leavesJson), txHash,
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
    hash = await chain.sendRoute({ runId, recruiter: plan.recruiter, squad: plan.squad, airdrop: plan.airdrop, root });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await writePlan("dry_run", null);
    await db.query(`update public.evm_gen8_route_runs set error = $4 where chain_id = $1 and splitter_address = $2 and run_id = $3`, [cfg.chainId, splitter, runId.toString(), msg.slice(0, 500)]);
    return { status: "skipped", reason: "route-simulation-or-send-failed", detail: { error: msg.slice(0, 300) } };
  }
  await writePlan("sent", hash);
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
          const r = await runGen8RoutePass({ db: opts.db, cfg, chain, send: Boolean(send && operator), operatorAddress: operator ? await operator.getAddress() : null, minWei, alert, mismatchMemory });
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
