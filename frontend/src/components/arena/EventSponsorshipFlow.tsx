import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  EventSponsorshipPaymentState,
  EventSponsorshipQuote,
  EventSponsorshipState,
  EventSponsorshipTransport,
} from "@/lib/arena/eventSponsorshipContracts";
import {
  presentEventSponsorship,
  presentEventSponsorshipPayment,
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
  const [payment, setPayment] = useState<EventSponsorshipPaymentState | null>(null);
  const [loading, setLoading] = useState(Boolean(transport));
  const [stateLoading, setStateLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(!transport);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadOptions = useCallback(async (signal?: AbortSignal) => {
    if (!transport) return;
    setLoading(true);
    setLoadError(null);
    try {
      const items = await transport.getOptions(signal);
      const sponsorable = items.filter((item) => presentEventSponsorship(item).sponsorable);
      setEvents(sponsorable);
      setEventId((current) => current || sponsorable[0]?.eventId || "");
      setUnavailable(false);
    } catch (error) {
      if (signal?.aborted) return;
      setUnavailable(true);
      setLoadError(String((error as Error)?.message || "Could not load sponsorable events."));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [transport]);

  useEffect(() => {
    if (!transport) {
      setUnavailable(true);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    void loadOptions(controller.signal);
    return () => controller.abort();
  }, [loadOptions, transport]);

  useEffect(() => {
    if (!transport || !eventId) return;
    const controller = new AbortController();
    setStateLoading(true);
    transport.getState(eventId, controller.signal)
      .then((next) => {
        if (!presentEventSponsorship(next).sponsorable) return;
        setEvents((current) => current.map((item) => item.eventId === eventId ? next : item));
      })
      .catch((error) => {
        if (!controller.signal.aborted) setLoadError(String((error as Error)?.message || "Could not refresh sponsorship state."));
      })
      .finally(() => {
        if (!controller.signal.aborted) setStateLoading(false);
      });
    return () => controller.abort();
  }, [eventId, transport]);

  const selected = useMemo(() => events.find((event) => event.eventId === eventId) || null, [eventId, events]);
  const eventModel = useMemo(() => (selected ? presentEventSponsorship(selected) : null), [selected]);
  const quoteModel = useMemo(() => presentEventSponsorshipQuote(quote || {}), [quote]);
  const paymentModel = useMemo(() => presentEventSponsorshipPayment(payment || {}), [payment]);
  const approvalKey = String(selected?.sponsorApprovalStatus || selected?.status || "").toLowerCase();
  const approved = ["approved", "payment_pending", "paid", "scheduled", "active", "completed"].includes(approvalKey);

  async function requestQuote() {
    if (!transport || !selected || !sponsorWallet || !approved) return;
    setBusy(true);
    setPayment(null);
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

  async function refreshPayment() {
    if (!transport || !quoteModel.quoteId) return;
    setBusy(true);
    try {
      setPayment(await transport.getPaymentState(quoteModel.quoteId));
    } catch (error) {
      toast.error(String((error as Error)?.message || "Could not refresh sponsorship payment state."));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <div role="status" aria-live="polite" className="text-xs text-white/45">Loading sponsorable events…</div>;
  }

  if (unavailable || !transport) {
    return (
      <section data-event-sponsorship-runtime="unavailable" role="status" aria-live="polite" className="space-y-3 border border-white/10 bg-black/20 p-4">
        <div className="font-retro text-sm text-white/85">Sponsor an event</div>
        <div className="text-xs text-white/45">{loadError || "Event sponsorship runtime is not available yet."} The existing advertising sponsorship product is unchanged.</div>
        {transport ? <Button type="button" variant="outline" size="sm" onClick={() => void loadOptions()}>Retry</Button> : null}
      </section>
    );
  }

  if (!events.length) {
    return <div role="status" aria-live="polite" className="text-xs text-white/45">No sponsorable MemeWarzone events are open right now.</div>;
  }

  return (
    <section data-event-sponsorship-flow="true" aria-labelledby="event-sponsorship-title" className="space-y-4 border border-white/10 bg-black/20 p-4">
      <div>
        <div className="text-[10px] uppercase tracking-[0.2em] text-white/40">Sponsor an event</div>
        <div id="event-sponsorship-title" className="mt-1 font-retro text-lg text-white/90">Fund the prize pool. Never the outcome.</div>
      </div>

      <label className="block space-y-2">
        <span className="text-[10px] uppercase tracking-[0.14em] text-white/45">Eligible event</span>
        <select
          value={eventId}
          onChange={(event) => {
            setEventId(event.target.value);
            setQuote(null);
            setPayment(null);
          }}
          className="h-11 w-full border border-white/10 bg-black px-3 text-sm text-white/85"
        >
          {events.map((event) => {
            const model = presentEventSponsorship(event);
            return <option key={event.eventId} value={event.eventId}>{model.title} · {model.symbol || "CHAIN"}</option>;
          })}
        </select>
      </label>

      {stateLoading ? <div className="text-[10px] uppercase tracking-[0.14em] text-white/35">Refreshing authoritative event state…</div> : null}
      {loadError ? <div role="status" className="text-xs text-amber-100/75">{loadError}</div> : null}

      {eventModel ? (
        <div className="grid gap-2 sm:grid-cols-4" aria-live="polite">
          <FlowMetric label="Tier" value={eventModel.pricingTier || "Authoritative"} />
          <FlowMetric label="Minimum" value={eventModel.minimumUsd != null ? `$${eventModel.minimumUsd}` : "Server quote"} />
          <FlowMetric label="Payment asset" value={eventModel.symbol || "Native"} />
          <FlowMetric label="Approval" value={eventModel.approvalStatus.label} />
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
          <Button type="button" size="sm" className="mwz-button font-retro" disabled={!sponsorWallet || busy || stateLoading} onClick={() => void requestQuote()}>
            {busy ? "Loading quote…" : sponsorWallet ? "Get native quote" : "Connect event-chain wallet"}
          </Button>
        </>
      )}

      {quoteModel.valid ? (
        <div className="space-y-3 border border-white/10 bg-black/30 p-3" data-event-sponsorship-quote="true" role="status" aria-live="polite">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10px] uppercase tracking-[0.14em] text-white/40">Authoritative quote</span>
            <span className="font-retro text-lg text-white/90">{quoteModel.grossNative} {quoteModel.symbol}</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <FlowMetric label="70% event prize" value={`${quoteModel.eventPrizeNative ?? "—"} ${quoteModel.symbol || ""}`.trim()} />
            <FlowMetric label="20% marketing" value={`${quoteModel.marketingNative ?? "—"} ${quoteModel.symbol || ""}`.trim()} />
            <FlowMetric label="10% protocol" value={`${quoteModel.protocolNative ?? "—"} ${quoteModel.symbol || ""}`.trim()} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void refreshPayment()}>
              Refresh payment state
            </Button>
            <span className="text-[9px] uppercase tracking-[0.13em] text-white/35">Payment mutation stays disabled until the authoritative wallet transaction adapter is frozen.</span>
          </div>
        </div>
      ) : null}

      {paymentModel.quoteId ? (
        <div data-event-sponsorship-payment-state="true" className="space-y-1 border border-white/10 bg-black/25 p-3" role="status" aria-live="polite">
          <div className="text-[10px] uppercase tracking-[0.14em] text-white/40">{paymentModel.status.label}</div>
          {paymentModel.eventPrizeNative != null && paymentModel.symbol ? <div className="text-sm text-white/75">{paymentModel.eventPrizeNative} {paymentModel.symbol} added to Event Prize</div> : null}
          {paymentModel.txHash || paymentModel.signature ? <div className="break-all text-[10px] text-white/40">{paymentModel.txHash || paymentModel.signature}</div> : null}
          {paymentModel.error ? <div className="text-xs text-red-200/75">{paymentModel.error}</div> : null}
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
