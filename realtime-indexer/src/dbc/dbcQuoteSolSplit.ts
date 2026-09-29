/**
 * D21: after a quote-token claim, swap to SOL and split the SOL actually
 * received in the same proportions as the quote slices. Remainder to protocol.
 */
export const DBC_QUOTE_SWAP_MAX_IMPACT_BPS_DEFAULT = 100n;

export function quoteSwapMaxImpactBps(env = process.env): bigint {
  const raw = String(env.DBC_QUOTE_SWAP_MAX_IMPACT_BPS || "").trim();
  if (!raw) return DBC_QUOTE_SWAP_MAX_IMPACT_BPS_DEFAULT;
  try {
    const value = BigInt(raw);
    return value < 0n ? DBC_QUOTE_SWAP_MAX_IMPACT_BPS_DEFAULT : value;
  } catch {
    return DBC_QUOTE_SWAP_MAX_IMPACT_BPS_DEFAULT;
  }
}

export type QuoteSlices = {
  leagueWeekly: bigint;
  leagueMonthly: bigint;
  recruiter: bigint;
  squad: bigint;
  airdrop: bigint;
  protocol: bigint;
  creatorPool: bigint;
};

export function quoteRoutedTotal(slices: QuoteSlices): bigint {
  return slices.leagueWeekly + slices.leagueMonthly + slices.recruiter + slices.squad + slices.airdrop + slices.protocol;
}

function floorShare(total: bigint, part: bigint, sol: bigint): bigint {
  if (total <= 0n || part <= 0n || sol <= 0n) return 0n;
  return (sol * part) / total;
}

/**
 * Split `solReceived` across the routed quote slices. creatorPool stays on the
 * collector in quote tokens (step 5b) and is not swapped. Remainder to protocol.
 */
export function splitSolFromQuoteSwap(slices: QuoteSlices, solReceived: bigint): QuoteSlices {
  const sol = BigInt(solReceived);
  if (sol < 0n) throw new Error("SOL received is negative");
  const routed = quoteRoutedTotal(slices);
  const leagueWeekly = floorShare(routed, slices.leagueWeekly, sol);
  const leagueMonthly = floorShare(routed, slices.leagueMonthly, sol);
  const recruiter = floorShare(routed, slices.recruiter, sol);
  const squad = floorShare(routed, slices.squad, sol);
  const airdrop = floorShare(routed, slices.airdrop, sol);
  const protocolShare = floorShare(routed, slices.protocol, sol);
  const used = leagueWeekly + leagueMonthly + recruiter + squad + airdrop + protocolShare;
  const protocol = protocolShare + (sol - used);
  return {
    leagueWeekly,
    leagueMonthly,
    recruiter,
    squad,
    airdrop,
    protocol,
    creatorPool: 0n,
  };
}

export function swapImpactRefused(impactBps: bigint, maxBps = DBC_QUOTE_SWAP_MAX_IMPACT_BPS_DEFAULT): boolean {
  return BigInt(impactBps) > BigInt(maxBps);
}
