export type EventSponsorshipEventType =
  | "normal_tournament"
  | "vote_tournament"
  | "monthly_mwl"
  | "quarterly_championship";

export type EventSponsorshipStatus =
  | "submitted"
  | "under_review"
  | "approved"
  | "rejected"
  | "payment_pending"
  | "paid"
  | "scheduled"
  | "active"
  | "completed";

export type EventSponsorIdentity = {
  id?: string | null;
  projectName: string;
  websiteUrl?: string | null;
  logoUrl?: string | null;
  foundingSponsor?: boolean;
  eventPrizeNative?: number | string | null;
  nativeSymbol?: string | null;
  chainId?: number | null;
};

export type EventSponsorshipState = {
  eventId: string;
  eventType: EventSponsorshipEventType | string;
  title: string;
  chainId: number;
  nativeSymbol?: string | null;
  sponsorshipOpen: boolean;
  status?: EventSponsorshipStatus | string | null;
  sponsorApprovalStatus?: "submitted" | "under_review" | "approved" | "rejected" | string | null;
  pricingTier?: string | null;
  minimumUsd?: number | string | null;
  minimumUsdCents?: number | string | null;
  sponsorCount?: number | null;
  sponsorshipPrizeNative?: number | string | null;
  sponsors?: EventSponsorIdentity[];
};

export type EventSponsorshipQuote = {
  quoteId: string;
  eventId: string;
  chainId: number;
  sponsorWallet: string;
  pricingTier?: string | null;
  pricingVersion?: string | null;
  minimumUsd: number | string;
  requestedUsd?: number | string | null;
  grossNative: number | string;
  eventPrizeNative: number | string;
  marketingNative: number | string;
  protocolNative: number | string;
  nativeSymbol?: string | null;
  expiresAt: string;
};

export type EventSponsorshipPaymentState = {
  quoteId: string;
  eventId?: string | null;
  status: "pending" | "submitted" | "verifying" | "confirmed" | "failed" | string;
  txHash?: string | null;
  signature?: string | null;
  eventPrizeNative?: number | string | null;
  nativeSymbol?: string | null;
  error?: string | null;
};

/**
 * Browser-facing Event Sponsorship transport.
 *
 * Public reads are declared by Agent 3 as:
 *   GET /api/arena/sponsorships/options
 *   GET /api/arena/sponsorships/:eventId/state
 *   GET /api/arena/sponsorships/payments/:quoteId
 *
 * Solana money preparation is declared as:
 *   POST /api/arena/sponsorships/solana-quote
 *   POST /api/arena/sponsorships/solana-payment
 *
 * Agent 2 must not call the internal /confirm route, calculate authoritative
 * pricing, verify receipts, or construct the final Solana transaction before
 * Agent 3 freezes the returned transaction contract.
 */
export type EventSponsorshipTransport = {
  getOptions(signal?: AbortSignal): Promise<EventSponsorshipState[]>;
  getState(eventId: string, signal?: AbortSignal): Promise<EventSponsorshipState>;
  getPaymentState(quoteId: string, signal?: AbortSignal): Promise<EventSponsorshipPaymentState>;
  getQuote(input: {
    eventId: string;
    sponsorWallet: string;
    requestedUsd?: number | string | null;
  }): Promise<EventSponsorshipQuote>;
  submitPayment?: (input: {
    quoteId: string;
    eventId: string;
    sponsorWallet: string;
    txHash?: string | null;
    signature?: string | null;
  }) => Promise<EventSponsorshipState>;
  getSolanaQuote?: (input: Record<string, unknown>) => Promise<unknown>;
  submitSolanaPayment?: (input: Record<string, unknown>) => Promise<unknown>;
};
