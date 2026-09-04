import { Contract, formatUnits, type JsonRpcSigner } from "ethers";

import { apiFetch } from "@/lib/apiBase";
import { getNativeSymbol } from "@/lib/chainConfig";
import { sendSolanaArenaInstruction, type SolanaArenaInstructionEnvelope } from "@/lib/arena/solanaArenaBrowserTransaction";
import type {
  EventSponsorshipPaymentState,
  EventSponsorshipQuote,
  EventSponsorshipState,
  EventSponsorshipTransport,
} from "@/lib/arena/eventSponsorshipContracts";
import { signSolanaMessage } from "@/lib/solanaWallet";
import { signWalletAction } from "@/lib/walletActionAuth";

const EVM_SPONSORSHIP_ABI = [
  "function paySponsorship(bytes32 eventId,bytes32 pricingTier,uint256 pricingVersion,uint256 minimumUsdMicros,uint256 requestedUsdMicros,uint256 minimumNativeRaw,uint256 requestedNativeRaw,uint256 nativeUsdReferenceMicros,uint256 oracleTimestamp,uint256 nonce,uint256 deadline,bytes signature) payable",
] as const;

async function readJson(res: Response, label: string) {
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok === false) throw new Error(String(json?.error || `${label} failed (${res.status})`));
  return json;
}

function isSolana(chainId: number) {
  return Number(chainId) === 101 || Number(chainId) === 102;
}

function native(raw: unknown, chainId: number): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  try { return formatUnits(BigInt(String(raw)), isSolana(chainId) ? 9 : 18); } catch { return null; }
}

function centsToUsd(value: unknown): string | null {
  try {
    const cents = BigInt(String(value));
    const whole = cents / 100n;
    const fraction = String(cents % 100n).padStart(2, "0");
    return fraction === "00" ? whole.toString() : `${whole}.${fraction}`;
  } catch { return null; }
}

function usdToCents(value: number | string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) throw new Error("Sponsorship contribution must be a USD amount with at most 2 decimals.");
  const [whole, fraction = ""] = raw.split(".");
  return (BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2))).toString();
}

function optionState(row: any): EventSponsorshipState {
  const chainId = Number(row?.chainId || 0);
  const profile = row?.sponsorProfile || null;
  return {
    eventId: String(row?.eventId || ""),
    eventReferenceId: row?.eventReferenceId ? String(row.eventReferenceId) : null,
    eventType: String(row?.eventType || ""),
    title: String(row?.eventReferenceId || row?.eventId || "Event"),
    chainId,
    sponsorshipOpen: row?.sponsorshipOpen === true,
    status: profile?.status || null,
    sponsorApprovalStatus: profile?.status || null,
    sponsorProfile: profile ? {
      id: profile.id ? String(profile.id) : null,
      projectName: profile.projectName ? String(profile.projectName) : null,
      status: String(profile.status || "missing"),
      approved: profile.approved === true,
      foundingSponsor: profile.foundingSponsor === true,
    } : null,
    pricingTier: row?.authoritativeTier?.code ? String(row.authoritativeTier.code) : null,
    minimumUsdCents: row?.minimumUsdCents == null ? null : String(row.minimumUsdCents),
    minimumUsd: centsToUsd(row?.minimumUsdCents),
    sponsors: [],
    sponsorCount: 0,
    chainReady: row?.chainState?.ready ?? null,
    chainReason: row?.chainState?.reason ? String(row.chainState.reason) : null,
  };
}

