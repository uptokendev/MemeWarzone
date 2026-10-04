// The one place that says which MonthlyLeagueTreasury pays the BNB / Robinhood monthly league.
// Root publishing (scripts/publish-evm-league-roots.mjs, api/leagueRoot.js), the claim card
// (api/monthlyLeagueTreasury.js, api/league.js) and claim verification (lib/evmLeagueClaimVerification.js)
// all resolve the address here, so they cannot drift apart again.
//
// Why (2026-10-04): the original vaults (BNB 0xF62A09de..., Robinhood 0xE72A281b...) were deployed with
// monthlyCapUsd = 30000 raw (a few wei per month) and replaced on 2026-09-27. The fee routers were
// re-pointed to the replacements (M1 propose + M2 accept), the old BNB vault's balance was moved over in
// M1, but the payout code kept the old addresses: a root sealed there could never pay, and a claim
// built for it targeted a vault holding 0.
//
// Fail closed: a missing, malformed, superseded or non-canonical address throws. Nothing here ever
// falls back to a superseded vault, and there is no unscoped env fallback on mainnet (an unscoped
// address cannot say which chain it belongs to).

import { Contract, getAddress, isAddress } from "ethers";

/**
 * Current monthly treasury per mainnet chain.
 *   56:   deployments/bnb/mainnet.monthly-league-treasury-v2.json (deployTx 0x11f079ca...),
 *         activated on router V3 by deployments/bnb/mainnet.M2-monthly-league-accept.safe-batch.json
 *   4663: deployments/robinhood/mainnet.monthly-league-treasury-v2.json (deployTx 0xc0c350a4...),
 *         activated on router V3 by deployments/robinhood/mainnet.M2-monthly-league-accept.safe-batch.json
 * Read back 2026-10-04: router V3 and router V4 monthlyLeagueTreasury() on both chains return these.
 */
export const MONTHLY_LEAGUE_TREASURY_MAINNET = Object.freeze({
  56: "0x42D254A7451808Bb01df879d71BcAfDC5D605A38",
  4663: "0x576c1d6Ba6975020702Aa13dE0899D8CD92ECD1A",
});

/**
 * Superseded monthly treasuries (the `replaces` field of the records above). Never a target for a new
 * seal or a new claim. They are only consulted to find a month that was already sealed on them; as of
 * 2026-10-04 none was (monthSeal false for every month, totalOutstandingClaims 0, balance 0 on both).
 */
export const SUPERSEDED_MONTHLY_LEAGUE_TREASURIES = Object.freeze({
  56: Object.freeze(["0xF62A09dea232bc8311D13bAEa89d79F48Cf7eCB8"]),
  4663: Object.freeze(["0xE72A281b4A728AFb5fa836f593B56C8f74Fd4238"]),
});

/**
 * Fee routers that send the monthly league slice today and must point at the current treasury before a
 * root is sealed (TreasuryRouterV4 gen-6, then TreasuryRouterV3). Same addresses as
 * lib/financeFeeRoutingEvm.js; records: deployments/<chain>/mainnet.evmgen-fees.json and
 * mainnet.treasury-router-v3.json. The BNB TreasuryRouterV2 0xe157a6FD... still points at the
 * superseded vault and is deliberately not listed: it is not the source of truth for the payout vault.
 */
export const MONTHLY_LEAGUE_FEE_ROUTERS_MAINNET = Object.freeze({
  56: Object.freeze(["0x8C8141B84cDb4634829cF1936f1e8cc14C61CEaa", "0xe635AA43fE5707561c8c3C655225da5C3e4C2239"]),
  4663: Object.freeze(["0x49Ae38B19664d90b410AE860B9604e1Bc5f7Ab5d", "0xda0a9Ed9e68D2B468257aBD66465fdD94F4338bb"]),
});

const MONTH_SEAL_ABI = [
  "function monthSeal(uint256) view returns (bool isSealed, bytes32 winnersRoot, uint256 oraclePrice, uint256 capUsd, uint256 capNative, uint256 playerPool, uint256 winnerTotal, uint256 overflow, uint256 sealedAt)",
];
const ROUTER_ABI = ["function monthlyLeagueTreasury() view returns (address)"];

export class MonthlyLeagueTreasuryConfigError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.name = "MonthlyLeagueTreasuryConfigError";
    this.code = code;
    this.status = status;
  }
}

function sameAddress(left, right) {
  return String(left || "").toLowerCase() === String(right || "").toLowerCase();
}

