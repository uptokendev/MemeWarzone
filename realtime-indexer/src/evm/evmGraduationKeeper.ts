/**
 * EVM graduation keeper for the launch generation (campaign generation 5), modelled on the Solana DBC
 * keeper (src/dbc/dbcGraduationKeeper.ts). Spec: docs/evm-launch/spec/C5-graduation.md.
 *
 * Per campaign, one step per pass, every step simulated (eth_call + estimateGas) before anything is sent:
 *   1. Graduated and a protocol fee escrowed (router refused routeFinalize) -> flushProtocolGraduationFee().
 *   2. Pending -> graduate(), when it simulates and fits the gas cap.
 *   3. graduate() reverts or exceeds the cap (a pre-made Robinhood pool seeded with bids) -> repairPool(limit):
 *      limit 0 (all the way) when that fits, else a partial limit between the pool's price and the price
 *      the adapter's repairStep stops at, halving until a step fits: the curve price P for a MEME/WETH
 *      pool; for a MEME/STOCK pool P * ETHUSD / STOCKUSD raised by REPAIR_STEP_MARGIN_BPS, read from the
 *      adapter's two Chainlink feeds exactly as the adapter computes it. BNB's Topaz adapters have no
 *      repairStep (graduate() repairs a Topaz pool itself), so there only graduate() is tried.
 *      A step must sell MEME (memeSold > 0), or it is no progress.
 *   4. A quote coin Pending >= 7 days whose route still fails (E12) -> useNativeFallback(); graduate() next.
 *   5. Otherwise blocked with the named revert; retried next pass.
 *   6. Graduated into a Uniswap V3 pool (Robinhood 4663 / 46630) whose observationCardinalityNext is below
 *      the configured slot count (EVM_KEEPER_V3_OBSERVATION_SLOTS, default 180) ->
 *      pool.increaseObservationCardinalityNext(slots), once. The fail-closed TWAP reads (the Buyback vault's
 *      buybackPool, any future MEME-sale guard) need history the pool only records once its slots are grown.
 *      Permissionless; costs gas proportional to the slots added. Only after any escrowed fee is flushed.
 * Due but not Pending (the crossing buy's oracle read failed, or nobody traded since): the indexed net
 * raise (sum of gen-5 gross buys minus gross sells) is compared with the campaign's native target (a
 * cached view) and the indexed sold amount with curveSupply; a campaign that passes this cheap filter
 * gets an eth_call graduate(), which runs the contract's own due check and enters Pending. GraduationNotDue
 * or TradingNotOpen from that call is "not due" (idle), never "blocked".
 * All four entry points are permissionless on chain; the keeper only saves everyone the wait.
 *
 * Sends: sign locally with an explicit nonce, write the job row (status 'sending', hash, nonce, raw tx)
 * BEFORE broadcasting, then broadcast. After a restart a 'sending' row is resolved by its receipt; with no
 * receipt and the nonce still unused, the same raw transaction is broadcast again (same hash, so it cannot
 * land twice); with the nonce used by something else it is marked 'dropped'. At most one transaction per
 * chain is in flight. Dry-run unless EVM_GRADUATION_KEEPER_SEND=true.
 */
import { ethers } from "ethers";
import { GEN5_CAMPAIGN_ABI } from "./evmGen5Abi.js";

export const NATIVE_FALLBACK_DELAY_SECONDS = 7n * 86_400n;
export const GEN5_CAMPAIGN_IFACE_FULL = new ethers.Interface(GEN5_CAMPAIGN_ABI as unknown as string[]);

export type KeeperAction = "graduate" | "repair" | "native_fallback" | "flush" | "observations";

export type KeeperCall =
  | { action: "graduate"; fn: "graduate"; args: [] }
  | { action: "repair"; fn: "repairPool"; args: [bigint] }
  | { action: "native_fallback"; fn: "useNativeFallback"; args: [] }
  | { action: "flush"; fn: "flushProtocolGraduationFee"; args: [] }
  /** The only call not sent to the campaign: `target` is the graduated Uniswap V3 pool. */
  | { action: "observations"; fn: "increaseObservationCardinalityNext"; args: [number]; target: string };

export const CALLS = {
  graduate: (): KeeperCall => ({ action: "graduate", fn: "graduate", args: [] }),
  repair: (limit: bigint): KeeperCall => ({ action: "repair", fn: "repairPool", args: [limit] }),
  nativeFallback: (): KeeperCall => ({ action: "native_fallback", fn: "useNativeFallback", args: [] }),
  flush: (): KeeperCall => ({ action: "flush", fn: "flushProtocolGraduationFee", args: [] }),
  observations: (pool: string, slots: number): KeeperCall => ({
    action: "observations",
    fn: "increaseObservationCardinalityNext",
    args: [slots],
    target: pool,
  }),
};

export const V3_POOL_OBSERVATIONS_IFACE = new ethers.Interface([
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function increaseObservationCardinalityNext(uint16 observationCardinalityNext)",
]);

/** Where a keeper call goes and its calldata: the campaign, except the observation growth (the pool). */
export function encodeKeeperCall(campaign: string, call: KeeperCall): { to: string; data: string } {
  if (call.action === "observations") {
    return { to: call.target, data: V3_POOL_OBSERVATIONS_IFACE.encodeFunctionData(call.fn, call.args) };
  }
  return { to: campaign, data: GEN5_CAMPAIGN_IFACE_FULL.encodeFunctionData(call.fn, call.args) };
}

