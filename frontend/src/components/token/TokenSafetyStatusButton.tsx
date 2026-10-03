import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createDbcLaunchpadAdapter } from "@/features/launchpad/dbcAdapter";
import { useIsDbcCoin } from "@/features/launchpad/useIsDbcCoin";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldCheck, X, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import type { LaunchpadAdapterStatus, LaunchpadTradePreflight, TradeSide } from "@/features/launchpad/adapters";
import { useLaunchpadAdapter } from "@/features/launchpad/useLaunchpadAdapter";
import { isRobinhoodChainId, isSolanaChainId } from "@/lib/chainConfig";


const DBC_ADAPTER = createDbcLaunchpadAdapter();
type TokenSafetyStatusButtonProps = {
  campaignAddress?: string | null;
  chainId?: number | string | null;
};

const SAFETY_WARM_REFRESH_MS = 12_000;

declare global {
  interface Window {
    __mwzTokenSafetyState?: {
      chain?: string;
      blocked: boolean;
      warning: boolean;
      buyAllowed: boolean;
      sellAllowed: boolean;
      reasons: string[];
      warnings: string[];
      campaignAddress: string;
      updatedAt: number;
    };
  }
}

function uniq(values: string[]) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function tone(preflight?: LaunchpadTradePreflight | null) {
  if (!preflight) return "checking";
  if (!preflight.allowed) return "blocked";
  if (preflight.warnings.length || preflight.lookupErrors?.length) return "warning";
  return "ok";
}