function stateFromResponse(json: any, previous?: EventSponsorshipState | null): EventSponsorshipState {
  const event = json?.event || {};
  const chainId = Number(event.chainId || previous?.chainId || 0);
  const sponsors = (Array.isArray(json?.sponsors) ? json.sponsors : []).map((row: any) => ({
    id: row?.sponsorshipId ? String(row.sponsorshipId) : null,
    projectName: String(row?.projectName || "Sponsor"),
    foundingSponsor: row?.foundingSponsor === true,
    eventPrizeNative: native(row?.prizeContributionNativeRaw, chainId),
    nativeSymbol: getNativeSymbol(chainId),
    chainId,
    paymentStatus: row?.paymentStatus ? String(row.paymentStatus) : null,
    confirmedAt: row?.confirmedAt ? String(row.confirmedAt) : null,
  }));
  return {
    ...(previous || {} as EventSponsorshipState),
    eventId: String(event.id || previous?.eventId || ""),
    eventReferenceId: event.referenceId ? String(event.referenceId) : previous?.eventReferenceId || null,
    eventType: String(event.type || previous?.eventType || ""),
    title: String(event.referenceId || previous?.title || event.id || "Event"),
    chainId,
    sponsorshipOpen: event.sponsorshipOpen === true,
    sponsorshipPrizeNative: native(event.sponsorshipPrizeNativeRaw, chainId),
    sponsors,
    sponsorCount: sponsors.length,
    foundingSponsors: Array.isArray(json?.foundingSponsors) ? json.foundingSponsors : [],
    chainReady: json?.chainState?.ready ?? previous?.chainReady ?? null,
    chainReason: json?.chainState?.reason ? String(json.chainState.reason) : previous?.chainReason || null,
  };
}

function paymentFromResponse(json: any): EventSponsorshipPaymentState {
  const payment = json?.payment || {};
  const chainId = Number(json?.chainId || 0);
  return {
    quoteId: String(json?.quoteId || ""),
    eventId: json?.eventId ? String(json.eventId) : null,
    status: payment.verified === true ? "confirmed" : String(payment.status || json?.sponsorshipStatus || "pending"),
    verified: payment.verified === true,
    signature: payment.signature ? String(payment.signature) : null,
    receiptPda: payment.receiptPda ? String(payment.receiptPda) : null,
    confirmedAt: payment.confirmedAt ? String(payment.confirmedAt) : null,
    nativeSymbol: getNativeSymbol(chainId),
  };
}

async function fetchOptionsRaw(input: { walletAddress?: string | null; chainId?: number | null; signal?: AbortSignal } = {}) {
  const qs = new URLSearchParams();
  if (input.walletAddress) qs.set("walletAddress", input.walletAddress);
  if (input.chainId) qs.set("chainId", String(input.chainId));
  const suffix = qs.size ? `?${qs.toString()}` : "";
  const res = await apiFetch(`/api/arena/sponsorships/options${suffix}`, { cache: "no-store", signal: input.signal });
  const json = await readJson(res, "Event sponsorship options");
  return (Array.isArray(json?.options) ? json.options : []).map(optionState);
}

export async function fetchEventSponsorshipOptions(signal?: AbortSignal): Promise<EventSponsorshipState[]> {
  return fetchOptionsRaw({ signal });
}

export async function fetchEventSponsorshipState(eventId: string, signal?: AbortSignal): Promise<EventSponsorshipState> {
  const res = await apiFetch(`/api/arena/sponsorships/${encodeURIComponent(eventId)}/state`, { cache: "no-store", signal });
  return stateFromResponse(await readJson(res, "Event sponsorship state"));
}

export async function fetchEventSponsorshipPaymentState(quoteId: string, signal?: AbortSignal): Promise<EventSponsorshipPaymentState> {
  const res = await apiFetch(`/api/arena/sponsorships/payments/${encodeURIComponent(quoteId)}`, { cache: "no-store", signal });
  return paymentFromResponse(await readJson(res, "Event sponsorship payment state"));
}

type EvmSignedQuote = {
  domain: { verifyingContract: string; chainId: number };
  value: Record<string, string> & { sponsor: string; requestedNativeRaw: string };
  signature: string;
};

type SolanaQuoteRaw = {
  quoteId: string; eventId: string; chainId: number; minimumUsdCents: string; requestedUsdCents: string;
  grossLamports: string; prizeLamports: string; marketingLamports: string; protocolLamports: string;
  transaction: SolanaArenaInstructionEnvelope; expiresAt: string;
};

