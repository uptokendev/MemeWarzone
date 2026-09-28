/**
 * DBC graduation (kind 1) split and D7 compensation. Trade fees use dbcFeeSplit
 * (kind 0, league 37.5%). Finalize has no league: linked 15/2.5, OG 17.5/2.5,
 * unlinked airdrop 17.5, protocol the rest — preview_bnb_route when kind != trade.
 */
import type { DbcFeeProfile } from "./dbcFeeSplit.js";
import { DBC_FEE_BPS, bpsFloor } from "./dbcFeeSplit.js";
import type { RouteTotals } from "./dbcFeeRouter.js";

export const DBC_FINALIZE_LINKED_RECRUITER_BPS = 1_500n;
export const DBC_FINALIZE_LINKED_SQUAD_BPS = 250n;
export const DBC_FINALIZE_OG_RECRUITER_BPS = 1_750n;
export const DBC_FINALIZE_OG_SQUAD_BPS = 250n;
export const DBC_FINALIZE_UNLINKED_AIRDROP_BPS = 1_750n;

export type DbcFinalizeSlices = {
  remaining: bigint;
  recruiter: bigint;
  squad: bigint;
  airdrop: bigint;
  protocol: bigint;
  profile: DbcFeeProfile;
};

export function finalizeProfileBps(profile: DbcFeeProfile): {
  recruiter: bigint;
  squad: bigint;
  airdrop: bigint;
} {
  if (profile === "og_linked") {
    return { recruiter: DBC_FINALIZE_OG_RECRUITER_BPS, squad: DBC_FINALIZE_OG_SQUAD_BPS, airdrop: 0n };
  }
  if (profile === "standard_linked") {
    return { recruiter: DBC_FINALIZE_LINKED_RECRUITER_BPS, squad: DBC_FINALIZE_LINKED_SQUAD_BPS, airdrop: 0n };
  }
  return { recruiter: 0n, squad: 0n, airdrop: DBC_FINALIZE_UNLINKED_AIRDROP_BPS };
}

export function splitDbcFinalizeFee(remaining: bigint, profile: DbcFeeProfile): DbcFinalizeSlices {
  const amount = BigInt(remaining);
  if (amount < 0n) throw new Error("DBC finalize remaining is negative");
  const bps = finalizeProfileBps(profile);
  const recruiter = bpsFloor(amount, bps.recruiter);
  const squad = bpsFloor(amount, bps.squad);
  const airdrop = bpsFloor(amount, bps.airdrop);
  const used = recruiter + squad + airdrop;
  if (used > amount) {
    throw new Error(`DBC finalize slices exceed remaining: used ${used.toString()} remaining ${amount.toString()}`);
  }
  return { remaining: amount, recruiter, squad, airdrop, protocol: amount - used, profile };
}

export function finalizeSlicesConserve(slices: DbcFinalizeSlices): boolean {
  return slices.recruiter + slices.squad + slices.airdrop + slices.protocol === slices.remaining;
}

export function finalizeRouteTotals(slices: DbcFinalizeSlices): RouteTotals {
  return {
    leagueWeekly: 0n,
    leagueMonthly: 0n,
    recruiter: slices.recruiter,
    squad: slices.squad,
    airdrop: slices.airdrop,
    protocol: slices.protocol,
    creatorPool: 0n,
    routed: slices.remaining,
  };
}

export type CompensationInput = {
  protocolMigrationQuoteFeeAmount: bigint;
  protocolMigrationBaseFeeAmount: bigint;
  dammQuoteVault: bigint;
  dammBaseVault: bigint;
};

export type CompensationDue = {
  quoteCut: bigint;
  baseCut: bigint;
  baseAsSol: bigint;
  due: bigint;
};

/**
 * D7: quote cut plus the base cut valued at the migration price (pool quote/base
 * including the 0.2% that was taken). Floor division; never silent-zero.
 */
export function compensationDue(input: CompensationInput): CompensationDue {
  const quoteCut = BigInt(input.protocolMigrationQuoteFeeAmount);
  const baseCut = BigInt(input.protocolMigrationBaseFeeAmount);
  const quoteIncl = BigInt(input.dammQuoteVault) + quoteCut;
  const baseIncl = BigInt(input.dammBaseVault) + baseCut;
  const baseAsSol = baseIncl === 0n ? 0n : (baseCut * quoteIncl) / baseIncl;
  return { quoteCut, baseCut, baseAsSol, due: quoteCut + baseAsSol };
}

export type CompensationPay = {
  paid: bigint;
  shortfall: bigint;
  remaining: bigint;
};

export function payCompensation(due: bigint, pot: bigint): CompensationPay {
  const want = BigInt(due);
  const have = BigInt(pot);
  if (have < 0n) throw new Error("compensation pot is negative");
  const paid = want < have ? want : have;
  return { paid, shortfall: want - paid, remaining: have - paid };
}

/**
 * D7 from the protocol slice (2026-09-28): split the whole partner fee with
 * finalize bps first, then pay compensation from protocol. Recruiter / squad /
 * airdrop stay as without compensation. Shortfall is recorded when protocol
 * cannot cover the due amount.
 */
export function finalizeAfterCompensation(
  partnerFee: bigint,
  profile: DbcFeeProfile,
  due: bigint,
): { slices: DbcFinalizeSlices; paid: bigint; shortfall: bigint; remainingProtocol: bigint } {
  const slices = splitDbcFinalizeFee(partnerFee, profile);
  const pay = payCompensation(due, slices.protocol);
  return {
    slices: {
      ...slices,
      remaining: slices.remaining - pay.paid,
      protocol: slices.protocol - pay.paid,
    },
    paid: pay.paid,
    shortfall: pay.shortfall,
    remainingProtocol: pay.remaining,
  };
}

export function expectedMigrationFee(threshold: bigint, feePct = 22n): bigint {
  const intoPool = (BigInt(threshold) * (100n - feePct) + 99n) / 100n;
  return BigInt(threshold) - intoPool;
}

export function expectedPartnerMigrationFee(threshold: bigint, feePct = 22n, creatorPct = 90n): bigint {
  const fee = expectedMigrationFee(threshold, feePct);
  const creator = (fee * creatorPct) / 100n;
  return fee - creator;
}

/** D19: platform LP fees — 80% creator_pool, remainder to protocol. Keep coins send 100% to protocol. */
export function splitPlatformLpFees(claimed: bigint): { creatorPool: bigint; protocol: bigint } {
  const amount = BigInt(claimed);
  if (amount < 0n) throw new Error("LP claim is negative");
  const creatorPool = (amount * 80n) / 100n;
  return { creatorPool, protocol: amount - creatorPool };
}

export function isPlatformFeeChoice(feeChoice: string | null | undefined): boolean {
  const choice = String(feeChoice || "keep").trim().toLowerCase();
  return choice === "holders" || choice === "split" || choice === "buyback";
}
