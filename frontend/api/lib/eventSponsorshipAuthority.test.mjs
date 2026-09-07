import assert from "node:assert/strict";
import test from "node:test";

import { sponsorshipSplit } from "./arenaSponsorshipRuntime.mjs";
import {
  canonicalEventSponsorshipEntitlementKey,
  canonicalEventSponsorshipType,
  eventSponsorshipContractSummary,
  nativeAssetForEventSponsorship,
  publicSponsorActive,
  resolveSponsorableEvent,
  tierMinimumColumnForEventType,
} from "./eventSponsorshipAuthority.mjs";

function fakeDb({ registry, tournament = null, league = null, championship = null, wrongChain = false }) {
  return {
    async query(sql, params) {
      if (sql.includes("from public.sponsorship_events")) {
        if (wrongChain && params?.length > 1) return { rows: [] };
        return { rows: registry ? [registry] : [] };
      }
      if (sql.includes("from public.arena_championship_epochs")) return { rows: championship ? [championship] : [] };
      if (sql.includes("from public.arena_tournaments")) return { rows: tournament ? [tournament] : [] };
      if (sql.includes("from public.arena_league_seasons")) return { rows: league ? [league] : [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const now = Date.parse("2026-09-08T12:00:00.000Z");
const baseRegistry = {
  id: "11111111-1111-4111-8111-111111111111",
  event_reference_id: "t-1",
  event_type: "normal_tournament",
  chain_id: 56,
  starts_at: "2026-09-01T00:00:00.000Z",
  ends_at: "2026-09-20T00:00:00.000Z",
  sponsorship_open: true,
};

test("normal and vote tournaments resolve only through tournament authority", async () => {
  for (const [eventType, battleMode] of [["normal_tournament", "normal"], ["vote_tournament", "vote"]]) {
    const result = await resolveSponsorableEvent(fakeDb({
      registry: { ...baseRegistry, event_type: eventType },
      tournament: { id: "t-1", chain_id: 56, status: "upcoming", origin: "custom", battle_mode: battleMode, starts_at: baseRegistry.starts_at, ends_at: baseRegistry.ends_at },
    }), { eventRef: baseRegistry.id, nowMs: now });
    assert.equal(result.ok, true);
    assert.equal(result.sponsorable, true);
    assert.equal(result.eventType, eventType);
  }
});

test("Monthly MWL binds exact canonical monthly season identity", async () => {
  const seasonId = "mwl-2026-m09-c56";
  const result = await resolveSponsorableEvent(fakeDb({
    registry: { ...baseRegistry, event_type: "monthly_mwl", event_reference_id: seasonId },
    league: { id: seasonId, chain_id: 56, state: "live", active: true, reset_at: "2026-10-01T00:00:00.000Z" },
  }), { eventRef: baseRegistry.id, nowMs: now });
  assert.equal(result.ok, true);
  assert.equal(result.sponsorable, true);
  assert.equal(result.eventType, "monthly_mwl");
  assert.equal(result.canonical.kind, "major_war_league");
  assert.equal(result.canonical.seasonId, seasonId);
});

test("Quarterly Championship binds exact #220 arena_championship_epochs identity", async () => {
  const epochId = "quarterly-championship-2026-q3-c56";
  const result = await resolveSponsorableEvent(fakeDb({
    registry: { ...baseRegistry, event_type: "quarterly_championship", event_reference_id: epochId, ends_at: "2026-10-01T00:00:00.000Z" },
    championship: { id: epochId, event_type: "quarterly_championship", chain_id: 56, year: 2026, quarter: 3, state: "open", opens_at: "2026-07-01T00:00:00.000Z", closes_at: "2026-10-01T00:00:00.000Z" },
  }), { eventRef: baseRegistry.id, nowMs: now });
  assert.equal(result.ok, true);
  assert.equal(result.sponsorable, true);
  assert.equal(result.eventType, "quarterly_championship");
  assert.equal(result.canonical.kind, "quarterly_championship");
  assert.equal(result.canonical.epochId, epochId);
  assert.equal(result.canonical.childEventId, null);
  assert.equal(result.canonical.parentEventId, null);
  assert.equal(result.canonical.relationship, "sponsorship_events.event_reference_id=arena_championship_epochs.id");
  assert.equal(canonicalEventSponsorshipEntitlementKey(result), `56:quarterly_championship:${epochId}`);
});

test("legacy mwl_quarter_finals can resolve the canonical epoch but is read-only for new purchases", async () => {
  const epochId = "quarterly-championship-2026-q3-c56";
  const result = await resolveSponsorableEvent(fakeDb({
    registry: { ...baseRegistry, event_type: "mwl_quarter_finals", event_reference_id: epochId, ends_at: "2026-10-01T00:00:00.000Z" },
    championship: { id: epochId, event_type: "quarterly_championship", chain_id: 56, year: 2026, quarter: 3, state: "open", opens_at: "2026-07-01T00:00:00.000Z", closes_at: "2026-10-01T00:00:00.000Z" },
  }), { eventRef: baseRegistry.id, nowMs: now });
  assert.equal(result.ok, true);
  assert.equal(result.eventType, "quarterly_championship");
  assert.equal(result.registryEventType, "mwl_quarter_finals");
  assert.equal(result.sponsorable, false);
  assert.equal(result.sponsorabilityReason, "legacy_quarterly_alias_read_only");
  assert.equal(canonicalEventSponsorshipType("mwl_quarter_finals"), "quarterly_championship");
  assert.equal(canonicalEventSponsorshipEntitlementKey(result), `56:quarterly_championship:${epochId}`);
});

test("a historical quarter-final tournament can never become the new quarterly sponsorship target", async () => {
  const result = await resolveSponsorableEvent(fakeDb({
    registry: { ...baseRegistry, event_type: "normal_tournament" },
    tournament: { id: "t-1", chain_id: 56, status: "upcoming", origin: "quarter_finals", battle_mode: "normal", starts_at: baseRegistry.starts_at, ends_at: baseRegistry.ends_at },
  }), { eventRef: baseRegistry.id, nowMs: now });
  assert.equal(result.ok, false);
  assert.equal(result.code, "LEGACY_QUARTER_FINAL_TOURNAMENT_NOT_SPONSORABLE");
});

test("closed or expired quarterly epochs fail closed", async () => {
  const epochId = "quarterly-championship-2026-q2-c56";
  const result = await resolveSponsorableEvent(fakeDb({
    registry: { ...baseRegistry, event_type: "quarterly_championship", event_reference_id: epochId, ends_at: "2026-07-01T00:00:00.000Z" },
    championship: { id: epochId, event_type: "quarterly_championship", chain_id: 56, year: 2026, quarter: 2, state: "closed", opens_at: "2026-04-01T00:00:00.000Z", closes_at: "2026-07-01T00:00:00.000Z" },
  }), { eventRef: baseRegistry.id, nowMs: now });
  assert.equal(result.ok, true);
  assert.equal(result.sponsorable, false);
});

test("wrong chain cannot resolve a canonical event", async () => {
  const result = await resolveSponsorableEvent(fakeDb({ registry: baseRegistry, wrongChain: true }), { eventRef: baseRegistry.id, chainId: 101, nowMs: now });
  assert.equal(result.ok, false);
  assert.equal(result.code, "EVENT_NOT_FOUND");
});

test("pricing columns are isolated by commercial event class", () => {
  assert.equal(tierMinimumColumnForEventType("normal_tournament"), "tournament_min_usd_cents");
  assert.equal(tierMinimumColumnForEventType("vote_tournament"), "tournament_min_usd_cents");
  assert.equal(tierMinimumColumnForEventType("monthly_mwl"), "mwl_min_usd_cents");
  assert.equal(tierMinimumColumnForEventType("quarterly_championship"), "quarterly_min_usd_cents");
  assert.equal(tierMinimumColumnForEventType("mwl_quarter_finals"), "quarterly_min_usd_cents");
});

test("public sponsor activation requires confirmed payment", () => {
  assert.equal(publicSponsorActive({ sponsorshipStatus: "active", paymentStatus: "confirmed" }), true);
  assert.equal(publicSponsorActive({ sponsorshipStatus: "active", paymentStatus: "pending" }), false);
  assert.equal(publicSponsorActive({ sponsorshipStatus: "pending_payment", paymentStatus: "confirmed" }), false);
});

test("70/20/10 sponsorship economics are unchanged and conserve raw units", () => {
  for (const gross of [1n, 10n, 1001n, 999999999999999999n]) {
    const split = sponsorshipSplit(gross);
    assert.equal(split.prize + split.marketing + split.protocol, gross);
    assert.equal(split.marketing, (gross * 2000n) / 10000n);
    assert.equal(split.protocol, (gross * 1000n) / 10000n);
    assert.equal(split.prize, gross - split.marketing - split.protocol);
  }
});

test("native routes remain BNB, SOL and Robinhood ETH", () => {
  assert.deepEqual(nativeAssetForEventSponsorship(56), { symbol: "BNB", decimals: 18, family: "evm" });
  assert.deepEqual(nativeAssetForEventSponsorship(101), { symbol: "SOL", decimals: 9, family: "solana" });
  assert.deepEqual(nativeAssetForEventSponsorship(4663), { symbol: "ETH", decimals: 18, family: "evm" });
});

test("commercial contract exposes one canonical quarterly product", () => {
  const contract = eventSponsorshipContractSummary();
  assert.equal(contract.eligibleEventTypes.includes("quarterly_championship"), true);
  assert.equal(contract.eligibleEventTypes.includes("mwl_quarter_finals"), false);
  assert.equal(contract.legacyEventTypeAliases.mwl_quarter_finals, "quarterly_championship");
  assert.equal(contract.quarterlyAuthority, "arena_championship_epochs");
  assert.deepEqual(contract.allocationBps, { prize: 7000, marketing: 2000, protocol: 1000 });
});
