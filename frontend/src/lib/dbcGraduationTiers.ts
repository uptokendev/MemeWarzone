import { GRADUATION_WAD, type GraduationTier } from "@/lib/graduationTiers";

/** DBC rehearsal target is $150 (the $6 launchpad test tier is not used). */
export const DBC_TEST_GRADUATION_TARGET_WEI = 150n * GRADUATION_WAD;

export const DBC_TEST_GRADUATION_TIER: GraduationTier = {
  id: "test",
  label: "$150",
  title: "Devnet rehearsal",
  description: "Devnet only: graduates at a $150 market cap.",
  targetWei: DBC_TEST_GRADUATION_TARGET_WEI,
  testOnly: true,
};

export function isDbcDevnetCluster(cluster?: string | null): boolean {
  const raw = String(cluster || import.meta.env.VITE_SOLANA_CLUSTER || "").trim().toLowerCase();
  return raw === "devnet" || raw === "solana-devnet";
}

/**
 * DBC targets are the graduation MARKET CAP (founder 2026-10-08): $30K fast, $50K normal. $15K is gone.
 * The values match DBC_TARGET_USD_MICROS (shared/dbcEconomics.mjs). BNB, Robinhood and the Solana
 * launchpad keep STANDARD_GRADUATION_TIERS.
 */
export const DBC_GRADUATION_TIERS: readonly GraduationTier[] = [
  {
    id: "fast",
    label: "$30K MC",
    title: "Fast grad",
    description: "Moves to a Meteora pool when the market cap reaches $30K.",
    targetWei: 30_000n * GRADUATION_WAD,
  },
  {
    id: "normal",
    label: "$50K MC",
    title: "Normal",
    description: "Moves to a Meteora pool when the market cap reaches $50K.",
    targetWei: 50_000n * GRADUATION_WAD,
  },
] as const;

/** The normal tier is preselected. */
export const DBC_DEFAULT_GRADUATION_TARGET_WEI = 50_000n * GRADUATION_WAD;

export function getDbcGraduationTiers(cluster?: string | null): GraduationTier[] {
  if (isDbcDevnetCluster(cluster)) return [DBC_TEST_GRADUATION_TIER, ...DBC_GRADUATION_TIERS];
  return [...DBC_GRADUATION_TIERS];
}
