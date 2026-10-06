import assert from "node:assert/strict";
import test from "node:test";

import {
  checkVies,
  evidenceEventSql,
  evidenceStatus,
  resolveEvidenceEvents,
  resolveVatTreatment,
  validateVatCustomerInput,
  vatFraction,
  vatOfDay,
  vatReturnsByPeriod,
} from "./financeVat.js";
import { effectiveTaxRuleSet } from "./financeTaxRules.js";
import { computeWeeks } from "./financeAccountingWeekly.js";
import { evidenceByDay } from "./financeVat.js";

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.011, `${msg}: ${a} vs ${b}`);
const rules = () => effectiveTaxRuleSet(null);
const business = (country, extra = {}) => ({ customerType: "business", country, vatId: null, businessNumber: null, viesStatus: "not_checked", evidence: [], ...extra });
const consumer = (country, items) => ({ customerType: "consumer", country, evidence: items.map(([kind, c]) => ({ kind, country: c })) });

test("defaults: every anonymous lane keeps 21% as VAT included; Meteora referral outside the scope; sponsors per customer", () => {
  const r = rules();
  near(vatFraction(r.vat.lanes.trading_fees) * 121, 21, "21/121");
  assert.equal(vatFraction(r.vat.lanes.dbc_referral), 0);
  assert.equal(vatFraction({ treatment: "reverse_charge", rate: 0.21, taxableShare: 1 }), 0);
  assert.equal(vatFraction({ treatment: "taxable", rate: 0.21, taxableShare: 1 }) > 0, true, "the old name still reserves");
  for (const lane of ["trading_fees", "graduation_fees", "import_swaps", "upvotes", "arena_boosts", "battle_entries"]) {
    assert.equal(r.vat.lanes[lane].evidence, "none", lane);
    assert.equal(r.vat.lanes[lane].rate, 0.21, lane);
  }
  assert.equal(r.vat.lanes.sponsorships.evidence, "customer");
  assert.equal(r.vat.lanes.home_placements.evidence, "customer");
  assert.equal(r.vat.oss.thresholdEur, 10000);
  assert.equal(r.vat.oss.rates.FI, 0.255);
  assert.equal(Object.keys(r.vat.oss.rates).length, 27);
});

test("evidence status: VIES-valid EU business, Dutch business, non-EU business number, two matching consumer items", () => {
  assert.equal(evidenceStatus(null).status, "none");
  assert.equal(evidenceStatus(business("NL")).status, "business_nl");
  assert.equal(evidenceStatus(business("DE", { vatId: "DE123456789", viesStatus: "valid" })).status, "business_eu");
  assert.equal(evidenceStatus(business("DE", { vatId: "DE123456789", viesStatus: "invalid" })).status, "none", "invalid VIES: a consumer (art. 18(2))");
  assert.equal(evidenceStatus(business("DE", { vatId: "DE123456789", viesStatus: "unavailable" })).status, "none");
  assert.equal(evidenceStatus(business("US", { businessNumber: "EIN 12-3456789" })).status, "business_non_eu");
  assert.equal(evidenceStatus(business("US")).status, "none", "non-EU business needs a number (art. 18(3))");
  assert.equal(evidenceStatus(consumer("FR", [["billing_address", "FR"], ["ip_geolocation", "FR"]])).status, "consumer_eu");
  assert.equal(evidenceStatus(consumer("FR", [["billing_address", "FR"], ["ip_geolocation", "BE"]])).status, "none", "contradicting items");
  assert.equal(evidenceStatus(consumer("FR", [["billing_address", "FR"], ["billing_address", "FR"]])).status, "none", "two items of the same kind");
  assert.equal(evidenceStatus(consumer("US", [["billing_address", "US"], ["bank_country", "US"]])).status, "consumer_non_eu");
});

