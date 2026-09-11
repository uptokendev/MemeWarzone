import { createHash, randomBytes, randomUUID } from "node:crypto";

export const TICKER_RESERVATION_STATUS = Object.freeze({
  DRAFT_UNRESERVED: "DRAFT_UNRESERVED",
  SOFT_RESERVED: "SOFT_RESERVED",
  PREPARE_MODE_RESERVED: "PREPARE_MODE_RESERVED",
  SCHEDULED_UNARMED: "SCHEDULED_UNARMED",
  ARM_AUTHORIZED: "ARM_AUTHORIZED",
  ARMING: "ARMING",
  ARMED_ONCHAIN: "ARMED_ONCHAIN",
  LIVE: "LIVE",
  DEPLOY_FAILED: "DEPLOY_FAILED",
  EXPIRED_GRACE: "EXPIRED_GRACE",
  RELEASED: "RELEASED",
  SCHEDULE_MISSED: "SCHEDULE_MISSED",
});

export const SOFT_RESERVATION_HOURS = 72;
export const PUBLISHED_RESERVATION_DAYS = 14;
export const RESERVATION_EXTENSION_DAYS = 14;
export const RESERVATION_GRACE_HOURS = 24;
export const MAX_RESERVATION_RENEWALS = 2;

const RELEASED_STATUSES = new Set([
  TICKER_RESERVATION_STATUS.DRAFT_UNRESERVED,
  TICKER_RESERVATION_STATUS.RELEASED,
]);
const LOCKED_ONCHAIN_STATUSES = new Set([
  TICKER_RESERVATION_STATUS.ARMED_ONCHAIN,
  TICKER_RESERVATION_STATUS.LIVE,
]);
const EXPIRABLE_STATUSES = [
  TICKER_RESERVATION_STATUS.SOFT_RESERVED,
  TICKER_RESERVATION_STATUS.PREPARE_MODE_RESERVED,
  TICKER_RESERVATION_STATUS.SCHEDULED_UNARMED,
  TICKER_RESERVATION_STATUS.DEPLOY_FAILED,
  TICKER_RESERVATION_STATUS.EXPIRED_GRACE,
  TICKER_RESERVATION_STATUS.SCHEDULE_MISSED,
];

