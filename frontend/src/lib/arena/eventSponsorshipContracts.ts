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
  minimumUsd?: number | string | null;
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

/**
 * Agent 3 owns the implementation behind this transport.
 * Agent 2 consumes it and must not recreate quote/payment verification logic.
 */
export type EventSponsorshipTransport = {
  getOptions(signal?: AbortSignal): Promise<EventSponsorshipState[]>;
  getState(eventId: string, signal?: AbortSignal): Promise<EventSponsorshipState>;
  getQuote(input: {
    eventId: string;
    sponsorWallet: string;
    requestedUsd?: number | string | null;
  }): Promise<EventSponsorshipQuote>;
  submitPayment(input: {
    quoteId: string;
    eventId: string;
    sponsorWallet: string;
    txHash?: string | null;
    signature?: string | null;
  }): Promise<EventSponsorshipState>;
};
