import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Interface, Wallet, verifyTypedData } from "ethers";

import {
  assertSponsorshipPaidMatches,
  decodeSponsorshipPaidLog,
  readSponsorshipPricingConfig,
  signSponsorshipQuote,
  sponsorshipEventId,
  sponsorshipPricingTierId,
  sponsorshipSplit,
  usdMicrosToNativeRaw,
} from "./arenaSponsorshipRuntime.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.join(here, "..");
const PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ROUTER = "0x1111111111111111111111111111111111111111";
const SPONSOR = "0x2222222222222222222222222222222222222222";

function readApi(rel) {
  return fs.readFileSync(path.join(apiRoot, rel), "utf8");
}

test("sponsorship identities are deterministic and domain-separated", () => {
  assert.match(sponsorshipEventId("event-1"), /^0x[0-9a-f]{64}$/i);
  assert.equal(sponsorshipEventId("event-1"), sponsorshipEventId("event-1"));
  assert.notEqual(sponsorshipEventId("event-1"), sponsorshipEventId("event-2"));
  assert.equal(sponsorshipPricingTierId("founding"), sponsorshipPricingTierId("FOUNDING"));
});

test("sponsorship split conserves every wei at founder-locked 70/20/10", () => {
  const split = sponsorshipSplit(101n);
  assert.equal(split.marketing, 20n);
  assert.equal(split.protocol, 10n);
  assert.equal(split.prize, 71n);
  assert.equal(split.prize + split.marketing + split.protocol, 101n);
  assert.deepEqual(
    { eventBps: split.eventBps, marketingBps: split.marketingBps, protocolBps: split.protocolBps },
    { eventBps: 7000, marketingBps: 2000, protocolBps: 1000 },
  );
});

test("USD sponsorship amounts convert to native raw with ceiling protection", () => {
  const nativeRaw = usdMicrosToNativeRaw(49_000_000n, 600_000_000n, 18);
  assert.equal(nativeRaw, 81_666_666_666_666_667n);
  assert.ok(nativeRaw * 600_000_000n >= 49_000_000n * 10n ** 18n);
});

test("signed sponsorship quote binds event, sponsor, tier, price snapshot and requested amount", async () => {
  const signer = new Wallet(PRIVATE_KEY);
  const config = readSponsorshipPricingConfig(56, {
    ARENA_SPONSORSHIP_NATIVE_USD_MICROS_56: "600000000",
    ARENA_SPONSORSHIP_PRICING_VERSION_56: "7",
    ARENA_SPONSORSHIP_NATIVE_USD_UPDATED_AT_56: "1000",
    ARENA_SPONSORSHIP_PRICE_MAX_AGE_SECONDS_56: "300",
    WARZONE_SPONSORSHIP_ROUTER_V1_ADDRESS_56: ROUTER,
    ARENA_SPONSORSHIP_QUOTE_SIGNER_PRIVATE_KEY: PRIVATE_KEY,
    ARENA_SPONSORSHIP_QUOTE_SIGNER_ADDRESS_56: signer.address,
  }, 1100);
  const signed = await signSponsorshipQuote({
    config,
    eventUuid: "00000000-0000-0000-0000-000000000001",
    sponsor: SPONSOR,
    pricingTierCode: "FOUNDING",
    minimumUsdMicros: 49_000_000n,
    requestedUsdMicros: 100_000_000n,
    nonce: 77n,
    deadline: 1400n,
  });
  assert.equal(signed.value.sponsor, SPONSOR);
  assert.equal(signed.value.pricingVersion, 7n);
  assert.equal(signed.value.nativeUsdReferenceMicros, 600_000_000n);
  assert.equal(signed.value.minimumUsdMicros, 49_000_000n);
  assert.equal(signed.value.requestedUsdMicros, 100_000_000n);
  assert.equal(
    verifyTypedData(signed.domain, signed.types, signed.value, signed.signature),
    signer.address,
  );
});

test("SponsorshipPaid receipt verification binds signed economics and exact 70/20/10 event fields", () => {
  const eventUuid = "00000000-0000-0000-0000-000000000001";
  const gross = 1_000_000_000_000_003n;
  const split = sponsorshipSplit(gross);
  const iface = new Interface([
    "event SponsorshipPaid(bytes32 indexed eventId,address indexed sponsor,uint256 indexed nonce,bytes32 pricingTier,uint256 pricingVersion,uint256 minimumUsdMicros,uint256 requestedUsdMicros,uint256 nativeUsdReferenceMicros,uint256 oracleTimestamp,uint256 grossNativeRaw,uint256 eventNativeRaw,uint256 marketingNativeRaw,uint256 protocolNativeRaw)",
  ]);
  const encoded = iface.encodeEventLog(iface.getEvent("SponsorshipPaid"), [
    sponsorshipEventId(eventUuid),
    SPONSOR,
    77n,
    sponsorshipPricingTierId("FOUNDING"),
    7n,
    49_000_000n,
    100_000_000n,
    600_000_000n,
    1000n,
    gross,
    split.prize,
    split.marketing,
    split.protocol,
  ]);
  const event = decodeSponsorshipPaidLog({ address: ROUTER, topics: encoded.topics, data: encoded.data }, ROUTER);
  assert.doesNotThrow(() => assertSponsorshipPaidMatches(event, {
    eventUuid,
    sponsor: SPONSOR,
    nonce: 77n,
    pricingTierCode: "FOUNDING",
    pricingVersion: 7n,
    minimumUsdMicros: 49_000_000n,
    requestedUsdMicros: 100_000_000n,
    requestedNativeRaw: gross,
    nativeUsdReferenceMicros: 600_000_000n,
    oracleTimestamp: 1000n,
  }));
  assert.throws(() => assertSponsorshipPaidMatches(event, {
    eventUuid,
    sponsor: SPONSOR,
    nonce: 77n,
    pricingTierCode: "FOUNDING",
    pricingVersion: 7n,
    minimumUsdMicros: 49_000_000n,
    requestedUsdMicros: 100_000_000n,
    requestedNativeRaw: gross + 1n,
    nativeUsdReferenceMicros: 600_000_000n,
    oracleTimestamp: 1000n,
  }), /gross native mismatch/);
});

test("sponsorship API derives price server-side, preflights deployment and uses receipt-level idempotency", () => {
  const api = readApi("arenaSponsorships.js");
  const deployment = readApi("lib/arenaSponsorshipDeploymentVerification.mjs");
  assert.match(api, /sponsorship_price_overrides/);
  assert.match(api, /active_tier_id/);
  assert.match(api, /verified_wallet is not null/);
  assert.match(api, /verifySponsorshipDeployment/);
  assert.match(api, /SPONSORSHIP_CHAIN_NOT_SUPPORTED/);
  assert.match(api, /requireInternalAuth\(req, res, \{ routeLabel: "arena_sponsorship_confirm" \}\)/);
  assert.match(api, /signature_reference = \$2/);
  assert.match(api, /prizeBps: 7000/);
  assert.match(api, /marketingOpsBps: 2000/);
  assert.match(api, /protocolBps: 1000/);
  assert.match(deployment, /router\.quoteSigner\(\)/);
  assert.match(deployment, /router\.enabledEvents\(eventId\)/);
  assert.match(deployment, /vault\.eventReceivers\(eventId\)/);
});
