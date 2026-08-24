import type { QueryResult } from "pg";
import { pool } from "../db.js";
import { normalizeWalletAddress } from "../walletAddress.js";

export const RECRUITER_ADMIN_ACTION_TYPES = [
  "recruiter_upsert",
  "og_tag_update",
  "status_change",
  "dispute_override",
  "settlement_export",
] as const;

export type RecruiterAdminActionType = (typeof RECRUITER_ADMIN_ACTION_TYPES)[number];

export type RecruiterAdminActionRecord = {
  id: number;
  recruiterId: number | null;
  walletAddress: string | null;
  actionType: RecruiterAdminActionType;
  actedBy: string | null;
  reason: string | null;
  detailsJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type RecruiterClaimableSettlementRecord = {
  epochId: number;
  chainId: number;
  epochType: string;
  startAt: string;
  endAt: string;
  recruiterId: number | null;
  recruiterWalletAddress: string | null;
  recruiterCode: string | null;
  recruiterDisplayName: string | null;
  recruiterIsOg: boolean;
  recruiterStatus: string | null;
  recruiterClosedAt: string | null;
  walletAddress: string;
  claimableEntryCount: number;
  claimableAmount: string;
  firstClaimableAt: string | null;
  claimDeadlineAt: string | null;
  ledgerEntryIds: number[];
  materializedAt: string;
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

function normalizeCode(value: unknown): string {
  const code = String(value ?? "").trim();
  if (!code) throw new Error("Recruiter code is required");
  return code;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function mapRecruiterAdminActionRow(row: any): RecruiterAdminActionRecord {
  return {
    id: asNumber(row.id),
    recruiterId: row.recruiter_id != null ? asNumber(row.recruiter_id) : null,
    walletAddress: row.wallet_address != null ? String(row.wallet_address) : null,
    actionType: String(row.action_type) as RecruiterAdminActionType,
    actedBy: row.acted_by != null ? String(row.acted_by) : null,
    reason: row.reason != null ? String(row.reason) : null,
    detailsJson: asObject(row.details_json),
    createdAt: mustIso(row.created_at, "recruiter_admin_actions.created_at"),
    updatedAt: mustIso(row.updated_at, "recruiter_admin_actions.updated_at"),
  };
}

function mapRecruiterClaimableSettlementRow(row: any): RecruiterClaimableSettlementRecord {
  return {
    epochId: asNumber(row.epoch_id),
    chainId: asNumber(row.chain_id),
    epochType: String(row.epoch_type),
    startAt: mustIso(row.start_at, "recruiter_claimable_settlements.start_at"),
    endAt: mustIso(row.end_at, "recruiter_claimable_settlements.end_at"),
    recruiterId: row.recruiter_id != null ? asNumber(row.recruiter_id) : null,
    recruiterWalletAddress: row.recruiter_wallet_address != null ? String(row.recruiter_wallet_address) : null,
    recruiterCode: row.recruiter_code != null ? String(row.recruiter_code) : null,
    recruiterDisplayName: row.recruiter_display_name != null ? String(row.recruiter_display_name) : null,
    recruiterIsOg: Boolean(row.recruiter_is_og),
    recruiterStatus: row.recruiter_status != null ? String(row.recruiter_status) : null,
    recruiterClosedAt: toIso(row.recruiter_closed_at),
    walletAddress: String(row.wallet_address),
    claimableEntryCount: asNumber(row.claimable_entry_count),
    claimableAmount: String(row.claimable_amount ?? "0"),
    firstClaimableAt: toIso(row.first_claimable_at),
    claimDeadlineAt: toIso(row.claim_deadline_at),
    ledgerEntryIds: Array.isArray(row.ledger_entry_ids) ? row.ledger_entry_ids.map((value: unknown) => asNumber(value)) : [],
    materializedAt: mustIso(row.materialized_at, "recruiter_claimable_settlements.materialized_at"),
  };
}

export async function recordRecruiterAdminAction(input: {
  recruiterId?: number | null;
  walletAddress?: string | null;
  actionType: RecruiterAdminActionType;
  actedBy?: string | null;
  reason?: string | null;
  detailsJson?: Record<string, unknown> | null;
}, db: DbLike = pool): Promise<RecruiterAdminActionRecord> {
  const walletAddress = input.walletAddress ? normalizeAddress(input.walletAddress) : null;
  const r = await db.query(
    `insert into public.recruiter_admin_actions(
       recruiter_id, wallet_address, action_type, acted_by, reason, details_json, created_at, updated_at
     ) values (
       $1, $2, $3, $4, $5, $6::jsonb, now(), now()
     )
     returning *`,
    [
      input.recruiterId ?? null,
      walletAddress,
      input.actionType,
      input.actedBy ?? null,
      input.reason ?? null,
      JSON.stringify(input.detailsJson ?? {}),
    ]
  );
  return mapRecruiterAdminActionRow(r.rows[0]);
}

export async function listRecruiterAdminActions(filters: {
  recruiterId?: number | null;
  walletAddress?: string | null;
  recruiterCode?: string | null;
  actionType?: RecruiterAdminActionType | null;
  limit?: number;
}, db: DbLike = pool): Promise<RecruiterAdminActionRecord[]> {
  const clauses = ["1=1"];
  const values: any[] = [];

  if (filters.recruiterId != null) {
    values.push(filters.recruiterId);
    clauses.push(`raa.recruiter_id = $${values.length}`);
  }
  if (filters.walletAddress) {
    values.push(normalizeAddress(filters.walletAddress));
    clauses.push(`raa.wallet_address = $${values.length}`);
  }
  if (filters.recruiterCode) {
    values.push(normalizeCode(filters.recruiterCode).toLowerCase());
    clauses.push(`lower(rec.code) = $${values.length}`);
  }
  if (filters.actionType) {
    values.push(filters.actionType);
    clauses.push(`raa.action_type = $${values.length}`);
  }

  values.push(Math.max(1, Math.min(500, Math.trunc(filters.limit ?? 100) || 100)));
  const r = await db.query(
    `select raa.*
       from public.recruiter_admin_actions raa
       left join public.recruiters rec on rec.id = raa.recruiter_id
      where ${clauses.join(" and ")}
      order by raa.created_at desc, raa.id desc
      limit $${values.length}`,
    values
  );
  return r.rows.map(mapRecruiterAdminActionRow);
}

export async function listRecruiterClaimableSettlements(filters: {
  epochId?: number | null;
  recruiterId?: number | null;
  recruiterCode?: string | null;
  walletAddress?: string | null;
  chainId?: number | null;
  limit?: number;
}, db: DbLike = pool): Promise<RecruiterClaimableSettlementRecord[]> {
  const clauses = ["1=1"];
  const values: any[] = [];

  if (filters.epochId != null) {
    values.push(filters.epochId);
    clauses.push(`epoch_id = $${values.length}`);
  }
  if (filters.recruiterId != null) {
    values.push(filters.recruiterId);
    clauses.push(`recruiter_id = $${values.length}`);
  }
  if (filters.recruiterCode) {
    values.push(normalizeCode(filters.recruiterCode).toLowerCase());
    clauses.push(`lower(recruiter_code) = $${values.length}`);
  }
  if (filters.walletAddress) {
    values.push(normalizeAddress(filters.walletAddress));
    clauses.push(`wallet_address = $${values.length}`);
  }
  if (filters.chainId != null) {
    values.push(filters.chainId);
    clauses.push(`chain_id = $${values.length}`);
  }

  values.push(Math.max(1, Math.min(500, Math.trunc(filters.limit ?? 100) || 100)));
  const r = await db.query(
    `select *
       from public.recruiter_claimable_settlements
      where ${clauses.join(" and ")}
      order by end_at desc, epoch_id desc, wallet_address asc
      limit $${values.length}`,
    values
  );
  return r.rows.map(mapRecruiterClaimableSettlementRow);
}
