export const MWL_SUPPORTED_CHAIN_IDS = Object.freeze([56, 97, 101, 4663, 46630]);

const CHAINS = Object.freeze({
  56: { family: "bnb", environment: "production", nativeSymbol: "BNB" },
  97: { family: "bnb", environment: "staging", nativeSymbol: "tBNB" },
  101: { family: "solana", environment: "cluster", nativeSymbol: "SOL" },
  4663: { family: "robinhood", environment: "production", nativeSymbol: "ETH" },
  46630: { family: "robinhood", environment: "staging", nativeSymbol: "ETH" },
});

export class MwlIdentityError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "MwlIdentityError";
    this.code = code;
    this.status = status;
  }
}

export function requiredMwlChainId(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    throw new MwlIdentityError("MWL_CHAIN_REQUIRED", "Major War League chainId is required");
  }
  const chainId = Number(value);
  if (!Number.isSafeInteger(chainId) || !MWL_SUPPORTED_CHAIN_IDS.includes(chainId)) {
    throw new MwlIdentityError("MWL_CHAIN_UNSUPPORTED", "Unsupported Major War League chainId");
  }
  return chainId;
}

export function mwlChainIdentity(value) {
  const chainId = requiredMwlChainId(value);
  return { chainId, ...CHAINS[chainId] };
}

export function canonicalMwlMonth({ chainId, year, month } = {}) {
  const id = requiredMwlChainId(chainId);
  const y = Number(year);
  const m = Number(month);
  if (!Number.isInteger(y) || y < 2000 || y > 9999 || !Number.isInteger(m) || m < 1 || m > 12) {
    throw new MwlIdentityError("MWL_MONTH_INVALID", "Invalid Major War League monthly period");
  }
  const month2 = String(m).padStart(2, "0");
  return {
    chainId: id,
    year: y,
    month: m,
    monthId: `${y}${month2}`,
    seasonId: `mwl-${y}-m${month2}-c${id}`,
    epochStart: new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0)).toISOString(),
  };
}

export function currentMwlMonth(chainId, now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) throw new MwlIdentityError("MWL_TIME_INVALID", "Invalid Major War League clock");
  return canonicalMwlMonth({ chainId, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 });
}

export function mwlSeasonIdentityMatches(row, expected = {}) {
  if (!row) return false;
  const period = canonicalMwlMonth({ chainId: expected.chainId, year: expected.year, month: expected.month });
  return Number(row.chain_id) === period.chainId
    && Number(row.year) === period.year
    && Number(row.month) === period.month
    && String(row.id || "") === period.seasonId
    && String(row.mwl_epoch_key || row.id || "") === period.seasonId;
}

export function assertMwlSeasonIdentity(row, expected = {}) {
  if (!mwlSeasonIdentityMatches(row, expected)) {
    throw new MwlIdentityError("MWL_SEASON_CHAIN_MISMATCH", "Major War League season identity does not match chain/month", 409);
  }
  return row;
}

// Where each chain's Major War League money actually sits, read from chain 2026-10-02:
// Solana = the treasury program's mwl_vault PDA (the arena MWL receiver since 2026-09-26);
// BNB / Robinhood = PostGradLeagueTreasuryV2, the contract ArenaWarPoolTreasuryV2.claimLeague pays
// (`postGradLeagueTreasury()` on each war pool). Testnets have no default and need the env.
export const MWL_TREASURY_MAINNET_DEFAULTS = Object.freeze({
  56: "0xD9E381408A4e361C66D8b1e657583bdE6c52402d",
  101: "PCDQmFBrYTV2kfdGtiGWJ2Au9TfaR5ZzBkXdtymV1Bd",
  4663: "0x5D5CC19B5BE86BA28b8164f85883F17843B69810",
});

// Only MWL_TREASURY_ADDRESS_<id>. MONTHLY_LEAGUE_TREASURY_ADDRESS_<id> used to come first, but that
// name belongs to the pre-grad MonthlyLeagueTreasury (league.js, leagueRoot.js, claims): setting it
// would have bound the MWL to the pre-grad monthly pot.
export function mwlTreasuryEnvKeys(chainId) {
  const id = requiredMwlChainId(chainId);
  return Object.freeze([`MWL_TREASURY_ADDRESS_${id}`]);
}

export function resolveMwlTreasuryAssociation(chainId, env = process.env) {
  const identity = mwlChainIdentity(chainId);
  const keys = mwlTreasuryEnvKeys(chainId);
  const matchedKey = keys.find((key) => String(env?.[key] || "").trim()) || null;
  const fallback = MWL_TREASURY_MAINNET_DEFAULTS[identity.chainId] || null;
  const treasuryId = matchedKey ? String(env[matchedKey]).trim() : fallback;
  return {
    ...identity,
    treasuryId,
    configured: Boolean(treasuryId),
    configKey: matchedKey || (fallback ? `default:${identity.chainId}` : null),
    reserveShareBps: 6000,
  };
}

export function mwlEntitlementIdentity({ chainId, seasonId, monthId, recipient, amountRaw, version } = {}) {
  const id = requiredMwlChainId(chainId);
  const season = String(seasonId || "").trim();
  const month = String(monthId || "").trim();
  const wallet = String(recipient || "").trim();
  const amount = String(amountRaw ?? "").trim();
  const v = String(version || "").trim();
  if (!season || !/^\d{6}$/.test(month) || !wallet || !/^\d+$/.test(amount) || !v) {
    throw new MwlIdentityError("MWL_ENTITLEMENT_IDENTITY_INVALID", "Incomplete Major War League entitlement identity");
  }
  return `${id}:${season}:${month}:${wallet}:${amount}:${v}`;
}
