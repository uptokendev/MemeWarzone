import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  EventSponsorshipQuote,
  EventSponsorshipState,
  EventSponsorshipTransport,
} from "@/lib/arena/eventSponsorshipContracts";
import {
  presentEventSponsorship,
  presentEventSponsorshipQuote,
} from "@/lib/arena/eventSponsorshipPresentation.mjs";

export function EventSponsorshipFlow({
  sponsorWallet,
  transport,
  onApply,
}: {
  sponsorWallet?: string | null;
  transport?: EventSponsorshipTransport | null;
  onApply?: (eventId: string) => void;
}) {
  const [events, setEvents] = useState<EventSponsorshipState[]>([]);
  const [eventId, setEventId] = useState("");
  const [requestedUsd, setRequestedUsd] = useState("");
  const [quote, setQuote] = useState<EventSponsorshipQuote | null>(null);
  const [loading, setLoading] = useState(Boolean(transport));
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(!transport);

  useEffect(() => {
    if (!transport) {
      setUnavailable(true);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    transport
      .getOptions(controller.signal)
      .then((items) => {
        const sponsorable = items.filter((item) => presentEventSponsorship(item).sponsorable);
        setEvents(sponsorable);
        setEventId((current) => current || sponsorable[0]?.eventId || "");
        setUnavailable(false);
      })
      .catch(() => setUnavailable(true))
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [transport]);

  const selected = useMemo(() => events.find((event) => event.eventId === eventId) || null, [eventId, events]);
  const eventModel = useMemo(() => (selected ? presentEventSponsorship(selected) : null), [selected]);
  const quoteModel = useMemo(() => presentEventSponsorshipQuote(quote || {}), [quote]);
  const approved = selected?.status === "approved" || selected?.status === "payment_pending" || selected?.status === "paid" || selected?.status === "scheduled" || selected?.status === "active";

  async function requestQuote() {
    if (!transport || !selected || !sponsorWallet || !approved) return;
    setBusy(true);
    try {
      const next = await transport.getQuote({
        eventId: selected.eventId,
        sponsorWallet,
        requestedUsd: requestedUsd.trim() || null,
      });
      setQuote(next);
    } catch (error) {
      toast.error(String((error as Error)?.message || "Could not load sponsorship quote."));
      setQuote(null);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <div className="text-xs text-white/45">Loading sponsorable events…</div>;
  }

  if (unavailable || !transport) {
    return (
      <section data-event-sponsorship-runtime="unavailable" className="space-y-2 border border-white/10 bg-black/20 p-4">
        <div className="font-retro text-sm text-white/85">Sponsor an event</div>
        <div className="text-xs text-white/45">Event sponsorship runtime is not available yet. The existing advertising sponsorship product is unchanged.</div>
      </section>
    );
  }

  if (!events.length) {
    return <div className="text-xs text-white/45">No sponsorable MemeWarzone events are open right now.</div>;
  }

  return (
    <section data-event-sponsorship-flow="true" className="space-y-4 border border-white/10 bg-black/20 p-4">
      <div>
        <div className="text-[10px] uppercase tracking-[0.2em] text-white/40">Sponsor an event</div>
        <div className="mt-1 font-retro text-lg text-white/90">Fund the prize pool. Never the outcome.</div>
      </div>

      <label className="block space-y-2">
        <span className="text-[10px] uppercase tracking-[0.14em] text-white/45">Eligible event</span>
        <select
          value={eventId}
          onChange={(event) => {
            setEventId(event.target.value);
            setQuote(null);
          }}
          className="h-11 w-full border border-white/10 bg-black px-3 text-sm text-white/85"
        >
          {events.map((event) => {
            const model = presentEventSponsorship(event);
            return <option key={event.eventId} value={event.eventId}>{model.title} · {model.symbol || "CHAIN"}</option>;
          })}
        </select>
      </label>

      {eventModel ? (
        <div className="grid gap-2 sm:grid-cols-3">
          <FlowMetric label="Minimum" value={eventModel.minimumUsd != null ? `$${eventModel.minimumUsd}` : "Server quote"} />
          <FlowMetric label="Payment asset" value={eventModel.symbol || "Native"} />
          <FlowMetric label="Status" value={eventModel.status.label} />
        </div>
      ) : null}

      {!approved ? (
        <div className="space-y-2 border border-amber-400/20 bg-amber-500/5 p-3">
          <div className="text-xs text-amber-100/80">Sponsor approval comes before payment.</div>
          <Button type="button" variant="outline" size="sm" className="font-retro" disabled={!onApply || !selected} onClick={() => selected && onApply?.(selected.eventId)}>
            Apply to sponsor this event
          </Button>
        </div>
      ) : (
        <>
          <label className="block space-y-2">
            <span className="text-[10px] uppercase tracking-[0.14em] text-white/45">Contribution in USD reference</span>
            <Input
              inputMode="decimal"
              value={requestedUsd}
              onChange={(event) => setRequestedUsd(event.target.value)}
              placeholder={eventModel?.minimumUsd != null ? `Minimum $${eventModel.minimumUsd}` : "Enter contribution"}
              className="h-11 border-white/10 bg-black text-white/85"
            />
          </label>
          <Button type="button" size="sm" className="mwz-button font-retro" disabled={!sponsorWallet || busy} onClick={() => void requestQuote()}>
            {busy ? "Loading quote…" : sponsorWallet ? "Get native quote" : "Connect event-chain wallet"}
          </Button>
        </>
      )}

      {quoteModel.valid ? (
        <div className="space-y-3 border border-white/10 bg-black/30 p-3" data-event-sponsorship-quote="true">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10px] uppercase tracking-[0.14em] text-white/40">You pay</span>
            <span className="font-retro text-lg text-white/90">{quoteModel.grossNative} {quoteModel.symbol}</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <FlowMetric label="70% event prize" value={`${quoteModel.eventPrizeNative ?? "—"} ${quoteModel.symbol || ""}`.trim()} />
            <FlowMetric label="20% marketing" value={`${quoteModel.marketingNative ?? "—"} ${quoteModel.symbol || ""}`.trim()} />
            <FlowMetric label="10% protocol" value={`${quoteModel.protocolNative ?? "—"} ${quoteModel.symbol || ""}`.trim()} />
          </div>
          <div className="text-[9px] uppercase tracking-[0.13em] text-white/35">
            Payment remains disabled here until Agent 3 publishes the authoritative transaction/payment transport. Browser-entered native amounts are never trusted.
          </div>
        </div>
      ) : null}
    </section>
  );
}

function FlowMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-white/10 bg-black/20 p-3">
      <div className="text-[9px] uppercase tracking-[0.14em] text-white/35">{label}</div>
      <div className="mt-1 font-retro text-sm text-white/85">{value}</div>
    </div>
  );
}
