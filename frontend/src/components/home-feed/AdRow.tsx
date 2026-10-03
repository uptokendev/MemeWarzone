import { useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/apiBase";
import { resolveImageUri } from "@/lib/media";
import { tokenDetailsPath } from "@/lib/tokenDetailsPath";

/** Ad slot for the row at the top of Home (CO-21, founder 2026-10-03). Booked in the web-dashboard ads manager. */
export const HOME_TOP_ROW_SLOT = "home-top-row";
const SPOTS = 6;

type AdItem = {
  id: string;
  name?: string | null;
  bannerUrl?: string | null;
  imageUrl?: string | null;
  logoUri?: string | null;
  targetUrl?: string | null;
  websiteUrl?: string | null;
  campaignAddress?: string | null;
  tokenAddress?: string | null;
  chainId?: number | null;
  isHouseAd?: boolean;
  placementType?: string | null;
};

async function loadAds(chainId: number): Promise<AdItem[]> {
  const qs = new URLSearchParams({ chainId: String(chainId), slot: HOME_TOP_ROW_SLOT, limit: String(SPOTS) });
  const res = await apiFetch(`/api/sponsored?${qs.toString()}`, { cache: "no-store" });
  if (!res.ok) return [];
  const json = await res.json().catch(() => null);
  const items: AdItem[] = Array.isArray(json?.items) ? json.items : [];
  return items.filter((item) => !item.isHouseAd && String(item.placementType || "") !== "house").slice(0, SPOTS);
}

function isTokenAddress(value?: string | null) {
  const v = String(value || "").trim();
  return /^0x[0-9a-fA-F]{40}$/.test(v) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
}

const tileClass = "mw-focus relative block h-[90px] w-[240px] shrink-0 overflow-hidden rounded-xl border border-mw-border bg-mw-input";

function AdTile({ ad, hidden }: { ad: AdItem; hidden?: boolean }) {
  const image = resolveImageUri(ad.bannerUrl || ad.imageUrl || ad.logoUri || "") || "";
  const href = String(ad.targetUrl || ad.websiteUrl || "").trim();
  const body = (
    <>
      {image ? (
        <img src={image} alt={hidden ? "" : ad.name || "Sponsored"} className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <span className="flex h-full w-full items-center justify-center px-3 text-center font-mw-cond text-lg font-bold text-mw-text">{ad.name || "Sponsored"}</span>
      )}
      <span className="absolute right-1.5 top-1.5 rounded-full bg-[rgba(5,6,8,0.7)] px-1.5 py-0.5 text-[10px] font-semibold text-[#C9CED4]">Ad</span>
    </>
  );
  const a11y = { "aria-hidden": hidden || undefined, tabIndex: hidden ? -1 : undefined } as const;
  if (/^https?:\/\//i.test(href)) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer sponsored" className={`${tileClass} hover:border-[#3A424C]`} {...a11y}>
        {body}
      </a>
    );
  }
  const token = isTokenAddress(ad.tokenAddress) ? ad.tokenAddress : isTokenAddress(ad.campaignAddress) ? ad.campaignAddress : null;
  if (token) {
    return (
      <Link to={tokenDetailsPath({ tokenAddress: token, campaignAddress: ad.campaignAddress || undefined, chainId: Number(ad.chainId || 0) || undefined })} className={`${tileClass} hover:border-[#3A424C]`} {...a11y}>
        {body}
      </Link>
    );
  }
  return <span className={tileClass} {...a11y}>{body}</span>;
}

function HouseTile({ hidden }: { hidden?: boolean }) {
  return (
    <Link
      to={`/sponsorships/apply?slot=${HOME_TOP_ROW_SLOT}`}
      aria-hidden={hidden || undefined}
      tabIndex={hidden ? -1 : undefined}
      className="mw-focus flex h-[90px] w-[240px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl border border-dashed border-[#3A424C] bg-mw-input text-center hover:border-mw-accent"
    >
      <span className="font-mw-cond text-lg font-bold text-mw-text">Your ad here</span>
      <span className="text-[13px] text-mw-accent-soft">Book this spot</span>
    </Link>
  );
}

/**
 * Row of up to 6 ad spots at the top of Home, same height as the story row it replaces (CO-21).
 * Paid ads first, then one "Your ad here" tile while a spot is free. Scrolls as a ticker only when
 * the tiles do not fit the width.
 */
export function AdRow({ chainId }: { chainId: number }) {
  const ads = useQuery({ queryKey: ["home-top-row-ads", chainId], queryFn: () => loadAds(chainId), staleTime: 60_000, retry: 1 }).data || [];
  // Founder 2026-10-03: paid ads, then a single "Your ad here" while a spot is free (never a row of them).
  const spots: Array<AdItem | null> = ads.length < SPOTS ? [...ads, null] : ads;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [slides, setSlides] = useState(false);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const track = trackRef.current;
    if (!wrap || !track || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      // One copy of the tiles is the first half of the track while sliding.
      const oneCopy = slides ? track.scrollWidth / 2 : track.scrollWidth;
      setSlides(oneCopy > wrap.clientWidth + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [slides, ads.length]);

  const render = (hidden: boolean, prefix: string) =>
    spots.map((ad, i) => (ad ? <AdTile key={`${prefix}-${ad.id}-${i}`} ad={ad} hidden={hidden} /> : <HouseTile key={`${prefix}-house-${i}`} hidden={hidden} />));

  return (
    <section
      aria-label="Sponsored"
      data-ad-slot={HOME_TOP_ROW_SLOT}
      className={`${slides ? "mw-marquee" : ""} overflow-hidden border-b border-[#1E2329] py-3.5 lg:rounded-[14px] lg:border lg:border-mw-border lg:bg-mw-surface`}
    >
      <div ref={wrapRef} className="overflow-hidden px-3.5">
        <div ref={trackRef} className={`${slides ? "mw-marquee-track w-max" : ""} flex gap-2`}>
          {render(false, "a")}
          {slides ? render(true, "b") : null}
        </div>
      </div>
    </section>
  );
}
