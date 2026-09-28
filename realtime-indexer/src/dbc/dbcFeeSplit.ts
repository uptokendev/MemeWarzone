/**
 * DBC collector fee split (D4). Slices are shares of the whole trade fee F
 * (trading_fee + protocol_fee + referral_fee), the same bps as preview_bnb_route
 * kind 0. Protocol is the remainder of what the collector actually received.
 */

export const DBC_FEE_BPS = 10_000n;
export const DBC_LEAGUE_BPS = 3_750n;
export const DBC_WEEKLY_OF_LEAGUE_BPS = 3_000n;
export const DBC_CREATOR_CUT_PCT = 7n;

export type DbcFeeProfile = "standard_linked" | "standard_unlinked" | "og_linked";
export type DbcCreatorFeeMode = "creator" | "platform";

export type DbcFeeSliceInput = {
  tradingFee: bigint;
  protocolFee: bigint;
  referralFee: bigint;
  mode: DbcCreatorFeeMode;
  profile: DbcFeeProfile;
};

export type DbcFeeSlices = {
  feeTotal: bigint;
  tradingFee: bigint;
  protocolFee: bigint;
  referralFee: bigint;
  creatorCut: bigint;
  collectorAmount: bigint;
  creatorPool: bigint;
  leagueWeekly: bigint;
  leagueMonthly: bigint;
  recruiter: bigint;
  squad: bigint;
  airdrop: bigint;
  protocol: bigint;
  profile: DbcFeeProfile;
  mode: DbcCreatorFeeMode;
};

export function bpsFloor(amount: bigint, bps: bigint): bigint {
  return (amount * bps) / DBC_FEE_BPS;
}

export function profileBps(profile: DbcFeeProfile): { recruiter: bigint; squad: bigint; airdrop: bigint } {
  if (profile === "og_linked") return { recruiter: 1_500n, squad: 250n, airdrop: 0n };
  if (profile === "standard_linked") return { recruiter: 1_250n, squad: 250n, airdrop: 0n };
  return { recruiter: 0n, squad: 0n, airdrop: 1_500n };
}

export function splitDbcCollectorFee(input: DbcFeeSliceInput): DbcFeeSlices {
  const tradingFee = BigInt(input.tradingFee);
  const protocolFee = BigInt(input.protocolFee);
  const referralFee = BigInt(input.referralFee);
  const feeTotal = tradingFee + protocolFee + referralFee;
  const creatorCut = (tradingFee * DBC_CREATOR_CUT_PCT) / 100n;
  const collectorAmount = input.mode === "creator" ? tradingFee - creatorCut : tradingFee;
  const creatorPool = input.mode === "platform" ? creatorCut : 0n;
  const league = bpsFloor(feeTotal, DBC_LEAGUE_BPS);
  const leagueWeekly = bpsFloor(league, DBC_WEEKLY_OF_LEAGUE_BPS);
  const leagueMonthly = league - leagueWeekly;
  const bps = profileBps(input.profile);
  const recruiter = bpsFloor(feeTotal, bps.recruiter);
  const squad = bpsFloor(feeTotal, bps.squad);
  const airdrop = bpsFloor(feeTotal, bps.airdrop);
  const used = leagueWeekly + leagueMonthly + recruiter + squad + airdrop + creatorPool;
  if (used > collectorAmount) {
    throw new Error(
      `DBC fee slices exceed collector amount: used ${used.toString()} collector ${collectorAmount.toString()}`,
    );
  }
  const protocol = collectorAmount - used;
  if (protocol < 0n) throw new Error("DBC protocol slice is negative");
  return {
    feeTotal,
    tradingFee,
    protocolFee,
    referralFee,
    creatorCut,
    collectorAmount,
    creatorPool,
    leagueWeekly,
    leagueMonthly,
    recruiter,
    squad,
    airdrop,
    protocol,
    profile: input.profile,
    mode: input.mode,
  };
}

export function slicesConserve(slices: DbcFeeSlices): boolean {
  return (
    slices.leagueWeekly +
      slices.leagueMonthly +
      slices.recruiter +
      slices.squad +
      slices.airdrop +
      slices.protocol +
      slices.creatorPool ===
    slices.collectorAmount
  );
}

export function routedLamports(slices: DbcFeeSlices): bigint {
  return (
    slices.leagueWeekly +
    slices.leagueMonthly +
    slices.recruiter +
    slices.squad +
    slices.airdrop +
    slices.protocol
  );
}

export function creatorFeeModeFromChoice(feeChoice: string | null | undefined): DbcCreatorFeeMode {
  return String(feeChoice || "keep").trim().toLowerCase() === "keep" ? "creator" : "platform";
}

export function profileFromLink(row: { is_og?: unknown } | null): DbcFeeProfile {
  if (!row) return "standard_unlinked";
  return row.is_og ? "og_linked" : "standard_linked";
}
