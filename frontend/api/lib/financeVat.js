// VAT per revenue event from customer evidence, and the quarterly VAT return
// figures (Dutch return + OSS return). Research 2026-10-06, sources in
// financeTaxRules.js (vat.*):
//
//   Place of supply. B2B (art. 44 Directive 2006/112/EC): where the business
//   customer is. An EU business with a valid VAT number (checked in VIES,
//   art. 18(1) Reg. 282/2011): reverse charge, NL return rubriek 3b + ICP. A
//   Dutch business: 21%, rubriek 1a. A business outside the EU with proof of
//   business status (art. 18(3)): outside the scope, not reported. A customer
//   who gives no VAT number may be treated as a consumer (art. 18(2)).
//   B2C electronically supplied services (art. 58): where the consumer lives,
//   but Dutch VAT while supplies to consumers in other EU countries stay at or
//   under EUR 10,000 this and last calendar year (art. 59c, art. 6k Wet OB);
//   above it, the destination country's rate through the OSS union scheme.
//   B2C services that are not electronically supplied (human-negotiated ads):
//   art. 45, Dutch VAT.
//   Location of a consumer needs two non-contradictory items (art. 24b(d) +
//   24f Reg. 282/2011: billing address, IP geolocation, bank, SIM, land line,
//   other commercially relevant information). Anonymous wallets give none, and
//   the regulation has no fallback, so without evidence the reserve stays at
//   the lane's default (21% on the fee as VAT included).
//
// Evidence exists only where a customer is known: sponsors (sponsor_profiles,
// event sponsorship payments) and Home placement buyers
// (sponsorship_applications). An admin records it on the Tax page
// (finance_vat_customers); the VAT number is checked in VIES server-side.

import { FinanceInputError } from "./financeAccountingCosts.js";
import { LANE_SPECS } from "./financeRevenueLanes.js";
import { vatFraction, vatLaneOf } from "./financeTaxRules.js";

export { vatFraction };

export const EU_COUNTRIES = Object.freeze(["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"]);
export const VAT_TREATMENTS = Object.freeze(["taxable_nl", "reverse_charge", "outside_scope", "exempt", "oss_destination", "uncertain"]);
export const VAT_TREATMENT_LABELS = Object.freeze({
  taxable_nl: "Dutch VAT (21%)",
  reverse_charge: "Reverse charge (EU business)",
  outside_scope: "Outside the scope of Dutch VAT",
  exempt: "Exempt",
  oss_destination: "OSS: VAT of the customer's EU country",
  uncertain: "Uncertain: reserved at 21%",
});
export const VAT_SUBJECT_KINDS = Object.freeze(["sponsor_profile", "sponsorship_application"]);
export const VAT_EVIDENCE_KINDS = Object.freeze(["billing_address", "ip_geolocation", "bank_country", "registration", "other"]);
const VAT_EVIDENCE_LABELS = Object.freeze({ billing_address: "Billing address", ip_geolocation: "IP geolocation", bank_country: "Bank account country", registration: "Company registration", other: "Other commercially relevant information" });

/** VIES and EU systems use EL for Greece. */
export function viesCountry(country) {
  return country === "GR" ? "EL" : country;
}

// ------------------------------------------------------------------ customer evidence

