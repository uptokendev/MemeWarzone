// Dutch tax and distribution rules as data (founder 2026-10-05: "All rules,
// regulations and laws are findable on the web. For now we do not need an
// advisor ... If something needs to change we can do it afterwards.").
//
// Every rule carries its value, the condition it depends on, the official
// source it was read from, the date it was checked and a confidence level
// (high / medium / low). The page shows "Based on <source>, checked <date>"
// and marks every low-confidence rule "needs confirmation". finance.manage can
// change any value afterwards (PUT /api/admin/finance/tax-rules, audit logged).
// These are rules for a reserve and a distribution plan, not a tax filing.

import { FinanceInputError } from "./financeAccountingCosts.js";

export const RULES_CHECKED_ON = "2026-10-05";
/** The VAT rules were refined with the place-of-supply and evidence research on this date. */
export const VAT_CHECKED_ON = "2026-10-06";
export const CONFIDENCE = Object.freeze(["high", "medium", "low"]);
const VAT_TREATMENT_KEYS = Object.freeze(["taxable_nl", "reverse_charge", "outside_scope", "exempt", "oss_destination", "uncertain"]);
export const ENTITY_TYPES = Object.freeze(["dutch_holding_bv", "us_corporation", "natural_person", "other"]);
export const ENTITY_TYPE_LABELS = Object.freeze({
  dutch_holding_bv: "Dutch holding BV",
  us_corporation: "US corporation",
  natural_person: "Natural person",
  other: "Other entity",
});

// VAT lanes: every revenue lane id (financeRevenueLanes.js) maps to one.
export const VAT_LANES = Object.freeze(["trading_fees", "graduation_fees", "import_swaps", "upvotes", "arena_boosts", "battle_entries", "sponsorships", "home_placements", "dbc_referral", "other"]);
const LANE_ID_PREFIX = Object.freeze([
  ["bonding-route:", "trading_fees"],
  ["graduation-fee:", "graduation_fees"],
  ["import-swaps:", "import_swaps"],
  ["upvotes:", "upvotes"],
  ["arena-boosts:", "arena_boosts"],
  ["arena-entries:", "battle_entries"],
  ["sponsorships:", "sponsorships"],
  ["home-placements:", "home_placements"],
  ["dbc-referral:", "dbc_referral"],
]);

/** The VAT lane of a revenue lane id ("bonding-route:101" -> trading_fees). */
export function vatLaneOf(laneId) {
  const id = String(laneId || "");
  return LANE_ID_PREFIX.find(([prefix]) => id.startsWith(prefix))?.[1] || "other";
}

/** Share of a VAT-inclusive fee that is VAT under one lane rule (0 for reverse charge, outside scope and exempt). */
export function vatFraction(rule) {
  const t = rule?.treatment === "taxable" ? "taxable_nl" : rule?.treatment;
  if (t === "exempt" || t === "outside_scope" || t === "reverse_charge") return 0;
  const rate = Number(rule?.rate) || 0;
  return rate > 0 ? (rate / (1 + rate)) * (Number(rule?.taxableShare ?? 1) || 0) : 0;
}

const SRC = Object.freeze({
  vpbRates: "https://www.kvk.nl/geldzaken/vennootschapsbelasting/",
  vpbRates2026: "https://www.sra.nl/nieuws/004501/2025/09/nieuwe-belastingtarieven--kortingen-en-faciliteiten-2026",
  vpbLoss: "https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/winst/vennootschapsbelasting/verrekenen_van_verliezen/verrekenen_van_verliezen",
  vpbInstalments: "https://www.belastingdienst.nl/wps/wcm/connect/nl/betalenenontvangen/content/in-termijnen-betalen",
  crypto: "https://www.kvk.nl/geldzaken/belasting-betalen-over-cryptos/",
  divLaw: "https://wetten.overheid.nl/BWBR0002515",
  divReturn: "https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/winst/dividendbelasting/als_u_dividend_uitkeert/dividendbelasting-aangifte-betalen",
  divForeign: "https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/winst/dividendbelasting/als_u_dividend_uitkeert/deelnemingsdividend-uitkeren-aan-aandeelhouder-buiten-nederland",
  divLob: "https://kennisgroepen.belastingdienst.nl/publicaties/kg02420254-inhoudingsvrijstelling-van-toepassing-wanneer-geen-recht-op-verdragsvoordelen-voor-het-dividend/",
  divNotify: "https://kennisgroepen.belastingdienst.nl/publicaties/kg02420237-inhoudingsvrijstelling-en-notificatieplicht/",
  treatyText: "https://wetten.overheid.nl/BWBV0002040",
  conditional: "https://zoek.officielebekendmakingen.nl/stcrt-2026-24065.pdf",
  bw216: "https://wetten.overheid.nl/BWBR0003045",
  vatB2c: "https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/btw/zakendoen_met_het_buitenland/afstandsverkopen-zoals-e-commerce-en-diensten-voor-particulieren-in-andere-eu-landen/diensten-aan-particulieren-binnen-eu/",
  vatDirective: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02006L0112-20250101",
  vatRegulation: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02011R0282-20220701",
  vatB2bEu: "https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/btw/zakendoen_met_het_buitenland/goederen_en_diensten_naar_andere_eu_landen/",
  vatB2bNonEu: "https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/btw/zakendoen_met_het_buitenland/zakendoen_buiten_de_eu/aangifte_doen_als_u_zakendoet_buiten_de_eu/aangifte_doen_als_u_diensten_levert_aan_afnemers_in_niet_eu_landen",
  vatOss: "https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/btw/zakendoen_met_het_buitenland/afstandsverkopen-zoals-e-commerce-en-diensten-voor-particulieren-in-andere-eu-landen/afstandsverkopen-zoals-e-commerce-binnen-de-eu/unieregeling-registratie-melding-betaling-en-administratie/",
  vatCommittee: "https://taxation-customs.ec.europa.eu/system/files/2024-01/guidelines-vat-committee-meetings_en.pdf",
  vatWetOb: "https://wetten.overheid.nl/BWBR0002629/2026-01-01",
  kansspelbelasting: "https://wetten.overheid.nl/BWBR0002359/2026-01-01",
  vatRates: "https://taxation-customs.ec.europa.eu/vat-rates_en",
  hedqvist: "https://curia.europa.eu/juris/liste.jsf?num=C-264/14",
  participation: "https://wetten.overheid.nl/BWBR0002672",
  irc245a: "https://www.law.cornell.edu/uscode/text/26/245A",
  vatReturn: "https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/btw/btw_aangifte_doen_en_betalen/btw-aangifte-waar-moet-u-aan-denken",
  vpbReturn: "https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/winst/vennootschapsbelasting/uitstel_aangifte_vennootschapsbelasting/uitstel_aangifte_vennootschapsbelasting",
  stockValuation: "https://www.jongbloed-fiscaaljuristen.nl/databank/startende_ondernemer/fiscale_voorraadwaardering/",
  stockConsistency: "https://www.taxlive.nl/nl/documenten/nieuws/fiscale-spelregels-bij-de-waardering-van-voorraad/",
  cryptoLifo: "https://www.grantthornton.nl/insights/tax/cryptos-hoe-behandel-je-deze-fiscaal-optimaal/",
  cryptoBv: "https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/winst/inkomstenbelasting/inkomstenbelasting_voor_ondernemers/bitcoins-en-andere-cryptovalutas",
  bw387: "https://wetboekplus.nl/burgerlijk-wetboek-boek-2-artikel-387-waardeverminderingen/",
  custody: "https://dart.deloitte.com/USDART/home/news/all-news/2025/jan/sec-rescinds-guidance-safeguarding-crypto-assets",
  depositDeadline: "https://www.kvk.nl/deponeren/uiterste-termijn-deponeren-jaarrekening/",
  bvInFormation: "https://www.taxence.nl/nieuws/handelen-voor-de-bv-in-oprichting/",
  bvInFormationVat: "https://www.jongbloed-fiscaaljuristen.nl/databank/herstructurering/de_bv_in_oprichting/",
});

