/**
 * Gen-8 hold-through holder checks (founder rule, evmGen8HoldThrough.ts): four secret checks per week, one per
 * quarter, from the chain's week secret. Data, not money: taken in a dry run too (as gen-6/7 snapshots), so switching
 * to send mid-week loses nothing.
 *
 * One check of one coin:
 *   - the census balances AND token_holder_sync.last_block of the coin's token are read in ONE statement (a consistent
 *     snapshot: the census writes both in one transaction), so the balances are exactly those at that block;
 *   - the check block is that last_block. Its block time must be in gen8CheckWindow: before the check's moment the
 *     check waits for the census; at or after the window end it is missed (nothing recorded, alert);
 *   - supply = the token's totalSupply() at that block;
 *   - holders = gen8EligibleAt with gen8HardSkip (0xdEaD, zero, the token, the vault, the operator, the human creator
 *     as the vault records it, cfg(id).creator, and evm_gen8_holder_exclusions) and the soft list
 *     (EVM_HOLDER_EXCLUDED_WALLETS + risk-excluded wallets) removed; no code check (founder 2026-10-22: only known
 *     contracts are skipped, gen8ContractFilter); the run row's `holders` is that count, before the 0.01% line;
 *   - the run row and its wallets are written in ONE statement (a CTE): the run row's primary key makes it idempotent
 *     (a second writer inserts nothing at all).
 * Coins are checked for every check whose moment is at or after their launch (gen8RequiredChecks), and only those.
 */
import { CHOICE, previousWeek, weekOf, weekSecret } from "./evmCreatorChoice.js";
import { gen8CheckMoments, gen8CheckWindow, gen8DueCheck, gen8EligibleAt, gen8HardSkip, GEN8_CHECKS, GEN8_HOLDER_RULE } from "./evmGen8HoldThrough.js";
import { gen8ContractFilter, type Gen8ChoiceChain } from "./evmGen8ChoiceChain.js";

export type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };

export type Gen8ChoiceAlert = (a: { severity: "critical" | "warning" | "info"; kind: string; chainId: number; subject?: string; title: string; message: string }) => Promise<unknown>;

export type Gen8ChoiceCoin = {
  poolId: string; // bytes32, lowercase
  token: string; // lowercase
  /** evm_gen8_pools.creator_address (display only; the hard skip uses the vault's cfg(id).creator, as the watchdog). */
  creator: string | null;
  choice: number; // 2 holders, 3 split, 4 buyback
  launchBlock: number;
  /** Launch block time (unix seconds): the block's timestamp, as the watchdog reads it. */
  launchedAt: number;
};

export type Gen8CheckReport = { kind: "check"; subject: string; decision: "sent" | "wait" | "skip" | "blocked"; reason: string };

const lc = (a: string) => String(a || "").toLowerCase();

/** The choice coins of this vault (the vault is their hook creator), holders / split / buyback. */
export async function listGen8ChoiceCoins(db: Queryable, chainId: number, vault: string, chain?: Pick<Gen8ChoiceChain, "blockTime">): Promise<Gen8ChoiceCoin[]> {
  const { rows } = await db.query(
    `select pool_id, token_address, creator_address, fee_choice, launch_block::text as launch_block,
            extract(epoch from launch_time)::bigint::text as launch_time
       from public.evm_gen8_pools
      where chain_id = $1 and fee_choice in (2, 3, 4) and lower(coalesce(hook_creator_address, '')) = $2
      order by pool_id`,
    [chainId, lc(vault)],
  );
  const out: Gen8ChoiceCoin[] = [];
  for (const r of rows) {
    const launchBlock = Number(r.launch_block);
    // The launch block's own timestamp when the chain is at hand (what the watchdog compares launchedAt with).
    const launchedAt = chain ? await chain.blockTime(launchBlock) : r.launch_time == null ? null : Number(r.launch_time);
    if (launchedAt == null) continue;
    out.push({
      poolId: lc(String(r.pool_id)),
      token: lc(String(r.token_address)),
      creator: r.creator_address ? lc(String(r.creator_address)) : null,
      choice: Number(r.fee_choice),
      launchBlock,
      launchedAt,
    });
  }
  return out;
}

/** ONE statement: the token's census cursor and its positive balances at that cursor. lastBlock null: not synced yet. */
export async function readCensusAtCursor(db: Queryable, chainId: number, token: string): Promise<{ lastBlock: number | null; balances: Map<string, bigint> }> {
  const { rows } = await db.query(
    `select s.last_block::text as last_block, b.wallet, b.balance_raw::text as balance
       from public.token_holder_sync s
       left join public.token_holder_balances b
         on b.chain_id = s.chain_id and b.token_address = s.token_address and b.balance_raw > 0
      where s.chain_id = $1 and s.token_address = $2`,
    [chainId, lc(token)],
  );
  const balances = new Map<string, bigint>();
  if (!rows.length) return { lastBlock: null, balances };
  for (const r of rows) if (r.wallet != null) balances.set(lc(String(r.wallet)), BigInt(String(r.balance)));
  return { lastBlock: Number(rows[0].last_block), balances };
}

