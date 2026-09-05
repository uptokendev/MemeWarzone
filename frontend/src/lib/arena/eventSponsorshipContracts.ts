export type EventSponsorshipEventType =
  | "normal_tournament"
  | "vote_tournament"
  | "monthly_mwl"
  | "quarterly_championship";

export type EventSponsorshipStatus =
  | "submitted" | "under_review" | "approved" | "rejected" | "payment_pending"
  | "paid" | "scheduled" | "active" | "completed";

export type EventSponsorIdentity = {
  id?: string | null;
  projectName: string;
  websiteUrl?: string | null;
  logoUrl?: string | null;
  foundingSponsor?: boolean;
  eventPrizeNative?: number | string | null;
  nativeSymbol?: string | null;
  chainId?: number | null;
  paymentStatus?: string | null;
  confirmedAt?: string | null;
};

export type EventSponsorProfile = {
  id?: string | null;
  projectName?: string | null;
  status: string;
  approved: boolean;
  foundingSponsor: boolean;
};

export type EventSponsorshipState = {
  eventId: string;
  eventReferenceId?: string | null;
  eventType: EventSponsorshipEventType | string;
  title: string;
  chainId: number;
  nativeSymbol?: string | null;
  sponsorshipOpen: boolean;
  status?: EventSponsorshipStatus | string | null;
  sponsorApprovalStatus?: string | null;
  sponsorProfile?: EventSponsorProfile | null;
  pricingTier?: string | null;
  minimumUsd?: number | string | null;
  minimumUsdCents?: number | string | null;
  sponsorCount?: number | null;
  sponsorshipPrizeNative?: number | string | null;
  sponsors?: EventSponsorIdentity[];
  foundingSponsors?: Array<{ projectName: string; sponsorshipId?: string | null }>;
  chainReady?: boolean | null;
  chainReason?: string | null;
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
  transactionKind?: "evm" | "solana";
  transaction?: unknown;
  raw?: unknown;
};

export type EventSponsorshipPaymentState = {
  quoteId: string;
  eventId?: string | null;
  status: "pending" | "submitted" | "verifying" | "confirmed" | "failed" | string;
  verified?: boolean;
  txHash?: string | null;
  signature?: string | null;
  receiptPda?: string | null;
  eventPrizeNative?: number | string | null;
  nativeSymbol?: string | null;
  error?: string | null;
  confirmedAt?: string | null;
};

export type EventSponsorshipTransport = {
  getOptions(signal?: AbortSignal): Promise<EventSponsorshipState[]>;
  getState(eventId: string, signal?: AbortSignal): Promise<EventSponsorshipState>;
  getPaymentState(quoteId: string, signal?: AbortSignal): Promise<EventSponsorshipPaymentState>;
  getQuote(input: { eventId: string; sponsorWallet: string; requestedUsd?: number | string | null }): Promise<EventSponsorshipQuote>;
  submitPayment?: (input: { quoteId: string; eventId: string; sponsorWallet: string }) => Promise<EventSponsorshipPaymentState>;
};
