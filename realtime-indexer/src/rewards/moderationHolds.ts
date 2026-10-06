// Moderation holds -- the indexer's copy of frontend/shared/moderationHolds.mjs (that file is the
// canonical one and explains the rules). Same SQL, byte for byte; src/tests/moderationHolds.test.ts
// fails if the two drift.
//
// Used by: finalizeEpochWinners (a voided prize's category is never settled again),
// publishLeagueEpochRoot (an epoch with a held prize waits), publishRecruiterSettlementV2 (held or
// voided credit stays out of the weekly batch), publishRecruiterSettlementRoot (a prepared batch with
// held credit is not posted) and exportLeaguePayoutBatch (held prizes are not exported for payment).
// Selection only: nothing here signs, moves money or rewrites a posted root.

type Db = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

function isoOf(value: unknown): string | null {
  const date = value instanceof Date ? value : new Date(String(value || ""));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** SQL: holds row `h` applies to league_epoch_winners row `w` (item hold, wallet hold, recruiter hold). */
export function leagueHoldMatchSql(h = "h", w = "w"): string {
  return `((${h}.subject_kind = 'league_winner' and ${h}.state in ('held', 'voided')
            and ${h}.chain_id = ${w}.chain_id and ${h}.subject->>'period' = ${w}.period
            and (${h}.subject->>'epochStart')::timestamptz = ${w}.epoch_start
            and ${h}.subject->>'category' = ${w}.category and (${h}.subject->>'rank')::int = ${w}.rank)
        or (${h}.subject_kind = 'wallet' and ${h}.state = 'held'
            and ${h}.wallet_key in (lower(${w}.recipient_address), lower(coalesce(${w}.payload->>'wallet', ${w}.recipient_address))))
        or (${h}.subject_kind = 'recruiter' and ${h}.state = 'held' and ${h}.recruiter_id is not null
            and ${w}.payload->>'recruiterId' = ${h}.recruiter_id::text))`;
}

/** SQL: holds row `h` applies to recruiter_reward_ledger row `l` (item hold or void, recruiter hold). */
export function recruiterLedgerHoldMatchSql(h = "h", l = "l"): string {
  return `((${h}.subject_kind = 'recruiter_ledger' and ${h}.state in ('held', 'voided')
            and ${h}.subject_key = 'recruiter-ledger:' || ${l}.id::text)
        or (${h}.subject_kind = 'recruiter' and ${h}.state = 'held'
            and (${h}.account_id = ${l}.recruiter_id
                 or (${h}.recruiter_id is not null and exists (
                       select 1 from public.recruiters mr join public.recruiter_accounts ma on ma.code = mr.code
                        where mr.id = ${h}.recruiter_id and ma.recruiter_id = ${l}.recruiter_id)))))`;
}

/** SQL: holds row `h` is a blanket hold on wallet expression `walletExpr`. */
export function walletHoldMatchSql(h = "h", walletExpr = "w.wallet_address"): string {
  return `(${h}.subject_kind = 'wallet' and ${h}.state = 'held' and ${h}.wallet_key = lower(${walletExpr}))`;
}

/** False until db/migrations/20261006_000020_moderation_holds.sql is applied (then nothing can be held). */
export async function moderationHoldsAvailable(db: Db): Promise<boolean> {
  const { rows } = await db.query(`select to_regclass('public.moderation_holds') is not null as ok`);
  return Boolean(rows?.[0]?.ok);
}

export type HeldLeagueWinner = { category: string; rank: number; recipient_address: string; subject_kind: string; subject_key: string; state: string; reason: string };

/** Held (or voided-but-still-present) league winners of one epoch: the root publishers wait on these. */
export async function heldLeagueWinners(db: Db, input: { chainId: number; period: string; epochStart: string | Date }): Promise<HeldLeagueWinner[]> {
  if (!(await moderationHoldsAvailable(db))) return [];
  const { rows } = await db.query(
    `select w.category, w.rank, w.recipient_address, h.subject_kind, h.subject_key, h.state, h.reason
       from public.league_epoch_winners w
       join public.moderation_holds h on ${leagueHoldMatchSql("h", "w")}
      where w.chain_id = $1 and w.period = $2 and w.epoch_start = $3::timestamptz
      order by w.category, w.rank`,
    [Number(input.chainId), String(input.period), isoOf(input.epochStart)],
  );
  return rows as HeldLeagueWinner[];
}

/**
 * True when a prize of this epoch/category was voided from the Moderation page. The void removes the
 * winner row; without this check the next settlement run would see an empty category and settle it
 * again (and could pay the same wallet). Places are never renumbered by a void.
 */
export async function voidedLeagueCategory(db: Db, input: { chainId: number; period: string; epochStart: string | Date; category: string }): Promise<boolean> {
  if (!(await moderationHoldsAvailable(db))) return false;
  const { rows } = await db.query(
    `select 1 from public.moderation_holds h
      where h.subject_kind = 'league_winner' and h.state = 'voided'
        and h.chain_id = $1 and h.subject->>'period' = $2
        and (h.subject->>'epochStart')::timestamptz = $3::timestamptz and h.subject->>'category' = $4
      limit 1`,
    [Number(input.chainId), String(input.period), isoOf(input.epochStart), String(input.category)],
  );
  return rows.length > 0;
}

/** recruiter_reward_ledger ids (of `ids`) that are held, voided or belong to a held recruiter. */
export async function heldRecruiterLedgerIds(db: Db, ids: string[]): Promise<Set<string>> {
  const list = ids.map(String).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (!list.length || !(await moderationHoldsAvailable(db))) return new Set();
  const { rows } = await db.query(
    `select distinct l.id::text as id
       from public.recruiter_reward_ledger l
       join public.moderation_holds h on ${recruiterLedgerHoldMatchSql("h", "l")}
      where l.id = any($1::uuid[])`,
    [list],
  );
  return new Set(rows.map((row) => String(row.id)));
}

/** Lower-cased wallets under a blanket hold. */
export async function heldWalletKeys(db: Db): Promise<Set<string>> {
  if (!(await moderationHoldsAvailable(db))) return new Set();
  const { rows } = await db.query(`select wallet_key from public.moderation_holds where subject_kind = 'wallet' and state = 'held' and wallet_key is not null`);
  return new Set(rows.map((row) => String(row.wallet_key || "").trim().toLowerCase()).filter(Boolean));
}

/**
 * Claims of a prepared (not yet posted) Solana recruiter batch that carry held or voided credit, or
 * pay a held wallet. The root publisher does not post such a batch; the next export run rebuilds it
 * without them (a prepared batch is rebuilt on every export).
 */
export async function heldPreparedRecruiterClaims(db: Db, batchId: string): Promise<Array<{ wallet: string; source_ref: string }>> {
  if (!(await moderationHoldsAvailable(db))) return [];
  const { rows } = await db.query(
    `select distinct c.wallet_address as wallet, c.source_ref
       from public.solana_reward_lane_claims c
      where c.batch_id = $1::uuid and c.lane = 'recruiter'
        and (exists (select 1 from public.moderation_holds h where ${walletHoldMatchSql("h", "c.wallet_address")})
             or exists (select 1 from public.recruiter_reward_ledger l
                          join public.moderation_holds h on ${recruiterLedgerHoldMatchSql("h", "l")}
                         where c.source_type = 'recruiter_reward_claim' and l.claim_id::text = c.source_ref))`,
    [batchId],
  );
  return rows as Array<{ wallet: string; source_ref: string }>;
}

export const MODERATION_GLOBAL_LOCK = "mwz-moderation:global";

/** Same keys as frontend/shared/moderationHolds.mjs. */
export function leagueEpochLockKey(chainId: number, period: string, epochStart: string | Date): string {
  return `mwz-league-root:${Number(chainId)}:${String(period)}:${isoOf(epochStart)}`;
}

export function recruiterBatchLockKey(chainId: number, epochId: string | number): string {
  return `mwz-recruiter-batch:${Number(chainId)}:${String(epochId)}`;
}

type PoolLike = Db & { connect: () => Promise<Db & { release: () => void }> };

/**
 * Publication guard (see the API copy for the full protocol): one short transaction that re-checks
 * holds and the list, then writes a marker a moderation action refuses to act through. Transaction
 * locks only, so it is safe on the transaction pooler.
 */
export async function beginGuardedPublish(pool: PoolLike, key: string, check: (client: Db) => Promise<unknown[]>): Promise<{ ok: boolean; guarded?: boolean; problems?: unknown[] }> {
  if (!(await moderationHoldsAvailable(pool))) return { ok: true, guarded: false };
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock_shared(hashtext($1))", [MODERATION_GLOBAL_LOCK]);
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [key]);
    const problems = (await check(client)) || [];
    if (problems.length) {
      await client.query("rollback");
      return { ok: false, problems };
    }
    await client.query(
      `insert into public.moderation_publish_markers (lock_key, started_at) values ($1, now())
       on conflict (lock_key) do update set started_at = now()`,
      [key],
    );
    await client.query("commit");
    return { ok: true, guarded: true };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Clears the marker once the root is recorded (or found on chain and recorded). */
export async function endGuardedPublish(pool: Db, key: string): Promise<void> {
  if (!(await moderationHoldsAvailable(pool))) return;
  await pool.query(`delete from public.moderation_publish_markers where lock_key = $1`, [key]);
}
