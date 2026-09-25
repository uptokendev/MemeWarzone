import type { PoolClient, QueryResult } from "pg";
import { pool } from "../db.js";

export type RecruiterStatus = "active" | "inactive" | "closed" | "suspended";
export type LinkSource = "referral_cookie" | "manual" | "admin_override" | "migration";

export type WalletAttributionState = {
  walletAddress: string;
  firstSeenAt: string | null;
  firstActivityAt: string | null;
  hasActivity: boolean;
  createdCampaignCount: number;
  tradeCount: number;
  recruiterLinkState: "unlinked" | "linked_unlocked" | "linked_locked" | "detached" | "closed_history";
  squadState: "solo" | "solo_detached" | "in_squad";
  detachReason: string | null;
  recruiter: null | {
    id: number;
    walletAddress: string;
    code: string;
    displayName: string | null;
    isOg: boolean;
    status: RecruiterStatus;
    linkedAt: string;
    lockedAt: string | null;
    linkSource: LinkSource;
  };
  squad: null | {
    recruiterId: number;
    recruiterCode: string;
    recruiterDisplayName: string | null;
    joinedAt: string;
  };
  lastLink: null | {
    recruiterId: number | null;
    recruiterCode: string | null;
    recruiterStatus: RecruiterStatus | null;
    linkedAt: string | null;
    lockedAt: string | null;
    detachedAt: string | null;
    detachReason: string | null;
  };
};

