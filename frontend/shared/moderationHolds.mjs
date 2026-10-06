// Moderation holds (B7, 2026-10-06): the canonical rules every publish, batch and claim path uses
// to keep a held or voided item from being paid. The indexer has a copy of the SQL in
// realtime-indexer/src/rewards/moderationHolds.ts; realtime-indexer/src/tests/moderationHolds.test.ts
// fails if the two drift.
//
// Table: public.moderation_holds (db/migrations/20261006_000020_moderation_holds.sql). Until that
// migration is applied there can be no holds, so every reader treats a missing table as "nothing held"
// (moderationHoldsAvailable) instead of failing the job.
//
// What blocks:
//   item holds (league_winner, airdrop_item, recruiter_ledger): state 'held' or 'voided'
//   blanket holds (wallet, recruiter): state 'held'
// A blanket wallet hold covers every prize whose winner or payout address is that wallet; a blanket
// recruiter hold covers the recruiter's credit and its Recruiter League prizes.
//
// Plain JS, no imports: the indexer test reads this file directly.

export const MODERATION_SUBJECT_KINDS = Object.freeze(["league_winner", "airdrop_item", "recruiter_ledger", "recruiter", "wallet"]);
export const MODERATION_ITEM_KINDS = Object.freeze(["league_winner", "airdrop_item", "recruiter_ledger"]);
export const MODERATION_STATES = Object.freeze(["held", "released", "voided"]);
export const MODERATION_REASON_MAX = 500;
export const MODERATION_REASON_MIN = 3;

/** Wallet key: trimmed and lower-cased (recruiters.wallet_address stores Solana keys lower-cased too). */
export function moderationWalletKey(wallet) {
  return String(wallet || "").trim().toLowerCase();
}