export class TickerReservationError extends Error {
  constructor(message, { code = "TICKER_RESERVATION_ERROR", httpStatus = 409, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "TickerReservationError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function normalizeTicker(value) {
  return String(value || "")
    .trim()
    .replace(/^\$+/, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .slice(0, 12);
}

export function sha256Hex(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function canonicalSolanaCluster(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["mainnet", "mainnet-beta", "solana-mainnet", "solana-mainnet-beta"].includes(normalized)) {
    return "solana-mainnet-beta";
  }
  if (["devnet", "solana-devnet"].includes(normalized)) return "solana-devnet";
  if (["testnet", "solana-testnet"].includes(normalized)) return "solana-testnet";
  if (["localnet", "localhost", "solana-localnet"].includes(normalized)) return "solana-localnet";
  return normalized;
}

export function canonicalClusterForChain(chainId, explicitCluster = "") {
  const numericChainId = Number(chainId);
  if (numericChainId === 102) {
    throw new TickerReservationError("Legacy Solana chain 102 cannot select a current reservation or deployment cluster.", {
      code: "LEGACY_SOLANA_CHAIN_NOT_AUTHORIZED",
      httpStatus: 400,
    });
  }

  const explicit = String(explicitCluster || "").trim().toLowerCase();
  if (explicit) {
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(explicit)) {
      throw new TickerReservationError("Invalid chain cluster.", {
        code: "INVALID_RESERVATION_CLUSTER",
        httpStatus: 400,
      });
    }
    return numericChainId === 101 ? canonicalSolanaCluster(explicit) : explicit;
  }

  if (numericChainId === 56) return "bsc-mainnet";
  if (numericChainId === 97) return "bsc-testnet";
  // Current Solana application identity is chain 101; cluster is explicit runtime state.
  if (numericChainId === 101) {
    return canonicalSolanaCluster(
      process.env.SOLANA_CLUSTER || process.env.VITE_SOLANA_CLUSTER || "solana-mainnet-beta",
    );
  }
  return `chain-${numericChainId}`;
}

export function isBlockingReservationStatus(status) {
  return !RELEASED_STATUSES.has(String(status || ""));
}

export function mapTickerReservationRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    draftId: row.draft_id ? String(row.draft_id) : null,
    creatorWallet: String(row.creator_wallet || ""),
    chainId: Number(row.chain_id),
    cluster: String(row.cluster || ""),
    originalTicker: String(row.original_ticker || ""),
    normalizedTicker: normalizeTicker(row.normalized_ticker || row.original_ticker),
    tickerHash: String(row.ticker_hash || ""),
    reservationIdHash: String(row.reservation_id_hash || ""),
    status: String(row.status || ""),
    reservedAt: row.reserved_at ?? null,
    publishedAt: row.published_at ?? null,
    expiresAt: row.expires_at ?? null,
    graceEndAt: row.grace_end_at ?? null,
    renewalCount: Number(row.renewal_count || 0),
    scheduledLaunchAt: row.scheduled_launch_at ?? null,
    armAuthorizedAt: row.arm_authorized_at ?? null,
    armingAt: row.arming_at ?? null,
    armedAt: row.armed_at ?? null,
    liveAt: row.live_at ?? null,
    scheduleMissedAt: row.schedule_missed_at ?? null,
    releasedAt: row.released_at ?? null,
    programId: row.program_id ?? null,
    generationId: row.generation_id ?? null,
    campaignPda: row.campaign_pda ?? null,
    mint: row.mint ?? null,
    deploymentSignature: row.deployment_signature ?? null,
    reservationVersion: String(row.reservation_version || "1"),
    authorizationNonce: row.authorization_nonce ?? null,
    failureReason: row.failure_reason ?? null,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

export function isTickerReservationSchemaMissing(error) {
  return error?.code === "42P01" || error?.code === "42703";
}

export function isTickerReservationConflict(error) {
  return error instanceof TickerReservationError || error?.code === "23505";
}

export async function withTickerReservationTransaction(pool, work) {
  if (!pool?.connect) return work(pool);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function recordEvent(db, {
  reservationId,
  eventType,
  fromStatus = null,
  toStatus = null,
  actorType = "system",
  actorWallet = null,
  reason = null,
  metadata = {},
}) {
  await db.query(
    `insert into public.ticker_reservation_events
       (reservation_id, event_type, from_status, to_status, actor_type, actor_wallet, reason, metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [
      reservationId,
      eventType,
      fromStatus,
      toStatus,
      actorType,
      actorWallet || null,
      reason || null,
      JSON.stringify(metadata || {}),
    ],
  );
}

export async function refreshExpiredTickerReservations(db, {
  chainId = null,
  cluster = null,
  normalizedTicker = null,
  draftId = null,
} = {}) {
  const ticker = normalizedTicker ? normalizeTicker(normalizedTicker) : null;
  const reservationCluster = cluster ? canonicalClusterForChain(chainId, cluster) : null;
  const params = [
    chainId == null ? null : Number(chainId),
    reservationCluster,
    ticker || null,
    draftId || null,
    EXPIRABLE_STATUSES,
  ];

  const released = await db.query(
    `with candidates as materialized (
       select id, status
         from public.ticker_reservations
        where status = any($5::text[])
          and expires_at is not null
          and expires_at <= now()
          and (grace_end_at is null or grace_end_at <= now())
          and ($1::integer is null or chain_id = $1)
          and ($2::text is null or cluster = $2)
          and ($3::text is null or normalized_ticker = $3)
          and ($4::uuid is null or draft_id = $4)
        for update
     ), changed as (
       update public.ticker_reservations r
          set status = 'RELEASED',
              released_at = coalesce(r.released_at, now()),
              failure_reason = coalesce(r.failure_reason, 'Reservation expired after grace period.'),
              reservation_version = r.reservation_version + 1,
              updated_at = now()
         from candidates c
        where r.id = c.id
       returning r.id, c.status as from_status, r.status as to_status
     )
     insert into public.ticker_reservation_events
       (reservation_id, event_type, from_status, to_status, actor_type, reason, metadata)
     select id, 'reservation_released_after_grace', from_status, to_status, 'system',
            'Reservation expired after the grace period.', '{}'::jsonb
       from changed
     returning reservation_id`,
    params,
  );

  const grace = await db.query(
    `with candidates as materialized (
       select id, status
         from public.ticker_reservations
        where status = any($5::text[])
          and status <> 'EXPIRED_GRACE'
          and expires_at is not null
          and expires_at <= now()
          and grace_end_at > now()
          and ($1::integer is null or chain_id = $1)
          and ($2::text is null or cluster = $2)
          and ($3::text is null or normalized_ticker = $3)
          and ($4::uuid is null or draft_id = $4)
        for update
     ), changed as (
       update public.ticker_reservations r
          set status = 'EXPIRED_GRACE',
              failure_reason = coalesce(r.failure_reason, 'Reservation expired; grace period active.'),
              updated_at = now()
         from candidates c
        where r.id = c.id
       returning r.id, c.status as from_status, r.status as to_status
     )
     insert into public.ticker_reservation_events
       (reservation_id, event_type, from_status, to_status, actor_type, reason, metadata)
     select id, 'reservation_entered_grace', from_status, to_status, 'system',
            'Reservation expiry reached; grace period remains active.', '{}'::jsonb
       from changed
     returning reservation_id`,
    params,
  );

  return {
    released: released.rowCount || 0,
    enteredGrace: grace.rowCount || 0,
  };
}

export async function loadTickerReservationByDraft(db, draftId, { forUpdate = false, includeReleased = false } = {}) {
  const statusClause = includeReleased ? "" : "and status not in ('DRAFT_UNRESERVED', 'RELEASED')";
  const lockClause = forUpdate ? "for update" : "";
  const result = await db.query(
    `select *
       from public.ticker_reservations
      where draft_id = $1
        ${statusClause}
      order by created_at desc
      limit 1
      ${lockClause}`,
    [draftId],
  );
  return mapTickerReservationRow(result.rows[0]);
}

export async function loadTickerReservationsByDraftIds(db, draftIds) {
  const ids = Array.from(new Set((Array.isArray(draftIds) ? draftIds : []).map(String).filter(Boolean)));
  if (!ids.length) return new Map();
  const result = await db.query(
    `select distinct on (draft_id) *
       from public.ticker_reservations
      where draft_id = any($1::uuid[])
      order by draft_id, created_at desc`,
    [ids],
  );
  return new Map(result.rows.map((row) => [String(row.draft_id), mapTickerReservationRow(row)]));
}

export async function getTickerAvailability(db, {
  chainId,
  cluster = "",
  ticker,
  excludeDraftId = null,
}) {
  const numericChainId = Number(chainId);
  const normalizedTicker = normalizeTicker(ticker);
  if (!Number.isFinite(numericChainId) || numericChainId <= 0) {
    throw new TickerReservationError("Invalid chain id.", {
      code: "INVALID_RESERVATION_CHAIN",
      httpStatus: 400,
    });
  }
  if (!normalizedTicker) {
    throw new TickerReservationError("Ticker is required.", {
      code: "INVALID_RESERVATION_TICKER",
      httpStatus: 400,
    });
  }

  const reservationCluster = canonicalClusterForChain(numericChainId, cluster);
  await refreshExpiredTickerReservations(db, {
    chainId: numericChainId,
    cluster: reservationCluster,
    normalizedTicker,
  });
  const result = await db.query(
    `select *
       from public.ticker_reservations
      where chain_id = $1
        and cluster = $2
        and normalized_ticker = $3
        and status not in ('DRAFT_UNRESERVED', 'RELEASED')
        and ($4::uuid is null or draft_id is distinct from $4::uuid)
      order by created_at asc
      limit 1`,
    [numericChainId, reservationCluster, normalizedTicker, excludeDraftId || null],
  );
  const reservation = mapTickerReservationRow(result.rows[0]);
  return {
    ticker: normalizedTicker,
    chainId: numericChainId,
    cluster: reservationCluster,
    available: !reservation,
    reservation,
  };
}

function reservationTerms({ published = false, now = new Date() } = {}) {
  const durationMs = published
    ? PUBLISHED_RESERVATION_DAYS * 24 * 60 * 60 * 1000
    : SOFT_RESERVATION_HOURS * 60 * 60 * 1000;
  const expiresAt = new Date(now.getTime() + durationMs);
  const graceEndAt = new Date(expiresAt.getTime() + RESERVATION_GRACE_HOURS * 60 * 60 * 1000);
  return {
    status: published ? TICKER_RESERVATION_STATUS.PREPARE_MODE_RESERVED : TICKER_RESERVATION_STATUS.SOFT_RESERVED,
    expiresAt,
    graceEndAt,
  };
}

export async function createTickerReservation(db, {
  draftId,
  creatorWallet,
  chainId,
  cluster = "",
  ticker,
  published = false,
  actorType = "creator",
}) {
  const numericChainId = Number(chainId);
  const normalizedTicker = normalizeTicker(ticker);
  const reservationCluster = canonicalClusterForChain(numericChainId, cluster);
  if (!draftId || !creatorWallet || !normalizedTicker || !Number.isFinite(numericChainId) || numericChainId <= 0) {
    throw new TickerReservationError("Draft, creator, chain, and ticker are required.", {
      code: "INVALID_RESERVATION_REQUEST",
      httpStatus: 400,
    });
  }

  const existing = await loadTickerReservationByDraft(db, draftId, { forUpdate: true });
  if (existing) {
    if (existing.chainId === numericChainId && existing.cluster === reservationCluster && existing.normalizedTicker === normalizedTicker) return existing;
    throw new TickerReservationError("Draft already owns a different active ticker reservation.", {
      code: "DRAFT_RESERVATION_CONFLICT",
    });
  }

  const availability = await getTickerAvailability(db, { chainId: numericChainId, cluster: reservationCluster, ticker: normalizedTicker });
  if (!availability.available) {
    throw new TickerReservationError("Ticker already reserved by an active draft or live campaign.", {
      code: "TICKER_UNAVAILABLE",
    });
  }

  const id = randomUUID();
  const terms = reservationTerms({ published });
  try {
    const inserted = await db.query(
      `insert into public.ticker_reservations
         (id, draft_id, creator_wallet, chain_id, cluster, original_ticker, normalized_ticker,
          ticker_hash, reservation_id_hash, status, reserved_at, published_at, expires_at,
          grace_end_at, reservation_version, metadata)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11,$12,$13,1,$14::jsonb)
       returning *`,
      [
        id,
        draftId,
        creatorWallet,
        numericChainId,
        reservationCluster,
        String(ticker || normalizedTicker).trim().slice(0, 32),
        normalizedTicker,
        sha256Hex(normalizedTicker),
        sha256Hex(id),
        terms.status,
        published ? new Date() : null,
        terms.expiresAt,
        terms.graceEndAt,
        JSON.stringify({ source: "draft_create" }),
      ],
    );
    const reservation = mapTickerReservationRow(inserted.rows[0]);
    await recordEvent(db, {
      reservationId: reservation.id,
      eventType: published ? "prepare_mode_reservation_created" : "soft_reservation_created",
      toStatus: reservation.status,
      actorType,
      actorWallet: creatorWallet,
      reason: published ? "Public Prepare Mode ticker reserved." : "Private draft ticker reserved.",
      metadata: { draftId: String(draftId), chainId: numericChainId, cluster: reservationCluster, ticker: normalizedTicker },
    });
    return reservation;
  } catch (error) {
    if (error?.code === "23505") {
      throw new TickerReservationError("Ticker already reserved by an active draft or live campaign.", {
        code: "TICKER_UNAVAILABLE",
        cause: error,
      });
    }
    throw error;
  }
}

export async function promoteTickerReservation(db, {
  draftId,
  creatorWallet,
  chainId,
  cluster = "",
  ticker,
  publishedAt = new Date(),
}) {
  await refreshExpiredTickerReservations(db, { draftId });
  let reservation = await loadTickerReservationByDraft(db, draftId, { forUpdate: true });
  if (!reservation) {
    return createTickerReservation(db, {
      draftId,
      creatorWallet,
      chainId,
      cluster,
      ticker,
      published: true,
    });
  }
  if (LOCKED_ONCHAIN_STATUSES.has(reservation.status)) return reservation;
  if (
    reservation.status === TICKER_RESERVATION_STATUS.PREPARE_MODE_RESERVED &&
    reservation.publishedAt &&
    reservation.expiresAt &&
    new Date(reservation.expiresAt).getTime() > Date.now()
  ) {
    return reservation;
  }

  const terms = reservationTerms({ published: true, now: new Date(publishedAt) });
  const updated = await db.query(
    `update public.ticker_reservations
        set status = 'PREPARE_MODE_RESERVED',
            published_at = coalesce(published_at, $2),
            expires_at = $3,
            grace_end_at = $4,
            reservation_version = reservation_version + 1,
            failure_reason = null,
            updated_at = now()
      where id = $1
      returning *`,
    [reservation.id, publishedAt, terms.expiresAt, terms.graceEndAt],
  );
  const next = mapTickerReservationRow(updated.rows[0]);
  await recordEvent(db, {
    reservationId: next.id,
    eventType: "reservation_published",
    fromStatus: reservation.status,
    toStatus: next.status,
    actorType: "creator",
    actorWallet: creatorWallet,
    reason: "Prepare Mode published; ticker reservation extended to the public window.",
    metadata: { draftId: String(draftId), expiresAt: next.expiresAt, reservationVersion: next.reservationVersion },
  });
  return next;
}

export async function renewTickerReservation(db, { draftId, creatorWallet }) {
  await refreshExpiredTickerReservations(db, { draftId });
  const reservation = await loadTickerReservationByDraft(db, draftId, { forUpdate: true });
  if (!reservation) {
    throw new TickerReservationError("No active ticker reservation exists for this draft.", {
      code: "RESERVATION_NOT_FOUND",
      httpStatus: 404,
    });
  }
  if (LOCKED_ONCHAIN_STATUSES.has(reservation.status)) {
    throw new TickerReservationError("An armed or live ticker never expires and cannot be renewed.", {
      code: "RESERVATION_ALREADY_PERMANENT",
    });
  }
  if (reservation.renewalCount >= MAX_RESERVATION_RENEWALS) {
    throw new TickerReservationError("Ticker reservation extension limit reached.", {
      code: "RESERVATION_RENEWAL_LIMIT",
    });
  }
  if (![TICKER_RESERVATION_STATUS.PREPARE_MODE_RESERVED, TICKER_RESERVATION_STATUS.EXPIRED_GRACE].includes(reservation.status)) {
    throw new TickerReservationError("Only published Prepare Mode reservations can be extended.", {
      code: "RESERVATION_NOT_RENEWABLE",
    });
  }

  const baseMs = Math.max(Date.now(), reservation.expiresAt ? new Date(reservation.expiresAt).getTime() : 0);
  const expiresAt = new Date(baseMs + RESERVATION_EXTENSION_DAYS * 24 * 60 * 60 * 1000);
  const graceEndAt = new Date(expiresAt.getTime() + RESERVATION_GRACE_HOURS * 60 * 60 * 1000);
  const updated = await db.query(
    `update public.ticker_reservations
        set status = 'PREPARE_MODE_RESERVED',
            expires_at = $2,
            grace_end_at = $3,
            renewal_count = renewal_count + 1,
            reservation_version = reservation_version + 1,
            failure_reason = null,
            updated_at = now()
      where id = $1
      returning *`,
    [reservation.id, expiresAt, graceEndAt],
  );
  const next = mapTickerReservationRow(updated.rows[0]);
  await recordEvent(db, {
    reservationId: next.id,
    eventType: "reservation_renewed",
    fromStatus: reservation.status,
    toStatus: next.status,
    actorType: "creator",
    actorWallet: creatorWallet,
    reason: "Ticker reservation extended by 14 days.",
    metadata: {
      draftId: String(draftId),
      renewalCount: next.renewalCount,
      expiresAt: next.expiresAt,
      reservationVersion: next.reservationVersion,
    },
  });
  return next;
}

export async function releaseTickerReservation(db, {
  draftId,
  creatorWallet,
  reason = "Ticker reservation released by creator.",
}) {
  const reservation = await loadTickerReservationByDraft(db, draftId, { forUpdate: true });
  if (!reservation) return null;
  if (LOCKED_ONCHAIN_STATUSES.has(reservation.status)) {
    throw new TickerReservationError("Armed and live tickers are permanently bound and cannot be released.", {
      code: "RESERVATION_PERMANENTLY_BOUND",
    });
  }

  const updated = await db.query(
    `update public.ticker_reservations
        set status = 'RELEASED',
            released_at = coalesce(released_at, now()),
            reservation_version = reservation_version + 1,
            failure_reason = $2,
            updated_at = now()
      where id = $1
      returning *`,
    [reservation.id, reason],
  );
  const next = mapTickerReservationRow(updated.rows[0]);
  await recordEvent(db, {
    reservationId: next.id,
    eventType: "reservation_released",
    fromStatus: reservation.status,
    toStatus: next.status,
    actorType: "creator",
    actorWallet: creatorWallet,
    reason,
    metadata: { draftId: String(draftId), reservationVersion: next.reservationVersion },
  });
  return next;
}

function randomAuthorizationNonce() {
  return BigInt(`0x${randomBytes(32).toString("hex")}`).toString();
}

export async function authorizeScheduledTickerReservation(pool, {
  draftId,
  creatorWallet,
  launchAt,
  buildAuthorization,
}) {
  return withTickerReservationTransaction(pool, async (db) => {
    await refreshExpiredTickerReservations(db, { draftId });
    const reservation = await loadTickerReservationByDraft(db, draftId, { forUpdate: true });
    if (!reservation) {
      throw new TickerReservationError("Ticker reservation is missing or has been released.", {
        code: "RESERVATION_NOT_FOUND",
        httpStatus: 409,
      });
    }
    if (LOCKED_ONCHAIN_STATUSES.has(reservation.status)) {
      throw new TickerReservationError("Ticker is already armed on-chain or live.", {
        code: "RESERVATION_ALREADY_ARMED",
      });
    }

    const nextVersion = BigInt(reservation.reservationVersion) + 1n;
    const authorizationNonce = randomAuthorizationNonce();
    const updated = await db.query(
      `update public.ticker_reservations
          set status = 'ARM_AUTHORIZED',
              scheduled_launch_at = to_timestamp($2),
              arm_authorized_at = now(),
              authorization_nonce = $3,
              reservation_version = $4,
              failure_reason = null,
              updated_at = now()
        where id = $1
        returning *`,
      [reservation.id, Number(launchAt), authorizationNonce, nextVersion.toString()],
    );
    const authorizedReservation = mapTickerReservationRow(updated.rows[0]);
    const authorizationResult = await buildAuthorization(authorizedReservation);
    await recordEvent(db, {
      reservationId: authorizedReservation.id,
      eventType: "reservation_arm_authorized",
      fromStatus: reservation.status,
      toStatus: authorizedReservation.status,
      actorType: "route_signer",
      actorWallet: creatorWallet,
      reason: "Scheduled deployment authorization issued for the canonical reservation version.",
      metadata: {
        draftId: String(draftId),
        scheduledLaunchAt: authorizedReservation.scheduledLaunchAt,
        reservationVersion: authorizedReservation.reservationVersion,
      },
    });
    return { reservation: authorizedReservation, ...authorizationResult };
  });
}

export async function markTickerReservationDeployed(db, {
  draftId,
  creatorWallet,
  campaignAddress,
  mint = null,
  deploymentSignature = null,
  scheduledLaunchAt = null,
  programId = null,
  generationId = null,
}) {
  const reservation = await loadTickerReservationByDraft(db, draftId, { forUpdate: true });
  if (!reservation) {
    throw new TickerReservationError("Canonical ticker reservation not found for deployed draft.", {
      code: "RESERVATION_NOT_FOUND",
      httpStatus: 409,
    });
  }
  if (reservation.status === TICKER_RESERVATION_STATUS.RELEASED) {
    throw new TickerReservationError("Released ticker reservation cannot be attached to a deployment.", {
      code: "RESERVATION_RELEASED",
    });
  }

  const launchSeconds = scheduledLaunchAt == null ? null : Number(scheduledLaunchAt);
  const isScheduled = Number.isInteger(launchSeconds) && launchSeconds > Math.floor(Date.now() / 1000);
  const toStatus = isScheduled ? TICKER_RESERVATION_STATUS.ARMED_ONCHAIN : TICKER_RESERVATION_STATUS.LIVE;
  const updated = await db.query(
    `update public.ticker_reservations
        set status = $2,
            scheduled_launch_at = case when $3::bigint is null then scheduled_launch_at else to_timestamp($3) end,
            armed_at = coalesce(armed_at, now()),
            live_at = case when $2 = 'LIVE' then coalesce(live_at, now()) else live_at end,
            expires_at = null,
            grace_end_at = null,
            campaign_pda = $4,
            mint = coalesce($5, mint),
            deployment_signature = coalesce($6, deployment_signature),
            program_id = coalesce($7, program_id),
            generation_id = coalesce($8, generation_id),
            failure_reason = null,
            updated_at = now()
      where id = $1
      returning *`,
    [
      reservation.id,
      toStatus,
      isScheduled ? launchSeconds : null,
      campaignAddress,
      mint || null,
      deploymentSignature || null,
      programId || null,
      generationId || null,
    ],
  );
  const next = mapTickerReservationRow(updated.rows[0]);
  await recordEvent(db, {
    reservationId: next.id,
    eventType: isScheduled ? "reservation_armed_onchain" : "reservation_live",
    fromStatus: reservation.status,
    toStatus: next.status,
    actorType: "creator",
    actorWallet: creatorWallet,
    reason: isScheduled
      ? "Campaign and ticker are permanently bound on-chain before the trading timestamp."
      : "Campaign is deployed and ticker is permanently live.",
    metadata: {
      draftId: String(draftId),
      campaignAddress,
      mint: mint || null,
      deploymentSignature: deploymentSignature || null,
      scheduledLaunchAt: next.scheduledLaunchAt,
      reservationVersion: next.reservationVersion,
    },
  });
  return next;
}