/** uint16 slot count; 0 turns the step off. */
export const MAX_V3_OBSERVATION_SLOTS = 65_535;

export type CampaignChainState = {
  launched: boolean;
  graduationPending: boolean;
  pendingSince: bigint;
  quoteToken: string | null;
  nativeFallback: boolean;
  pendingProtocolFee: bigint;
};

export type SimResult =
  | { ok: true; gas: bigint; memeSold?: bigint }
  | { ok: false; error: string };

export type RepairContext = { currentSqrtX96: bigint; targetSqrtX96: bigint };

/** A graduated campaign's Uniswap V3 pool and its slot0().observationCardinalityNext. */
export type ObservationState = { pool: string; cardinalityNext: number };

export type Decision =
  | { kind: "send"; call: KeeperCall; gas: bigint; reason: string }
  | { kind: "idle"; reason: string }
  | { kind: "blocked"; reason: string };

export interface KeeperReader {
  readCampaign(campaign: string): Promise<CampaignChainState>;
  simulate(campaign: string, call: KeeperCall): Promise<SimResult>;
  blockTimestamp(): Promise<bigint>;
  /** Pool price and curve price for partial repair limits; null when unknown (then only limit 0 is tried). */
  repairContext(campaign: string): Promise<RepairContext | null>;
  /** curveSupply and the native graduation target (cached views); nativeTarget null when the oracle reverts. */
  dueInputs?(campaign: string): Promise<DueInputs | null>;
  /**
   * The graduated V3 pool and its observationCardinalityNext; null when there is no V3 pool (Topaz, or
   * the read failed). `minSlots` lets an implementation cache pools already at or above it.
   */
  observationState?(campaign: string, minSlots: number): Promise<ObservationState | null>;
}

export type DueInputs = { curveSupply: bigint; nativeTarget: bigint | null };

export type KeeperConfig = {
  maxGas: bigint;
  minFlushWei: bigint;
  maxRepairHalvings: number;
  /** Due pre-filter slack: a campaign within this many bps of its native target is simulated. Default 200. */
  dueSlackBps?: number;
  /** At most this many due-but-not-pending candidates are simulated per pass. Default 25. */
  maxDueCandidates?: number;
  /**
   * Grow a graduated Uniswap V3 pool's observationCardinalityNext to this many slots (step 6). 0 or
   * absent turns it off (BNB's Topaz pools have no oracle slots). Default 180 on 4663 / 46630.
   */
  v3ObservationSlots?: number;
};

/** Reverts of graduate() that mean "not due yet", not "stuck". */
export const NOT_DUE_REVERTS = new Set(["GraduationNotDue", "TradingNotOpen"]);

/**
 * The cheap due filter over indexed state. Sold-out needs no oracle (the contract's trigger 1); otherwise
 * the net raise must be within `slackBps` of the native target (indexed figures can trail the chain by a
 * block, and the oracle target moves with the price). A null target (oracle down) passes only sold-out.
 */
export function isLikelyDue(input: {
  netRaisedWei: bigint;
  soldRaw: bigint;
  curveSupply: bigint;
  nativeTarget: bigint | null;
  slackBps: number;
}): boolean {
  if (input.curveSupply > 0n && input.soldRaw >= input.curveSupply) return true;
  if (input.nativeTarget === null || input.nativeTarget <= 0n || input.netRaisedWei <= 0n) return false;
  const slack = BigInt(Math.max(0, Math.min(10_000, Math.floor(input.slackBps))));
  return input.netRaisedWei * 10_000n >= input.nativeTarget * (10_000n - slack);
}

function fits(sim: SimResult, cfg: KeeperConfig): sim is { ok: true; gas: bigint; memeSold?: bigint } {
  return sim.ok && sim.gas <= cfg.maxGas;
}

function describe(sim: SimResult, cfg: KeeperConfig): string {
  if (!sim.ok) return sim.error;
  return `gas ${sim.gas} > cap ${cfg.maxGas}`;
}

/**
 * Partial repair limits between the pool's current sqrt price and the curve's: 1/2, 1/4, 1/8 ... of the
 * way from the current price (largest step first). Never 0 (0 means "all the way") and never past the target.
 */
export function partialRepairLimits(ctx: RepairContext, halvings: number): bigint[] {
  const out: bigint[] = [];
  const { currentSqrtX96: cur, targetSqrtX96: target } = ctx;
  if (cur <= 0n || target <= 0n || cur === target) return out;
  const span = target > cur ? target - cur : cur - target;
  for (let k = 1; k <= halvings; k += 1) {
    const step = span >> BigInt(k);
    if (step === 0n) break;
    out.push(target > cur ? cur + step : cur - step);
  }
  return out;
}

/**
 * Decide the next step for one campaign. Pure apart from the injected reader. `dueCandidate` marks a
 * campaign listed by the due filter: when it is not Pending, graduate() is simulated anyway (it enters
 * Pending itself when due); without the flag a campaign that is not Pending is idle.
 */