test("treatment per lane: reverse charge, outside scope, 21%; consumers of non-automated ads stay Dutch; ESS consumers follow the EUR 10,000 threshold", () => {
  const r = rules();
  const s = r.vat.lanes.sponsorships;
  assert.equal(resolveVatTreatment(s, business("DE", { vatId: "DE1", viesStatus: "valid" }), r).treatment, "reverse_charge");
  assert.equal(resolveVatTreatment(s, business("US", { businessNumber: "x" }), r).treatment, "outside_scope");
  assert.equal(resolveVatTreatment(s, business("NL"), r).treatment, "taxable_nl");
  assert.equal(resolveVatTreatment(s, null, r).byEvidence, false, "no evidence: default");
  assert.equal(resolveVatTreatment(s, consumer("US", [["billing_address", "US"], ["bank_country", "US"]]), r).treatment, "taxable_nl", "art. 45: not an ESS");
  // Trading fees have no customer evidence at all: the default always applies.
  assert.equal(resolveVatTreatment(r.vat.lanes.trading_fees, business("DE", { vatId: "DE1", viesStatus: "valid" }), r).byEvidence, false);
  const ess = { ...s, ess: true };
  const fr = consumer("FR", [["billing_address", "FR"], ["ip_geolocation", "FR"]]);
  assert.equal(resolveVatTreatment(ess, fr, r, { crossBorderB2cEur: 9000 }).treatment, "taxable_nl", "under the threshold");
  const over = resolveVatTreatment(ess, fr, r, { crossBorderB2cEur: 10001 });
  assert.equal(over.treatment, "oss_destination");
  assert.equal(over.rate, 0.2);
  assert.equal(resolveVatTreatment(ess, consumer("US", [["billing_address", "US"], ["bank_country", "US"]]), r).treatment, "outside_scope");
});

test("threshold runs per calendar year and counts the year before; events resolve in time order", () => {
  const r = rules();
  r.vat.lanes.home_placements.ess = true;
  const fr = consumer("FR", [["billing_address", "FR"], ["ip_geolocation", "FR"]]);
  const ev = (at, usd) => ({ at, laneId: "home-placements:56", amountUsd: usd, customer: fr });
  const out = resolveEvidenceEvents([ev("2026-03-01T00:00:00Z", 6000), ev("2026-02-01T00:00:00Z", 6000), ev("2026-04-01T00:00:00Z", 1000), ev("2027-01-05T00:00:00Z", 100)], r, () => 1);
  assert.deepEqual(out.map((e) => e.treatment), ["taxable_nl", "taxable_nl", "oss_destination", "oss_destination"], "over 10k from the third sale on, and the next year too (last year over)");
  near(out[2].vatEur, 1000 * 0.2 / 1.2, "French 20% as VAT included");
  near(out[2].defaultVatEur, 1000 * 21 / 121, "what the default would have reserved");
});

test("a day's VAT: evidence events leave the lane default; release = default minus actual; return boxes", () => {
  const r = rules();
  const lanes = [{ laneId: "sponsorships:56", amountUsd: 1210 }, { laneId: "bonding-route:101", amountUsd: 121 }];
  const evidence = resolveEvidenceEvents([{ at: "2026-09-10T10:00:00Z", laneId: "sponsorships:56", amountUsd: 1000, customer: business("DE", { vatId: "DE123456789", viesStatus: "valid" }) }], r, () => 1);
  const day = vatOfDay(lanes, r, 1, evidence);
  near(day.defaultVatEur, (1210 + 121) * 21 / 121, "everything at 21% without evidence");
  near(day.vatEur, (210 + 121) * 21 / 121, "1,000 under reverse charge");
  near(day.ret.r3b.baseEur, 1000, "rubriek 3b");
  assert.deepEqual(Object.keys(day.ret.icp), ["DE123456789"], "ICP per VAT number");
  near(day.ret.r1a.baseEur, (210 + 121) * 100 / 121, "rubriek 1a base excludes VAT");

  const segments = [{ start: "2026-09-10", vatReturn: day.ret, otherRevenueEur: 121, otherVatEur: 21 }];
  const [q] = vatReturnsByPeriod(segments, "quarter");
  assert.equal(q.period, "2026-Q3");
  near(q.nl.r1a.vatEur, (210 + 121) * 21 / 121 + 21, "1a VAT includes VAT on bank receipts");
  near(q.nl.r1a.baseEur, (210 + 121) * 100 / 121 + 100, "and their base");
  near(q.releasedByEvidenceEur, 1000 * 21 / 121, "released by the VIES-checked VAT number");
  assert.equal(q.oss.vatDueEur, 0);
  assert.equal(q.nl.icp[0].baseEur, 1000);
});

