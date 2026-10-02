import { useEffect, useMemo, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type CreatorProtectionDetail = {
  code?: string | null;
  creatorWallet?: string | null;
  campaignAddress?: string | null;
  creatorLinked?: boolean;
  relationship?: "creator" | "confirmed_cluster" | string | null;
  tier?: string | null;
  tierNumber?: number | null;
  unlockAt?: string | null;
  creatorBuyCapWei?: string | null;
  creatorBoughtWei?: string | null;
  requestedWei?: string | null;
  remainingWei?: string | null;
  error?: string | null;
  force?: boolean;
};

const SEEN_STORAGE_KEY = "mwz:creatorProtectionSeen:v1";

function protectionSeenKey(detail: CreatorProtectionDetail): string {
  const campaign = String(detail.campaignAddress || "").trim().toLowerCase();
  const wallet = String(detail.creatorWallet || "").trim().toLowerCase();
  const code = String(detail.code || "CREATOR_BUY_LOCKED").trim();
  return `${campaign || "campaign"}:${wallet || "wallet"}:${code}`;
}

function readSeenKeys(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(SEEN_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed as Record<string, number> : {};
  } catch {
    return {};
  }
}

function hasSeenProtection(key: string): boolean {
  return Boolean(readSeenKeys()[key]);
}

function markProtectionSeen(key: string): void {
  if (typeof window === "undefined" || !key) return;
  try {
    window.sessionStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify({
      ...readSeenKeys(),
      [key]: Date.now(),
    }));
  } catch {
    // Ignore storage failures; worst case the first-view reminder repeats.
  }
}

const TIER_RULES = [
  { tier: 1, name: "New", lock: "24 hours", cap: "0.25 BNB" },
  { tier: 2, name: "Trusted", lock: "6 hours", cap: "1 BNB" },
  { tier: 3, name: "Proven", lock: "1 hour", cap: "3 BNB" },
] as const;

function formatBnb(raw?: string | null): string {
  try {
    const wei = BigInt(String(raw || "0"));
    const whole = wei / 10n ** 18n;
    const fraction = (wei % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "").slice(0, 6);
    return `${whole.toString()}${fraction ? `.${fraction}` : ""} BNB`;
  } catch {
    return "—";
  }
}

function formatUnlock(value?: string | null): string {
  if (!value) return "the end of the protection period";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export function CreatorProtectionDialog() {
  const [detail, setDetail] = useState<CreatorProtectionDetail | null>(null);

  useEffect(() => {
    const onBlocked = (event: Event) => {
      const next = (event as CustomEvent<CreatorProtectionDetail>).detail;
      if (!next) return;
      const key = protectionSeenKey(next);
      // Passive safety polls fire every few seconds on Token Details.
      // Show the reminder once, then only reopen on an explicit buy attempt.
      if (!next.force && hasSeenProtection(key)) return;
      if (!next.force) markProtectionSeen(key);
      setDetail(next);
    };
    window.addEventListener("mwz:creatorProtectionBlocked", onBlocked as EventListener);
    return () => window.removeEventListener("mwz:creatorProtectionBlocked", onBlocked as EventListener);
  }, []);

  const copy = useMemo(() => {
    const code = String(detail?.code || "");
    const tierNumber = Number(detail?.tierNumber || 1);
    const tierLabel = detail?.tier || `Tier ${tierNumber}`;
    const cap = formatBnb(detail?.creatorBuyCapWei);
    const unlock = formatUnlock(detail?.unlockAt);

    if (code === "CREATOR_CLUSTER_BUY_CAP_EXCEEDED") {
      return {
        title: "Creator Cluster Buy Cap Reached",
        body: `This buy would exceed the ${cap} combined purchase allowance for the ${tierLabel} creator wallet and its confirmed linked wallets.`,
        note: detail?.remainingWei != null ? `Remaining creator-cluster allowance: ${formatBnb(detail.remainingWei)}.` : null,
      };
    }

    if (code === "CREATOR_CLUSTER_CHECK_UNAVAILABLE" || code === "CREATOR_CLUSTER_CAP_CHECK_UNAVAILABLE") {
      return {
        title: "Protection Check Unavailable",
        body: "MemeWarzone could not safely verify the creator-cluster protection for this campaign. No trading authorization was issued and MetaMask was not opened.",
        note: "Try again after the security service and RPC connection are healthy.",
      };
    }

    if (detail?.relationship === "confirmed_cluster" || detail?.relationship === "direct_creator_funding" || code === "CREATOR_CLUSTER_BUY_LOCKED") {
      return {
        title: "Creator-Linked Wallet",
        body: `This wallet is linked to the ${tierLabel} campaign creator. Creator-linked wallets cannot buy this campaign during the creator protection period.`,
        note: `This campaign-specific restriction ends at ${unlock}. The combined creator-cluster allowance after that time is ${cap}.`,
      };
    }

    return {
      title: `Tier ${tierNumber} Creator Buy Protection`,
      body: `As a ${tierLabel} creator, you cannot buy your own token during the first ${tierNumber === 1 ? "24 hours" : tierNumber === 2 ? "6 hours" : "1 hour"}.`,
      note: `You can participate after ${unlock}. Your creator wallet and confirmed linked wallets share a combined allowance of ${cap}.`,
    };
  }, [detail]);

  return (
    <Dialog open={Boolean(detail)} onOpenChange={(open) => !open && setDetail(null)}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto border-amber-500/35 bg-card/95 backdrop-blur-xl">
        <DialogHeader>
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-2xl border border-amber-500/35 bg-amber-500/10">
            <ShieldAlert className="h-6 w-6 text-amber-300" />
          </div>
          <DialogTitle className="font-retro text-base md:text-lg">{copy.title}</DialogTitle>
          <DialogDescription className="space-y-3 text-left text-sm leading-6 text-muted-foreground">
            <span className="block">{copy.body}</span>
            {copy.note ? <span className="block rounded-xl border border-border/60 bg-muted/20 p-3 text-foreground/85">{copy.note}</span> : null}
            <span className="block rounded-xl border border-amber-500/25 bg-black/30 p-3">
              <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.14em] text-amber-300">Creator protection rules</span>
              <span className="grid gap-2">
                {TIER_RULES.map((rule) => {
                  const active = Number(detail?.tierNumber || 1) === rule.tier;
                  return (
                    <span
                      key={rule.tier}
                      className={`grid grid-cols-[auto_1fr] gap-x-3 rounded-lg border px-3 py-2 ${
                        active
                          ? "border-amber-400/60 bg-amber-500/10 text-foreground"
                          : "border-border/45 bg-muted/10 text-muted-foreground"
                      }`}
                    >
                      <span className="font-semibold">Tier {rule.tier}</span>
                      <span>{rule.name}: {rule.lock} buy lock, then {rule.cap} shared creator-cluster cap.</span>
                    </span>
                  );
                })}
              </span>
              <span className="mt-2 block text-xs text-muted-foreground">
                These limits apply only to the creator&apos;s own campaign. Linked wallets can trade unrelated campaigns normally.
              </span>
            </span>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" onClick={() => setDetail(null)}>Understood</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