export async function decideKeeperStep(
  reader: KeeperReader,
  campaign: string,
  cfg: KeeperConfig,
  opts: { dueCandidate?: boolean } = {},
): Promise<Decision> {
  const state = await reader.readCampaign(campaign);

  if (state.launched) {
    if (state.pendingProtocolFee < cfg.minFlushWei || state.pendingProtocolFee === 0n) {
      return decideObservations(reader, campaign, cfg);
    }
    const sim = await reader.simulate(campaign, CALLS.flush());
    if (fits(sim, cfg)) return { kind: "send", call: CALLS.flush(), gas: sim.gas, reason: `escrowed protocol fee ${state.pendingProtocolFee}` };
    return { kind: "blocked", reason: `flush: ${describe(sim, cfg)}` };
  }

  if (!state.graduationPending && !opts.dueCandidate) return { kind: "idle", reason: "not pending" };

  const grad = await reader.simulate(campaign, CALLS.graduate());
  if (fits(grad, cfg)) {
    return { kind: "send", call: CALLS.graduate(), gas: grad.gas, reason: state.graduationPending ? "pending" : "due, not pending" };
  }
  if (!state.graduationPending && !grad.ok && NOT_DUE_REVERTS.has(grad.error)) {
    return { kind: "idle", reason: `not due (${grad.error})` };
  }
  const gradWhy = describe(grad, cfg);

  // A pre-made pool: repair in chunks while a step still sells MEME.
  const full = await reader.simulate(campaign, CALLS.repair(0n));
  if (fits(full, cfg) && (full.memeSold ?? 0n) > 0n) {
    return { kind: "send", call: CALLS.repair(0n), gas: full.gas, reason: `graduate: ${gradWhy}; repair all the way` };
  }
  const fullBlockedByGas = full.ok ? full.gas > cfg.maxGas : /gas/i.test(full.error);
  if (fullBlockedByGas) {
    const ctx = await reader.repairContext(campaign);
    if (ctx) {
      for (const limit of partialRepairLimits(ctx, cfg.maxRepairHalvings)) {
        const part = await reader.simulate(campaign, CALLS.repair(limit));
        if (fits(part, cfg) && (part.memeSold ?? 0n) > 0n) {
          return { kind: "send", call: CALLS.repair(limit), gas: part.gas, reason: `graduate: ${gradWhy}; partial repair` };
        }
      }
    }
  }

  // E12: a quote coin whose route stays dead switches to the native pool after 7 days in Pending.
  // Only from Pending: pendingSince is 0 before, and useNativeFallback() requires Pending.
  if (state.graduationPending && state.quoteToken && !state.nativeFallback) {
    const now = await reader.blockTimestamp();
    if (now >= state.pendingSince + NATIVE_FALLBACK_DELAY_SECONDS) {
      const fb = await reader.simulate(campaign, CALLS.nativeFallback());
      if (fits(fb, cfg)) return { kind: "send", call: CALLS.nativeFallback(), gas: fb.gas, reason: `graduate: ${gradWhy}; quote route dead 7 days` };
      return { kind: "blocked", reason: `graduate: ${gradWhy}; native fallback: ${describe(fb, cfg)}` };
    }
  }

  return { kind: "blocked", reason: `graduate: ${gradWhy}; repair: ${describe(full, cfg)}` };
}

/**
 * Step 6: a graduated campaign's V3 pool below the configured observation slots gets
 * increaseObservationCardinalityNext(slots), simulated and gas-estimated first. Already at or above the
 * slots (by us or anyone) -> idle, so the call happens once.
 */
async function decideObservations(reader: KeeperReader, campaign: string, cfg: KeeperConfig): Promise<Decision> {
  const slots = Math.floor(Number(cfg.v3ObservationSlots ?? 0));
  if (!(slots > 0) || !reader.observationState) return { kind: "idle", reason: "graduated" };
  const obs = await reader.observationState(campaign, slots);
  if (!obs) return { kind: "idle", reason: "graduated" };
  if (obs.cardinalityNext >= slots) {
    return { kind: "idle", reason: `graduated; observations ${obs.cardinalityNext} >= ${slots}` };
  }
  const call = CALLS.observations(obs.pool, slots);
  const sim = await reader.simulate(campaign, call);
  if (fits(sim, cfg)) {
    return { kind: "send", call, gas: sim.gas, reason: `pool ${obs.pool} observations ${obs.cardinalityNext} -> ${slots}` };
  }
  return { kind: "blocked", reason: `observations: ${describe(sim, cfg)}` };
}

// ---------------------------------------------------------------------------------------------------
// Jobs: record before send, resolve after restart
// ---------------------------------------------------------------------------------------------------

export type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };

export interface KeeperSender {
  address: string;
  getNonce(tag: "latest" | "pending"): Promise<number>;
  getReceipt(hash: string): Promise<{ status: number; blockNumber: number } | null>;
  /** Signs a call; never broadcasts. */
  sign(campaign: string, call: KeeperCall, gasLimit: bigint, nonce: number): Promise<{ raw: string; hash: string }>;
  broadcast(raw: string): Promise<void>;
}

export type ResolveResult = { confirmed: number; reverted: number; dropped: number; rebroadcast: number; waiting: number };

/** Errors that mean the node has the transaction or already mined its nonce; the job stays 'sending'. */
export function isBenignBroadcastError(message: string): boolean {
  return /already known|known transaction|nonce too low|replacement transaction underpriced|already imported/i.test(message);
}