export function createEventSponsorshipTransport(input: {
  evmAccount?: string | null;
  evmSigner?: JsonRpcSigner | null;
  solanaAccount?: string | null;
}): EventSponsorshipTransport {
  const stateCache = new Map<string, EventSponsorshipState>();
  const quoteCache = new Map<string, EventSponsorshipQuote>();

  async function getOptions(signal?: AbortSignal) {
    const base = await fetchOptionsRaw({ signal });
    const rows: EventSponsorshipState[] = [];
    for (const item of base) {
      const wallet = isSolana(item.chainId) ? input.solanaAccount : input.evmAccount;
      let enriched = item;
      if (wallet) {
        const scoped = await fetchOptionsRaw({ walletAddress: wallet, chainId: item.chainId, signal });
        enriched = scoped.find((row) => row.eventId === item.eventId) || item;
      }
      stateCache.set(enriched.eventId, enriched);
      rows.push(enriched);
    }
    return rows;
  }

  async function getState(eventId: string, signal?: AbortSignal) {
    const previous = stateCache.get(eventId) || null;
    const res = await apiFetch(`/api/arena/sponsorships/${encodeURIComponent(eventId)}/state`, { cache: "no-store", signal });
    const next = stateFromResponse(await readJson(res, "Event sponsorship state"), previous);
    stateCache.set(eventId, next);
    return next;
  }

  async function getQuote(request: { eventId: string; sponsorWallet: string; requestedUsd?: number | string | null }) {
    const state = stateCache.get(request.eventId);
    if (!state?.pricingTier || !state.minimumUsdCents || !state.eventReferenceId) throw new Error("Authoritative sponsorship tier/minimum/event reference is unavailable.");
    const requestedUsdCents = usdToCents(request.requestedUsd) || String(state.minimumUsdCents);
    const minimumUsdCents = String(state.minimumUsdCents);
    let normalized: EventSponsorshipQuote;

    if (isSolana(state.chainId)) {
      const wallet = String(input.solanaAccount || request.sponsorWallet || "").trim();
      const auth = await signWalletAction({
        action: "arena_sponsorship_quote", walletAddress: wallet, chainId: state.chainId, walletType: "solana",
        signMessage: async (message) => (await signSolanaMessage(message, wallet)).signature,
        extraLines: [`Event: ${state.eventId}`, `Tier: ${state.pricingTier}`, `Minimum USD cents: ${minimumUsdCents}`, `Requested USD cents: ${requestedUsdCents}`],
      });
      const res = await apiFetch("/api/arena/sponsorships/solana-quote", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventId: state.eventId, chainId: state.chainId, walletAddress: wallet, requestedUsdCents, auth }),
      });
      const raw = await readJson(res, "Solana sponsorship quote") as SolanaQuoteRaw;
      normalized = {
        quoteId: String(raw.quoteId), eventId: String(raw.eventId), chainId: Number(raw.chainId), sponsorWallet: wallet,
        pricingTier: state.pricingTier, minimumUsd: centsToUsd(raw.minimumUsdCents) || "0", requestedUsd: centsToUsd(raw.requestedUsdCents),
        grossNative: native(raw.grossLamports, state.chainId) || "0", eventPrizeNative: native(raw.prizeLamports, state.chainId) || "0",
        marketingNative: native(raw.marketingLamports, state.chainId) || "0", protocolNative: native(raw.protocolLamports, state.chainId) || "0",
        nativeSymbol: "SOL", expiresAt: raw.expiresAt, transactionKind: "solana", transaction: raw.transaction, raw,
      };
    } else {
      if (!input.evmSigner || !input.evmAccount) throw new Error("Connect the event-chain EVM wallet before requesting a sponsorship quote.");
      const auth = await signWalletAction({
        action: "arena_sponsorship_quote", walletAddress: input.evmAccount, chainId: state.chainId, signer: input.evmSigner,
        extraLines: [`Event: ${state.eventId}`, `Event Reference: ${state.eventReferenceId}`, `Tier: ${state.pricingTier}`, `Minimum USD cents: ${minimumUsdCents}`, `Requested USD cents: ${requestedUsdCents}`],
      });
      const res = await apiFetch("/api/arena/sponsorships/quote", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventId: state.eventId, chainId: state.chainId, walletAddress: input.evmAccount, requestedUsdCents, auth }),
      });
      const raw = await readJson(res, "EVM sponsorship quote");
      const signed = raw.quote as EvmSignedQuote;
      const gross = BigInt(String(signed.value.requestedNativeRaw));
      const marketing = gross * 2000n / 10000n;
      const protocol = gross * 1000n / 10000n;
      const prize = gross - marketing - protocol;
      normalized = {
        quoteId: String(raw.quoteId), eventId: String(raw.eventId), chainId: state.chainId, sponsorWallet: input.evmAccount,
        pricingTier: state.pricingTier, pricingVersion: String(signed.value.pricingVersion), minimumUsd: centsToUsd(raw.minimumUsdCents) || "0",
        requestedUsd: centsToUsd(raw.requestedUsdCents), grossNative: native(gross, state.chainId) || "0",
        eventPrizeNative: native(prize, state.chainId) || "0", marketingNative: native(marketing, state.chainId) || "0",
        protocolNative: native(protocol, state.chainId) || "0", nativeSymbol: getNativeSymbol(state.chainId),
        expiresAt: new Date(Number(signed.value.deadline) * 1000).toISOString(), transactionKind: "evm", transaction: signed, raw,
      };
    }
    quoteCache.set(normalized.quoteId, normalized);
    return normalized;
  }

  async function submitPayment(request: { quoteId: string; eventId: string; sponsorWallet: string }): Promise<EventSponsorshipPaymentState> {
    const quote = quoteCache.get(request.quoteId);
    if (!quote) throw new Error("Sponsorship quote is not available in this wallet session.");
    if (quote.transactionKind === "solana") {
      const signature = await sendSolanaArenaInstruction({
        chainId: quote.chainId, wallet: quote.sponsorWallet, transaction: quote.transaction as SolanaArenaInstructionEnvelope, label: "Event sponsorship",
      });
      const auth = await signWalletAction({
        action: "arena_sponsorship_payment", walletAddress: quote.sponsorWallet, chainId: quote.chainId, walletType: "solana",
        signMessage: async (message) => (await signSolanaMessage(message, quote.sponsorWallet)).signature,
        extraLines: [`Quote: ${quote.quoteId}`, `Signature: ${signature}`],
      });
      const res = await apiFetch("/api/arena/sponsorships/solana-payment", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quoteId: quote.quoteId, signature, auth }),
      });
      const raw = await readJson(res, "Solana sponsorship payment");
      return { quoteId: quote.quoteId, eventId: quote.eventId, status: "confirmed", verified: true, signature, receiptPda: raw.receiptPda || null, confirmedAt: raw.confirmedAt || null, eventPrizeNative: native(raw.allocation?.prizeNativeRaw, quote.chainId), nativeSymbol: "SOL" };
    }

    if (!input.evmSigner) throw new Error("Connect the event-chain EVM wallet before paying sponsorship.");
    const signed = quote.transaction as EvmSignedQuote;
    const network = await input.evmSigner.provider.getNetwork();
    if (Number(network.chainId) !== Number(quote.chainId)) throw new Error("Wallet chain does not match sponsorship quote.");
    if (String(await input.evmSigner.getAddress()).toLowerCase() !== quote.sponsorWallet.toLowerCase()) throw new Error("Sponsorship quote belongs to another wallet.");
    const value = signed.value;
    const router = new Contract(signed.domain.verifyingContract, EVM_SPONSORSHIP_ABI, input.evmSigner);
    const tx = await router.paySponsorship(
      value.eventId, value.pricingTier, BigInt(value.pricingVersion), BigInt(value.minimumUsdMicros), BigInt(value.requestedUsdMicros),
      BigInt(value.minimumNativeRaw), BigInt(value.requestedNativeRaw), BigInt(value.nativeUsdReferenceMicros), BigInt(value.oracleTimestamp),
      BigInt(value.nonce), BigInt(value.deadline), signed.signature, { value: BigInt(value.requestedNativeRaw) },
    );
    const receipt = await tx.wait();
    if (receipt && Number(receipt.status) !== 1) throw new Error("Sponsorship transaction did not succeed.");
    return { quoteId: quote.quoteId, eventId: quote.eventId, status: "submitted", verified: false, txHash: String(tx.hash || receipt?.hash || ""), nativeSymbol: getNativeSymbol(quote.chainId) };
  }

  return { getOptions, getState, getPaymentState: fetchEventSponsorshipPaymentState, getQuote, submitPayment };
}
