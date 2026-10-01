import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { FeedComposer } from "@/components/feed/FeedComposer";
import { FeedItemView } from "@/components/feed/FeedCards";
import { ProfilePostCard } from "@/components/profile/ProfilePostCard";
import type { ProfileTabKey } from "@/components/profile/ProfileShell";
import { formatCompactUsd } from "@/features/postgrad/warRoomMetrics";
import type { CampaignDraft } from "@/lib/draftApi";
import type { FeedItem } from "@/lib/feedApi";
import type { PublicPortfolioHolding } from "@/lib/profileApi";
import { tokenDetailsPath } from "@/lib/tokenDetailsPath";

export type ProfileCoin = {
  id?: number;
  image: string;
  name: string;
  ticker: string;
  campaignAddress: string;
  tokenAddress?: string | null;
  chainId?: number;
  marketCap?: string;
  progress?: string | null;
  status?: string | null;
  timeAgo?: string | null;
};

type Props = {
  tab: ProfileTabKey;
  isOwner: boolean;
  chainId: number;
  posts: FeedItem[];
  events: FeedItem[];
  coins: ProfileCoin[];
  drafts?: CampaignDraft[];
  holdings?: PublicPortfolioHolding[];
  loadingPosts?: boolean;
  loadingCoins?: boolean;
  loadingDrafts?: boolean;
  loadingHoldings?: boolean;
  loadingActivity?: boolean;
  activityError?: string | null;
  draftsError?: string | null;
  onPosted?: () => void;
};

export type CoinsFilterKey = "created" | "holdings" | "drafts";

const COIN_FILTERS: Array<{ key: CoinsFilterKey; label: string }> = [
  { key: "created", label: "Created" },
  { key: "holdings", label: "Holdings" },
  { key: "drafts", label: "Drafts" },
];

function draftHref(draft: CampaignDraft) {
  if (draft.status === "deployed" && (draft.tokenAddress || draft.campaignAddress)) {
    return `/token/${draft.tokenAddress || draft.campaignAddress}`;
  }
  return draft.slug ? `/prepare/${draft.slug}` : `/drafts/${draft.id}`;
}

export function authorsFromFeed(
  items: FeedItem[],
  excludeWallet?: string | null,
): Array<{ wallet: string; name?: string | null; avatar?: string | null }> {
  const seen = new Set<string>();
  const out: Array<{ wallet: string; name?: string | null; avatar?: string | null }> = [];
  const exclude = String(excludeWallet || "").trim().toLowerCase();
  for (const item of items) {
    const walletAddr = String(item.wallet || "").trim();
    if (!walletAddr) continue;
    const key = walletAddr.toLowerCase();
    if (seen.has(key)) continue;
    if (exclude && key === exclude) continue;
    seen.add(key);
    out.push({
      wallet: walletAddr,
      name: item.authorDisplayName,
      avatar: item.authorAvatarUrl,
    });
  }
  return out;
}

