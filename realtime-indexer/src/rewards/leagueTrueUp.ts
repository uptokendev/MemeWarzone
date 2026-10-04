/**
 * League true-up (2026-10-04). Settlement records the fee-budget share each category was settled with
 * (league_category_budgets.base_raw). Later runs recompute recent epochs; trades indexed after
 * settlement (weekly 2026-09-14 was settled on ~1% of its final fees; the vault had the money, winners
 * never got it) are credited to the same category of the epoch that is open now
 * (league_late_fee_credits), and the baseline is raised in the same transaction. Late money is never
 * stranded and never paid twice. Credits are not league_rollovers rows: settlement deletes a whole
 * rollover row when a no-winner category later gets a winner, which would wipe a credit stored there.
 */

type Db = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
  connect: () => Promise<{
    query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
    release: () => void;
  }>;
};

type Period = "weekly" | "monthly";

/** Category i's share of `total` split over `count`, dust to the first categories (the pot rule). */
export function categoryShare(total: bigint, count: number, index: number): bigint {
  if (count <= 0) return 0n;
  const base = total / BigInt(count);
  const rem = total % BigInt(count);
  return base + (BigInt(index) < rem ? 1n : 0n);
}

function isMissingRelation(error: unknown) {
  const code = (error as { code?: string })?.code;
  return code === "42P01" || code === "42703";
}

/** Late-indexed fees credited to this epoch/category (0 before the migration). */
export async function getLateFeeCreditsRaw(db: Db, chainId: number, period: Period, epochStartIso: string, category: string) {
  try {
    const { rows } = await db.query(
      `select coalesce(sum(amount_raw),0)::numeric(78,0) as amount_raw
         from public.league_late_fee_credits
        where chain_id=$1 and period=$2 and target_epoch_start=$3::timestamptz and category=$4`,
      [chainId, period, epochStartIso, category]
    );
    return BigInt(String(rows?.[0]?.amount_raw ?? "0"));
  } catch (error) {
    if (isMissingRelation(error)) return 0n;
    throw error;
  }
}

/** The fee-budget share a category was settled with. First write wins; never throws. */
export async function recordBudgetBaseline(db: Db, chainId: number, period: Period, epochStartIso: string, category: string, baseRaw: bigint) {
  try {
    await db.query(
      `insert into public.league_category_budgets (chain_id, period, epoch_start, category, base_raw)
       values ($1, $2, $3::timestamptz, $4, $5::numeric)
       on conflict (chain_id, period, epoch_start, category) do nothing`,
      [chainId, period, epochStartIso, category, baseRaw.toString()]
    );
  } catch (error) {
    // Never blocks settlement. No baseline only means no true-up for this category: the safe direction.
    if (!isMissingRelation(error)) {
      console.warn(`[leagueTrueUp] budget baseline not recorded chain=${chainId} period=${period} category=${category}: ${(error as Error)?.message || error}`);
    }
  }
}

/**
 * For each settled source epoch, recompute the fee budget; when a category's share grew, credit the
 * difference to the same category of `targetStart` and raise the baseline (compare-and-set, one
 * transaction: a concurrent run cannot apply it twice). A share that shrank is only logged: paid prizes
 * are never clawed back. Returns the credits applied.
 */
export async function trueUpLateFees(
  db: Db,
  input: {
    chainId: number;
    period: Period;
    categories: readonly string[];
    budgetBps: number;
    sources: Array<{ start: Date; end: Date }>;
    targetStart: Date;
    computeFee: (startIso: string, endIso: string) => Promise<bigint>;
  },
): Promise<Array<{ source: string; category: string; amount: bigint }>> {
  const { chainId, period, categories } = input;
  const targetIso = input.targetStart.toISOString();
  const applied: Array<{ source: string; category: string; amount: bigint }> = [];

  for (const source of input.sources) {
    const sourceIso = source.start.toISOString();
    if (source.end.getTime() > input.targetStart.getTime()) continue; // only ended epochs
    let baselines: Map<string, bigint>;
    try {
      const { rows } = await db.query(
        `select category, base_raw::text as base_raw from public.league_category_budgets
          where chain_id=$1 and period=$2 and epoch_start=$3::timestamptz`,
        [chainId, period, sourceIso]
      );
      baselines = new Map(rows.map((row: any) => [String(row.category), BigInt(String(row.base_raw))]));
    } catch (error) {
      if (isMissingRelation(error)) return applied;
      throw error;
    }
    if (!baselines.size) continue;

    const fee = await input.computeFee(sourceIso, source.end.toISOString());
    const budget = (fee * BigInt(input.budgetBps)) / 10_000n;
    for (let i = 0; i < categories.length; i++) {
      const category = categories[i];
      const settled = baselines.get(category);
      if (settled === undefined) continue;
      const fresh = categoryShare(budget, categories.length, i);
      const delta = fresh - settled;
      if (delta < 0n) {
        console.warn(`[leagueTrueUp] chain=${chainId} period=${period} epoch=${sourceIso} category=${category}: fee share fell by ${-delta}; nothing clawed back`);
        continue;
      }
      if (delta === 0n) continue;
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const raised = await client.query(
          `update public.league_category_budgets
              set base_raw = $5::numeric, trued_up_raw = trued_up_raw + $6::numeric, updated_at = now()
            where chain_id=$1 and period=$2 and epoch_start=$3::timestamptz and category=$4 and base_raw = $7::numeric`,
          [chainId, period, sourceIso, category, fresh.toString(), delta.toString(), settled.toString()]
        );
        if ((raised.rowCount ?? 0) !== 1) {
          await client.query("ROLLBACK");
          continue;
        }
        await client.query(
          `insert into public.league_late_fee_credits (chain_id, period, source_epoch_start, category, target_epoch_start, amount_raw)
           values ($1, $2, $3::timestamptz, $4, $5::timestamptz, $6::numeric)
           on conflict (chain_id, period, source_epoch_start, category, target_epoch_start)
           do update set amount_raw = public.league_late_fee_credits.amount_raw + excluded.amount_raw, updated_at = now()`,
          [chainId, period, sourceIso, category, targetIso, delta.toString()]
        );
        await client.query("COMMIT");
        applied.push({ source: sourceIso, category, amount: delta });
        console.log(`[leagueTrueUp] chain=${chainId} period=${period} epoch=${sourceIso} category=${category}: +${delta} late fees -> ${targetIso}`);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        console.error(`[leagueTrueUp] FAILED chain=${chainId} period=${period} epoch=${sourceIso} category=${category}: ${(error as Error)?.message || error}`);
      } finally {
        client.release();
      }
    }
  }
  return applied;
}
