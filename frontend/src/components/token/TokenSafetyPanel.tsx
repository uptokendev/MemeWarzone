import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Clock, RefreshCw, Route, ShieldAlert, ShieldCheck, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import type { LaunchpadAdapterStatus, LaunchpadTradePreflight, TradeSide } from "@/features/launchpad/adapters";
import { useLaunchpadAdapter } from "@/features/launchpad/useLaunchpadAdapter";

type TokenSafetyPanelProps = {
  campaignAddress?: string | null;
  chainId?: number | string | null;
  compact?: boolean;
};

function formatDateTime(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function toneClass(tone: "success" | "warning" | "blocked" | "neutral") {
  if (tone === "success") return "border-emerald-400/30 bg-emerald-500/10 text-emerald-100";
  if (tone === "warning") return "border-orange-400/30 bg-orange-500/10 text-orange-100";
  if (tone === "blocked") return "border-rose-400/30 bg-rose-500/10 text-rose-100";
  return "border-cyan-400/25 bg-cyan-500/10 text-cyan-100";
}

function SafetyPill({ label, tone }: { label: string; tone: "success" | "warning" | "blocked" | "neutral" }) {
  return <span className={`inline-flex rounded-full border px-2 py-1 font-retro text-[9px] uppercase tracking-[0.16em] ${toneClass(tone)}`}>{label}</span>;
}

function preflightTone(preflight?: LaunchpadTradePreflight | null): "success" | "warning" | "blocked" | "neutral" {
  if (!preflight) return "neutral";
  if (!preflight.allowed) return "blocked";
  if (preflight.warnings.length || preflight.lookupErrors?.length) return "warning";
  return "success";
}

function preflightIcon(preflight?: LaunchpadTradePreflight | null) {
  if (!preflight) return Clock;
  if (!preflight.allowed) return XCircle;
  if (preflight.warnings.length || preflight.lookupErrors?.length) return AlertTriangle;
  return CheckCircle2;
}

function uniq(values: string[]) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

export function TokenSafetyPanel({ campaignAddress, chainId, compact = false }: TokenSafetyPanelProps) {
  const wallet = useWallet();
  const solanaWallet = useSolanaWallet();
  const adapter = useLaunchpadAdapter({ chainId });
  const [status, setStatus] = useState<LaunchpadAdapterStatus | null>(null);
  const [buyPreflight, setBuyPreflight] = useState<LaunchpadTradePreflight | null>(null);
  const [sellPreflight, setSellPreflight] = useState<LaunchpadTradePreflight | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const isSolanaChain = Number(chainId) === 101 || Number(chainId) === 102;
  const connectedWallet = String(
    isSolanaChain ? solanaWallet.solanaAccount || wallet.account || "" : wallet.account || "",
  ).trim();
  const campaign = String(campaignAddress || "").trim();

  const refreshSafety = async () => {
    setLoading(true);
    try {
      const nextStatus = await adapter.getStatus();
      setStatus(nextStatus);

      if (!connectedWallet || !campaign) {
        setBuyPreflight(null);
        setSellPreflight(null);
        return;
      }
      const [nextBuy, nextSell] = await Promise.all([
        adapter.preflightTrade({ side: "buy", walletAddress: connectedWallet, campaignAddress: campaign, chainId }),
        adapter.preflightTrade({ side: "sell", walletAddress: connectedWallet, campaignAddress: campaign, chainId }),
      ]);
      setBuyPreflight(nextBuy);
      setSellPreflight(nextSell);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    void (async () => {
      try {
        const nextStatus = await adapter.getStatus();
        if (cancelled) return;
        setStatus(nextStatus);

        // Without a connected wallet, only campaign adapter status is needed.
        // Wallet preflight is deferred until connect so visitors never get
        // creator-protection dialogs from passive page loads.
        if (!connectedWallet || !campaign) {
          if (!cancelled) {
            setBuyPreflight(null);
            setSellPreflight(null);
          }
          return;
        }

        const [nextBuy, nextSell] = await Promise.all([
          adapter.preflightTrade({ side: "buy", walletAddress: connectedWallet, campaignAddress: campaign }),
          adapter.preflightTrade({ side: "sell", walletAddress: connectedWallet, campaignAddress: campaign }),
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
  }, [adapter, connectedWallet, campaign, chainId]);

  const allWarnings = useMemo(() => uniq([
    ...(status?.warnings || []),
    ...(buyPreflight?.warnings || []),
    ...(sellPreflight?.warnings || []),
    ...(buyPreflight?.lookupErrors || []),
    ...(sellPreflight?.lookupErrors || []),
  ]), [status, buyPreflight, sellPreflight]);

  const allBlocks = useMemo(() => uniq([
    ...(buyPreflight?.reasons || []),
    ...(sellPreflight?.reasons || []),
  ]), [buyPreflight, sellPreflight]);

  const campaignState = buyPreflight?.campaign || sellPreflight?.campaign || null;
  const walletRisk = buyPreflight?.walletRisk || sellPreflight?.walletRisk || null;
  const cluster = buyPreflight?.cluster || sellPreflight?.cluster || null;
  const protocolBlocked = status && !status.protocolLive;
  const hasBlocks = Boolean(protocolBlocked || allBlocks.length);
  const panelTone: "success" | "warning" | "blocked" | "neutral" = hasBlocks ? "blocked" : allWarnings.length ? "warning" : status ? "success" : "neutral";
  const BuyIcon = preflightIcon(buyPreflight);
  const SellIcon = preflightIcon(sellPreflight);

  return (
    <div className={`rounded-2xl border p-3 shadow-xl backdrop-blur-md ${toneClass(panelTone)} ${compact ? "" : "bg-black/80"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheck className="h-4 w-4 shrink-0" />
            <div className="font-retro text-[10px] uppercase tracking-[0.18em]">Trading safety</div>
            <SafetyPill label={status?.chain || adapter.chain} tone={status?.protocolLive === false ? "blocked" : "neutral"} />
          </div>
          <div className="mt-1 text-xs opacity-85">{status?.message || "Checking launchpad safety state..."}</div>
        </div>
        <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-[10px]" disabled={loading} onClick={() => void refreshSafety()}>
          <RefreshCw className={`mr-1 h-3 w-3 ${loading ? "animate-spin" : ""}`} />
          Check
        </Button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        {(["buy", "sell"] as TradeSide[]).map((side) => {
          const preflight = side === "buy" ? buyPreflight : sellPreflight;
          const Icon = side === "buy" ? BuyIcon : SellIcon;
          const tone = preflightTone(preflight);
          return (
            <div key={side} className="rounded-xl border border-white/10 bg-black/20 p-2">
              <div className="flex items-center justify-between gap-2">
                <div className="inline-flex items-center gap-1.5 font-retro text-[10px] uppercase tracking-[0.14em]"><Icon className="h-3.5 w-3.5" />{side}</div>
                <SafetyPill label={preflight ? (preflight.allowed ? "allowed" : "blocked") : "checking"} tone={tone} />
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] opacity-85">
        <span className="inline-flex items-center gap-1"><Route className="h-3 w-3" /> Route auth: {status?.routeAuthorizationReady ? "ready" : "unknown"}</span>
        {walletRisk?.riskLevel ? <span>Wallet risk: {walletRisk.riskLevel}</span> : null}
        {cluster?.id ? <span>Cluster: {cluster.id}</span> : null}
      </div>

      {hasBlocks || allWarnings.length || expanded ? (
        <div className="mt-3 space-y-2 text-[11px]">
          {protocolBlocked ? <div className="rounded-xl border border-rose-400/20 bg-rose-500/10 p-2">{status?.label || "Protocol"} is not live for trading.</div> : null}
          {allBlocks.slice(0, expanded ? 8 : 3).map((reason) => <div key={reason} className="rounded-xl border border-rose-400/20 bg-rose-500/10 p-2">{reason}</div>)}
          {allWarnings.slice(0, expanded ? 8 : 3).map((warning) => <div key={warning} className="rounded-xl border border-orange-400/20 bg-orange-500/10 p-2">{warning}</div>)}
          {campaignState ? (
            <div className="grid grid-cols-2 gap-2 rounded-xl border border-white/10 bg-black/20 p-2">
              <div>Campaign paused: {campaignState.paused ? "yes" : "no"}</div>
              <div>Buy pause: {campaignState.buyPaused ? "yes" : "no"}</div>
              <div>Sell pause: {campaignState.sellPaused ? "yes" : "no"}</div>
              <div>Graduation pause: {campaignState.graduationPaused ? "yes" : "no"}</div>
              {campaignState.creatorBuyLockUntil ? <div className="col-span-2">Creator buy lock until {formatDateTime(campaignState.creatorBuyLockUntil)}</div> : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {(allBlocks.length > 3 || allWarnings.length > 3 || campaignState) ? (
        <button type="button" className="mt-2 text-[10px] uppercase tracking-[0.16em] opacity-80 hover:opacity-100" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Show less" : "Show full safety detail"}
        </button>
      ) : null}

      {!connectedWallet ? (
        <div className="mt-3 inline-flex items-center gap-2 rounded-xl border border-orange-400/20 bg-orange-500/10 p-2 text-[11px]">
          <ShieldAlert className="h-3.5 w-3.5" /> Connect wallet for wallet-specific buy/sell checks.
        </div>
      ) : null}
    </div>
  );
}
