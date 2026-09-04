import { apiFetch } from "@/lib/apiBase";
import type {
  EventSponsorshipPaymentState,
  EventSponsorshipState,
} from "@/lib/arena/eventSponsorshipContracts";

async function readJson(res: Response, label: string) {
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok === false) {
    throw new Error(String(json?.error || `${label} failed (${res.status})`));
  }
  return json;
}

function optionRows(json: any): EventSponsorshipState[] {
  const rows = Array.isArray(json) ? json : Array.isArray(json?.events) ? json.events : Array.isArray(json?.options) ? json.options : [];
  return rows.filter(Boolean) as EventSponsorshipState[];
}

export async function fetchEventSponsorshipOptions(signal?: AbortSignal): Promise<EventSponsorshipState[]> {
  const res = await apiFetch("/api/arena/sponsorships/options", { cache: "no-store", signal });
  return optionRows(await readJson(res, "Event sponsorship options"));
}

export async function fetchEventSponsorshipState(eventId: string, signal?: AbortSignal): Promise<EventSponsorshipState> {
  const res = await apiFetch(`/api/arena/sponsorships/${encodeURIComponent(eventId)}/state`, { cache: "no-store", signal });
  const json = await readJson(res, "Event sponsorship state");
  return (json?.state || json?.event || json) as EventSponsorshipState;
}

export async function fetchEventSponsorshipPaymentState(quoteId: string, signal?: AbortSignal): Promise<EventSponsorshipPaymentState> {
  const res = await apiFetch(`/api/arena/sponsorships/payments/${encodeURIComponent(quoteId)}`, { cache: "no-store", signal });
  const json = await readJson(res, "Event sponsorship payment state");
  return (json?.payment || json?.state || json) as EventSponsorshipPaymentState;
}

/**
 * Raw Solana preparation boundary only. Agent 2 intentionally does not inspect,
 * construct, deserialize or sign any returned transaction payload here.
 */
export async function requestSolanaSponsorshipQuote(input: Record<string, unknown>): Promise<unknown> {
  const res = await apiFetch("/api/arena/sponsorships/solana-quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return readJson(res, "Solana sponsorship quote");
}

/**
 * Payment submission boundary only. Receipt/PDA verification stays on Agent 3.
 */
export async function submitSolanaSponsorshipPayment(input: Record<string, unknown>): Promise<unknown> {
  const res = await apiFetch("/api/arena/sponsorships/solana-payment", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return readJson(res, "Solana sponsorship payment");
}
