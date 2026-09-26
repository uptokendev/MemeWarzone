/** Pure mapping of a Solana FeeSlices event to a reward_events row (no DB); see solanaRewardEvents.ts. */
import type { FeeSlicesAccruedEvent, FeeSlicesRoutedEvent } from "../solanaAnchorEvents.js";
import type { RewardRouteProfile } from "./ingest.js";

export const SOLANA_REWARD_CHAIN_ID = 101;

/** Program route profile ids (programs/memewarzone_solana/src/lib.rs): 0 linked, 1 unlinked, 2 OG. */
export function solanaRouteProfileName(id: number): RewardRouteProfile {
  if (id === 0) return "standard_linked";
  if (id === 2) return "og_linked";
  if (id === 1) return "standard_unlinked";
  throw new Error(`Unknown Solana route profile ${id}`);
}

/** Program trade sides (authorized_trade.rs): 1 buy, 2 sell, 3 graduation (finalize). */
export const TRADE_SIDE_FINALIZE = 3;

export function solanaRewardEventRow(event: FeeSlicesAccruedEvent | FeeSlicesRoutedEvent) {
  // The side decides, not the event name: the launchpad before the fee escrow (Aug 2026) emitted
  // FeeSlicesRouted for ordinary buys and sells, which belong to the trader's recruiter.
  const finalize = event.side === TRADE_SIDE_FINALIZE;
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