export async function resolveSendingJobs(input: {
  db: Queryable;
  chainId: number;
  sender: KeeperSender;
  send: boolean;
}): Promise<ResolveResult> {
  const out: ResolveResult = { confirmed: 0, reverted: 0, dropped: 0, rebroadcast: 0, waiting: 0 };
  const { rows } = await input.db.query(
    `select * from public.evm_graduation_keeper_jobs
      where chain_id = $1 and status = 'sending' order by id`,
    [input.chainId],
  );
  for (const row of rows) {
    const receipt = await input.sender.getReceipt(String(row.tx_hash));
    if (receipt) {
      const ok = Number(receipt.status) === 1;
      await input.db.query(
        `update public.evm_graduation_keeper_jobs
            set status = $2, receipt_block = $3, updated_at = now()
          where id = $1`,
        [row.id, ok ? "confirmed" : "reverted", receipt.blockNumber],
      );
      if (ok) out.confirmed += 1;
      else out.reverted += 1;
      continue;
    }
    const latest = await input.sender.getNonce("latest");
    if (latest > Number(row.nonce)) {
      // Nonce used, no receipt for our hash. Re-check once: the receipt may have just appeared.
      const again = await input.sender.getReceipt(String(row.tx_hash));
      if (again) {
        await input.db.query(
          `update public.evm_graduation_keeper_jobs set status = $2, receipt_block = $3, updated_at = now() where id = $1`,
          [row.id, Number(again.status) === 1 ? "confirmed" : "reverted", again.blockNumber],
        );
        if (Number(again.status) === 1) out.confirmed += 1;
        else out.reverted += 1;
        continue;
      }
      await input.db.query(
        `update public.evm_graduation_keeper_jobs
            set status = 'dropped', last_error = 'nonce used by another transaction', updated_at = now()
          where id = $1`,
        [row.id],
      );
      out.dropped += 1;
      continue;
    }
    if (input.send && row.raw_tx) {
      try {
        await input.sender.broadcast(String(row.raw_tx));
        await input.db.query(
          `update public.evm_graduation_keeper_jobs set attempt = attempt + 1, updated_at = now() where id = $1`,
          [row.id],
        );
        out.rebroadcast += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isBenignBroadcastError(message)) {
          await input.db.query(
            `update public.evm_graduation_keeper_jobs set last_error = $2, updated_at = now() where id = $1`,
            [row.id, message.slice(0, 500)],
          );
        }
      }
    }
    out.waiting += 1;
  }
  return out;
}

export type PassStep = {
  campaign: string;
  decision: Decision;
  jobId?: number | string;
  txHash?: string;
  sent?: boolean;
  error?: string;
};

/**
 * Campaigns the keeper looks at. With `observations`, graduated campaigns that have no confirmed
 * observation-growth job are listed too (step 6); the chain read decides whether one is still needed.
 */
export async function listKeeperCampaigns(db: Queryable, chainId: number, opts: { observations?: boolean } = {}): Promise<string[]> {
  const { rows } = await db.query(
    `select c.campaign_address
       from public.campaigns c
       left join public.evm_campaign_gen5_state s
         on s.chain_id = c.chain_id and s.campaign_address = c.campaign_address
      where c.chain_id = $1
        and coalesce(c.campaign_generation, 0) >= 5
        and (
          s.graduation_stage = 'pending'
          or (s.graduation_stage = 'graduated' and s.protocol_fee_escrowed_raw > s.protocol_fee_flushed_raw)
          or ($2::boolean and s.graduation_stage = 'graduated' and not exists (
                select 1 from public.evm_graduation_keeper_jobs j
                 where j.chain_id = c.chain_id and j.campaign_address = c.campaign_address
                   and j.action = 'observations' and j.status = 'confirmed'))
        )
      order by s.pending_since nulls last, c.campaign_address`,
    [chainId, Boolean(opts.observations)],
  );
  return rows.map((r) => String(r.campaign_address).toLowerCase());
}

/**
 * Gen-5 campaigns still trading (not Pending, not graduated) with their indexed net raise and sold amount,
 * largest raise first. gross_raw is the gen-5 trade annotation (buy: cost without fee, sell: gross before
 * fee), i.e. exactly what moves netRaisedWei; a row the annotation missed falls back to bnb_amount_raw,
 * which only overstates the raise (a pre-filter may overstate; graduate() decides).
 */
