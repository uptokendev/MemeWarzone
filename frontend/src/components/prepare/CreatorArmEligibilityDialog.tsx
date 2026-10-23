import { useEffect, useMemo, useState } from "react";
import { Clock3, Layers, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type CreatorArmBlockReason = "cooldown" | "live_limit" | "restricted" | "manual_review" | "generic";

export type CreatorArmEligibilityDialogDetail = {
  reason: CreatorArmBlockReason;
  mode?: "now" | "scheduled" | null;
  cooldownEndsAt?: number | null;
  currentLiveCount?: number | null;
  maxLiveBonding?: number | null;
  message?: string | null;
};

const EVENT_NAME = "mwz:creatorArmBlocked";

function formatLocal(seconds?: number | null) {
  if (seconds == null || !Number.isFinite(Number(seconds)) || Number(seconds) <= 0) return null;
  return new Date(Number(seconds) * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** Same pattern as mwz:creatorProtectionBlocked — fire and forget. */
export function emitCreatorArmBlocked(detail: CreatorArmEligibilityDialogDetail) {
  try {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail }));
  } catch {
    // ignore
  }
}

/**
 * Global dialog host (mounted once in App), same architecture as CreatorProtectionDialog.
 */
export function CreatorArmEligibilityDialog() {
  const [detail, setDetail] = useState<CreatorArmEligibilityDialogDetail | null>(null);

  useEffect(() => {
    const onBlocked = (event: Event) => {
      const next = (event as CustomEvent<CreatorArmEligibilityDialogDetail>).detail;
      if (next && typeof next === "object") {
        setDetail({ ...next });
      }
    };
    window.addEventListener(EVENT_NAME, onBlocked as EventListener);
    return () => window.removeEventListener(EVENT_NAME, onBlocked as EventListener);
  }, []);

  const modeLabel =
    detail?.mode === "scheduled" ? "Deploy with countdown" : detail?.mode === "now" ? "Deploy now" : "deploy";
  const unlockLabel = formatLocal(detail?.cooldownEndsAt);
  const liveCount = Number(detail?.currentLiveCount ?? 0);
  const liveLimit = Number(detail?.maxLiveBonding ?? 0);
  const liveKnown = liveLimit > 0;

  const copy = useMemo(() => {
    if (!detail) {
      return { title: "", lead: "", showClocks: true };
    }
    if (detail.reason === "cooldown") {
      return {
        title: "Creator arm cooldown is active",
        lead: `You cannot use ${modeLabel} until the creator arm cooldown ends${unlockLabel ? ` (${unlockLabel})` : ""}.`,
        showClocks: true,
      };
    }
    if (detail.reason === "live_limit") {
      return {
        title: "Live campaign limit reached",
        lead: `You already hold the maximum number of live campaigns${liveKnown ? ` (${liveCount} / ${liveLimit})` : ""}.`,
        showClocks: true,
      };
    }
    if (detail.reason === "restricted") {
      return {
        title: "Creator wallet restricted",
        lead: detail.message || "This creator wallet is restricted from launching new campaigns.",
        showClocks: false,
      };
    }
    if (detail.reason === "manual_review") {
      return {
        title: "Manual review required",
        lead: detail.message || "This creator wallet must pass manual review before another launch.",
        showClocks: false,
      };
    }
    return {
      title: "Deployment not available right now",
      lead: detail.message || "This wallet cannot deploy or arm another campaign right now.",
      showClocks: true,
    };
  }, [detail, liveCount, liveKnown, liveLimit, modeLabel, unlockLabel]);

  return (
    <Dialog open={Boolean(detail)} onOpenChange={(open) => !open && setDetail(null)}>
      <DialogContent className="z-[200] max-h-[90vh] max-w-lg overflow-y-auto border-orange-500/35 bg-card/95 backdrop-blur-xl">
        <DialogHeader>
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-2xl border border-orange-500/35 bg-orange-500/10">
            <ShieldAlert className="h-6 w-6 text-orange-300" />
          </div>
          <DialogTitle className="font-retro text-base md:text-lg">{copy.title}</DialogTitle>
          <DialogDescription className="space-y-3 text-left text-sm leading-6 text-muted-foreground">
            <span className="block text-foreground/90">{copy.lead}</span>

            {copy.showClocks ? (
              <span className="block rounded-xl border border-border/60 bg-muted/20 p-3 text-foreground/85">
                <span className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-orange-300">
                  <Clock3 className="h-3.5 w-3.5" />
                  Two different clocks
                </span>
                <span className="mb-2 block">
                  <strong className="text-foreground">Creator arm cooldown</strong> starts when you pay gas and the
                  campaign is created on-chain (Deploy now or Deploy with countdown). That is when the 24-hour wait
                  begins — even if trading is still locked.
                </span>
                <span className="block">
                  <strong className="text-foreground">Trading open time</strong> is only when the public can buy/sell.
                  Setting the timer days ahead does <em>not</em> delay or reset the arm cooldown.
                </span>
              </span>
            ) : null}

            <span className="block rounded-xl border border-orange-500/25 bg-black/30 p-3">
              <span className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-orange-300">
                <Layers className="h-3.5 w-3.5" />
                What you can still do
              </span>
              <span className="grid gap-2 text-foreground/90">
                <span>• Prepare, edit, and publish as many drafts as your draft limit allows.</span>
                {/* Current launch types (Solana DBC, BNB and Robinhood) have no launch cooldown and no live-coin
                    limit (founder 2026-10-10, api/lib/dbc/dbcCreateLimits.js). These lines show only when the server
                    reports that block. */}
                {detail?.reason === "cooldown" ? (
                  <span>• Arm or deploy at most one campaign every 24 hours per creator wallet.</span>
                ) : null}
                {detail?.reason === "live_limit" ? (
                  <span>
                    • Hold at most your tier&apos;s live campaigns at once
                    {liveKnown ? ` (currently ${liveCount} / ${liveLimit})` : ""}.
                  </span>
                ) : null}
                {detail?.reason === "live_limit" ? (
                  <span>• Free a slot by graduating an existing live campaign, then try again.</span>
                ) : null}
                {detail?.reason === "cooldown" && unlockLabel ? (
                  <span>
                    • Retry {modeLabel} after {unlockLabel}.
                  </span>
                ) : null}
              </span>
            </span>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" onClick={() => setDetail(null)}>
            Understood
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** @deprecated use CreatorArmEligibilityDialog — kept so older imports keep working */
export const CreatorArmEligibilityDialogHost = CreatorArmEligibilityDialog;

export function classifyCreatorArmBlock(input: {
  mode?: "now" | "scheduled" | null;
  eligibility?: {
    allowed?: boolean;
    cooldownEndsAt?: number;
    lastRecordedLaunchAt?: number;
    currentLiveCount?: number;
    maxLiveBonding?: number;
    restricted?: boolean;
    manualReviewRequired?: boolean;
  } | null;
  errorMessage?: string | null;
  errorCode?: string | null;
}): CreatorArmEligibilityDialogDetail | null {
  const now = Math.floor(Date.now() / 1000);
  const eligibility = input.eligibility || null;
  const text = String(input.errorMessage || "").toLowerCase();
  const code = String(input.errorCode || "").toUpperCase();

  if (eligibility?.restricted) {
    return { reason: "restricted", mode: input.mode, ...snap(eligibility), message: input.errorMessage };
  }
  if (eligibility?.manualReviewRequired) {
    return { reason: "manual_review", mode: input.mode, ...snap(eligibility), message: input.errorMessage };
  }

  const liveCap =
    Number(eligibility?.maxLiveBonding || 0) > 0 &&
    Number(eligibility?.currentLiveCount || 0) >= Number(eligibility?.maxLiveBonding || 0);
  if (liveCap && (eligibility?.allowed === false || looksLikeLiveLimit(text, code))) {
    return { reason: "live_limit", mode: input.mode, ...snap(eligibility), message: input.errorMessage };
  }

  const recordedLaunch = Number(eligibility?.lastRecordedLaunchAt || 0) > 0;
  const cooldownEndsAt = Number(eligibility?.cooldownEndsAt || 0);
  const cooldownActive = recordedLaunch && cooldownEndsAt > now + 30;
  if (cooldownActive && (eligibility?.allowed === false || looksLikeExplicitCooldown(text, code))) {
    return {
      reason: "cooldown",
      mode: input.mode,
      ...snap(eligibility),
      cooldownEndsAt,
      message: input.errorMessage,
    };
  }

  if (looksLikeLiveLimit(text, code)) {
    return { reason: "live_limit", mode: input.mode, ...snap(eligibility), message: input.errorMessage };
  }
  if (looksLikeExplicitCooldown(text, code) && recordedLaunch && cooldownEndsAt > now + 30) {
    return {
      reason: "cooldown",
      mode: input.mode,
      ...snap(eligibility),
      cooldownEndsAt,
      message: input.errorMessage,
    };
  }

  if (eligibility?.allowed === false) {
    return { reason: "generic", mode: input.mode, ...snap(eligibility), message: input.errorMessage };
  }

  return null;
}

/** Always produce a dialog payload for known arm blocks; never return null for cooldown ISO messages. */
export function resolveCreatorArmBlock(input: {
  mode?: "now" | "scheduled" | null;
  eligibility?: Parameters<typeof classifyCreatorArmBlock>[0]["eligibility"];
  errorMessage?: string | null;
  errorCode?: string | null;
}): CreatorArmEligibilityDialogDetail {
  return (
    classifyCreatorArmBlock(input) || {
      reason: "generic",
      mode: input.mode,
      message: input.errorMessage || "This wallet cannot deploy or arm another campaign right now.",
      currentLiveCount: Number(input.eligibility?.currentLiveCount || 0),
      maxLiveBonding: Number(input.eligibility?.maxLiveBonding || 0),
      cooldownEndsAt: Number(input.eligibility?.cooldownEndsAt || 0) || null,
    }
  );
}

function looksLikeExplicitCooldown(text: string, code: string) {
  return (
    text.includes("cooldown") ||
    text.includes("24h between") ||
    text.includes("24 hours between") ||
    code.includes("COOLDOWN")
  );
}

function looksLikeLiveLimit(text: string, code: string) {
  return (
    text.includes("live campaign limit") ||
    text.includes("active solana campaign limit") ||
    text.includes("live-limit") ||
    text.includes("maxlive") ||
    text.includes("live bonding") ||
    text.includes("live limit") ||
    code.includes("LIVE_LIMIT") ||
    code.includes("LAUNCH_LIMIT") ||
    code.includes("CREATORLIVELIMIT")
  );
}

function snap(eligibility: {
  currentLiveCount?: number | null;
  maxLiveBonding?: number | null;
  cooldownEndsAt?: number | null;
} | null) {
  return {
    currentLiveCount: Number(eligibility?.currentLiveCount ?? 0),
    maxLiveBonding: Number(eligibility?.maxLiveBonding ?? 0),
    cooldownEndsAt: Number(eligibility?.cooldownEndsAt ?? 0) || null,
  };
}
