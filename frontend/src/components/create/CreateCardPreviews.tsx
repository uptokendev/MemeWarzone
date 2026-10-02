/**
 * Presentational Launchpad card previews for the Create wizard.
 * CO-24 (founder, 2026-10-03): both previews use the redesign campaign card
 * (`components/home/CampaignCard.tsx`), drawn statically: no navigation, follow or upvote.
 */
import { Flame, Star } from "lucide-react";
import { cn } from "@/lib/utils";

function shortAddr(addr?: string) {
  if (!addr) return "—";
  const a = String(addr);
  return a.length > 10 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a;
}

function PreviewShell({
  logo,
  name,
  chipLeft,
  chipLeftClass,
  chipRight,
  className,
  children,
}: {
  logo: string;
  name: string;
  chipLeft: string;
  chipLeftClass: string;
  chipRight: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <article
      aria-label={`${name} card preview`}
      className={cn(
        "relative flex w-full max-w-[240px] flex-col overflow-hidden rounded-[14px] border border-mw-border bg-mw-surface font-mw-body text-mw-text",
        className,
      )}
    >
      <div className="relative h-[150px] w-full overflow-hidden bg-[#2A1609]">
        <img src={logo} alt={name} className="h-full w-full object-cover" draggable={false} />
        <div className={cn("absolute left-2.5 top-2.5 inline-flex h-[22px] items-center rounded-full bg-[rgba(0,0,0,0.55)] px-2 text-xs font-semibold", chipLeftClass)}>
          {chipLeft}
        </div>
        <div className="absolute right-2.5 top-2.5 inline-flex h-[22px] items-center gap-1 rounded-full bg-[rgba(0,0,0,0.55)] px-2 font-mw-mono text-xs text-[#C9CED4]">
          {chipRight}
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">{children}</div>
    </article>
  );
}

function FollowStar() {
  return (
    <span aria-hidden="true" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-mw-edge bg-mw-raised">
      <Star className="h-4 w-4 text-mw-muted" />
    </span>
  );
}

export function CreateDraftCardPreview({
  name,
  ticker,
  logoUrl,
  mission,
  creatorWallet,
  className,
}: {
  name: string;
  ticker: string;
  logoUrl?: string;
  mission?: string;
  creatorWallet?: string;
  className?: string;
}) {
  const logo = logoUrl?.trim() || "/placeholder.svg";
  const displayName = name.trim() || "Your coin name";
  const displayTicker = ticker.trim() ? `$${ticker.trim().replace(/^\$/, "")}` : "$TICKER";
  const blurb = mission?.trim() || "Your short description will appear here once you write it.";

  return (
    <PreviewShell
      logo={logo}
      name={displayName}
      chipLeft="Draft"
      chipLeftClass="text-[#6EE7A0]"
      chipRight={<><Flame className="h-3 w-3" aria-hidden="true" />Cold</>}
      className={className}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-bold text-mw-text">{displayName}</span>
        <FollowStar />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-[13px] text-mw-muted">
        <span className="font-mw-mono">{displayTicker}</span>
        <span>· now</span>
        <span className="min-w-0 truncate">· <span className="font-mw-mono text-mw-accent-soft">{shortAddr(creatorWallet)}</span></span>
      </div>
      <p className="m-0 line-clamp-3 text-[13px] leading-snug text-mw-muted">{blurb}</p>
      <div className="flex items-center justify-between gap-2 font-mw-mono text-[13px]">
        <span className="text-mw-muted">Watchlist <b className="text-mw-text">0</b></span>
        <span className="text-mw-muted">Heat <b className="text-mw-text">0%</b></span>
      </div>
      <div className="mt-auto pt-1">
        <span className="inline-flex h-10 w-full items-center justify-center rounded-[10px] border border-mw-edge bg-mw-raised text-sm font-semibold text-mw-text">
          Promotion page
        </span>
      </div>
    </PreviewShell>
  );
}

/** The Coins page CampaignCard, decorative only (no nav / follow / upvote). */
export function CreateLiveCardPreview({
  name,
  symbol,
  logoUrl,
  creator,
  description,
  className,
}: {
  name: string;
  symbol: string;
  logoUrl?: string;
  creator?: string;
  description?: string;
  className?: string;
}) {
  const logo = logoUrl?.trim() || "/placeholder.svg";
  const displayName = name.trim() || "Your coin name";
  const displaySymbol = symbol.trim() ? `$${symbol.trim().replace(/^\$/, "")}` : "$TICKER";
  const blurb = description?.trim();

  return (
    <PreviewShell
      logo={logo}
      name={displayName}
      chipLeft="LIVE"
      chipLeftClass="text-mw-accent-soft"
      chipRight={<><Flame className="h-3 w-3" aria-hidden="true" />0/24h</>}
      className={className}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-bold text-mw-text">{displayName}</span>
        <FollowStar />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-[13px] text-mw-muted">
        <span className="font-mw-mono">{displaySymbol}</span>
        <span>· now</span>
        <span className="min-w-0 truncate">· <span className="font-mw-mono text-mw-accent-soft">{shortAddr(creator)}</span></span>
      </div>
      {blurb ? <p className="m-0 line-clamp-2 text-[13px] leading-snug text-mw-muted">{blurb}</p> : null}
      <div className="flex items-center justify-between gap-2 font-mw-mono text-[13px]">
        <span className="text-mw-muted">MCap <b className="text-mw-text">—</b></span>
        <span className="text-mw-muted">Curve <b className="text-mw-text">0%</b></span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-mw-border" aria-hidden="true" />
      <div className="flex items-center justify-between gap-2 text-xs text-mw-muted">
        <span>ATH —</span>
        <span>0%</span>
      </div>
      <div className="mt-auto pt-1">
        <span className="inline-flex h-10 w-full items-center justify-center rounded-[10px] border border-mw-edge bg-mw-raised text-sm font-semibold text-mw-text">
          UpVote
        </span>
      </div>
    </PreviewShell>
  );
}
