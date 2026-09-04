import test from "node:test";
import assert from "node:assert/strict";

import {
  EVENT_SPONSORSHIP_SPLIT,
  isEventSponsorable,
  presentEventSponsor,
  presentEventSponsorship,
  presentEventSponsorshipQuote,
} from "./eventSponsorshipPresentation.mjs";

test("only founder-locked organized event types are sponsorable", () => {
  for (const eventType of ["normal_tournament", "vote_tournament", "monthly_mwl", "quarterly_championship"]) {
    assert.equal(isEventSponsorable({ eventType }), true);
  }
  assert.equal(isEventSponsorable({ eventType: "battle" }), false);
  assert.equal(isEventSponsorable({ eventType: "normal_battle" }), false);
});

test("sponsorship economics stay 70/20/10", () => {
  assert.deepEqual(EVENT_SPONSORSHIP_SPLIT, { eventPrize: 70, marketing: 20, protocol: 10 });
  const model = presentEventSponsorship({
    eventType: "vote_tournament",
    chainId: 56,
    sponsorshipOpen: true,
    sponsorshipPrizeNative: 7,
  });
  assert.equal(model.splitLabel, "70% EVENT PRIZE · 20% MARKETING · 10% PROTOCOL");
  assert.equal(model.symbol, "BNB");
  assert.equal(model.sponsorshipOpen, true);
});

test("event chain determines payment asset", () => {
  assert.equal(presentEventSponsorship({ eventType: "monthly_mwl", chainId: 56 }).symbol, "BNB");
  assert.equal(presentEventSponsorship({ eventType: "monthly_mwl", chainId: 101 }).symbol, "SOL");
  assert.equal(presentEventSponsorship({ eventType: "monthly_mwl", chainId: 4663 }).symbol, "ETH");
});

test("public sponsor contribution represents event-prize share", () => {
  const sponsor = presentEventSponsor({
    projectName: "ALPHA",
    chainId: 56,
    eventPrizeNative: 7,
    foundingSponsor: true,
  });
  assert.equal(sponsor.badgeLabel, "FOUNDING SPONSOR · MEMEWARZONE 2026");
  assert.equal(sponsor.contributionLabel, "7 BNB added to this prize pool");
});

test("quote is invalid until authoritative native quote identity exists", () => {
  assert.equal(presentEventSponsorshipQuote({ chainId: 56, grossNative: 1 }).valid, false);
  assert.equal(
    presentEventSponsorshipQuote({ quoteId: "q1", chainId: 56, grossNative: 1, minimumUsd: 49 }).valid,
    true,
  );
});
