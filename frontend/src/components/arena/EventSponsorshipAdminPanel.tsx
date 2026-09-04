import type { EventSponsorshipState } from "@/lib/arena/eventSponsorshipContracts";
import { presentEventSponsorship } from "@/lib/arena/eventSponsorshipPresentation.mjs";

export function EventSponsorshipAdminPanel({
  state,
  onViewSponsors,
  onSetOverride,
  onToggleOpen,
}: {
  state: EventSponsorshipState;
  onViewSponsors?: (eventId: string) => void;
  onSetOverride?: (eventId: string) => void;
  onToggleOpen?: (eventId: string, open: boolean) => void;
}) {
  const model = presentEventSponsorship(state);
  if (!model.sponsorable) return null;
  const eventId = model.eventId || state.eventId;

  return (
    <section data-event-sponsorship-admin="true" className="space-y-4 border border-white/10 bg-black/20 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-white/40">Event sponsorship control</div>
          <div className="mt-1 font-retro text-base text-white/90">{model.title}</div>
        </div>
        <div className="text-right text-[10px] uppercase tracking-[0.14em] text-white/45">
          <div>{model.status.label}</div>
          <div>{model.sponsorshipOpen ? "SPONSORSHIP OPEN" : "SPONSORSHIP CLOSED"}</div>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-4">
        <AdminMetric label="Chain" value={model.symbol || "—"} />
        <AdminMetric label="Minimum" value={model.minimumUsd != null ? `$${model.minimumUsd}` : "—"} />
        <AdminMetric label="Sponsors" value={String(model.sponsorCount)} />
        <AdminMetric
          label="Prize from sponsors"
          value={model.eventPrizeNative != null && model.symbol ? `${model.eventPrizeNative} ${model.symbol}` : "—"}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!onViewSponsors}
          onClick={() => onViewSponsors?.(eventId)}
          className="mwz-button min-h-10 px-3 text-[10px] uppercase tracking-[0.14em] disabled:cursor-not-allowed disabled:opacity-40"
        >
          View sponsors
        </button>
        <button
          type="button"
          disabled={!onSetOverride}
          onClick={() => onSetOverride?.(eventId)}
          className="mwz-button min-h-10 px-3 text-[10px] uppercase tracking-[0.14em] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Set price override
        </button>
        <button
          type="button"
          disabled={!onToggleOpen}
          onClick={() => onToggleOpen?.(eventId, !model.sponsorshipOpen)}
          className="min-h-10 px-3 text-[10px] uppercase tracking-[0.14em] text-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          {model.sponsorshipOpen ? "Close sponsorship" : "Open sponsorship"}
        </button>
      </div>

      <div className="text-[9px] uppercase tracking-[0.13em] text-white/35">
        Admin mutations remain disabled until Agent 3 publishes audited event-sponsorship admin APIs.
      </div>
    </section>
  );
}

function AdminMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-white/10 bg-black/25 p-3">
      <div className="text-[9px] uppercase tracking-[0.14em] text-white/35">{label}</div>
      <div className="mt-1 font-retro text-sm text-white/85">{value}</div>
    </div>
  );
}
