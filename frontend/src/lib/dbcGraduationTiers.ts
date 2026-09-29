import {
  GRADUATION_WAD,
  STANDARD_GRADUATION_TIERS,
  type GraduationTier,
} from "@/lib/graduationTiers";

/** DBC rehearsal target is $150 (the $6 launchpad test tier is not used). */
export const DBC_TEST_GRADUATION_TARGET_WEI = 150n * GRADUATION_WAD;

export const DBC_TEST_GRADUATION_TIER: GraduationTier = {
  id: "test",
  label: "$150",
  title: "Devnet rehearsal",
  description: "Devnet only. A small test launch without a $15K target.",
  targetWei: DBC_TEST_GRADUATION_TARGET_WEI,
  testOnly: true,
};

export function isDbcDevnetCluster(cluster?: string | null): boolean {
  const raw = String(cluster || import.meta.env.VITE_SOLANA_CLUSTER || "").trim().toLowerCase();
  return raw === "devnet" || raw === "solana-devnet";
}

export function getDbcGraduationTiers(cluster?: string | null): GraduationTier[] {
  if (isDbcDevnetCluster(cluster)) return [DBC_TEST_GRADUATION_TIER, ...STANDARD_GRADUATION_TIERS];
  return [...STANDARD_GRADUATION_TIERS];
}
