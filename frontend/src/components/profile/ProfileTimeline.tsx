import { useNavigate } from "react-router-dom";
import { FeedComposer } from "@/components/feed/FeedComposer";
import { FeedItemView } from "@/components/feed/FeedCards";
import { ProfilePostCard } from "@/components/profile/ProfilePostCard";
import type { ProfileTabKey } from "@/components/profile/ProfileShell";
import type { CampaignDraft } from "@/lib/draftApi";
import type { FeedItem } from "@/lib/feedApi";
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
  loadingPosts?: boolean;
  loadingCoins?: boolean;
  loadingDrafts?: boolean;
  loadingActivity?: boolean;
  activityError?: string | null;
  draftsError?: string | null;
  onPosted?: () => void;
};

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
  loadingPosts,
  loadingCoins,
  loadingDrafts,
  loadingActivity,
  activityError,
  draftsError,
  onPosted,
}: Props) {
  const navigate = useNavigate();

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
        {loadingCoins ? (
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
        )}

        {drafts.length || loadingDrafts || draftsError ? (
          <div className="pt-2">
            <div className="mb-3 font-retro text-xs uppercase tracking-[0.16em] text-muted-foreground">Drafts</div>
            {loadingDrafts ? (
              <div className="text-sm text-muted-foreground">Loading drafts...</div>
            ) : draftsError ? (
              <div className="text-sm text-destructive">{draftsError}</div>
            ) : (
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
            )}
          </div>
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