export function isSupersededMonthlyLeagueTreasury(chainId, address) {
  return (SUPERSEDED_MONTHLY_LEAGUE_TREASURIES[Number(chainId)] || []).some((old) => sameAddress(old, address));
}

/**
 * The current MonthlyLeagueTreasury for a chain (checksummed). Mainnet: the canonical constant; the
 * optional MONTHLY_LEAGUE_TREASURY_ADDRESS_<id> env must equal it. Testnets: that env, required
 * (chain 97 also accepts the unscoped MONTHLY_LEAGUE_TREASURY_ADDRESS, as the other BNB vault envs do).
 */
export function monthlyLeagueTreasuryAddress(chainId, env = process.env) {
  const chain = Number(chainId);
  const scoped = String(env[`MONTHLY_LEAGUE_TREASURY_ADDRESS_${chain}`] || "").trim();
  const canonical = MONTHLY_LEAGUE_TREASURY_MAINNET[chain] || "";
  const configured = scoped || (!canonical && chain === 97 ? String(env.MONTHLY_LEAGUE_TREASURY_ADDRESS || "").trim() : "");

  if (configured) {
    if (!isAddress(configured)) {
      throw new MonthlyLeagueTreasuryConfigError("MONTHLY_TREASURY_MISCONFIGURED", `MONTHLY_LEAGUE_TREASURY_ADDRESS_${chain} is not an address.`, 500);
    }
    if (isSupersededMonthlyLeagueTreasury(chain, configured)) {
      throw new MonthlyLeagueTreasuryConfigError(
        "MONTHLY_TREASURY_SUPERSEDED",
        `MONTHLY_LEAGUE_TREASURY_ADDRESS_${chain} is the superseded vault ${getAddress(configured)}; the current one is ${canonical}. Remove the env or set it to the current vault.`,
        500,
      );
    }
    if (canonical && !sameAddress(configured, canonical)) {
      throw new MonthlyLeagueTreasuryConfigError(
        "MONTHLY_TREASURY_MISMATCH",
        `MONTHLY_LEAGUE_TREASURY_ADDRESS_${chain}=${getAddress(configured)} differs from the deployment record (${canonical}).`,
        500,
      );
    }
    return getAddress(configured);
  }
  if (canonical) return getAddress(canonical);
  throw new MonthlyLeagueTreasuryConfigError("MONTHLY_TREASURY_UNAVAILABLE", `No MonthlyLeagueTreasury configured for chain ${chain}.`, 503);
}

/**
 * The treasury that holds a given month: the superseded vault only if that month was sealed there (and
 * not on the current one), otherwise the current vault. Superseded vaults never had a month sealed as of
 * 2026-10-04, so in practice this returns the current vault; the lookup keeps an old seal claimable
 * where its money is instead of pointing it at a vault that never reserved it. RPC errors propagate.
 */
export async function monthlyLeagueTreasuryForMonth(provider, chainId, monthId, env = process.env) {
  const current = monthlyLeagueTreasuryAddress(chainId, env);
  const currentSeal = await new Contract(current, MONTH_SEAL_ABI, provider).monthSeal(monthId);
  if (currentSeal.isSealed) return current;
  for (const old of SUPERSEDED_MONTHLY_LEAGUE_TREASURIES[Number(chainId)] || []) {
    const seal = await new Contract(old, MONTH_SEAL_ABI, provider).monthSeal(monthId);
    if (seal.isSealed) return getAddress(old);
  }
  return current;
}

/**
 * Before a seal: every listed live fee router must send the monthly slice to `treasury`. A mismatch
 * means the deployment record and the chain disagree, and nothing is sealed until a human looks.
 * Returns the routers checked (empty on chains without a pinned list, i.e. testnets).
 */
export async function assertFeeRoutersFeedMonthlyTreasury(provider, chainId, treasury) {
  const routers = MONTHLY_LEAGUE_FEE_ROUTERS_MAINNET[Number(chainId)] || [];
  for (const router of routers) {
    const target = await new Contract(router, ROUTER_ABI, provider).monthlyLeagueTreasury();
    if (!sameAddress(target, treasury)) {
      throw new MonthlyLeagueTreasuryConfigError(
        "MONTHLY_TREASURY_ROUTER_MISMATCH",
        `fee router ${router} sends the monthly league slice to ${target}, not ${treasury}`,
        409,
      );
    }
  }
  return routers;
}