export async function listTradingDueCandidates(
  db: Queryable,
  chainId: number,
  limit: number,
): Promise<Array<{ campaign: string; netRaisedWei: bigint; soldRaw: bigint }>> {
  const { rows } = await db.query(
    `select c.campaign_address,
            (coalesce(sum(case when t.side = 'buy' then coalesce(t.gross_raw, t.bnb_amount_raw::numeric) end), 0)
             - coalesce(sum(case when t.side = 'sell' then coalesce(t.gross_raw, t.bnb_amount_raw::numeric) end), 0))::text as net_raised_raw,
            (coalesce(sum(case when t.side = 'buy' then t.token_amount_raw::numeric end), 0)
             - coalesce(sum(case when t.side = 'sell' then t.token_amount_raw::numeric end), 0))::text as sold_raw
       from public.campaigns c
       join public.curve_trades t
         on t.chain_id = c.chain_id and t.campaign_address = c.campaign_address
       left join public.evm_campaign_gen5_state s
         on s.chain_id = c.chain_id and s.campaign_address = c.campaign_address
      where c.chain_id = $1
        and coalesce(c.campaign_generation, 0) >= 5
        and coalesce(s.graduation_stage, 'trading') = 'trading'
        and c.graduated_block is null
      group by c.campaign_address
     having coalesce(sum(case when t.side = 'buy' then coalesce(t.gross_raw, t.bnb_amount_raw::numeric) end), 0)
            - coalesce(sum(case when t.side = 'sell' then coalesce(t.gross_raw, t.bnb_amount_raw::numeric) end), 0) > 0
      order by 2 desc, c.campaign_address
      limit $2`,
    [chainId, Math.max(1, limit)],
  );
  const big = (v: unknown) => {
    const text = String(v ?? "0").split(".")[0];
    return /^-?\d+$/.test(text) ? BigInt(text) : 0n;
  };
  return rows.map((r) => ({
    campaign: String(r.campaign_address).toLowerCase(),
    netRaisedWei: big(r.net_raised_raw),
    soldRaw: big(r.sold_raw),
  }));
}

/** The due filter: indexed candidates whose raise or sold amount says graduate() is worth a call. */
export async function listDueCampaigns(input: {
  db: Queryable;
  chainId: number;
  reader: KeeperReader;
  cfg: KeeperConfig;
}): Promise<string[]> {
  if (!input.reader.dueInputs) return [];
  const limit = input.cfg.maxDueCandidates ?? 25;
  if (limit <= 0) return [];
  const candidates = await listTradingDueCandidates(input.db, input.chainId, limit);
  const out: string[] = [];
  for (const c of candidates) {
    let due: DueInputs | null = null;
    try {
      due = await input.reader.dueInputs(c.campaign);
    } catch {
      due = null;
    }
    if (!due) continue;
    if (
      isLikelyDue({
        netRaisedWei: c.netRaisedWei,
        soldRaw: c.soldRaw,
        curveSupply: due.curveSupply,
        nativeTarget: due.nativeTarget,
        slackBps: input.cfg.dueSlackBps ?? 200,
      })
    ) {
      out.push(c.campaign);
    }
  }
  return out;
}

async function recordBlocked(db: Queryable, chainId: number, campaign: string, reason: string) {
  await db.query(
    `insert into public.evm_graduation_keeper_blocks(chain_id, campaign_address, reason, seen_at)
     values ($1, $2, $3, now())
     on conflict (chain_id, campaign_address) do update set reason = excluded.reason, seen_at = now()`,
    [chainId, campaign, reason.slice(0, 500)],
  );
}

async function clearBlocked(db: Queryable, chainId: number, campaign: string) {
  await db.query(`delete from public.evm_graduation_keeper_blocks where chain_id = $1 and campaign_address = $2`, [chainId, campaign]);
}

/**
 * One keeper pass on one chain: resolve what is in flight, then at most one new transaction.
 * Dry-run (send=false) decides and logs; it writes no job and signs nothing.
 */
