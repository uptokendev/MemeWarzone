import type { PoolClient, QueryResult } from "pg";
import { pool } from "../db.js";
import { ENV } from "../env.js";

export const CLAIM_REMINDER_KINDS = ["claim_inactive_30d", "claim_inactive_60d"] as const;
export type ClaimReminderKind = (typeof CLAIM_REMINDER_KINDS)[number];

export const CLAIM_REMINDER_STATUSES = ["pending", "processing", "sent", "failed", "cancelled"] as const;
export type ClaimReminderStatus = (typeof CLAIM_REMINDER_STATUSES)[number];

export type ClaimReminderStateRecord = {
  id: number;
  walletAddress: string;
  reminderKind: ClaimReminderKind;
  basisAt: string;
  firstClaimableAt: string;
  lastClaimedAt: string | null;
  dueAt: string;
  status: ClaimReminderStatus;
  nextAttemptAt: string;
  attemptCount: number;
  lastAttemptAt: string | null;
  sentAt: string | null;
  cancelledAt: string | null;
  lastError: string | null;
  targetSummary: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ClaimReminderDeliveryRecord = {
  id: number;
  reminderStateId: number;
  walletAddress: string;
  reminderKind: ClaimReminderKind;
  deliveryChannel: "outbox" | "webhook";
  attemptNumber: number;
  status: "sent" | "failed";
  attemptedAt: string;
  responseStatus: number | null;
  responseBody: string | null;
  payload: Record<string, unknown>;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type ProcessClaimRemindersResult = {
  syncedCount: number;
  cancelledCount: number;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
};

type DbLike = {
  query: (queryTextOrConfig: string | { text: string; values?: any[]; simple?: boolean }, values?: any[]) => Promise<QueryResult<any>>;
};

type ClaimReminderCandidate = {
  walletAddress: string;
  basisAt: string;
  firstClaimableAt: string;
  lastClaimedAt: string | null;
  outstandingEntryCount: number;
  outstandingAmount: string;
  outstandingEntries: unknown[];
};

const REMINDER_DAY_OFFSETS: Record<ClaimReminderKind, number> = {
  claim_inactive_30d: 30,
  claim_inactive_60d: 60,
};

function asNumber(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function mustIso(value: unknown, label: string): string {
  const iso = toIso(value);
  if (!iso) throw new Error(`Missing ${label}`);
  return iso;
}

function normalizeAddress(value: unknown): string {
  const address = String(value ?? "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(address)) {
    throw new Error(`Invalid wallet address: ${String(value ?? "")}`);
  }
  return address;
}

function isClaimReminderKind(value: unknown): value is ClaimReminderKind {
  return (CLAIM_REMINDER_KINDS as readonly string[]).includes(String(value ?? ""));
}

function isClaimReminderStatus(value: unknown): value is ClaimReminderStatus {
  return (CLAIM_REMINDER_STATUSES as readonly string[]).includes(String(value ?? ""));
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toJsonText(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function truncateText(value: string | null, maxLength = 4000): string | null {
  if (!value) return value;
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function getReminderDueAt(kind: ClaimReminderKind, basisAt: string): Date {
  const days = REMINDER_DAY_OFFSETS[kind];
  const basis = new Date(basisAt);
  return new Date(basis.getTime() + days * 24 * 60 * 60 * 1000);
}

function getRetryBackoffMs(attemptCount: number): number {
  const base = Math.max(60_000, ENV.REWARD_REMINDER_RETRY_BACKOFF_MS);
  const multiplier = Math.max(1, Math.min(8, attemptCount));
  return base * multiplier;
}

function mapClaimReminderStateRow(row: any): ClaimReminderStateRecord {
  return {
    id: asNumber(row.id),
    walletAddress: String(row.wallet_address),
    reminderKind: String(row.reminder_kind) as ClaimReminderKind,
    basisAt: mustIso(row.basis_at, "claim_reminder_states.basis_at"),
    firstClaimableAt: mustIso(row.first_claimable_at, "claim_reminder_states.first_claimable_at"),
    lastClaimedAt: toIso(row.last_claimed_at),
    dueAt: mustIso(row.due_at, "claim_reminder_states.due_at"),
    status: String(row.status) as ClaimReminderStatus,
    nextAttemptAt: mustIso(row.next_attempt_at, "claim_reminder_states.next_attempt_at"),
    attemptCount: asNumber(row.attempt_count),
    lastAttemptAt: toIso(row.last_attempt_at),
    sentAt: toIso(row.sent_at),
    cancelledAt: toIso(row.cancelled_at),
    lastError: row.last_error ? String(row.last_error) : null,
    targetSummary: asObject(row.target_summary),
    metadata: asObject(row.metadata),
    createdAt: mustIso(row.created_at, "claim_reminder_states.created_at"),
    updatedAt: mustIso(row.updated_at, "claim_reminder_states.updated_at"),
  };
}

function mapClaimReminderDeliveryRow(row: any): ClaimReminderDeliveryRecord {
  return {
    id: asNumber(row.id),
    reminderStateId: asNumber(row.reminder_state_id),
    walletAddress: String(row.wallet_address),
    reminderKind: String(row.reminder_kind) as ClaimReminderKind,
    deliveryChannel: String(row.delivery_channel) as "outbox" | "webhook",
    attemptNumber: asNumber(row.attempt_number),
    status: String(row.status) as "sent" | "failed",
    attemptedAt: mustIso(row.attempted_at, "claim_reminder_deliveries.attempted_at"),
    responseStatus: row.response_status != null ? asNumber(row.response_status) : null,
    responseBody: row.response_body ? String(row.response_body) : null,
    payload: asObject(row.payload),
    errorMessage: row.error_message ? String(row.error_message) : null,
    metadata: asObject(row.metadata),
    createdAt: mustIso(row.created_at, "claim_reminder_deliveries.created_at"),
  };
}

async function withTransaction<T>(fn: (client: PoolClient & DbLike) => Promise<T>): Promise<T> {
  const client = (await pool.connect()) as PoolClient & DbLike & { query: any };
  const origQuery = client.query.bind(client);

  client.query = (...args: any[]) => {
    if (typeof args[0] === "string") {
      return origQuery({ text: args[0], values: Array.isArray(args[1]) ? args[1] : undefined, simple: true });
    }
    if (args[0] && typeof args[0] === "object" && typeof args[0].text === "string") {
      return origQuery({ ...args[0], simple: true });
    }
    return origQuery.apply(client, args);
  };

  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      // ignore rollback errors
    }
    throw err;
  } finally {
    // Drop the per-transaction query patch: a patched client returned to the pool drops
    // pool.query's callback and hangs the next caller forever (2026-09-25 pool starvation).
    delete (client as any).query;
    client.release();
  }
}

async function listReminderCandidates(db: DbLike): Promise<ClaimReminderCandidate[]> {
  const r = await db.query(
    `select wallet_address, basis_at, first_claimable_at, last_claimed_at,
            outstanding_entry_count, outstanding_amount, outstanding_entries
       from public.claim_reminder_candidates
      order by basis_at asc, wallet_address asc`
  );

  return r.rows.map((row: any) => ({
    walletAddress: String(row.wallet_address),
    basisAt: mustIso(row.basis_at, "claim_reminder_candidates.basis_at"),
    firstClaimableAt: mustIso(row.first_claimable_at, "claim_reminder_candidates.first_claimable_at"),
    lastClaimedAt: toIso(row.last_claimed_at),
    outstandingEntryCount: asNumber(row.outstanding_entry_count),
    outstandingAmount: String(row.outstanding_amount ?? "0"),
    outstandingEntries: Array.isArray(row.outstanding_entries) ? row.outstanding_entries : [],
  }));
}

function buildTargetSummary(candidate: ClaimReminderCandidate): Record<string, unknown> {
  return {
    walletAddress: candidate.walletAddress,
    basisAt: candidate.basisAt,
    firstClaimableAt: candidate.firstClaimableAt,
    lastClaimedAt: candidate.lastClaimedAt,
    outstandingEntryCount: candidate.outstandingEntryCount,
    outstandingAmount: candidate.outstandingAmount,
    outstandingEntries: candidate.outstandingEntries,
  };
}

async function syncClaimReminderStates(asOf: Date): Promise<{ syncedCount: number; cancelledCount: number }> {
  return withTransaction(async (db) => {
    const candidates = await listReminderCandidates(db);
    let syncedCount = 0;

    for (const candidate of candidates) {
      for (const kind of CLAIM_REMINDER_KINDS) {
        const dueAt = getReminderDueAt(kind, candidate.basisAt);
        const r = await db.query(
          `insert into public.claim_reminder_states(
             wallet_address, reminder_kind, basis_at, first_claimable_at, last_claimed_at,
             due_at, status, next_attempt_at, target_summary, metadata, created_at, updated_at
           ) values (
             $1, $2, $3, $4, $5,
             $6, 'pending', $6, $7::jsonb, $8::jsonb, now(), now()
           )
           on conflict (wallet_address, reminder_kind, basis_at) do update set
             first_claimable_at = excluded.first_claimable_at,
             last_claimed_at = excluded.last_claimed_at,
             due_at = excluded.due_at,
             target_summary = excluded.target_summary,
             metadata = excluded.metadata,
             status = case
               when public.claim_reminder_states.status = 'processing' then public.claim_reminder_states.status
               when public.claim_reminder_states.status = 'sent' then public.claim_reminder_states.status
               else 'pending'
             end,
             next_attempt_at = case
               when public.claim_reminder_states.status in ('pending', 'failed', 'cancelled') then least(public.claim_reminder_states.next_attempt_at, excluded.due_at)
               else public.claim_reminder_states.next_attempt_at
             end,
             cancelled_at = case
               when public.claim_reminder_states.status = 'cancelled' then null
               else public.claim_reminder_states.cancelled_at
             end,
             updated_at = now()
           returning id`,
          [
            candidate.walletAddress,
            kind,
            candidate.basisAt,
            candidate.firstClaimableAt,
            candidate.lastClaimedAt,
            dueAt,
            toJsonText(buildTargetSummary(candidate)),
            toJsonText({ syncedAt: asOf.toISOString() }),
          ]
        );
        syncedCount += r.rowCount ?? 0;
      }
    }

    const cancelled = await db.query(
      `update public.claim_reminder_states s
          set status = 'cancelled',
              cancelled_at = coalesce(cancelled_at, $1),
              updated_at = now()
        where s.status in ('pending', 'failed')
          and not exists (
            select 1
              from public.claim_reminder_candidates c
             where c.wallet_address = s.wallet_address
               and c.basis_at = s.basis_at
          )
        returning s.id`,
      [asOf]
    );

    return {
      syncedCount,
      cancelledCount: cancelled.rowCount ?? 0,
    };
  });
}

async function claimReminderAttempt(id: number, asOf: Date): Promise<ClaimReminderStateRecord | null> {
  return withTransaction(async (db) => {
    const r = await db.query(
      `update public.claim_reminder_states
          set status = 'processing',
              attempt_count = attempt_count + 1,
              last_attempt_at = $2,
              updated_at = now()
        where id = $1
          and status in ('pending', 'failed')
          and due_at <= $2
          and next_attempt_at <= $2
        returning *`,
      [id, asOf]
    );
    return r.rows[0] ? mapClaimReminderStateRow(r.rows[0]) : null;
  });
}

async function getCurrentReminderCandidate(
  walletAddress: string,
  basisAt: string,
  db: DbLike = pool,
): Promise<ClaimReminderCandidate | null> {
  const r = await db.query(
    `select wallet_address, basis_at, first_claimable_at, last_claimed_at,
            outstanding_entry_count, outstanding_amount, outstanding_entries
       from public.claim_reminder_candidates
      where wallet_address = $1
        and basis_at = $2
      limit 1`,
    [walletAddress, basisAt]
  );

  const row = r.rows[0];
  if (!row) return null;

  return {
    walletAddress: String(row.wallet_address),
    basisAt: mustIso(row.basis_at, "claim_reminder_candidates.basis_at"),
    firstClaimableAt: mustIso(row.first_claimable_at, "claim_reminder_candidates.first_claimable_at"),
    lastClaimedAt: toIso(row.last_claimed_at),
    outstandingEntryCount: asNumber(row.outstanding_entry_count),
    outstandingAmount: String(row.outstanding_amount ?? "0"),
    outstandingEntries: Array.isArray(row.outstanding_entries) ? row.outstanding_entries : [],
  };
}

async function markReminderCancelled(id: number, asOf: Date, reason: string): Promise<void> {
  await pool.query(
    `update public.claim_reminder_states
        set status = 'cancelled',
            cancelled_at = coalesce(cancelled_at, $2),
            last_error = $3,
            updated_at = now()
      where id = $1`,
    [id, asOf, reason]
  );
}

async function finalizeReminderDelivery(input: {
  reminder: ClaimReminderStateRecord;
  attemptedAt: Date;
  deliveryChannel: "outbox" | "webhook";
  status: "sent" | "failed";
  payload: Record<string, unknown>;
  responseStatus?: number | null;
  responseBody?: string | null;
  errorMessage?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await withTransaction(async (db) => {
    await db.query(
      `insert into public.claim_reminder_deliveries(
         reminder_state_id, wallet_address, reminder_kind, delivery_channel,
         attempt_number, status, attempted_at, response_status, response_body,
         payload, error_message, metadata, created_at
       ) values (
         $1, $2, $3, $4,
         $5, $6, $7, $8, $9,
         $10::jsonb, $11, $12::jsonb, now()
       )`,
      [
        input.reminder.id,
        input.reminder.walletAddress,
        input.reminder.reminderKind,
        input.deliveryChannel,
        input.reminder.attemptCount,
        input.status,
        input.attemptedAt,
        input.responseStatus ?? null,
        truncateText(input.responseBody ?? null),
        toJsonText(input.payload),
        truncateText(input.errorMessage ?? null),
        toJsonText(input.metadata ?? {}),
      ]
    );

    if (input.status === "sent") {
      await db.query(
        `update public.claim_reminder_states
            set status = 'sent',
                sent_at = coalesce(sent_at, $2),
                next_attempt_at = $2,
                last_error = null,
                target_summary = $3::jsonb,
                updated_at = now()
          where id = $1`,
        [input.reminder.id, input.attemptedAt, toJsonText(input.payload)]
      );
      return;
    }

    const nextAttemptAt = new Date(input.attemptedAt.getTime() + getRetryBackoffMs(input.reminder.attemptCount));
    await db.query(
      `update public.claim_reminder_states
          set status = 'failed',
              next_attempt_at = $2,
              last_error = $3,
              target_summary = $4::jsonb,
              updated_at = now()
        where id = $1`,
      [input.reminder.id, nextAttemptAt, truncateText(input.errorMessage ?? "Unknown reminder delivery failure"), toJsonText(input.payload)]
    );
  });
}

async function dispatchReminder(reminder: ClaimReminderStateRecord, asOf: Date): Promise<"sent" | "failed" | "cancelled"> {
  const candidate = await getCurrentReminderCandidate(reminder.walletAddress, reminder.basisAt);
  if (!candidate) {
    await markReminderCancelled(reminder.id, asOf, "No current outstanding claim reminder candidate");
    return "cancelled";
  }

  const payload = {
    walletAddress: candidate.walletAddress,
    reminderKind: reminder.reminderKind,
    basisAt: candidate.basisAt,
    dueAt: reminder.dueAt,
    firstClaimableAt: candidate.firstClaimableAt,
    lastClaimedAt: candidate.lastClaimedAt,
    outstandingEntryCount: candidate.outstandingEntryCount,
    outstandingAmount: candidate.outstandingAmount,
    outstandingEntries: candidate.outstandingEntries,
  };

  if (!ENV.REWARD_REMINDER_WEBHOOK_URL) {
    await finalizeReminderDelivery({
      reminder,
      attemptedAt: asOf,
      deliveryChannel: "outbox",
      status: "sent",
      payload,
      metadata: { dispatchMode: "outbox" },
    });
    return "sent";
  }

  try {
    const response = await fetch(ENV.REWARD_REMINDER_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    const responseBody = truncateText(await response.text());
    if (!response.ok) {
      await finalizeReminderDelivery({
        reminder,
        attemptedAt: asOf,
        deliveryChannel: "webhook",
        status: "failed",
        payload,
        responseStatus: response.status,
        responseBody,
        errorMessage: `Reminder webhook failed with status ${response.status}`,
        metadata: { dispatchMode: "webhook" },
      });
      return "failed";
    }

    await finalizeReminderDelivery({
      reminder,
      attemptedAt: asOf,
      deliveryChannel: "webhook",
      status: "sent",
      payload,
      responseStatus: response.status,
      responseBody,
      metadata: { dispatchMode: "webhook" },
    });
    return "sent";
  } catch (error) {
    await finalizeReminderDelivery({
      reminder,
      attemptedAt: asOf,
      deliveryChannel: "webhook",
      status: "failed",
      payload,
      errorMessage: error instanceof Error ? error.message : String(error),
      metadata: { dispatchMode: "webhook" },
    });
    return "failed";
  }
}

export async function processClaimReminders(asOf = new Date(), limit = 100): Promise<ProcessClaimRemindersResult> {
  const syncResult = await syncClaimReminderStates(asOf);
  const dueStates = await listClaimReminderStates({
    status: ["pending", "failed"],
    dueBefore: asOf,
    limit,
  });

  let sentCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const state of dueStates) {
    const claimed = await claimReminderAttempt(state.id, asOf);
    if (!claimed) {
      skippedCount += 1;
      continue;
    }

    const outcome = await dispatchReminder(claimed, asOf);
    if (outcome === "sent") sentCount += 1;
    else if (outcome === "failed") failedCount += 1;
    else skippedCount += 1;
  }

  return {
    syncedCount: syncResult.syncedCount,
    cancelledCount: syncResult.cancelledCount,
    sentCount,
    failedCount,
    skippedCount,
  };
}

export async function listClaimReminderStates(filters: {
  walletAddress?: string | null;
  reminderKind?: ClaimReminderKind | null;
  status?: ClaimReminderStatus | ClaimReminderStatus[] | null;
  dueBefore?: Date | null;
  limit?: number;
} = {}, db: DbLike = pool): Promise<ClaimReminderStateRecord[]> {
  const clauses = ["1=1"];
  const values: any[] = [];

  if (filters.walletAddress) {
    values.push(normalizeAddress(filters.walletAddress));
    clauses.push(`wallet_address = $${values.length}`);
  }
  if (filters.reminderKind) {
    if (!isClaimReminderKind(filters.reminderKind)) throw new Error(`Invalid reminder kind: ${String(filters.reminderKind)}`);
    values.push(filters.reminderKind);
    clauses.push(`reminder_kind = $${values.length}`);
  }
  if (filters.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    if (!statuses.every((status) => isClaimReminderStatus(status))) {
      throw new Error(`Invalid reminder status filter: ${String(filters.status)}`);
    }
    values.push(statuses);
    clauses.push(`status = any($${values.length}::text[])`);
  }
  if (filters.dueBefore) {
    values.push(filters.dueBefore);
    clauses.push(`due_at <= $${values.length}`);
    values.push(filters.dueBefore);
    clauses.push(`next_attempt_at <= $${values.length}`);
  }

  values.push(Math.max(1, Math.min(500, Math.trunc(filters.limit ?? 100) || 100)));
  const r = await db.query(
    `select *
       from public.claim_reminder_states
      where ${clauses.join(" and ")}
      order by due_at asc, id asc
      limit $${values.length}`,
    values
  );

  return r.rows.map(mapClaimReminderStateRow);
}

export async function listClaimReminderDeliveries(filters: {
  walletAddress?: string | null;
  reminderStateId?: number | null;
  reminderKind?: ClaimReminderKind | null;
  limit?: number;
} = {}, db: DbLike = pool): Promise<ClaimReminderDeliveryRecord[]> {
  const clauses = ["1=1"];
  const values: any[] = [];

  if (filters.walletAddress) {
    values.push(normalizeAddress(filters.walletAddress));
    clauses.push(`wallet_address = $${values.length}`);
  }
  if (filters.reminderStateId != null) {
    values.push(filters.reminderStateId);
    clauses.push(`reminder_state_id = $${values.length}`);
  }
  if (filters.reminderKind) {
    if (!isClaimReminderKind(filters.reminderKind)) throw new Error(`Invalid reminder kind: ${String(filters.reminderKind)}`);
    values.push(filters.reminderKind);
    clauses.push(`reminder_kind = $${values.length}`);
  }

  values.push(Math.max(1, Math.min(500, Math.trunc(filters.limit ?? 100) || 100)));
  const r = await db.query(
    `select *
       from public.claim_reminder_deliveries
      where ${clauses.join(" and ")}
      order by attempted_at desc, id desc
      limit $${values.length}`,
    values
  );

  return r.rows.map(mapClaimReminderDeliveryRow);
}
