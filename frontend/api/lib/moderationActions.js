// Moderation actions (B7, 2026-10-06): hold, release and void on league prizes, airdrop allocations
// and recruiter credit, plus blanket holds on a wallet or a recruiter. Every change is one database
// transaction that writes public.moderation_holds and public.moderation_audit_log together, so a state
// never changes without its audit row. Enforcement lives in the publish, batch and claim paths
// (shared/moderationHolds.mjs); this file only records decisions and, for a void, takes the row out
// of payment the way the 2026-10-05 manual voids did.
//
// Money rules (audited in the PR):
//   - Nothing here signs, sends, or touches a root. A published root can never change.
//   - Void is refused on anything published or paid; only hold (as a claim guard) and release are
//     allowed after publication.
//   - Hold / release / void are idempotent: repeating the same action on the same state changes
//     nothing and writes no audit row.
//   - Concurrency: transaction advisory locks only (safe on the transaction pooler). An item action
//     takes the shared global lock and its list lock and refuses while a publisher's marker for that
//     list exists; a blanket hold takes the exclusive global lock. Recruiter actions also take the lock
//     the EVM recruiter payout takes, so a hold and a payout never interleave.

import {
  MODERATION_GLOBAL_LOCK,
  MODERATION_REASON_MAX,
  MODERATION_REASON_MIN,
  airdropSubjectKey,
  leagueEpochLockKey,
  leagueReleasePath,
  leagueSubjectKey,
  moderationWalletKey,
  recruiterBatchLockKey,
  recruiterLedgerSubjectKey,
  recruiterModerationLockKey,
  walletSubjectKey,
} from "../../shared/moderationHolds.mjs";

