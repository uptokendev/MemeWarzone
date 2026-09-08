/**
 * Fixed Featured top-left sponsorship cell — full-bleed creative only.
 * House ad: soft centered "Advertise here". Paid: small bottom title overlay.
 */
import { resolveImageUri } from "@/lib/media";

export type FeaturedSponsorPlacement = {
  id?: string | null;
  name?: string | null;
  imageUrl?: string | null;
  logoUri?: string | null;
  targetUrl?: string | null;
  websiteUrl?: string | null;
  bio?: string | null;
  placementLabel?: string | null;
  slotCode?: string | null;
  /** House inventory — opens apply dialog instead of external link. */
  isHouseAd?: boolean;
};

export const FEATURED_HOUSE_AD: FeaturedSponsorPlacement = {
  id: "house-advertise-featured",
  name: "Advertise here",
  bio: null,
  imageUrl: "/assets/memewarzone.png",
  logoUri: "/assets/memewarzone.png",
  placementLabel: "Sponsored",
  slotCode: "featured-top-left",
  isHouseAd: true,
};

function usefulImage(value: unknown) {
  const raw = String(value ?? "").trim();
  return Boolean(raw && raw !== "/placeholder.svg" && raw !== "-");
}

export function SponsoredFeaturedSlotCard({
  placement,
  className = "",
  onHouseAdClick,
  onAdvertisementClick,
  plainBorder = false,
}: {
  placement: FeaturedSponsorPlacement;
  className?: string;
  onHouseAdClick?: () => void;
  onAdvertisementClick?: () => void;
  /** Square orange border — no HUD cut-corners. */
  plainBorder?: boolean;
}) {
  const title = String(placement.name || "Sponsored").trim() || "Sponsored";
  const imageRaw = placement.imageUrl || placement.logoUri;
  const image = usefulImage(imageRaw) ? resolveImageUri(String(imageRaw)) : null;
  const href = String(placement.targetUrl || placement.websiteUrl || "").trim();
  const isHouse = Boolean(placement.isHouseAd);
  const clickable = isHouse || Boolean(href);

  const open = () => {
    if (isHouse) {
      onHouseAdClick?.();
      return;
    }
    if (!href) return;
    try {
      window.open(href, "_blank", "noopener,noreferrer");
    } catch {
      // ignore
    }
  };

  return (
    <div
      className={`${plainBorder ? "border-orange-400/25 hover:border-orange-300/70 ![clip-path:none] before:!hidden after:!hidden" : "mwz-hud-frame border-amber-400/40 hover:border-amber-300/70 hover:shadow-[0_0_18px_rgba(251,191,36,0.16)]"} group relative flex h-[150px] w-full snap-start overflow-hidden rounded-none border bg-black transition ${clickable ? "cursor-pointer" : ""} ${className}`}
      style={plainBorder ? { clipPath: "none" } : undefined}
      role={clickable ? "button" : "article"}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? open : undefined}
      onKeyDown={(event) => {
        if (!clickable) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      }}
      aria-label={isHouse ? "Advertise here — open sponsorship application" : `Sponsored: ${title}`}
    >
      {/* Inner wrap: .mwz-hud-frame > * is forced to position:relative, which
          would crush an absolute Advertisement pill into a 1px strip. */}
      <div className="relative h-full w-full">
        <img
          src={image || "/placeholder.svg"}
          alt=""
          className="absolute inset-0 h-full w-full object-cover transition duration-500 group-hover:scale-[1.04]"
          draggable={false}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={(event) => {
            const el = event.currentTarget;
            if (el.dataset.fallbackApplied === "1") return;
            el.dataset.fallbackApplied = "1";
            el.src = "/placeholder.svg";
          }}
        />

        <button
          type="button"
          className={`absolute right-2 top-2 z-20 max-w-[calc(100%-1rem)] truncate border border-white/25 bg-black/80 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-white ${onAdvertisementClick ? "hover:border-orange-300/70 hover:text-orange-200" : "cursor-default"}`}
          aria-label="Advertisement"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onAdvertisementClick?.();
          }}
        >
          <span className="sm:hidden">Ad</span>
          <span className="hidden sm:inline">Advertisement</span>
        </button>

        {isHouse ? (
          <>
            <div className="absolute inset-0 bg-black/35 transition group-hover:bg-black/40" />
            <div className="absolute inset-0 flex items-center justify-center p-4">
              <span className="text-center text-[20px] font-semibold tracking-wide text-white/90 drop-shadow-[0_2px_12px_rgba(0,0,0,0.85)] group-hover:text-white md:text-[22px]">
                Advertise here
              </span>
            </div>
          </>
        ) : (
          <>
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/80 via-black/40 to-transparent" />
            <div className="absolute inset-x-0 bottom-0 z-10 px-3 pb-2.5 pt-6">
              <div className="truncate text-[13px] font-semibold leading-tight text-white/95 drop-shadow-[0_1px_6px_rgba(0,0,0,0.9)]">
                {title}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default SponsoredFeaturedSlotCard;
