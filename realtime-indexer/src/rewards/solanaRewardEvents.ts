/**
 * Solana fee slices -> public.reward_events, the same per-trade fee table the EVM router scan writes
 * (rewards/ingest.ts), so recruiter crediting, the recruiter league and the reward epochs read one
 * table on every chain (2026-09-26: nothing recorded Solana recruiter slices, so no recruiter was
 * ever credited).
 *
 * Amounts are the program's own FeeSlicesAccrued / FeeSlicesRouted slices -- exactly what reached
 * the recruiter / squad vaults -- never an estimate. raw_amount is the fee, like the EVM row's
 * amountIn. Trades carry the trader; graduation (finalize) carries none (the event's trader is the
 * graduation authority), and is credited to the campaign creator's recruiter, as on EVM.
 */
import type { FeeSlicesAccruedEvent, FeeSlicesRoutedEvent } from "../solanaAnchorEvents.js";
import { ensureWeeklyEpoch } from "./epochs.js";
import type { RewardRouteProfile } from "./ingest.js";

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export const SOLANA_REWARD_CHAIN_ID = 101;

/** Program route profile ids (programs/memewarzone_solana/src/lib.rs): 0 linked, 1 unlinked, 2 OG. */
export function solanaRouteProfileName(id: number): RewardRouteProfile {
  if (id === 0) return "standard_linked";
  if (id === 2) return "og_linked";
  if (id === 1) return "standard_unlinked";
  throw new Error(`Unknown Solana route profile ${id}`);
}

export function solanaRewardEventRow(event: FeeSlicesAccruedEvent | FeeSlicesRoutedEvent) {
  const finalize = event.kind === "FeeSlicesRouted";
  return {
    routeKind: finalize ? ("finalize" as const) : ("trade" as const),
    routeProfile: solanaRouteProfileName(event.routeProfile),
    walletAddress: finalize ? null : event.trader,
    campaignAddress: event.campaign,
    leagueAmount: (event.weekly + event.monthly).toString(),
    recruiterAmount: event.recruiter.toString(),
    airdropAmount: event.airdrop.toString(),
    squadAmount: event.squad.toString(),
    protocolAmount: event.protocol.toString(),
    rawAmount: event.feeLamports.toString(),
    sourceEvent: event.kind,
    metadata: {
      side: event.side,
      routeProfileId: event.routeProfile,
      creatorLamports: event.creator.toString(),
      weeklyLeagueLamports: event.weekly.toString(),
      monthlyLeagueLamports: event.monthly.toString(),
      eventTrader: event.trader,
      ...(finalize ? { grossLamports: (event as FeeSlicesRoutedEvent).grossLamports.toString() } : {}),
    },
  };
}

/** Idempotent on (chain_id, tx_hash, log_index); the signature keeps its exact base58 case. */
export async function recordSolanaRewardEvent(
  db: Queryable,
  event: FeeSlicesAccruedEvent | FeeSlicesRoutedEvent,
  input: { signature: string; logIndex: number; slot: number; blockTime: Date; sourceContract: string },
) {
  const row = solanaRewardEventRow(event);
  const epoch = await ensureWeeklyEpoch(SOLANA_REWARD_CHAIN_ID, input.blockTime, db as any);
  await db.query(
    `insert into public.reward_events(
       chain_id, tx_hash, log_index, block_number, occurred_at, epoch_id,
       wallet_address, campaign_address, route_kind, route_profile,
       league_amount, recruiter_amount, airdrop_amount, squad_amount, protocol_amount, raw_amount,
       source_contract, source_event, matched_activity_source, metadata, created_at, updated_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'solana_fee_slices',$19::jsonb,now(),now())
     on conflict (chain_id, tx_hash, log_index) do nothing`,
    [
      SOLANA_REWARD_CHAIN_ID,
      input.signature,
      input.logIndex,
      input.slot,
      input.blockTime,
      epoch.id,
      row.walletAddress,
      row.campaignAddress,
      row.routeKind,
      row.routeProfile,
      row.leagueAmount,
      row.recruiterAmount,
      row.airdropAmount,
      row.squadAmount,
      row.protocolAmount,
      row.rawAmount,
      input.sourceContract,
      row.sourceEvent,
      JSON.stringify(row.metadata),
    ],
  );
}