function isoOf(value) {
  const date = value instanceof Date ? value : new Date(String(value || ""));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Same id the Moderation list gives the row: league:<chain>:<period>:<epochStartIso>:<category>:<rank>. */
export function leagueSubjectKey({ chainId, period, epochStart, category, rank }) {
  return `league:${Number(chainId)}:${String(period)}:${isoOf(epochStart)}:${String(category)}:${Number(rank)}`;
}

export function airdropSubjectKey(rewardLedgerId) {
  return `airdrop:${String(rewardLedgerId)}`;
}

export function recruiterLedgerSubjectKey(ledgerId) {
  return `recruiter-ledger:${String(ledgerId)}`;
}

export function walletSubjectKey(wallet) {
  return `wallet:${moderationWalletKey(wallet)}`;
}

/** SQL: holds row `h` applies to league_epoch_winners row `w` (item hold, wallet hold, recruiter hold). */
export function leagueHoldMatchSql(h = "h", w = "w") {
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
export function recruiterLedgerHoldMatchSql(h = "h", l = "l") {
  return `((${h}.subject_kind = 'recruiter_ledger' and ${h}.state in ('held', 'voided')
            and ${h}.subject_key = 'recruiter-ledger:' || ${l}.id::text)
        or (${h}.subject_kind = 'recruiter' and ${h}.state = 'held'
            and (${h}.account_id = ${l}.recruiter_id
                 or (${h}.recruiter_id is not null and exists (
                       select 1 from public.recruiters mr join public.recruiter_accounts ma on ma.code = mr.code
                        where mr.id = ${h}.recruiter_id and ma.recruiter_id = ${l}.recruiter_id)))))`;
}

/** SQL: holds row `h` is a blanket hold on wallet expression `walletExpr`. */
export function walletHoldMatchSql(h = "h", walletExpr = "w.wallet_address") {
  return `(${h}.subject_kind = 'wallet' and ${h}.state = 'held' and ${h}.wallet_key = lower(${walletExpr}))`;
}

/** SQL: holds row `h` applies to reward_ledger row `l` (airdrop item hold or void, wallet hold). */
export function rewardLedgerHoldMatchSql(h = "h", l = "l") {
  return `((${h}.subject_kind = 'airdrop_item' and ${h}.state in ('held', 'voided')
            and ${h}.subject_key = 'airdrop:' || ${l}.id::text)
        or ${walletHoldMatchSql(h, `${l}.wallet_address`)})`;
}

/** False until db/migrations/20261006_000020_moderation_holds.sql is applied (then nothing can be held). */
export async function moderationHoldsAvailable(db) {
  const { rows } = await db.query(`select to_regclass('public.moderation_holds') is not null as ok`);
  return Boolean(rows?.[0]?.ok);
}

/**
 * Held (or voided-but-still-present) league winners of one epoch, one row per matching hold.
 * Every league root publisher refuses to post an epoch while this is non-empty: a root can never
 * change, the program and contracts take one root per epoch, and a list is never shrunk -- so a held
 * prize keeps its place and the epoch waits until the hold is released or the prize voided.
 */
export async function heldLeagueWinners(db, { chainId, period, epochStart }) {
  if (!(await moderationHoldsAvailable(db))) return [];
  const { rows } = await db.query(
    `select w.category, w.rank, w.recipient_address, h.subject_kind, h.subject_key, h.state, h.reason
       from public.league_epoch_winners w
       join public.moderation_holds h on ${leagueHoldMatchSql("h", "w")}
      where w.chain_id = $1 and w.period = $2 and w.epoch_start = $3::timestamptz
      order by w.category, w.rank`,
    [Number(chainId), String(period), isoOf(epochStart)],
  );
  return rows || [];
}

/** The hold that stops one league prize's claim, or null. */
export async function leagueWinnerHold(db, { chainId, period, epochStart, category, rank }) {
  if (!(await moderationHoldsAvailable(db))) return null;
  const { rows } = await db.query(
    `select h.subject_kind, h.subject_key, h.state, h.reason
       from public.league_epoch_winners w
       join public.moderation_holds h on ${leagueHoldMatchSql("h", "w")}
      where w.chain_id = $1 and w.period = $2 and w.epoch_start = $3::timestamptz and w.category = $4 and w.rank = $5
      limit 1`,
    [Number(chainId), String(period), isoOf(epochStart), String(category), Number(rank)],
  );
  return rows?.[0] || null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** reward_ledger ids (of `ids`) that are held, voided or belong to a held wallet. */
export async function rewardLedgerHolds(db, ids) {
  const list = (ids || []).map(String).filter((id) => UUID.test(id));
  if (!list.length || !(await moderationHoldsAvailable(db))) return [];
  const { rows } = await db.query(
    `select l.id::text as id, h.subject_kind, h.subject_key, h.state, h.reason
       from public.reward_ledger l
       join public.moderation_holds h on ${rewardLedgerHoldMatchSql("h", "l")}
      where l.id = any($1::uuid[])`,
    [list],
  );
  return rows || [];
}

/** Lower-cased wallets under a blanket hold. The weekly airdrop draw leaves them out of the field. */
export async function heldWalletKeys(db) {
  if (!(await moderationHoldsAvailable(db))) return new Set();
  const { rows } = await db.query(`select wallet_key from public.moderation_holds where subject_kind = 'wallet' and state = 'held' and wallet_key is not null`);
  return new Set((rows || []).map((row) => moderationWalletKey(row.wallet_key)).filter(Boolean));
}

/** Plain-language refusal the claim APIs return for a held item. */
export function moderationClaimRefusal(hold) {
  return {
    code: "MODERATION_HOLD",
    error: hold?.state === "voided"
      ? "This reward was voided after review. Nothing was sent."
      : "This reward is on hold for review. Nothing was sent.",
  };
}

/**
 * Blanket hold that stops a recruiter's payout: the recruiter itself (by payout account, or by
 * recruiters.id linked through the code) or its payout wallet. Null when there is none.
 */
export async function recruiterPayoutHold(db, { accountId, payoutWallet }) {
  if (!(await moderationHoldsAvailable(db))) return null;
  const { rows } = await db.query(
    `select h.subject_kind, h.subject_key, h.state, h.reason
       from public.moderation_holds h
      where h.state = 'held'
        and ((h.subject_kind = 'recruiter'
              and (h.account_id = $1::uuid
                   or (h.recruiter_id is not null and exists (
                         select 1 from public.recruiters mr join public.recruiter_accounts ma on ma.code = mr.code
                          where mr.id = h.recruiter_id and ma.recruiter_id = $1::uuid))))
             or (h.subject_kind = 'wallet' and $2::text <> '' and h.wallet_key = lower($2::text)))
      limit 1`,
    [String(accountId), String(payoutWallet || "")],
  );
  return rows?.[0] || null;
}

/** SQL condition: recruiter_reward_ledger row `l` is not held, not voided and its recruiter not held. */
export function recruiterLedgerNotHeldSql(l = "l") {
  return `not exists (select 1 from public.moderation_holds h where ${recruiterLedgerHoldMatchSql("h", l)})`;
}

/** The hold on any credit row behind one recruiter_reward_claims id (Solana lane claim), or null. */
export async function recruiterClaimHold(db, recruiterClaimId) {
  if (!(await moderationHoldsAvailable(db))) return null;
  const { rows } = await db.query(
    `select h.subject_kind, h.subject_key, h.state, h.reason
       from public.recruiter_reward_ledger l
       join public.moderation_holds h on ${recruiterLedgerHoldMatchSql("h", "l")}
      where l.claim_id = $1::uuid
      limit 1`,
    [String(recruiterClaimId)],
  );
  return rows?.[0] || null;
}

/** Advisory lock key both the recruiter payout and a moderation action on that recruiter take. */
export function recruiterModerationLockKey(accountId) {
  return `mwz-moderation:recruiter-account:${String(accountId)}`;
}

/**
 * Publication guard. A root publisher and a moderation action never overlap on the same list:
 *
 *   publisher, right before it sends:  one short transaction -- shared global lock, exclusive list
 *     lock, re-check holds and that the list it read is still the list in the database, write a
 *     marker row (moderation_publish_markers) -- commit; send; record the root; delete the marker.
 *   moderation action on an item:      shared global lock, exclusive list lock, refuse while a marker
 *     for that list exists (the root may be on its way).
 *   blanket hold (wallet / recruiter): exclusive global lock, so every publication either checked
 *     holds before it (and is listed as already in flight) or sees the hold.
 *
 * Only transaction-scoped advisory locks, held for milliseconds: safe on the Supabase transaction
 * pooler (6543), where a session lock is not tied to one connection. A marker left behind by a crash
 * after a send stays until the next publisher run records the root (or sends it) and clears it.
 */
export const MODERATION_GLOBAL_LOCK = "mwz-moderation:global";

export function leagueEpochLockKey(chainId, period, epochStart) {
  return `mwz-league-root:${Number(chainId)}:${String(period)}:${isoOf(epochStart)}`;
}

export function recruiterBatchLockKey(chainId, epochId) {
  return `mwz-recruiter-batch:${Number(chainId)}:${String(epochId)}`;
}

/**
 * `check(client)` returns a list of problems (held items, "list changed"); empty means go. Returns
 * { ok: true } after writing the marker, { ok: false, problems } otherwise (nothing written). Before the
 * moderation migration is applied nothing can be held: { ok: true, guarded: false }, no marker.
 */
export async function beginGuardedPublish(pool, key, check) {
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
export async function endGuardedPublish(pool, key) {
  if (!(await moderationHoldsAvailable(pool))) return;
  await pool.query(`delete from public.moderation_publish_markers where lock_key = $1`, [key]);
}

// --------------------------------------------------------------------------
// League roots without held winners (founder 2026-10-06: a hold drops only that one winner)

export const MODERATION_CARRY_CATEGORY = "moderation_release";

/** Which post-publication release path a chain has (no program or contract change needed for either). */
export function leagueReleasePath(chainId) {
  return Number(chainId) === 101 || Number(chainId) === 102 ? "solana_carry" : "evm_safe_withdraw";
}

const winnerKey = (row) => `${String(row.category)}|${Number(row.rank)}`;

/**
 * The winner rows of one epoch that belong in (or already are in) its Merkle root, in the order every
 * proof builder uses (category, rank, recipient). Rows not in it come back in `excluded`.
 *
 *   frozen (a root is recorded, a publication is in flight, or exclusions were stored): exactly the
 *     stored exclusions (moderation_root_exclusions) are left out -- a hold placed after publication
 *     never changes a published leaf set.
 *   not frozen: winners under a hold (item, wallet or recruiter) are left out; nobody else moves.
 *
 * Before the moderation migration: every row, nothing excluded.
 */
export async function rootLeafRows(db, { chainId, period, epochStart }) {
  const iso = isoOf(epochStart);
  const params = [Number(chainId), String(period), iso];
  const { rows } = await db.query(
    `select w.category, w.rank, w.recipient_address, w.amount_raw::text as amount_raw, w.epoch_end, w.expires_at, w.payload
       from public.league_epoch_winners w
      where w.chain_id = $1 and w.period = $2 and w.epoch_start = $3::timestamptz
      order by w.category asc, w.rank asc, w.recipient_address asc`,
    params,
  );
  const all = rows || [];
  if (!(await moderationHoldsAvailable(db))) return { rows: all, excluded: [], frozen: false };
  const state = await db.query(
    `select exists (select 1 from public.league_epoch_roots r where r.chain_id = $1 and r.period = $2 and r.epoch_start = $3::timestamptz) as rooted,
            exists (select 1 from public.moderation_publish_markers m where m.lock_key = $4) as marked,
            exists (select 1 from public.moderation_root_exclusions x where x.chain_id = $1 and x.period = $2 and x.epoch_start = $3::timestamptz) as stored`,
    [...params, leagueEpochLockKey(chainId, period, iso)],
  );
  const s = state.rows?.[0] || {};
  const frozen = Boolean(s.rooted || s.marked || s.stored);
  const reasons = new Map();
  if (frozen) {
    const stored = await db.query(
      `select category, rank, hold_subject_key, release_status from public.moderation_root_exclusions
        where chain_id = $1 and period = $2 and epoch_start = $3::timestamptz`,
      params,
    );
    for (const row of stored.rows || []) reasons.set(winnerKey(row), { hold: row.hold_subject_key, releaseStatus: row.release_status, stored: true });
  } else {
    const held = await db.query(
      `select distinct on (w.category, w.rank) w.category, w.rank, h.subject_key
         from public.league_epoch_winners w
         join public.moderation_holds h on ${leagueHoldMatchSql("h", "w")}
        where w.chain_id = $1 and w.period = $2 and w.epoch_start = $3::timestamptz
        order by w.category, w.rank, h.subject_key`,
      params,
    );
    for (const row of held.rows || []) reasons.set(winnerKey(row), { hold: row.subject_key, releaseStatus: null, stored: false });
  }
  const included = [];
  const excluded = [];
  for (const row of all) {
    const reason = reasons.get(winnerKey(row));
    if (reason) excluded.push({ ...row, ...reason });
    else included.push(row);
  }
  return { rows: included, excluded, frozen };
}

/**
 * The league publish guard. One short transaction, right before the send: shared global lock, the epoch
 * lock, rebuild the leaf set under the lock, check it still gives `root` (`rootOf(rows)` computes it the
 * caller's way), then store the exclusions and the marker. From then on the leaf set is frozen and no
 * moderation action can change it. Returns { ok, excluded } or { ok: false, problems }.
 */
export async function beginGuardedLeaguePublish(pool, { chainId, period, epochStart }, root, rootOf) {
  if (!(await moderationHoldsAvailable(pool))) return { ok: true, guarded: false, excluded: [] };
  const key = leagueEpochLockKey(chainId, period, epochStart);
  const iso = isoOf(epochStart);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock_shared(hashtext($1))", [MODERATION_GLOBAL_LOCK]);
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [key]);
    const leaf = await rootLeafRows(client, { chainId, period, epochStart: iso });
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
        [Number(chainId), String(period), iso, row.category, Number(row.rank), row.recipient_address, String(row.amount_raw), row.hold],
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

/** The stored exclusion of one league winner (its leaf is not in the published root), or null. */
export async function leagueRootExclusion(db, { chainId, period, epochStart, category, rank }) {
  if (!(await moderationHoldsAvailable(db))) return null;
  const { rows } = await db.query(
    `select chain_id, period, epoch_start, category, rank, recipient_address, amount_raw::text as amount_raw, hold_subject_key,
            release_path, release_status, released_at, carried_to, paid_tx
       from public.moderation_root_exclusions
      where chain_id = $1 and period = $2 and epoch_start = $3::timestamptz and category = $4 and rank = $5`,
    [Number(chainId), String(period), isoOf(epochStart), String(category), Number(rank)],
  );
  return rows?.[0] || null;
}

/** Claim-page text for a prize whose leaf is not in its published root. */
export function leagueExclusionRefusal(exclusion) {
  const status = exclusion?.release_status;
  if (status === "paid") return { code: "LEAGUE_PRIZE_PAID_BY_MULTISIG", error: "This prize was paid to your wallet by the team's multisig.", txHash: exclusion.paid_tx || null };
  if (status === "carried") return { code: "LEAGUE_PRIZE_MOVED", error: "This prize was moved into a later league root. Claim it there.", movedTo: exclusion.carried_to || null };
  if (status === "pending") return { code: "LEAGUE_PRIZE_MOVING", error: "This prize was released after review and goes into the next league root of this period. Claim it there once it is posted." };
  if (status === "awaiting_multisig") return { code: "LEAGUE_PRIZE_MULTISIG", error: "This prize was released after review and is paid to your wallet by the team's multisig. Nothing to claim here." };
  if (status === "voided") return { code: "MODERATION_HOLD", error: "This reward was voided after review. Nothing was sent." };
  return { code: "MODERATION_HOLD", error: "This reward is on hold for review. Nothing was sent." };
}