export function ProfileTimeline({
  tab,
  isOwner,
  chainId,
  posts,
  events,
  coins,
  drafts = [],
  holdings = [],
  loadingPosts,
  loadingCoins,
  loadingDrafts,
  loadingHoldings,
  loadingActivity,
  activityError,
  draftsError,
  onPosted,
}: Props) {
  const navigate = useNavigate();
  const [coinsFilter, setCoinsFilter] = useState<CoinsFilterKey>("created");
  const topHoldings = holdings.filter((row) => !row.isNative).slice(0, 3);
  const topHoldingsFallback = topHoldings.length ? topHoldings : holdings.slice(0, 3);

  if (tab === "posts") {
    return (
      <div data-profile-tab-panel="posts">
        {isOwner ? (
          <div className="border-b border-border/40 px-4 py-4">
            <FeedComposer
              chainId={chainId}
              onPosted={onPosted}
              compact
              placeholder="Drop your payload"
            />
          </div>
        ) : null}
        {loadingPosts && !posts.length ? (
          <div className="px-4 py-8 text-sm text-muted-foreground">Loading posts...</div>
        ) : posts.length ? (
          posts.map((item) => <ProfilePostCard key={item.id} item={item} />)
        ) : (
          <div className="px-4 py-8 text-sm text-muted-foreground">
            {isOwner ? "No posts yet. Drop your payload." : "No public posts yet."}
          </div>
        )}
      </div>
    );
  }

  if (tab === "coins") {
    return (
      <div data-profile-tab-panel="coins" className="space-y-4 px-4 py-4">
        {topHoldingsFallback.length ? (
          <div data-profile-top-holdings="true">
            <div className="mb-2 font-retro text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Top holdings</div>
            <div className="flex flex-wrap gap-2">
              {topHoldingsFallback.map((holding) => (
                <span
                  key={`${holding.tokenAddress || holding.ticker}-${holding.isNative ? "native" : "token"}`}
                  className="rounded-full border border-border/60 px-2.5 py-1 text-xs text-foreground"
                >
                  ${holding.ticker}
                  {holding.valueUsd && holding.valueUsd > 0 ? (
                    <span className="ml-1 text-muted-foreground">{formatCompactUsd(holding.valueUsd)}</span>
                  ) : null}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-1" data-profile-coins-filter="true">
          {COIN_FILTERS.map((item) => {
            const on = coinsFilter === item.key;
            return (
              <button
                key={item.key}
                type="button"
                data-coins-filter={item.key}
                onClick={() => setCoinsFilter(item.key)}
                className={
                  on
                    ? "rounded-full bg-accent px-3 py-1.5 font-retro text-xs text-accent-foreground"
                    : "rounded-full border border-border/60 px-3 py-1.5 font-retro text-xs text-muted-foreground"
                }
              >
                {item.label}
              </button>
            );
          })}
        </div>

        {coinsFilter === "created" ? (
          loadingCoins ? (
            <div className="text-sm text-muted-foreground">Loading coins...</div>
          ) : coins.length ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {coins.map((coin) => (
                <button
                  key={coin.campaignAddress}
                  type="button"
                  onClick={() =>
                    navigate(
                      tokenDetailsPath({
                        tokenAddress: coin.tokenAddress,
                        campaignAddress: coin.campaignAddress,
                        chainId: coin.chainId,
                      }),
                    )
                  }
                  className="rounded-xl border border-border/40 bg-background/30 p-4 text-left transition hover:border-accent/50"
                >
                  <div className="flex items-center gap-3">
                    <img src={coin.image} alt={coin.name} className="h-11 w-11 rounded-none object-cover" />
                    <div className="min-w-0">
                      <div className="truncate font-retro text-sm text-foreground">{coin.name}</div>
                      <div className="text-xs text-muted-foreground">${coin.ticker}</div>
                    </div>
                  </div>
                  <div className="mt-3 flex justify-between text-xs text-muted-foreground">
                    <span className="capitalize">{coin.status ?? "live"}</span>
                    <span>{coin.marketCap || "—"}</span>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">No public created coins yet.</div>
          )
        ) : null}

        {coinsFilter === "holdings" ? (
          loadingHoldings ? (
            <div className="text-sm text-muted-foreground">Loading holdings...</div>
          ) : holdings.length ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {holdings.map((holding) => {
                const clickable = !holding.isNative && (holding.tokenAddress || holding.campaignAddress);
                return (
                  <button
                    key={`${holding.tokenAddress || holding.ticker}-${holding.isNative ? "native" : "token"}`}
                    type="button"
                    disabled={!clickable}
                    onClick={() => {
                      if (!clickable) return;
                      navigate(
                        tokenDetailsPath({
                          tokenAddress: holding.tokenAddress,
                          campaignAddress: holding.campaignAddress,
                          chainId,
                        }),
                      );
                    }}
                    className="rounded-xl border border-border/40 bg-background/30 p-4 text-left transition hover:border-accent/50 disabled:hover:border-border/40"
                  >
                    <div className="flex items-center gap-3">
                      <img
                        src={holding.image || "/placeholder.svg"}
                        alt={holding.name || holding.ticker}
                        className="h-11 w-11 rounded-none object-cover"
                      />
                      <div className="min-w-0">
                        <div className="truncate font-retro text-sm text-foreground">{holding.name || holding.ticker}</div>
                        <div className="text-xs text-muted-foreground">${holding.ticker}</div>
                      </div>
                    </div>
                    <div className="mt-3 flex justify-between text-xs text-muted-foreground">
                      <span>
                        {(() => {
                          const bal = Number(holding.balanceFormatted);
                          return Number.isFinite(bal)
                            ? bal.toLocaleString(undefined, { maximumFractionDigits: 4 })
                            : holding.balanceFormatted || "—";
                        })()}
                      </span>
                      <span>
                        {holding.valueUsd && holding.valueUsd > 0 ? formatCompactUsd(holding.valueUsd) : "—"}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">No holdings detected yet.</div>
          )
        ) : null}

        {coinsFilter === "drafts" ? (
          loadingDrafts ? (
            <div className="text-sm text-muted-foreground">Loading drafts...</div>
          ) : draftsError ? (
            <div className="text-sm text-destructive">{draftsError}</div>
          ) : drafts.length ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {drafts.map((draft) => (
                <button
                  key={draft.id}
                  type="button"
                  onClick={() => navigate(draftHref(draft))}
                  className="rounded-xl border border-border/40 bg-background/30 p-4 text-left transition hover:border-accent/50"
                >
                  <div className="flex items-center gap-3">
                    <img src={draft.logoUrl || "/placeholder.svg"} alt={draft.name} className="h-11 w-11 rounded-none object-cover" />
                    <div className="min-w-0">
                      <div className="truncate font-retro text-sm text-foreground">{draft.name}</div>
                      <div className="text-xs text-muted-foreground">${draft.ticker}</div>
                    </div>
                  </div>
                  <div className="mt-3 text-xs capitalize text-muted-foreground">{draft.status.replace(/_/g, " ")}</div>
                </button>
              ))}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              {isOwner ? "No drafts yet." : "No public drafts yet."}
            </div>
          )
        ) : null}
      </div>
    );
  }

  return (
    <div data-profile-tab-panel="activity">
      {loadingActivity && !events.length ? (
        <div className="px-4 py-8 text-sm text-muted-foreground">Loading activity...</div>
      ) : activityError ? (
        <div className="px-4 py-8 text-sm text-destructive">{activityError}</div>
      ) : events.length ? (
        <div className="divide-y divide-border/40">
          {events.map((item) => (
            <div key={item.id} className="px-2">
              <FeedItemView item={item} />
            </div>
          ))}
        </div>
      ) : (
        <div className="px-4 py-8 text-sm text-muted-foreground">No public drafts, deploys, or trades yet.</div>
      )}
    </div>
  );
}