export type Gen8CheckRow = {
  chainId: number;
  weekId: string;
  poolId: string;
  index: number;
  token: string;
  momentAtMs: number;
  block: number;
  blockTime: number;
  supply: bigint;
  softExcluded: bigint;
  /** The wallets left out at this check for being on the configured or risk list then (lowercase, sorted). */
  softExcludedWallets: string[];
  eligibleSupply: bigint;
  holders: Array<{ owner: string; amount: bigint }>;
};

/** ONE statement: the run row and its wallets, or nothing at all when the run row exists. True when written. */
export async function writeGen8Check(db: Queryable, row: Gen8CheckRow): Promise<boolean> {
  const holders = row.holders.filter((h) => h.amount > 0n).map((h) => ({ wallet: lc(h.owner), amount: h.amount.toString() }));
  const res = await db.query(
    `with run as (
       insert into public.evm_gen8_holder_check_runs
         (chain_id, week_id, pool_id, check_index, token_address, moment_at, block_number, block_time, supply, holders, soft_excluded, eligible_supply, rule, soft_excluded_wallets)
       values ($1, $2, $3, $4, $5, to_timestamp($6::double precision / 1000), $7, $8, $9::numeric, $10, $11::numeric, $12::numeric, $13, $15::text[])
       on conflict (chain_id, week_id, pool_id, check_index) do nothing
       returning chain_id, week_id, pool_id, check_index
     ), wallets as (
       insert into public.evm_gen8_holder_checks (chain_id, week_id, pool_id, check_index, wallet, amount)
       select run.chain_id, run.week_id, run.pool_id, run.check_index, h.wallet, h.amount::numeric
         from run cross join jsonb_to_recordset($14::jsonb) as h(wallet text, amount text)
       returning 1
     )
     select (select count(*) from run)::int as runs, (select count(*) from wallets)::int as wallets`,
    [
      row.chainId, row.weekId, lc(row.poolId), row.index, lc(row.token), row.momentAtMs, row.block, row.blockTime, row.supply.toString(),
      holders.length, row.softExcluded.toString(), row.eligibleSupply.toString(), GEN8_HOLDER_RULE, JSON.stringify(holders),
      [...new Set(row.softExcludedWallets.map(lc))].sort(),
    ],
  );
  return Number(res.rows[0]?.runs ?? 0) === 1;
}

/** Wallets the weekly airdrop refuses for security reasons (same query as evmCreatorChoicePass.riskExcludedWallets). */
export async function gen8RiskExcluded(db: Queryable): Promise<Set<string>> {
  try {
    const { rows } = await db.query(
      `select lower(w.wallet_address) wallet
         from public.wallet_risk_profiles w left join public.wallet_clusters c on c.cluster_id=w.cluster_id
        where w.restricted or lower(coalesce(w.risk_level,'low')) in ('high','critical')
           or coalesce(c.restricted,false) or lower(coalesce(c.risk_level,'low')) in ('high','critical')`,
    );
    return new Set(rows.map((r: any) => String(r.wallet)));
  } catch {
    return new Set();
  }
}

export async function gen8CensusExclusions(db: Queryable, chainId: number): Promise<string[]> {
  const { rows } = await db.query(`select wallet from public.evm_gen8_holder_exclusions where chain_id = $1`, [chainId]);
  return rows.map((r: any) => lc(String(r.wallet)));
}

/** The week's check moments of a chain. */
export function gen8WeekMoments(masterSecret: string, chainId: number, week: { weekId: string; start: Date }): Date[] {
  return gen8CheckMoments(weekSecret(masterSecret, chainId, week.weekId), chainId, week.start);
}

/**
 * Takes every check that is due and not yet recorded, for the week just finished (its last check can still be read
 * while the census is behind the week end) and the current week. Returns one report per decision.
 */