function formatDateTime(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function StatusIcon({ state }: { state: "ok" | "warning" | "blocked" | "checking" }) {
  if (state === "ok") return <CheckCircle2 className="h-3.5 w-3.5" />;
  if (state === "warning") return <AlertTriangle className="h-3.5 w-3.5" />;
  if (state === "blocked") return <XCircle className="h-3.5 w-3.5" />;
  return <RefreshCw className="h-3.5 w-3.5 animate-spin" />;
}

function safetyNetworkLabel(chainId?: number | string | null) {
  const id = Number(chainId);
  if (isSolanaChainId(id)) return "Solana";
  if (isRobinhoodChainId(id)) return "Robinhood";
  return "BNB";
}

function safetySummary(
  state: "ok" | "warning" | "blocked" | "checking",
  walletAddress: string,
  chainId?: number | string | null,
) {
  const network = safetyNetworkLabel(chainId);
  if (state === "blocked") return "Trading is currently blocked by campaign safety controls.";
  if (state === "warning") {
    return walletAddress
      ? "Trading is available with warnings."
      : `Campaign checks are clear. Connect ${network} for wallet-specific checks.`;
  }
  if (state === "ok") {
    return walletAddress
      ? "Campaign and wallet safety checks are clear."
      : `Campaign safety checks are clear. Connect ${network} for wallet-specific checks.`;
  }
  return "Checking campaign safety...";
}

export function TokenSafetyStatusButton({ campaignAddress, chainId }: TokenSafetyStatusButtonProps) {
  const wallet = useWallet();
  const solanaWallet = useSolanaWallet();
  const launchpadAdapter = useLaunchpadAdapter({ chainId });
  // A DBC coin trades on its Meteora pool: the launchpad's switches do not apply to it.
  const isDbcCoin = useIsDbcCoin(String(campaignAddress || ""), chainId);
  const adapter = useMemo(() => (isDbcCoin ? DBC_ADAPTER : launchpadAdapter), [isDbcCoin, launchpadAdapter]);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const refreshInFlightRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<LaunchpadAdapterStatus | null>(null);
  const [buyPreflight, setBuyPreflight] = useState<LaunchpadTradePreflight | null>(null);
  const [sellPreflight, setSellPreflight] = useState<LaunchpadTradePreflight | null>(null);

  // Solana safety must use Solana wallet, not EVM account.
  const isSolanaChain = Number(chainId) === 101 || Number(chainId) === 102;
  const walletAddress = String(
    isSolanaChain ? solanaWallet.solanaAccount || wallet.account || "" : wallet.account || "",
  ).trim();
  const campaign = String(campaignAddress || "").trim();

  const updateAnchor = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect || typeof window === "undefined") return;
    setAnchor({ top: rect.bottom + 8, right: Math.max(8, window.innerWidth - rect.right) });
  }, []);

  const refresh = useCallback(async (options?: { silent?: boolean }) => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    if (!options?.silent) setLoading(true);
    try {
      const nextStatus = await adapter.getStatus();
      setStatus(nextStatus);
      if (!walletAddress || !campaign) {
        setBuyPreflight(null);
        setSellPreflight(null);
        return;
      }
      const sides: TradeSide[] = ["buy", "sell"];
      const [nextBuy, nextSell] = await Promise.all(
        sides.map((side) => adapter.preflightTrade({ side, walletAddress, campaignAddress: campaign, chainId })),
      );
      setBuyPreflight(nextBuy);
      setSellPreflight(nextSell);
    } finally {
      refreshInFlightRef.current = false;
      if (!options?.silent) setLoading(false);
    }
  }, [adapter, walletAddress, campaign, chainId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const nextStatus = await adapter.getStatus();
        if (cancelled) return;
        setStatus(nextStatus);
        if (!walletAddress || !campaign) {
          if (!cancelled) {
            setBuyPreflight(null);
            setSellPreflight(null);
          }
          return;
        }
        const [nextBuy, nextSell] = await Promise.all([
          adapter.preflightTrade({ side: "buy", walletAddress, campaignAddress: campaign, chainId }),
          adapter.preflightTrade({ side: "sell", walletAddress, campaignAddress: campaign, chainId }),
        ]);
        if (cancelled) return;
        setBuyPreflight(nextBuy);
        setSellPreflight(nextSell);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adapter, walletAddress, campaign, chainId]);

  useEffect(() => {
    if (!campaign) return;
    const timer = window.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void refresh({ silent: true });
    }, SAFETY_WARM_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [campaign, refresh]);

  useEffect(() => {
    if (!campaign) return;

    const refreshVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void refresh({ silent: true });
    };

    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);

    return () => {
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [campaign, refresh]);

  useEffect(() => {
    const openSafety = () => {
      updateAnchor();
      setOpen(true);
    };
    window.addEventListener("mwz:openTokenSafety", openSafety as EventListener);
    return () => window.removeEventListener("mwz:openTokenSafety", openSafety as EventListener);
  }, [updateAnchor]);

  useEffect(() => {
    const refreshSafety = () => {
      updateAnchor();
      setOpen(true);
      void refresh();
    };
    window.addEventListener("mwz:refreshTokenSafety", refreshSafety as EventListener);
    return () => window.removeEventListener("mwz:refreshTokenSafety", refreshSafety as EventListener);
  }, [refresh, updateAnchor]);

  useEffect(() => {
    if (!open) return;
    updateAnchor();
    window.addEventListener("resize", updateAnchor);
    window.addEventListener("scroll", updateAnchor, true);
    return () => {
      window.removeEventListener("resize", updateAnchor);
      window.removeEventListener("scroll", updateAnchor, true);
    };
  }, [open, updateAnchor]);

  const blocks = useMemo(() => uniq([
    ...(buyPreflight?.reasons || []),
    ...(sellPreflight?.reasons || []),
  ]), [buyPreflight, sellPreflight]);

  const warnings = useMemo(() => uniq([
    ...(status?.warnings || []),
    ...(buyPreflight?.warnings || []),
    ...(sellPreflight?.warnings || []),
    ...(buyPreflight?.lookupErrors || []),
    ...(sellPreflight?.lookupErrors || []),
  ]), [status, buyPreflight, sellPreflight]);

  const campaignState = buyPreflight?.campaign || sellPreflight?.campaign || null;
  const walletRisk = buyPreflight?.walletRisk || sellPreflight?.walletRisk || null;
  const cluster = buyPreflight?.cluster || sellPreflight?.cluster || null;
  const buyTone = tone(buyPreflight);
  const sellTone = tone(sellPreflight);
  const blocked = Boolean(status?.protocolLive === false || blocks.length || buyTone === "blocked" || sellTone === "blocked");
  const warning = Boolean(!blocked && (warnings.length || buyTone === "warning" || sellTone === "warning"));
  const state: "ok" | "warning" | "blocked" | "checking" = loading && !status ? "checking" : blocked ? "blocked" : warning ? "warning" : "ok";

  useEffect(() => {
    if (typeof window === "undefined") return;
    const detail = {
      chain: status?.chain || adapter.chain,
      blocked,
      warning,
      buyAllowed: Boolean(buyPreflight?.allowed),
      sellAllowed: Boolean(sellPreflight?.allowed),
      reasons: blocks,
      warnings,
      campaignAddress: campaign,
      updatedAt: Date.now(),
    };
    window.__mwzTokenSafetyState = detail;
    window.dispatchEvent(new CustomEvent("mwz:tokenSafetyChanged", { detail }));
  }, [adapter.chain, blocked, warning, buyPreflight?.allowed, sellPreflight?.allowed, blocks, warnings, campaign, status?.chain]);

  const buttonClass = state === "ok"
    ? "border-[#1F5133] bg-[#0F2418] text-[#6EE7A0] hover:bg-[#143020]"
    : state === "warning"
      ? "border-[#7A3A0C] bg-[#2A1609] text-mw-accent-soft hover:bg-[#341C0B]"
      : state === "blocked"
        ? "border-[#5A1F2A] bg-[#2A0F16] text-[#FDA4AF] hover:bg-[#35121B]"
        : "border-mw-edge bg-[#171B20] text-[#C9CED4] hover:text-mw-text";

  const popover = open && anchor ? createPortal(
    <div
      data-token-safety
      className="w-[min(92vw,25rem)] rounded-[18px] border border-mw-edge bg-mw-surface font-mw-body text-mw-text p-4 text-sm shadow-2xl"
      style={{ position: "fixed", top: anchor.top, right: anchor.right, zIndex: 90 }}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="inline-flex items-center gap-2 font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">
            <ShieldCheck className="h-4 w-4 text-mw-accent" />
            Campaign safety · {status?.chain || adapter.chain}
          </div>
          <p className="mt-1 text-sm text-mw-muted">{safetySummary(state, walletAddress, chainId)}</p>
        </div>
        <button type="button" onClick={() => setOpen(false)} className="mw-focus inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] text-mw-muted hover:bg-mw-raised hover:text-mw-text -mr-2 -mt-2" aria-label="Close safety">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-[10px] border border-mw-border bg-mw-input p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">Buy</span>
            <span className={buyPreflight?.allowed ? "font-semibold text-[#6EE7A0]" : "font-semibold text-mw-sell"}>{buyPreflight?.allowed ? "OK" : "Blocked"}</span>
          </div>
        </div>
        <div className="rounded-[10px] border border-mw-border bg-mw-input p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">Sell</span>
            <span className={sellPreflight?.allowed ? "font-semibold text-[#6EE7A0]" : "font-semibold text-mw-sell"}>{sellPreflight?.allowed ? "OK" : "Blocked"}</span>
          </div>
        </div>
      </div>

      <div className="mt-3 space-y-2 text-xs">
        <div className="rounded-[10px] border border-mw-border bg-mw-input p-2.5 text-mw-muted">
          Backend route check: {status?.routeAuthorizationReady ? "ready" : "pending"}
          {walletAddress
            ? walletRisk?.riskLevel
              ? ` · Wallet risk: ${walletRisk.riskLevel}`
              : " · Wallet risk: clear"
            : ` · Wallet checks: connect ${safetyNetworkLabel(chainId)}`}
          {cluster?.id ? ` · Cluster: ${cluster.id}` : ""}
        </div>
        {status?.protocolLive === false ? <div className="rounded-[10px] border border-[#5A1F2A] bg-[#2A0F16] p-2.5 text-[#FDA4AF]">{status.label} is not live for trading.</div> : null}
        {blocks.slice(0, 4).map((reason) => <div key={reason} className="rounded-[10px] border border-[#5A1F2A] bg-[#2A0F16] p-2.5 text-[#FDA4AF]">{reason}</div>)}
        {warnings.slice(0, 4).map((item) => <div key={item} className="rounded-[10px] border border-[#5A3416] bg-mw-accent-fill p-2.5 text-mw-accent-soft">{item}</div>)}
        {campaignState ? (
          <div className="grid grid-cols-2 gap-2 rounded-[10px] border border-mw-border bg-mw-input p-2.5 text-mw-muted">
            <div>Campaign: {campaignState.paused ? "paused" : "live"}</div>
            <div>Buy: {campaignState.buyPaused ? "paused" : "live"}</div>
            <div>Sell: {campaignState.sellPaused ? "paused" : "live"}</div>
            <div>Graduation: {campaignState.graduationPaused ? "paused" : "live"}</div>
            {campaignState.creatorBuyLockUntil ? <div className="col-span-2">Creator lock until {formatDateTime(campaignState.creatorBuyLockUntil)}</div> : null}
          </div>
        ) : null}
      </div>

      <Button type="button" variant="outline" size="sm" className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-[15px] font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text disabled:opacity-60 mt-3 w-full" disabled={loading} onClick={() => void refresh()}>
        <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        Refresh safety
      </Button>
    </div>,
    document.body,
  ) : null;

  return (
    <div className="relative z-50" data-token-safety>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          updateAnchor();
          setOpen((value) => !value);
        }}
        className={`mw-focus inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 font-mw-body text-[13px] font-semibold transition ${buttonClass}`}
        title="Trading safety status"
      >
        <StatusIcon state={state} />
        Safety
      </button>
      {popover}
    </div>
  );
}
