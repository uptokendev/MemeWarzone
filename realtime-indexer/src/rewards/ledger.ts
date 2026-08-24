import type { PoolClient, QueryResult } from "pg";
import { pool } from "../db.js";
import { normalizeWalletAddress, walletEqualsSql } from "../walletAddress.js";
import { ensureWeeklyEpoch, getCurrentWeeklyEpoch, getEpochById, type RewardEpochRecord } from "./epochs.js";
import { processRewardEligibilityForEpoch } from "./eligibility.js";
import { ensurePublishedAirdropDrawForEpoch, getPublishedAirdropDrawForEpoch, listAirdropWinners } from "./airdrops.js";
import { getSquadAllocationPreview } from "./squads.js";

export const REWARD_PROGRAMS = ["recruiter", "airdrop_trader", "airdrop_creator", "squad"] as const;
export type RewardProgram = "recruiter" | "airdrop_trader" | "airdrop_creator" | "squad";
export type RewardLedgerStatus = "pending" | "claimable" | "claimed" | "expired" | "rolled_over" | "cancelled";
export type RewardClaimStatus = "recorded" | "cancelled";
export type RewardRolloverDestination = "squad_pool" | "squad_pool_same" | "airdrop_treasury" | "next_epoch_wallet_claim";

export type RewardLedgerEntryRecord = {
  id: number;
  epochId: number;
  walletAddress: string;
  program: RewardProgram;
  subProgram: string | null;
  grossAmount: string;
  netAmount: string;
  status: RewardLedgerStatus;
  sourceReference: Record<string, unknown>;
  claimableAt: string | null;
  claimDeadlineAt: string | null;
  claimedAt: string | null;
  expiredAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RewardClaimRecord = {
  id: number;
  walletAddress: string;
  epochId: number;
  program: RewardProgram;
  claimedAmount: string;
  claimTxHash: string | null;
  claimedAt: string;
  status: RewardClaimStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ClaimRolloverRecord = {
  id: number;
  fromLedgerEntryId: number;
  toLedgerEntryId: number | null;
  program: RewardProgram;
  amount: string;
  reason: string;
  destinationKind: RewardRolloverDestination;
  executedAt: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type MaterializeRecruiterLedgerResult = {
  epoch: RewardEpochRecord;
  materializedCount: number;
  beneficiaryCount: number;
  unresolvedEventCount: number;
  totalGrossAmount: string;
};

export type PublishRewardLedgerResult = {
  epoch: RewardEpochRecord;
  updatedCount: number;
  claimableTotal: string;
  claimDeadlineAt: string;
};

export type RecordRewardClaimResult = {
  claim: RewardClaimRecord;
  ledgerEntryCount: number;
  claimedAmount: string;
  partialClaimSupported: false;
};

export type ProcessRewardExpiriesResult = {
  expiredCount: number;
  rolledOverCount: number;
};

type DbLike = {
  query: (queryTextOrConfig: string | { text: string; values?: any[]; simple?: boolean }, values?: any[]) => Promise<QueryResult<any>>;
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
  return normalizeWalletAddress(value);
}

function normalizeHash(value: unknown): string {
  const hash = String(value ?? "").trim().toLowerCase();
  if (!hash) return hash;
  if (!/^0x[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`Invalid tx hash: ${String(value ?? "")}`);
  }
  return hash;
}

function bigintString(value: bigint): string {
  return value.toString();
}

function parseNumericBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  return BigInt(String(value ?? "0"));
}

function mapLedgerRow(row: any): RewardLedgerEntryRecord {
  return {
    id: asNumber(row.id),
    epochId: asNumber(row.epoch_id),
    walletAddress: String(row.wallet_address),
    program: String(row.program) as RewardProgram,
    subProgram: row.sub_program ? String(row.sub_program) : null,
    grossAmount: String(row.gross_amount ?? "0"),
    netAmount: String(row.net_amount ?? "0"),
    status: String(row.status) as RewardLedgerStatus,
    sourceReference: row.source_reference && typeof row.source_reference === "object" ? row.source_reference : {},
    claimableAt: toIso(row.claimable_at),
    claimDeadlineAt: toIso(row.claim_deadline_at),
    claimedAt: toIso(row.claimed_at),
    expiredAt: toIso(row.expired_at),
    cancelledAt: toIso(row.cancelled_at),
    createdAt: mustIso(row.created_at, "reward_ledger_entries.created_at"),
    updatedAt: mustIso(row.updated_at, "reward_ledger_entries.updated_at"),
  };
}

function mapClaimRow(row: any): RewardClaimRecord {
  return {
    id: asNumber(row.id),
    walletAddress: String(row.wallet_address),
    epochId: asNumber(row.epoch_id),
    program: String(row.program) as RewardProgram,
    claimedAmount: String(row.claimed_amount ?? "0"),
    claimTxHash: row.claim_tx_hash ? String(row.claim_tx_hash) : null,
    claimedAt: mustIso(row.claimed_at, "claims.claimed_at"),
    status: String(row.status) as RewardClaimStatus,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    createdAt: mustIso(row.created_at, "claims.created_at"),
    updatedAt: mustIso(row.updated_at, "claims.updated_at"),
  };
}

function mapRolloverRow(row: any): ClaimRolloverRecord {
  return {
    id: asNumber(row.id),
    fromLedgerEntryId: asNumber(row.from_ledger_entry_id),
    toLedgerEntryId: row.to_ledger_entry_id != null ? asNumber(row.to_ledger_entry_id) : null,
    program: String(row.program) as RewardProgram,
    amount: String(row.amount ?? "0"),
    reason: String(row.reason),
    destinationKind: String(row.destination_kind) as RewardRolloverDestination,
    executedAt: mustIso(row.executed_at, "claim_rollovers.executed_at"),
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    createdAt: mustIso(row.created_at, "claim_rollovers.created_at"),
    updatedAt: mustIso(row.updated_at, "claim_rollovers.updated_at"),
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
    client.release();
  }
}

async function getHistoricalRecruiterWalletForParticipant(
  db: DbLike,
  walletAddress: string | null,
  occurredAt: string,
): Promise<{ recruiterWalletAddress: string; recruiterId: number; recruiterCode: string | null } | null> {
  if (!walletAddress) return null;

  const r = await db.query(
    `select rec.id as recruiter_id, rec.wallet_address as recruiter_wallet_address, rec.code as recruiter_code
       from public.wallet_recruiter_links l
       join public.recruiters rec on rec.id = l.recruiter_id
      where l.wallet_address = $1
        and l.linked_at <= $2
        and (l.detached_at is null or l.detached_at > $2)
      order by l.linked_at desc, l.id desc
      limit 1`,
    [walletAddress, occurredAt]
  );

  const row = r.rows[0];
  if (!row) return null;
  return {
    recruiterWalletAddress: String(row.recruiter_wallet_address),
    recruiterId: asNumber(row.recruiter_id),
    recruiterCode: row.recruiter_code ? String(row.recruiter_code) : null,
  };
}

async function getFinalizeParticipantWallet(db: DbLike, chainId: number, campaignAddress: string | null): Promise<string | null> {
  if (!campaignAddress) return null;
  const r = await db.query(
    `select creator_address
       from public.campaigns
      where chain_id = $1 and campaign_address = $2
      limit 1`,
    [chainId, campaignAddress]
  );
  return r.rows[0]?.creator_address ? String(r.rows[0].creator_address) : null;
}

function getClaimDeadlineFromEpoch(epoch: RewardEpochRecord): Date {
  return new Date(new Date(epoch.endAt).getTime() + 7 * 24 * 60 * 60 * 1000);
}

async function getNextWeeklyEpoch(epoch: RewardEpochRecord, db: DbLike): Promise<RewardEpochRecord> {
  return ensureWeeklyEpoch(epoch.chainId, new Date(new Date(epoch.endAt).getTime() + 1), db);
}

async function upsertEpochCarryover(
  db: DbLike,
  input: {
    sourceEpoch: RewardEpochRecord;
    targetEpoch: RewardEpochRecord;
    amount: bigint;
    reason: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db.query(
    `insert into public.reward_pool_carryovers(
       source_epoch_id, target_epoch_id, chain_id, program, source_ledger_entry_id,
       amount, reason, metadata, created_at, updated_at
     ) values (
       $1, $2, $3, 'squad', null,
       $4, $5, $6::jsonb, now(), now()
     )
     on conflict (source_epoch_id, target_epoch_id, program, reason)
     where source_ledger_entry_id is null
     do update set
       amount = excluded.amount,
       metadata = excluded.metadata,
       updated_at = now()`,
    [
      input.sourceEpoch.id,
      input.targetEpoch.id,
      input.sourceEpoch.chainId,
      bigintString(input.amount),
      input.reason,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}

async function upsertLedgerCarryover(
  db: DbLike,
  input: {
    sourceEpoch: RewardEpochRecord;
    targetEpoch: RewardEpochRecord;
    sourceLedgerEntryId: number;
    amount: bigint;
    reason: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db.query(
    `insert into public.reward_pool_carryovers(
       source_epoch_id, target_epoch_id, chain_id, program, source_ledger_entry_id,
       amount, reason, metadata, created_at, updated_at
     ) values (
       $1, $2, $3, 'squad', $4,
       $5, $6, $7::jsonb, now(), now()
     )
     on conflict (source_ledger_entry_id, reason)
     where source_ledger_entry_id is not null
     do update set
       amount = excluded.amount,
       metadata = excluded.metadata,
       updated_at = now()`,
    [
      input.sourceEpoch.id,
      input.targetEpoch.id,
      input.sourceEpoch.chainId,
      input.sourceLedgerEntryId,
      bigintString(input.amount),
      input.reason,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}

function mapRolloverDestination(program: RewardProgram): RewardRolloverDestination {
  switch (program) {
    case "recruiter":
      return "squad_pool";
    case "squad":
      return "squad_pool_same";
    case "airdrop_trader":
    case "airdrop_creator":
      return "airdrop_treasury";
    default:
      return "next_epoch_wallet_claim";
  }
}

export async function listRewardLedgerEntries(filters: {
  walletAddress?: string | null;
  epochId?: number | null;
  program?: RewardProgram | null;
  status?: RewardLedgerStatus | null;
  limit?: number;
}, db: DbLike = pool): Promise<RewardLedgerEntryRecord[]> {
  const clauses: string[] = ["1=1"];
  const values: any[] = [];

  if (filters.walletAddress) {
    values.push(normalizeAddress(filters.walletAddress));
    clauses.push(walletEqualsSql("wallet_address", values.length));
  }
  if (filters.epochId != null) {
    values.push(filters.epochId);
    clauses.push(`epoch_id = $${values.length}`);
  }
  if (filters.program) {
    values.push(filters.program);
    clauses.push(`program = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    clauses.push(`status = $${values.length}`);
  }

  values.push(Math.max(1, Math.min(500, Math.trunc(filters.limit ?? 50) || 50)));
  const r = await db.query(
    `select *
       from public.reward_ledger_entries
      where ${clauses.join(" and ")}
      order by created_at desc, id desc
      limit $${values.length}`,
    values
  );

  return r.rows.map(mapLedgerRow);
}

export async function listRewardClaims(filters: {
  walletAddress?: string | null;
  epochId?: number | null;
  program?: RewardProgram | null;
  limit?: number;
}, db: DbLike = pool): Promise<RewardClaimRecord[]> {
  const clauses: string[] = ["1=1"];
  const values: any[] = [];

  if (filters.walletAddress) {
    values.push(normalizeAddress(filters.walletAddress));
    clauses.push(walletEqualsSql("wallet_address", values.length));
  }
  if (filters.epochId != null) {
    values.push(filters.epochId);
    clauses.push(`epoch_id = $${values.length}`);
  }
  if (filters.program) {
    values.push(filters.program);
    clauses.push(`program = $${values.length}`);
  }

  values.push(Math.max(1, Math.min(500, Math.trunc(filters.limit ?? 50) || 50)));
  const r = await db.query(
    `select *
       from public.claims
      where ${clauses.join(" and ")}
      order by claimed_at desc, id desc
      limit $${values.length}`,
    values
  );

  return r.rows.map(mapClaimRow);
}

export async function listClaimRollovers(filters: {
  program?: RewardProgram | null;
  fromLedgerEntryId?: number | null;
  limit?: number;
}, db: DbLike = pool): Promise<ClaimRolloverRecord[]> {
  const clauses: string[] = ["1=1"];
  const values: any[] = [];

  if (filters.program) {
    values.push(filters.program);
    clauses.push(`program = $${values.length}`);
  }
  if (filters.fromLedgerEntryId != null) {
    values.push(filters.fromLedgerEntryId);
    clauses.push(`from_ledger_entry_id = $${values.length}`);
  }

  values.push(Math.max(1, Math.min(500, Math.trunc(filters.limit ?? 50) || 50)));
  const r = await db.query(
    `select *
       from public.claim_rollovers
      where ${clauses.join(" and ")}
      order by executed_at desc, id desc
      limit $${values.length}`,
    values
  );

  return r.rows.map(mapRolloverRow);
}

type RewardEligibilitySnapshot = {
  walletAddress: string;
  program: RewardProgram;
  isEligible: boolean;
  score: bigint;
  reasonCodes: string[];
  metadata: Record<string, unknown>;
};

type ManagedLedgerDraft = {
  walletAddress: string;
  program: RewardProgram;
  subProgram: string;
  grossAmount: bigint;
  netAmount: bigint;
  status: "pending" | "cancelled";
  sourceReference: Record<string, unknown>;
};

type ProgramMaterializationSummary = {
  materializedCount: number;
  beneficiaryCount: number;
  totalGrossAmount: bigint;
  totalNetAmount: bigint;
};

type AirdropPoolTotals = {
  totalAirdropAmount: bigint;
  traderPoolAmount: bigint;
  creatorPoolAmount: bigint;
};

function parseReasonCodes(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function getProgramPoolAmount(poolTotals: AirdropPoolTotals, program: RewardProgram): bigint {
  if (program === "airdrop_trader") return poolTotals.traderPoolAmount;
  if (program === "airdrop_creator") return poolTotals.creatorPoolAmount;
  return 0n;
}

function buildLedgerKey(walletAddress: string, program: RewardProgram, subProgram: string): string {
  return `${walletAddress}:${program}:${subProgram}`;
}

function buildManagedSourceReference(
  materializer: string,
  sourceReference: Record<string, unknown>,
): Record<string, unknown> {
  return {
    materializer,
    ...sourceReference,
  };
}

function sortAllocationCandidates<T extends { walletAddress: string; subProgram: string; remainder: bigint }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.remainder === b.remainder) {
      const walletCmp = a.walletAddress.localeCompare(b.walletAddress);
      return walletCmp !== 0 ? walletCmp : a.subProgram.localeCompare(b.subProgram);
    }
    return a.remainder > b.remainder ? -1 : 1;
  });
}

function allocateProRataShares(
  totalAmount: bigint,
  items: Array<{ walletAddress: string; subProgram: string; score: bigint }>,
  program: RewardProgram,
): Map<string, bigint> {
  const shares = new Map<string, bigint>();
  if (totalAmount <= 0n || items.length === 0) return shares;

  const totalScore = items.reduce((acc, item) => acc + item.score, 0n);
  if (totalScore <= 0n) return shares;

  let allocated = 0n;
  const ranked = items.map((item) => {
    const numerator = totalAmount * item.score;
    const baseShare = numerator / totalScore;
    const remainder = numerator % totalScore;
    allocated += baseShare;
    return {
      ...item,
      baseShare,
      remainder,
    };
  });

  let leftover = totalAmount - allocated;
  for (const item of ranked) {
    shares.set(buildLedgerKey(item.walletAddress, program, item.subProgram), item.baseShare);
  }

  for (const item of sortAllocationCandidates(ranked)) {
    if (leftover <= 0n) break;
    const key = buildLedgerKey(item.walletAddress, program, item.subProgram);
    shares.set(key, (shares.get(key) ?? 0n) + 1n);
    leftover -= 1n;
  }

  return shares;
}

async function loadEligibilitySnapshots(
  db: DbLike,
  epochId: number,
): Promise<Map<RewardProgram, Map<string, RewardEligibilitySnapshot>>> {
  const r = await db.query(
    `select wallet_address, program, is_eligible, score, reason_codes, metadata
       from public.eligibility_results
      where epoch_id = $1`,
    [epochId]
  );

  const byProgram = new Map<RewardProgram, Map<string, RewardEligibilitySnapshot>>();
  for (const program of REWARD_PROGRAMS) {
    byProgram.set(program, new Map<string, RewardEligibilitySnapshot>());
  }

  for (const row of r.rows) {
    const program = String(row.program) as RewardProgram;
    const map = byProgram.get(program);
    if (!map) continue;
    map.set(String(row.wallet_address), {
      walletAddress: String(row.wallet_address),
      program,
      isEligible: Boolean(row.is_eligible),
      score: parseNumericBigInt(row.score),
      reasonCodes: parseReasonCodes(row.reason_codes),
      metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    });
  }

  return byProgram;
}

async function getAirdropPoolTotals(db: DbLike, epochId: number): Promise<AirdropPoolTotals> {
  const r = await db.query(
    `select coalesce(sum(airdrop_amount), 0)::numeric(78,0) as total_airdrop_amount
       from public.reward_events
      where epoch_id = $1`,
    [epochId]
  );
  const totalAirdropAmount = parseNumericBigInt(r.rows[0]?.total_airdrop_amount ?? "0");
  const traderPoolAmount = totalAirdropAmount / 2n;
  const creatorPoolAmount = totalAirdropAmount - traderPoolAmount;
  return {
    totalAirdropAmount,
    traderPoolAmount,
    creatorPoolAmount,
  };
}

async function getRecruiterRewardAggregates(db: DbLike, epochId: number): Promise<{
  aggregates: Array<{
    walletAddress: string;
    recruiterId: number;
    recruiterCode: string | null;
    amount: bigint;
    rewardEventIds: number[];
    tradeEventCount: number;
    finalizeEventCount: number;
  }>;
  unresolvedEventCount: number;
}> {
  const matched = await db.query(
    `with matched_events as (
       select
         rec.wallet_address,
         rec.id as recruiter_id,
         rec.code as recruiter_code,
         re.id as reward_event_id,
         re.route_kind,
         re.recruiter_amount
       from public.reward_events re
       join public.wallet_recruiter_links l
         on re.route_kind = 'trade'
        and re.wallet_address is not null
        and l.wallet_address = re.wallet_address
        and l.linked_at <= re.occurred_at
        and (l.detached_at is null or l.detached_at > re.occurred_at)
       join public.recruiters rec on rec.id = l.recruiter_id
       where re.epoch_id = $1
         and re.recruiter_amount > 0
       union all
       select
         rec.wallet_address,
         rec.id as recruiter_id,
         rec.code as recruiter_code,
         re.id as reward_event_id,
         re.route_kind,
         re.recruiter_amount
       from public.reward_events re
       join public.campaigns c
         on re.route_kind = 'finalize'
        and c.chain_id = re.chain_id
        and c.campaign_address = re.campaign_address
       join public.wallet_recruiter_links l
         on l.wallet_address = lower(c.creator_address)
        and l.linked_at <= re.occurred_at
        and (l.detached_at is null or l.detached_at > re.occurred_at)
       join public.recruiters rec on rec.id = l.recruiter_id
       where re.epoch_id = $1
         and re.recruiter_amount > 0
     )
     select
       wallet_address,
       recruiter_id,
       recruiter_code,
       array_agg(reward_event_id order by reward_event_id) as reward_event_ids,
       coalesce(sum(recruiter_amount), 0)::numeric(78,0) as amount,
       count(*) filter (where route_kind = 'trade')::int as trade_event_count,
       count(*) filter (where route_kind = 'finalize')::int as finalize_event_count
     from matched_events
     group by wallet_address, recruiter_id, recruiter_code`,
    [epochId]
  );

  const unresolved = await db.query(
    `with matched_event_ids as (
       select re.id
         from public.reward_events re
         join public.wallet_recruiter_links l
           on re.route_kind = 'trade'
          and re.wallet_address is not null
          and l.wallet_address = re.wallet_address
          and l.linked_at <= re.occurred_at
          and (l.detached_at is null or l.detached_at > re.occurred_at)
        where re.epoch_id = $1
          and re.recruiter_amount > 0
       union
       select re.id
         from public.reward_events re
         join public.campaigns c
           on re.route_kind = 'finalize'
          and c.chain_id = re.chain_id
          and c.campaign_address = re.campaign_address
         join public.wallet_recruiter_links l
           on l.wallet_address = lower(c.creator_address)
          and l.linked_at <= re.occurred_at
          and (l.detached_at is null or l.detached_at > re.occurred_at)
        where re.epoch_id = $1
          and re.recruiter_amount > 0
     )
     select count(*)::bigint as unresolved_event_count
       from public.reward_events re
      where re.epoch_id = $1
        and re.recruiter_amount > 0
        and not exists (
          select 1 from matched_event_ids m where m.id = re.id
        )`,
    [epochId]
  );

  return {
    aggregates: matched.rows.map((row: any) => ({
      walletAddress: String(row.wallet_address),
      recruiterId: asNumber(row.recruiter_id),
      recruiterCode: row.recruiter_code ? String(row.recruiter_code) : null,
      amount: parseNumericBigInt(row.amount),
      rewardEventIds: Array.isArray(row.reward_event_ids) ? row.reward_event_ids.map((value: unknown) => asNumber(value)) : [],
      tradeEventCount: asNumber(row.trade_event_count),
      finalizeEventCount: asNumber(row.finalize_event_count),
    })),
    unresolvedEventCount: asNumber(unresolved.rows[0]?.unresolved_event_count ?? 0),
  };
}

async function getSquadPoolAggregates(db: DbLike, epochId: number): Promise<{
  aggregates: Array<{
    recruiterId: number;
    recruiterCode: string | null;
    amount: bigint;
    rewardEventIds: number[];
    tradeEventCount: number;
    finalizeEventCount: number;
  }>;
  unresolvedEventCount: number;
}> {
  const matched = await db.query(
    `with matched_events as (
       select
         rec.id as recruiter_id,
         rec.code as recruiter_code,
         re.id as reward_event_id,
         re.route_kind,
         re.squad_amount
       from public.reward_events re
       join public.wallet_recruiter_links l
         on re.route_kind = 'trade'
        and re.wallet_address is not null
        and l.wallet_address = re.wallet_address
        and l.linked_at <= re.occurred_at
        and (l.detached_at is null or l.detached_at > re.occurred_at)
       join public.recruiters rec on rec.id = l.recruiter_id
       where re.epoch_id = $1
         and re.squad_amount > 0
       union all
       select
         rec.id as recruiter_id,
         rec.code as recruiter_code,
         re.id as reward_event_id,
         re.route_kind,
         re.squad_amount
       from public.reward_events re
       join public.campaigns c
         on re.route_kind = 'finalize'
        and c.chain_id = re.chain_id
        and c.campaign_address = re.campaign_address
       join public.wallet_recruiter_links l
         on l.wallet_address = lower(c.creator_address)
        and l.linked_at <= re.occurred_at
        and (l.detached_at is null or l.detached_at > re.occurred_at)
       join public.recruiters rec on rec.id = l.recruiter_id
       where re.epoch_id = $1
         and re.squad_amount > 0
     )
     select
       recruiter_id,
       recruiter_code,
       array_agg(reward_event_id order by reward_event_id) as reward_event_ids,
       coalesce(sum(squad_amount), 0)::numeric(78,0) as amount,
       count(*) filter (where route_kind = 'trade')::int as trade_event_count,
       count(*) filter (where route_kind = 'finalize')::int as finalize_event_count
     from matched_events
     group by recruiter_id, recruiter_code`,
    [epochId]
  );

  const unresolved = await db.query(
    `with matched_event_ids as (
       select re.id
         from public.reward_events re
         join public.wallet_recruiter_links l
           on re.route_kind = 'trade'
          and re.wallet_address is not null
          and l.wallet_address = re.wallet_address
          and l.linked_at <= re.occurred_at
          and (l.detached_at is null or l.detached_at > re.occurred_at)
        where re.epoch_id = $1
          and re.squad_amount > 0
       union
       select re.id
         from public.reward_events re
         join public.campaigns c
           on re.route_kind = 'finalize'
          and c.chain_id = re.chain_id
          and c.campaign_address = re.campaign_address
         join public.wallet_recruiter_links l
           on l.wallet_address = lower(c.creator_address)
          and l.linked_at <= re.occurred_at
          and (l.detached_at is null or l.detached_at > re.occurred_at)
        where re.epoch_id = $1
          and re.squad_amount > 0
     )
     select count(*)::bigint as unresolved_event_count
       from public.reward_events re
      where re.epoch_id = $1
        and re.squad_amount > 0
        and not exists (
          select 1 from matched_event_ids m where m.id = re.id
        )`,
    [epochId]
  );

  return {
    aggregates: matched.rows.map((row: any) => ({
      recruiterId: asNumber(row.recruiter_id),
      recruiterCode: row.recruiter_code ? String(row.recruiter_code) : null,
      amount: parseNumericBigInt(row.amount),
      rewardEventIds: Array.isArray(row.reward_event_ids) ? row.reward_event_ids.map((value: unknown) => asNumber(value)) : [],
      tradeEventCount: asNumber(row.trade_event_count),
      finalizeEventCount: asNumber(row.finalize_event_count),
    })),
    unresolvedEventCount: asNumber(unresolved.rows[0]?.unresolved_event_count ?? 0),
  };
}

function buildAirdropProgramDrafts(
  program: "airdrop_trader" | "airdrop_creator",
  winners: Array<{
    drawId: number;
    walletAddress: string;
    winnerRank: number;
    weightTier: number;
    weightValue: number;
    activityScore: string;
    payoutAmount: string;
    metadataJson: Record<string, unknown>;
  }>,
  eligibilityMap: Map<string, RewardEligibilitySnapshot>,
): ManagedLedgerDraft[] {
  const drafts: ManagedLedgerDraft[] = [];
  for (const winner of winners) {
    const eligibility = eligibilityMap.get(winner.walletAddress);
    const grossAmount = parseNumericBigInt(winner.payoutAmount);
    if (grossAmount <= 0n) continue;
    drafts.push({
      walletAddress: winner.walletAddress,
      program,
      subProgram: "",
      grossAmount,
      netAmount: eligibility?.isEligible === false ? 0n : grossAmount,
      status: eligibility?.isEligible === false ? "cancelled" : "pending",
      sourceReference: buildManagedSourceReference(`${program}_draw_v1`, {
        kind: "airdrop_draw_winner",
        drawId: winner.drawId,
        winnerRank: winner.winnerRank,
        weightTier: winner.weightTier,
        weightValue: winner.weightValue,
        activityScore: winner.activityScore,
        winnerMetadata: winner.metadataJson,
        isEligible: eligibility?.isEligible ?? true,
        reasonCodes: eligibility?.reasonCodes ?? [],
        eligibilityMetadata: eligibility?.metadata ?? {},
      }),
    });
  }
  return drafts;
}

function buildRecruiterDrafts(
  aggregates: Array<{
    walletAddress: string;
    recruiterId: number;
    recruiterCode: string | null;
    amount: bigint;
    rewardEventIds: number[];
    tradeEventCount: number;
    finalizeEventCount: number;
  }>,
  eligibilityMap: Map<string, RewardEligibilitySnapshot>,
): ManagedLedgerDraft[] {
  return aggregates.map((aggregate) => {
    const eligibility = eligibilityMap.get(aggregate.walletAddress);
    const isEligible = eligibility ? eligibility.isEligible : true;
    return {
      walletAddress: aggregate.walletAddress,
      program: "recruiter",
      subProgram: "",
      grossAmount: aggregate.amount,
      netAmount: isEligible ? aggregate.amount : 0n,
      status: isEligible ? "pending" : "cancelled",
      sourceReference: buildManagedSourceReference("recruiter_v2", {
        kind: "reward_events",
        rewardEventIds: aggregate.rewardEventIds,
        rewardEventCount: aggregate.rewardEventIds.length,
        recruiterId: aggregate.recruiterId,
        recruiterCode: aggregate.recruiterCode,
        tradeEventCount: aggregate.tradeEventCount,
        finalizeEventCount: aggregate.finalizeEventCount,
        isEligible,
        reasonCodes: eligibility?.reasonCodes ?? [],
        eligibilityMetadata: eligibility?.metadata ?? {},
      }),
    };
  });
}

function buildSquadDrafts(
  aggregates: Array<{
    recruiterId: number;
    recruiterCode: string | null;
    amount: bigint;
    rewardEventIds: number[];
    tradeEventCount: number;
    finalizeEventCount: number;
  }>,
  preview: Awaited<ReturnType<typeof getSquadAllocationPreview>>,
): ManagedLedgerDraft[] {
  const aggregateByRecruiter = new Map<number, {
    recruiterCode: string | null;
    amount: bigint;
    rewardEventIds: number[];
    tradeEventCount: number;
    finalizeEventCount: number;
  }>();
  for (const aggregate of aggregates) {
    aggregateByRecruiter.set(aggregate.recruiterId, {
      recruiterCode: aggregate.recruiterCode,
      amount: aggregate.amount,
      rewardEventIds: aggregate.rewardEventIds,
      tradeEventCount: aggregate.tradeEventCount,
      finalizeEventCount: aggregate.finalizeEventCount,
    });
  }
  const drafts: ManagedLedgerDraft[] = [];
  for (const member of preview.members) {
    const grossAmount = parseNumericBigInt(member.estimatedPayoutAmount);
    if (grossAmount <= 0n) continue;
    const aggregate = aggregateByRecruiter.get(member.recruiterId);
    const subProgram = `recruiter:${member.recruiterCode ?? member.recruiterId}`;
    drafts.push({
      walletAddress: member.walletAddress,
      program: "squad",
      subProgram,
      grossAmount,
      netAmount: member.isEligible ? grossAmount : 0n,
      status: member.isEligible ? "pending" : "cancelled",
      sourceReference: buildManagedSourceReference("squad_v2", {
        kind: "squad_pool_allocation",
        allocator: "global_score_with_caps_v2",
        recruiterId: member.recruiterId,
        recruiterCode: member.recruiterCode,
        recruiterDisplayName: member.recruiterDisplayName,
        globalPoolAmount: preview.globalPoolAmount,
        previewCarryoverAmount: preview.carryoverAmount,
        rewardEventIds: aggregate?.rewardEventIds ?? [],
        rewardEventCount: aggregate?.rewardEventIds.length ?? 0,
        routedPoolAmount: aggregate ? bigintString(aggregate.amount) : "0",
        tradeEventCount: aggregate?.tradeEventCount ?? 0,
        finalizeEventCount: aggregate?.finalizeEventCount ?? 0,
        memberRawScore: member.rawScore,
        memberCapAmount: member.memberCapAmount,
        memberCapApplied: member.memberCapApplied,
        isEligible: member.isEligible,
        reasonCodes: member.reasonCodes,
      }),
    });
  }

  return drafts;
}

async function syncManagedProgramLedgerEntries(
  db: DbLike,
  epochId: number,
  program: RewardProgram,
  materializer: string,
  drafts: ManagedLedgerDraft[],
): Promise<ProgramMaterializationSummary> {
  const existing = await db.query(
    `select id, wallet_address, sub_program, status
       from public.reward_ledger_entries
      where epoch_id = $1
        and program = $2
        and coalesce(source_reference ->> 'materializer', '') = $3`,
    [epochId, program, materializer]
  );

  const desiredKeys = new Set(drafts.map((draft) => buildLedgerKey(draft.walletAddress, draft.program, draft.subProgram)));
  const staleIds = existing.rows
    .filter((row: any) => !desiredKeys.has(buildLedgerKey(String(row.wallet_address), program, String(row.sub_program ?? ""))))
    .map((row: any) => asNumber(row.id))
    .filter((id) => id > 0);

  for (const draft of drafts) {
    await db.query(
      `insert into public.reward_ledger_entries(
         epoch_id, wallet_address, program, sub_program,
         gross_amount, net_amount, status, source_reference,
         claimable_at, claim_deadline_at, claimed_at, expired_at, cancelled_at,
         created_at, updated_at
       ) values (
         $1, $2, $3, $4,
         $5, $6, $7, $8::jsonb,
         null, null, null, null,
         case when $7 = 'cancelled' then now() else null end,
         now(), now()
       )
       on conflict (epoch_id, wallet_address, program, sub_program) do update set
         gross_amount = case
           when public.reward_ledger_entries.status in ('claimed', 'rolled_over') then public.reward_ledger_entries.gross_amount
           else excluded.gross_amount
         end,
         net_amount = case
           when public.reward_ledger_entries.status in ('claimed', 'rolled_over') then public.reward_ledger_entries.net_amount
           else excluded.net_amount
         end,
         status = case
           when public.reward_ledger_entries.status in ('claimed', 'rolled_over') then public.reward_ledger_entries.status
           else excluded.status
         end,
         source_reference = excluded.source_reference,
         cancelled_at = case
           when public.reward_ledger_entries.status in ('claimed', 'rolled_over') then public.reward_ledger_entries.cancelled_at
           when excluded.status = 'cancelled' then coalesce(public.reward_ledger_entries.cancelled_at, now())
           else null
         end,
         updated_at = now()`,
      [
        epochId,
        draft.walletAddress,
        draft.program,
        draft.subProgram,
        bigintString(draft.grossAmount),
        bigintString(draft.netAmount),
        draft.status,
        JSON.stringify(draft.sourceReference),
      ]
    );
  }

  if (staleIds.length > 0) {
    await db.query(
      `update public.reward_ledger_entries
          set gross_amount = 0,
              net_amount = 0,
              status = case
                when status in ('claimed', 'rolled_over') then status
                else 'cancelled'
              end,
              cancelled_at = case
                when status in ('claimed', 'rolled_over') then cancelled_at
                else coalesce(cancelled_at, now())
              end,
              updated_at = now()
        where id = any($1::bigint[])`,
      [staleIds]
    );
  }

  const beneficiaryWallets = new Set(drafts.map((draft) => draft.walletAddress));
  return {
    materializedCount: drafts.length,
    beneficiaryCount: beneficiaryWallets.size,
    totalGrossAmount: drafts.reduce((acc, draft) => acc + draft.grossAmount, 0n),
    totalNetAmount: drafts.reduce((acc, draft) => acc + draft.netAmount, 0n),
  };
}

export async function materializeRewardLedgerForEpoch(epochId: number): Promise<MaterializeRecruiterLedgerResult> {
  return withTransaction(async (db) => {
    const epoch = await getEpochById(epochId, db);
    if (!epoch) throw new Error(`Epoch ${epochId} not found`);

    if (epoch.status === "published" || epoch.status === "expired") {
      throw new Error(`Epoch ${epochId} is already ${epoch.status}`);
    }

    const eligibilitySnapshots = await loadEligibilitySnapshots(db, epochId);
    if (Array.from(eligibilitySnapshots.values()).every((map) => map.size === 0)) {
      throw new Error(`Eligibility results missing for epoch ${epochId}; process eligibility before materializing ledger`);
    }

    await db.query(
      `update public.epochs
          set status = 'processing'
        where id = $1 and status in ('open', 'processing', 'finalized')`,
      [epochId]
    );

    const [recruiterAggregates, squadAggregates, publishedTraderDraw, publishedCreatorDraw, airdropTraderWinners, airdropCreatorWinners, squadPreview] = await Promise.all([
      getRecruiterRewardAggregates(db, epochId),
      getSquadPoolAggregates(db, epochId),
      getPublishedAirdropDrawForEpoch(epochId, "airdrop_trader", db),
      getPublishedAirdropDrawForEpoch(epochId, "airdrop_creator", db),
      listAirdropWinners({ epochId, program: "airdrop_trader", publishedOnly: true, limit: 500 }, db),
      listAirdropWinners({ epochId, program: "airdrop_creator", publishedOnly: true, limit: 500 }, db),
      getSquadAllocationPreview(epochId, db),
    ]);

    if (!publishedTraderDraw) throw new Error(`Published airdrop trader draw missing for epoch ${epochId}`);
    if (!publishedCreatorDraw) throw new Error(`Published airdrop creator draw missing for epoch ${epochId}`);

    const recruiterDrafts = buildRecruiterDrafts(
      recruiterAggregates.aggregates,
      eligibilitySnapshots.get("recruiter") ?? new Map<string, RewardEligibilitySnapshot>()
    );
    const airdropTraderDrafts = buildAirdropProgramDrafts(
      "airdrop_trader",
      airdropTraderWinners,
      eligibilitySnapshots.get("airdrop_trader") ?? new Map<string, RewardEligibilitySnapshot>()
    );
    const airdropCreatorDrafts = buildAirdropProgramDrafts(
      "airdrop_creator",
      airdropCreatorWinners,
      eligibilitySnapshots.get("airdrop_creator") ?? new Map<string, RewardEligibilitySnapshot>()
    );
    const squadDrafts = buildSquadDrafts(
      squadAggregates.aggregates,
      squadPreview,
    );

    const [recruiterSummary, traderSummary, creatorSummary, squadSummary] = await Promise.all([
      syncManagedProgramLedgerEntries(db, epochId, "recruiter", "recruiter_v2", recruiterDrafts),
      syncManagedProgramLedgerEntries(db, epochId, "airdrop_trader", "airdrop_trader_draw_v1", airdropTraderDrafts),
      syncManagedProgramLedgerEntries(db, epochId, "airdrop_creator", "airdrop_creator_draw_v1", airdropCreatorDrafts),
      syncManagedProgramLedgerEntries(db, epochId, "squad", "squad_v2", squadDrafts),
    ]);

    const nextEpoch = await getNextWeeklyEpoch(epoch, db);
    await upsertEpochCarryover(db, {
      sourceEpoch: epoch,
      targetEpoch: nextEpoch,
      amount: parseNumericBigInt(squadPreview.carryoverAmount),
      reason: "allocation_excess_unallocated",
      metadata: {
        globalPoolAmount: squadPreview.globalPoolAmount,
        epochId,
      },
    });

    const epochAfter = await getEpochById(epochId, db);
    if (!epochAfter) throw new Error(`Epoch ${epochId} disappeared`);

    const totalGrossAmount =
      recruiterSummary.totalGrossAmount +
      traderSummary.totalGrossAmount +
      creatorSummary.totalGrossAmount +
      squadSummary.totalGrossAmount;

    const beneficiaryCount = new Set([
      ...recruiterDrafts.map((draft) => draft.walletAddress),
      ...airdropTraderDrafts.map((draft) => draft.walletAddress),
      ...airdropCreatorDrafts.map((draft) => draft.walletAddress),
      ...squadDrafts.map((draft) => draft.walletAddress),
    ]).size;

    return {
      epoch: epochAfter,
      materializedCount:
        recruiterSummary.materializedCount +
        traderSummary.materializedCount +
        creatorSummary.materializedCount +
        squadSummary.materializedCount,
      beneficiaryCount,
      unresolvedEventCount: recruiterAggregates.unresolvedEventCount + squadAggregates.unresolvedEventCount,
      totalGrossAmount: bigintString(totalGrossAmount),
    };
  });
}

export async function materializeRecruiterLedgerForEpoch(epochId: number): Promise<MaterializeRecruiterLedgerResult> {
  return materializeRewardLedgerForEpoch(epochId);
}

export async function publishRewardLedgerForEpoch(epochId: number, claimableAt = new Date()): Promise<PublishRewardLedgerResult> {
  return withTransaction(async (db) => {
    const epoch = await getEpochById(epochId, db);
    if (!epoch) throw new Error(`Epoch ${epochId} not found`);

    const claimDeadline = getClaimDeadlineFromEpoch(epoch);
    const r = await db.query(
      `update public.reward_ledger_entries
          set status = 'claimable',
              claimable_at = coalesce(claimable_at, $2),
              claim_deadline_at = coalesce(claim_deadline_at, $3),
              updated_at = now()
        where epoch_id = $1
          and status = 'pending'
        returning net_amount`,
      [epochId, claimableAt, claimDeadline]
    );

    let claimableTotal = 0n;
    for (const row of r.rows) {
      claimableTotal += parseNumericBigInt(row.net_amount);
    }

    await db.query(
      `update public.epochs
          set status = 'published',
              finalized_at = coalesce(finalized_at, $2)
        where id = $1`,
      [epochId, claimableAt]
    );

    const epochAfter = await getEpochById(epochId, db);
    if (!epochAfter) throw new Error(`Epoch ${epochId} disappeared`);

    return {
      epoch: epochAfter,
      updatedCount: r.rowCount ?? 0,
      claimableTotal: bigintString(claimableTotal),
      claimDeadlineAt: claimDeadline.toISOString(),
    };
  });
}

export async function recordRewardClaim(input: {
  walletAddress: string;
  epochId: number;
  program: RewardProgram;
  claimTxHash?: string | null;
  claimedAt?: Date;
  metadata?: Record<string, unknown> | null;
}): Promise<RecordRewardClaimResult> {
  return withTransaction(async (db) => {
    const walletAddress = normalizeAddress(input.walletAddress);
    const claimedAt = input.claimedAt ?? new Date();
    const claimTxHash = input.claimTxHash ? normalizeHash(input.claimTxHash) : null;

    const existingClaim = await db.query(
      `select *
         from public.claims
        where wallet_address = $1
          and epoch_id = $2
          and program = $3
          and status = 'recorded'
        order by claimed_at desc, id desc
        limit 1`,
      [walletAddress, input.epochId, input.program]
    );

    if (existingClaim.rowCount) {
      throw new Error(`Reward already claimed for ${walletAddress} in epoch ${input.epochId} (${input.program})`);
    }

    const ledgerRows = await db.query(
      `select *
         from public.reward_ledger_entries
        where epoch_id = $1
          and wallet_address = $2
          and program = $3
          and status = 'claimable'
          and (claim_deadline_at is null or claim_deadline_at > $4)
        order by id asc
        for update`,
      [input.epochId, walletAddress, input.program, claimedAt]
    );

    if (!ledgerRows.rowCount) {
      const claimRows = await db.query(
        `select *
           from public.claims
          where wallet_address = $1
            and epoch_id = $2
            and program = $3
            and status = 'recorded'
          order by claimed_at desc, id desc
          limit 1`,
        [walletAddress, input.epochId, input.program]
      );
      if (claimRows.rowCount) {
        throw new Error(`Reward already claimed for ${walletAddress} in epoch ${input.epochId} (${input.program})`);
      }

      throw new Error(`No claimable ${input.program} entries for ${walletAddress} in epoch ${input.epochId}`);
    }

    let claimedAmount = 0n;
    const ledgerEntryIds: number[] = [];
    for (const row of ledgerRows.rows) {
      claimedAmount += parseNumericBigInt(row.net_amount);
      ledgerEntryIds.push(asNumber(row.id));
    }

    const claimInsert = await db.query(
      `insert into public.claims(
         wallet_address, epoch_id, program, claimed_amount,
         claim_tx_hash, claimed_at, status, metadata, created_at, updated_at
       ) values (
         $1, $2, $3, $4,
         $5, $6, 'recorded', $7::jsonb, now(), now()
       )
       returning *`,
      [
        walletAddress,
        input.epochId,
        input.program,
        bigintString(claimedAmount),
        claimTxHash,
        claimedAt,
        JSON.stringify({ ...(input.metadata ?? {}), ledgerEntryIds, partialClaimSupported: false }),
      ]
    );

    const updated = await db.query(
      `update public.reward_ledger_entries
          set status = 'claimed',
              claimed_at = $2,
              updated_at = now()
        where id = any($1::bigint[])
          and status = 'claimable'`,
      [ledgerEntryIds, claimedAt]
    );

    if ((updated.rowCount ?? 0) !== ledgerEntryIds.length) {
      throw new Error(`Claim state changed while processing ${walletAddress} in epoch ${input.epochId} (${input.program})`);
    }

    return {
      claim: mapClaimRow(claimInsert.rows[0]),
      ledgerEntryCount: ledgerEntryIds.length,
      claimedAmount: bigintString(claimedAmount),
      partialClaimSupported: false,
    };
  });
}

export async function markExpiredRewardLedgerEntries(asOf = new Date()): Promise<number> {
  return withTransaction(async (db) => {
    const r = await db.query(
      `update public.reward_ledger_entries
          set status = 'expired',
              expired_at = coalesce(expired_at, $1),
              updated_at = now()
        where status = 'claimable'
          and claim_deadline_at is not null
          and claim_deadline_at <= $1
        returning id`,
      [asOf]
    );
    return r.rowCount ?? 0;
  });
}

export async function rollExpiredRewardLedgerEntries(asOf = new Date()): Promise<number> {
  return withTransaction(async (db) => {
    const entries = await db.query(
      `select l.*
         from public.reward_ledger_entries l
        where l.status = 'expired'
          and not exists (
            select 1
              from public.claim_rollovers r
             where r.from_ledger_entry_id = l.id
               and r.reason = 'claim_expired'
          )
        order by l.id asc`
    );

    let rolledOverCount = 0;

    for (const row of entries.rows) {
      const destinationKind = mapRolloverDestination(String(row.program) as RewardProgram);
      const sourceEpoch = await getEpochById(asNumber(row.epoch_id), db);
      if (!sourceEpoch) throw new Error(`Reward epoch ${String(row.epoch_id)} missing while rolling expired rewards`);
      await db.query(
        `insert into public.claim_rollovers(
           from_ledger_entry_id, to_ledger_entry_id, program, amount,
           reason, destination_kind, executed_at, metadata, created_at, updated_at
         ) values (
           $1, null, $2, $3,
           'claim_expired', $4, $5, $6::jsonb, now(), now()
         )
         on conflict (from_ledger_entry_id, reason) do nothing`,
        [
          row.id,
          row.program,
          String(row.net_amount ?? '0'),
          destinationKind,
          asOf,
          JSON.stringify({ epochId: asNumber(row.epoch_id), walletAddress: String(row.wallet_address) }),
        ]
      );

      if (destinationKind === "squad_pool" || destinationKind === "squad_pool_same") {
        const targetEpoch = await getNextWeeklyEpoch(sourceEpoch, db);
        await upsertLedgerCarryover(db, {
          sourceEpoch,
          targetEpoch,
          sourceLedgerEntryId: asNumber(row.id),
          amount: parseNumericBigInt(row.net_amount),
          reason: destinationKind === "squad_pool" ? "expired_recruiter_reward_to_squad_pool" : "expired_squad_reward_to_squad_pool",
          metadata: {
            walletAddress: String(row.wallet_address),
            sourceProgram: String(row.program),
            destinationKind,
          },
        });
      }

      await db.query(
        `update public.reward_ledger_entries
            set status = 'rolled_over',
                updated_at = now()
          where id = $1`,
        [row.id]
      );
      rolledOverCount += 1;
    }

    return rolledOverCount;
  });
}

export async function processRewardExpiries(asOf = new Date()): Promise<ProcessRewardExpiriesResult> {
  const expiredCount = await markExpiredRewardLedgerEntries(asOf);
  const rolledOverCount = await rollExpiredRewardLedgerEntries(asOf);
  return { expiredCount, rolledOverCount };
}

export async function processEndedWeeklyRewardEpochs(chainIds: number[], asOf = new Date()): Promise<Array<{
  chainId: number;
  epochId: number;
  status: string;
  materializedCount: number;
  claimableCount: number;
}>> {
  const results: Array<{ chainId: number; epochId: number; status: string; materializedCount: number; claimableCount: number }> = [];

  for (const chainId of chainIds) {
    await getCurrentWeeklyEpoch(chainId);

    const epochLimit = Math.max(1, Math.min(52, Number(process.env.PROCESS_REWARD_EPOCH_LIMIT || "1") || 1));
    const epochs = await pool.query(
      `select id
         from public.epochs
        where chain_id = $1
          and epoch_type = 'weekly'
          and end_at <= $2
          and status in ('open', 'processing', 'finalized')
        order by start_at desc
        limit $3`,
      [chainId, asOf, epochLimit]
    );

    for (const row of epochs.rows) {
      const epochId = asNumber(row.id);
      await processRewardEligibilityForEpoch(epochId);
      await ensurePublishedAirdropDrawForEpoch(epochId, "airdrop_trader");
      await ensurePublishedAirdropDrawForEpoch(epochId, "airdrop_creator");
      const materialized = await materializeRewardLedgerForEpoch(epochId);
      const published = await publishRewardLedgerForEpoch(epochId, asOf);
      results.push({
        chainId,
        epochId,
        status: published.epoch.status,
        materializedCount: materialized.materializedCount,
        claimableCount: published.updatedCount,
      });
    }
  }

  return results;
}