export async function takeGen8Checks(input: {
  db: Queryable;
  chainId: number;
  chain: Gen8ChoiceChain;
  coins: Gen8ChoiceCoin[];
  masterSecret: string;
  now: Date;
  /** The vault's operator (hard skip). */
  operator: string;
  /** EVM_HOLDER_EXCLUDED_WALLETS (lowercase); risk-excluded wallets are added here. */
  excluded: Set<string>;
  alert?: Gen8ChoiceAlert;
}): Promise<Gen8CheckReport[]> {
  const { db, chainId, chain } = input;
  const out: Gen8CheckReport[] = [];
  const holderCoins = input.coins.filter((c) => c.choice === CHOICE.holders || c.choice === CHOICE.split);
  if (!holderCoins.length) return out;
  let soft: Set<string> | null = null;
  let census: string[] | null = null;
  const vaultCreator = new Map<string, string>();
  const current = weekOf(input.now);
  for (const week of [previousWeek(input.now), current]) {
    const moments = gen8WeekMoments(input.masterSecret, chainId, week);
    const due = week.weekId === current.weekId ? gen8DueCheck(moments, input.now) : GEN8_CHECKS - 1;
    if (due == null) continue;
    for (const coin of holderCoins) {
      const pending: number[] = [];
      for (let i = 0; i <= due; i += 1) if (Math.floor(moments[i].getTime() / 1000) >= coin.launchedAt) pending.push(i);
      if (!pending.length) continue;
      const done = await db.query(
        `select check_index from public.evm_gen8_holder_check_runs where chain_id = $1 and week_id = $2 and pool_id = $3`,
        [chainId, week.weekId, coin.poolId],
      );
      const have = new Set(done.rows.map((r: any) => Number(r.check_index)));
      const open = pending.filter((i) => !have.has(i));
      if (!open.length) continue;
      const snap = await readCensusAtCursor(db, chainId, coin.token);
      const subject = `${week.weekId}:${coin.poolId}`;
      if (snap.lastBlock == null) {
        out.push({ kind: "check", subject, decision: "wait", reason: "the holder census has not synced this coin yet" });
        continue;
      }
      const blockTime = await chain.blockTime(snap.lastBlock);
      for (const i of open) {
        const win = gen8CheckWindow(moments, i, week.end);
        if (blockTime < win.from) {
          out.push({ kind: "check", subject: `${subject}:${i}`, decision: "wait", reason: `census block ${snap.lastBlock} (${blockTime}) is before the check moment ${win.from}` });
          break;
        }
        if (blockTime >= win.to) {
          out.push({ kind: "check", subject: `${subject}:${i}`, decision: "blocked", reason: `missed: census block ${snap.lastBlock} (${blockTime}) is past the window end ${win.to}` });
          await input.alert?.({
            severity: "critical", kind: "gen8_choice_check_missed", chainId, subject: `${week.weekId}:${i}:${coin.poolId}`,
            title: `Gen-8 holder check ${i} of ${week.weekId} missed on chain ${chainId}`,
            message: `Coin ${coin.poolId} (${coin.token}): the census block ${snap.lastBlock} at ${blockTime} is already past the window [${win.from}, ${win.to}). Nothing was recorded; the coin's holder pot rolls over this week.`,
          });
          continue;
        }
        soft ??= new Set([...input.excluded, ...(await gen8RiskExcluded(db))]);
        census ??= await gen8CensusExclusions(db, chainId);
        if (!vaultCreator.has(coin.poolId)) vaultCreator.set(coin.poolId, (await chain.coin(coin.poolId)).creator);
        const skip = gen8HardSkip({ token: coin.token, vault: chain.vault, operator: input.operator, creator: vaultCreator.get(coin.poolId) ?? null, censusExclusions: census });
        // H1 (founder 2026-10-22): only known contracts are skipped; gen8ContractFilter is empty and reads no code.
        const contracts = gen8ContractFilter([...snap.balances.keys()].filter((w) => !skip.has(w)));
        const supply = await chain.totalSupplyAt(coin.token, snap.lastBlock);
        if (supply <= 0n) {
          out.push({ kind: "check", subject: `${subject}:${i}`, decision: "blocked", reason: "totalSupply is zero" });
          continue;
        }
        const eligible = gen8EligibleAt(snap.balances, skip, soft, contracts);
        // The same filter as gen8EligibleAt up to its soft step: the wallets the soft list removed at this check.
        const softWallets = [...snap.balances.entries()]
          .filter(([w, a]) => a > 0n && !skip.has(lc(w)) && !contracts.has(lc(w)) && soft!.has(lc(w)))
          .map(([w]) => lc(w))
          .sort();
        const written = await writeGen8Check(db, {
          chainId, weekId: week.weekId, poolId: coin.poolId, index: i, token: coin.token, momentAtMs: moments[i].getTime(),
          block: snap.lastBlock, blockTime, supply, softExcluded: eligible.softExcluded, softExcludedWallets: softWallets, eligibleSupply: eligible.eligibleSupply, holders: eligible.holders,
        });
        out.push({ kind: "check", subject: `${subject}:${i}`, decision: written ? "sent" : "skip", reason: written ? `${eligible.holders.length} holders at block ${snap.lastBlock}` : "already recorded" });
      }
    }
  }
  return out;
}