export const MODERATION_MANAGE_PERMISSIONS = Object.freeze(["community.manage", "finance.manage"]);
export const MODERATION_ACTIONS = Object.freeze(["hold", "release", "void"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const LEAGUE_KEY = /^league:(\d+):(weekly|monthly|mwl_monthly|quarterly):(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z):([a-z_]+):(\d{1,3})$/;

export class ModerationActionError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const fail = (status, code, message, extra) => {
  throw new ModerationActionError(status, code, message, extra);
};

// --------------------------------------------------------------------------
// Input

/**
 * Body: { subjectKind, subjectId, action, reason, expectedVersion? }. subjectId is the Moderation row
 * id (league:..., airdrop:..., recruiter:..., recruiter-account:...), recruiter-ledger:<uuid>, or for
 * a wallet the address (or wallet:<address>).
 */
export function parseModerationAction(body = {}) {
  const kind = String(body.subjectKind || "").trim();
  const action = String(body.action || "").trim().toLowerCase();
  const reason = String(body.reason ?? "").trim();
  const rawId = String(body.subjectId ?? body.wallet ?? "").trim();
  if (!["league_winner", "airdrop_item", "recruiter_ledger", "recruiter", "wallet"].includes(kind)) {
    return { error: "subjectKind must be league_winner, airdrop_item, recruiter_ledger, recruiter or wallet." };
  }
  if (!MODERATION_ACTIONS.includes(action)) return { error: "action must be hold, release or void." };
  if (reason.length < MODERATION_REASON_MIN) return { error: "A written reason is required." };
  if (reason.length > MODERATION_REASON_MAX) return { error: `The reason can be at most ${MODERATION_REASON_MAX} characters.` };
  if (action === "void" && kind === "wallet") return { error: "A wallet cannot be voided. Void its prizes one by one, or hold the wallet." };
  const expectedVersion = body.expectedVersion == null || body.expectedVersion === "" ? null : Number(body.expectedVersion);
  if (expectedVersion != null && !Number.isInteger(expectedVersion)) return { error: "expectedVersion must be an integer." };

  if (kind === "league_winner") {
    const m = rawId.match(LEAGUE_KEY);
    if (!m) return { error: "subjectId must be a league row id (league:<chain>:<period>:<epochStart>:<category>:<rank>)." };
    const ref = { chainId: Number(m[1]), period: m[2], epochStart: new Date(m[3]).toISOString(), category: m[4], rank: Number(m[5]) };
    if (!(ref.rank >= 1 && ref.rank <= 255)) return { error: "rank must be 1..255." };
    return { kind, action, reason, expectedVersion, ref, subjectKey: leagueSubjectKey(ref) };
  }
  if (kind === "airdrop_item") {
    const id = rawId.replace(/^airdrop:/, "");
    if (!UUID.test(id)) return { error: "subjectId must be an airdrop row id (airdrop:<uuid>)." };
    return { kind, action, reason, expectedVersion, ref: { id: id.toLowerCase() }, subjectKey: airdropSubjectKey(id.toLowerCase()) };
  }
  if (kind === "recruiter_ledger") {
    const id = rawId.replace(/^recruiter-ledger:/, "");
    if (!UUID.test(id)) return { error: "subjectId must be recruiter-ledger:<uuid>." };
    return { kind, action, reason, expectedVersion, ref: { id: id.toLowerCase() }, subjectKey: recruiterLedgerSubjectKey(id.toLowerCase()) };
  }
  if (kind === "recruiter") {
    let m = rawId.match(/^recruiter:(\d{1,18})$/);
    if (m) return { kind, action, reason, expectedVersion, ref: { recruiterId: m[1] }, subjectKey: `recruiter:${m[1]}` };
    m = rawId.match(/^recruiter-account:([0-9a-f-]{36})$/i);
    if (m && UUID.test(m[1])) return { kind, action, reason, expectedVersion, ref: { accountId: m[1].toLowerCase() }, subjectKey: `recruiter-account:${m[1].toLowerCase()}` };
    return { error: "subjectId must be a recruiter row id (recruiter:<id> or recruiter-account:<uuid>)." };
  }
  const wallet = rawId.replace(/^wallet:/, "");
  if (!EVM_ADDRESS.test(wallet) && !SOLANA_ADDRESS.test(wallet)) return { error: "subjectId must be an EVM or Solana wallet address." };
  return { kind, action, reason, expectedVersion, ref: { wallet }, subjectKey: walletSubjectKey(wallet) };
}

// --------------------------------------------------------------------------
// Helpers

async function lockExclusive(client, key) {
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [key]);
}

async function lockShared(client, key) {
  await client.query("select pg_advisory_xact_lock_shared(hashtext($1))", [key]);
}

async function tableExists(client, name) {
  const { rows } = await client.query("select to_regclass($1) is not null as ok", [name]);
  return Boolean(rows[0]?.ok);
}

async function marker(client, key) {
  const { rows } = await client.query("select started_at from public.moderation_publish_markers where lock_key = $1", [key]);
  return rows[0] || null;
}

async function refuseWhilePublishing(client, key, what) {
  const found = await marker(client, key);
  if (found) {
    fail(409, "PUBLISH_IN_PROGRESS", `The ${what} is being published right now (started ${new Date(found.started_at).toISOString()}). Try again when it is done; if it stays stuck, run its root publisher again, which records or finishes it.`, { startedAt: found.started_at });
  }
}

function plain(row) {
  if (!row) return null;
  return JSON.parse(JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

// --------------------------------------------------------------------------
// Subjects: lock, read the row behind it, decide what is allowed

/**
 * Each loader returns:
 *   { snapshot, published, paid, voidable, voidBlockReason, columns: { chainId, walletKey, recruiterId, accountId, subject } }
 * published: a root/batch with this item is on chain (or may be) -> hold is a claim guard, void refused.
 * paid: money left (or is leaving) -> hold and void refused.
 */
async function loadLeagueWinner(client, ref, existing) {
  await lockShared(client, MODERATION_GLOBAL_LOCK);
  await lockExclusive(client, leagueEpochLockKey(ref.chainId, ref.period, ref.epochStart));
  await refuseWhilePublishing(client, leagueEpochLockKey(ref.chainId, ref.period, ref.epochStart), "league epoch root");
  const { rows } = await client.query(
    `select * from public.league_epoch_winners
      where chain_id = $1 and period = $2 and epoch_start = $3::timestamptz and category = $4 and rank = $5
      for update`,
    [ref.chainId, ref.period, ref.epochStart, ref.category, ref.rank],
  );
  const row = rows[0];
  // Left out of its published root by an earlier hold (moderation_root_exclusions)?
  const ex = await client.query(
    `select * from public.moderation_root_exclusions
      where chain_id = $1 and period = $2 and epoch_start = $3::timestamptz and category = $4 and rank = $5
      for update`,
    [ref.chainId, ref.period, ref.epochStart, ref.category, ref.rank],
  );
  const exclusion = ex.rows[0] || null;
  if (exclusion?.release_status === "carried") fail(409, "ALREADY_MOVED", "This prize was released and moved into a later root; act on the moderation_release row there.", { movedTo: exclusion.carried_to });
  if (!row && existing?.state !== "voided") fail(404, "SUBJECT_NOT_FOUND", "This league prize no longer exists.");
  const root = await client.query(
    `select published_at from public.league_epoch_roots where chain_id = $1 and period = $2 and epoch_start = $3::timestamptz limit 1`,
    [ref.chainId, ref.period, ref.epochStart],
  );
  const key = [ref.chainId, ref.period, ref.epochStart, ref.category, ref.rank];
  const claimed = await client.query(
    `select 1 from public.league_epoch_claims where chain_id = $1 and period = $2 and epoch_start = $3::timestamptz and category = $4 and rank = $5
     union all
     select 1 from public.league_epoch_payouts where chain_id = $1 and period = $2 and epoch_start = $3::timestamptz and category = $4 and rank = $5
     limit 1`,
    key,
  );
  let categoryPaid = false;
  if (await tableExists(client, "public.league_epoch_paid_totals")) {
    const paid = await client.query(
      `select 1 from public.league_epoch_paid_totals where chain_id = $1 and period = $2 and epoch_start = $3::timestamptz and category = $4 and paid_raw > 0 limit 1`,
      key.slice(0, 4),
    );
    categoryPaid = paid.rows.length > 0;
  }
  const rootPosted = root.rows.length > 0;
  const excluded = Boolean(exclusion);
  // Published = its leaf is in a posted root. A winner left out of the root (held at publication) has no
  // leaf: it can still be voided, and a release pays it by the chain's release path.
  const published = rootPosted && !excluded;
  const paid = claimed.rows.length > 0 || exclusion?.release_status === "paid";
  const payload = row?.payload && typeof row.payload === "object" ? row.payload : {};
  const voidable = !paid && (excluded ? true : !rootPosted && !categoryPaid);
  return {
    row,
    exclusion,
    snapshot: plain(row),
    published,
    paid,
    voidable,
    voidBlockReason: paid ? "This prize was already claimed or paid." : published ? "Its root is already published; a posted root can never change." : categoryPaid ? "Money of this category was already paid out." : null,
    columns: {
      chainId: ref.chainId,
      walletKey: moderationWalletKey(payload.wallet || row?.recipient_address || existing?.wallet_key || ""),
      recruiterId: payload.recruiterId != null ? String(payload.recruiterId) : null,
      accountId: null,
      subject: { ...ref, recipient: row?.recipient_address || existing?.subject?.recipient || null, amountRaw: row ? String(row.amount_raw) : existing?.subject?.amountRaw || null },
    },
  };
}

async function voidLeagueWinner(client, ref, loaded, holdId) {
  await client.query(
    `insert into public.league_epoch_winners_moderation_voided
       select w.*, now(), $6::uuid from public.league_epoch_winners w
        where chain_id = $1 and period = $2 and epoch_start = $3::timestamptz and category = $4 and rank = $5
     on conflict do nothing`,
    [ref.chainId, ref.period, ref.epochStart, ref.category, ref.rank, holdId],
  );
  const deleted = await client.query(
    `delete from public.league_epoch_winners
      where chain_id = $1 and period = $2 and epoch_start = $3::timestamptz and category = $4 and rank = $5
        and (not exists (select 1 from public.league_epoch_roots r where r.chain_id = $1 and r.period = $2 and r.epoch_start = $3::timestamptz)
             or exists (select 1 from public.moderation_root_exclusions x
                         where x.chain_id = $1 and x.period = $2 and x.epoch_start = $3::timestamptz and x.category = $4 and x.rank = $5))`,
    [ref.chainId, ref.period, ref.epochStart, ref.category, ref.rank],
  );
  if (deleted.rowCount !== 1) fail(409, "VOID_RACE", "The prize changed while it was being voided. Nothing was changed.");
  return { backup: "league_epoch_winners_moderation_voided", amountRaw: String(loaded.row.amount_raw), placesRenumbered: false, moneyStays: "league vault, unassigned" };
}

/**
 * A league winner left out of its published root (held at publication). Release starts the chain's
 * release path (Solana: carried into the next root of the period by the publisher; BNB / Robinhood: paid
 * by a Safe proposal, scripts/league-release-safe-batch.mjs); a new hold stops that path; void ends it.
 */
async function updateExclusion(client, input, exclusion, state, warnings) {
  if (["carried", "paid"].includes(exclusion.release_status)) fail(409, "ALREADY_MOVED", "This prize was already moved or paid.");
  let path = exclusion.release_path;
  let status = exclusion.release_status;
  if (state === "released") {
    path = leagueReleasePath(input.ref.chainId);
    status = path === "solana_carry" ? "pending" : "awaiting_multisig";
    warnings.push({
      code: "RELEASED_AFTER_PUBLICATION",
      message: path === "solana_carry"
        ? "Released after its root was published: the prize moves into the next root of this period on Solana, automatically."
        : "Released after its root was published: paid manually via a Safe multisig proposal (scripts/league-release-safe-batch.mjs).",
    });
  } else if (state === "held") {
    status = null;
  } else if (state === "voided") {
    status = "voided";
  }
  await client.query(
    `update public.moderation_root_exclusions
        set release_path = $6, release_status = $7, released_at = case when $7 in ('pending', 'awaiting_multisig') then now() else released_at end, updated_at = now()
      where chain_id = $1 and period = $2 and epoch_start = $3::timestamptz and category = $4 and rank = $5`,
    [input.ref.chainId, input.ref.period, input.ref.epochStart, input.ref.category, input.ref.rank, path, status],
  );
  return { heldOutOfRoot: true, releasePath: path, releaseStatus: status };
}

const AIRDROP_PUBLISHED_BATCH = new Set(["funding_check", "published", "claim_open", "paused", "closed", "archived", "failed"]);

async function loadAirdropItem(client, ref) {
  const { rows } = await client.query(
    `select l.*, bi.batch_id::text as batch_id, b.status as batch_status,
            (l.metadata ? 'merkleRoot') or (b.metadata ? 'merkleRoot') as has_root
       from public.reward_ledger l
       left join public.reward_batch_items bi on bi.reward_ledger_id = l.id
       left join public.reward_batches b on b.id = bi.batch_id
      where l.id = $1::uuid
      for update of l`,
    [ref.id],
  );
  const row = rows[0];
  if (!row) fail(404, "SUBJECT_NOT_FOUND", "This airdrop allocation does not exist.");
  const status = String(row.status || "").toLowerCase();
  const paid = status === "claimed" || Boolean(row.claim_tx_hash);
  const published = Boolean(row.has_root) || AIRDROP_PUBLISHED_BATCH.has(String(row.batch_status || "")) || !["pending", "approved"].includes(status);
  return {
    row,
    snapshot: plain({ ...row, has_root: undefined }),
    published,
    paid,
    voidable: !published && !paid,
    voidBlockReason: paid ? "This allocation was already claimed." : published ? "Its batch root is already built or published; a posted root can never change." : null,
    columns: { chainId: Number(row.chain) || null, walletKey: moderationWalletKey(row.wallet_address), recruiterId: null, accountId: null, subject: { id: ref.id, wallet: row.wallet_address, amountRaw: String(row.amount), rewardType: row.reward_type, batchId: row.batch_id } },
  };
}

async function voidAirdropItem(client, ref, loaded, holdId, reason, actor) {
  const meta = { voidedReason: reason, voidedBy: actor, voidedAt: new Date().toISOString(), moderationHoldId: holdId };
  const updated = await client.query(
    `update public.reward_ledger set status = 'cancelled', metadata = coalesce(metadata, '{}'::jsonb) || $2::jsonb, updated_at = now()
      where id = $1::uuid and status in ('pending', 'approved')`,
    [ref.id, JSON.stringify(meta)],
  );
  if (updated.rowCount !== 1) fail(409, "VOID_RACE", "The allocation changed while it was being voided. Nothing was changed.");
  await client.query(`update public.reward_batch_items set status = 'cancelled' where reward_ledger_id = $1::uuid and status in ('pending', 'approved')`, [ref.id]);
  return { ledgerStatus: "cancelled", amountRaw: String(loaded.row.amount) };
}

const RECRUITER_IN_FLIGHT = new Set(["created", "submitted", "confirmed", "claimed"]);
const RECRUITER_VOIDABLE = new Set(["claimable", "retriable", "pending", "pending_finality"]);

/** The lane batch (if any) that carries this credit row: { id, status, epoch_id, chain_id }. */
async function recruiterBatchOf(client, claimId) {
  if (!claimId) return null;
  const { rows } = await client.query(
    `select b.id::text as id, b.status, b.epoch_id::text as epoch_id, b.chain_id
       from public.solana_reward_lane_claims c join public.solana_reward_lane_batches b on b.id = c.batch_id
      where c.lane = 'recruiter' and c.source_type = 'recruiter_reward_claim' and c.source_ref = $1
      order by b.epoch_id desc limit 1`,
    [String(claimId)],
  );
  return rows[0] || null;
}

async function loadRecruiterLedger(client, ref) {
  const pre = await client.query(`select recruiter_id::text as account_id from public.recruiter_reward_ledger where id = $1::uuid`, [ref.id]);
  if (!pre.rows[0]) fail(404, "SUBJECT_NOT_FOUND", "This recruiter credit row does not exist.");
  // Lock order: global (shared) -> recruiter account (the EVM payout takes this one before its row
  // locks) -> the credit row -> its batch. Same order everywhere, so no deadlock with a payout.
  await lockShared(client, MODERATION_GLOBAL_LOCK);
  const accountId = pre.rows[0].account_id;
  await lockExclusive(client, recruiterModerationLockKey(accountId));
  const { rows } = await client.query(`select * from public.recruiter_reward_ledger where id = $1::uuid for update`, [ref.id]);
  const row = rows[0];
  const batch = await recruiterBatchOf(client, row.claim_id);
  if (batch) {
    await lockExclusive(client, recruiterBatchLockKey(batch.chain_id, batch.epoch_id));
    await refuseWhilePublishing(client, recruiterBatchLockKey(batch.chain_id, batch.epoch_id), "recruiter settlement batch");
  }
  const status = String(row.status || "").toLowerCase();
  const paid = RECRUITER_IN_FLIGHT.has(status);
  const published = Boolean(batch && batch.status !== "prepared");
  return {
    row,
    snapshot: plain(row),
    published,
    paid,
    voidable: !paid && !published && RECRUITER_VOIDABLE.has(status),
    voidBlockReason: paid ? "This credit is being paid or was paid." : published ? "It is in a published weekly batch; a posted root can never change." : !RECRUITER_VOIDABLE.has(status) ? `Its status is ${status}; only unpaid credit can be voided.` : null,
    columns: { chainId: row.chain_id == null ? null : Number(row.chain_id), walletKey: moderationWalletKey(row.metadata?.earningWallet || ""), recruiterId: null, accountId, subject: { id: ref.id, chain: row.chain, amountRaw: String(row.amount_raw), accountId } },
  };
}

async function voidRecruiterLedger(client, ref, loaded, holdId, reason, actor) {
  const meta = { voidedReason: reason, voidedBy: actor, voidedAt: new Date().toISOString(), moderationHoldId: holdId };
  const updated = await client.query(
    `update public.recruiter_reward_ledger set status = 'failed', metadata = coalesce(metadata, '{}'::jsonb) || $2::jsonb, updated_at = now()
      where id = $1::uuid and status = any($3::text[])`,
    [ref.id, JSON.stringify(meta), [...RECRUITER_VOIDABLE]],
  );
  if (updated.rowCount !== 1) fail(409, "VOID_RACE", "The credit changed while it was being voided. Nothing was changed.");
  return { ledgerStatus: "failed", amountRaw: String(loaded.row.amount_raw), chain: loaded.row.chain };
}

async function resolveRecruiter(client, ref) {
  if (ref.recruiterId) {
    const { rows } = await client.query(
      `select r.id::text as recruiter_id, r.code, r.wallet_address, a.recruiter_id::text as account_id
         from public.recruiters r left join public.recruiter_accounts a on a.code = r.code
        where r.id = $1::bigint`,
      [ref.recruiterId],
    );
    if (!rows[0]) fail(404, "SUBJECT_NOT_FOUND", "This recruiter does not exist.");
    return rows[0];
  }
  const { rows } = await client.query(
    `select r.id::text as recruiter_id, a.code, a.signup_wallet as wallet_address, a.recruiter_id::text as account_id
       from public.recruiter_accounts a left join public.recruiters r on r.code = a.code
      where a.recruiter_id = $1::uuid`,
    [ref.accountId],
  );
  if (!rows[0]) fail(404, "SUBJECT_NOT_FOUND", "This recruiter account does not exist.");
  return rows[0];
}

async function inFlightPublications(client) {
  const { rows } = await client.query(`select lock_key, started_at from public.moderation_publish_markers order by started_at`);
  return rows.map((row) => ({ list: row.lock_key, startedAt: row.started_at }));
}

// --------------------------------------------------------------------------
// Apply

async function writeHold(client, { existing, input, state, published, snapshot, columns, actor }) {
  if (existing) {
    const { rows } = await client.query(
      `update public.moderation_holds
          set state = $2, reason = $3, published = $4, snapshot = coalesce($5::jsonb, snapshot),
              chain_id = coalesce($6, chain_id), wallet_key = coalesce(nullif($7, ''), wallet_key),
              recruiter_id = coalesce($8::bigint, recruiter_id), account_id = coalesce($9::uuid, account_id),
              subject = subject || $10::jsonb,
              updated_by = $11, updated_by_member = $12::uuid, updated_at = now(), version = version + 1
        where id = $1
        returning *`,
      [existing.id, state, input.reason, published, snapshot ? JSON.stringify(snapshot) : null, columns.chainId, columns.walletKey || "",
        columns.recruiterId, columns.accountId, JSON.stringify(columns.subject || {}), actor.email, actor.memberId],
    );
    return rows[0];
  }
  const { rows } = await client.query(
    `insert into public.moderation_holds
       (subject_kind, subject_key, subject, chain_id, wallet_key, recruiter_id, account_id, state, reason, published, snapshot,
        created_by, created_by_member, updated_by, updated_by_member)
     values ($1, $2, $3::jsonb, $4, nullif($5, ''), $6::bigint, $7::uuid, $8, $9, $10, $11::jsonb, $12, $13::uuid, $12, $13::uuid)
     returning *`,
    [input.kind, input.subjectKey, JSON.stringify(columns.subject || {}), columns.chainId, columns.walletKey || "", columns.recruiterId, columns.accountId,
      state, input.reason, published, snapshot ? JSON.stringify(snapshot) : null, actor.email, actor.memberId],
  );
  return rows[0];
}

async function writeAudit(client, { hold, input, kind, subjectKey, action, fromState, toState, reason, published, actor, requestId, details }) {
  const { rows } = await client.query(
    `insert into public.moderation_audit_log
       (hold_id, subject_kind, subject_key, action, from_state, to_state, reason, published, actor_email, actor_member_id, request_id, details)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid, $11, $12::jsonb)
     returning id::text as id, created_at`,
    [hold?.id || null, kind || input.kind, subjectKey || input.subjectKey, action || input.action, fromState, toState, reason || input.reason, Boolean(published),
      actor.email, actor.memberId, requestId || null, JSON.stringify(details || {})],
  );
  return rows[0];
}

function nextState(action, current) {
  if (action === "hold") {
    if (current === "held") return { idempotent: true, state: "held" };
    if (current === "voided") fail(409, "ALREADY_VOIDED", "This item is voided; a void is final.");
    return { state: "held" };
  }
  if (action === "release") {
    if (current === "released") return { idempotent: true, state: "released" };
    if (current === "voided") fail(409, "ALREADY_VOIDED", "This item is voided; a void is final and cannot be released.");
    if (current !== "held") fail(409, "NOT_HELD", "This item is not on hold.");
    return { state: "released" };
  }
  if (current === "voided") return { idempotent: true, state: "voided" };
  return { state: "voided" };
}

/**
 * Applies one action. `db` must offer connect() (a pg Pool). `principal` is the dashboard principal
 * (email, memberId); the caller has already checked the manage permission.
 * Returns { ok, idempotent, hold, auditId, published, effects, warnings }.
 */
export async function applyModerationAction(db, { input, principal, requestId = null }) {
  const actor = { email: String(principal?.email || "unknown"), memberId: principal?.memberId && UUID.test(String(principal.memberId)) ? String(principal.memberId) : null };
  const client = await db.connect();
  try {
    await client.query("begin");
    if (!(await tableExists(client, "public.moderation_holds"))) {
      fail(503, "MODERATION_SCHEMA_MISSING", "The moderation tables are not installed yet (db/migrations/20261006_000020_moderation_holds.sql).");
    }

    // Serialize actions on the same subject (also a not-yet-existing hold row).
    await lockExclusive(client, `mwz-moderation:subject:${input.kind}:${input.subjectKey}`);
    const found = await client.query(`select * from public.moderation_holds where subject_kind = $1 and subject_key = $2 for update`, [input.kind, input.subjectKey]);
    const existing = found.rows[0] || null;
    if (input.expectedVersion != null && Number(existing?.version || 0) !== input.expectedVersion) {
      fail(409, "STALE_VERSION", "This item changed since the page was loaded. Reload and try again.", { currentVersion: Number(existing?.version || 0) });
    }
    const current = existing?.state || null;
    const warnings = [];

    // Blanket holds.
    if (input.kind === "wallet" || input.kind === "recruiter") {
      await lockExclusive(client, MODERATION_GLOBAL_LOCK);
      let columns;
      let recruiter = null;
      if (input.kind === "wallet") {
        columns = { chainId: EVM_ADDRESS.test(input.ref.wallet) ? null : 101, walletKey: moderationWalletKey(input.ref.wallet), recruiterId: null, accountId: null, subject: { wallet: input.ref.wallet } };
      } else {
        recruiter = await resolveRecruiter(client, input.ref);
        if (recruiter.account_id) await lockExclusive(client, recruiterModerationLockKey(recruiter.account_id));
        columns = { chainId: null, walletKey: "", recruiterId: recruiter.recruiter_id, accountId: recruiter.account_id, subject: { recruiterId: recruiter.recruiter_id, accountId: recruiter.account_id, code: recruiter.code, wallet: recruiter.wallet_address } };
      }

      if (input.action === "void") {
        // Recruiter void = void every unpaid, unpublished credit row of the recruiter. The blanket state
        // itself does not change (a recruiter is never "voided"; future credit follows its hold state).
        if (!recruiter.account_id) fail(409, "NOTHING_TO_VOID", "This recruiter has no payout account and so no credit to void.");
        const { rows: candidates } = await client.query(
          `select id::text as id from public.recruiter_reward_ledger
            where recruiter_id = $1::uuid and status = any($2::text[])
            order by created_at for update`,
          [recruiter.account_id, [...RECRUITER_VOIDABLE]],
        );
        const voided = [];
        const skipped = [];
        for (const { id } of candidates) {
          const sub = { kind: "recruiter_ledger", action: "void", reason: input.reason, ref: { id }, subjectKey: recruiterLedgerSubjectKey(id) };
          const subFound = await client.query(`select * from public.moderation_holds where subject_kind = 'recruiter_ledger' and subject_key = $1 for update`, [sub.subjectKey]);
          const subExisting = subFound.rows[0] || null;
          if (subExisting?.state === "voided") continue;
          const { rows: lrows } = await client.query(`select * from public.recruiter_reward_ledger where id = $1::uuid for update`, [id]);
          const lrow = lrows[0];
          const batch = await recruiterBatchOf(client, lrow.claim_id);
          if (batch && batch.status !== "prepared") { skipped.push({ id, reason: "in a published batch" }); continue; }
          if (batch && (await marker(client, recruiterBatchLockKey(batch.chain_id, batch.epoch_id)))) { skipped.push({ id, reason: "its batch is being published" }); continue; }
          const subHold = await writeHold(client, { existing: subExisting, input: sub, state: "voided", published: false, snapshot: plain(lrow), columns: { chainId: lrow.chain_id == null ? null : Number(lrow.chain_id), walletKey: "", recruiterId: null, accountId: recruiter.account_id, subject: { id, chain: lrow.chain, amountRaw: String(lrow.amount_raw), accountId: recruiter.account_id } }, actor });
          const effect = await voidRecruiterLedger(client, sub.ref, { row: lrow }, subHold.id, input.reason, actor.email);
          await writeAudit(client, { hold: subHold, input: sub, fromState: subExisting?.state || null, toState: "voided", published: false, actor, requestId, details: { ...effect, via: input.subjectKey } });
          voided.push({ id, amountRaw: effect.amountRaw, chain: effect.chain });
        }
        if (!voided.length) fail(409, "NOTHING_TO_VOID", "This recruiter has no unpaid, unpublished credit to void.", { skipped });
        const audit = await writeAudit(client, { hold: existing, input, fromState: current, toState: "voided", published: false, actor, requestId, details: { scope: "unpaid unpublished credit", voided, skipped } });
        await client.query("commit");
        return { ok: true, idempotent: false, hold: existing, auditId: audit.id, published: false, effects: { voided, skipped }, warnings };
      }

      const next = nextState(input.action, current);
      if (next.idempotent) {
        await client.query("rollback");
        return { ok: true, idempotent: true, hold: existing, auditId: null, published: false, effects: {}, warnings };
      }
      if (input.action === "hold") {
        const flights = await inFlightPublications(client);
        if (flights.length) warnings.push({ code: "PUBLICATIONS_IN_FLIGHT", message: "These lists passed their hold check before this hold and may still be published; for them the hold only stops our claim pages.", lists: flights });
      }
      const hold = await writeHold(client, { existing, input, state: next.state, published: false, snapshot: null, columns, actor });
      const audit = await writeAudit(client, { hold, input, fromState: current, toState: next.state, published: false, actor, requestId, details: { scope: input.kind === "wallet" ? "every unpublished prize of this wallet; claim guard on published ones" : "all credit and Recruiter League prizes of this recruiter; claim guard on published ones", warnings } });
      await client.query("commit");
      return { ok: true, idempotent: false, hold, auditId: audit.id, published: false, effects: {}, warnings };
    }

    // Item holds.
    const loaded = input.kind === "league_winner"
      ? await loadLeagueWinner(client, input.ref, existing)
      : input.kind === "airdrop_item"
        ? await loadAirdropItem(client, input.ref)
        : await loadRecruiterLedger(client, input.ref);

    const next = nextState(input.action, current);
    if (next.idempotent) {
      await client.query("rollback");
      return { ok: true, idempotent: true, hold: existing, auditId: null, published: Boolean(existing?.published), effects: {}, warnings };
    }
    if (input.action === "hold" && loaded.paid) fail(409, "ALREADY_PAID", "This item was already claimed or paid; there is nothing left to hold.");
    if (input.action === "void" && !loaded.voidable) fail(409, loaded.published ? "ALREADY_PUBLISHED" : "NOT_VOIDABLE", `Cannot void: ${loaded.voidBlockReason || "not voidable"}`);
    if (input.action === "hold" && loaded.published) {
      warnings.push({ code: "CLAIM_GUARD_ONLY", message: "Already published: the root cannot change. The hold stops our claim page from preparing this claim; it cannot stop a claim sent with a proof obtained elsewhere." });
    }

    const hold = await writeHold(client, { existing, input, state: next.state, published: loaded.published, snapshot: loaded.snapshot, columns: loaded.columns, actor });
    let effects = {};
    if (input.kind === "league_winner" && loaded.exclusion) effects = await updateExclusion(client, input, loaded.exclusion, next.state, warnings);
    if (next.state === "voided") {
      effects = { ...effects, ...(input.kind === "league_winner"
        ? await voidLeagueWinner(client, input.ref, loaded, hold.id)
        : input.kind === "airdrop_item"
          ? await voidAirdropItem(client, input.ref, loaded, hold.id, input.reason, actor.email)
          : await voidRecruiterLedger(client, input.ref, loaded, hold.id, input.reason, actor.email)) };
    }
    const audit = await writeAudit(client, { hold, input, fromState: current, toState: next.state, published: loaded.published, actor, requestId, details: { ...effects, warnings } });
    await client.query("commit");
    return { ok: true, idempotent: false, hold, auditId: audit.id, published: loaded.published, effects, warnings };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// --------------------------------------------------------------------------
// Read

/** Every hold row (small table), indexed for decorating the Moderation lists. Empty before the migration. */
export async function loadModerationState(db) {
  const empty = { bySubject: new Map(), wallets: new Map(), recruiters: new Map(), accounts: new Map(), available: false };
  const exists = await db.query("select to_regclass('public.moderation_holds') is not null as ok");
  if (!exists.rows?.[0]?.ok) return empty;
  const { rows } = await db.query(
    `select id::text as id, subject_kind, subject_key, subject, chain_id, wallet_key, recruiter_id::text as recruiter_id, account_id::text as account_id,
            state, reason, published, created_by, updated_by, created_at, updated_at, version
       from public.moderation_holds`,
  );
  const out = { ...empty, available: true };
  for (const row of rows) {
    out.bySubject.set(`${row.subject_kind}|${row.subject_key}`, row);
    if (row.subject_kind === "wallet" && row.state === "held" && row.wallet_key) out.wallets.set(row.wallet_key, row);
    if (row.subject_kind === "recruiter" && row.state === "held") {
      if (row.recruiter_id) out.recruiters.set(row.recruiter_id, row);
      if (row.account_id) out.accounts.set(row.account_id, row);
    }
  }
  return out;
}

export async function listModerationLog(db, { subjectKey = null, limit = 100, before = null } = {}) {
  const exists = await db.query("select to_regclass('public.moderation_audit_log') is not null as ok");
  if (!exists.rows?.[0]?.ok) return { available: false, entries: [] };
  const n = Math.max(1, Math.min(500, Number(limit) || 100));
  const { rows } = await db.query(
    `select id::text as id, hold_id::text as hold_id, subject_kind, subject_key, action, from_state, to_state, reason, published,
            actor_email, request_id, details, created_at
       from public.moderation_audit_log
      where ($1::text is null or subject_key = $1)
        and ($2::bigint is null or id < $2::bigint)
      order by id desc
      limit $3`,
    [subjectKey, before == null || before === "" ? null : Number(before), n],
  );
  return { available: true, entries: rows, nextBefore: rows.length === n ? rows[rows.length - 1].id : null };
}

// --------------------------------------------------------------------------
// Decorate the Moderation lists

export const MODERATION_STATE_FILTERS = Object.freeze(["held", "voided", "released", "none"]);

function holdView(row) {
  if (!row) return null;
  return { id: row.id, kind: row.subject_kind, key: row.subject_key, state: row.state, reason: row.reason, by: row.updated_by, at: row.updated_at, version: Number(row.version), published: Boolean(row.published) };
}

const lowerKey = (value) => moderationWalletKey(value);

/**
 * Adds `moderation` to each row: its own state, the blanket holds that cover it, what blocks payment
 * (`effective`), and which buttons apply. Pure: `state` comes from loadModerationState.
 */
export function decorateModerationRows(tab, rows, state) {
  return rows.map((row) => {
    let item = null;
    const blanket = [];
    let published = false;
    let paid = false;
    if (tab === "airdrops") {
      item = state.bySubject.get(`airdrop_item|${row.id}`) || null;
      const w = state.wallets.get(lowerKey(row.wallet));
      if (w) blanket.push(w);
      published = Boolean(row.published);
      paid = row.status === "claimed";
    } else if (tab === "leagues") {
      item = state.bySubject.get(`league_winner|${row.id}`) || null;
      for (const wallet of new Set([lowerKey(row.wallet), lowerKey(row.recipient)])) {
        const w = wallet ? state.wallets.get(wallet) : null;
        if (w && !blanket.includes(w)) blanket.push(w);
      }
      if (row.recruiterId && state.recruiters.get(String(row.recruiterId))) blanket.push(state.recruiters.get(String(row.recruiterId)));
      // A winner held out of its posted root has no leaf there, so it is not "published".
      published = Boolean(row.rootPosted) && !row.heldOutOfRoot;
      paid = row.status === "claimed" || row.releaseStatus === "paid";
    } else {
      item = state.bySubject.get(`recruiter|${row.id}`) || null;
      const viaAccount = row.accountId ? state.accounts.get(String(row.accountId)) : null;
      const viaRecruiter = row.recruiterId ? state.recruiters.get(String(row.recruiterId)) : null;
      for (const h of [viaAccount, viaRecruiter]) if (h && h !== item && !blanket.includes(h)) blanket.push(h);
    }
    const itemState = item?.state || null;
    const voided = itemState === "voided" || row.status === "voided";
    const effective = voided ? "voided" : itemState === "held" || blanket.some((h) => h.state === "held") ? "held" : null;
    const isRecruiter = tab === "recruiters";
    const moved = row.heldOutOfRoot && ["carried", "paid"].includes(row.releaseStatus);
    const walletHold = tab === "recruiters" ? null : blanket.find((h) => h.subject_kind === "wallet") || null;
    const actions = {
      hold: !voided && !paid && !moved && itemState !== "held" && state.available,
      release: !moved && itemState === "held" && state.available,
      void: state.available && !voided && !moved && (isRecruiter || (!published && !paid)),
      holdWallet: !isRecruiter && state.available && !walletHold && Boolean(row.wallet),
      releaseWallet: !isRecruiter && state.available && Boolean(walletHold),
    };
    let note = null;
    if (!state.available) note = "Moderation tables are not installed yet; actions are off.";
    else if (voided) note = "Voided: removed from payment. A void is final.";
    else if (row.heldOutOfRoot && row.releaseStatus === "paid") note = `Released after publication and paid by the Safe multisig${row.paidTx ? ` (${row.paidTx})` : ""}.`;
    else if (row.heldOutOfRoot && row.releaseStatus === "carried") note = "Released after publication and moved into a later root as a Released prize row.";
    else if (paid) note = "Already claimed or paid: nothing left to hold or void.";
    else if (row.heldOutOfRoot && row.releaseStatus === "pending") note = "Released after publication: moves into the next root of this period on Solana, automatically. Hold stops that; void keeps the money in the vault.";
    else if (row.heldOutOfRoot && row.releaseStatus === "awaiting_multisig") note = "Released after publication: paid manually via a Safe multisig proposal (scripts/league-release-safe-batch.mjs). Hold stops that; void keeps the money in the vault.";
    else if (row.heldOutOfRoot) note = `Held out of the published root: it has no leaf, its amount stays in the vault. Release pays it ${Number(row.chainId) === 101 ? "through the next root of this period (Solana)" : "by a Safe multisig proposal"}; void keeps the money in the vault.`;
    else if (published) note = "Already published: the root cannot change. Hold only stops our claim page from preparing the claim; void is not possible.";
    else if (tab === "leagues" && itemState === "held") note = "On hold: when its epoch root is posted it gets no leaf; the other winners are posted as settled. Release before then puts it back in the root.";
    else if (isRecruiter) note = "Hold covers all unpaid credit and Recruiter League prizes of this recruiter. Void voids its unpaid credit that is not in a published batch.";
    return {
      ...row,
      moderation: {
        state: itemState,
        effective,
        item: holdView(item),
        blanket: blanket.map(holdView),
        published,
        paid,
        chainId: row.chainId ?? null,
        heldOutOfRoot: Boolean(row.heldOutOfRoot),
        releasePath: row.releasePath || null,
        releaseStatus: row.releaseStatus || null,
        actions,
        note,
        subjectKind: tab === "airdrops" ? "airdrop_item" : tab === "leagues" ? "league_winner" : "recruiter",
      },
    };
  });
}

/** Row filter for ?modState=held|voided|released|none. */
export function moderationStateMatches(row, wanted) {
  if (!wanted) return true;
  const m = row.moderation || {};
  if (wanted === "held") return m.effective === "held";
  if (wanted === "voided") return m.effective === "voided";
  if (wanted === "released") return m.state === "released" && !m.effective;
  if (wanted === "none") return !m.state && !m.effective && !(m.blanket || []).length;
  return true;
}