export type RecruiterRecord = {
  id: number;
  walletAddress: string;
  code: string;
  displayName: string | null;
  isOg: boolean;
  status: RecruiterStatus;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CaptureReferralWindowInput = {
  recruiterId: number;
  walletAddress?: string | null;
  clientFingerprint?: string | null;
  sessionToken?: string | null;
  capturedAt?: Date;
  expiresAt?: Date;
  metadata?: Record<string, unknown> | null;
};

export type LinkWalletToRecruiterResult = {
  changed: boolean;
  errorCode: string | null;
  state: WalletAttributionState;
};

export type ApplyRecruiterDisputeOverrideResult = {
  changed: boolean;
  previousRecruiter: RecruiterRecord | null;
  recruiter: RecruiterRecord;
  state: WalletAttributionState;
};

type DbLike = {
  query: (queryTextOrConfig: string | { text: string; values?: any[]; simple?: boolean }, values?: any[]) => Promise<QueryResult<any>>;
};

function normalizeAddress(value: unknown): string {
  const address = String(value ?? "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(address)) {
    throw new Error(`Invalid wallet address: ${String(value ?? "")}`);
  }
  return address;
}

function normalizeCode(value: unknown): string {
  const code = String(value ?? "").trim();
  if (!code) throw new Error("Recruiter code is required");
  return code;
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function asNumber(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function mustIso(value: unknown, label: string): string {
  const iso = toIso(value);
  if (!iso) throw new Error(`Missing ${label}`);
  return iso;
}

function mapRecruiterRecordRow(row: any): RecruiterRecord {
  return {
    id: asNumber(row.id),
    walletAddress: String(row.wallet_address),
    code: String(row.code),
    displayName: row.display_name ? String(row.display_name) : null,
    isOg: Boolean(row.is_og),
    status: row.status,
    closedAt: toIso(row.closed_at),
    createdAt: mustIso(row.created_at, "recruiter.createdAt"),
    updatedAt: mustIso(row.updated_at, "recruiter.updatedAt"),
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
      // ignore rollback error
    }
    throw err;
  } finally {
    // Drop the per-transaction query patch: a patched client returned to the pool drops
    // pool.query's callback and hangs the next caller forever (2026-09-25 pool starvation).
    delete (client as any).query;
    client.release();
  }
}

async function ensureWalletProfileDb(db: DbLike, walletAddress: string, seenAt: Date): Promise<void> {
  await db.query(
    `insert into public.wallet_profiles(wallet_address, first_seen_at, updated_at)
     values ($1, $2, now())
     on conflict (wallet_address) do update
       set first_seen_at = least(public.wallet_profiles.first_seen_at, excluded.first_seen_at),
           updated_at = now()`,
    [walletAddress, seenAt]
  );
}

async function getCurrentActiveRecruiterLinkDb(db: DbLike, walletAddress: string): Promise<any | null> {
  const r = await db.query(
    `select l.id, l.wallet_address, l.recruiter_id, l.link_source, l.linked_at, l.locked_at,
            l.detached_at, l.detach_reason, l.is_active,
            r.status as recruiter_status, r.code as recruiter_code
       from public.wallet_recruiter_links l
       join public.recruiters r on r.id = l.recruiter_id
      where l.wallet_address = $1 and l.is_active = true
      order by l.linked_at desc, l.id desc
      limit 1`,
    [walletAddress]
  );
  return r.rows[0] ?? null;
}

async function getWalletAttributionStateDb(db: DbLike, walletAddress: string): Promise<WalletAttributionState> {
  const normalized = normalizeAddress(walletAddress);
  const r = await db.query(
    `select *
       from public.wallet_attribution_states
      where wallet_address = $1`,
    [normalized]
  );

  const row = r.rows[0];
  if (!row) {
    return {
      walletAddress: normalized,
      firstSeenAt: null,
      firstActivityAt: null,
      hasActivity: false,
      createdCampaignCount: 0,
      tradeCount: 0,
      recruiterLinkState: "unlinked",
      squadState: "solo",
      detachReason: null,
      recruiter: null,
      squad: null,
      lastLink: null,
    };
  }

  return {
    walletAddress: normalized,
    firstSeenAt: toIso(row.first_seen_at),
    firstActivityAt: toIso(row.first_activity_at),
    hasActivity: Boolean(row.has_activity),
    createdCampaignCount: asNumber(row.created_campaign_count),
    tradeCount: asNumber(row.trade_count),
    recruiterLinkState: row.recruiter_link_state,
    squadState: row.squad_state,
    detachReason: row.last_detach_reason ?? null,
    recruiter: row.recruiter_id
      ? {
          id: asNumber(row.recruiter_id),
          walletAddress: String(row.recruiter_wallet_address),
          code: String(row.recruiter_code),
          displayName: row.recruiter_display_name ? String(row.recruiter_display_name) : null,
          isOg: Boolean(row.recruiter_is_og),
          status: row.recruiter_status,
          linkedAt: mustIso(row.linked_at, "linkedAt"),
          lockedAt: toIso(row.locked_at),
          linkSource: row.link_source,
        }
      : null,
    squad: row.squad_recruiter_id
      ? {
          recruiterId: asNumber(row.squad_recruiter_id),
          recruiterCode: String(row.squad_recruiter_code),
          recruiterDisplayName: row.squad_recruiter_display_name ? String(row.squad_recruiter_display_name) : null,
          joinedAt: mustIso(row.squad_joined_at, "squad.joinedAt"),
        }
      : null,
    lastLink: row.last_link_id
      ? {
          recruiterId: row.last_recruiter_id != null ? asNumber(row.last_recruiter_id) : null,
          recruiterCode: row.last_recruiter_code ? String(row.last_recruiter_code) : null,
          recruiterStatus: row.last_recruiter_status ?? null,
          linkedAt: toIso(row.last_linked_at),
          lockedAt: toIso(row.last_locked_at),
          detachedAt: toIso(row.last_detached_at),
          detachReason: row.last_detach_reason ? String(row.last_detach_reason) : null,
        }
      : null,
  };
}

export async function getWalletAttributionState(walletAddress: string): Promise<WalletAttributionState> {
  return getWalletAttributionStateDb(pool, walletAddress);
}

export async function createOrUpdateRecruiter(input: {
  walletAddress: string;
  code: string;
  displayName?: string | null;
  isOg?: boolean;
  status?: RecruiterStatus;
}): Promise<RecruiterRecord> {
  const walletAddress = normalizeAddress(input.walletAddress);
  const code = normalizeCode(input.code);
  const status: RecruiterStatus = input.status ?? "active";
  const r = await pool.query(
    `insert into public.recruiters(wallet_address, code, display_name, is_og, status, updated_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (wallet_address) do update
       set code = excluded.code,
           display_name = excluded.display_name,
           is_og = excluded.is_og,
           status = excluded.status,
           closed_at = case when excluded.status = 'closed' then coalesce(public.recruiters.closed_at, now()) else null end,
           updated_at = now()
     returning id, wallet_address, code, display_name, is_og, status, closed_at, created_at, updated_at`,
    [walletAddress, code, input.displayName ?? null, Boolean(input.isOg), status]
  );
  return mapRecruiterRecordRow(r.rows[0]);
}

export async function resolveRecruiterByCode(code: string): Promise<RecruiterRecord | null> {
  const normalized = normalizeCode(code).toLowerCase();
  const r = await pool.query(
    `select id, wallet_address, code, display_name, is_og, status, closed_at, created_at, updated_at
       from public.recruiters
      where lower(code) = $1
      limit 1`,
    [normalized]
  );
  const row = r.rows[0];
  if (!row) return null;
  return mapRecruiterRecordRow(row);
}

async function resolveRecruiterByIdDb(db: DbLike, recruiterId: number): Promise<RecruiterRecord | null> {
  const r = await db.query(
    `select id, wallet_address, code, display_name, is_og, status, closed_at, created_at, updated_at
       from public.recruiters
      where id = $1
      limit 1`,
    [recruiterId]
  );
  return r.rows[0] ? mapRecruiterRecordRow(r.rows[0]) : null;
}

export async function captureReferralWindow(input: CaptureReferralWindowInput): Promise<{ id: number; expiresAt: string }> {
  const capturedAt = input.capturedAt ?? new Date();
  const expiresAt = input.expiresAt ?? new Date(capturedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
  const walletAddress = input.walletAddress ? normalizeAddress(input.walletAddress) : null;
  const r = await pool.query(
    `insert into public.wallet_referral_attribution_windows(
        wallet_address, recruiter_id, client_fingerprint, session_token,
        captured_at, expires_at, metadata, updated_at
     ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, now())
     returning id, expires_at`,
    [
      walletAddress,
      input.recruiterId,
      input.clientFingerprint ?? null,
      input.sessionToken ?? null,
      capturedAt,
      expiresAt,
      JSON.stringify(input.metadata ?? {}),
    ]
  );
  return { id: asNumber(r.rows[0].id), expiresAt: mustIso(r.rows[0].expires_at, "referral.expiresAt") };
}

async function findOpenReferralWindowDb(
  db: DbLike,
  args: { walletAddress?: string | null; sessionToken?: string | null; clientFingerprint?: string | null }
): Promise<any | null> {
  const identifiers: string[] = [];
  const values: any[] = [];
  let p = 1;

  const walletAddress = args.walletAddress ? normalizeAddress(args.walletAddress) : null;
  if (walletAddress) {
    identifiers.push(`wallet_address = $${p++}`);
    values.push(walletAddress);
  }
  if (args.sessionToken) {
    identifiers.push(`session_token = $${p++}`);
    values.push(String(args.sessionToken));
  }
  if (args.clientFingerprint) {
    identifiers.push(`client_fingerprint = $${p++}`);
    values.push(String(args.clientFingerprint));
  }

  if (identifiers.length === 0) return null;

  const r = await db.query(
    `select id, wallet_address, recruiter_id, client_fingerprint, session_token, captured_at, expires_at
       from public.wallet_referral_attribution_windows
      where consumed_at is null
        and expires_at > now()
        and (${identifiers.join(" or ")})
      order by captured_at desc, id desc
      limit 1`,
    values
  );
  return r.rows[0] ?? null;
}

async function ensureRecruiterIsLinkableDb(db: DbLike, recruiterId: number): Promise<any> {
  const r = await db.query(
    `select id, wallet_address, code, display_name, is_og, status
       from public.recruiters
      where id = $1
      limit 1`,
    [recruiterId]
  );
  const recruiter = r.rows[0];
  if (!recruiter) throw new Error(`Recruiter ${recruiterId} not found`);
  if (String(recruiter.status) !== "active") {
    throw new Error(`Recruiter ${recruiterId} is not active`);
  }
  return recruiter;
}

async function linkWalletToRecruiterDb(
  db: DbLike,
  input: {
    walletAddress: string;
    recruiterId: number;
    linkSource: LinkSource;
    linkedAt: Date;
    bypassLock?: boolean;
    detachReason?: string;
  }
): Promise<LinkWalletToRecruiterResult> {
  const walletAddress = normalizeAddress(input.walletAddress);
  await ensureRecruiterIsLinkableDb(db, input.recruiterId);
  await ensureWalletProfileDb(db, walletAddress, input.linkedAt);

  const profileRes = await db.query(
    `select has_activity, first_activity_at
       from public.wallet_profiles
      where wallet_address = $1`,
    [walletAddress]
  );
  const hasActivity = Boolean(profileRes.rows[0]?.has_activity);

  const existing = await getCurrentActiveRecruiterLinkDb(db, walletAddress);
  if (existing && asNumber(existing.recruiter_id) === input.recruiterId) {
    return {
      changed: false,
      errorCode: null,
      state: await getWalletAttributionStateDb(db, walletAddress),
    };
  }

  if (existing && (existing.locked_at || hasActivity) && !input.bypassLock) {
    return {
      changed: false,
      errorCode: "RECRUITER_LINK_LOCKED",
      state: await getWalletAttributionStateDb(db, walletAddress),
    };
  }

  if (existing) {
    await db.query(
      `update public.wallet_recruiter_links
          set is_active = false,
              detached_at = $2,
              detach_reason = $3,
              updated_at = now()
        where id = $1`,
      [existing.id, input.linkedAt, input.detachReason ?? "relinked_before_first_activity"]
    );

    await db.query(
      `update public.wallet_squad_memberships
          set is_active = false,
              left_at = $2,
              leave_reason = $3,
              updated_at = now()
        where wallet_address = $1 and is_active = true`,
      [walletAddress, input.linkedAt, input.detachReason ?? "relinked_before_first_activity"]
    );
  } else if (input.bypassLock) {
    await db.query(
      `update public.wallet_squad_memberships
          set is_active = false,
              left_at = $2,
              leave_reason = $3,
              updated_at = now()
        where wallet_address = $1 and is_active = true`,
      [walletAddress, input.linkedAt, input.detachReason ?? "admin_dispute_override"]
    );
  }

  const lockedAt = hasActivity ? input.linkedAt : null;
  await db.query(
    `insert into public.wallet_recruiter_links(
        wallet_address, recruiter_id, link_source, linked_at,
        locked_at, detached_at, detach_reason, is_active, created_at, updated_at
     ) values ($1, $2, $3, $4, $5, null, null, true, now(), now())`,
    [walletAddress, input.recruiterId, input.linkSource, input.linkedAt, lockedAt]
  );

  await db.query(
    `insert into public.wallet_squad_memberships(
        wallet_address, recruiter_id, joined_at, left_at, leave_reason, is_active, created_at, updated_at
     ) values ($1, $2, $3, null, null, true, now(), now())`,
    [walletAddress, input.recruiterId, input.linkedAt]
  );

  return {
    changed: true,
    errorCode: null,
    state: await getWalletAttributionStateDb(db, walletAddress),
  };
}

export async function linkWalletToRecruiter(input: {
  walletAddress: string;
  recruiterId: number;
  linkSource: LinkSource;
  linkedAt?: Date;
}): Promise<LinkWalletToRecruiterResult> {
  return withTransaction((db) =>
    linkWalletToRecruiterDb(db, {
      ...input,
      linkedAt: input.linkedAt ?? new Date(),
    })
  );
}

export async function applyRecruiterDisputeOverride(input: {
  walletAddress: string;
  recruiterId: number;
  linkedAt?: Date;
  reason?: string | null;
}): Promise<ApplyRecruiterDisputeOverrideResult> {
  return withTransaction(async (db) => {
    const linkedAt = input.linkedAt ?? new Date();
    const walletAddress = normalizeAddress(input.walletAddress);
    const existing = await getCurrentActiveRecruiterLinkDb(db, walletAddress);
    const previousRecruiter = existing?.recruiter_id
      ? await resolveRecruiterByIdDb(db, asNumber(existing.recruiter_id))
      : null;

    const result = await linkWalletToRecruiterDb(db, {
      walletAddress,
      recruiterId: input.recruiterId,
      linkSource: "admin_override",
      linkedAt,
      bypassLock: true,
      detachReason: input.reason ?? "admin_dispute_override",
    });

    const recruiter = await resolveRecruiterByIdDb(db, input.recruiterId);
    if (!recruiter) throw new Error(`Recruiter ${input.recruiterId} not found`);

    return {
      changed: result.changed,
      previousRecruiter,
      recruiter,
      state: result.state,
    };
  });
}

export async function linkWalletOnConnect(input: {
  walletAddress: string;
  sessionToken?: string | null;
  clientFingerprint?: string | null;
  linkedAt?: Date;
}): Promise<LinkWalletToRecruiterResult> {
  return withTransaction(async (db) => {
    const linkedAt = input.linkedAt ?? new Date();
    const walletAddress = normalizeAddress(input.walletAddress);
    await ensureWalletProfileDb(db, walletAddress, linkedAt);

    const current = await getCurrentActiveRecruiterLinkDb(db, walletAddress);
    if (current) {
      return {
        changed: false,
        errorCode: null,
        state: await getWalletAttributionStateDb(db, walletAddress),
      };
    }

    const window = await findOpenReferralWindowDb(db, {
      walletAddress,
      sessionToken: input.sessionToken ?? null,
      clientFingerprint: input.clientFingerprint ?? null,
    });

    if (!window) {
      return {
        changed: false,
        errorCode: "NO_RECRUITER",
        state: await getWalletAttributionStateDb(db, walletAddress),
      };
    }

    await db.query(
      `update public.wallet_referral_attribution_windows
          set wallet_address = coalesce(wallet_address, $2),
              consumed_at = $3,
              updated_at = now()
        where id = $1`,
      [window.id, walletAddress, linkedAt]
    );

    return linkWalletToRecruiterDb(db, {
      walletAddress,
      recruiterId: asNumber(window.recruiter_id),
      linkSource: "referral_cookie",
      linkedAt,
    });
  });
}

async function markWalletActivityDb(
  db: DbLike,
  input: { walletAddress: string; activityAt: Date; tradeDelta: number; campaignDelta: number }
): Promise<void> {
  const walletAddress = normalizeAddress(input.walletAddress);
  const firstActivityAt = input.activityAt;
  await db.query(
    `insert into public.wallet_profiles(
        wallet_address, first_seen_at, first_activity_at, has_activity,
        created_campaign_count, trade_count,
        last_campaign_created_at, last_trade_at, updated_at
     ) values (
        $1::text, $2::timestamptz, $2::timestamptz, true,
        greatest($3::int, 0), greatest($4::int, 0),
        case when $3::int > 0 then $2::timestamptz else null end,
        case when $4::int > 0 then $2::timestamptz else null end,
        now()
     )
     on conflict (wallet_address) do update set
       first_seen_at = least(public.wallet_profiles.first_seen_at, excluded.first_seen_at),
       first_activity_at = case
         when public.wallet_profiles.first_activity_at is null then excluded.first_activity_at
         else least(public.wallet_profiles.first_activity_at, excluded.first_activity_at)
       end,
       has_activity = true,
       created_campaign_count = public.wallet_profiles.created_campaign_count + greatest($3::int, 0),
       trade_count = public.wallet_profiles.trade_count + greatest($4::int, 0),
       last_campaign_created_at = case
         when $3::int > 0 then greatest(coalesce(public.wallet_profiles.last_campaign_created_at, to_timestamp(0)), excluded.last_campaign_created_at)
         else public.wallet_profiles.last_campaign_created_at
       end,
       last_trade_at = case
         when $4::int > 0 then greatest(coalesce(public.wallet_profiles.last_trade_at, to_timestamp(0)), excluded.last_trade_at)
         else public.wallet_profiles.last_trade_at
       end,
       updated_at = now()`,
    [walletAddress, firstActivityAt, input.campaignDelta, input.tradeDelta]
  );

  await db.query(
    `update public.wallet_recruiter_links
        set locked_at = coalesce(locked_at, $2),
            updated_at = now()
      where wallet_address = $1 and is_active = true and locked_at is null`,
    [walletAddress, firstActivityAt]
  );
}

export async function recordTradeActivity(walletAddress: string, activityAt: Date): Promise<void> {
  await withTransaction((db) => markWalletActivityDb(db, { walletAddress, activityAt, tradeDelta: 1, campaignDelta: 0 }));
}

export async function recordCampaignCreatedActivity(walletAddress: string, activityAt: Date): Promise<void> {
  await withTransaction((db) => markWalletActivityDb(db, { walletAddress, activityAt, tradeDelta: 0, campaignDelta: 1 }));
}

export async function setRecruiterStatus(input: {
  recruiterId: number;
  status: RecruiterStatus;
  changedAt?: Date;
  detachMembers?: boolean;
  detachReason?: string;
}): Promise<{ recruiter: RecruiterRecord; detachedWalletCount: number }> {
  return withTransaction(async (db) => {
    const changedAt = input.changedAt ?? new Date();
    const detachMembers = Boolean(input.detachMembers) || input.status === "closed";
    const rr = await db.query(
      `update public.recruiters
          set status = $2,
              closed_at = case when $2 = 'closed' then coalesce(closed_at, $3) else null end,
              updated_at = now()
        where id = $1
        returning id, wallet_address, code, display_name, is_og, status, closed_at, created_at, updated_at`,
      [input.recruiterId, input.status, changedAt]
    );

    const recruiterRow = rr.rows[0];
    if (!recruiterRow) throw new Error(`Recruiter ${input.recruiterId} not found`);

    let detachedWalletCount = 0;
    if (detachMembers) {
      const reason = input.detachReason ?? (input.status === "closed" ? "recruiter_closed" : "recruiter_status_changed");
      const links = await db.query(
        `update public.wallet_recruiter_links
            set is_active = false,
                detached_at = $2,
                detach_reason = $3,
                updated_at = now()
          where recruiter_id = $1 and is_active = true
          returning wallet_address`,
        [input.recruiterId, changedAt, reason]
      );
      detachedWalletCount = links.rowCount ?? 0;

      await db.query(
        `update public.wallet_squad_memberships
            set is_active = false,
                left_at = $2,
                leave_reason = $3,
                updated_at = now()
          where recruiter_id = $1 and is_active = true`,
        [input.recruiterId, changedAt, reason]
      );
    }

    return {
      recruiter: mapRecruiterRecordRow(recruiterRow),
      detachedWalletCount,
    };
  });
}

export async function setRecruiterOgStatus(input: {
  recruiterId: number;
  isOg: boolean;
}): Promise<RecruiterRecord> {
  const r = await pool.query(
    `update public.recruiters
        set is_og = $2,
            updated_at = now()
      where id = $1
      returning id, wallet_address, code, display_name, is_og, status, closed_at, created_at, updated_at`,
    [input.recruiterId, input.isOg]
  );
  if (!r.rows[0]) throw new Error(`Recruiter ${input.recruiterId} not found`);
  return mapRecruiterRecordRow(r.rows[0]);
}
