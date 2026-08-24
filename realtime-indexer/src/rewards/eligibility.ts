import type { PoolClient, QueryResult } from "pg";
import { pool } from "../db.js";
import { parseWalletAddressOrNull } from "../walletAddress.js";
import { getEpochById, type RewardEpochRecord } from "./epochs.js";
import { ELIGIBILITY_PROGRAMS, ELIGIBILITY_REASON_CODES, EXCLUSION_FLAG_SEVERITIES, isEligibilityProgram, isEligibilityReasonCode, isExclusionFlagSeverity, type EligibilityProgram, type EligibilityReasonCode, type ExclusionFlagSeverity } from "./reasonCodes.js";

const BNB = 10n ** 18n;
const TRADER_MIN_VOLUME = 25n * (10n ** 16n); // 0.25 BNB
const TRADER_MAX_COUNTED_VOLUME = 15n * BNB;
const CREATOR_MIN_BONDING_VOLUME = 3n * BNB;
const CREATOR_MAX_COUNTED_VOLUME = 25n * BNB;
const CREATOR_MAX_ELIGIBLE_CAMPAIGNS = 2;
const CREATOR_MIN_UNIQUE_BUYERS = 10;
const TRADER_MIN_TRADE_COUNT = 3;
const TRADER_MIN_ACTIVE_DAYS = 2;

export type EligibilityResultRecord = {
  id: number;
  epochId: number;
  walletAddress: string;
  program: EligibilityProgram;
  isEligible: boolean;
  score: string;
  reasonCodes: EligibilityReasonCode[];
  metadata: Record<string, unknown>;
  computedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type ExclusionFlagRecord = {
  id: number;
  walletAddress: string;
  epochId: number | null;
  program: EligibilityProgram | null;
  flagType: EligibilityReasonCode;
  severity: ExclusionFlagSeverity;
  detailsJson: Record<string, unknown>;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  metadata: Record<string, unknown>;
  updatedAt: string;
};

export type ProcessEligibilityResult = {
  epoch: RewardEpochRecord;
  walletCount: number;
  resultCount: number;
  eligibleCounts: Record<EligibilityProgram, number>;
  reviewCount: number;
  hardFlaggedCount: number;
};

type DbLike = {
  query: (queryTextOrConfig: string | { text: string; values?: any[]; simple?: boolean }, values?: any[]) => Promise<QueryResult<any>>;
};

export type WalletTradeMetrics = {
  tradeVolumeRaw: bigint;
  tradeCount: number;
  activeDays: number;
  ownCampaignTradeCount: number;
};

export type WalletCreatorMetrics = {
  activeCampaignCount: number;
  qualifyingCampaignCount: number;
  totalBuyVolumeRaw: bigint;
  countedQualifiedVolumeRaw: bigint;
  maxUniqueBuyers: number;
};

export type WalletAttributionSnapshot = {
  recruiterLinkState: string | null;
  squadState: string | null;
  recruiterId: number | null;
  recruiterCode: string | null;
  recruiterStatus: string | null;
  recruiterIsOg: boolean;
  lastDetachReason: string | null;
};

export type SquadMembershipOverlap = {
  recruiterId: number;
  joinedAt: string;
  leftAt: string | null;
  leaveReason: string | null;
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
  const parsed = parseWalletAddressOrNull(value);
  if (!parsed) throw new Error(`Invalid wallet address: ${String(value ?? "")}`);
  return parsed;
}

function parseNumericBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  const s = String(value ?? "0");
  if (!s.trim()) return 0n;
  return BigInt(s);
}

function bigintString(value: bigint): string {
  return value.toString();
}

function uniqReasonCodes(codes: EligibilityReasonCode[]): EligibilityReasonCode[] {
  return Array.from(new Set(codes));
}

function mapEligibilityRow(row: any): EligibilityResultRecord {
  const reasonCodes = Array.isArray(row.reason_codes)
    ? row.reason_codes.filter((value: unknown): value is EligibilityReasonCode => isEligibilityReasonCode(value))
    : [];

  return {
    id: asNumber(row.id),
    epochId: asNumber(row.epoch_id),
    walletAddress: String(row.wallet_address),
    program: String(row.program) as EligibilityProgram,
    isEligible: Boolean(row.is_eligible),
    score: String(row.score ?? "0"),
    reasonCodes,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    computedAt: mustIso(row.computed_at, "eligibility_results.computed_at"),
    createdAt: mustIso(row.created_at, "eligibility_results.created_at"),
    updatedAt: mustIso(row.updated_at, "eligibility_results.updated_at"),
  };
}

