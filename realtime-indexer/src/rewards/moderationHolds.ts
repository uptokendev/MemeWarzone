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

// --------------------------------------------------------------------------
// League roots without held winners (copy of frontend/shared/moderationHolds.mjs; same SQL, same rules)

export const MODERATION_CARRY_CATEGORY = "moderation_release";

export type LeafRow = { category: string; rank: number; recipient_address: string; amount_raw: string; epoch_end?: Date | string; expires_at?: Date | string | null; payload?: any };
export type ExcludedRow = LeafRow & { hold: string | null; releaseStatus: string | null; stored: boolean };

const winnerKey = (row: { category: string; rank: number | string }) => `${String(row.category)}|${Number(row.rank)}`;

/** See the API copy: the rows in (or for) an epoch's root, with the held ones left out. */
export async function rootLeafRows(db: Db, input: { chainId: number; period: string; epochStart: string | Date }): Promise<{ rows: LeafRow[]; excluded: ExcludedRow[]; frozen: boolean }> {
  const iso = isoOf(input.epochStart);
  const params = [Number(input.chainId), String(input.period), iso];
  const { rows } = await db.query(
    `select w.category, w.rank, w.recipient_address, w.amount_raw::text as amount_raw, w.epoch_end, w.expires_at, w.payload
       from public.league_epoch_winners w
      where w.chain_id = $1 and w.period = $2 and w.epoch_start = $3::timestamptz
      order by w.category asc, w.rank asc, w.recipient_address asc`,
    params,
  );
  const all = rows as LeafRow[];
  if (!(await moderationHoldsAvailable(db))) return { rows: all, excluded: [], frozen: false };
  const state = await db.query(
    `select exists (select 1 from public.league_epoch_roots r where r.chain_id = $1 and r.period = $2 and r.epoch_start = $3::timestamptz) as rooted,
            exists (select 1 from public.moderation_publish_markers m where m.lock_key = $4) as marked,
            exists (select 1 from public.moderation_root_exclusions x where x.chain_id = $1 and x.period = $2 and x.epoch_start = $3::timestamptz) as stored`,
    [...params, leagueEpochLockKey(input.chainId, input.period, iso!)],
  );
  const s = state.rows?.[0] || {};
  const frozen = Boolean(s.rooted || s.marked || s.stored);
  const reasons = new Map<string, { hold: string | null; releaseStatus: string | null; stored: boolean }>();
  if (frozen) {
    const stored = await db.query(
      `select category, rank, hold_subject_key, release_status from public.moderation_root_exclusions
        where chain_id = $1 and period = $2 and epoch_start = $3::timestamptz`,
      params,
    );
    for (const row of stored.rows) reasons.set(winnerKey(row), { hold: row.hold_subject_key, releaseStatus: row.release_status, stored: true });
  } else {
    const held = await db.query(
      `select distinct on (w.category, w.rank) w.category, w.rank, h.subject_key
         from public.league_epoch_winners w
         join public.moderation_holds h on ${leagueHoldMatchSql("h", "w")}
        where w.chain_id = $1 and w.period = $2 and w.epoch_start = $3::timestamptz
        order by w.category, w.rank, h.subject_key`,
      params,
    );
    for (const row of held.rows) reasons.set(winnerKey(row), { hold: row.subject_key, releaseStatus: null, stored: false });
  }
  const included: LeafRow[] = [];
  const excluded: ExcludedRow[] = [];
  for (const row of all) {
    const reason = reasons.get(winnerKey(row));
    if (reason) excluded.push({ ...row, ...reason });
    else included.push(row);
  }
  return { rows: included, excluded, frozen };
}

/** See the API copy: re-check under the epoch lock, store exclusions and the marker, then the caller sends. */
export async function beginGuardedLeaguePublish(pool: PoolLike, input: { chainId: number; period: string; epochStart: string | Date }, root: string, rootOf: (rows: LeafRow[]) => string): Promise<{ ok: boolean; guarded?: boolean; excluded?: ExcludedRow[]; problems?: unknown[] }> {
  if (!(await moderationHoldsAvailable(pool))) return { ok: true, guarded: false, excluded: [] };
  const key = leagueEpochLockKey(input.chainId, input.period, input.epochStart);
  const iso = isoOf(input.epochStart);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock_shared(hashtext($1))", [MODERATION_GLOBAL_LOCK]);
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [key]);
    const leaf = await rootLeafRows(client, { chainId: input.chainId, period: input.period, epochStart: iso! });
    if (String(rootOf(leaf.rows)).toLowerCase() !== String(root).toLowerCase()) {
      await client.query("rollback");
      return { ok: false, problems: [{ reason: "winner list or holds changed since it was read" }] };
    }
    for (const row of leaf.excluded) {
      if (row.stored) continue;
      await client.query(
        `insert into public.moderation_root_exclusions (chain_id, period, epoch_start, category, rank, recipient_address, amount_raw, hold_subject_key)
         values ($1, $2, $3::timestamptz, $4, $5, $6, $7::numeric, $8)
         on conflict do nothing`,
        [Number(input.chainId), String(input.period), iso, row.category, Number(row.rank), row.recipient_address, String(row.amount_raw), row.hold],
      );
    }
    await client.query(
      `insert into public.moderation_publish_markers (lock_key, started_at, details) values ($1, now(), $2::jsonb)
       on conflict (lock_key) do update set started_at = now(), details = excluded.details`,
      [key, JSON.stringify({ root: String(root), excluded: leaf.excluded.map((r) => ({ category: r.category, rank: Number(r.rank) })) })],
    );
    await client.query("commit");
    return { ok: true, guarded: true, excluded: leaf.excluded };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Solana release after publication (no program change): a released prize whose leaf was left out of its
 * published root moves into the next root of the same period (same vault), as a new leaf with category
 * moderation_release. Runs before the publisher reads epoch `target`, only while `target` is not frozen
 * and has settled winners of its own (so a carry can never publish an epoch before its settlement). The
 * original row moves to league_epoch_winners_moderation_voided (disposition 'carried'), so the amount is
 * owed exactly once. Returns the carries made.
 */