/** Validates the evidence form for one customer. */
export function validateVatCustomerInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new FinanceInputError("Send the customer evidence as a JSON object.");
  const customerType = String(body.customerType || "");
  if (!["business", "consumer"].includes(customerType)) throw new FinanceInputError("customerType must be business or consumer.", "customerType");
  const country = String(body.country || "").trim().toUpperCase().replace(/^EL$/, "GR");
  if (!/^[A-Z]{2}$/.test(country)) throw new FinanceInputError("country must be a two-letter country code (NL, DE, US).", "country");
  let vatId = String(body.vatId || "").toUpperCase().replace(/[\s.-]/g, "");
  if (vatId.length > 20) throw new FinanceInputError("vatId is longer than 20 characters.", "vatId");
  if (vatId && EU_COUNTRIES.includes(country)) {
    const prefix = viesCountry(country);
    if (!vatId.startsWith(prefix)) vatId = `${prefix}${vatId}`;
    if (!/^[A-Z]{2}[A-Z0-9]{2,14}$/.test(vatId)) throw new FinanceInputError("vatId does not look like an EU VAT number.", "vatId");
  }
  const businessNumber = String(body.businessNumber || "").trim();
  if (businessNumber.length > 60) throw new FinanceInputError("businessNumber is longer than 60 characters.", "businessNumber");
  const evidence = Array.isArray(body.evidence) ? body.evidence : [];
  if (evidence.length > 6) throw new FinanceInputError("At most 6 evidence items.", "evidence");
  const items = evidence.map((e, i) => {
    const kind = String(e?.kind || "");
    if (!VAT_EVIDENCE_KINDS.includes(kind)) throw new FinanceInputError(`evidence ${i + 1}: kind must be one of ${VAT_EVIDENCE_KINDS.join(", ")}.`, "evidence");
    const c = String(e?.country || "").trim().toUpperCase().replace(/^EL$/, "GR");
    if (!/^[A-Z]{2}$/.test(c)) throw new FinanceInputError(`evidence ${i + 1}: country must be a two-letter code.`, "evidence");
    const note = String(e?.note || "").trim();
    if (note.length > 200) throw new FinanceInputError(`evidence ${i + 1}: note is longer than 200 characters.`, "evidence");
    return { kind, country: c, note };
  });
  const note = String(body.note || "").trim();
  if (note.length > 500) throw new FinanceInputError("note is longer than 500 characters.", "note");
  return { customerType, country, vatId: vatId || null, businessNumber: businessNumber || null, evidence: items, note };
}

/**
 * VIES check of an EU VAT number (European Commission REST API, no key). Only
 * the validity and the registered name are kept: they are the evidence for
 * reverse charge. A VIES outage is "unavailable", never "invalid".
 */
