/**
 * Accrue DBC collector slices per indexed trade. Idempotent on (tx, log_index).
 */
import { ensureWeeklyEpoch } from "../rewards/epochs.js";
import {
  creatorFeeModeFromChoice,
  profileFromLink,
  splitDbcCollectorFee,
  type DbcCreatorFeeMode,
  type DbcFeeProfile,
  type DbcFeeSlices,
} from "./dbcFeeSplit.js";

export const SOLANA_CHAIN_ID = 101;
export const DBC_PROGRAM_ID = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";

type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };

const LINK_SQL = `
select r.is_og
  from public.wallet_recruiter_links l
  join public.recruiters r on r.id = l.recruiter_id
 where l.wallet_address = $1
   and l.linked_at <= $2
   and (l.detached_at is null or l.detached_at > $2)
 order by l.linked_at desc, l.id desc
 limit 1`;

export async function resolveTraderProfile(
  db: Queryable,
  wallet: string,
  at: Date,
): Promise<DbcFeeProfile> {
  const { rows } = await db.query(LINK_SQL, [wallet, at]);
  return profileFromLink(rows[0] || null);
}

export function rewardEventRow(input: {
  slices: DbcFeeSlices;
  wallet: string;
  campaign: string;
  signature: string;
  logIndex: number;
  slot: number;
  occurredAt: Date;
}) {
  return {
    chainId: SOLANA_CHAIN_ID,
    txHash: input.signature,
    logIndex: input.logIndex,
    blockNumber: input.slot,
    occurredAt: input.occurredAt,
    walletAddress: input.wallet,
    campaignAddress: input.campaign,
    routeKind: "trade" as const,
    routeProfile: input.slices.profile,
    leagueAmount: (input.slices.leagueWeekly + input.slices.leagueMonthly).toString(),
    recruiterAmount: input.slices.recruiter.toString(),
    airdropAmount: input.slices.airdrop.toString(),
    squadAmount: input.slices.squad.toString(),
    protocolAmount: input.slices.protocol.toString(),
    rawAmount: input.slices.feeTotal.toString(),
    sourceContract: DBC_PROGRAM_ID,
    sourceEvent: "EvtSwap2",
    matchedActivitySource: "dbc_collector",
    metadata: {
      weeklyLeagueLamports: input.slices.leagueWeekly.toString(),
      monthlyLeagueLamports: input.slices.leagueMonthly.toString(),
      tradingFee: input.slices.tradingFee.toString(),
      protocolFee: input.slices.protocolFee.toString(),
      referralFee: input.slices.referralFee.toString(),
      collectorAmount: input.slices.collectorAmount.toString(),
      creatorPool: input.slices.creatorPool.toString(),
      mode: input.slices.mode,
    },
  };
}

function bigintMeta(meta: Record<string, unknown>, ...keys: string[]): bigint {
  for (const key of keys) {
    const value = meta[key];
    if (value == null || value === "") continue;
    return BigInt(String(value));
  }
  return 0n;
}

let referralColumnReady = false;

/** referral_ours (db/migrations/20261007_000010_dbc_referral_ours.sql), added here too so a deploy before the migration still writes. */
async function ensureReferralOursColumn(db: Queryable) {
  if (referralColumnReady) return;
  await db.query(`alter table public.dbc_fee_accruals add column if not exists referral_ours boolean`);
  referralColumnReady = true;
}

