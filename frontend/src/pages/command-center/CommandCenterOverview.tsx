import { Link } from "react-router-dom";
import { Trophy } from "lucide-react";

import { ArenaDailyBriefing } from "@/components/command-center/ArenaDailyBriefing";

import { CommandCenterCard } from "@/components/command-center/CommandCenterCard";
import { useCommandCenterData } from "@/components/command-center/CommandCenterContext";
import { PortfolioMetricsGrid } from "@/components/profile/PortfolioMetricsGrid";
import {
  isSolanaChainId,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_TESTNET_CHAIN_ID,
} from "@/lib/chainConfig";
import { tokenDetailsPath } from "@/lib/tokenDetailsPath";
import { applyDisplayPrefs, useDisplayPrefs } from "@/lib/displayPrefs";

function nativeSymbol(chainId?: number | null): "BNB" | "SOL" | "ETH" {
  if (isSolanaChainId(chainId)) return "SOL";
  if (chainId === ROBINHOOD_CHAIN_ID || chainId === ROBINHOOD_TESTNET_CHAIN_ID) return "ETH";
  return "BNB";
}

export default function CommandCenterOverview() {
  const {
    leagueCabinet,
    loadingLeagueCabinet,
    chainId,
    nativeBalance,
    tokenBalances,
    loadingBalances,
    portfolioMetrics,
    loadingPortfolioMetrics,
    walletAddress,
  } = useCommandCenterData();
  // Settings > Portfolio display (founder, 2026-10-03) filters the list; Total value counts everything.
  const { prefs: displayPrefs } = useDisplayPrefs(walletAddress);
  const shownBalances = applyDisplayPrefs(tokenBalances, displayPrefs);
  const coinsHeld = tokenBalances.filter((t) => t.kind !== "native").length;

  const trophyCount = Array.isArray((leagueCabinet as any)?.trophies)
    ? (leagueCabinet as any).trophies.length
    : Array.isArray((leagueCabinet as any)?.badges)
      ? (leagueCabinet as any).badges.length
      : 0;
  const symbol = nativeSymbol(chainId);

  const row = "flex min-h-10 items-center gap-2.5 border-b border-[#1E2329] text-sm last:border-b-0";

  return (
    <div className="flex flex-col gap-3.5">
      <ArenaDailyBriefing />

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <div className="rounded-[14px] border border-mw-border bg-mw-surface p-3">
          <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">Native {symbol}</div>
          <div className="font-mw-mono text-[19px] font-bold">{loadingBalances ? "…" : nativeBalance || "-"}</div>
          <div className="text-xs text-mw-muted">Connected wallet balance</div>
        </div>
        <div className="rounded-[14px] border border-mw-border bg-mw-surface p-3">
          <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">Coins held</div>
          <div className="font-mw-mono text-[19px] font-bold">{loadingBalances ? "…" : coinsHeld}</div>
          <div className="text-xs text-mw-muted">Tokens in this wallet</div>
        </div>
      </div>

      <CommandCenterCard title="Portfolio">
        <PortfolioMetricsGrid
          metrics={portfolioMetrics}
          loading={loadingPortfolioMetrics}
          variant="command-center"
        />
        <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">Top holdings</div>
        {loadingBalances ? (
          <div className="text-sm text-mw-muted">Loading token balances...</div>
        ) : shownBalances.length > 0 ? (
          <div className="flex flex-col">
            {shownBalances.slice(0, 8).map((token) => {
              // Founder, 2026-10-03: logo, name, ticker and USD value for every coin in the wallet.
              // Coins launched or imported here open their coin page; other tokens are listed only.
              const content = (
                <>
                  <img
                    src={(token as any).image || "/placeholder.svg"}
                    alt=""
                    className="h-8 w-8 shrink-0 rounded-lg border border-mw-border object-cover"
                    onError={(event) => { (event.currentTarget as HTMLImageElement).src = "/placeholder.svg"; }}
                  />
                  <span className="min-w-0 flex-1">
                    <b className="block truncate">{token.ticker ? `$${String(token.ticker).replace(/^\$/, "")}` : token.name}</b>
                    <span className="block truncate text-xs text-mw-muted">
                      {token.name}
                      {token.kind === "imported" ? " · Imported" : token.kind === "launched" ? " · Launched here" : token.kind === "native" ? " · Native coin" : token.stable ? " · Stablecoin" : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    {typeof token.valueUsd === "number" && token.valueUsd > 0 ? (
                      <b className="block font-mw-mono">${token.valueUsd.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}</b>
                    ) : null}
                    <span className="block font-mw-mono text-xs text-mw-muted">
                      {Number(token.balanceFormatted).toLocaleString(undefined, { maximumFractionDigits: 4 })}
                    </span>
                  </span>
                </>
              );
              return token.kind === "other" || token.kind === "native" ? (
                <div key={`${token.tokenAddress || token.kind}-${token.campaignAddress}`} className={`${row} py-1.5 text-mw-text`}>{content}</div>
              ) : (
                <Link
                  key={`${token.tokenAddress}-${token.campaignAddress}`}
                  to={tokenDetailsPath(
                    {
                      tokenAddress: token.tokenAddress,
                      campaignAddress: token.campaignAddress,
                      chainId,
                    },
                    { chainId },
                  )}
                  className={`${row} py-1.5 text-mw-text hover:text-mw-text`}
                >
                  {content}
                </Link>
              );
            })}
          </div>
        ) : (
          <div className="text-sm text-mw-muted">No launchpad token balances detected yet.</div>
        )}
      </CommandCenterCard>

      <CommandCenterCard title="League cabinet">
        {loadingLeagueCabinet ? (
          <div className="text-sm text-mw-muted">Loading league cabinet...</div>
        ) : trophyCount > 0 ? (
          <div className="flex items-center gap-3 rounded-[14px] border border-[#5A3416] bg-[#1A130D] p-3">
            <Trophy className="h-5 w-5 text-[#F2C14E]" aria-hidden="true" />
            <div>
              <b className="font-mw-mono text-lg">{trophyCount}</b>
              <div className="text-[13px] text-mw-muted">Cabinet items detected for this wallet.</div>
            </div>
          </div>
        ) : (
          <div>
            <div className="font-bold">No trophies yet</div>
            <p className="m-0 mt-1 text-sm text-mw-muted">League wins, badges, and status items will appear here once earned.</p>
          </div>
        )}
      </CommandCenterCard>
    </div>
  );
}