export async function checkVies(vatId, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const m = /^([A-Z]{2})([A-Z0-9]+)$/.exec(String(vatId || ""));
  if (!m) return { status: "not_checked", name: null, checkedAt: null, error: "No VAT number." };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`https://ec.europa.eu/taxation_customs/vies/rest-api/ms/${m[1]}/vat/${m[2]}`, { headers: { Accept: "application/json" }, signal: controller.signal });
    const body = await response.json().catch(() => null);
    const checkedAt = new Date().toISOString();
    if (!response.ok || !body || body.userError && body.userError !== "VALID" && body.userError !== "INVALID") {
      return { status: "unavailable", name: null, checkedAt, error: String(body?.userError || `VIES answered ${response.status}`).slice(0, 120) };
    }
    const name = typeof body.name === "string" && body.name.trim() && body.name.trim() !== "---" ? body.name.trim().slice(0, 200) : null;
    return { status: body.isValid === true ? "valid" : "invalid", name, checkedAt, error: null };
  } catch (error) {
    return { status: "unavailable", name: null, checkedAt: new Date().toISOString(), error: String(error?.message || "VIES did not answer").slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What the evidence of one customer proves, independent of the lane:
 *   business_nl | business_eu (valid VIES) | business_non_eu (business number or
 *   VAT number recorded) | consumer_nl | consumer_eu (two matching items, other
 *   EU country) | consumer_non_eu (two matching items, outside the EU) | none.
 */
export function evidenceStatus(customer) {
  if (!customer) return { status: "none", reason: "No evidence recorded." };
  const eu = EU_COUNTRIES.includes(customer.country);
  if (customer.customerType === "business") {
    if (customer.country === "NL") return { status: "business_nl", reason: "Dutch business." };
    if (eu) {
      if (customer.viesStatus === "valid") return { status: "business_eu", reason: `VAT number ${customer.vatId} valid in VIES (${customer.viesCheckedAt?.slice(0, 10) || "date unknown"}).` };
      return { status: "none", reason: customer.vatId ? `VAT number ${customer.vatId} is ${customer.viesStatus === "invalid" ? "not valid" : "not confirmed"} in VIES, so the customer counts as a consumer (art. 18(2)).` : "EU business without a VAT number counts as a consumer (art. 18(2))." };
    }
    if (customer.businessNumber || customer.vatId) return { status: "business_non_eu", reason: `Business outside the EU with number ${customer.businessNumber || customer.vatId} (art. 18(3)).` };
    return { status: "none", reason: "Business outside the EU without a business or tax number (art. 18(3) needs one)." };
  }
  const items = (customer.evidence || []).filter((e) => e.country);
  const kinds = new Set(items.map((e) => e.kind));
  const agree = items.length >= 2 && kinds.size >= 2 && items.every((e) => e.country === customer.country);
  if (!agree) return { status: "none", reason: "A consumer's country needs two different items of evidence that agree (art. 24b(d) and 24f Reg. 282/2011)." };
  if (customer.country === "NL") return { status: "consumer_nl", reason: "Consumer in the Netherlands (two items agree)." };
  return eu ? { status: "consumer_eu", reason: `Consumer in ${customer.country} (two items agree).` } : { status: "consumer_non_eu", reason: `Consumer outside the EU in ${customer.country} (two items agree).` };
}

/**
 * Treatment of one event of a lane for one customer. `crossBorderB2cEur` is the
 * EU cross-border B2C ESS total this and last calendar year before this event
 * (art. 59c). Without usable evidence the lane's default applies.
 */
export function resolveVatTreatment(laneRule, customer, rules, { crossBorderB2cEur = 0 } = {}) {
  const fallback = { treatment: laneRule.treatment === "taxable" ? "taxable_nl" : laneRule.treatment, rate: Number(laneRule.rate) || 0, taxableShare: Number(laneRule.taxableShare ?? 1), country: null, byEvidence: false, reason: "Lane default (no usable evidence)." };
  if (laneRule.evidence !== "customer" || laneRule.treatment === "exempt") return fallback;
  const ev = evidenceStatus(customer);
  const standard = Number(rules?.vat?.standardRate ?? 0.21);
  const nl = (reason) => ({ treatment: "taxable_nl", rate: standard, taxableShare: 1, country: "NL", byEvidence: true, reason });
  switch (ev.status) {
    case "business_nl": return nl(ev.reason);
    case "business_eu": return { treatment: "reverse_charge", rate: 0, taxableShare: 0, country: customer.country, vatId: customer.vatId, byEvidence: true, reason: ev.reason };
    case "business_non_eu": return { treatment: "outside_scope", rate: 0, taxableShare: 0, country: customer.country, byEvidence: true, reason: ev.reason };
    case "consumer_nl": return nl(ev.reason);
    case "consumer_non_eu": return laneRule.ess ? { treatment: "outside_scope", rate: 0, taxableShare: 0, country: customer.country, byEvidence: true, reason: ev.reason } : nl(`${ev.reason} Not an electronically supplied service, so Dutch VAT (art. 45).`);
    case "consumer_eu": {
      if (!laneRule.ess) return nl(`${ev.reason} Not an electronically supplied service, so Dutch VAT (art. 45).`);
      const oss = rules?.vat?.oss || {};
      if (crossBorderB2cEur <= Number(oss.thresholdEur ?? 10000)) return nl(`${ev.reason} EU cross-border consumer sales are at or under EUR ${Number(oss.thresholdEur ?? 10000).toLocaleString("en-US")}, so Dutch VAT (art. 59c).`);
      const rate = Number(oss.rates?.[customer.country]);
      if (!Number.isFinite(rate) || rate <= 0) return fallback;
      return { treatment: "oss_destination", rate, taxableShare: 1, country: customer.country, byEvidence: true, reason: `${ev.reason} Over the EUR ${Number(oss.thresholdEur ?? 10000).toLocaleString("en-US")} threshold: ${customer.country} VAT through OSS.` };
    }
    default: return fallback;
  }
}

/**
 * Resolves evidence events in time order, tracking the EU cross-border B2C ESS
 * total per calendar year (this and last year count, art. 59c). Each event gets
 * its treatment and VAT in EUR (fee is VAT included).
 * @param {Array<{at:string, laneId:string, amountUsd:number|null, customer:object}>} events
 */
export function resolveEvidenceEvents(events, rules, usdPerEur) {
  const byYear = new Map();
  const out = [];
  for (const e of [...events].sort((a, b) => String(a.at).localeCompare(String(b.at)))) {
    const date = String(e.at).slice(0, 10);
    const rate = usdPerEur(date);
    if (e.amountUsd == null || !(rate > 0)) continue;
    const year = Number(date.slice(0, 4));
    const vatLane = vatLaneOf(e.laneId);
    const laneRule = rules.vat.lanes[vatLane] || rules.vat.lanes.other;
    const crossBorder = (byYear.get(year) || 0) + (byYear.get(year - 1) || 0);
    const t = resolveVatTreatment(laneRule, e.customer, rules, { crossBorderB2cEur: crossBorder });
    const eur = e.amountUsd / rate;
    const ev = evidenceStatus(e.customer);
    if (laneRule.ess && ev.status === "consumer_eu") byYear.set(year, (byYear.get(year) || 0) + eur);
    out.push({ ...e, date, vatLane, eur, ...t, vatEur: eur * vatFraction(t), defaultVatEur: eur * vatFraction(laneRule) });
  }
  return out;
}

/** Resolved events grouped per UTC day, for computeWeeks. */
export function evidenceByDay(resolved) {
  const map = new Map();
  for (const e of resolved) {
    const list = map.get(e.date) || [];
    list.push(e);
    map.set(e.date, list);
  }
  return map;
}

// ------------------------------------------------------------------ return figures

function emptyReturn() {
  return { r1a: { baseEur: 0, vatEur: 0 }, r3b: { baseEur: 0 }, icp: {}, notReported: { outsideScopeEur: 0, exemptEur: 0 }, oss: {}, reserveDefaultEur: 0, reserveEur: 0, evidenceEvents: 0 };
}

/** Adds one VAT-inclusive amount (EUR) under one treatment to a return accumulator. */
export function addToReturn(acc, { eur, treatment, rate, taxableShare = 1, country = null, vatId = null, defaultVatEur = null }) {
  const vat = eur * vatFraction({ treatment, rate, taxableShare });
  acc.reserveEur += vat;
  acc.reserveDefaultEur += defaultVatEur ?? vat;
  if (treatment === "reverse_charge") {
    acc.r3b.baseEur += eur;
    if (vatId) acc.icp[vatId] = { vatId, country, baseEur: (acc.icp[vatId]?.baseEur || 0) + eur };
  } else if (treatment === "outside_scope") acc.notReported.outsideScopeEur += eur;
  else if (treatment === "exempt") acc.notReported.exemptEur += eur;
  else if (treatment === "oss_destination") {
    const o = acc.oss[country] || { country, rate, baseEur: 0, vatEur: 0 };
    o.baseEur += eur - vat;
    o.vatEur += vat;
    acc.oss[country] = o;
  } else {
    // taxable_nl and uncertain: in the Dutch return at the lane rate (the reserve).
    acc.r1a.baseEur += eur - vat;
    acc.r1a.vatEur += vat;
  }
  return acc;
}

/**
 * VAT of one day's revenue lanes: lanes without evidence at their default
 * rule, events with evidence at their own treatment (taken out of the lane's
 * default). Returns the VAT, VAT per lane, the default-only VAT and the
 * return accumulator.
 */
export function vatOfDay(lanes, rules, usdPerEur, evidence = []) {
  const acc = emptyReturn();
  const byLane = {};
  const covered = new Map();
  for (const e of evidence) covered.set(e.laneId, (covered.get(e.laneId) || 0) + e.amountUsd);
  for (const lane of lanes || []) {
    if (lane.amountUsd == null) continue;
    const key = vatLaneOf(lane.laneId);
    const rule = rules.vat.lanes[key] || rules.vat.lanes.other;
    const coveredUsd = Math.min(lane.amountUsd, covered.get(lane.laneId) || 0);
    const restEur = (lane.amountUsd - coveredUsd) / usdPerEur;
    const before = acc.reserveEur;
    if (restEur > 0) addToReturn(acc, { eur: restEur, treatment: rule.treatment === "taxable" ? "taxable_nl" : rule.treatment, rate: rule.rate, taxableShare: rule.taxableShare });
    for (const e of evidence) {
      if (e.laneId !== lane.laneId) continue;
      // Scale when an event's USD (single-event pricing) exceeds what the lane holds that day.
      const scale = covered.get(lane.laneId) > lane.amountUsd ? lane.amountUsd / covered.get(lane.laneId) : 1;
      const eur = (e.amountUsd * scale) / usdPerEur;
      addToReturn(acc, { eur, treatment: e.treatment, rate: e.rate, taxableShare: e.taxableShare, country: e.country, vatId: e.vatId || null, defaultVatEur: eur * vatFraction(rule) });
      acc.evidenceEvents += 1;
    }
    byLane[key] = (byLane[key] || 0) + (acc.reserveEur - before);
  }
  return { vatEur: acc.reserveEur, byLane, defaultVatEur: acc.reserveDefaultEur, ret: acc };
}

/** Merges return accumulators (segments of one period). */
export function mergeReturns(list) {
  const out = emptyReturn();
  for (const r of list) {
    if (!r) continue;
    out.r1a.baseEur += r.r1a.baseEur;
    out.r1a.vatEur += r.r1a.vatEur;
    out.r3b.baseEur += r.r3b.baseEur;
    for (const v of Object.values(r.icp)) out.icp[v.vatId] = { vatId: v.vatId, country: v.country, baseEur: (out.icp[v.vatId]?.baseEur || 0) + v.baseEur };
    out.notReported.outsideScopeEur += r.notReported.outsideScopeEur;
    out.notReported.exemptEur += r.notReported.exemptEur;
    for (const o of Object.values(r.oss)) {
      const m = out.oss[o.country] || { country: o.country, rate: o.rate, baseEur: 0, vatEur: 0 };
      m.baseEur += o.baseEur;
      m.vatEur += o.vatEur;
      out.oss[o.country] = m;
    }
    out.reserveDefaultEur += r.reserveDefaultEur;
    out.reserveEur += r.reserveEur;
    out.evidenceEvents += r.evidenceEvents;
  }
  return out;
}

const r2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

/**
 * Quarterly (or monthly) VAT return figures from the weekly model's segments.
 * Dutch return: rubriek 1a (base, VAT) incl. VAT on bank receipts, 3b (base),
 * ICP per VAT number; not reported: outside scope, exempt. OSS return: base and
 * VAT per member state. Released by evidence = default reserve - reserve.
 */
export function vatReturnsByPeriod(segments, period = "quarter") {
  const groups = new Map();
  const key = (date) => (period === "month" ? date.slice(0, 7) : `${date.slice(0, 4)}-Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`);
  for (const s of segments) {
    const k = key(s.start);
    const g = groups.get(k) || { returns: [], otherRevenueEur: 0, otherVatEur: 0 };
    g.returns.push(s.vatReturn);
    g.otherRevenueEur += s.otherRevenueEur || 0;
    g.otherVatEur += s.otherVatEur || 0;
    groups.set(k, g);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([p, g]) => {
    const m = mergeReturns(g.returns);
    const oss = Object.values(m.oss).map((o) => ({ country: o.country, rate: o.rate, baseEur: r2(o.baseEur), vatEur: r2(o.vatEur) })).sort((a, b) => a.country.localeCompare(b.country));
    const ossVat = r2(oss.reduce((s, o) => s + o.vatEur, 0));
    return {
      period: p,
      nl: {
        r1a: { baseEur: r2(m.r1a.baseEur + g.otherRevenueEur - g.otherVatEur), vatEur: r2(m.r1a.vatEur + g.otherVatEur) },
        r3b: { baseEur: r2(m.r3b.baseEur) },
        icp: Object.values(m.icp).map((v) => ({ vatId: v.vatId, country: v.country, baseEur: r2(v.baseEur) })),
        notReported: { outsideScopeEur: r2(m.notReported.outsideScopeEur), exemptEur: r2(m.notReported.exemptEur) },
        vatDueEur: r2(m.r1a.vatEur + g.otherVatEur),
      },
      oss: { byCountry: oss, vatDueEur: ossVat },
      reserveDefaultEur: r2(m.reserveDefaultEur + g.otherVatEur),
      reserveEur: r2(m.reserveEur + g.otherVatEur),
      releasedByEvidenceEur: r2(m.reserveDefaultEur - m.reserveEur),
      evidenceEvents: m.evidenceEvents,
    };
  });
}

// ------------------------------------------------------------------ store

const CUSTOMER_COLUMNS = `subject_kind, subject_id, customer_type, country, vat_id, business_number, vies_status, vies_name,
  vies_checked_at, evidence, note, updated_by, updated_at`;

export function vatCustomerFromRow(r) {
  return {
    subjectKind: r.subject_kind, subjectId: String(r.subject_id), customerType: r.customer_type, country: r.country,
    vatId: r.vat_id || null, businessNumber: r.business_number || null, viesStatus: r.vies_status || "not_checked",
    viesName: r.vies_name || null, viesCheckedAt: r.vies_checked_at ? new Date(r.vies_checked_at).toISOString() : null,
    evidence: Array.isArray(r.evidence) ? r.evidence : [], note: r.note || "", updatedBy: r.updated_by || null,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  };
}

export async function listVatCustomers(db) {
  const { rows } = await db.query(`select ${CUSTOMER_COLUMNS} from public.finance_vat_customers order by updated_at desc limit 2000`);
  return rows.map(vatCustomerFromRow);
}

/**
 * Known customers (sponsors and Home placement buyers) with the revenue that
 * evidence would cover, so the page can show who needs evidence.
 */
export async function listVatSubjects(db) {
  const { rows } = await db.query(`
    select 'sponsor_profile' as subject_kind, sp.id::text as subject_id, sp.project_name as name, sp.wallet as wallet,
           count(p.id)::int as payments, min(p.confirmed_at) as first_at, max(p.confirmed_at) as last_at
      from public.sponsor_profiles sp
      join public.event_sponsorships es on es.sponsor_profile_id = sp.id
      join public.sponsorship_payments p on p.event_sponsorship_id = es.id and p.status = 'confirmed' and p.confirmed_at is not null
     group by sp.id, sp.project_name, sp.wallet
    union all
    select 'sponsorship_application', a.id::text, a.project_name, a.applicant_wallet,
           count(p.id)::int, min(coalesce(a.paid_at, p.approved_at, p.starts_at)), max(coalesce(a.paid_at, p.approved_at, p.starts_at))
      from public.sponsorship_applications a
      join public.sponsored_placements p on p.application_id = a.id and p.payment_status in ('paid', 'verified')
     where coalesce(a.status, '') <> 'rejected'
     group by a.id, a.project_name, a.applicant_wallet
     order by 7 desc nulls last
     limit 500`);
  return rows.map((r) => ({ subjectKind: r.subject_kind, subjectId: String(r.subject_id), name: r.name || "", wallet: r.wallet || null, payments: Number(r.payments || 0), firstAt: r.first_at ? new Date(r.first_at).toISOString() : null, lastAt: r.last_at ? new Date(r.last_at).toISOString() : null }));
}

export async function upsertVatCustomer(client, { subjectKind, subjectId, input, vies, actor }) {
  const { rows } = await client.query(
    `insert into public.finance_vat_customers (subject_kind, subject_id, customer_type, country, vat_id, business_number, vies_status, vies_name, vies_checked_at, evidence, note, updated_by, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, now())
     on conflict (subject_kind, subject_id) do update set customer_type = excluded.customer_type, country = excluded.country, vat_id = excluded.vat_id,
       business_number = excluded.business_number, vies_status = excluded.vies_status, vies_name = excluded.vies_name, vies_checked_at = excluded.vies_checked_at,
       evidence = excluded.evidence, note = excluded.note, updated_by = excluded.updated_by, updated_at = now()
     returning ${CUSTOMER_COLUMNS}`,
    [subjectKind, subjectId, input.customerType, input.country, input.vatId, input.businessNumber, vies.status, vies.name, vies.checkedAt, JSON.stringify(input.evidence), input.note, actor.email],
  );
  return vatCustomerFromRow(rows[0]);
}

export async function readVatCustomer(db, subjectKind, subjectId) {
  const { rows } = await db.query(`select ${CUSTOMER_COLUMNS} from public.finance_vat_customers where subject_kind = $1 and subject_id = $2`, [subjectKind, subjectId]);
  return rows[0] ? vatCustomerFromRow(rows[0]) : null;
}

export async function deleteVatCustomer(client, subjectKind, subjectId) {
  const { rows } = await client.query(`delete from public.finance_vat_customers where subject_kind = $1 and subject_id = $2 returning ${CUSTOMER_COLUMNS}`, [subjectKind, subjectId]);
  return rows[0] ? vatCustomerFromRow(rows[0]) : null;
}

// Per-event revenue of the evidence lanes (same filters and amounts as the
// revenue lanes) joined to the recorded customer evidence. $1 = chain id.
const EVIDENCE_LANES = Object.freeze({
  sponsorships: { join: `join public.event_sponsorships es on es.id = p.event_sponsorship_id
      join public.finance_vat_customers c on c.subject_kind = 'sponsor_profile' and c.subject_id = es.sponsor_profile_id::text` },
  home_placements: { join: `join public.finance_vat_customers c on c.subject_kind = 'sponsorship_application' and c.subject_id = a.id::text` },
});

export function evidenceEventSql(laneKey) {
  const spec = LANE_SPECS[laneKey];
  return `
    select ${spec.time} as occurred_at, (${spec.amount})::text as amount_raw, ${spec.eventId} as event_id,
           ${CUSTOMER_COLUMNS.split(",").map((c) => `c.${c.trim()}`).join(", ")}
      from ${spec.from}
      ${EVIDENCE_LANES[laneKey].join}
     where ${spec.where}
     order by 1`;
}

/**
 * Evidence events of every mainnet, priced at their hour (USD), ready for
 * resolveEvidenceEvents. A missing table gives no events and a note.
 * @param {{laneDefinitions: Function}} deps  laneDefinitions from financeRevenueLanes.js
 */
export async function readEvidenceEvents({ db, networks, prices, laneDefinitions }) {
  const events = [];
  for (const network of networks) {
    const defs = laneDefinitions(network).filter((d) => EVIDENCE_LANES[d.key]);
    for (const def of defs) {
      let rows;
      try {
        ({ rows } = await db.query(evidenceEventSql(def.key), [network.chainId]));
      } catch (error) {
        if (["42P01", "42703"].includes(String(error?.code || ""))) return { events: [], note: "Customer VAT evidence is not installed yet (db/migrations/20261006_000003_finance_vat_evidence.sql), so every lane uses its default reserve." };
        throw error;
      }
      for (const row of rows) {
        const raw = String(row.amount_raw || "0").split(".")[0];
        if (!/^\d+$/.test(raw) || raw === "0") continue;
        const at = new Date(row.occurred_at).toISOString();
        const usd = await prices.valueEvents(def.assetSymbol, [{ hour: at, raw }], def.decimals ?? network.decimals);
        events.push({ at, laneId: def.id, eventId: row.event_id, amountUsd: usd.amountUsd ?? null, customer: vatCustomerFromRow(row) });
      }
    }
  }
  return { events, note: null };
}

export function evidenceLabel(kind) {
  return VAT_EVIDENCE_LABELS[kind] || kind;
}