export async function accrueDbcFees(db: Queryable, opts: { limit?: number } = {}): Promise<{ scanned: number; accrued: number; skipped: number; missingActivity: number }> {
  const limit = Math.max(1, Math.min(5_000, opts.limit ?? 500));
  await ensureReferralOursColumn(db);
  const missing = await db.query(
    `select count(*)::int as n
       from public.curve_trades t
       left join public.activity_events a
         on a.chain_id = t.chain_id and a.tx_hash = t.tx_hash and a.log_index = t.log_index
       left join public.dbc_fee_accruals f
         on f.tx_hash = t.tx_hash and f.log_index = t.log_index
      where t.chain_id = $1
        and t.venue = 'dbc'
        and f.tx_hash is null
        and a.tx_hash is null`,
    [SOLANA_CHAIN_ID],
  );
  const missingActivity = Number(missing.rows[0]?.n || 0);
  if (missingActivity > 0) {
    console.warn("[dbc-fee] DBC trades waiting on activity_events", { missingActivity });
  }
  const found = await db.query(
    `select t.campaign_address, t.tx_hash, t.log_index, t.wallet, t.block_number, t.block_time,
            a.meta as activity_meta, c.meta as campaign_meta
       from public.curve_trades t
       join public.activity_events a
         on a.chain_id = t.chain_id and a.tx_hash = t.tx_hash and a.log_index = t.log_index
       left join public.campaigns c
         on c.chain_id = t.chain_id and c.campaign_address = t.campaign_address
       left join public.dbc_fee_accruals f
         on f.tx_hash = t.tx_hash and f.log_index = t.log_index
      where t.chain_id = $1
        and t.venue = 'dbc'
        and f.tx_hash is null
      order by t.block_number asc, t.log_index asc
      limit $2`,
    [SOLANA_CHAIN_ID, limit],
  );
  let accrued = 0;
  let skipped = 0;
  for (const row of found.rows) {
    const rawMeta = row.activity_meta;
    const meta = typeof rawMeta === "string"
      ? JSON.parse(rawMeta)
      : (rawMeta && typeof rawMeta === "object" ? rawMeta : {});
    const tradingFee = bigintMeta(meta, "trading_fee", "tradingFee");
    const protocolFee = bigintMeta(meta, "protocol_fee", "protocolFee");
    const referralFee = bigintMeta(meta, "referral_fee", "referralFee");
    // Whether that referral fee reached our account (dbcIndexer referralPaidToUs); null = unknown.
    const rawOurs = meta?.referral_ours ?? meta?.referralOurs;
    const referralOurs = referralFee <= 0n ? false : typeof rawOurs === "boolean" ? rawOurs : null;
    if (tradingFee + protocolFee + referralFee <= 0n) {
      skipped += 1;
      console.warn("[dbc-fee] activity row has no EvtSwap2 fees; not accruing", {
        tx: String(row.tx_hash),
        logIndex: Number(row.log_index),
      });
      continue;
    }
    const campaignMeta = row.campaign_meta && typeof row.campaign_meta === "object" ? row.campaign_meta : {};
    const feeChoice = campaignMeta?.dbc?.feeChoice || campaignMeta?.dbc?.fee_choice || "keep";
    const mode: DbcCreatorFeeMode = creatorFeeModeFromChoice(String(feeChoice));
    const at = row.block_time instanceof Date ? row.block_time : new Date(row.block_time);
    const profile = await resolveTraderProfile(db, String(row.wallet), at);
    const slices = splitDbcCollectorFee({ tradingFee, protocolFee, referralFee, mode, profile });
    const epoch = await ensureWeeklyEpoch(SOLANA_CHAIN_ID, at, db as any);
    const event = rewardEventRow({
      slices,
      wallet: String(row.wallet),
      campaign: String(row.campaign_address),
      signature: String(row.tx_hash),
      logIndex: Number(row.log_index),
      slot: Number(row.block_number),
      occurredAt: at,
    });
    await db.query(
      `insert into public.dbc_fee_accruals(
         pool, tx_hash, log_index, trader, profile, fee_total,
         trading_fee, protocol_fee, referral_fee, collector_amount,
         league_weekly, league_monthly, recruiter, squad, airdrop, protocol, creator_pool, status,
         referral_ours
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'accrued',$18)
       on conflict (tx_hash, log_index) do nothing`,
      [
        String(row.campaign_address),
        String(row.tx_hash),
        Number(row.log_index),
        String(row.wallet),
        slices.profile,
        slices.feeTotal.toString(),
        slices.tradingFee.toString(),
        slices.protocolFee.toString(),
        slices.referralFee.toString(),
        slices.collectorAmount.toString(),
        slices.leagueWeekly.toString(),
        slices.leagueMonthly.toString(),
        slices.recruiter.toString(),
        slices.squad.toString(),
        slices.airdrop.toString(),
        slices.protocol.toString(),
        slices.creatorPool.toString(),
        referralOurs,
      ],
    );
    await db.query(
      `insert into public.reward_events(
         chain_id, tx_hash, log_index, block_number, occurred_at, epoch_id,
         wallet_address, campaign_address, route_kind, route_profile,
         league_amount, recruiter_amount, airdrop_amount, squad_amount, protocol_amount, raw_amount,
         source_contract, source_event, matched_activity_source, metadata, created_at, updated_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,now(),now())
       on conflict (chain_id, tx_hash, log_index) do update set
         wallet_address = excluded.wallet_address,
         campaign_address = excluded.campaign_address,
         route_kind = excluded.route_kind,
         route_profile = excluded.route_profile,
         league_amount = excluded.league_amount,
         recruiter_amount = excluded.recruiter_amount,
         airdrop_amount = excluded.airdrop_amount,
         squad_amount = excluded.squad_amount,
         protocol_amount = excluded.protocol_amount,
         raw_amount = excluded.raw_amount,
         source_event = excluded.source_event,
         metadata = excluded.metadata,
         updated_at = now()
       where public.reward_events.matched_activity_source = 'dbc_collector'`,
      [
        event.chainId,
        event.txHash,
        event.logIndex,
        event.blockNumber,
        event.occurredAt,
        epoch.id,
        event.walletAddress,
        event.campaignAddress,
        event.routeKind,
        event.routeProfile,
        event.leagueAmount,
        event.recruiterAmount,
        event.airdropAmount,
        event.squadAmount,
        event.protocolAmount,
        event.rawAmount,
        event.sourceContract,
        event.sourceEvent,
        event.matchedActivitySource,
        JSON.stringify(event.metadata),
      ],
    );
    accrued += 1;
  }
  return { scanned: found.rows.length, accrued, skipped, missingActivity };
}