/** The year-end rules (write-down, user funds, annual accounts, BV in formation) were researched on this date. */
export const YEAR_END_CHECKED_ON = "2026-10-06";

const rule = (value, source, confidence, extra = {}) => ({ ...value, source, checkedOn: RULES_CHECKED_ON, confidence, ...extra });

// VAT conclusion (research 2026-10-05, refined 2026-10-06 with the place of
// supply and evidence rules, see financeVat.js):
// - Trading, graduation and import swap fees: taxable. Memecoins are not a
//   means of payment (CJEU C-264/14 Hedqvist paras 24, 52-56; VAT Committee
//   guidelines 2022 and 2024) and carry no rights, so art. 135(1)(e)/(f) does
//   not apply; an automated swap interface is not exempt negotiation (C-5/17
//   DPAS para 38, C-235/00 CSC para 39).
// - Upvotes, boosts: electronically supplied services (Annex I 3(h), art. 7
//   Reg. 282/2011).
// - All of these go to anonymous wallets: no VAT number, so consumers
//   (art. 18(2)); Dutch VAT while EU cross-border consumer sales stay at or under
//   EUR 10,000 (art. 59c); non-EU consumers are outside the scope but need two
//   items of location evidence (art. 24b(d), 24f), which wallets do not give.
//   So the reserve stays 21% of the fee as VAT included (21/121).
// - Battle entries: founder decision 2026-10-06, a prize competition for one
//   winner, not a game of chance: taxable, 21% (no gambling-tax exemption).
// - Sponsorships and Home placements: per customer from recorded evidence
//   (reverse charge for an EU business with a VIES-valid VAT number, outside
//   the scope for a non-EU business with a business number, 21% otherwise).
// - Meteora referral: B2B outside the Netherlands, outside the scope.
// The reserve stays in the multisig until a return is filed and paid.
export const DEFAULT_TAX_RULES = Object.freeze({
  version: 1,
  checkedOn: RULES_CHECKED_ON,
  note: "Researched from official sources on the web (no adviser). Any value can be changed afterwards on this page; every change is logged.",
  vpb: {
    years: {
      2025: rule({ brackets: [{ upTo: 200000, rate: 0.19 }, { upTo: null, rate: 0.258 }], condition: "Taxable profit of the calendar year (book year = calendar year), in EUR." }, SRC.vpbRates, "high"),
      2026: rule({ brackets: [{ upTo: 200000, rate: 0.19 }, { upTo: null, rate: 0.258 }], condition: "Taxable profit of the calendar year (book year = calendar year), in EUR. Unchanged from 2025." }, SRC.vpbRates2026, "high"),
    },
    lossCarryForward: rule({ fullOffsetUpToEur: 1000000, excessOffsetShare: 0.5, carryBackYears: 1, condition: "A loss is set off against later profits without a time limit (losses from 2022 on): in full up to EUR 1,000,000 taxable profit per year, and 50% of the profit above that (art. 20 Wet Vpb). A loss can also go back 1 year for a refund; this view does not count that refund in the reserve." }, SRC.vpbLoss, "high"),
    profitBasis: rule({ condition: "Crypto received as a fee is revenue at its EUR value on the day it is received (sound business practice). Held crypto stays on the books at cost or lower market value; a price rise is taxed only when the crypto is sold. Crypto is not treated as money, so there is no day-rate revaluation. Costs made for the business are deductible. This view books fees at the event-hour price and does not tax unrealised gains." }, SRC.crypto, "medium"),
    cryptoCostMethod: rule({ method: "fifo", lowerOfCostOrMarket: true, condition: "Which units leave first when crypto is sold, converted, spent on fees or paid out. FIFO: the oldest units held by the BV, across all its wallets, exchange and bank accounts, per asset (SOL, BNB, ETH, USDC, USDT, USD). The cost of a unit is its EUR value on the day it came in (fee revenue: the event-hour price at the ECB rate of that day). Dutch tax practice (goed koopmansgebruik) clearly accepts LIFO per transaction and cost or lower market value; sources see grounds for FIFO as well. Average cost (average) and LIFO (lifo) can be chosen here instead; whatever is chosen must then be kept year after year (bestendige gedragslijn). Held crypto is shown at cost or lower market value; a write-down to a lower market value is a deductible loss at the balance date (year end) and is shown, not booked, until then." }, SRC.stockValuation, "medium"),
    payment: rule({ belastingrente2026: 0.05, condition: "A provisional assessment (voorlopige aanslag) received during the year can be paid in monthly instalments, all paid by 31 December. The return is due 5 months after the book year ends (1 June), with a standard 5-month extension on request. Tax interest (belastingrente) for corporate tax is 5% from 2026; it runs from 1 July after the year unless the return is filed before 1 June or a provisional assessment is requested before 1 May. The reserve here stays in the multisig until it is paid." }, SRC.vpbInstalments, "high"),
  },
  calendar: {
    vatPeriod: rule({ period: "quarter", dueMonthsAfterPeriod: 1, condition: "VAT return per quarter (most businesses), filed and paid at the latest on the last day of the month after the quarter: Q1 by 30 April, Q2 by 31 July, Q3 by 31 October, Q4 by 31 January. The Belastingdienst can set a month instead (period: month)." }, SRC.vatReturn, "high"),
    vpbProvisional: rule({ requestBeforeMonthDay: "05-01", shortRemainderWeeks: 6, condition: "A provisional corporate tax assessment for the current year is paid in equal monthly instalments; the number depends on the date on the assessment (dated 15 February: 10 instalments, March to December), all paid by 31 December. With less than 2 whole months left, one payment within 6 weeks. Asking for a provisional assessment before 1 May after the year avoids tax interest (belastingrente). An assessment received after the year: pay by the due date printed on it." }, SRC.vpbInstalments, "high"),
    vpbReturn: rule({ dueMonthsAfterYear: 5, condition: "The corporate tax return is due 5 months after the book year ends (1 June for a calendar year); a 5-month extension can be requested." }, SRC.vpbReturn, "high"),
    firstPeriodOn: rule({ date: "", condition: "First day the BV files VAT and corporate tax for (registration date). Empty: from the first revenue. Obligations for earlier periods are not listed; their reserve stays until a return is recorded." }, SRC.vatReturn, "low"),
  },
  dividendTax: rule({ rate: 0.15, condition: "Withheld by the BV on every dividend (including interim dividends) unless an exemption applies (art. 5 Wet op de dividendbelasting 1965)." }, SRC.divLaw, "high"),
  withholding: {
    dutch_holding_bv: rule({ exemptMinBps: 500, rateIfExempt: 0, rateOtherwise: 0.15, basis: "Exempt under art. 4 lid 1 Wet op de dividendbelasting 1965", condition: "The holding is a Dutch-resident company for which the participation exemption applies (at least 5% of the paid-up capital, shares part of its business) or a fiscal unity. No return is needed when this exemption covers the whole dividend, unless the Belastingdienst asks for one." }, SRC.divLaw, "high"),
    us_corporation: rule({ exemptMinBps: 500, rateIfExempt: 0, treatyMinBps: 1000, treatyRate: 0.05, rateOtherwise: 0.15, basis: "Exempt under art. 4 lid 2 Wet op de dividendbelasting 1965 (company in a treaty state with a dividend article)", condition: "The US corporation holds at least 5%, would qualify for the participation exemption if it were Dutch, is the beneficial owner, does not hold the shares mainly to avoid tax in an artificial arrangement, and is not comparable to a Dutch fiscal investment institution (art. 4 lid 2-4). The Belastingdienst knowledge group confirms this applies even if the treaty's limitation on benefits article would deny treaty benefits. The facts (substance of the US corporation) still need checking. If the exemption is refused: treaty rate 5% (company with at least 10% of the voting power, art. 10 NL-US treaty)." }, SRC.divLob, "medium"),
    natural_person: rule({ rate: 0.15, basis: "Standard rate", condition: "No exemption for individuals." }, SRC.divLaw, "high"),
    other: rule({ rate: 0.15, basis: "Standard rate until an exemption is shown", condition: "Check the entity and its residence country." }, SRC.divLaw, "low"),
  },
  conditionalWithholding: rule({ appliesToUs: false, condition: "The conditional withholding tax on dividends (from 2024) applies only to shareholders in low-tax jurisdictions on the Dutch list. The United States is not on the 2026 list (US Virgin Islands, American Samoa and Guam are)." }, SRC.conditional, "high"),
  filing: rule({ returnDueMonths: 1, returnWhenOnlyDutchExempt: false, notifyForForeignExemption: true, maxFineEur: 5278, condition: "Dividend tax withheld: file the return and pay within 1 month after the dividend is made available. Only Dutch holdings exempt under art. 4 lid 1: no return, unless the Belastingdienst asks. Foreign shareholder exempt under art. 4 lid 2 (the US corporation): an opgaaf (notification) is due within the same month (art. 4 lid 11); missing it does not cancel the exemption but can bring a fine of up to EUR 5,278. Keep: shareholder register, the resolutions, proof of US residence (IRS Form 6166), a beneficial-owner statement and evidence of the US corporation's substance." }, SRC.divNotify, "high"),
  distributionLaw: rule({ condition: "Art. 2:216 BW: the general meeting decides (unless the articles say otherwise); only free equity above statutory and article reserves can be paid out (balance test); the board must approve and refuses if it knows or should foresee the BV cannot keep paying its due debts after the payment (liquidity test). Directors are jointly liable for the shortfall if they knew or should have foreseen it; a shareholder who knew or should have known must repay. Interim distributions are allowed. There is no legal minimum interval, so weekly is possible if each payment has its own shareholder resolution (in writing is fine, art. 2:238) and a dated board approval with the liquidity test (usually looking about 12 months ahead)." }, SRC.bw216, "high"),
  vat: {
    standardRate: 0.21,
    condition: "Digital services to consumers in the EU are taxed where the consumer lives, but with Dutch VAT while cross-border EU consumer sales stay at or under EUR 10,000 this and last calendar year (then OSS); consumers outside the EU: outside Dutch VAT; businesses: where the business is (reverse charge for EU businesses with a valid VAT number, 21% for Dutch businesses). A consumer's country needs two items of evidence that agree; anonymous wallets give none, so their fees stay at 21%.",
    source: SRC.vatB2c,
    checkedOn: VAT_CHECKED_ON,
    confidence: "medium",
    oss: rule({
      thresholdEur: 10000,
      // Standard rates 2026 (EC VAT rates / TEDB, cross-checked 2026-10-06; FI 25.5% since 2024-09, SK 23% 2025, EE 24% 2025-07, RO 21% 2025-08).
      rates: { AT: 0.2, BE: 0.21, BG: 0.2, HR: 0.25, CY: 0.19, CZ: 0.21, DK: 0.25, EE: 0.24, FI: 0.255, FR: 0.2, DE: 0.19, GR: 0.24, HU: 0.27, IE: 0.23, IT: 0.22, LV: 0.21, LT: 0.21, LU: 0.17, MT: 0.18, NL: 0.21, PL: 0.23, PT: 0.23, RO: 0.21, SK: 0.23, SI: 0.22, ES: 0.21, SE: 0.25 },
      condition: "Art. 59c Directive / art. 6k Wet OB: Dutch VAT on electronically supplied services to consumers in other EU countries while those sales (plus EU distance sales of goods) stay at or under EUR 10,000 in this and the last calendar year. From the sale that goes over it, the consumer's country's VAT applies, declared in one OSS (union scheme) return per quarter, due the last day of the month after the quarter (also when nil). Register for OSS before the first such sale (by the 10th of the next month at the latest).",
    }, SRC.vatOss, "high", { checkedOn: VAT_CHECKED_ON }),
    evidence: rule({
      condition: "Business customer: a VAT number checked in VIES (EU) or a business or tax number (outside the EU) (art. 18 Reg. 282/2011). Consumer: two items of evidence that agree, from billing address, IP geolocation, bank country, SIM country, land line or other commercially relevant information (art. 24b(d) and 24f). The one-item rule for suppliers under EUR 100,000 needs the item to come from a third party such as a bank or payment provider, which wallet payments do not have. Without evidence the lane default applies.",
    }, SRC.vatRegulation, "high", { checkedOn: VAT_CHECKED_ON }),
    lanes: {
      trading_fees: rule({ treatment: "taxable_nl", rate: 0.21, taxableShare: 1, evidence: "none", ess: true, reason: "Taxable electronically supplied service: memecoins are not a means of payment (Hedqvist C-264/14 paras 52-56) and carry no rights, so no financial exemption. Paid by anonymous wallets (consumers, art. 18(2)) with no location evidence: Dutch VAT, 21% of the fee reserved." }, SRC.hedqvist, "medium", { checkedOn: VAT_CHECKED_ON }),
      graduation_fees: rule({ treatment: "taxable_nl", rate: 0.21, taxableShare: 1, evidence: "none", ess: true, reason: "Part of the trading flow: same as trading fees." }, SRC.hedqvist, "medium", { checkedOn: VAT_CHECKED_ON }),
      import_swaps: rule({ treatment: "taxable_nl", rate: 0.21, taxableShare: 1, evidence: "none", ess: true, reason: "Our 0.5% fee for routing a memecoin swap through Jupiter, KyberSwap or Uniswap. An automated interface is not exempt negotiation (C-5/17 DPAS para 38; C-235/00 CSC para 39). Same place of supply as trading fees." }, SRC.vatCommittee, "medium", { checkedOn: VAT_CHECKED_ON }),
      upvotes: rule({ treatment: "taxable_nl", rate: 0.21, taxableShare: 1, evidence: "none", ess: true, reason: "Paid visibility on the site: electronically supplied service (Annex I 3(h), art. 7(2)(b) Reg. 282/2011). Anonymous wallets without location evidence: Dutch VAT." }, SRC.vatRegulation, "medium", { checkedOn: VAT_CHECKED_ON }),
      arena_boosts: rule({ treatment: "taxable_nl", rate: 0.21, taxableShare: 1, evidence: "none", ess: true, reason: "Paid visibility in the arena: electronically supplied service. Anonymous wallets without location evidence: Dutch VAT." }, SRC.vatRegulation, "medium", { checkedOn: VAT_CHECKED_ON }),
      battle_entries: rule({ treatment: "taxable_nl", rate: 0.21, taxableShare: 1, evidence: "none", ess: true, reason: "Our 5% of battle stakes. Founder decision 2026-10-06: battles are a prize competition for one winner, not a game of chance, so no gambling-tax exemption is claimed; treated as a taxable electronically supplied service to anonymous wallets: Dutch VAT, 21% reserved." }, SRC.kansspelbelasting, "medium", { checkedOn: VAT_CHECKED_ON, decidedBy: "founder", decidedOn: "2026-10-06" }),
      sponsorships: rule({ treatment: "taxable_nl", rate: 0.21, taxableShare: 1, evidence: "customer", ess: false, reason: "Advertising agreed with the sponsor (not automated, art. 7(3)(m)): B2B where the business is (art. 44): reverse charge for an EU business with a VIES-valid VAT number (rubriek 3b + ICP), outside the scope for a business outside the EU with a business number, 21% for Dutch businesses and for buyers without a VAT number (art. 45). Default 21% until the sponsor's evidence is recorded." }, SRC.vatB2bEu, "high", { checkedOn: VAT_CHECKED_ON }),
      home_placements: rule({ treatment: "taxable_nl", rate: 0.21, taxableShare: 1, evidence: "customer", ess: false, reason: "Home placement sold by application and marked paid by an admin: same as sponsorships. Default 21% until the buyer's evidence is recorded." }, SRC.vatB2bEu, "high", { checkedOn: VAT_CHECKED_ON }),
      dbc_referral: rule({ treatment: "outside_scope", rate: 0, taxableShare: 0, evidence: "none", ess: false, reason: "Referral fee paid by Meteora, a business outside the Netherlands: taxed where the customer is (art. 44), not in the Dutch return. If Meteora turns out to be an EU business with a VAT number: reverse charge (rubriek 3b + ICP)." }, SRC.vatB2bNonEu, "medium", { checkedOn: VAT_CHECKED_ON }),
      other: rule({ treatment: "uncertain", rate: 0.21, taxableShare: 1, evidence: "none", ess: false, reason: "Unknown lane: 21% reserved." }, SRC.vatB2c, "low", { checkedOn: VAT_CHECKED_ON }),
    },
  },
  // Year-end package (B8, research 2026-10-06): how the year-end figures are
  // made, as data so a bookkeeper can see (and change) every assumption.
  yearEnd: {
    writeDown: rule({
      perAsset: true,
      reverses: true,
      condition: "Crypto the BV holds is a current asset, valued at the balance date (31 December) at cost or lower market value (Belastingdienst: kostprijs of lagere bedrijfswaarde; art. 2:387 lid 2 BW: current assets at the lower actual value on the balance date). The write-down is a loss of the year it is made in and is deductible. Art. 2:387 lid 4 BW: a write-down is reversed as soon as the fall in value has ended, never above cost. So every year end compares the FIFO cost of what is held with its market value, per asset (all lots of one coin together), and the year's result carries the change: minus (write-down at this year end - write-down at the last year end). The FIFO lots themselves keep their original cost. Market value: the Binance 1h close of 31 December 23:00 UTC (stablecoins at $1, platform coins from our market data) at the ECB USD/EUR rate of that day.",
    }, SRC.bw387, "medium", { checkedOn: YEAR_END_CHECKED_ON, alsoSource: SRC.cryptoBv }),
    userFunds: rule({
      onBalanceSheet: false,
      condition: "Money owed to users (league and MWL prizes, recruiter rewards, creator fees, the airdrop pot, squad and war pool money) never was revenue of the BV: the contracts route it straight to its own vault, and the revenue lanes count only the protocol share. The BV has no right to it and does not carry its price risk, so it is not an asset of the BV and the matching debt to users is not a liability of the BV: it is shown off the balance sheet, with the amounts and whether each vault covers what it owes (rights and obligations not in the balance sheet, art. 2:381 BW). Only a shortfall the BV would have to make good from its own money is a liability, and only when that is probable and can be measured (IAS 37 / ASC 450-20, the rule the SEC staff returned to when it rescinded SAB 121 with SAB 122 in January 2025). The operator wallet and the protocol vault are the BV's own money and are on the balance sheet.",
    }, SRC.custody, "medium", { checkedOn: YEAR_END_CHECKED_ON }),
    annualAccounts: rule({
      prepareMonths: 5,
      extensionMonths: 5,
      fileDaysAfterAdoption: 8,
      fileWithinMonths: 12,
      condition: "The board prepares the annual accounts within 5 months after the book year (art. 2:210 BW); the general meeting can extend that by up to 5 months. The accounts are filed with the KVK within 8 days after they are adopted, and in any case within 12 months after the book year (art. 2:394 BW). For a calendar year without extension the KVK gives 8 August as the last day; with the full extension 31 December. A micro BV files a balance sheet with a few notes only.",
    }, SRC.depositDeadline, "high", { checkedOn: YEAR_END_CHECKED_ON }),
    bvInFormation: rule({
      condition: "Until the deed of incorporation is signed the BV does not exist: the founders who act for the BV in formation are jointly and severally liable until the BV, once incorporated, ratifies those acts (art. 2:203 BW). Results of that period (the voorperiode) are added to the BV's first book year and taxed with corporate income tax at the rates of the year of incorporation, not with income tax at the founders. For VAT a company is an entrepreneur only from its incorporation date, so VAT on activity before that date is a matter for the founders. These books are kept as if the BV is registered; the package says so on every page.",
    }, SRC.bvInFormation, "medium", { checkedOn: YEAR_END_CHECKED_ON, alsoSource: SRC.bvInFormationVat }),
  },
  holdingSide: {
    dutch_holding_bv: rule({ condition: "A Dutch holding BV with at least 5% receives the dividend tax-free under the participation exemption (art. 13 Wet Vpb 1969). Box 2 at personal level is out of scope here." }, SRC.participation, "high"),
    us_corporation: rule({ condition: "A US C corporation owning at least 10% can deduct 100% of the foreign-source part of the dividend (IRC 245A; shares held more than 365 days in the 731-day window). No foreign tax credit on a 245A dividend; if 245A does not apply, Dutch tax withheld can be credited (IRC 901). The BV is not a CFC (US owners hold 20%); PFIC could matter if the BV holds large passive crypto balances." }, SRC.irc245a, "medium"),
  },
});