export async function runEvmGraduationKeeperPass(input: {
  db: Queryable;
  chainId: number;
  reader: KeeperReader;
  sender: KeeperSender;
  cfg: KeeperConfig;
  send: boolean;
  campaigns?: string[];
  /** Due-but-not-pending campaigns (tests); listed by listDueCampaigns when both lists are omitted. */
  dueCampaigns?: string[];
}): Promise<{ resolved: ResolveResult; steps: PassStep[]; inFlight: boolean }> {
  const resolved = await resolveSendingJobs({ db: input.db, chainId: input.chainId, sender: input.sender, send: input.send });
  const inFlight = resolved.waiting > 0;
  const steps: PassStep[] = [];
  const campaigns =
    input.campaigns ??
    (await listKeeperCampaigns(input.db, input.chainId, { observations: (input.cfg.v3ObservationSlots ?? 0) > 0 }));
  const due = new Set(input.dueCampaigns ?? []);
  if (!input.campaigns && input.dueCampaigns === undefined) {
    try {
      for (const c of await listDueCampaigns({ db: input.db, chainId: input.chainId, reader: input.reader, cfg: input.cfg })) due.add(c);
    } catch (error) {
      console.warn("[evm-grad] due filter failed", { chainId: input.chainId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const all = [...campaigns, ...[...due].filter((c) => !campaigns.includes(c))];
  let sentThisPass = false;

  for (const campaign of all) {
    let decision: Decision;
    try {
      decision = await decideKeeperStep(input.reader, campaign, input.cfg, { dueCandidate: due.has(campaign) });
    } catch (error) {
      steps.push({ campaign, decision: { kind: "blocked", reason: "read failed" }, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const step: PassStep = { campaign, decision };
    steps.push(step);
    if (decision.kind === "blocked") {
      if (input.send) await recordBlocked(input.db, input.chainId, campaign, decision.reason);
      continue;
    }
    if (decision.kind !== "send") continue;
    if (!input.send || inFlight || sentThisPass) continue;

    // Record, then send.
    const gasLimit = (decision.gas * 12n) / 10n + 25_000n;
    const nonce = await input.sender.getNonce("pending");
    const signed = await input.sender.sign(campaign, decision.call, gasLimit, nonce);
    const inserted = await input.db.query(
      `insert into public.evm_graduation_keeper_jobs(
          chain_id, campaign_address, action, call_args, keeper_address, nonce, gas_limit,
          tx_hash, raw_tx, status, reason
       ) values ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,'sending',$10)
       returning id`,
      [
        input.chainId,
        campaign,
        decision.call.action,
        JSON.stringify(decision.call.args.map((a) => String(a))),
        input.sender.address.toLowerCase(),
        nonce,
        gasLimit.toString(),
        signed.hash.toLowerCase(),
        signed.raw,
        decision.reason.slice(0, 500),
      ],
    );
    step.jobId = inserted.rows[0]?.id;
    step.txHash = signed.hash;
    sentThisPass = true;
    await clearBlocked(input.db, input.chainId, campaign);
    try {
      await input.sender.broadcast(signed.raw);
      step.sent = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      step.error = message;
      // The job stays 'sending': the next pass decides by receipt and nonce whether it left.
      await input.db.query(
        `update public.evm_graduation_keeper_jobs set last_error = $2, updated_at = now() where id = $1`,
        [step.jobId, message.slice(0, 500)],
      );
    }
  }
  return { resolved, steps, inFlight };
}

// ---------------------------------------------------------------------------------------------------
// ethers implementations
// ---------------------------------------------------------------------------------------------------

/** Names a revert from its data when it is one of the campaign's custom errors. */
export function revertName(error: unknown): string {
  const e = error as any;
  const data: string | undefined = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
  if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
    try {
      const parsed = GEN5_CAMPAIGN_IFACE_FULL.parseError(data);
      if (parsed) return parsed.name;
    } catch {
      // unknown selector
    }
  }
  return String(e?.shortMessage || e?.reason || e?.message || e).slice(0, 300);
}

const V3_FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const V3_POOL_ABI = ["function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)", "function token0() view returns (address)"];

/** Known Uniswap V3 deployments for the partial-repair price read (C7 section 2). Env overrides. */
const KNOWN_V3: Record<number, { factory: string; weth: string; fee: number }> = {
  4663: { factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA", weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", fee: 3000 },
};

export function bigintSqrt(value: bigint): bigint {
  if (value < 0n) throw new Error("sqrt of negative");
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) >> 1n;
  while (y < x) {
    x = y;
    y = (x + value / x) >> 1n;
  }
  return x;
}

/**
 * Curve price P (wei of native per whole MEME, both 18 decimals) as a V3 sqrtPriceX96 for the MEME/WETH
 * pool: token1/token0 = P / 1e18 when MEME is token0, 1e18 / P otherwise.
 */
export function curvePriceToSqrtX96(priceWei: bigint, memeIsToken0: boolean): bigint {
  if (priceWei <= 0n) return 0n;
  const Q192 = 1n << 192n;
  const WAD = 10n ** 18n;
  return memeIsToken0 ? bigintSqrt((priceWei * Q192) / WAD) : bigintSqrt((WAD * Q192) / priceWei);
}

const WAD = 10n ** 18n;
const BPS = 10_000n;

/** Chainlink answer to a WAD price, as RobinhoodStockGraduationAdapterV2._oraclePriceWad (null = unhealthy). */
export function oraclePriceWad(answer: bigint, decimals: number): bigint | null {
  if (answer <= 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  return decimals <= 18 ? answer * 10n ** BigInt(18 - decimals) : answer / 10n ** BigInt(decimals - 18);
}

/**
 * RobinhoodStockGraduationAdapterV2._repairStepPriceWad: the stock-per-MEME price (stock raw units per
 * 1e18 MEME) at which repairStep stops, P * ETHUSD / STOCKUSD raised by the margin. Floors exactly like
 * the contract's Math.mulDiv, so the partial limits the keeper derives lie strictly inside the range the
 * adapter accepts (limit between the pool's price and this stop).
 */
export function stockRepairStopPriceWad(input: {
  curvePriceWad: bigint;
  nativeUsdWad: bigint;
  stockUsdWad: bigint;
  stockUnit: bigint;
  marginBps: bigint;
}): bigint {
  if (input.stockUsdWad <= 0n) return 0n;
  const estimate = (((input.curvePriceWad * input.nativeUsdWad) / input.stockUsdWad) * input.stockUnit) / WAD;
  return (estimate * (BPS + input.marginBps)) / BPS;
}

const ADAPTER_REPAIR_ABI = [
  "function v3Factory() view returns (address)",
  "function WETH() view returns (address)",
  "function POOL_FEE() view returns (uint24)",
  "function nativeUsdOracle() view returns (address)",
  "function REPAIR_STEP_MARGIN_BPS() view returns (uint256)",
  "function stockRoutes(address) view returns (address oracleFeed, address acquisitionPool, uint24 acquisitionFeeTier, uint256 minimumRouteLiquidityUsdWad, uint16 maxSwapSlippageBps, uint16 maxOracleDeviationBps, uint16 maxPriceImpactBps, bool enabled)",
];
const FEED_ABI = [
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
];
const ERC20_DECIMALS_ABI = ["function decimals() view returns (uint8)"];

export function createEthersKeeperReader(provider: ethers.Provider, chainId: number, from: string, env: NodeJS.ProcessEnv = process.env): KeeperReader {
  const curveSupplyCache = new Map<string, bigint>();
  const targetCache = new Map<string, { at: number; value: bigint | null }>();
  const observationDone = new Map<string, ObservationState>();
  const targetTtlMs = Math.max(5_000, Number(env.EVM_GRADUATION_KEEPER_TARGET_TTL_MS || 60_000) || 60_000);
  const v3 = (() => {
    const known = KNOWN_V3[chainId];
    const factory = String(env[`EVM_KEEPER_V3_FACTORY_${chainId}`] || known?.factory || "").trim();
    const weth = String(env[`EVM_KEEPER_WETH_${chainId}`] || known?.weth || "").trim();
    const fee = Number(env[`EVM_KEEPER_V3_FEE_${chainId}`] || known?.fee || 3000);
    return factory && weth ? { factory, weth, fee } : null;
  })();
  return {
    async readCampaign(campaign) {
      const c = new ethers.Contract(campaign, GEN5_CAMPAIGN_ABI, provider) as any;
      const [launched, pending, since, quote, fallback, fee] = await Promise.all([
        c.launched(),
        c.graduationPending(),
        c.pendingSince(),
        c.graduationQuoteToken(),
        c.nativeFallback(),
        c.pendingProtocolGraduationFee(),
      ]);
      const q = String(quote).toLowerCase();
      return {
        launched: Boolean(launched),
        graduationPending: Boolean(pending),
        pendingSince: BigInt(since),
        quoteToken: q === ethers.ZeroAddress.toLowerCase() ? null : q,
        nativeFallback: Boolean(fallback),
        pendingProtocolFee: BigInt(fee),
      };
    },
    async simulate(campaign, call) {
      const { to, data } = encodeKeeperCall(campaign, call);
      try {
        const result = await provider.call({ to, from, data });
        const gas = await provider.estimateGas({ to, from, data });
        let memeSold: bigint | undefined;
        if (call.fn === "repairPool") {
          const decoded = GEN5_CAMPAIGN_IFACE_FULL.decodeFunctionResult("repairPool", result);
          memeSold = BigInt(decoded[0]);
        }
        return { ok: true, gas: BigInt(gas), memeSold };
      } catch (error) {
        return { ok: false, error: revertName(error) };
      }
    },
    async blockTimestamp() {
      const block = await provider.getBlock("latest");
      return BigInt(block?.timestamp ?? Math.floor(Date.now() / 1000));
    },
    async repairContext(campaign) {
      try {
        const c = new ethers.Contract(campaign, GEN5_CAMPAIGN_ABI, provider) as any;
        const [meme, quote, fallback, state, adapterAddr] = await Promise.all([
          c.token(),
          c.graduationQuoteToken(),
          c.nativeFallback(),
          c.getGraduationState(),
          c.graduationAdapter().catch(() => ethers.ZeroAddress),
        ]);
        const price = BigInt(state.finalCurvePrice ?? state[1]);
        const adapter = new ethers.Contract(String(adapterAddr), ADAPTER_REPAIR_ABI, provider) as any;
        const hasAdapter = String(adapterAddr).toLowerCase() !== ethers.ZeroAddress.toLowerCase();
        // The adapter's own V3 surface first (it is the one repairStep swaps on); env / known as fallback.
        const [aFactory, aWeth, aFee] = hasAdapter
          ? await Promise.all([
              adapter.v3Factory().catch(() => null),
              adapter.WETH().catch(() => null),
              adapter.POOL_FEE().catch(() => null),
            ])
          : [null, null, null];
        const factoryAddr = aFactory ? String(aFactory) : v3?.factory;
        const weth = aWeth ? String(aWeth) : v3?.weth;
        const fee = aFee != null ? Number(aFee) : v3?.fee ?? 3000;
        if (!factoryAddr || !weth) return null;

        const stockQuote = String(quote).toLowerCase() !== ethers.ZeroAddress.toLowerCase() && !fallback ? String(quote) : null;
        const paired = stockQuote ?? weth;
        const factory = new ethers.Contract(factoryAddr, V3_FACTORY_ABI, provider) as any;
        const poolAddr = String(await factory.getPool(meme, paired, fee));
        if (poolAddr === ethers.ZeroAddress) return null;
        const pool = new ethers.Contract(poolAddr, V3_POOL_ABI, provider) as any;
        const [slot0, token0] = await Promise.all([pool.slot0(), pool.token0()]);
        const memeIsToken0 = String(token0).toLowerCase() === String(meme).toLowerCase();
        const currentSqrtX96 = BigInt(slot0.sqrtPriceX96 ?? slot0[0]);

        if (!stockQuote) {
          return { currentSqrtX96, targetSqrtX96: curvePriceToSqrtX96(price, memeIsToken0) };
        }
        // MEME/STOCK (C7 section 2): the adapter's repairStep stops at P * ETHUSD / STOCKUSD raised by its
        // margin, read from the same two Chainlink feeds; partial limits go between the pool and that stop.
        if (!hasAdapter) return null;
        const [nativeOracle, route, margin] = await Promise.all([
          adapter.nativeUsdOracle(),
          adapter.stockRoutes(stockQuote),
          adapter.REPAIR_STEP_MARGIN_BPS().catch(() => 500n),
        ]);
        const stockFeed = String(route.oracleFeed ?? route[0]);
        const readFeed = async (addr: string) => {
          const feed = new ethers.Contract(addr, FEED_ABI, provider) as any;
          const [round, decimals] = await Promise.all([feed.latestRoundData(), feed.decimals()]);
          return oraclePriceWad(BigInt(round.answer ?? round[1]), Number(decimals));
        };
        const [nativeUsdWad, stockUsdWad, stockDecimals] = await Promise.all([
          readFeed(String(nativeOracle)),
          readFeed(stockFeed),
          new ethers.Contract(stockQuote, ERC20_DECIMALS_ABI, provider).decimals(),
        ]);
        if (!nativeUsdWad || !stockUsdWad) return null;
        const stop = stockRepairStopPriceWad({
          curvePriceWad: price,
          nativeUsdWad,
          stockUsdWad,
          stockUnit: 10n ** BigInt(Number(stockDecimals)),
          marginBps: BigInt(margin),
        });
        if (stop <= 0n) return null;
        return { currentSqrtX96, targetSqrtX96: curvePriceToSqrtX96(stop, memeIsToken0) };
      } catch {
        return null;
      }
    },
    async observationState(campaign, minSlots) {
      const known = observationDone.get(campaign);
      if (known && known.cardinalityNext >= minSlots) return known;
      try {
        const c = new ethers.Contract(campaign, GEN5_CAMPAIGN_ABI, provider) as any;
        const state = await c.getGraduationState();
        const pool = String(state.dexPair ?? state[0]);
        if (!ethers.isAddress(pool) || pool.toLowerCase() === ethers.ZeroAddress.toLowerCase()) return null;
        const raw = await provider.call({ to: pool, data: V3_POOL_OBSERVATIONS_IFACE.encodeFunctionData("slot0", []) });
        const slot0 = V3_POOL_OBSERVATIONS_IFACE.decodeFunctionResult("slot0", raw);
        const out = { pool: ethers.getAddress(pool), cardinalityNext: Number(slot0.observationCardinalityNext ?? slot0[4]) };
        if (out.cardinalityNext >= minSlots) observationDone.set(campaign, out);
        return out;
      } catch {
        return null; // not a V3 pool (no slot0 of this shape) or the read failed
      }
    },
    async dueInputs(campaign) {
      const c = new ethers.Contract(campaign, GEN5_CAMPAIGN_ABI, provider) as any;
      let curveSupply = curveSupplyCache.get(campaign);
      if (curveSupply === undefined) {
        curveSupply = BigInt(await c.curveSupply());
        curveSupplyCache.set(campaign, curveSupply);
      }
      const hit = targetCache.get(campaign);
      let nativeTarget: bigint | null;
      if (hit && Date.now() - hit.at < targetTtlMs) {
        nativeTarget = hit.value;
      } else {
        try {
          nativeTarget = BigInt(await c.graduationNativeTarget());
        } catch {
          nativeTarget = null; // oracle down: only a sold-out curve can be due (trigger 1)
        }
        targetCache.set(campaign, { at: Date.now(), value: nativeTarget });
      }
      return { curveSupply, nativeTarget };
    },
  };
}

export function createEthersKeeperSender(provider: ethers.Provider, wallet: ethers.Wallet, chainId: number): KeeperSender {
  const signer = wallet.connect(provider);
  return {
    address: wallet.address,
    getNonce: (tag) => provider.getTransactionCount(wallet.address, tag),
    async getReceipt(hash) {
      const r = await provider.getTransactionReceipt(hash);
      return r ? { status: Number(r.status ?? 0), blockNumber: r.blockNumber } : null;
    },
    async sign(campaign, call, gasLimit, nonce) {
      const { to, data } = encodeKeeperCall(campaign, call);
      const fee = await provider.getFeeData();
      const tx: ethers.TransactionRequest = { to, data, gasLimit, nonce, chainId, value: 0n };
      if (fee.maxFeePerGas != null && fee.maxPriorityFeePerGas != null) {
        tx.type = 2;
        tx.maxFeePerGas = fee.maxFeePerGas;
        tx.maxPriorityFeePerGas = fee.maxPriorityFeePerGas;
      } else {
        tx.type = 0;
        tx.gasPrice = fee.gasPrice ?? undefined;
      }
      const raw = await signer.signTransaction(tx);
      return { raw, hash: ethers.Transaction.from(raw).hash! };
    },
    async broadcast(raw) {
      await (provider as ethers.JsonRpcProvider).broadcastTransaction(raw);
    },
  };
}

/** Deployers and other keys the keeper must never run with. */
export const FORBIDDEN_KEEPER_ADDRESSES = [
  "0x77f96a7d3bea7a090aacbd00a50002d2b9ae0714", // EVM mainnet deployer (deployments/*.json)
  "0x13ad79765e14927df2c554d9662bbe539e89c8e8", // testnet deployer
  "0x1a367016f10b230e28cf1abda2594c47bf60fe34", // testnet deployer
];

export function assertKeeperKeyAllowed(address: string, env: NodeJS.ProcessEnv = process.env): void {
  const extra = String(env.EVM_KEEPER_FORBIDDEN_ADDRESSES || "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
  const forbidden = new Set([...FORBIDDEN_KEEPER_ADDRESSES, ...extra]);
  if (forbidden.has(address.toLowerCase())) {
    throw new Error(`EVM graduation keeper refuses key ${address}: it is a deployer / forbidden address`);
  }
}
