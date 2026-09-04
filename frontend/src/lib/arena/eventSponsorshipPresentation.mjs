export const EVENT_SPONSORSHIP_SPLIT = Object.freeze({ eventPrize: 70, marketing: 20, protocol: 10 });

const SPONSORABLE_EVENT_TYPES = new Set([
  "normal_tournament",
  "vote_tournament",
  "monthly_mwl",
  "quarterly_championship",
]);

function text(value) {
  return String(value || "").trim();
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function isEventSponsorable(source = {}) {
  const eventType = text(source.eventType || source.event_type).toLowerCase();
  return SPONSORABLE_EVENT_TYPES.has(eventType);
}

export function presentEventSponsorshipStatus(value) {
  const raw = text(value).toLowerCase();
  const labels = {
    submitted: "SUBMITTED",
    under_review: "UNDER REVIEW",
    approved: "APPROVED · PAYMENT ENABLED",
    rejected: "NOT APPROVED",
    payment_pending: "PAYMENT PENDING",
    paid: "PAYMENT CONFIRMED",
    scheduled: "SCHEDULED",
    active: "ACTIVE",
    completed: "COMPLETED",
  };
  return { key: raw || "unavailable", label: labels[raw] || "UNAVAILABLE" };
}

export function presentEventNativeSymbol(source = {}) {
  const explicit = text(source.nativeSymbol || source.native_symbol);
  if (explicit) return explicit;
  const chainId = Number(source.chainId ?? source.chain_id);
  if (chainId === 101 || chainId === 102) return "SOL";
  if (chainId === 4663 || chainId === 46630) return "ETH";
  if (chainId === 56 || chainId === 97) return "BNB";
  return null;
}

export function presentEventSponsorshipQuote(source = {}) {
  const grossNative = finite(source.grossNative ?? source.gross_native);
  const minimumUsd = finite(source.minimumUsd ?? source.minimum_usd);
  const requestedUsd = finite(source.requestedUsd ?? source.requested_usd);
  const symbol = presentEventNativeSymbol(source);
  const eventPrizeNative = finite(source.eventPrizeNative ?? source.event_prize_native);
  const marketingNative = finite(source.marketingNative ?? source.marketing_native);
  const protocolNative = finite(source.protocolNative ?? source.protocol_native);
  return {
    quoteId: text(source.quoteId || source.quote_id) || null,
    symbol,
    minimumUsd,
    requestedUsd,
    grossNative,
    eventPrizeNative,
    marketingNative,
    protocolNative,
    expiresAt: source.expiresAt || source.expires_at || null,
    valid: Boolean(text(source.quoteId || source.quote_id) && symbol && grossNative != null && grossNative > 0),
  };
}

export function presentEventSponsor(source = {}) {
  const founding = Boolean(source.foundingSponsor ?? source.founding_sponsor);
  const eventPrizeNative = finite(source.eventPrizeNative ?? source.event_prize_native ?? source.prizeContributionNative);
  const symbol = presentEventNativeSymbol(source);
  return {
    id: text(source.id) || null,
    projectName: text(source.projectName || source.project_name) || "Sponsor",
    websiteUrl: text(source.websiteUrl || source.website_url) || null,
    logoUrl: text(source.logoUrl || source.logo_url) || null,
    foundingSponsor: founding,
    badgeLabel: founding ? "FOUNDING SPONSOR · MEMEWARZONE 2026" : "EVENT SPONSOR",
    eventPrizeNative,
    symbol,
    contributionLabel:
      eventPrizeNative != null && symbol ? `${eventPrizeNative} ${symbol} added to this prize pool` : null,
  };
}

export function presentEventSponsorship(source = {}) {
  const sponsorable = isEventSponsorable(source);
  const status = presentEventSponsorshipStatus(source.status);
  const minimumUsd = finite(source.minimumUsd ?? source.minimum_usd);
  const sponsorCount = finite(source.sponsorCount ?? source.sponsor_count);
  const eventPrizeNative = finite(source.sponsorshipPrizeNative ?? source.sponsorship_prize_native);
  const symbol = presentEventNativeSymbol(source);
  const sponsors = (Array.isArray(source.sponsors) ? source.sponsors : []).map(presentEventSponsor);
  return {
    eventId: text(source.eventId || source.event_id || source.id) || null,
    eventType: text(source.eventType || source.event_type).toLowerCase() || null,
    title: text(source.title || source.eventTitle || source.event_title) || "Event",
    sponsorable,
    sponsorshipOpen: sponsorable && Boolean(source.sponsorshipOpen ?? source.sponsorship_open),
    status,
    minimumUsd,
    symbol,
    sponsorCount: sponsorCount == null ? sponsors.length : sponsorCount,
    eventPrizeNative,
    sponsors,
    foundingSponsors: sponsors.filter((sponsor) => sponsor.foundingSponsor),
    splitLabel: "70% EVENT PRIZE · 20% MARKETING · 10% PROTOCOL",
    paymentRuleLabel: symbol ? `PAYMENT IN ${symbol} · EVENT CHAIN ONLY` : "CHAIN-NATIVE PAYMENT ONLY",
    competitiveIntegrityLabel: "SPONSORSHIP FUNDS REWARDS · NEVER RANKING, SEEDING, VOTES OR BATTLE POINTS",
  };
}