// ------------------------------------------------------------------ validation

const MAX_TEXT = 1200;

/** Walks `body` along the default's shape: numbers stay numbers in range, text stays text, unknown keys are dropped. */
function conform(schema, value, path) {
  if (Array.isArray(schema)) {
    if (!Array.isArray(value)) throw new FinanceInputError(`${path} must be a list.`, path);
    return value;
  }
  if (schema && typeof schema === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new FinanceInputError(`${path} must be an object.`, path);
    const out = {};
    for (const key of Object.keys(schema)) {
      out[key] = key in value ? conform(schema[key], value[key], `${path}.${key}`) : structuredClone(schema[key]);
    }
    return out;
  }
  if (typeof schema === "number") {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new FinanceInputError(`${path} must be a number of 0 or more.`, path);
    if ((/rate|Share$/i.test(path.split(".").pop()) || path.includes(".oss.rates.")) && n > 1) throw new FinanceInputError(`${path} is a fraction between 0 and 1 (0.15 = 15%).`, path);
    return n;
  }
  if (typeof schema === "boolean") return value === true;
  if (typeof schema === "string") {
    const text = String(value ?? "").trim();
    if (text.length > MAX_TEXT) throw new FinanceInputError(`${path} is longer than ${MAX_TEXT} characters.`, path);
    if (path.endsWith(".confidence") && !CONFIDENCE.includes(text)) throw new FinanceInputError(`${path} must be high, medium or low.`, path);
    if (path.endsWith(".treatment")) {
      // "taxable" is the name before 2026-10-06: stored rules keep working as Dutch VAT.
      if (text === "taxable") return "taxable_nl";
      if (!VAT_TREATMENT_KEYS.includes(text)) throw new FinanceInputError(`${path} must be one of ${VAT_TREATMENT_KEYS.join(", ")}.`, path);
    }
    if (path.endsWith(".evidence") && !["none", "customer"].includes(text)) throw new FinanceInputError(`${path} must be none or customer.`, path);
    if (path.endsWith(".source") && text && !/^https:\/\//.test(text)) throw new FinanceInputError(`${path} must be an https link.`, path);
    if (path.endsWith(".method") && !["fifo", "lifo", "average"].includes(text)) throw new FinanceInputError(`${path} must be fifo, lifo or average.`, path);
    if (path.endsWith(".period") && !["quarter", "month"].includes(text)) throw new FinanceInputError(`${path} must be quarter or month.`, path);
    if (path.endsWith("firstPeriodOn.date") && text && !/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new FinanceInputError(`${path} must be a date (YYYY-MM-DD) or empty.`, path);
    if (path.endsWith(".requestBeforeMonthDay") && !/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(text)) throw new FinanceInputError(`${path} must be MM-DD.`, path);
    if (path.endsWith("checkedOn") && text && !/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new FinanceInputError(`${path} must be a date (YYYY-MM-DD).`, path);
    return text;
  }
  return value;
}

function checkBrackets(brackets, path) {
  if (!Array.isArray(brackets) || brackets.length < 1 || brackets.length > 10) throw new FinanceInputError(`${path} must list 1 to 10 brackets.`, path);
  let previous = 0;
  return brackets.map((b, i) => {
    const last = i === brackets.length - 1;
    const rate = Number(b?.rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new FinanceInputError(`${path} bracket ${i + 1}: rate must be between 0 and 1.`, path);
    if (last) {
      if (b?.upTo != null && b?.upTo !== "") throw new FinanceInputError(`${path}: the last bracket has no upper limit.`, path);
      return { upTo: null, rate };
    }
    const upTo = Number(b?.upTo);
    if (!Number.isFinite(upTo) || upTo <= previous) throw new FinanceInputError(`${path} bracket ${i + 1}: upTo must be higher than the bracket before it.`, path);
    previous = upTo;
    return { upTo, rate };
  });
}

/** Validates a full or partial rule set from the settings form; missing parts keep the default. */
export function validateTaxRuleSet(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new FinanceInputError("Send the rules as a JSON object.");
  const out = conform(DEFAULT_TAX_RULES, body, "rules");
  // Years are open ended: any year 2024-2100 may carry its own brackets.
  const years = {};
  const sourceYears = body.vpb?.years && typeof body.vpb.years === "object" ? body.vpb.years : DEFAULT_TAX_RULES.vpb.years;
  for (const [year, value] of Object.entries(sourceYears)) {
    if (!/^\d{4}$/.test(year) || Number(year) < 2024 || Number(year) > 2100) throw new FinanceInputError(`vpb.years.${year} is not a year.`, "vpb");
    const base = DEFAULT_TAX_RULES.vpb.years[year] || DEFAULT_TAX_RULES.vpb.years[2026];
    const merged = conform({ ...base, brackets: [] }, { ...base, ...value }, `rules.vpb.years.${year}`);
    years[year] = { ...merged, brackets: checkBrackets(value?.brackets ?? base.brackets, `vpb.years.${year}`) };
  }
  if (!Object.keys(years).length) throw new FinanceInputError("vpb.years needs at least one year.", "vpb");
  out.vpb.years = years;
  return out;
}

/** Rules in use: stored (validated) or the defaults, with isDefault. */
export function effectiveTaxRuleSet(stored) {
  if (stored && typeof stored === "object") {
    try {
      return { ...validateTaxRuleSet(stored), isDefault: false };
    } catch {
      return { ...structuredClone(DEFAULT_TAX_RULES), isDefault: true, storedInvalid: true };
    }
  }
  return { ...structuredClone(DEFAULT_TAX_RULES), isDefault: true };
}

/**
 * VPB brackets for a year: that year's, else the latest earlier year's (flagged
 * `fallback`), else the earliest year's. `override` = brackets saved on the
 * old tax-reserve form; they win for every year when present.
 */
export function vpbYear(rules, year, override = null) {
  if (override?.brackets?.length) return { year, brackets: override.brackets, source: "Saved on the Tax & Reserves form", checkedOn: null, confidence: "medium", fallback: false, override: true };
  const years = rules?.vpb?.years || DEFAULT_TAX_RULES.vpb.years;
  if (years[year]) return { year, ...years[year], fallback: false };
  const known = Object.keys(years).map(Number).sort((a, b) => a - b);
  const earlier = known.filter((y) => y < year).pop();
  const pick = earlier ?? known[0];
  return { year, ...years[pick], fallback: true, fallbackFrom: pick };
}

/** Infers the entity type from the free-text legal entity of older settings. */
export function inferEntityType(entity) {
  const text = String(entity || "").toLowerCase();
  if (/\b(us|usa|united states|american)\b/.test(text) && /(corp|inc|llc|company)/.test(text)) return "us_corporation";
  if (/(dutch|nederland|netherlands)/.test(text) && /(holding|\bbv\b|b\.v\.)/.test(text)) return "dutch_holding_bv";
  if (/(person|individual|natuurlijk)/.test(text)) return "natural_person";
  return "other";
}

/**
 * Withholding for one shareholder from the rules: rate (0..1), the reason in
 * plain words, the rule's source and confidence, and the fallback (treaty)
 * rate where one exists. A per-shareholder override (withholdingOverride true
 * with withholdingPct) wins and says so.
 */
export function withholdingFor(share, rules) {
  const type = ENTITY_TYPES.includes(share.entityType) ? share.entityType : inferEntityType(share.entity);
  const w = rules?.withholding?.[type] || DEFAULT_TAX_RULES.withholding[type];
  const pct = (r) => `${Math.round(r * 10000) / 100}%`;
  let result;
  if (type === "dutch_holding_bv" || type === "us_corporation") {
    const exempt = share.bps >= w.exemptMinBps;
    if (exempt) {
      result = { rate: w.rateIfExempt, reason: `${w.basis}: holds ${share.bps / 100}% (at least ${w.exemptMinBps / 100}%).` };
      if (type === "us_corporation") result.fallbackRate = share.bps >= w.treatyMinBps ? w.treatyRate : w.rateOtherwise;
    } else if (type === "us_corporation" && share.bps >= w.treatyMinBps) {
      result = { rate: w.treatyRate, reason: `NL-US treaty rate ${pct(w.treatyRate)} (holds ${share.bps / 100}%).` };
    } else {
      result = { rate: w.rateOtherwise, reason: `Holds ${share.bps / 100}%, below the ${w.exemptMinBps / 100}% needed for the exemption: ${pct(w.rateOtherwise)}.` };
    }
  } else {
    result = { rate: w.rate, reason: `${w.basis}: ${pct(w.rate)}.` };
  }
  const base = { entityType: type, entityLabel: ENTITY_TYPE_LABELS[type], condition: w.condition, source: w.source, checkedOn: w.checkedOn, confidence: w.confidence, needsConfirmation: w.confidence === "low" };
  if (share.withholdingOverride === true && Number.isFinite(Number(share.withholdingPct))) {
    const rate = Number(share.withholdingPct) / 100;
    return { ...base, rate, override: true, ruleRate: result.rate, reason: `Set by hand to ${pct(rate)} (the rules give ${pct(result.rate)}: ${result.reason})`, fallbackRate: result.fallbackRate ?? null };
  }
  return { ...base, rate: result.rate, override: false, ruleRate: result.rate, reason: result.reason, fallbackRate: result.fallbackRate ?? null };
}

/** Adds months to a date (YYYY-MM-DD), clamped to the month end: the dividend tax return due date. */
export function addMonthsToDate(date, months) {
  const [y, m, d] = date.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

/** Flat list of rules for the page: what, value, condition, source, checked, confidence. */
export function rulesTable(rules) {
  const pct = (r) => `${Math.round(r * 10000) / 100}%`;
  const rows = [];
  const push = (key, label, value, r) => rows.push({ key, label, value, condition: r.condition || r.reason || "", source: r.source, checkedOn: r.checkedOn, confidence: r.confidence, needsConfirmation: r.confidence === "low" });
  for (const [year, y] of Object.entries(rules.vpb.years)) push(`vpb.${year}`, `Corporate income tax ${year}`, y.brackets.map((b) => `${pct(b.rate)}${b.upTo == null ? " above" : ` up to EUR ${b.upTo.toLocaleString("en-US")}`}`).join(", "), y);
  const l = rules.vpb.lossCarryForward;
  push("vpb.loss", "Loss carry-forward", `Unlimited in time; full up to EUR ${l.fullOffsetUpToEur.toLocaleString("en-US")}, ${pct(l.excessOffsetShare)} above`, l);
  push("vpb.basis", "Profit of a BV paid in crypto", "EUR value at receipt; held crypto at cost", rules.vpb.profitBasis);
  push("vpb.payment", "When corporate tax is paid", "Provisional assessment, monthly instalments", rules.vpb.payment);
  const cm = rules.vpb.cryptoCostMethod;
  push("vpb.cryptoCost", "Cost of crypto sold or spent", `${String(cm.method).toUpperCase()} per asset${cm.lowerOfCostOrMarket ? "; held at cost or lower market value" : ""}`, cm);
  const cal = rules.calendar;
  push("cal.vat", "VAT return period", `Per ${cal.vatPeriod.period}, file and pay within ${cal.vatPeriod.dueMonthsAfterPeriod} month after it`, cal.vatPeriod);
  push("cal.vpbProvisional", "Corporate tax provisional assessment", "Monthly instalments to 31 December; ask before 1 May after the year", cal.vpbProvisional);
  push("cal.vpbReturn", "Corporate tax return", `${cal.vpbReturn.dueMonthsAfterYear} months after the year ends`, cal.vpbReturn);
  push("cal.firstPeriod", "First tax period", cal.firstPeriodOn.date || "From the first revenue", cal.firstPeriodOn);
  push("div.rate", "Dividend withholding tax", pct(rules.dividendTax.rate), rules.dividendTax);
  for (const type of ENTITY_TYPES) {
    const w = rules.withholding[type];
    const value = w.rateIfExempt != null ? `${pct(w.rateIfExempt)} if at least ${w.exemptMinBps / 100}%${w.treatyRate != null ? `; treaty ${pct(w.treatyRate)} otherwise` : ""}` : pct(w.rate);
    push(`withholding.${type}`, `Withholding: ${ENTITY_TYPE_LABELS[type]}`, value, w);
  }
  push("div.conditional", "Conditional withholding tax", rules.conditionalWithholding.appliesToUs ? "Applies to the US" : "Does not apply to the US", rules.conditionalWithholding);
  push("div.filing", "Dividend tax return", `Within ${rules.filing.returnDueMonths} month after the dividend is made available; notification for the US exemption${rules.filing.returnWhenOnlyDutchExempt ? "; also when only Dutch holdings are paid" : ""}`, rules.filing);
  push("bw.216", "Distribution test (art. 2:216 BW)", "Balance test + board liquidity test, per distribution", rules.distributionLaw);
  for (const lane of VAT_LANES) {
    const v = rules.vat.lanes[lane];
    const zero = ["exempt", "outside_scope", "reverse_charge"].includes(v.treatment);
    const value = `${zero ? `${v.treatment.replaceAll("_", " ")} (0%)` : `${pct(v.rate)} on ${pct(v.taxableShare)} of the fee (${v.treatment.replaceAll("_", " ")})`}${v.evidence === "customer" ? "; per customer from recorded evidence" : ""}`;
    push(`vat.${lane}`, `VAT: ${lane.replaceAll("_", " ")}`, value, v);
  }
  push("vat.oss", "VAT: EU consumer threshold and OSS", `EUR ${Number(rules.vat.oss.thresholdEur).toLocaleString("en-US")} per calendar year; above it the customer's country rate through OSS`, rules.vat.oss);
  push("vat.evidence", "VAT: customer evidence", "VIES-checked VAT number (business) or two matching location items (consumer)", rules.vat.evidence);
  const ye = rules.yearEnd;
  if (ye) {
    push("yearEnd.writeDown", "Year end: crypto at cost or lower market value", `Per ${ye.writeDown.perAsset ? "asset" : "lot"} at 31 December; ${ye.writeDown.reverses ? "reversed when the price recovers (never above cost)" : "not reversed"}`, ye.writeDown);
    push("yearEnd.userFunds", "Year end: money owed to users", ye.userFunds.onBalanceSheet ? "On the balance sheet (asset and liability)" : "Off the balance sheet, disclosed with vault coverage", ye.userFunds);
    push("yearEnd.annualAccounts", "Annual accounts", `Prepare within ${ye.annualAccounts.prepareMonths} months (+${ye.annualAccounts.extensionMonths}); file within ${ye.annualAccounts.fileDaysAfterAdoption} days of adoption, at most ${ye.annualAccounts.fileWithinMonths} months after the year`, ye.annualAccounts);
    push("yearEnd.bvInFormation", "BV in formation", "Pre-incorporation results go to the first book year after ratification", ye.bvInFormation);
  }
  for (const type of ["dutch_holding_bv", "us_corporation"]) push(`holding.${type}`, `On the shareholder's side: ${ENTITY_TYPE_LABELS[type]}`, "Informational", rules.holdingSide[type]);
  return rows;
}

/** What changed between two rule sets, in plain lines (rules table values). */
export function describeTaxRuleChange(before, after) {
  const prev = new Map(rulesTable(effectiveTaxRuleSet(before)).map((r) => [r.key, r]));
  const lines = [];
  for (const row of rulesTable(effectiveTaxRuleSet(after))) {
    const old = prev.get(row.key);
    if (!old) { lines.push(`${row.label}: ${row.value}`); continue; }
    if (old.value !== row.value) lines.push(`${row.label}: ${old.value} -> ${row.value}`);
    if (old.confidence !== row.confidence) lines.push(`${row.label} confidence: ${old.confidence} -> ${row.confidence}`);
    if (old.source !== row.source) lines.push(`${row.label} source: ${row.source}`);
  }
  return lines.length ? lines : ["Saved without changes"];
}
