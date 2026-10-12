/**
 * Payout-watchdog facts for a gen-8 choice vault. Pure: the worker reads the chain and passes the numbers in.
 * Alerts use gen8_* kinds. Nothing here sends a transaction.
 */
export type Gen8ForeignClaim = { txHash: string; from: string; amount: bigint };

export type Gen8VaultWatchFacts = {
  chainId: number;
  vault: string;
  balanceWei: bigint;
  totalLiabilitiesWei: bigint;
  treasuryRouter: string | null;
  expectedRouter: string | null;
  foreignClaims: Gen8ForeignClaim[];
  foreignScanError?: string | null;
};

export type Gen8WatchAlert = {
  severity: "critical" | "warning" | "info";
  kind: string;
  rewardType: string;
  subject: string;
  title: string;
  message: string;
};

function addr(value: string | null | undefined): string | null {
  const raw = String(value || "").trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(raw) && !/^0x0{40}$/.test(raw) ? raw : null;
}

/** Balance must equal totalLiabilities. A foreign claimRouter and a router that is not the splitter are reported too. */
export function evaluateGen8VaultWatch(facts: Gen8VaultWatchFacts): Gen8WatchAlert[] {
  const out: Gen8WatchAlert[] = [];
  const chainId = facts.chainId;
  const vault = addr(facts.vault) ?? facts.vault;
  if (facts.balanceWei < facts.totalLiabilitiesWei) {
    out.push({
      severity: "critical",
      kind: "gen8_vault_short",
      rewardType: "gen8_choice_vault",
      subject: vault,
      title: `Gen-8 choice vault on chain ${chainId} holds less than its liabilities`,
      message: `Balance ${facts.balanceWei} wei is below totalLiabilities ${facts.totalLiabilitiesWei} wei on ${vault}.`,
    });
  } else if (facts.balanceWei > facts.totalLiabilitiesWei) {
    out.push({
      severity: "warning",
      kind: "gen8_vault_excess",
      rewardType: "gen8_choice_vault",
      subject: vault,
      title: `Gen-8 choice vault on chain ${chainId} holds more than its liabilities`,
      message: `Balance ${facts.balanceWei} wei is above totalLiabilities ${facts.totalLiabilitiesWei} wei on ${vault}. That native is not owed. The Safe can rescue the excess.`,
    });
  }
  const expected = addr(facts.expectedRouter);
  const current = addr(facts.treasuryRouter);
  if (expected && current && expected !== current) {
    out.push({
      severity: "critical",
      kind: "gen8_router_changed",
      rewardType: "gen8_hook",
      subject: `${expected}:${current}`,
      title: `Gen-8 hook pays a different router on chain ${chainId}`,
      message: `hook.treasuryRouter() is ${current}. The configured splitter is ${expected}.`,
    });
  }
  for (const claim of facts.foreignClaims) {
    out.push({
      severity: "warning",
      kind: "gen8_foreign_router_claim",
      rewardType: "gen8_hook",
      subject: claim.txHash,
      title: `Gen-8 hook: claimRouter() sent by an unknown wallet on chain ${chainId}`,
      message: `${claim.from} called claimRouter() in ${claim.txHash} for ${claim.amount} wei. The money went to the current router.`,
    });
  }
  if (facts.foreignScanError) {
    out.push({
      severity: "warning",
      kind: "gen8_foreign_claim_scan_unavailable",
      rewardType: "gen8_hook",
      subject: vault,
      title: `Gen-8 hook: foreign claim scan failed on chain ${chainId}`,
      message: facts.foreignScanError,
    });
  }
  return out;
}
