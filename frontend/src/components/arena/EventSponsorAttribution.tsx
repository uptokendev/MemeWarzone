import type { PublicEventSponsor } from "@/hooks/useEventSponsors";
import { cn } from "@/lib/utils";

type Variant = "compact" | "prominent" | "premium";

function SponsorIdentity({ sponsor, compact }: { sponsor: PublicEventSponsor; compact?: boolean }) {
  const body = (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {sponsor.logoUrl ? (
        <img
          src={sponsor.logoUrl}
          alt=""
          loading="lazy"
          className={cn("shrink-0 rounded-full object-cover", compact ? "h-4 w-4" : "h-6 w-6")}
        />
      ) : null}
      <span className="truncate font-black text-foreground">{sponsor.projectName}</span>
      {sponsor.foundingSponsor ? (
        <span className="shrink-0 text-[9px] uppercase tracking-[0.12em] text-orange-300">
          {sponsor.foundingSponsorBadge || "Founding sponsor"}
        </span>
      ) : null}
    </span>
  );

  if (!sponsor.websiteUrl) return body;
  return (
    <a href={sponsor.websiteUrl} target="_blank" rel="noopener noreferrer" className="hover:text-accent hover:underline">
      {body}
    </a>
  );
}

export function EventSponsorAttribution({
  sponsors,
  variant = "compact",
  className,
}: {
  sponsors?: PublicEventSponsor[] | null;
  variant?: Variant;
  className?: string;
}) {
  if (!sponsors?.length) return null;
  const compact = variant === "compact";
  const label = variant === "premium" ? "PRESENTED BY" : variant === "prominent" ? "THIS TOURNAMENT IS SPONSORED BY" : "SPONSORED BY";

  return (
    <div
      data-event-sponsor-attribution={variant}
      className={cn(
        compact
          ? "mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px] uppercase tracking-[0.14em] text-white/50"
          : "mt-2 border-l-2 border-orange-400/60 pl-3 text-[10px] uppercase tracking-[0.18em] text-white/50",
        className,
      )}
    >
      <span className={cn("shrink-0", variant === "premium" && "text-orange-200")}>{label}</span>
      <span className={cn("flex min-w-0 flex-wrap items-center gap-2", !compact && "mt-1")}> 
        {sponsors.map((sponsor, index) => (
          <span key={sponsor.sponsorProfileId} className="inline-flex min-w-0 items-center gap-2 normal-case tracking-normal">
            {index > 0 ? <span aria-hidden="true" className="text-white/35">·</span> : null}
            <SponsorIdentity sponsor={sponsor} compact={compact} />
          </span>
        ))}
      </span>
    </div>
  );
}
