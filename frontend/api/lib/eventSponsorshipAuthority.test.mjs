import assert from "node:assert/strict";
import test from "node:test";

import { sponsorshipSplit } from "./arenaSponsorshipRuntime.mjs";
import {
  deterministicFoundingSponsorOrder,
  eventSponsorshipContractSummary,
  nativeAssetForEventSponsorship,
  publicSponsorActive,
  resolveSponsorableEvent,
} from "./eventSponsorshipAuthority.mjs";
import {
  canIssueQuote,
  cancellationPolicy,
  deriveSponsorshipState,
  immutablePaymentIdentity,
  paymentStateFromQuote,
} from "./eventSponsorshipLifecycle.mjs";

function fakeDb({ registry, tournament = null, league = null, qf = null }) {
  return {
    async query(sql) {
      if (sql.includes("from public.sponsorship_events")) return { rows: registry ? [registry] : [] };
      if (sql.includes("from public.arena_tournaments t") && sql.includes("join public.arena_league_seasons")) return { rows: qf ? [qf] : [] };
      if (sql.includes("from public.arena_tournaments")) return { rows: tournament ? [tournament] : [] };
      if (sql.includes("from public.arena_league_seasons")) return { rows: league ? [league] : [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const baseRegistry = {
  id: "11111111-1111-4111-8111-111111111111",
  event_reference_id: "t-1",
  chain_id: 56,
  starts_at: "2026-09-06T00:00:00.000Z",
  ends_at: "2026-09-07T00:00:00.000Z",
  sponsorship_open: true,
};
const future = Date.parse("2026-09-05T12:00:00.000Z");

test("Normal Tournament is eligible only from canonical tournament identity", async () => {
  const result = await resolveSponsorableEvent(fakeDb({
    registry: { ...baseRegistry, event_type: "normal_tournament" },
    tournament: { id: "t-1", chain_id: 56, status: "upcoming", origin: "custom", battle_mode: "normal", starts_at: baseRegistry.starts_at, ends_at: baseRegistry.ends_at },
  }), { eventRef: baseRegistry.id, nowMs: future });
  assert.equal(result.ok, true);
  assert.equal(result.sponsorable, true);
  assert.equal(result.canonical.kind, "normal_tournament");
});

test("Vote Tournament is eligible only when canonical battle_mode is vote", async () => {
  const result = await resolveSponsorableEvent(fakeDb({
    registry: { ...baseRegistry, event_type: "vote_tournament" },
    tournament: { id: "t-1", chain_id: 56, status: "upcoming", origin: "custom", battle_mode: "vote", starts_at: baseRegistry.starts_at, ends_at: baseRegistry.ends_at },
  }), { eventRef: baseRegistry.id, nowMs: future });
  assert.equal(result.ok, true);
  assert.equal(result.canonical.kind, "vote_tournament");
});

test("Major War League is eligible from the canonical season", async () => {
  const result = await resolveSponsorableEvent(fakeDb({
    registry: { ...baseRegistry, event_type: "monthly_mwl", event_reference_id: "22222222-2222-4222-8222-222222222222" },
    league: { id: "22222222-2222-4222-8222-222222222222", chain_id: 56, state: "live", active: true, reset_at: baseRegistry.ends_at },
  }), { eventRef: baseRegistry.id, nowMs: future });
  assert.equal(result.ok, true);
  assert.equal(result.canonical.kind, "major_war_league");
});

test("MWL Quarter Finals requires exact season quarter_finals_tournament_id relationship", async () => {
  const qf = {
    tournament_id: "qf-season-1", chain_id: 56, status: "upcoming", origin: "quarter_finals",
    starts_at: baseRegistry.starts_at, ends_at: baseRegistry.ends_at,
    league_id: "33333333-3333-4333-8333-333333333333", league_state: "quarter_finals", league_active: true,
    quarter_finals_tournament_id: "qf-season-1",
  };
  const result = await resolveSponsorableEvent(fakeDb({ registry: { ...baseRegistry, event_type: "mwl_quarter_finals", event_reference_id: "qf-season-1" }, qf }), { eventRef: baseRegistry.id, nowMs: future });
  assert.equal(result.ok, true);
  assert.equal(result.canonical.parentEventId, qf.league_id);
  assert.equal(result.canonical.childEventId, qf.tournament_id);
  assert.match(result.canonical.relationship, /quarter_finals_tournament_id/);
});

test("fake Quarter Finals origin without canonical MWL relationship fails closed", async () => {
  const result = await resolveSponsorableEvent(fakeDb({ registry: { ...baseRegistry, event_type: "mwl_quarter_finals", event_reference_id: "fake-qf" }, qf: null }), { eventRef: baseRegistry.id, nowMs: future });
  assert.equal(result.ok, false);
  assert.equal(result.code, "MWL_QUARTER_FINALS_RELATIONSHIP_INVALID");
});

for (const eventType of ["quarterly_championship", "battle", "legacy_event", "unknown"]) {
  test(`${eventType} is explicitly rejected`, async () => {
    const result = await resolveSponsorableEvent(fakeDb({ registry: { ...baseRegistry, event_type: eventType } }), { eventRef: baseRegistry.id, nowMs: future });
    assert.equal(result.ok, false);
    assert.equal(result.code, "EVENT_CLASS_INELIGIBLE");
  });
}

test("wrong chain cannot resolve a canonical event", async () => {
  const db = {
    async query(sql, params) {
      if (sql.includes("from public.sponsorship_events")) return Number(params?.[1]) === 101 ? { rows: [] } : { rows: [{ ...baseRegistry, event_type: "normal_tournament" }] };
      return { rows: [] };
    },
  };
  const result = await resolveSponsorableEvent(db, { eventRef: baseRegistry.id, chainId: 101, nowMs: future });
  assert.equal(result.ok, false);
  assert.equal(result.code, "EVENT_NOT_FOUND");
});

test("native routes are BNB, SOL, and ETH with raw integer decimals", () => {
  assert.deepEqual(nativeAssetForEventSponsorship(56), { symbol: "BNB", decimals: 18, family: "evm" });
  assert.deepEqual(nativeAssetForEventSponsorship(101), { symbol: "SOL", decimals: 9, family: "solana" });
  assert.deepEqual(nativeAssetForEventSponsorship(4663), { symbol: "ETH", decimals: 18, family: "evm" });
  assert.throws(() => nativeAssetForEventSponsorship(1), /unsupported/);
});

test("70/20/10 split conserves every raw native unit with deterministic prize remainder", () => {
  for (const gross of [1n, 7n, 10n, 99n, 100n, 101n, 999999999999999999n]) {
    const split = sponsorshipSplit(gross);
    assert.equal(split.prize + split.marketing + split.protocol, gross);
    assert.equal(split.marketing, (gross * 2000n) / 10000n);
    assert.equal(split.protocol, (gross * 1000n) / 10000n);
    assert.equal(split.prize, gross - split.marketing - split.protocol);
  }
});

test("approval alone never activates a public sponsor", () => {
  assert.equal(deriveSponsorshipState({ applicationStatus: "approved", paymentState: "none" }), "inactive");
  assert.equal(publicSponsorActive({ sponsorshipStatus: "active", paymentStatus: "pending" }), false);
});

test("confirmed payment activates exactly the confirmed state", () => {
  assert.equal(deriveSponsorshipState({ applicationStatus: "approved", paymentState: "confirmed" }), "active");
  assert.equal(publicSponsorActive({ sponsorshipStatus: "active", paymentStatus: "confirmed" }), true);
});

test("unresolved payment blocks replacement and expired quote allows a fresh quote", () => {
  assert.equal(canIssueQuote({ applicationStatus: "approved", existingPaymentState: "recovering", eventSponsorable: true }).code, "SPONSORSHIP_PAYMENT_UNRESOLVED");
  assert.equal(canIssueQuote({ applicationStatus: "approved", existingPaymentState: "expired", eventSponsorable: true }).ok, true);
  assert.equal(paymentStateFromQuote({ expires_at: "2026-09-01T00:00:00.000Z" }, future), "expired");
});

test("payment identity binds chain, event, quote, payer, and receipt", () => {
  const identity = immutablePaymentIdentity({ chainId: 56, eventId: "event-a", quoteId: "quote-a", payer: "0xabc", paymentReference: "0xreceipt:0" });
  assert.equal(identity, "event-sponsorship-v1:56:event-a:quote-a:0xabc:0xreceipt:0");
  assert.notEqual(identity, immutablePaymentIdentity({ chainId: 56, eventId: "event-b", quoteId: "quote-a", payer: "0xabc", paymentReference: "0xreceipt:0" }));
});

test("Founding Sponsor ordering uses authoritative confirmation ordering with stable payment tie-break", () => {
  const rows = [
    { id: "b", confirmed_at: "2026-09-05T10:00:00.000Z", signature_reference: "z" },
    { id: "a", confirmed_at: "2026-09-05T09:00:00.000Z", signature_reference: "q" },
    { id: "c", confirmed_at: "2026-09-05T10:00:00.000Z", signature_reference: "a" },
  ];
  assert.deepEqual(deterministicFoundingSponsorOrder(rows).map((r) => r.id), ["a", "c", "b"]);
});

test("event cancellation after confirmed payment requires operator policy and never invents refund economics", () => {
  assert.deepEqual(cancellationPolicy({ paymentState: "confirmed" }), {
    state: "operator_policy_required",
    refundable: null,
    treasuryMovementAllowed: false,
    reason: "Founder material does not define an automatic refund rule for a confirmed event sponsorship cancellation.",
  });
  assert.equal(deriveSponsorshipState({ applicationStatus: "approved", paymentState: "confirmed", eventCancelled: true }), "operator_policy_required");
});

test("advertising sponsorship remains a separate product contract", () => {
  const contract = eventSponsorshipContractSummary();
  assert.equal(contract.advertisingSystem, "separate:sponsorship_applications");
  assert.deepEqual(contract.allocationBps, { prize: 7000, marketing: 2000, protocol: 1000 });
  assert.equal(contract.explicitlyIneligible.includes("battle"), true);
  assert.equal(contract.explicitlyIneligible.includes("quarterly_championship"), true);
});
