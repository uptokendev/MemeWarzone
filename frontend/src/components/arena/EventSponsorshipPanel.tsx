import { ExternalLink, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { EventSponsorshipState } from "@/lib/arena/eventSponsorshipContracts";
import { presentEventSponsorship } from "@/lib/arena/eventSponsorshipPresentation.mjs";

export function EventSponsorshipPanel({
  state,
  onSponsorEvent,
}: {
  state: EventSponsorshipState;
  onSponsorEvent?: (eventId: string) => void;
}) {
  const model = presentEventSponsorship(state);
  if (!model.sponsorable) return null;

  return (
    <section
      data-event-sponsorship-panel="true"
      className="space-y-4 border-t pt-4"
      style={{ borderColor: "var(--mwz-flat-card-border)" }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.2em] text-white/45">Presented with</div>
          <div className="mt-1 font-retro text-lg text-white/90">Event sponsorship</div>
          <div className="mt-1 text-[10px] uppercase tracking-[0.14em] text-white/45">{model.paymentRuleLabel}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            data-event-sponsorship-open={model.sponsorshipOpen ? "true" : "false"}
            className={`px-2 py-1 text-[10px] uppercase tracking-[0.16em] ${
              model.sponsorshipOpen ? "border border-orange-400/50 text-orange-200" : "border border-white/15 text-white/45"
            }`}
          >
            {model.sponsorshipOpen ? "OPEN" : "CLOSED"}
          </span>
          {model.sponsorshipOpen ? (
            <Button
              type="button"
              size="sm"
              className="mwz-button mwz-button-orange font-retro min-h-11"
              disabled={!onSponsorEvent}
              onClick={() => onSponsorEvent?.(model.eventId || state.eventId)}
            >
              Sponsor event
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-2 text-[10px] uppercase tracking-[0.14em] text-white/48 sm:grid-cols-3">
        <div className="border border-white/10 bg-black/20 p-3">
          <div className="text-white/35">Minimum</div>
          <div className="mt-1 font-retro text-sm text-white/85">
            {model.minimumUsd != null ? `$${model.minimumUsd}` : "Authoritative quote required"}
          </div>
        </div>
        <div className="border border-white/10 bg-black/20 p-3">
          <div className="text-white/35">Prize contribution</div>
          <div className="mt-1 font-retro text-sm text-white/85">
            {model.eventPrizeNative != null && model.symbol
              ? `${model.eventPrizeNative} ${model.symbol}`
              : "—"}
          </div>
        </div>
        <div className="border border-white/10 bg-black/20 p-3">
          <div className="text-white/35">Split</div>
          <div className="mt-1 font-retro text-[11px] text-white/85">70 / 20 / 10</div>
        </div>
      </div>

      {model.sponsors.length ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {model.sponsors.map((sponsor, index) => (
            <article
              key={sponsor.id || `${sponsor.projectName}-${index}`}
              data-event-founding-sponsor={sponsor.foundingSponsor ? "true" : undefined}
              className={`border bg-black/20 p-3 ${sponsor.foundingSponsor ? "border-orange-400/45" : "border-white/10"}`}
              style={sponsor.foundingSponsor ? { boxShadow: "inset 2px 0 0 rgba(240,106,26,0.85)" } : undefined}
            >
              <div className="flex items-center gap-3">
                {sponsor.logoUrl ? (
                  <img src={sponsor.logoUrl} alt="" className="h-10 w-10 shrink-0 object-cover" />
                ) : (
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center border border-white/10 bg-white/5">
                    <ShieldCheck className="h-4 w-4 text-white/45" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-retro text-sm text-white/90">{sponsor.projectName}</div>
                  <div className={`text-[10px] uppercase tracking-[0.14em] ${sponsor.foundingSponsor ? "text-orange-200" : "text-amber-200/75"}`}>
                    {sponsor.badgeLabel}
                  </div>
                </div>
                {sponsor.websiteUrl ? (
                  <a
                    href={sponsor.websiteUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open ${sponsor.projectName} website`}
                    className="text-white/45 hover:text-accent"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </a>
                ) : null}
              </div>
              {sponsor.contributionLabel ? (
                <div className="mt-3 text-xs text-white/55">{sponsor.contributionLabel}</div>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <div className="text-xs text-white/45">No confirmed event sponsors yet.</div>
      )}

      <div className="space-y-1 text-[10px] uppercase tracking-[0.13em] text-white/42">
        <div>{model.splitLabel}</div>
        <div>{model.competitiveIntegrityLabel}</div>
        {!onSponsorEvent ? (
          <div className="mt-2 border border-white/10 bg-black/30 px-2 py-2 text-white/50">
            Payment flow remains locked until the authoritative event-sponsorship runtime is available.
          </div>
        ) : null}
      </div>
    </section>
  );
}
