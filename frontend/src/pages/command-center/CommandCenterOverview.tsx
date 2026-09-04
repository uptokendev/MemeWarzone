import { Link } from "react-router-dom";

import { CommandCenterCard } from "@/components/command-center/CommandCenterCard";
import { useCommandCenterData } from "@/components/command-center/CommandCenterContext";
import { PortfolioMetricsGrid } from "@/components/profile/PortfolioMetricsGrid";
import {
  isSolanaChainId,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_TESTNET_CHAIN_ID,
} from "@/lib/chainConfig";
import { tokenDetailsPath } from "@/lib/tokenDetailsPath";

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
  } = useCommandCenterData();

  const trophyCount = Array.isArray((leagueCabinet as any)?.trophies)
    ? (leagueCabinet as any).trophies.length
    : Array.isArray((leagueCabinet as any)?.badges)
      ? (leagueCabinet as any).badges.length
      : 0;
  const symbol = nativeSymbol(chainId);

  return (
    <div>
      <div className="mb-4">
        <PortfolioMetricsGrid
          metrics={portfolioMetrics}
          loading={loadingPortfolioMetrics}
          variant="command-center"
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <CommandCenterCard title="League Cabinet" description="Badges, trophies, and league status.">
          <div className="rounded-2xl border border-border/50 bg-background/25 p-4">
            {loadingLeagueCabinet ? (
              <div className="font-retro text-sm text-muted-foreground">Loading league cabinet...</div>
            ) : trophyCount > 0 ? (
              <>
                <div className="font-retro text-3xl text-foreground">{trophyCount}</div>
                <p className="mt-2 text-sm text-muted-foreground">Cabinet items detected for this wallet.</p>
              </>
            ) : (
              <>
                <div className="font-retro text-lg text-foreground">No trophies yet</div>
                <p className="mt-2 text-sm text-muted-foreground">
                  League wins, badges, and status items will appear here once earned.
                </p>
              </>
            )}
          </div>
        </CommandCenterCard>

        <CommandCenterCard title="Balances" description="Wallet balance and detected launchpad token balances.">
          <div className="space-y-3 rounded-2xl border border-border/50 bg-background/25 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-border/50 bg-card/35">
                  <img src="/assets/ticker.png" alt={symbol} className="h-7 w-7 object-contain" />
                </div>
                <div>
                  <div className="font-retro text-sm text-foreground">Native {symbol}</div>
                  <div className="mt-1 text-xs text-muted-foreground">Connected wallet balance</div>
                </div>
              </div>
              <div className="shrink-0 font-retro text-sm text-foreground">
                {loadingBalances ? "Loading..." : nativeBalance || "-"}
              </div>
            </div>
            <div className="border-t border-border/50 pt-3">
              <div className="font-retro text-sm text-foreground">Token balances</div>
              {loadingBalances ? (
                <div className="mt-2 text-sm text-muted-foreground">Loading token balances...</div>
              ) : tokenBalances.length > 0 ? (
                <div className="mt-3 grid gap-2">
                  {tokenBalances.slice(0, 6).map((token) => (
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
                      className="flex items-center justify-between gap-3 rounded-xl border border-border/40 bg-card/25 p-3 transition hover:border-accent/50 hover:bg-card/45"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <img
                          src={(token as any).image || "/placeholder.svg"}
                          alt={token.ticker || token.name}
                          className="h-10 w-10 shrink-0 rounded-xl border border-border/50 object-cover"
                        />
                        <div className="min-w-0">
                          <div className="truncate font-retro text-xs text-foreground">{token.name}</div>
                          <div className="text-xs text-muted-foreground">{token.ticker}</div>
                        </div>
                      </div>
                      <div className="shrink-0 text-right font-retro text-xs text-foreground">
                        {Number(token.balanceFormatted).toLocaleString(undefined, { maximumFractionDigits: 4 })}
                      </div>
                    </Link>
                  ))}
                </div>
              ) : (
                <div className="mt-2 text-sm text-muted-foreground">No launchpad token balances detected yet.</div>
              )}
            </div>
          </div>
        </CommandCenterCard>
      </div>
    </div>
  );
}
