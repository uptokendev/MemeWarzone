import { resolveCurrentSolanaAuthority } from "../../shared/solanaCurrentAuthority.mjs";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export const GRADUATION_WAD = 10n ** 18n;
export const DEFAULT_GRADUATION_TARGET_WEI = 30_000n * GRADUATION_WAD;
export const TEST_GRADUATION_TARGET_WEI = 6n * GRADUATION_WAD;

export type GraduationTier = {
  id: "fast" | "normal" | "deep" | "test";
  label: string;
  title: string;
  description: string;
  targetWei: bigint;
  testOnly?: boolean;
};

export type GraduationRuntimeIdentity = {
  environment?: string | null;
  cluster?: string | null;
  solanaCluster?: string | null;
};

export const STANDARD_GRADUATION_TIERS: readonly GraduationTier[] = [
  {
    id: "fast",
    label: "$15K",
    title: "Fast grad",
    description: "Shorter bonding phase for a faster route into DEX liquidity.",
    targetWei: 15_000n * GRADUATION_WAD,
  },
  {
    id: "normal",
    label: "$30K",
    title: "Normal bond",
    description: "Balanced default with room for discovery, activity, and community growth.",
    targetWei: DEFAULT_GRADUATION_TARGET_WEI,
  },
  {
    id: "deep",
    label: "$50K",
    title: "Deep liquidity",
    description: "Longer bonding phase designed to seed stronger DEX liquidity.",
    targetWei: 50_000n * GRADUATION_WAD,
  },
] as const;

export const TEST_GRADUATION_TIER: GraduationTier = {
  id: "test",
  label: "$6",
  title: "Test grad",
  description:
    "Dev/test only (BNB testnet + Solana devnet). Rehearse graduation, LP lock, DEX trading, and fees without a $15k bond.",
  targetWei: TEST_GRADUATION_TARGET_WEI,
  testOnly: true,
};

function runtimeSolanaIdentity(identity?: GraduationRuntimeIdentity): GraduationRuntimeIdentity {
  if (identity) return identity;
  return {
    environment: import.meta.env.VITE_RUNTIME_ENVIRONMENT,
    cluster: import.meta.env.VITE_SOLANA_CLUSTER,
  };
}

/**
 * Current $6 eligibility is a safety policy, not a product-chain shortcut.
 * BNB testnet 97 remains eligible. Solana is eligible only as canonical chain
 * 101 with staging + devnet. Legacy chain 102 can never activate the policy.
 */
export function isTestGraduationChain(chainId: number, identity?: GraduationRuntimeIdentity): boolean {
  const id = Number(chainId);
  if (id === 97) return true;
  if (id !== 101) return false;
  const runtime = runtimeSolanaIdentity(identity);
  return resolveCurrentSolanaAuthority({
    chainId: id,
    environment: runtime.environment,
    cluster: runtime.solanaCluster ?? runtime.cluster,
  })?.environment === "staging";
}

export function isTestGraduationTierEnabled(chainId: number, identity?: GraduationRuntimeIdentity): boolean {
  if (!isTestGraduationChain(chainId, identity)) return false;
  const raw = String(import.meta.env.VITE_ENABLE_TEST_GRADUATION_THRESHOLD ?? "").trim().toLowerCase();
  // Default ON only after the chain/environment safety gate above succeeds.
  if (!raw) return true;
  return TRUE_VALUES.has(raw);
}

/** Solana V4 create uses USD micros (1 USD = 1_000_000). BNB UI stores wei-scale USD wad. */
export function graduationTargetToUsdMicros(targetWei: bigint | string | number): string {
  try {
    const raw = typeof targetWei === "bigint" ? targetWei : BigInt(String(targetWei || "0"));
    if (raw <= 0n) return "6000000";
    // Already micros (e.g. 6_000_000 for $6).
    if (raw < 1_000_000_000_000n) return raw.toString();
    // Wei-scale USD wad: dollars * 10^18 -> micros = dollars * 10^6.
    const dollars = raw / GRADUATION_WAD;
    if (dollars <= 0n) return "6000000";
    return (dollars * 1_000_000n).toString();
  } catch {
    return "6000000";
  }
}

export function getGraduationTiers(chainId: number, identity?: GraduationRuntimeIdentity): GraduationTier[] {
  const withTest = isTestGraduationTierEnabled(chainId, identity);
  // Current Solana devnet allows the $6 rehearsal tier. Production 101/mainnet-beta,
  // missing identity, and legacy 102 all receive standard production tiers only.
  if (Number(chainId) === 101 && withTest) {
    return [TEST_GRADUATION_TIER, ...STANDARD_GRADUATION_TIERS];
  }
  return withTest ? [...STANDARD_GRADUATION_TIERS, TEST_GRADUATION_TIER] : [...STANDARD_GRADUATION_TIERS];
}

/** Default selected target: $6 on an explicitly eligible test authority, else $30K. */
export function getDefaultGraduationTargetWei(chainId: number, identity?: GraduationRuntimeIdentity): bigint {
  if (isTestGraduationTierEnabled(chainId, identity) && (Number(chainId) === 101 || Number(chainId) === 97)) {
    return TEST_GRADUATION_TARGET_WEI;
  }
  return DEFAULT_GRADUATION_TARGET_WEI;
}

export function isSupportedGraduationTarget(
  chainId: number,
  targetWei: bigint,
  identity?: GraduationRuntimeIdentity,
): boolean {
  return getGraduationTiers(chainId, identity).some((tier) => tier.targetWei === targetWei);
}

export function graduationTierLabel(targetWei: bigint): string {
  return [...STANDARD_GRADUATION_TIERS, TEST_GRADUATION_TIER].find((tier) => tier.targetWei === targetWei)?.label || "$30K";
}