export async function prepareLeagueCarries(pool: PoolLike, target: { chainId: number; period: string; epochStart: string | Date }): Promise<Array<{ from: { epochStart: string; category: string; rank: number }; rank: number; recipient: string; amountRaw: string }>> {
  if (!(await moderationHoldsAvailable(pool))) return [];
  const iso = isoOf(target.epochStart)!;
  const key = leagueEpochLockKey(target.chainId, target.period, iso);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock_shared(hashtext($1))", [MODERATION_GLOBAL_LOCK]);
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [key]);
    const t = await client.query(
      `select (select min(epoch_end) from public.league_epoch_winners where chain_id = $1 and period = $2 and epoch_start = $3::timestamptz and category <> $5) as epoch_end,
              exists (select 1 from public.league_epoch_roots r where r.chain_id = $1 and r.period = $2 and r.epoch_start = $3::timestamptz) as rooted,
              exists (select 1 from public.moderation_publish_markers m where m.lock_key = $4) as marked,
              exists (select 1 from public.moderation_root_exclusions x where x.chain_id = $1 and x.period = $2 and x.epoch_start = $3::timestamptz) as stored`,
      [Number(target.chainId), String(target.period), iso, key, MODERATION_CARRY_CATEGORY],
    );
    const row = t.rows[0] || {};
    if (!row.epoch_end || row.rooted || row.marked || row.stored) {
      await client.query("rollback");
      return [];
    }
    const pending = await client.query(
      `select x.* from public.moderation_root_exclusions x
        where x.chain_id = $1 and x.period = $2 and x.epoch_start < $3::timestamptz
          and x.release_path = 'solana_carry' and x.release_status = 'pending'
          and exists (select 1 from public.league_epoch_roots r where r.chain_id = x.chain_id and r.period = x.period and r.epoch_start = x.epoch_start)
        order by x.epoch_start, x.category, x.rank
        for update of x`,
      [Number(target.chainId), String(target.period), iso],
    );
    const made = [];
    for (const x of pending.rows) {
      const next = await client.query(
        `select coalesce(max(rank), 0) + 1 as rank from public.league_epoch_winners
          where chain_id = $1 and period = $2 and epoch_start = $3::timestamptz and category = $4`,
        [Number(target.chainId), String(target.period), iso, MODERATION_CARRY_CATEGORY],
      );
      const rank = Number(next.rows[0].rank);
      if (rank > 255) break;
      const original = await client.query(
        `select * from public.league_epoch_winners where chain_id = $1 and period = $2 and epoch_start = $3 and category = $4 and rank = $5 for update`,
        [x.chain_id, x.period, x.epoch_start, x.category, x.rank],
      );
      const o = original.rows[0];
      if (!o) continue;
      const from = { epochStart: new Date(x.epoch_start).toISOString(), category: String(x.category), rank: Number(x.rank) };
      const payload = { ...(o.payload || {}), wallet: (o.payload && o.payload.wallet) || o.recipient_address, recipient_address: o.recipient_address, rank, amount_raw: String(o.amount_raw), moderationCarry: { from, hold: x.hold_subject_key } };
      await client.query(
        `insert into public.league_epoch_winners (chain_id, period, epoch_start, epoch_end, category, rank, recipient_address, amount_raw, expires_at, meta, payload)
         values ($1, $2, $3::timestamptz, $4::timestamptz, $5, $6, $7, $8::numeric,
                 case when $9::boolean then null else $4::timestamptz + interval '2160 hours' end, $10::jsonb, $10::jsonb)`,
        [Number(target.chainId), String(target.period), iso, row.epoch_end, MODERATION_CARRY_CATEGORY, rank, o.recipient_address, String(o.amount_raw), o.expires_at == null, JSON.stringify(payload)],
      );
      await client.query(
        `insert into public.league_epoch_winners_moderation_voided
           select w.*, now(), null, 'carried' from public.league_epoch_winners w
            where chain_id = $1 and period = $2 and epoch_start = $3 and category = $4 and rank = $5
         on conflict do nothing`,
        [x.chain_id, x.period, x.epoch_start, x.category, x.rank],
      );
      await client.query(
        `delete from public.league_epoch_winners where chain_id = $1 and period = $2 and epoch_start = $3 and category = $4 and rank = $5`,
        [x.chain_id, x.period, x.epoch_start, x.category, x.rank],
      );
      const to = { epochStart: iso, category: MODERATION_CARRY_CATEGORY, rank };
      await client.query(
        `update public.moderation_root_exclusions set release_status = 'carried', carried_to = $6::jsonb, updated_at = now()
          where chain_id = $1 and period = $2 and epoch_start = $3 and category = $4 and rank = $5`,
        [x.chain_id, x.period, x.epoch_start, x.category, x.rank, JSON.stringify(to)],
      );
      made.push({ from, rank, recipient: String(o.recipient_address), amountRaw: String(o.amount_raw) });
    }
    await client.query("commit");
    return made;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