test("weekly model: evidence lowers the segment VAT and keeps the default beside it", () => {
  const r = rules();
  const days = { "2026-09-22": { totalUsd: 1210, lanes: [{ laneId: "home-placements:56", amountUsd: 1210 }] } };
  const base = { today: "2026-10-04", fromDate: "2026-09-21", days, usdPerEur: () => 1, rules: r };
  const plain = computeWeeks(base);
  const seg = plain.segments.find((s) => s.start <= "2026-09-22" && s.end >= "2026-09-22");
  near(seg.vatEur, 210, "default 21% of 1,210");
  const evidence = evidenceByDay(resolveEvidenceEvents([{ at: "2026-09-22T09:00:00Z", laneId: "home-placements:56", amountUsd: 1210, customer: business("US", { businessNumber: "C-1" }) }], r, () => 1));
  const withEvidence = computeWeeks({ ...base, vatEvidence: evidence });
  const seg2 = withEvidence.segments.find((s) => s.start <= "2026-09-22" && s.end >= "2026-09-22");
  near(seg2.vatEur, 0, "non-EU business: outside the scope");
  near(seg2.vatDefaultEur, 210, "the default stays visible for the release");
  near(seg2.vatReturn.notReported.outsideScopeEur, 1210, "not reported");
});

test("customer input: country codes, VAT number prefix, evidence items; VIES result mapping", async () => {
  const v = validateVatCustomerInput({ customerType: "business", country: "de", vatId: "123 456 789" });
  assert.equal(v.country, "DE");
  assert.equal(v.vatId, "DE123456789");
  assert.equal(validateVatCustomerInput({ customerType: "business", country: "GR", vatId: "123456789" }).vatId, "EL123456789", "Greece is EL in VIES");
  assert.throws(() => validateVatCustomerInput({ customerType: "x", country: "DE" }), /business or consumer/);
  assert.throws(() => validateVatCustomerInput({ customerType: "consumer", country: "Germany" }), /two-letter/);
  assert.throws(() => validateVatCustomerInput({ customerType: "consumer", country: "DE", evidence: [{ kind: "ip_address", country: "DE" }] }), /kind must be/);
  const fetchOk = async (url) => { assert.match(url, /\/ms\/DE\/vat\/123456789$/); return { ok: true, json: async () => ({ isValid: true, name: "ACME GMBH", userError: "VALID" }) }; };
  assert.deepEqual((({ status, name }) => ({ status, name }))(await checkVies("DE123456789", { fetchImpl: fetchOk })), { status: "valid", name: "ACME GMBH" });
  const fetchBad = async () => ({ ok: true, json: async () => ({ isValid: false, userError: "INVALID" }) });
  assert.equal((await checkVies("DE1", { fetchImpl: fetchBad })).status, "invalid");
  const fetchDown = async () => ({ ok: true, json: async () => ({ isValid: false, userError: "MS_UNAVAILABLE" }) });
  assert.equal((await checkVies("DE1", { fetchImpl: fetchDown })).status, "unavailable", "an outage is never invalid");
  assert.equal((await checkVies("DE1", { fetchImpl: async () => { throw new Error("timeout"); } })).status, "unavailable");
});

test("evidence SQL reuses the revenue lane filters and joins the customer", () => {
  const s = evidenceEventSql("sponsorships");
  assert.match(s, /p\.status = 'confirmed'/);
  assert.match(s, /c\.subject_kind = 'sponsor_profile' and c\.subject_id = es\.sponsor_profile_id::text/);
  const h = evidenceEventSql("home_placements");
  assert.match(h, /payment_status in \('paid', 'verified'\)/);
  assert.match(h, /c\.subject_kind = 'sponsorship_application' and c\.subject_id = a\.id::text/);
});