function mapExclusionFlagRow(row: any): ExclusionFlagRecord {
  return {
    id: asNumber(row.id),
    walletAddress: String(row.wallet_address),
    epochId: row.epoch_id != null ? asNumber(row.epoch_id) : null,
    program: row.program ? String(row.program) as EligibilityProgram : null,
    flagType: String(row.flag_type) as EligibilityReasonCode,
    severity: String(row.severity) as ExclusionFlagSeverity,
    detailsJson: row.details_json && typeof row.details_json === "object" ? row.details_json : {},
    createdAt: mustIso(row.created_at, "exclusion_flags.created_at"),
    resolvedAt: toIso(row.resolved_at),
    resolvedBy: row.resolved_by ? String(row.resolved_by) : null,
    resolutionNote: row.resolution_note ? String(row.resolution_note) : null,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    updatedAt: mustIso(row.updated_at, "exclusion_flags.updated_at"),
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

async function getEpoch(db: DbLike, epochId: number): Promise<RewardEpochRecord> {
  const epoch = await getEpochById(epochId, db);
  if (!epoch) throw new Error(`Reward epoch ${epochId} not found`);
  return epoch;
}

async function getCandidateWallets(db: DbLike, epoch: RewardEpochRecord): Promise<string[]> {
  const r = await db.query(
    `with reward_wallets as (
       select distinct wallet_address
       from public.reward_events
       where epoch_id = $1 and wallet_address is not null
     ), creator_wallets as (
       select distinct lower(c.creator_address) as wallet_address
       from public.campaigns c
       join public.curve_trades t
         on t.chain_id = c.chain_id
        and t.campaign_address = c.campaign_address
        and t.block_time >= $2
        and t.block_time < $3
       where c.chain_id = $4
         and c.creator_address is not null
     ), recruiter_wallets as (
       select wallet_address from public.recruiters
     ), squad_wallets as (
       select distinct wallet_address
       from public.wallet_squad_memberships
       where joined_at < $3 and (left_at is null or left_at >= $2)
     )
     select wallet_address from reward_wallets
     union
     select wallet_address from creator_wallets
     union
     select wallet_address from recruiter_wallets
     union
     select wallet_address from squad_wallets
     order by wallet_address asc`,
    [epoch.id, epoch.startAt, epoch.endAt, epoch.chainId]
  );
  return r.rows.map((row: any) => String(row.wallet_address));
}

async function getTradeMetricsMap(db: DbLike, epoch: RewardEpochRecord): Promise<Map<string, WalletTradeMetrics>> {
  const r = await db.query(
    `select
       lower(t.wallet) as wallet_address,
       coalesce(sum(t.bnb_amount_raw::numeric), 0)::numeric(78,0) as trade_volume_raw,
       count(*)::int as trade_count,
       count(distinct date_trunc('day', t.block_time at time zone 'utc'))::int as active_days,
       count(*) filter (where lower(t.wallet) = lower(c.creator_address))::int as own_campaign_trade_count
     from public.curve_trades t
     left join public.campaigns c
       on c.chain_id = t.chain_id and c.campaign_address = t.campaign_address
     where t.chain_id = $1
       and t.block_time >= $2
       and t.block_time < $3
     group by lower(t.wallet)`,
    [epoch.chainId, epoch.startAt, epoch.endAt]
  );

  const map = new Map<string, WalletTradeMetrics>();
  for (const row of r.rows) {
    map.set(String(row.wallet_address), {
      tradeVolumeRaw: parseNumericBigInt(row.trade_volume_raw),
      tradeCount: asNumber(row.trade_count),
      activeDays: asNumber(row.active_days),
      ownCampaignTradeCount: asNumber(row.own_campaign_trade_count),
    });
  }
  return map;
}

async function getCreatorMetricsMap(db: DbLike, epoch: RewardEpochRecord): Promise<Map<string, WalletCreatorMetrics>> {
  const r = await db.query(
    `with per_campaign as (
       select
         lower(c.creator_address) as wallet_address,
         c.campaign_address,
         coalesce(sum(case when t.side = 'buy' then t.bnb_amount_raw::numeric else 0 end), 0)::numeric(78,0) as buy_volume_raw,
         count(distinct case when t.side = 'buy' and lower(t.wallet) <> lower(c.creator_address) then lower(t.wallet) end)::int as unique_buyers_non_creator
       from public.campaigns c
       left join public.curve_trades t
         on t.chain_id = c.chain_id
        and t.campaign_address = c.campaign_address
        and t.block_time >= $2
        and t.block_time < $3
       where c.chain_id = $1
         and c.creator_address is not null
       group by lower(c.creator_address), c.campaign_address
     ), qualified as (
       select
         wallet_address,
         campaign_address,
         buy_volume_raw,
         unique_buyers_non_creator,
         row_number() over (
           partition by wallet_address
           order by buy_volume_raw desc, campaign_address asc
         ) as qualified_rank
       from per_campaign
       where buy_volume_raw >= $4::numeric
         and unique_buyers_non_creator >= $5
     )
     select
       pc.wallet_address,
       count(*) filter (where pc.buy_volume_raw > 0)::int as active_campaign_count,
       count(*) filter (where pc.buy_volume_raw >= $4::numeric and pc.unique_buyers_non_creator >= $5)::int as qualifying_campaign_count,
       coalesce(sum(pc.buy_volume_raw), 0)::numeric(78,0) as total_buy_volume_raw,
       coalesce(sum(case when q.qualified_rank <= $6 then least(q.buy_volume_raw, $7::numeric) else 0 end), 0)::numeric(78,0) as counted_qualified_volume_raw,
       coalesce(max(pc.unique_buyers_non_creator), 0)::int as max_unique_buyers
     from per_campaign pc
     left join qualified q
       on q.wallet_address = pc.wallet_address and q.campaign_address = pc.campaign_address
     group by pc.wallet_address`,
    [
      epoch.chainId,
      epoch.startAt,
      epoch.endAt,
      bigintString(CREATOR_MIN_BONDING_VOLUME),
      CREATOR_MIN_UNIQUE_BUYERS,
      CREATOR_MAX_ELIGIBLE_CAMPAIGNS,
      bigintString(CREATOR_MAX_COUNTED_VOLUME),
    ]
  );

  const map = new Map<string, WalletCreatorMetrics>();
  for (const row of r.rows) {
    map.set(String(row.wallet_address), {
      activeCampaignCount: asNumber(row.active_campaign_count),
      qualifyingCampaignCount: asNumber(row.qualifying_campaign_count),
      totalBuyVolumeRaw: parseNumericBigInt(row.total_buy_volume_raw),
      countedQualifiedVolumeRaw: parseNumericBigInt(row.counted_qualified_volume_raw),
      maxUniqueBuyers: asNumber(row.max_unique_buyers),
    });
  }
  return map;
}

async function getAttributionSnapshotMap(db: DbLike): Promise<Map<string, WalletAttributionSnapshot>> {
  const r = await db.query(
    `select wallet_address, recruiter_link_state, squad_state, recruiter_id, recruiter_code, recruiter_status,
            coalesce(recruiter_is_og, false) as recruiter_is_og, last_detach_reason
       from public.wallet_attribution_states`
  );
  const map = new Map<string, WalletAttributionSnapshot>();
  for (const row of r.rows) {
    map.set(String(row.wallet_address), {
      recruiterLinkState: row.recruiter_link_state ? String(row.recruiter_link_state) : null,
      squadState: row.squad_state ? String(row.squad_state) : null,
      recruiterId: row.recruiter_id != null ? asNumber(row.recruiter_id) : null,
      recruiterCode: row.recruiter_code ? String(row.recruiter_code) : null,
      recruiterStatus: row.recruiter_status ? String(row.recruiter_status) : null,
      recruiterIsOg: Boolean(row.recruiter_is_og),
      lastDetachReason: row.last_detach_reason ? String(row.last_detach_reason) : null,
    });
  }
  return map;
}

async function getRecruiterWalletsMap(db: DbLike): Promise<Map<string, { id: number; code: string; status: string; isOg: boolean }>> {
  const r = await db.query(`select id, wallet_address, code, status, is_og from public.recruiters`);
  const map = new Map<string, { id: number; code: string; status: string; isOg: boolean }>();
  for (const row of r.rows) {
    map.set(String(row.wallet_address), {
      id: asNumber(row.id),
      code: String(row.code),
      status: String(row.status),
      isOg: Boolean(row.is_og),
    });
  }
  return map;
}

async function getSquadOverlapMap(db: DbLike, epoch: RewardEpochRecord): Promise<Map<string, SquadMembershipOverlap>> {
  const r = await db.query(
    `select distinct on (wallet_address)
       wallet_address, recruiter_id, joined_at, left_at, leave_reason
     from public.wallet_squad_memberships
     where joined_at < $2 and (left_at is null or left_at >= $1)
     order by wallet_address, joined_at desc, id desc`,
    [epoch.startAt, epoch.endAt]
  );
  const map = new Map<string, SquadMembershipOverlap>();
  for (const row of r.rows) {
    map.set(String(row.wallet_address), {
      recruiterId: asNumber(row.recruiter_id),
      joinedAt: mustIso(row.joined_at, "wallet_squad_memberships.joined_at"),
      leftAt: toIso(row.left_at),
      leaveReason: row.leave_reason ? String(row.leave_reason) : null,
    });
  }
  return map;
}

async function getOpenExclusionFlags(db: DbLike, epochId: number): Promise<ExclusionFlagRecord[]> {
  const r = await db.query(
    `select *
       from public.exclusion_flags
      where resolved_at is null
        and (epoch_id is null or epoch_id = $1)
      order by created_at asc, id asc`,
    [epochId]
  );
  return r.rows.map(mapExclusionFlagRow);
}

async function getRecentAirdropWinnerWallets(db: DbLike, epoch: RewardEpochRecord): Promise<Set<string>> {
  const r = await db.query(
    `with prior_epochs as (
       select id
         from public.epochs
        where chain_id = $1
          and epoch_type = 'weekly'
          and end_at <= $2
          and id <> $3
        order by end_at desc, id desc
        limit 2
     )
     select distinct lower(w.wallet_address) as wallet_address
       from public.airdrop_winners w
       join public.airdrop_draws d on d.id = w.draw_id
      where d.status = 'published'
        and w.epoch_id in (select id from prior_epochs)`,
    [epoch.chainId, epoch.startAt, epoch.id]
  );
  return new Set(r.rows.map((row: any) => String(row.wallet_address)));
}

async function getActiveBattleLeagueWinnerWallets(db: DbLike, epoch: RewardEpochRecord): Promise<Set<string>> {
  const epochStart = new Date(epoch.startAt);
  const epochEnd = new Date(epoch.endAt);
  if (Number.isNaN(epochStart.getTime()) || Number.isNaN(epochEnd.getTime())) return new Set();

  const monthStart = new Date(Date.UTC(epochStart.getUTCFullYear(), epochStart.getUTCMonth(), 1, 0, 0, 0, 0));
  const nextMonthStart = new Date(Date.UTC(epochStart.getUTCFullYear(), epochStart.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  if (epochEnd >= nextMonthStart) return new Set();

  const r = await db.query(
    `select distinct lower(recipient_address) as wallet_address
       from public.league_epoch_winners
      where chain_id = $1
        and epoch_end >= $2
        and epoch_end < $3`,
    [epoch.chainId, monthStart.toISOString(), nextMonthStart.toISOString()]
  );
  return new Set(r.rows.map((row: any) => String(row.wallet_address)));
}

async function clearAutomaticExclusionFlagsForEpoch(db: DbLike, epochId: number): Promise<void> {
  await db.query(
    `delete from public.exclusion_flags
      where epoch_id = $1
        and resolved_at is null
        and coalesce((metadata ->> 'autoGenerated')::boolean, false) = true`,
    [epochId]
  );
}

async function insertAutomaticExclusionFlag(
  db: DbLike,
  input: {
    walletAddress: string;
    epochId: number;
    flagType: EligibilityReasonCode;
    severity: ExclusionFlagSeverity;
    detailsJson?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  const walletAddress = parseWalletAddressOrNull(input.walletAddress);
  if (!walletAddress) return;
  await db.query(
    `insert into public.exclusion_flags(
       wallet_address, epoch_id, program, flag_type, severity, details_json, metadata, created_at, updated_at
     ) values (
       $1, $2, null, $3, $4, $5::jsonb, $6::jsonb, now(), now()
     )`,
    [
      walletAddress,
      input.epochId,
      input.flagType,
      input.severity,
      JSON.stringify(input.detailsJson ?? {}),
      JSON.stringify({ autoGenerated: true, ...(input.metadata ?? {}) }),
    ]
  );
}

async function syncAutomaticExclusionFlagsForEpoch(db: DbLike, epoch: RewardEpochRecord): Promise<void> {
  await clearAutomaticExclusionFlagsForEpoch(db, epoch.id);

  const selfTrading = await db.query(
    `select (array_agg(t.wallet order by t.block_time desc))[1] as wallet_address,
            count(*)::int as matched_trade_count,
            array_agg(distinct t.campaign_address order by t.campaign_address) as campaign_addresses
       from public.curve_trades t
       join public.campaigns c
         on c.chain_id = t.chain_id
        and c.campaign_address = t.campaign_address
      where t.chain_id = $1
        and t.block_time >= $2
        and t.block_time < $3
        and (t.wallet = c.creator_address or lower(t.wallet) = lower(c.creator_address))
      group by lower(t.wallet)`,
    [epoch.chainId, epoch.startAt, epoch.endAt]
  );

  for (const row of selfTrading.rows) {
    const walletAddress = String(row.wallet_address);
    await insertAutomaticExclusionFlag(db, {
      walletAddress,
      epochId: epoch.id,
      flagType: "SELF_TRADING",
      severity: "hard",
      detailsJson: {
        matchedTradeCount: asNumber(row.matched_trade_count),
        campaignAddresses: Array.isArray(row.campaign_addresses) ? row.campaign_addresses : [],
      },
      metadata: { detector: "self_trading_v1" },
    });
    await insertAutomaticExclusionFlag(db, {
      walletAddress,
      epochId: epoch.id,
      flagType: "CREATOR_FUNDED_FAKE_DEMAND",
      severity: "review",
      detailsJson: {
        matchedTradeCount: asNumber(row.matched_trade_count),
        campaignAddresses: Array.isArray(row.campaign_addresses) ? row.campaign_addresses : [],
      },
      metadata: { detector: "creator_funded_fake_demand_v1" },
    });
  }

  const commonControl = await db.query(
    `select (array_agg(t.wallet order by t.block_time desc))[1] as wallet_address,
            count(*)::int as matched_trade_count,
            array_agg(distinct t.campaign_address order by t.campaign_address) as campaign_addresses
       from public.curve_trades t
       join public.campaigns c
         on c.chain_id = t.chain_id
        and c.campaign_address = t.campaign_address
      where t.chain_id = $1
        and t.block_time >= $2
        and t.block_time < $3
        and c.fee_recipient_address is not null
        and (t.wallet = c.fee_recipient_address or lower(t.wallet) = lower(c.fee_recipient_address))
        and lower(t.wallet) <> lower(c.creator_address)
      group by lower(t.wallet)`,
    [epoch.chainId, epoch.startAt, epoch.endAt]
  );

  for (const row of commonControl.rows) {
    await insertAutomaticExclusionFlag(db, {
      walletAddress: String(row.wallet_address),
      epochId: epoch.id,
      flagType: "COMMON_CONTROL_CLUSTER",
      severity: "review",
      detailsJson: {
        matchedTradeCount: asNumber(row.matched_trade_count),
        campaignAddresses: Array.isArray(row.campaign_addresses) ? row.campaign_addresses : [],
      },
      metadata: { detector: "common_control_cluster_v1" },
    });
  }

  const circular = await db.query(
    `select (array_agg(t.wallet order by t.block_time desc))[1] as wallet_address,
            count(distinct t.campaign_address)::int as campaign_count,
            array_agg(distinct t.campaign_address order by t.campaign_address) as campaign_addresses
       from public.curve_trades t
      where t.chain_id = $1
        and t.block_time >= $2
        and t.block_time < $3
      group by lower(t.wallet), t.campaign_address
      having count(*) filter (where t.side = 'buy') > 0
         and count(*) filter (where t.side = 'sell') > 0`,
    [epoch.chainId, epoch.startAt, epoch.endAt]
  );

  const circularByWallet = new Map<string, Set<string>>();
  for (const row of circular.rows) {
    const walletAddress = String(row.wallet_address);
    const current = circularByWallet.get(walletAddress) ?? new Set<string>();
    if (Array.isArray(row.campaign_addresses)) {
      for (const campaignAddress of row.campaign_addresses) current.add(String(campaignAddress));
    }
    circularByWallet.set(walletAddress, current);
  }

  for (const [walletAddress, campaigns] of circularByWallet.entries()) {
    await insertAutomaticExclusionFlag(db, {
      walletAddress,
      epochId: epoch.id,
      flagType: "CIRCULAR_TRADING",
      severity: "review",
      detailsJson: {
        campaignCount: campaigns.size,
        campaignAddresses: Array.from(campaigns.values()).sort(),
      },
      metadata: { detector: "circular_trading_v1" },
    });
  }

  const walletSplitting = await db.query(
    `with per_wallet as (
       select
         l.recruiter_id,
         l.wallet_address,
         coalesce(sum(t.bnb_amount_raw::numeric), 0)::numeric(78,0) as trade_volume_raw
       from public.wallet_recruiter_links l
       join public.curve_trades t
         on lower(t.wallet) = l.wallet_address
        and t.chain_id = $1
        and t.block_time >= $2
        and t.block_time < $3
       where l.linked_at < $3
         and (l.detached_at is null or l.detached_at >= $2)
       group by l.recruiter_id, l.wallet_address
     ), flagged_recruiters as (
       select recruiter_id
       from per_wallet
       where trade_volume_raw > 0::numeric
         and trade_volume_raw < $4::numeric
       group by recruiter_id
       having count(*) >= 4
     )
     select p.wallet_address, p.recruiter_id, p.trade_volume_raw
       from per_wallet p
       join flagged_recruiters f on f.recruiter_id = p.recruiter_id
      where p.trade_volume_raw > 0::numeric
        and p.trade_volume_raw < $4::numeric`,
    [epoch.chainId, epoch.startAt, epoch.endAt, bigintString(TRADER_MIN_VOLUME)]
  );

  for (const row of walletSplitting.rows) {
    await insertAutomaticExclusionFlag(db, {
      walletAddress: String(row.wallet_address),
      epochId: epoch.id,
      flagType: "WALLET_SPLITTING",
      severity: "review",
      detailsJson: {
        recruiterId: asNumber(row.recruiter_id),
        tradeVolumeRaw: String(row.trade_volume_raw ?? "0"),
      },
      metadata: { detector: "wallet_splitting_v1" },
    });
  }

  const recruiterFarmingLoops = await db.query(
    `select r.wallet_address as wallet_address,
            r.id as recruiter_id,
            array_agg(distinct t.campaign_address order by t.campaign_address) as campaign_addresses
       from public.recruiters r
       join public.curve_trades t
         on (t.wallet = r.wallet_address or lower(t.wallet) = lower(r.wallet_address))
        and t.chain_id = $1
        and t.block_time >= $2
        and t.block_time < $3
       join public.campaigns c
         on c.chain_id = t.chain_id
        and c.campaign_address = t.campaign_address
       join public.wallet_recruiter_links l
         on l.recruiter_id = r.id
        and (lower(c.creator_address) = lower(l.wallet_address) or c.creator_address = l.wallet_address)
        and l.linked_at <= t.block_time
        and (l.detached_at is null or l.detached_at > t.block_time)
      group by r.wallet_address, r.id`,
    [epoch.chainId, epoch.startAt, epoch.endAt]
  );

  for (const row of recruiterFarmingLoops.rows) {
    await insertAutomaticExclusionFlag(db, {
      walletAddress: String(row.wallet_address),
      epochId: epoch.id,
      flagType: "RECRUITER_FARMING_LOOP",
      severity: "review",
      detailsJson: {
        recruiterId: asNumber(row.recruiter_id),
        campaignAddresses: Array.isArray(row.campaign_addresses) ? row.campaign_addresses : [],
      },
      metadata: { detector: "recruiter_farming_loop_v1" },
    });
  }
}

function appliesToProgram(flag: ExclusionFlagRecord, program: EligibilityProgram): boolean {
  return flag.program == null || flag.program === program;
}

function collectFlagReasons(
  walletAddress: string,
  program: EligibilityProgram,
  flagsByWallet: Map<string, ExclusionFlagRecord[]>,
): { hardReasons: EligibilityReasonCode[]; reviewReasons: EligibilityReasonCode[] } {
  const flags = flagsByWallet.get(walletAddress) ?? [];
  const hardReasons: EligibilityReasonCode[] = [];
  const reviewReasons: EligibilityReasonCode[] = [];

  for (const flag of flags) {
    if (!appliesToProgram(flag, program)) continue;
    if (flag.severity === "hard") {
      hardReasons.push(flag.flagType);
    } else {
      reviewReasons.push(flag.flagType === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : flag.flagType);
      if (flag.flagType !== "REVIEW_REQUIRED") reviewReasons.push("REVIEW_REQUIRED");
    }
  }

  return {
    hardReasons: uniqReasonCodes(hardReasons),
    reviewReasons: uniqReasonCodes(reviewReasons),
  };
}

function evaluateRecruiterProgram(input: {
  walletAddress: string;
  recruiterByWallet: Map<string, { id: number; code: string; status: string; isOg: boolean }>;
  flagsByWallet: Map<string, ExclusionFlagRecord[]>;
  ledgerAmountByWallet: Map<string, bigint>;
}): { isEligible: boolean; score: bigint; reasonCodes: EligibilityReasonCode[]; metadata: Record<string, unknown> } {
  const recruiter = input.recruiterByWallet.get(input.walletAddress);
  const flagReasons = collectFlagReasons(input.walletAddress, "recruiter", input.flagsByWallet);
  const reasonCodes: EligibilityReasonCode[] = [...flagReasons.hardReasons, ...flagReasons.reviewReasons];

  if (!recruiter) reasonCodes.push("NO_RECRUITER");
  if (recruiter?.status === "closed") reasonCodes.push("RECRUITER_CLOSED");
  if (recruiter && recruiter.status !== "active" && recruiter.status !== "closed") reasonCodes.push("REVIEW_REQUIRED");

  const score = input.ledgerAmountByWallet.get(input.walletAddress) ?? 0n;
  if (score <= 0n) reasonCodes.push("NO_REWARD_ACTIVITY");

  const finalReasonCodes = uniqReasonCodes(reasonCodes);
  return {
    isEligible: finalReasonCodes.length === 0,
    score,
    reasonCodes: finalReasonCodes,
    metadata: {
      recruiterId: recruiter?.id ?? null,
      recruiterCode: recruiter?.code ?? null,
      recruiterStatus: recruiter?.status ?? null,
      pendingLedgerAmountRaw: bigintString(score),
    },
  };
}

export function evaluateTraderAirdropProgram(input: {
  walletAddress: string;
  tradeMetrics: WalletTradeMetrics;
  recruiterByWallet: Map<string, { id: number; code: string; status: string; isOg: boolean }>;
  flagsByWallet: Map<string, ExclusionFlagRecord[]>;
  recentAirdropWinnerWallets: Set<string>;
  activeBattleLeagueWinnerWallets: Set<string>;
}): { isEligible: boolean; score: bigint; reasonCodes: EligibilityReasonCode[]; metadata: Record<string, unknown> } {
  const flagReasons = collectFlagReasons(input.walletAddress, "airdrop_trader", input.flagsByWallet);
  const reasonCodes: EligibilityReasonCode[] = [...flagReasons.hardReasons, ...flagReasons.reviewReasons];
  const recruiter = input.recruiterByWallet.get(input.walletAddress);

  if (recruiter) reasonCodes.push("RECRUITER_DIRECT_WIN_EXCLUDED");
  if (input.recentAirdropWinnerWallets.has(input.walletAddress)) reasonCodes.push("REPEAT_WINNER_COOLDOWN");
  if (input.activeBattleLeagueWinnerWallets.has(input.walletAddress)) reasonCodes.push("BATTLE_LEAGUE_ACTIVE_WINNER");
  if (input.tradeMetrics.tradeVolumeRaw < TRADER_MIN_VOLUME) reasonCodes.push("TRADER_VOLUME_BELOW_MIN");
  if (input.tradeMetrics.tradeCount < TRADER_MIN_TRADE_COUNT) reasonCodes.push("TRADER_TRADE_COUNT_BELOW_MIN");
  if (input.tradeMetrics.activeDays < TRADER_MIN_ACTIVE_DAYS) reasonCodes.push("TRADER_ACTIVE_DAYS_BELOW_MIN");
  if (input.tradeMetrics.ownCampaignTradeCount > 0) reasonCodes.push("OWN_CAMPAIGN_TRADE_EXCLUDED");

  const cappedScore = input.tradeMetrics.tradeVolumeRaw > TRADER_MAX_COUNTED_VOLUME
    ? TRADER_MAX_COUNTED_VOLUME
    : input.tradeMetrics.tradeVolumeRaw;

  const finalReasonCodes = uniqReasonCodes(reasonCodes);
  return {
    isEligible: finalReasonCodes.length === 0,
    score: finalReasonCodes.includes("TRADER_VOLUME_BELOW_MIN") ? 0n : cappedScore,
    reasonCodes: finalReasonCodes,
    metadata: {
      tradeVolumeRaw: bigintString(input.tradeMetrics.tradeVolumeRaw),
      countedTradeVolumeRaw: bigintString(cappedScore),
      tradeCount: input.tradeMetrics.tradeCount,
      activeDays: input.tradeMetrics.activeDays,
      ownCampaignTradeCount: input.tradeMetrics.ownCampaignTradeCount,
      cappedByMaxVolume: input.tradeMetrics.tradeVolumeRaw > TRADER_MAX_COUNTED_VOLUME,
      repeatWinnerCooldownActive: input.recentAirdropWinnerWallets.has(input.walletAddress),
      battleLeagueWinnerActive: input.activeBattleLeagueWinnerWallets.has(input.walletAddress),
    },
  };
}

export function evaluateCreatorAirdropProgram(input: {
  walletAddress: string;
  creatorMetrics: WalletCreatorMetrics;
  recruiterByWallet: Map<string, { id: number; code: string; status: string; isOg: boolean }>;
  flagsByWallet: Map<string, ExclusionFlagRecord[]>;
  recentAirdropWinnerWallets: Set<string>;
  activeBattleLeagueWinnerWallets: Set<string>;
}): { isEligible: boolean; score: bigint; reasonCodes: EligibilityReasonCode[]; metadata: Record<string, unknown> } {
  const flagReasons = collectFlagReasons(input.walletAddress, "airdrop_creator", input.flagsByWallet);
  const reasonCodes: EligibilityReasonCode[] = [...flagReasons.hardReasons, ...flagReasons.reviewReasons];
  const recruiter = input.recruiterByWallet.get(input.walletAddress);

  if (recruiter) reasonCodes.push("RECRUITER_DIRECT_WIN_EXCLUDED");
  if (input.recentAirdropWinnerWallets.has(input.walletAddress)) reasonCodes.push("REPEAT_WINNER_COOLDOWN");
  if (input.activeBattleLeagueWinnerWallets.has(input.walletAddress)) reasonCodes.push("BATTLE_LEAGUE_ACTIVE_WINNER");
  if (input.creatorMetrics.totalBuyVolumeRaw < CREATOR_MIN_BONDING_VOLUME) reasonCodes.push("CREATOR_BONDING_VOLUME_BELOW_MIN");
  if (input.creatorMetrics.maxUniqueBuyers < CREATOR_MIN_UNIQUE_BUYERS) reasonCodes.push("CREATOR_UNIQUE_BUYERS_BELOW_MIN");
  if (input.creatorMetrics.qualifyingCampaignCount > CREATOR_MAX_ELIGIBLE_CAMPAIGNS) reasonCodes.push("CREATOR_CAMPAIGN_CAP_EXCEEDED");

  const countedScore = input.creatorMetrics.countedQualifiedVolumeRaw > CREATOR_MAX_COUNTED_VOLUME
    ? CREATOR_MAX_COUNTED_VOLUME
    : input.creatorMetrics.countedQualifiedVolumeRaw;

  const finalReasonCodes = uniqReasonCodes(reasonCodes);
  return {
    isEligible: finalReasonCodes.filter((code) => code !== "CREATOR_CAMPAIGN_CAP_EXCEEDED").length === 0,
    score: finalReasonCodes.includes("CREATOR_BONDING_VOLUME_BELOW_MIN") || finalReasonCodes.includes("CREATOR_UNIQUE_BUYERS_BELOW_MIN")
      ? 0n
      : countedScore,
    reasonCodes: finalReasonCodes,
    metadata: {
      activeCampaignCount: input.creatorMetrics.activeCampaignCount,
      qualifyingCampaignCount: input.creatorMetrics.qualifyingCampaignCount,
      totalBuyVolumeRaw: bigintString(input.creatorMetrics.totalBuyVolumeRaw),
      countedQualifiedVolumeRaw: bigintString(countedScore),
      maxUniqueBuyers: input.creatorMetrics.maxUniqueBuyers,
      usesApproximateNonLinkedBuyerCount: true,
      repeatWinnerCooldownActive: input.recentAirdropWinnerWallets.has(input.walletAddress),
      battleLeagueWinnerActive: input.activeBattleLeagueWinnerWallets.has(input.walletAddress),
    },
  };
}

export function evaluateSquadProgram(input: {
  walletAddress: string;
  tradeMetrics: WalletTradeMetrics;
  creatorMetrics: WalletCreatorMetrics;
  attributionSnapshot: WalletAttributionSnapshot | undefined;
  squadOverlap: SquadMembershipOverlap | undefined;
  flagsByWallet: Map<string, ExclusionFlagRecord[]>;
}): { isEligible: boolean; score: bigint; reasonCodes: EligibilityReasonCode[]; metadata: Record<string, unknown> } {
  const flagReasons = collectFlagReasons(input.walletAddress, "squad", input.flagsByWallet);
  const reasonCodes: EligibilityReasonCode[] = [...flagReasons.hardReasons, ...flagReasons.reviewReasons];

  if (!input.squadOverlap) {
    if (input.attributionSnapshot?.squadState === "solo_detached" || input.attributionSnapshot?.lastDetachReason) {
      reasonCodes.push("SQUAD_DETACHED");
    } else {
      reasonCodes.push("NO_SQUAD");
    }
  }

  const traderComponentEligible =
    input.tradeMetrics.tradeVolumeRaw >= TRADER_MIN_VOLUME &&
    input.tradeMetrics.tradeCount >= TRADER_MIN_TRADE_COUNT &&
    input.tradeMetrics.activeDays >= TRADER_MIN_ACTIVE_DAYS &&
    input.tradeMetrics.ownCampaignTradeCount === 0;

  const creatorComponentEligible =
    input.creatorMetrics.totalBuyVolumeRaw >= CREATOR_MIN_BONDING_VOLUME &&
    input.creatorMetrics.maxUniqueBuyers >= CREATOR_MIN_UNIQUE_BUYERS;

  if (!traderComponentEligible) {
    if (input.tradeMetrics.tradeVolumeRaw < TRADER_MIN_VOLUME) reasonCodes.push("TRADER_VOLUME_BELOW_MIN");
    if (input.tradeMetrics.tradeCount < TRADER_MIN_TRADE_COUNT) reasonCodes.push("TRADER_TRADE_COUNT_BELOW_MIN");
    if (input.tradeMetrics.activeDays < TRADER_MIN_ACTIVE_DAYS) reasonCodes.push("TRADER_ACTIVE_DAYS_BELOW_MIN");
    if (input.tradeMetrics.ownCampaignTradeCount > 0) reasonCodes.push("OWN_CAMPAIGN_TRADE_EXCLUDED");
  }

  if (!creatorComponentEligible) {
    if (input.creatorMetrics.totalBuyVolumeRaw < CREATOR_MIN_BONDING_VOLUME) reasonCodes.push("CREATOR_BONDING_VOLUME_BELOW_MIN");
    if (input.creatorMetrics.maxUniqueBuyers < CREATOR_MIN_UNIQUE_BUYERS) reasonCodes.push("CREATOR_UNIQUE_BUYERS_BELOW_MIN");
  }

  const traderScore = traderComponentEligible
    ? (input.tradeMetrics.tradeVolumeRaw > TRADER_MAX_COUNTED_VOLUME ? TRADER_MAX_COUNTED_VOLUME : input.tradeMetrics.tradeVolumeRaw)
    : 0n;
  const creatorScore = creatorComponentEligible
    ? (input.creatorMetrics.countedQualifiedVolumeRaw > CREATOR_MAX_COUNTED_VOLUME ? CREATOR_MAX_COUNTED_VOLUME : input.creatorMetrics.countedQualifiedVolumeRaw)
    : 0n;

  const finalReasonCodes = uniqReasonCodes(reasonCodes);
  return {
    isEligible: finalReasonCodes.filter((code) => code !== "CREATOR_CAMPAIGN_CAP_EXCEEDED").length === 0,
    score: traderScore + creatorScore,
    reasonCodes: finalReasonCodes,
    metadata: {
      squadRecruiterId: input.squadOverlap?.recruiterId ?? null,
      squadJoinedAt: input.squadOverlap?.joinedAt ?? null,
      squadLeftAt: input.squadOverlap?.leftAt ?? null,
      traderScoreRaw: bigintString(traderScore),
      creatorScoreRaw: bigintString(creatorScore),
      combinedScoreRaw: bigintString(traderScore + creatorScore),
      usesApproximateNonLinkedBuyerCount: true,
    },
  };
}

async function getRecruiterRewardAmountMap(db: DbLike, epoch: RewardEpochRecord): Promise<Map<string, bigint>> {
  const r = await db.query(
    `with event_matches as (
       select
         rec.wallet_address,
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
     select wallet_address, coalesce(sum(recruiter_amount), 0)::numeric(78,0) as total_amount
       from event_matches
      group by wallet_address`,
    [epoch.id]
  );
  const map = new Map<string, bigint>();
  for (const row of r.rows) {
    map.set(String(row.wallet_address), parseNumericBigInt(row.total_amount));
  }
  return map;
}

async function upsertEligibilityResult(
  db: DbLike,
  epochId: number,
  walletAddress: string,
  program: EligibilityProgram,
  result: { isEligible: boolean; score: bigint; reasonCodes: EligibilityReasonCode[]; metadata: Record<string, unknown> },
): Promise<EligibilityResultRecord> {
  const r = await db.query(
    `insert into public.eligibility_results(
       epoch_id, wallet_address, program, is_eligible, score, reason_codes, metadata, computed_at, created_at, updated_at
     ) values (
       $1, $2, $3, $4, $5, $6::text[], $7::jsonb, now(), now(), now()
     )
     on conflict (epoch_id, wallet_address, program) do update set
       is_eligible = excluded.is_eligible,
       score = excluded.score,
       reason_codes = excluded.reason_codes,
       metadata = excluded.metadata,
       computed_at = now(),
       updated_at = now()
     returning *`,
    [
      epochId,
      walletAddress,
      program,
      result.isEligible,
      bigintString(result.score),
      uniqReasonCodes(result.reasonCodes),
      JSON.stringify(result.metadata ?? {}),
    ]
  );
  return mapEligibilityRow(r.rows[0]);
}

export async function processRewardEligibilityForEpoch(epochId: number): Promise<ProcessEligibilityResult> {
  return withTransaction(async (db) => {
    const epoch = await getEpoch(db, epochId);
    const wallets = await getCandidateWallets(db, epoch);
    const [tradeMetricsMap, creatorMetricsMap, attributionMap, recruiterByWallet, squadMap, recruiterRewardAmountMap, recentAirdropWinnerWallets, activeBattleLeagueWinnerWallets] = await Promise.all([
      getTradeMetricsMap(db, epoch),
      getCreatorMetricsMap(db, epoch),
      getAttributionSnapshotMap(db),
      getRecruiterWalletsMap(db),
      getSquadOverlapMap(db, epoch),
      getRecruiterRewardAmountMap(db, epoch),
      getRecentAirdropWinnerWallets(db, epoch),
      getActiveBattleLeagueWinnerWallets(db, epoch),
    ]);

    await syncAutomaticExclusionFlagsForEpoch(db, epoch);
    const openFlags = await getOpenExclusionFlags(db, epoch.id);

    const flagsByWallet = new Map<string, ExclusionFlagRecord[]>();
    for (const flag of openFlags) {
      const current = flagsByWallet.get(flag.walletAddress) ?? [];
      current.push(flag);
      flagsByWallet.set(flag.walletAddress, current);
    }

    const eligibleCounts: Record<EligibilityProgram, number> = {
      recruiter: 0,
      airdrop_trader: 0,
      airdrop_creator: 0,
      squad: 0,
    };

    let reviewCount = 0;
    let hardFlaggedCount = 0;
    let resultCount = 0;

    for (const walletAddress of wallets) {
      const tradeMetrics = tradeMetricsMap.get(walletAddress) ?? {
        tradeVolumeRaw: 0n,
        tradeCount: 0,
        activeDays: 0,
        ownCampaignTradeCount: 0,
      };
      const creatorMetrics = creatorMetricsMap.get(walletAddress) ?? {
        activeCampaignCount: 0,
        qualifyingCampaignCount: 0,
        totalBuyVolumeRaw: 0n,
        countedQualifiedVolumeRaw: 0n,
        maxUniqueBuyers: 0,
      };
      const attributionSnapshot = attributionMap.get(walletAddress);
      const squadOverlap = squadMap.get(walletAddress);
      const walletFlags = flagsByWallet.get(walletAddress) ?? [];
      if (walletFlags.some((flag) => flag.severity === "review")) reviewCount += 1;
      if (walletFlags.some((flag) => flag.severity === "hard")) hardFlaggedCount += 1;

      const recruiterResult = evaluateRecruiterProgram({
        walletAddress,
        recruiterByWallet,
        flagsByWallet,
        ledgerAmountByWallet: recruiterRewardAmountMap,
      });
      const airdropTraderResult = evaluateTraderAirdropProgram({
        walletAddress,
        tradeMetrics,
        recruiterByWallet,
        flagsByWallet,
        recentAirdropWinnerWallets,
        activeBattleLeagueWinnerWallets,
      });
      const airdropCreatorResult = evaluateCreatorAirdropProgram({
        walletAddress,
        creatorMetrics,
        recruiterByWallet,
        flagsByWallet,
        recentAirdropWinnerWallets,
        activeBattleLeagueWinnerWallets,
      });
      const squadResult = evaluateSquadProgram({
        walletAddress,
        tradeMetrics,
        creatorMetrics,
        attributionSnapshot,
        squadOverlap,
        flagsByWallet,
      });

      const resultsByProgram = {
        recruiter: recruiterResult,
        airdrop_trader: airdropTraderResult,
        airdrop_creator: airdropCreatorResult,
        squad: squadResult,
      } satisfies Record<EligibilityProgram, { isEligible: boolean; score: bigint; reasonCodes: EligibilityReasonCode[]; metadata: Record<string, unknown> }>;

      for (const program of ELIGIBILITY_PROGRAMS) {
        const saved = await upsertEligibilityResult(db, epoch.id, walletAddress, program, resultsByProgram[program]);
        resultCount += 1;
        if (saved.isEligible) eligibleCounts[program] += 1;
      }
    }

    return {
      epoch,
      walletCount: wallets.length,
      resultCount,
      eligibleCounts,
      reviewCount,
      hardFlaggedCount,
    };
  });
}

export async function listEligibilityResults(filters: {
  epochId?: number | null;
  walletAddress?: string | null;
  program?: EligibilityProgram | null;
  limit?: number;
} = {}): Promise<EligibilityResultRecord[]> {
  const clauses: string[] = [];
  const values: Array<string | number> = [];

  if (filters.epochId != null) {
    values.push(filters.epochId);
    clauses.push(`epoch_id = $${values.length}`);
  }
  if (filters.walletAddress) {
    values.push(normalizeAddress(filters.walletAddress));
    clauses.push(`wallet_address = $${values.length}`);
  }
  if (filters.program) {
    values.push(filters.program);
    clauses.push(`program = $${values.length}`);
  }

  const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
  values.push(Math.max(1, Math.min(500, Math.trunc(filters.limit ?? 100) || 100)));

  const r = await pool.query(
    `select *
       from public.eligibility_results
       ${where}
      order by computed_at desc, id desc
      limit $${values.length}`,
    values
  );
  return r.rows.map(mapEligibilityRow);
}

export async function createExclusionFlag(input: {
  walletAddress: string;
  epochId?: number | null;
  program?: EligibilityProgram | null;
  flagType: EligibilityReasonCode;
  severity: ExclusionFlagSeverity;
  detailsJson?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}): Promise<ExclusionFlagRecord> {
  const walletAddress = normalizeAddress(input.walletAddress);
  if (!isEligibilityReasonCode(input.flagType)) throw new Error(`Invalid exclusion flag type: ${String(input.flagType)}`);
  if (!isExclusionFlagSeverity(input.severity)) throw new Error(`Invalid exclusion severity: ${String(input.severity)}`);
  if (input.program != null && !isEligibilityProgram(input.program)) throw new Error(`Invalid exclusion program: ${String(input.program)}`);

  const r = await pool.query(
    `insert into public.exclusion_flags(
       wallet_address, epoch_id, program, flag_type, severity, details_json, metadata, created_at, updated_at
     ) values (
       $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, now(), now()
     )
     returning *`,
    [
      walletAddress,
      input.epochId ?? null,
      input.program ?? null,
      input.flagType,
      input.severity,
      JSON.stringify(input.detailsJson ?? {}),
      JSON.stringify(input.metadata ?? {}),
    ]
  );
  return mapExclusionFlagRow(r.rows[0]);
}

export async function resolveExclusionFlag(input: {
  exclusionFlagId: number;
  resolvedBy?: string | null;
  resolutionNote?: string | null;
  resolvedAt?: Date;
}): Promise<ExclusionFlagRecord | null> {
  const resolvedBy = input.resolvedBy ? normalizeAddress(input.resolvedBy) : null;
  const r = await pool.query(
    `update public.exclusion_flags
        set resolved_at = $2,
            resolved_by = $3,
            resolution_note = $4,
            updated_at = now()
      where id = $1
      returning *`,
    [input.exclusionFlagId, input.resolvedAt ?? new Date(), resolvedBy, input.resolutionNote ?? null]
  );
  return r.rows[0] ? mapExclusionFlagRow(r.rows[0]) : null;
}

export async function listExclusionFlags(filters: {
  walletAddress?: string | null;
  epochId?: number | null;
  program?: EligibilityProgram | null;
  severity?: ExclusionFlagSeverity | null;
  onlyOpen?: boolean;
  limit?: number;
} = {}): Promise<ExclusionFlagRecord[]> {
  const clauses: string[] = [];
  const values: Array<string | number> = [];

  if (filters.walletAddress) {
    values.push(normalizeAddress(filters.walletAddress));
    clauses.push(`wallet_address = $${values.length}`);
  }
  if (filters.epochId != null) {
    values.push(filters.epochId);
    clauses.push(`epoch_id = $${values.length}`);
  }
  if (filters.program) {
    values.push(filters.program);
    clauses.push(`program = $${values.length}`);
  }
  if (filters.severity) {
    values.push(filters.severity);
    clauses.push(`severity = $${values.length}`);
  }
  if (filters.onlyOpen) {
    clauses.push(`resolved_at is null`);
  }

  const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
  values.push(Math.max(1, Math.min(500, Math.trunc(filters.limit ?? 100) || 100)));

  const r = await pool.query(
    `select *
       from public.exclusion_flags
       ${where}
      order by created_at desc, id desc
      limit $${values.length}`,
    values
  );
  return r.rows.map(mapExclusionFlagRow);
}
