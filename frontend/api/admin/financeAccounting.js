// Command Center accounting: costs, monthly close, tax reserve, CSV exports
// and distribution proposals, under /api/admin/finance/.
//
// Auth: a dashboard sign-in only (the ops key is refused: every write is
// logged against a person). The railwayProxy gate already required
// finance.view for GET and finance.manage for any other method; this handler
// checks again. Writes go to the four accounting tables only, each with its
// finance_audit_log row in the same transaction. Nothing here signs, submits
// or moves funds: distributions produce downloadable, unsigned proposals.
//
//   GET    costs                      list, filter, totals          finance.view
//   POST   costs                      create                        finance.manage
//   PATCH  costs/:id                  update                        finance.manage
//   DELETE costs/:id                  soft delete                   finance.manage
//   GET    fx                         USD quote preview for a cost  finance.view
//   GET    tax-reserves?year=         rules + reserve per month     finance.view
//   PUT    tax-reserves               replace the bracket rules     finance.manage
//   GET    close?year=                months with status + figures  finance.view
//   GET    close/:month               one month (snapshot if closed)finance.view
//   POST   close/:month               {action: close|reopen}        finance.manage
//   GET    distributions              settings + "distributable now"finance.view
//   PUT    distributions              replace the settings          finance.manage
//   GET    distributions/safe-batch   unsigned Safe batch JSON      finance.view
//   GET    distributions/squads-proposal  Squads proposal text      finance.view
//          (both take ?week=YYYY-Www: the weekly amount of the decision week)
//   GET    weekly?weeks=              weekly distribution view      finance.view
//   GET    tax-rules                  researched rules + sources    finance.view
//   PUT    tax-rules                  replace the rules             finance.manage
//   GET    distributions/records      recorded distributions        finance.view
//   POST   distributions/records      record the decision week      finance.manage
//   PATCH  distributions/records/:id  status, tx hashes, tax dates  finance.manage
//   GET    exports/:kind              CSV (revenue-events, costs, close-summaries, payouts, treasury-movements)
//   GET    treasury                   accounts, movements, cash, gains finance.view
//   POST   treasury/accounts          add an account                finance.manage
//   PATCH  treasury/accounts/:id      rename, IBAN, archive         finance.manage
//   POST   treasury/movements         record a movement             finance.manage
//   PATCH  treasury/movements/:id     correct a movement            finance.manage
//   DELETE treasury/movements/:id     soft delete                   finance.manage
//   GET    treasury/unmatched?days=   chain outflows not recorded   finance.view
//   GET    treasury/value             EUR value preview             finance.view
//   POST   treasury/crypto-costs      book an on-chain outflow as a cost
//                                     (cost + crypto_payment, one transaction) finance.manage
//   GET    entity                     BV status (in formation / registered) finance.view
//   PUT    entity                     change it (label only)        finance.manage
//   GET    tax                        obligations, deadlines, items finance.view
//   POST   tax/items                  record a return/payment/...   finance.manage
//   PATCH  tax/items/:id              correct it                    finance.manage
//   DELETE tax/items/:id              soft delete                   finance.manage
//   GET    vat/customers              known customers + VAT evidence finance.view
//   PUT    vat/customers/:kind/:id    record evidence (VIES check)  finance.manage
//   DELETE vat/customers/:kind/:id    remove evidence               finance.manage
//   GET    year-end?year=&format=     year-end package (P&L, balance sheet, tax,
//                                     schedules): json (default), csv&schedule=, zip  finance.view

import { pool } from "../../server/db.js";
import { dashboardPrincipalCan } from "../dashboard/_access.js";
import { defaultPriceService } from "../lib/financePrices.js";
import { defaultEurUsdSource } from "../lib/financeAccountingFx.js";
import {
  COST_CATEGORIES,
  COST_CATEGORY_LABELS,
  COST_CURRENCIES,
  FinanceInputError,
  addMonths,
  checkMergedCost,
  costTotals,
  expandCost,
  isValidMonth,
  monthEnd,
  monthOf,
  monthRange,
  quoteCost,
  round2,
  roundUsd,
  todayIso,
  validateCostInput,
} from "../lib/financeAccountingCosts.js";
import { describeTaxChange, effectiveTaxRules, taxReserveSchedule, validateTaxRules } from "../lib/financeAccountingTax.js";
import { addMonthsToDate, describeTaxRuleChange, effectiveTaxRuleSet, rulesTable, validateTaxRuleSet, vpbYear, withholdingFor } from "../lib/financeTaxRules.js";
import { WEEK_RULE, computeWeeks, decideWeek, reconcileMonths, weekMonday, weekView } from "../lib/financeAccountingWeekly.js";
import {
  BUFFER_LABEL,
  DIVIDEND_NOTE,
  OPERATOR_CAP_USD,
  SAFE_BATCH_CHAINS,
  buildSafeBatch,
  buildSquadsProposal,
  computeDistribution,
  describeDistributionChange,
  effectiveDistributionSettings,
  validateDistributionSettings,
} from "../lib/financeAccountingDistributions.js";
import { toCsv } from "../lib/financeAccountingCsv.js";
import {
  ACCOUNT_KINDS,
  ACCOUNT_KIND_LABELS,
  CHAINS,
  MOVEMENT_KINDS,
  MOVEMENT_KIND_LABELS,
  TREASURY_ASSETS,
  TREASURY_METHOD,
  WALLET_KINDS,
  bankPaidOccurrence,
  cashPerAccount,
  checkMovementAccounts,
  lotAsset,
  offChainCashEur,
  revenueAcquisitions,
  runLots,
  splitAssetKey,
  tokenChainOf,
  treasuryByDay,
  treasuryByMonth,
  treasuryLotEvents,
  validateAccountInput,
  validateMovementInput,
  valuationLeg,
  valueInEur,
} from "../lib/financeTreasury.js";
import {
  RESERVE_RELEASE_RULE,
  TAX_ITEM_KINDS,
  TAX_ITEM_KIND_LABELS,
  TAX_TYPES,
  TAX_TYPE_LABELS,
  UPCOMING_DAYS,
  checkMergedTaxItem,
  taxObligations,
  validateTaxItemInput,
  vatByPeriodFrom,
} from "../lib/financeTaxCalendar.js";
import { unmatchedOutflows } from "../lib/financeTreasuryDetect.js";
import { VAT_LANES } from "../lib/financeTaxRules.js";
import {
  EU_COUNTRIES,
  VAT_EVIDENCE_KINDS,
  VAT_SUBJECT_KINDS,
  VAT_TREATMENT_LABELS,
  checkVies,
  deleteVatCustomer,
  evidenceByDay,
  evidenceLabel,
  evidenceStatus,
  listVatCustomers,
  listVatSubjects,
  readEvidenceEvents,
  readVatCustomer,
  resolveEvidenceEvents,
  upsertVatCustomer,
  validateVatCustomerInput,
  vatReturnsByPeriod,
} from "../lib/financeVat.js";
import { laneDefinitions } from "../lib/financeRevenueLanes.js";
import { ENTITY_STATUSES, ENTITY_STATUS_LABELS, describeEntityChange, effectiveEntity, validateEntityInput } from "../lib/financeEntity.js";
import {
  CRYPTO_COSTS_MIGRATION,
  TREASURY_MIGRATION,
  cryptoCostsMissing,
  curveTradesByTx,
  getAccount,
  getMovement,
  getTaxItem,
  insertAccount,
  insertMovement,
  insertTaxItem,
  listAccounts,
  listMovements,
  listTaxItems,
  movementTokenColumn,
  readEntitySetting,
  softDeleteMovement,
  softDeleteTaxItem,
  treasuryTablesMissing,
  updateAccount,
  updateMovement,
  tokenMarketData,
  updateTaxItem,
} from "../lib/financeTreasuryStore.js";
import { accountingNetworks, currentBalances, dailyRevenue, monthlyRevenue, revenueEventRows, solanaRowsAreMainnet } from "../lib/financeAccountingSources.js";
import { buildPayoutsAllChains, cachedPayouts, payoutsDays } from "../lib/financePayouts.js";
import { balanceDate, buildYearEnd, scheduleCsv, yearEndSchedules, yearEndZip } from "../lib/financeYearEnd.js";
import { feeRoutingAllNetworks } from "../lib/financeFeeRouting.js";
import {
  ACCOUNTING_MIGRATION,
  DISTRIBUTIONS_MIGRATION,
  accountingTablesMissing,
  distributionTablesMissing,
  getDistribution,
  insertDistribution,
  listDistributions,
  updateDistribution,
  assertAccountingTables,
  getCost,
  insertCost,
  listCloses,
  listCosts,
  listSettingsHistory,
  lockClose,
  markClosed,
  markReopened,
  readSettings,
  saveSetting,
  softDeleteCost,
  updateCost,
  withTransaction,
  writeAudit,
} from "../lib/financeAccountingStore.js";

const BASE = "/api/admin/finance";
const ACCOUNTING_PATH = /^\/api\/admin\/finance\/(?:costs|fx|tax-reserves|tax-rules|tax|weekly|close|distributions|exports|treasury|entity|vat|year-end)(?:\/|$)/;
export const VAT_EVIDENCE_MIGRATION = "db/migrations/20261006_000003_finance_vat_evidence.sql";
const MAX_EXPORT_MONTHS = 36;
const FIRST_MONTH = "2024-01";
// Close order (founder 2026-10-04): closed months form an unbroken run from
// the start. A month closes only when every earlier month with activity is
// closed; a month reopens only when no later month is closed (reopen latest
// first). Months without revenue or costs never block.
const CLOSE_ORDER_RULE = "A month can be closed only when every earlier month with revenue or costs is closed. A month can be reopened only when no later month is closed: reopen the latest first.";

function monthHasActivity(row) {
  return (row.lanes || []).length > 0 || (row.occurrences || []).length > 0 || (row.revenueUsd ?? 0) !== 0 || (row.costsUsd ?? 0) !== 0;
}
const PROPOSAL_LABEL = "Proposal only. Nothing is sent from this page.";
function taxLabel(rules) {
  return `Based on the Belastingdienst, wetten.overheid.nl and KVK, checked ${rules?.checkedOn || "2026-10-05"}. Each rule shows its source and confidence. This is a reserve estimate; any rule can be changed afterwards.`;
}
const WEEKLY_FORMULA = "Per week (EUR): revenue - VAT - costs + treasury (realized gains on crypto - fees + revenue received in the bank - its VAT) = profit; profit - corporate tax reserve (marginal on the year-to-date profit) = profit after tax. Distributable = profit after tax + what earlier weeks left undistributed. Available to divide now = the lower of that (through the last complete week) and the cash in the multisig minus what it must hold: open costs (not yet paid from the bank) + tax still to pay (each reserve minus tax paid) + distributions approved but not paid, less what the bank and exchange accounts hold in EUR, USD and stablecoins to pay those. Each shareholder: gross = share %, minus dividend withholding from the rules for its entity type = net.";
const MAX_WEEKS = 156;
const EVM_TX = /^0x[0-9a-fA-F]{64}$/;
const SOLANA_TX = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const DIST_STATUSES = ["proposed", "approved", "paid", "cancelled"];

const TREASURY_NOT_INSTALLED = `Recording treasury movements and tax items needs ${TREASURY_MIGRATION} on this database.`;
const CRYPTO_COSTS_NOT_INSTALLED = `Costs paid in crypto, token movements and the BV status need ${CRYPTO_COSTS_MIGRATION} on this database.`;
const NATIVE_OF_CHAIN = Object.freeze({ 101: "SOL", 56: "BNB", 4663: "ETH" });
const shortText = (value) => (value ? `${String(value).slice(0, 4)}...${String(value).slice(-4)}` : "");
const TREASURY_MEMO_MS = 20_000;

const COST_EXPORT_COLUMNS = Object.freeze([
  { key: "date", label: "date" }, { key: "month", label: "month" }, { key: "monthStatus", label: "month_status" }, { key: "costId", label: "cost_id" },
  { key: "category", label: "category" }, { key: "vendor", label: "vendor" }, { key: "description", label: "description" }, { key: "recurring", label: "recurring" },
  { key: "amountNative", label: "amount_native" }, { key: "currency", label: "currency" }, { key: "fxRateUsdPerUnit", label: "fx_rate_usd_per_unit" }, { key: "fxSource", label: "fx_source" },
  { key: "amountUsd", label: "amount_usd" }, { key: "usdPerEur", label: "usd_per_eur" }, { key: "amountEur", label: "amount_eur" }, { key: "attachmentUrl", label: "attachment_url" }, { key: "createdBy", label: "created_by" },
]);
const CLOSE_SUMMARY_COLUMNS = Object.freeze([
  { key: "month", label: "month" }, { key: "status", label: "status" }, { key: "source", label: "source" },
  { key: "revenueUsd", label: "revenue_usd" }, { key: "costsUsd", label: "costs_usd" }, { key: "profitUsd", label: "profit_usd" },
  { key: "taxReserveUsd", label: "tax_reserve_usd" }, { key: "ytdTaxReserveUsd", label: "ytd_tax_reserve_usd" },
  { key: "revenueEur", label: "revenue_eur" }, { key: "costsEur", label: "costs_eur" }, { key: "profitEur", label: "profit_eur" },
  { key: "usdPerEur", label: "usd_per_eur" }, { key: "fxSource", label: "fx_source" }, { key: "oursUsd", label: "ours_usd_at_close" }, { key: "owedUsd", label: "owed_usd_at_close" },
  { key: "solUsd", label: "sol_usd_at_close" }, { key: "bnbUsd", label: "bnb_usd_at_close" }, { key: "ethUsd", label: "eth_usd_at_close" }, { key: "priceSources", label: "price_sources" },
  { key: "closedBy", label: "closed_by" }, { key: "closedAt", label: "closed_at" },
]);
const REVENUE_EVENT_COLUMNS = Object.freeze([
  { key: "occurredAt", label: "occurred_at" }, { key: "month", label: "month" }, { key: "chainId", label: "chain_id" }, { key: "chain", label: "chain" }, { key: "lane", label: "lane" },
  { key: "source", label: "source" }, { key: "laneId", label: "lane_id" },
  { key: "asset", label: "asset" }, { key: "amountNative", label: "amount_native" }, { key: "priceUsd", label: "price_usd" }, { key: "amountUsd", label: "amount_usd" }, { key: "priceSource", label: "price_source" },
  { key: "usdPerEur", label: "usd_per_eur" }, { key: "amountEur", label: "amount_eur" }, { key: "fxSource", label: "fx_source" },
  { key: "txHash", label: "tx_hash" }, { key: "logIndex", label: "log_index" }, { key: "campaignAddress", label: "campaign_address" },
  { key: "reference", label: "reference" }, { key: "eventId", label: "event_id" },
]);
const MOVEMENT_EXPORT_COLUMNS = Object.freeze([
  { key: "occurredAt", label: "occurred_at" }, { key: "kind", label: "kind" }, { key: "from", label: "from_account" }, { key: "to", label: "to_account" },
  { key: "assetOut", label: "asset_out" }, { key: "amountOut", label: "amount_out" }, { key: "assetIn", label: "asset_in" }, { key: "amountIn", label: "amount_in" },
  { key: "assetAddress", label: "token_address" }, { key: "valueEur", label: "value_eur" }, { key: "valueSource", label: "value_source" }, { key: "feeAsset", label: "fee_asset" }, { key: "feeAmount", label: "fee_amount" },
  { key: "feeEur", label: "fee_eur" }, { key: "feeSource", label: "fee_source" }, { key: "realizedGainEur", label: "realized_gain_eur" }, { key: "costMethod", label: "cost_method" },
  { key: "costId", label: "cost_id" }, { key: "revenueLane", label: "revenue_lane" }, { key: "txHash", label: "tx_hash" }, { key: "reference", label: "reference" }, { key: "note", label: "note" }, { key: "createdBy", label: "created_by" },
]);
const YEAR_END_TIMEOUT_MS = 90_000;

/** Resolves to the promise's value, or rejects after ms (the year end never waits forever on a chain read). */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} took longer than ${Math.round(ms / 1000)} s`)), ms); })]).finally(() => clearTimeout(timer));
}

export function isFinanceAccountingPath(pathname) {
  return ACCOUNTING_PATH.test(String(pathname || ""));
}

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function notInstalled(res) {
  return res.status(503).json({
    ok: false,
    code: "FINANCE_ACCOUNTING_NOT_INSTALLED",
    error: `The accounting tables are not installed yet. Apply ${ACCOUNTING_MIGRATION} to this database, then reload.`,
  });
}

function currentMonth(nowMs) {
  return todayIso(nowMs).slice(0, 7);
}

function parseYear(value, nowMs) {
  const thisYear = Number(currentMonth(nowMs).slice(0, 4));
  if (value == null || value === "") return thisYear;
  const year = Number(value);
  if (!Number.isInteger(year) || year < 2024 || year > thisYear) throw new FinanceInputError(`year must be between 2024 and ${thisYear}.`, "year");
  return year;
}

function parseRange(query, nowMs, { defaultMonths = 12 } = {}) {
  const now = currentMonth(nowMs);
  const to = query.to ? String(query.to) : now;
  const from = query.from ? String(query.from) : addMonths(to, -(defaultMonths - 1));
  if (!isValidMonth(from) || !isValidMonth(to)) throw new FinanceInputError("from and to must be months (YYYY-MM).", "from");
  if (from > to) throw new FinanceInputError("from is after to.", "from");
  if (to > now) throw new FinanceInputError("to is in the future.", "to");
  if (from < "2024-01") throw new FinanceInputError("from is before 2024-01.", "from");
  if (monthRange(from, to).length > MAX_EXPORT_MONTHS) throw new FinanceInputError(`At most ${MAX_EXPORT_MONTHS} months per request.`, "from");
  return { from, to };
}

function sendCsv(res, filename, columns, rows) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).send(toCsv(columns, rows));
}

function sendFile(res, filename, contentType, body) {
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).send(body);
}

/**
 * @param {object} [deps]  injected for tests: db, prices, fx, revenue, revenueEvents, balances, nowMs
 */
export function createFinanceAccountingHandler(deps = {}) {
  const db = () => deps.db || pool;
  const prices = () => deps.prices || defaultPriceService();
  const fx = () => deps.fx || defaultEurUsdSource();
  const nowMs = () => (deps.nowMs ? deps.nowMs() : Date.now());
  const revenue = (args) => (deps.revenue || monthlyRevenue)({ db: db(), prices: prices(), ...args });
  const revenueEvents = (args) => (deps.revenueEvents || revenueEventRows)({ db: db(), prices: prices(), fx: fx(), ...args });
  const balances = () => (deps.balances || currentBalances)({ db: db() });
  const vatEvidenceEvents = (args) => (deps.vatEvidenceEvents || readEvidenceEvents)({ db: db(), prices: prices(), networks: accountingNetworks().filter((n) => solanaRowsAreMainnet(n)), laneDefinitions, ...args });
  const vies = (vatId) => (deps.checkVies || checkVies)(vatId);
  const payouts = (days) => (deps.payouts || ((d) => buildPayoutsAllChains(feeRoutingAllNetworks(), (network) => cachedPayouts({ network, days: d, db: db() }))))(days);

  async function settings() {
    const row = await readSettings(db());
    return {
      taxRules: effectiveTaxRuleSet(row?.tax_rules),
      taxRulesColumnMissing: Boolean(row?.taxRulesColumnMissing),
      tax: effectiveTaxRules(row?.tax_reserve_rules),
      distribution: effectiveDistributionSettings(row?.distribution),
      updatedBy: row?.updated_by || null,
      updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
    };
  }

  async function spotTable() {
    try {
      return await prices().spotTable(["SOL", "BNB", "ETH"]);
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------- treasury context

  let treasuryMemo = null;
  const invalidateTreasury = () => { treasuryMemo = null; };

  /** Accounts, movements and tax items; empty (installed: false) before the migration. */
  async function treasuryRows() {
    try {
      const [accounts, movements, taxItems] = await Promise.all([
        (deps.listAccounts || listAccounts)(db()),
        (deps.listMovements || listMovements)(db()),
        (deps.listTaxItems || listTaxItems)(db()),
      ]);
      return { installed: true, accounts, movements, taxItems };
    } catch (error) {
      if (treasuryTablesMissing(error)) return { installed: false, accounts: [], movements: [], taxItems: [] };
      throw error;
    }
  }

  /**
   * Treasury effects on the books: lots (fee revenue, opening balances,
   * conversions in) against disposals (conversions out, crypto fees, crypto
   * costs, distributions paid in crypto), realized gains per day, fees and fiat
   * revenue. Daily revenue is only read when there is something to dispose of
   * (or when the caller passes it). Memoized for a few seconds; any write clears it.
   */
  async function treasury({ costs = null, records = null, revDays = null, usdPerEur = null, rules = null } = {}) {
    const memo = !revDays && !usdPerEur;
    if (memo && treasuryMemo && Date.now() - treasuryMemo.at < TREASURY_MEMO_MS) return treasuryMemo.value;
    const rows = await treasuryRows();
    const taxRules = rules || (await settings()).taxRules;
    const today = todayIso(nowMs());
    const live = (costs || (await listCosts(db()))).filter((c) => !c.deletedAt);
    const cryptoCosts = live.filter((c) => lotAsset(c.currency) && c.currency !== "USD").flatMap((c) => expandCost(c, monthOf(c.incurredOn), today.slice(0, 7), { onOrBefore: today }));
    const recs = records || (await distributionRecords()).records;
    const ev = treasuryLotEvents({ movements: rows.movements, costs: cryptoCosts, distributions: recs });
    let days = revDays;
    if (!days && ev.disposals.length) days = (await (deps.dailyRevenue || dailyRevenue)({ db: db(), prices: prices(), fromDate: `${FIRST_MONTH}-01`, toDate: today })).days;
    let rate = usdPerEur;
    if (!rate) {
      const dates = [...Object.keys(days || {}), ...rows.movements.map((m) => m.occurredAt.slice(0, 10)), ...cryptoCosts.map((c) => c.date)].filter((d) => d <= today).sort();
      const map = dates.length ? await ratesByDate(dates[0], today) : new Map();
      const latest = (await fx().rate(null).catch(() => null))?.usdPerEur ?? null;
      rate = (d) => map.get(d) ?? latest;
    }
    const method = taxRules.vpb?.cryptoCostMethod?.method || "fifo";
    const lotInputs = { acquisitions: [...revenueAcquisitions(days || {}, rate), ...ev.acquisitions], disposals: ev.disposals };
    const lots = runLots({ ...lotInputs, method });
    const byDay = treasuryByDay({ lotDisposals: lots.disposals, movements: rows.movements, rules: taxRules, usdPerEur: rate });
    // lotInputs: the same lots in and out, for a year-end cut-off (financeYearEnd.js).
    const value = { ...rows, lots, lotInputs, byDay, byMonth: treasuryByMonth(byDay), method, revenueRead: Boolean(days) };
    if (memo) treasuryMemo = { at: Date.now(), value };
    return value;
  }

  const treasuryMonthView = (t, usdPerEur) => (t ? {
    realizedGainEur: round2(t.realizedGainEur),
    feesEur: round2(t.feesEur),
    otherRevenueEur: round2(t.otherRevenueEur),
    otherVatEur: round2(t.otherVatEur),
    netEur: round2(t.netEur),
    netUsd: usdPerEur ? roundUsd(t.netEur * usdPerEur) : null,
  } : null);

  /**
   * Revenue, costs, profit and tax reserve per month of one year, up to the
   * current month. Closed months come from their snapshot; open months live.
   * Open months include the treasury effects (realized gains, fees, fiat revenue).
   */
  /**
   * Bracket rules for one year: brackets saved on the Tax & Reserves form win;
   * otherwise that year's researched brackets (financeTaxRules).
   */
  function yearTaxRules(s, year) {
    if (!s.tax.isDefault) return s.tax;
    const y = vpbYear(s.taxRules, year);
    return { ...s.tax, name: `Dutch corporate income tax (vennootschapsbelasting) ${year}`, brackets: y.brackets, source: y.source, checkedOn: y.checkedOn, confidence: y.confidence, note: `Based on ${y.source}, checked ${y.checkedOn}. Can be changed afterwards.` };
  }

  async function buildYear(year, { rules, costs } = {}) {
    const now = nowMs();
    const nowMonth = currentMonth(now);
    const first = `${year}-01`;
    const last = `${year}` === nowMonth.slice(0, 4) ? nowMonth : `${year}-12`;
    const months = monthRange(first, last);
    const closes = await listCloses(db(), first, last);
    const allCosts = costs || (await listCosts(db()));
    const taxRules = rules || yearTaxRules(await settings(), year);
    const openMonths = months.filter((m) => closes.get(m)?.status !== "closed");
    // Revenue and treasury are independent reads: together.
    const [live, tr] = await Promise.all([
      openMonths.length ? revenue({ fromMonth: openMonths[0], toMonth: openMonths[openMonths.length - 1] }) : { months: {}, notes: [] },
      openMonths.length ? treasury({ costs: allCosts }) : null,
    ]);

    const rows = [];
    for (const month of months) {
      const close = closes.get(month);
      if (close?.status === "closed" && close.snapshot) {
        const s = close.snapshot;
        rows.push({
          month,
          status: "closed",
          source: "snapshot",
          revenueUsd: s.revenue?.totalUsd ?? null,
          costsUsd: s.costs?.totalUsd ?? null,
          profitUsd: s.profitUsd ?? null,
          treasury: s.treasury ? { realizedGainEur: s.treasury.realizedGainEur, feesEur: s.treasury.feesEur, otherRevenueEur: s.treasury.otherRevenueEur, otherVatEur: s.treasury.otherVatEur, netEur: s.treasury.netEur, netUsd: s.treasury.netUsd } : null,
          usdPerEur: s.fx?.usdPerEur ?? null,
          frozenReserveUsd: s.tax?.reserveUsd ?? null,
          closedBy: close.closedBy,
          closedAt: close.closedAt,
        });
        continue;
      }
      const occurrences = allCosts.flatMap((c) => expandCost(c, month, month));
      const revenueUsd = live.months[month]?.totalUsd ?? (live.months[month] ? null : 0);
      const costsUsd = costTotals(occurrences).totalUsd;
      const eur = await fx().rate(month === nowMonth ? null : monthEnd(month)).catch(() => null);
      const t = treasuryMonthView(tr?.byMonth.get(month), eur?.usdPerEur);
      const treasuryUsd = !t || t.netEur === 0 ? 0 : t.netUsd;
      rows.push({
        month,
        status: "open",
        source: "live",
        revenueUsd,
        costsUsd,
        profitUsd: revenueUsd == null || treasuryUsd == null ? null : roundUsd(revenueUsd - costsUsd + treasuryUsd),
        treasury: t,
        usdPerEur: eur?.usdPerEur ?? null,
        eurSource: eur?.source ?? null,
        frozenReserveUsd: null,
        reopenedBy: close?.reopenedBy || null,
        reopenedAt: close?.reopenedAt || null,
        lanes: live.months[month]?.lanes || [],
        occurrences,
      });
    }
    const schedule = taxReserveSchedule(rows, taxRules);
    const merged = rows.map((row, i) => ({ ...row, ytdProfitUsd: schedule.rows[i].ytdProfitUsd, reserveUsd: schedule.rows[i].reserveUsd, ytdReserveUsd: schedule.rows[i].ytdReserveUsd }));
    const sum = (key) => (merged.some((r) => r[key] == null) ? null : roundUsd(merged.reduce((s, r) => s + r[key], 0)));
    return {
      year,
      months: merged,
      ytd: { revenueUsd: sum("revenueUsd"), costsUsd: sum("costsUsd"), profitUsd: schedule.ytdProfitUsd, reserveUsd: schedule.ytdReserveUsd },
      rules: taxRules,
      notes: live.notes || [],
    };
  }

  // ---------------------------------------------------------------- costs

  async function closedMonthSet(fromMonth, toMonth) {
    const closes = await listCloses(db(), fromMonth, toMonth);
    return new Set([...closes.values()].filter((c) => c.status === "closed").map((c) => c.month));
  }

  async function getCosts(req, res, principal) {
    const query = req.query || {};
    const { from, to } = parseRange(query, nowMs(), { defaultMonths: 12 });
    const category = query.category ? String(query.category) : null;
    const currency = query.currency ? String(query.currency) : null;
    if (category && !COST_CATEGORIES.includes(category)) throw new FinanceInputError("Unknown category.", "category");
    if (currency && !COST_CURRENCIES.includes(currency)) throw new FinanceInputError("Unknown currency.", "currency");
    const includeDeleted = ["1", "true", "yes"].includes(String(query.includeDeleted || "").toLowerCase());
    const all = await listCosts(db(), { includeDeleted });
    const match = (c) => (!category || c.category === category) && (!currency || c.currency === currency);
    const live = all.filter((c) => !c.deletedAt && match(c));
    const occurrences = live.flatMap((c) => expandCost(c, from, to)).sort((a, b) => (a.date < b.date ? 1 : -1));
    const inRange = new Set(occurrences.map((o) => o.costId));
    const entries = all.filter((c) => match(c) && (inRange.has(c.id) || (c.deletedAt && monthOf(c.incurredOn) >= from && monthOf(c.incurredOn) <= to)));
    const months = monthRange(from, to);
    return res.status(200).json({
      schemaVersion: "finance-costs-v2",
      generatedAt: new Date(nowMs()).toISOString(),
      source: "dashboard-api",
      range: { from, to },
      entries,
      occurrences,
      totals: costTotals(occurrences, months),
      closedMonths: [...(await closedMonthSet(from, to))],
      categories: COST_CATEGORIES.map((key) => ({ key, label: COST_CATEGORY_LABELS[key] })),
      currencies: COST_CURRENCIES,
      defaultCurrency: "USD",
      canManage: dashboardPrincipalCan(principal, "finance.manage"),
      recurringRule: "Recurring costs are stored once and counted every month (or year) from their date until the end date. Each occurrence uses the amount and rate fixed at entry. Closed months keep their own frozen copy.",
    });
  }

  async function guardClosed(cost, label) {
    const closed = await closedMonthSet(monthOf(cost.incurredOn), monthOf(cost.incurredOn));
    if (closed.has(monthOf(cost.incurredOn))) {
      throw new HttpError(409, `${label} ${monthOf(cost.incurredOn)} is closed. Reopen the month first.`, { code: "MONTH_CLOSED", month: monthOf(cost.incurredOn) });
    }
  }

  async function createCost(req, res, actor) {
    const input = validateCostInput(req.body, { nowMs: nowMs() });
    checkMergedCost(input);
    await guardClosed(input, "The month");
    const quote = await quoteCost({ amount: input.amount, currency: input.currency, incurredOn: input.incurredOn, manualRate: input.fxRate ?? null, actorEmail: actor.email, prices: prices(), fx: fx(), nowMs: nowMs() });
    const cost = { ...input, ...quote };
    const created = await withTransaction(db(), async (client) => {
      const row = await insertCost(client, cost, actor);
      await writeAudit(client, { actor, action: "cost.create", entityType: "finance_cost", entityId: row.id, before: null, after: row });
      return row;
    });
    return res.status(201).json({ ok: true, cost: created });
  }

  const SAFE_ON_CLOSED = new Set(["recurringUntil", "description", "vendor", "attachmentUrl"]);

  async function patchCost(req, res, actor, id) {
    const input = validateCostInput(req.body, { partial: true, nowMs: nowMs() });
    const result = await withTransaction(db(), async (client) => {
      const before = await getCost(client, id, { forUpdate: true });
      if (!before || before.deletedAt) throw new HttpError(404, "Cost not found.");
      const merged = {
        incurredOn: before.incurredOn,
        category: before.category,
        vendor: before.vendor,
        description: before.description,
        amount: before.amount,
        currency: before.currency,
        recurring: before.recurring,
        recurringUntil: before.recurringUntil,
        attachmentUrl: before.attachmentUrl,
        ...input,
      };
      if (merged.recurring === "none") merged.recurringUntil = null;
      checkMergedCost(merged);
      const closedBefore = (await closedMonthSet(monthOf(before.incurredOn), monthOf(before.incurredOn))).has(monthOf(before.incurredOn));
      const closedAfter = (await closedMonthSet(monthOf(merged.incurredOn), monthOf(merged.incurredOn))).has(monthOf(merged.incurredOn));
      const onlySafeFields = before.recurring !== "none" && Object.keys(input).every((key) => SAFE_ON_CLOSED.has(key));
      if ((closedBefore || closedAfter) && !onlySafeFields) {
        const month = closedBefore ? monthOf(before.incurredOn) : monthOf(merged.incurredOn);
        throw new HttpError(409, `The month ${month} is closed. Reopen it first${before.recurring !== "none" ? ", or only change the end date, vendor, description or attachment" : ""}.`, { code: "MONTH_CLOSED", month });
      }
      const requote = ["amount", "currency", "incurredOn", "fxRate"].some((key) => key in input);
      const quote = requote
        ? await quoteCost({ amount: merged.amount, currency: merged.currency, incurredOn: merged.incurredOn, manualRate: input.fxRate ?? null, actorEmail: actor.email, prices: prices(), fx: fx(), nowMs: nowMs() })
        : { amountUsd: before.amountUsd, fxRate: before.fxRate, fxSource: before.fxSource, fxAt: before.fxAt, eurUsdRate: before.eurUsdRate, eurUsdDate: before.eurUsdDate };
      const after = await updateCost(client, id, { ...merged, ...quote }, actor);
      if (!after) throw new HttpError(404, "Cost not found.");
      await writeAudit(client, { actor, action: "cost.update", entityType: "finance_cost", entityId: id, before, after });
      return after;
    });
    return res.status(200).json({ ok: true, cost: result });
  }

  async function deleteCost(req, res, actor, id) {
    const result = await withTransaction(db(), async (client) => {
      const before = await getCost(client, id, { forUpdate: true });
      if (!before || before.deletedAt) throw new HttpError(404, "Cost not found.");
      const closed = (await closedMonthSet(monthOf(before.incurredOn), monthOf(before.incurredOn))).has(monthOf(before.incurredOn));
      if (closed) {
        throw new HttpError(409, before.recurring !== "none"
          ? `This cost starts in ${monthOf(before.incurredOn)}, which is closed. Set an end date instead, or reopen the month.`
          : `The month ${monthOf(before.incurredOn)} is closed. Reopen it first.`, { code: "MONTH_CLOSED", month: monthOf(before.incurredOn) });
      }
      const after = await softDeleteCost(client, id, actor);
      await writeAudit(client, { actor, action: "cost.delete", entityType: "finance_cost", entityId: id, before, after });
      return after;
    });
    return res.status(200).json({ ok: true, cost: result });
  }

  async function getFxQuote(req, res) {
    const query = req.query || {};
    const currency = String(query.currency || "USD");
    if (!COST_CURRENCIES.includes(currency)) throw new FinanceInputError("Unknown currency.", "currency");
    const date = query.date ? String(query.date) : todayIso(nowMs());
    const input = validateCostInput({ incurredOn: date, category: "other", vendor: "quote", amount: String(query.amount || "1"), currency }, { nowMs: nowMs() });
    const quote = await quoteCost({ amount: input.amount, currency, incurredOn: date, prices: prices(), fx: fx(), nowMs: nowMs() });
    return res.status(200).json({ ok: true, currency, date, amount: input.amount, ...quote });
  }

  // ---------------------------------------------------------------- tax

  // Who changed a setting and what, from finance_audit_log (newest first).
  async function settingsHistory(action, describe) {
    const rows = await (deps.settingsHistory || listSettingsHistory)(db(), action, 20);
    return rows.map((row) => ({ at: row.at, by: row.by, changes: describe(row.before, row.after) }));
  }

  async function getTax(req, res, principal) {
    const year = parseYear(req.query?.year, nowMs());
    const s = await settings();
    const rules = yearTaxRules(s, year);
    const [data, history] = await Promise.all([buildYear(year, { rules }), settingsHistory("settings.tax_reserve_rules", describeTaxChange)]);
    return res.status(200).json({
      schemaVersion: "finance-tax-reserves-v2",
      generatedAt: new Date(nowMs()).toISOString(),
      source: "dashboard-api",
      label: taxLabel(s.taxRules),
      year,
      rules,
      months: data.months.map(({ lanes, occurrences, ...row }) => row),
      ytd: data.ytd,
      notes: data.notes,
      history,
      method: "Profit (revenue minus costs) adds up per calendar year. Each month's reserve is the bracket tax on the year-to-date profit minus the bracket tax on the year-to-date profit before that month, both at that month's USD/EUR rate. A loss month releases reserve. Closed months keep the reserve frozen at close.",
      canManage: dashboardPrincipalCan(principal, "finance.manage"),
    });
  }

  async function putTax(req, res, actor) {
    const body = req.body?.rules ?? req.body;
    const rules = validateTaxRules(body);
    const before = await withTransaction(db(), async (client) => {
      const previous = await saveSetting(client, "tax_reserve_rules", rules, actor);
      await writeAudit(client, { actor, action: "settings.tax_reserve_rules", entityType: "finance_settings", entityId: "tax_reserve_rules", before: previous, after: rules });
      return previous;
    });
    return res.status(200).json({ ok: true, rules: { ...rules, isDefault: false }, replaced: before });
  }

  // ---------------------------------------------------------------- close

  async function getCloseYear(req, res, principal) {
    const year = parseYear(req.query?.year, nowMs());
    const data = await buildYear(year);
    const nowMonth = currentMonth(nowMs());
    return res.status(200).json({
      schemaVersion: "finance-close-v2",
      generatedAt: new Date(nowMs()).toISOString(),
      source: "dashboard-api",
      year,
      months: data.months.map(({ lanes, occurrences, ...row }, i, all) => {
        const earlierOpen = all.slice(0, i).filter((m) => m.status !== "closed" && monthHasActivity(m)).map((m) => m.month);
        const laterClosed = all.slice(i + 1).filter((m) => m.status === "closed").map((m) => m.month);
        return {
          ...row,
          closable: row.status === "open" && row.month < nowMonth && earlierOpen.length === 0,
          closeBlockedBy: row.status === "open" ? earlierOpen : [],
          reopenable: row.status === "closed" && laterClosed.length === 0,
          reopenBlockedBy: row.status === "closed" ? laterClosed : [],
        };
      }),
      closeOrderRule: CLOSE_ORDER_RULE,
      ytd: data.ytd,
      notes: data.notes,
      canManage: dashboardPrincipalCan(principal, "finance.manage"),
    });
  }

  async function buildSnapshot(month, actor) {
    const year = Number(month.slice(0, 4));
    const s = await settings();
    const costs = await listCosts(db());
    const data = await buildYear(year, { rules: yearTaxRules(s, year), costs });
    const row = data.months.find((m) => m.month === month);
    if (!row) throw new HttpError(400, "That month is not in the year view.");
    const single = await revenue({ fromMonth: month, toMonth: month });
    const occurrences = row.occurrences || costs.flatMap((c) => expandCost(c, month, month));
    const totals = costTotals(occurrences);
    let bal;
    try {
      bal = await balances();
    } catch (error) {
      bal = { error: `Balances could not be read: ${String(error?.message || error).slice(0, 160)}` };
    }
    const eur = await fx().rate(monthEnd(month)).catch(() => null);
    const tr = await treasury({ costs });
    const monthDays = Object.fromEntries([...tr.byDay].filter(([d]) => d.slice(0, 7) === month).map(([d, e]) => [d, { realizedGainEur: round2(e.realizedGainEur), feesEur: round2(e.feesEur), otherRevenueEur: round2(e.otherRevenueEur), otherVatEur: round2(e.otherVatEur), otherRevenueUsd: round2(e.otherRevenueUsd) }]));
    const warnings = [];
    const priorOpen = data.months.filter((m) => m.month < month && m.status !== "closed").map((m) => m.month);
    if (priorOpen.length) warnings.push(`Earlier months of ${year} are still open (${priorOpen.join(", ")}); this month's year-to-date tax uses their live figures.`);
    if (row.revenueUsd == null) warnings.push("Some revenue could not be valued in USD.");
    if (bal?.errors?.length) warnings.push(...bal.errors);
    warnings.push("Ours / owed are the balances when the month was closed, not at the last second of the month.");
    return {
      schemaVersion: "finance-close-snapshot-v1",
      month,
      computedAt: new Date(nowMs()).toISOString(),
      closedBy: actor.email,
      revenue: { totalUsd: single.months[month]?.totalUsd ?? row.revenueUsd, lanes: single.months[month]?.lanes || [], excludedTestCoinEvents: single.excludedTestCoinEvents, testCoinsExcluded: true, notes: single.notes, basis: "Each hour valued at that hour's Binance close (event time)." },
      costs: { totalUsd: totals.totalUsd, byCategory: totals.byCategory, occurrences },
      profitUsd: row.profitUsd,
      treasury: { ...(treasuryMonthView(tr.byMonth.get(month), eur?.usdPerEur ?? row.usdPerEur) || { realizedGainEur: 0, feesEur: 0, otherRevenueEur: 0, otherVatEur: 0, netEur: 0, netUsd: 0 }), byDay: monthDays, method: tr.method, cash: Object.fromEntries([...cashPerAccount(tr.movements, tr.taxItems)].map(([id, m]) => [id, Object.fromEntries([...m].map(([a, v]) => [a, roundUsd(v)]))])) },
      tax: { rules: yearTaxRules(s, year), usdPerEur: row.usdPerEur, ytdProfitUsd: row.ytdProfitUsd, reserveUsd: row.reserveUsd, ytdReserveUsd: row.ytdReserveUsd, label: taxLabel(s.taxRules) },
      balances: bal,
      prices: await spotTable(),
      fx: eur ? { usdPerEur: eur.usdPerEur, date: eur.date, source: eur.source } : null,
      warnings,
    };
  }

  async function getCloseMonth(req, res, principal, month) {
    const nowMonth = currentMonth(nowMs());
    if (month > nowMonth) throw new FinanceInputError("That month is in the future.", "month");
    const closes = await listCloses(db(), month, month);
    const close = closes.get(month) || { month, status: "open" };
    const canManage = dashboardPrincipalCan(principal, "finance.manage");
    if (close.status === "closed") {
      return res.status(200).json({ schemaVersion: "finance-close-month-v1", source: "dashboard-api", month, status: "closed", from: "snapshot", close, snapshot: close.snapshot, canManage });
    }
    const preview = await buildSnapshot(month, { email: principal.email });
    return res.status(200).json({ schemaVersion: "finance-close-month-v1", source: "dashboard-api", month, status: "open", from: "live", close, snapshot: preview, closable: month < nowMonth, canManage });
  }

  /**
   * Open months before `month` (from 2024-01) with any activity: revenue
   * lanes or cost occurrences. Closing must go in order over those.
   */
  async function openActiveMonthsBefore(month) {
    const last = addMonths(month, -1);
    if (last < FIRST_MONTH) return [];
    const closes = await listCloses(db(), FIRST_MONTH, last);
    const open = monthRange(FIRST_MONTH, last).filter((m) => closes.get(m)?.status !== "closed");
    if (!open.length) return [];
    const costs = (await listCosts(db())).filter((c) => !c.deletedAt);
    const live = await revenue({ fromMonth: open[0], toMonth: open[open.length - 1] });
    return open.filter((m) => (live.months[m]?.lanes || []).length > 0 || costs.some((c) => expandCost(c, m, m).length > 0));
  }

  async function postCloseMonth(req, res, actor, month) {
    const body = req.body || {};
    const action = String(body.action || "");
    if (action !== "close" && action !== "reopen") throw new FinanceInputError("action must be close or reopen.", "action");
    const expected = `${action.toUpperCase()} ${month}`;
    if (String(body.confirm || "").trim() !== expected) throw new FinanceInputError(`Type "${expected}" to confirm.`, "confirm");
    const nowMonth = currentMonth(nowMs());
    if (action === "close") {
      if (month >= nowMonth) throw new FinanceInputError("Only a month that has ended can be closed.", "month");
      const blockers = await openActiveMonthsBefore(month);
      if (blockers.length) {
        throw new HttpError(409, `Close the earlier months with activity first: ${blockers.join(", ")}.`, { code: "EARLIER_MONTHS_OPEN", months: blockers });
      }
      // Computed before the transaction (it reads chains and prices); the
      // transaction then only checks the status and writes.
      const snapshot = await buildSnapshot(month, actor);
      const result = await withTransaction(db(), async (client) => {
        const before = await lockClose(client, month);
        if (before.status === "closed") throw new HttpError(409, `${month} is already closed.`, { code: "ALREADY_CLOSED" });
        const after = await markClosed(client, month, snapshot, actor);
        await writeAudit(client, { actor, action: "close.close", entityType: "finance_month_close", entityId: month, before, after: { ...after, snapshot: undefined, snapshotSummary: { revenueUsd: snapshot.revenue.totalUsd, costsUsd: snapshot.costs.totalUsd, profitUsd: snapshot.profitUsd, reserveUsd: snapshot.tax.reserveUsd } } });
        return after;
      });
      return res.status(200).json({ ok: true, close: result });
    }
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length < 3 || reason.length > 500) throw new FinanceInputError("Give a reason for reopening (3 to 500 characters).", "reason");
    const later = [...(await listCloses(db(), addMonths(month, 1), "9999-12")).values()].filter((c) => c.status === "closed").map((c) => c.month);
    if (later.length) {
      throw new HttpError(409, `Later months are closed: reopen ${later.slice().reverse().join(", then ")} first (latest first).`, { code: "LATER_MONTHS_CLOSED", months: later });
    }
    const result = await withTransaction(db(), async (client) => {
      const before = await lockClose(client, month);
      if (before.status !== "closed") throw new HttpError(409, `${month} is not closed.`, { code: "NOT_CLOSED" });
      const after = await markReopened(client, month, reason, actor);
      await writeAudit(client, { actor, action: "close.reopen", entityType: "finance_month_close", entityId: month, before, after: { ...after, snapshot: undefined, reason } });
      return after;
    });
    return res.status(200).json({ ok: true, close: result });
  }

  // ---------------------------------------------------------------- distributions

  /** Costs dated up to today in open months, less those already paid (a bank payment or crypto payment linked to the cost). */
  async function openCostsUsd(costs, movements = []) {
    const today = todayIso(nowMs());
    const nowMonth = today.slice(0, 7);
    const live = costs.filter((c) => !c.deletedAt);
    if (!live.length) return 0;
    const earliest = live.reduce((m, c) => (monthOf(c.incurredOn) < m ? monthOf(c.incurredOn) : m), nowMonth);
    const from = earliest < addMonths(nowMonth, -(MAX_EXPORT_MONTHS * 3)) ? addMonths(nowMonth, -(MAX_EXPORT_MONTHS * 3)) : earliest;
    const closed = await closedMonthSet(from, nowMonth);
    const open = live.flatMap((c) => expandCost(c, from, nowMonth, { onOrBefore: today })).filter((o) => !closed.has(o.month) && !bankPaidOccurrence(o, movements));
    return costTotals(open).totalUsd ?? 0;
  }

  async function distributionModel() {
    const s = await settings();
    const costs = await listCosts(db());
    const year = Number(currentMonth(nowMs()).slice(0, 4));
    const [bal, yearData, open] = await Promise.all([
      balances().catch((error) => ({ oursUsd: null, chains: [], errors: [String(error?.message || error).slice(0, 160)] })),
      buildYear(year, { rules: yearTaxRules(s, year), costs }),
      openCostsUsd(costs),
    ]);
    const distribution = computeDistribution({
      chains: bal.chains || [],
      taxReserveUsd: yearData.ytd.reserveUsd,
      openCostsUsd: open,
      settings: resolvedSettings(s),
    });
    return { s, bal, yearData, distribution };
  }

  /** Distribution settings with each share's withholding % from the rules (or its override). */
  function resolvedSettings(s) {
    return { ...s.distribution, shares: s.distribution.shares.map((share) => {
      const w = withholdingFor(share, s.taxRules);
      return { ...share, entityType: w.entityType, withholdingPct: Math.round(w.rate * 10000) / 100, withholding: { reason: w.reason, source: w.source, confidence: w.confidence, override: w.override, fallbackRate: w.fallbackRate } };
    }) };
  }

  async function getDistributions(req, res, principal) {
    const [{ s, bal, yearData, distribution }, history] = await Promise.all([distributionModel(), settingsHistory("settings.distribution", describeDistributionChange)]);
    return res.status(200).json({
      schemaVersion: "finance-distributions-v2",
      generatedAt: new Date(nowMs()).toISOString(),
      source: "dashboard-api",
      label: PROPOSAL_LABEL,
      dividendNote: DIVIDEND_NOTE,
      settings: resolvedSettings(s),
      history,
      multisig: (bal.chains || []).map((c) => ({ chainId: c.chainId, chain: c.chain, asset: c.asset, address: c.multisigAddress, amountNative: c.multisigAmount ?? null, amountUsd: c.multisigUsd, priceUsd: c.priceUsd })),
      buffer: {
        label: BUFFER_LABEL,
        capUsd: OPERATOR_CAP_USD,
        totalUsd: bal.operatorUsd ?? null,
        chains: (bal.chains || []).map((c) => ({ chainId: c.chainId, chain: c.chain, asset: c.asset, address: c.operator?.address ?? null, amountNative: c.operator?.amount ?? null, amountUsd: c.operator?.amountUsd ?? null, status: c.operator?.status ?? "unknown" })),
        protocolVaults: (bal.chains || []).map((c) => ({ chainId: c.chainId, chain: c.chain, asset: c.asset, address: c.protocolVault?.address ?? null, amountNative: c.protocolVault?.amount ?? null, amountUsd: c.protocolVault?.amountUsd ?? null, status: c.protocolVault?.status ?? "unknown" })),
        note: "Protocol revenue fills the operator wallet up to the $10,000 cap; the rest overflows to the multisig. The operator wallet and the protocol vault (revenue not yet forwarded) are never distributed.",
      },
      balances: { asOf: bal.asOf || null, oursUsd: bal.oursUsd ?? null, heldUsd: bal.heldUsd ?? null, owedUsd: bal.owedUsd ?? null, errors: bal.errors || [], note: bal.note || null },
      taxYear: yearData.year,
      distribution,
      formula: "Distributable now = what the multisig holds (Squads vault on Solana, Safe on BNB and Robinhood; native coin, at spot) - tax reserve (this year to date) - open costs (costs dated up to today in months not yet closed). Each share gets its percentage, rounded down to the cent, minus the dividend withholding from the rules for its entity type (or the rate set by hand); per chain it is paid from that chain's part of the multisig balance and never more than the multisig holds there. The weekly view on this page divides profit after tax per week instead.",
      safeChains: Object.entries(SAFE_BATCH_CHAINS).map(([chainId, c]) => ({ chainId: Number(chainId), label: c.label, asset: c.asset, safe: (bal.chains || []).find((x) => x.chainId === Number(chainId))?.multisigAddress || null })),
      squadsVault: (bal.chains || []).find((x) => x.chainId === 101)?.multisigAddress || null,
      canManage: dashboardPrincipalCan(principal, "finance.manage"),
    });
  }

  async function putDistributions(req, res, actor) {
    const next = validateDistributionSettings(req.body?.settings ?? req.body);
    await withTransaction(db(), async (client) => {
      const previous = await saveSetting(client, "distribution", next, actor);
      await writeAudit(client, { actor, action: "settings.distribution", entityType: "finance_settings", entityId: "distribution", before: previous, after: next });
    });
    return res.status(200).json({ ok: true, settings: { ...next, isDefault: false } });
  }

  /** ?week= given: the weekly decision for that week (must be the decision week). */
  async function weeklyDistributionFor(week) {
    if (!weekMonday(week)) throw new FinanceInputError("week must be an ISO week (YYYY-Www).", "week");
    const model = await weeklyModel();
    if (model.decision.week !== week) throw new FinanceInputError(`Only the decision week ${model.decision.week || "(none yet)"} can be proposed; earlier weeks that were not paid are included in it as carry-over.`, "week");
    if (!model.decision.distribution || model.decision.availableEur == null) throw new FinanceInputError(`Nothing to propose for ${week}: ${model.decision.why}`);
    const d = model.decision;
    const summary = `Week ${week} (${d.weekStart} to ${d.weekEnd}): available to divide EUR ${d.availableEur.toFixed(2)} (~$${d.availableUsd.toFixed(2)} at ${d.usdPerEur} USD/EUR). ${d.why} The operator wallet (buffer, capped at $10,000) is not distributed.`;
    return { bal: model.bal, distribution: d.distribution, summary };
  }

  async function getSafeBatch(req, res) {
    const chainId = Number(req.query?.chainId);
    const week = req.query?.week ? String(req.query.week) : null;
    const { bal, distribution } = week ? await weeklyDistributionFor(week) : await distributionModel();
    const batch = buildSafeBatch({ chainId, distribution, chains: bal.chains || [], createdAtMs: nowMs(), week });
    return sendFile(res, `mwz-distribution-proposal-${week ? `${week}-` : ""}${chainId}-${todayIso(nowMs())}.safe-batch.json`, "application/json; charset=utf-8", `${JSON.stringify(batch, null, 2)}\n`);
  }

  async function getSquadsProposal(req, res) {
    const week = req.query?.week ? String(req.query.week) : null;
    const { bal, distribution, summary } = week ? await weeklyDistributionFor(week) : await distributionModel();
    const textBody = buildSquadsProposal({ distribution, chains: bal.chains || [], createdAtMs: nowMs(), week, summary: summary || null });
    return sendFile(res, `mwz-distribution-proposal-solana-${week ? `${week}-` : ""}${todayIso(nowMs())}.txt`, "text/plain; charset=utf-8", `${textBody}\n`);
  }

  // ---------------------------------------------------------------- weekly

  async function distributionRecords() {
    try {
      return { records: await (deps.listDistributions || listDistributions)(db()), installed: true };
    } catch (error) {
      if (distributionTablesMissing(error)) return { records: [], installed: false };
      throw error;
    }
  }

  async function ratesByDate(fromDate, toDate) {
    const map = new Map();
    for (let d = fromDate; d <= toDate; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
      const r = await fx().rate(d).catch(() => null);
      if (r?.usdPerEur) map.set(d, r.usdPerEur);
    }
    return map;
  }

  /** Everything the weekly view needs, computed once. */
  async function weeklyModel() {
    const [s, costs] = await Promise.all([settings(), listCosts(db())]);
    const today = todayIso(nowMs());
    const live = costs.filter((c) => !c.deletedAt);
    const [rev, recs, bal] = await Promise.all([
      (deps.dailyRevenue || dailyRevenue)({ db: db(), prices: prices(), fromDate: `${FIRST_MONTH}-01`, toDate: today }),
      distributionRecords(),
      balances().catch((error) => ({ chains: [], errors: [String(error?.message || error).slice(0, 160)] })),
    ]);
    const firstDates = [...Object.keys(rev.days), ...live.map((c) => c.incurredOn)].filter((d) => d <= today).sort();
    const fromDate = firstDates[0] || today;
    const firstYear = Number(fromDate.slice(0, 4));
    const months = new Map();
    const costsByMonth = new Map();
    const snapshotTreasury = new Map();
    // Every year is read together; the results are applied in year order as before.
    const years = [];
    for (let year = firstYear; year <= Number(today.slice(0, 4)); year += 1) years.push(year);
    const perYear = await Promise.all(years.map((year) => Promise.all([
      buildYear(year, { rules: yearTaxRules(s, year), costs }),
      listCloses(db(), `${year}-01`, `${year}-12`),
    ])));
    for (const [data, closes] of perYear) {
      for (const m of data.months) {
        if (m.month < fromDate.slice(0, 7)) continue;
        months.set(m.month, { status: m.status, revenueUsd: m.revenueUsd, costsUsd: m.costsUsd });
        const snap = closes.get(m.month)?.status === "closed" ? closes.get(m.month).snapshot : null;
        costsByMonth.set(m.month, snap ? snap.costs?.occurrences || [] : m.occurrences || live.flatMap((c) => expandCost(c, m.month, m.month)));
        for (const [d, e] of Object.entries(snap?.treasury?.byDay || {})) snapshotTreasury.set(d, e);
      }
    }
    const rates = await ratesByDate(fromDate, today);
    const latestRate = (await fx().rate(null).catch(() => null))?.usdPerEur ?? null;
    const usdPerEur = (date) => rates.get(date) ?? latestRate;
    // Treasury: live for open months, the close snapshot's for closed months (frozen).
    const tr = await treasury({ costs, records: recs.records, revDays: rev.days, usdPerEur, rules: s.taxRules });
    const byDay = new Map([...tr.byDay].filter(([d]) => months.get(d.slice(0, 7))?.status !== "closed"));
    for (const [d, e] of snapshotTreasury) byDay.set(d, e);
    const open = await openCostsUsd(costs, tr.movements);
    // Customer VAT evidence (sponsors, Home placement buyers): per-event treatment.
    const evidenceRead = await vatEvidenceEvents().catch((error) => ({ events: [], note: `Customer VAT evidence could not be read (${String(error?.message || error).slice(0, 120)}); every lane uses its default reserve.` }));
    const vatResolved = resolveEvidenceEvents(evidenceRead.events, s.taxRules, usdPerEur);
    const model = computeWeeks({ today, fromDate, days: rev.days, usdPerEur, costsByMonth, months, rules: s.taxRules, vpbOverride: s.tax.isDefault ? null : s.tax, records: recs.records, treasuryByDay: byDay, vatEvidence: evidenceByDay(vatResolved) });
    const vatPeriod = s.taxRules.calendar.vatPeriod.period;
    const vatReturns = vatReturnsByPeriod(model.segments, vatPeriod);
    const taxCal = taxObligations({ today, rules: s.taxRules, vatByPeriod: vatByPeriodFrom(model.segments, vatPeriod), ossByPeriod: Object.fromEntries(vatReturns.filter((r) => r.oss.vatDueEur > 0).map((r) => [r.period, r.oss.vatDueEur])), vpbYears: model.years, items: tr.taxItems, records: recs.records, firstActivityOn: fromDate });
    const cash = cashPerAccount(tr.movements, tr.taxItems);
    const offChain = offChainCashEur(tr.accounts, cash, latestRate);
    const monthlyCostsUsd = live.filter((c) => c.recurring !== "none" && (!c.recurringUntil || c.recurringUntil >= today) && c.incurredOn <= today)
      .reduce((sum, c) => sum + (c.recurring === "yearly" ? c.amountUsd / 12 : c.amountUsd), 0);
    const decision = decideWeek({ model, chains: bal.chains || [], openCostsUsd: open, usdPerEurNow: latestRate, settings: s.distribution, rules: s.taxRules, records: recs.records, today, operatorUsd: bal.operatorUsd ?? null, monthlyCostsUsd, held: taxCal.held, offChainCashEur: offChain.eur });
    return { s, today, model, months, costsByMonth, decision, bal, records: recs.records, recordsInstalled: recs.installed, notes: [...(rev.notes || []), ...(evidenceRead.note ? [evidenceRead.note] : [])], latestRate, tr, taxCal, cash, offChain, usdPerEur, revDays: rev.days, vatReturns, vatResolved, vatEvidenceNote: evidenceRead.note || null };
  }

  async function getWeekly(req, res, principal) {
    const n = req.query?.weeks == null || req.query.weeks === "" ? 12 : Number(req.query.weeks);
    if (!Number.isInteger(n) || n < 1 || n > MAX_WEEKS) throw new FinanceInputError(`weeks must be 1 to ${MAX_WEEKS}.`, "weeks");
    const w = await weeklyModel();
    const { decision } = w;
    return res.status(200).json({
      schemaVersion: "finance-weekly-v1",
      generatedAt: new Date(nowMs()).toISOString(),
      source: "dashboard-api",
      label: PROPOSAL_LABEL,
      taxLabel: taxLabel(w.s.taxRules),
      weekRule: WEEK_RULE,
      currency: "EUR",
      formula: WEEKLY_FORMULA,
      today: w.today,
      usdPerEur: w.latestRate,
      weeks: w.model.weeks.slice(-n).map(weekView).reverse(),
      years: w.model.years,
      reconciliation: reconcileMonths(w.model, w.months, w.today).slice(-6).reverse(),
      decision: { ...decision, distribution: undefined, shares: decision.shares.map(({ evmAddress, solanaAddress, ...rest }) => ({ ...rest, hasEvmAddress: Boolean(evmAddress), hasSolanaAddress: Boolean(solanaAddress) })) },
      safeChains: Object.entries(SAFE_BATCH_CHAINS).map(([chainId, c]) => ({ chainId: Number(chainId), label: c.label, asset: c.asset, safe: (w.bal.chains || []).find((x) => x.chainId === Number(chainId))?.multisigAddress || null })),
      squadsVault: (w.bal.chains || []).find((x) => x.chainId === 101)?.multisigAddress || null,
      records: w.records,
      recordsInstalled: w.recordsInstalled,
      tax: { next: w.taxCal.next, upcoming: w.taxCal.upcoming.length, overdue: w.taxCal.obligations.filter((o) => o.status === "overdue").length, held: { vatEur: w.taxCal.held.vatEur, vpbEur: w.taxCal.held.vpbEur, dividendTaxEur: w.taxCal.held.dividendTaxEur }, releaseRule: RESERVE_RELEASE_RULE },
      treasury: { installed: w.tr.installed, realizedGainEur: round2(w.model.totals.realizedGainEur), offChainCashEur: w.offChain.eur, offChainLines: w.offChain.lines, method: w.tr.method },
      migration: w.recordsInstalled ? null : `Recording distributions needs ${DISTRIBUTIONS_MIGRATION} on this database.`,
      rulesCheckedOn: w.s.taxRules.checkedOn,
      needsConfirmation: rulesTable(w.s.taxRules).filter((r) => r.needsConfirmation).map((r) => r.label),
      warnings: [...w.model.warnings, ...(w.bal.errors || [])],
      notes: w.notes,
      canManage: dashboardPrincipalCan(principal, "finance.manage"),
    });
  }

  // ---------------------------------------------------------------- tax rules

  async function getTaxRules(req, res, principal) {
    const s = await settings();
    const history = await settingsHistory("settings.tax_rules", describeTaxRuleChange).catch(() => []);
    return res.status(200).json({
      schemaVersion: "finance-tax-rules-v1",
      generatedAt: new Date(nowMs()).toISOString(),
      source: "dashboard-api",
      label: taxLabel(s.taxRules),
      rules: s.taxRules,
      table: rulesTable(s.taxRules),
      bracketsOverride: s.tax.isDefault ? null : { name: s.tax.name, brackets: s.tax.brackets, note: "Brackets saved on the tax-reserve form are used for every year instead of the researched brackets." },
      history,
      installed: !s.taxRulesColumnMissing,
      migration: s.taxRulesColumnMissing ? `Saving rules needs ${DISTRIBUTIONS_MIGRATION} on this database.` : null,
      canManage: dashboardPrincipalCan(principal, "finance.manage"),
    });
  }

  async function putTaxRules(req, res, actor) {
    const rules = validateTaxRuleSet(req.body?.rules ?? req.body);
    try {
      await withTransaction(db(), async (client) => {
        const previous = await saveSetting(client, "tax_rules", rules, actor);
        await writeAudit(client, { actor, action: "settings.tax_rules", entityType: "finance_settings", entityId: "tax_rules", before: previous, after: rules });
      });
    } catch (error) {
      if (distributionTablesMissing(error)) throw new HttpError(503, `Saving rules needs ${DISTRIBUTIONS_MIGRATION} on this database.`, { code: "FINANCE_DISTRIBUTIONS_NOT_INSTALLED" });
      throw error;
    }
    return res.status(200).json({ ok: true, rules: { ...rules, isDefault: false } });
  }

  // ---------------------------------------------------------------- distribution records

  function dateField(value, field, { notAfter = null } = {}) {
    if (value == null || value === "") return null;
    const text = String(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) throw new FinanceInputError(`${field} must be a date (YYYY-MM-DD).`, field);
    if (notAfter && text > notAfter) throw new FinanceInputError(`${field} is in the future.`, field);
    return text;
  }

  async function getRecords(req, res, principal) {
    const recs = await distributionRecords();
    return res.status(200).json({ schemaVersion: "finance-distribution-records-v1", source: "dashboard-api", records: recs.records, installed: recs.installed, migration: recs.installed ? null : `Recording distributions needs ${DISTRIBUTIONS_MIGRATION} on this database.`, canManage: dashboardPrincipalCan(principal, "finance.manage") });
  }

  async function createRecord(req, res, actor) {
    const body = req.body || {};
    const week = String(body.week || "");
    if (!weekMonday(week)) throw new FinanceInputError("week must be an ISO week (YYYY-Www).", "week");
    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (note.length > 1000) throw new FinanceInputError("note is longer than 1000 characters.", "note");
    const today = todayIso(nowMs());
    const availableOn = dateField(body.availableOn, "availableOn") || today;
    const w = await weeklyModel();
    if (!w.recordsInstalled) throw new HttpError(503, `Recording distributions needs ${DISTRIBUTIONS_MIGRATION} on this database.`, { code: "FINANCE_DISTRIBUTIONS_NOT_INSTALLED" });
    const d = w.decision;
    if (d.week !== week) throw new FinanceInputError(`Only the decision week ${d.week || "(none yet)"} can be recorded.`, "week");
    if (d.alreadyRecorded.length) throw new HttpError(409, `${week} already has a distribution (${d.alreadyRecorded.map((r) => r.status).join(", ")}). Cancel it first to record a new one.`, { code: "WEEK_ALREADY_RECORDED" });
    if (!(d.availableEur > 0)) throw new FinanceInputError(`Nothing to divide for ${week}: ${d.why}`);
    const shares = d.shares.map((x) => ({ id: x.id, name: x.name, entity: x.entity, entityType: x.entityType, bps: x.bps, grossEur: x.grossEur, withholdingRate: x.withholdingRate, withholdingEur: x.withholdingEur, netEur: x.netEur, grossUsd: x.grossUsd, withholdingUsd: x.withholdingUsd, netUsd: x.netUsd, withholdingReason: x.withholding.reason, withholdingSource: x.withholding.source, evmAddress: x.evmAddress || "", solanaAddress: x.solanaAddress || "", perChain: x.perChain }));
    const perChainTotals = new Map();
    for (const x of d.shares) for (const p of x.perChain) {
      const t = perChainTotals.get(p.chainId) || { chainId: p.chainId, chain: p.chain, asset: p.asset, units: 0n, amountUsd: 0 };
      t.units += BigInt(p.units);
      t.amountUsd += p.amountUsd;
      perChainTotals.set(p.chainId, t);
    }
    const perChain = [...perChainTotals.values()].map((t) => ({ ...t, units: t.units.toString(), amountUsd: round2(t.amountUsd) }));
    const needsFiling = d.totalWithholdingEur > 0 || d.shares.some((x) => x.entityType === "us_corporation" && x.withholdingRate === 0 && x.grossEur > 0);
    const rec = {
      week,
      availableOn,
      usdPerEur: d.usdPerEur,
      totalGrossEur: round2(d.shares.reduce((a, x) => a + x.grossEur, 0)),
      totalWithholdingEur: d.totalWithholdingEur,
      totalNetEur: round2(d.shares.reduce((a, x) => a + x.netEur, 0)),
      totalGrossUsd: round2(d.shares.reduce((a, x) => a + (x.grossUsd || 0), 0)),
      totalNetUsd: round2(d.shares.reduce((a, x) => a + (x.netUsd || 0), 0)),
      shares,
      perChain,
      checklist: { computed: d.checklist, why: d.why, shareholderResolution: false, boardApproval: false, balanceTest: false, liquidityTest: false },
      dividendTaxDueOn: needsFiling ? addMonthsToDate(availableOn, w.s.taxRules.filing.returnDueMonths || 1) : null,
      note,
    };
    try {
      const created = await withTransaction(db(), async (client) => {
        const row = await insertDistribution(client, rec, actor);
        await writeAudit(client, { actor, action: "distribution.create", entityType: "finance_distribution", entityId: row.id, before: null, after: row });
        return row;
      });
      return res.status(201).json({ ok: true, record: created });
    } catch (error) {
      if (error?.code === "23505") throw new HttpError(409, `${week} already has a distribution.`, { code: "WEEK_ALREADY_RECORDED" });
      if (distributionTablesMissing(error)) throw new HttpError(503, `Recording distributions needs ${DISTRIBUTIONS_MIGRATION} on this database.`, { code: "FINANCE_DISTRIBUTIONS_NOT_INSTALLED" });
      throw error;
    }
  }

  async function patchRecord(req, res, actor, id) {
    const body = req.body || {};
    const today = todayIso(nowMs());
    const result = await withTransaction(db(), async (client) => {
      const before = await getDistribution(client, id, { forUpdate: true });
      if (!before) throw new HttpError(404, "Distribution not found.");
      const next = { ...before };
      if ("note" in body) {
        const note = typeof body.note === "string" ? body.note.trim() : "";
        if (note.length > 1000) throw new FinanceInputError("note is longer than 1000 characters.", "note");
        next.note = note;
      }
      if (before.status === "cancelled") throw new HttpError(409, "This distribution was cancelled and cannot be changed.", { code: "DISTRIBUTION_CANCELLED" });
      if ("checklist" in body) {
        if (before.status !== "proposed") throw new FinanceInputError("The checklist can only change while the distribution is proposed.", "checklist");
        const c = body.checklist || {};
        next.checklist = { ...before.checklist, shareholderResolution: c.shareholderResolution === true, boardApproval: c.boardApproval === true, balanceTest: c.balanceTest === true, liquidityTest: c.liquidityTest === true };
      }
      if ("availableOn" in body) {
        if (before.status === "paid") throw new FinanceInputError("A paid distribution keeps its date.", "availableOn");
        next.availableOn = dateField(body.availableOn, "availableOn") || today;
        if (before.dividendTaxDueOn) next.dividendTaxDueOn = addMonthsToDate(next.availableOn, 1);
      }
      if ("txHashes" in body) {
        if (!["approved", "paid"].includes(before.status) && body.status !== "approved" && body.status !== "paid") throw new FinanceInputError("Transaction hashes are added once the distribution is approved.", "txHashes");
        const hashes = {};
        for (const [chainId, value] of Object.entries(body.txHashes || {})) {
          const text = String(value || "").trim();
          if (!text) continue;
          const chain = Number(chainId);
          if (!before.perChain.some((p) => p.chainId === chain)) throw new FinanceInputError(`Chain ${chainId} is not part of this distribution.`, "txHashes");
          if (chain === 101 ? !SOLANA_TX.test(text) : !EVM_TX.test(text)) throw new FinanceInputError(`Chain ${chainId}: that is not a transaction hash.`, "txHashes");
          hashes[chain] = text;
        }
        next.txHashes = { ...before.txHashes, ...hashes };
      }
      if ("dividendTaxReturnFiledOn" in body) next.dividendTaxReturnFiledOn = dateField(body.dividendTaxReturnFiledOn, "dividendTaxReturnFiledOn", { notAfter: today });
      if ("dividendTaxPaidOn" in body) next.dividendTaxPaidOn = dateField(body.dividendTaxPaidOn, "dividendTaxPaidOn", { notAfter: today });
      if ("status" in body && body.status !== before.status) {
        const to = String(body.status);
        if (!DIST_STATUSES.includes(to)) throw new FinanceInputError("status must be proposed, approved, paid or cancelled.", "status");
        const allowed = { proposed: ["approved", "cancelled"], approved: ["paid", "cancelled"], paid: [] }[before.status] || [];
        if (!allowed.includes(to)) throw new HttpError(409, `A ${before.status} distribution cannot become ${to}.`, { code: "BAD_TRANSITION" });
        if (to === "approved") {
          const c = next.checklist || {};
          const missing = [["shareholderResolution", "shareholder resolution"], ["boardApproval", "board approval"], ["balanceTest", "balance test"], ["liquidityTest", "liquidity test"]].filter(([k]) => c[k] !== true).map(([, label]) => label);
          if (missing.length) throw new FinanceInputError(`Confirm first: ${missing.join(", ")}.`, "checklist");
          next.decidedBy = actor.email;
          next.decidedAt = new Date(nowMs()).toISOString();
        }
        if (to === "paid") {
          const missing = before.perChain.filter((p) => p.units !== "0" && !next.txHashes?.[p.chainId]).map((p) => p.chain);
          if (missing.length) throw new FinanceInputError(`Add the transaction hash for: ${missing.join(", ")}.`, "txHashes");
          next.availableOn ||= today;
        }
        next.status = to;
      }
      const after = await updateDistribution(client, id, next, actor);
      await writeAudit(client, { actor, action: "distribution.update", entityType: "finance_distribution", entityId: id, before, after });
      return after;
    });
    return res.status(200).json({ ok: true, record: result });
  }

  // ---------------------------------------------------------------- treasury

  function requireTreasury(rows) {
    if (!rows.installed) throw new HttpError(503, TREASURY_NOT_INSTALLED, { code: "FINANCE_TREASURY_NOT_INSTALLED" });
  }

  function treasuryWriteError(error) {
    if (error?.code === "23505") return new HttpError(409, "That is already recorded (same name, address or transaction hash).", { code: "ALREADY_RECORDED" });
    if (cryptoCostsMissing(error)) return new HttpError(503, CRYPTO_COSTS_NOT_INSTALLED, { code: "FINANCE_CRYPTO_COSTS_NOT_INSTALLED" });
    if (treasuryTablesMissing(error)) return new HttpError(503, TREASURY_NOT_INSTALLED, { code: "FINANCE_TREASURY_NOT_INSTALLED" });
    return error;
  }

  async function guardMovementMonth(occurredAt) {
    const month = occurredAt.slice(0, 7);
    if ((await closedMonthSet(month, month)).has(month)) throw new HttpError(409, `The month ${month} is closed. Reopen it first.`, { code: "MONTH_CLOSED", month });
  }

  /**
   * A platform coin's USD price at a time, from our market data (read only):
   * the last curve trade at or before that time times the native coin's
   * Binance 1h close of that hour; when the time is now (within a day) the
   * market_stats price also counts. Null when there is none: the EUR value
   * is then entered by hand.
   */
  async function tokenPriceAt({ chainId, address, at, now = false }) {
    const md = await (deps.tokenMarketData || tokenMarketData)(db(), { chainId, address, at });
    if (!md?.coin) return null;
    const chain = chainId || md.coin.chainId;
    const native = NATIVE_OF_CHAIN[chain];
    const recent = Math.abs(nowMs() - Date.parse(at)) < 86_400_000;
    const label = md.coin.symbol || shortText(address);
    // Market value now: the market_stats price first (it follows the pool after graduation too).
    if (now && md.stats) return { priceUsd: md.stats.priceUsd, source: `${label} market_stats last price (${md.stats.source}, ${md.stats.at})` };
    if (md.trade && native) {
      const hour = Math.floor(Date.parse(at) / 3_600_000) * 3_600_000;
      const closes = typeof prices().hourly === "function" ? await prices().hourly(native, [hour]).catch(() => new Map()) : new Map();
      let nativeUsd = closes.get(hour) || null;
      let nativeSource = `Binance ${native}USDT 1h close ${new Date(hour).toISOString().slice(0, 13)}:00 UTC`;
      if (!nativeUsd && recent) {
        const spot = await prices().spot(native).catch(() => null);
        nativeUsd = spot?.priceUsd || null;
        nativeSource = spot?.source || "spot";
      }
      if (nativeUsd) return { priceUsd: md.trade.priceNative * nativeUsd, source: `${label} curve price of the last trade at or before that time (${md.trade.at}) x ${nativeSource}` };
    }
    if (md.stats && recent) return { priceUsd: md.stats.priceUsd, source: `${label} market_stats last price (${md.stats.source}, ${md.stats.at})` };
    return null;
  }

  /** EUR value of the movement and its fee: typed in, or priced at the time (with the source). */
  async function priceMovement(m, actor, accountsById = new Map()) {
    const out = { ...m };
    if (m.valueEur != null) {
      out.valueSource = `entered by ${actor.email}`;
      out.usdPerEur = null;
      out.priceUsd = null;
    } else {
      const leg = valuationLeg(m);
      const v = await valueInEur({ asset: leg.asset, amount: leg.amount, at: m.occurredAt, prices: prices(), fx: fx(), address: leg.address || null, chainId: leg.address ? tokenChainOf(m, accountsById) : null, tokenPrice: tokenPriceAt });
      Object.assign(out, { valueEur: v.eur, valueSource: v.source, usdPerEur: v.usdPerEur, priceUsd: v.priceUsd });
    }
    if (m.fee) {
      if (m.feeEur != null) out.feeSource = `entered by ${actor.email}`;
      else {
        const v = await valueInEur({ asset: m.fee.asset, amount: m.fee.amount, at: m.occurredAt, prices: prices(), fx: fx() }).catch((error) => {
          if (error instanceof FinanceInputError) throw new FinanceInputError(error.message.replace("valueEur", "feeEur"), "feeEur");
          throw error;
        });
        out.feeEur = v.eur;
        out.feeSource = v.source;
      }
    } else {
      out.feeEur = null;
      out.feeSource = null;
    }
    return out;
  }

  async function checkCostLink(m) {
    if (!m.costId) return;
    const cost = await getCost(db(), m.costId);
    if (!cost || cost.deletedAt) throw new FinanceInputError("costId: no such cost.", "costId");
  }

  function walletBalance(account, chains) {
    if (!account.address) return null;
    const chain = chains.find((c) => c.chainId === account.chainId);
    if (!chain) return null;
    const same = (a) => a && (account.chainId === 101 ? a === account.address : String(a).toLowerCase() === account.address.toLowerCase());
    if (same(chain.multisigAddress)) return { asset: chain.asset, amount: chain.multisigAmount ?? null, amountUsd: chain.multisigUsd ?? null, source: "fee-routing read (chain, now)" };
    if (same(chain.operator?.address)) return { asset: chain.asset, amount: chain.operator.amount ?? null, amountUsd: chain.operator.amountUsd ?? null, source: "fee-routing read (chain, now)" };
    return null;
  }

  async function marketEur(key, amount, usdPerEurNow) {
    const { asset, address } = splitAssetKey(key);
    if (asset === "EUR" && !address) return { eur: round2(amount), source: "EUR" };
    if (!(usdPerEurNow > 0)) return { eur: null, source: "no EUR rate" };
    if (address) {
      const p = await tokenPriceAt({ chainId: null, address, at: new Date(nowMs()).toISOString(), now: true }).catch(() => null);
      return p?.priceUsd ? { eur: round2((amount * p.priceUsd) / usdPerEurNow), source: `${p.source}; ECB rate` } : { eur: null, source: "no market price for this token in our market data" };
    }
    if (asset === "USD" || asset === "USDC" || asset === "USDT") return { eur: round2(amount / usdPerEurNow), source: `${asset} at $1; ECB rate` };
    const spot = await prices().spot(asset).catch(() => null);
    return spot?.priceUsd ? { eur: round2((amount * spot.priceUsd) / usdPerEurNow), source: `${spot.source}; ECB rate` } : { eur: null, source: "no price" };
  }

  async function getTreasury(req, res, principal) {
    const w = await weeklyModel();
    const { tr, cash, latestRate } = w;
    const chains = w.bal.chains || [];
    const names = new Map(tr.accounts.map((a) => [a.id, a.name]));
    const accounts = [];
    for (const a of tr.accounts) {
      const lines = [];
      for (const [key, amount] of cash.get(a.id) || []) {
        if (Math.abs(amount) < 1e-12) continue;
        const m = await marketEur(key, amount, latestRate);
        const { asset, address } = splitAssetKey(key);
        lines.push({ asset, address, amount: roundUsd(amount), marketEur: m.eur, source: m.source });
      }
      accounts.push({ ...a, kindLabel: ACCOUNT_KIND_LABELS[a.kind], chain: a.chainId ? CHAINS[a.chainId] : null, recorded: lines, chainBalance: walletBalance(a, chains) });
    }
    const known = new Set(tr.accounts.filter((a) => a.address && !a.archivedAt).map((a) => `${a.chainId}|${a.chainId === 101 ? a.address : a.address.toLowerCase()}`));
    const suggested = [];
    for (const c of chains) {
      for (const [kind, address, label] of [["multisig", c.multisigAddress, c.chainId === 101 ? "Squads vault" : "Safe"], ["operator_wallet", c.operator?.address, "Operator wallet"]]) {
        if (!address || known.has(`${c.chainId}|${c.chainId === 101 ? address : address.toLowerCase()}`)) continue;
        suggested.push({ name: `${label} ${CHAINS[c.chainId] || c.chain}`, kind, chainId: c.chainId, address, currency: c.asset });
      }
    }
    const holdings = [];
    const cm = w.s.taxRules.vpb.cryptoCostMethod;
    for (const [key, h] of Object.entries(tr.lots.holdings)) {
      const m = await marketEur(key, h.amount, latestRate);
      const book = m.eur == null || !cm.lowerOfCostOrMarket ? round2(h.costEur) : round2(Math.min(h.costEur, m.eur));
      const { asset, address } = splitAssetKey(key);
      holdings.push({ asset, address, amount: roundUsd(h.amount), costEur: round2(h.costEur), marketEur: m.eur, bookEur: book, writeDownEur: m.eur == null ? null : round2(Math.max(0, h.costEur - m.eur)), source: m.source });
    }
    const byYear = new Map();
    for (const d of tr.lots.disposals) byYear.set(d.date.slice(0, 4), (byYear.get(d.date.slice(0, 4)) || 0) + d.gainEur);
    const live = tr.movements.filter((m) => !m.deletedAt);
    const warnings = [];
    if (!tr.installed) warnings.push(TREASURY_NOT_INSTALLED);
    for (const u of tr.lots.uncovered) warnings.push(`${roundUsd(u.amount)} ${u.asset} left on ${u.date} (${u.ref}) without a recorded cost: counted at its proceeds (no gain, no loss). Add an opening balance for that account to fix it.`);
    const unlinked = live.filter((m) => m.kind === "bank_payment" && !m.costId);
    if (unlinked.length) warnings.push(`${unlinked.length} bank payment(s) are not linked to a cost: they move cash but are not a cost in the books. Link each one, or add the cost on the Costs page.`);
    const allCosts = await listCosts(db());
    const liveCostIds = new Set(allCosts.filter((c) => !c.deletedAt).map((c) => c.id));
    const orphaned = live.filter((m) => m.costId && !liveCostIds.has(String(m.costId)));
    if (orphaned.length) warnings.push(`${orphaned.length} payment(s) are linked to a cost that was deleted: the money left, but the cost is no longer in the books. Restore the cost or delete the payment.`);
    const costs = allCosts.filter((c) => !c.deletedAt).slice(0, 300).map((c) => ({ id: c.id, label: `${c.incurredOn} ${c.vendor} ${c.amount} ${c.currency}${c.recurring !== "none" ? ` (${c.recurring})` : ""}` }));
    return res.status(200).json({
      schemaVersion: "finance-treasury-v1",
      generatedAt: new Date(nowMs()).toISOString(),
      source: "dashboard-api",
      installed: tr.installed,
      migration: tr.installed ? null : TREASURY_NOT_INSTALLED,
      today: w.today,
      usdPerEur: latestRate,
      accounts,
      suggestedAccounts: suggested,
      movements: live.slice(0, 500).map((m) => ({ ...m, kindLabel: MOVEMENT_KIND_LABELS[m.kind], fromAccount: names.get(m.fromAccountId) || null, toAccount: names.get(m.toAccountId) || null })),
      realized: {
        method: tr.method,
        rule: { condition: cm.condition, source: cm.source, checkedOn: cm.checkedOn, confidence: cm.confidence },
        totalEur: round2(tr.lots.disposals.reduce((s2, d) => s2 + d.gainEur, 0)),
        byYear: [...byYear].sort().map(([year, eur]) => ({ year, gainEur: round2(eur) })),
        byMonth: [...tr.byMonth].sort(([a], [b]) => (a < b ? 1 : -1)).slice(0, 24).map(([month, t]) => ({ month, ...treasuryMonthView(t, null), netUsd: undefined })),
        disposals: tr.lots.disposals.slice(-200).reverse().map((d) => ({ date: d.date, asset: d.asset, amount: roundUsd(d.amount), kind: d.kind, ref: d.ref, proceedsEur: round2(d.proceedsEur), costEur: round2(d.costEur), gainEur: round2(d.gainEur), uncoveredAmount: roundUsd(d.uncoveredAmount) })),
        revenueLotsRead: tr.revenueRead,
      },
      holdings,
      offChain: w.offChain,
      kinds: MOVEMENT_KINDS.map((key) => ({ key, label: MOVEMENT_KIND_LABELS[key] })),
      accountKinds: ACCOUNT_KINDS.map((key) => ({ key, label: ACCOUNT_KIND_LABELS[key] })),
      assets: TREASURY_ASSETS,
      tokenRule: "Any other token (e.g. one of our platform coins) can be one leg of a movement: give its symbol and its mint or contract address. It is held at cost or lower market value, priced from our market data (last curve trade, market stats) or by hand.",
      revenueLanes: VAT_LANES,
      costCategories: COST_CATEGORIES.map((key) => ({ key, label: COST_CATEGORY_LABELS[key] })),
      entity: await entity(),
      costs,
      method: TREASURY_METHOD,
      warnings,
      canManage: dashboardPrincipalCan(principal, "finance.manage"),
    });
  }

  async function createAccount(req, res, actor) {
    const input = validateAccountInput(req.body);
    try {
      const created = await withTransaction(db(), async (client) => {
        const row = await insertAccount(client, input, actor);
        await writeAudit(client, { actor, action: "account.create", entityType: "finance_account", entityId: row.id, before: null, after: row });
        return row;
      });
      invalidateTreasury();
      return res.status(201).json({ ok: true, account: created });
    } catch (error) {
      throw treasuryWriteError(error);
    }
  }

  async function patchAccount(req, res, actor, id) {
    const input = validateAccountInput(req.body, { partial: true });
    try {
      const result = await withTransaction(db(), async (client) => {
        const before = await getAccount(client, id, { forUpdate: true });
        if (!before) throw new HttpError(404, "Account not found.");
        const next = { ...before, ...input };
        if ("archived" in input) next.archivedAt = input.archived ? before.archivedAt || new Date(nowMs()).toISOString() : null;
        if (next.kind !== "bank" && next.ibanMasked) throw new FinanceInputError("iban is only for bank accounts.", "iban");
        const after = await updateAccount(client, id, next, actor);
        await writeAudit(client, { actor, action: "account.update", entityType: "finance_account", entityId: id, before, after });
        return after;
      });
      invalidateTreasury();
      return res.status(200).json({ ok: true, account: result });
    } catch (error) {
      throw treasuryWriteError(error);
    }
  }

  async function createMovement(req, res, actor) {
    const input = validateMovementInput(req.body, { nowMs: nowMs() });
    const rows = await treasuryRows();
    requireTreasury(rows);
    const accountsById = new Map(rows.accounts.map((a) => [a.id, a]));
    checkMovementAccounts(input, accountsById);
    await checkCostLink(input);
    await guardMovementMonth(input.occurredAt);
    const priced = await priceMovement(input, actor, accountsById);
    try {
      const created = await withTransaction(db(), async (client) => {
        const row = await insertMovement(client, priced, actor);
        await writeAudit(client, { actor, action: "movement.create", entityType: "finance_treasury_movement", entityId: row.id, before: null, after: row });
        return row;
      });
      invalidateTreasury();
      return res.status(201).json({ ok: true, movement: created });
    } catch (error) {
      throw treasuryWriteError(error);
    }
  }

  /** A correction is a full replacement: the body is validated as a new movement. */
  async function patchMovement(req, res, actor, id) {
    const before = await getMovement(db(), id);
    if (!before || before.deletedAt) throw new HttpError(404, "Movement not found.");
    const input = validateMovementInput(req.body, { nowMs: nowMs() });
    const rows = await treasuryRows();
    const accountsById = new Map(rows.accounts.map((a) => [a.id, a]));
    checkMovementAccounts(input, accountsById, { allowArchived: true });
    await checkCostLink(input);
    await guardMovementMonth(before.occurredAt);
    await guardMovementMonth(input.occurredAt);
    const priced = await priceMovement(input, actor, accountsById);
    const tokenColumn = await movementTokenColumn(db());
    try {
      const result = await withTransaction(db(), async (client) => {
        const locked = await getMovement(client, id, { forUpdate: true, tokenColumn });
        if (!locked || locked.deletedAt) throw new HttpError(404, "Movement not found.");
        const hadToken = Boolean(locked.out?.address || locked.in?.address);
        const after = await updateMovement(client, id, priced, actor, { hadToken });
        await writeAudit(client, { actor, action: "movement.update", entityType: "finance_treasury_movement", entityId: id, before: locked, after });
        return after;
      });
      invalidateTreasury();
      return res.status(200).json({ ok: true, movement: result });
    } catch (error) {
      throw treasuryWriteError(error);
    }
  }

  async function deleteMovement(req, res, actor, id) {
    const before = await getMovement(db(), id);
    if (!before || before.deletedAt) throw new HttpError(404, "Movement not found.");
    await guardMovementMonth(before.occurredAt);
    const tokenColumn = await movementTokenColumn(db());
    const result = await withTransaction(db(), async (client) => {
      const locked = await getMovement(client, id, { forUpdate: true, tokenColumn });
      if (!locked || locked.deletedAt) throw new HttpError(404, "Movement not found.");
      const after = await softDeleteMovement(client, id, actor, { tokenColumn });
      await writeAudit(client, { actor, action: "movement.delete", entityType: "finance_treasury_movement", entityId: id, before: locked, after });
      return after;
    });
    invalidateTreasury();
    return res.status(200).json({ ok: true, movement: result });
  }

  async function getUnmatched(req, res, principal) {
    const days = req.query?.days == null || req.query.days === "" ? 30 : Number(req.query.days);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new FinanceInputError("days must be 1 to 365.", "days");
    const rows = await treasuryRows();
    const result = rows.installed
      ? await (deps.unmatchedOutflows || unmatchedOutflows)({ accounts: rows.accounts, movements: rows.movements, sinceMs: nowMs() - days * 86_400_000, nowMs: nowMs() })
      : { wallets: [], unmatched: [], note: TREASURY_NOT_INSTALLED };
    const unmatched = await describeOutflows(result.unmatched || [], rows.accounts);
    return res.status(200).json({ schemaVersion: "finance-treasury-unmatched-v1", generatedAt: new Date(nowMs()).toISOString(), source: "dashboard-api", days, installed: rows.installed, ...result, unmatched, costCategories: COST_CATEGORIES.map((key) => ({ key, label: COST_CATEGORY_LABELS[key] })), canManage: dashboardPrincipalCan(principal, "finance.manage") });
  }

  /**
   * Names what an outflow paid for: a buy of one of our coins through the
   * launchpad (from curve_trades by the transaction hash), or another program
   * the transaction called. Adds the "book as cost" prefill, and for a coin
   * bought, the alternative "conversion to the token" prefill. A buy of one of
   * our own platform coins by the multisig or an operator wallet is suggested
   * as a marketing cost (founder 2026-10-05: the K88 support buy).
   */
  async function describeOutflows(list, accounts) {
    if (!list.length) return list;
    const trades = await (deps.curveTradesByTx || curveTradesByTx)(db(), list.map((u) => u.txHash)).catch(() => new Map());
    const byId = new Map(accounts.map((a) => [a.id, a]));
    return list.map((u) => {
      const account = byId.get(String(u.accountId));
      const same = (x, y) => Boolean(x && y) && (u.chainId === 101 ? x === y : String(x).toLowerCase() === String(y).toLowerCase());
      const found = trades.get(u.chainId === 101 ? u.txHash : String(u.txHash).toLowerCase()) || [];
      const trade = found.find((t) => t.chainId === u.chainId && same(t.wallet, account?.address)) || found.find((t) => t.chainId === u.chainId) || null;
      let description = null;
      let token = null;
      if (trade) {
        const name = trade.symbol || shortText(trade.tokenAddress);
        description = `${trade.side === "sell" ? "Sale" : "Buy"} of ${name} through the launchpad`;
        token = { symbol: trade.symbol, name: trade.name, address: trade.tokenAddress, amount: trade.tokenAmount, chainId: trade.chainId, platformCoin: true, source: "curve_trades (our indexer) by transaction hash" };
      } else if (u.viaLaunchpad) {
        description = "Through the launchpad program (no trade found for this transaction in our indexer yet)";
        const t = (u.tokensIn || [])[0];
        if (t) token = { symbol: null, name: null, address: t.mint, amount: t.amount, chainId: u.chainId, platformCoin: true, source: "token balance change in the transaction" };
      } else if ((u.programs || []).length) {
        description = `Through program ${u.programs.map(shortText).join(", ")}`;
      }
      const wallet = account && (account.kind === "multisig" || account.kind === "operator_wallet");
      const ownCoinBuy = Boolean(token?.platformCoin && (!trade || trade.side === "buy"));
      const suggestion = ownCoinBuy && wallet ? { action: "book_cost", category: "marketing", label: "Book as marketing cost", why: "A buy of one of our own platform coins by our multisig or operator wallet is a support purchase: booked as a marketing cost (founder decision 2026-10-05, the K88 buy)." } : null;
      const symbol = token?.symbol || null;
      const bookCost = {
        accountId: String(u.accountId), txHash: u.txHash, occurredAt: u.at, asset: u.asset, amount: u.amount,
        category: suggestion ? "marketing" : "",
        vendor: trade ? `${trade.name && trade.name !== symbol ? `${trade.name} ` : ""}${symbol ? `(${symbol}) ` : ""}support buy`.trim() : (u.toAccount || (u.to ? `Paid to ${shortText(u.to)}` : "On-chain payment")),
        description: description ? `${description}${token?.amount ? `: ${token.amount} ${symbol || "tokens"}` : ""}` : "",
      };
      const conversion = token?.address && token.amount && symbol
        ? { kind: "conversion", occurredAt: u.at, fromAccountId: String(u.accountId), toAccountId: String(u.accountId), assetOut: u.asset, amountOut: u.amount, assetIn: symbol, amountIn: token.amount, assetAddress: token.address, txHash: u.txHash, note: description || "" }
        : null;
      return { ...u, description, token, suggestion, bookCost, conversionPrefill: conversion };
    });
  }

  const BOOK_FIELDS = ["accountId", "txHash", "occurredAt", "asset", "amount", "assetAddress", "category", "vendor", "description", "valueEur"];

  /**
   * Book an on-chain outflow from one of our wallets as a cost, in one
   * transaction: the finance_costs row (category chosen, EUR value = market
   * value at the time) and the crypto_payment movement linked to it (the
   * crypto leaves the lots at its FIFO cost, the gain or loss is realized),
   * each with its audit row. Records only; nothing is sent.
   */
  async function bookCryptoCost(req, res, actor) {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new FinanceInputError("Send the outflow as a JSON object.");
    const unknown = Object.keys(body).filter((k) => !BOOK_FIELDS.includes(k));
    if (unknown.length) throw new FinanceInputError(`Unknown field: ${unknown[0]}.`, unknown[0]);
    if (!body.txHash) throw new FinanceInputError("txHash is required: a cost booked from the chain names its transaction.", "txHash");
    if (!COST_CATEGORIES.includes(body.category)) throw new FinanceInputError(`category must be one of: ${COST_CATEGORIES.join(", ")}.`, "category");
    const description = String(body.description ?? "").trim();
    if (description.length > 400) throw new FinanceInputError("description is longer than 400 characters.", "description");
    // Placeholder cost id: the real one is the row inserted below.
    const input = validateMovementInput({
      kind: "crypto_payment", occurredAt: body.occurredAt, fromAccountId: body.accountId, assetOut: body.asset, amountOut: body.amount,
      assetAddress: body.assetAddress, valueEur: body.valueEur, costId: "1", txHash: body.txHash, note: description,
    }, { nowMs: nowMs() });
    const rows = await treasuryRows();
    requireTreasury(rows);
    const accountsById = new Map(rows.accounts.map((a) => [a.id, a]));
    const { from } = checkMovementAccounts(input, accountsById);
    if (!WALLET_KINDS.includes(from.kind)) throw new FinanceInputError("Book from one of our wallets.", "accountId");
    if ((from.chainId === 101) !== /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(input.txHash)) throw new FinanceInputError(`That transaction hash is not a ${CHAINS[from.chainId]} transaction.`, "txHash");
    const day = input.occurredAt.slice(0, 10);
    const vendor = String(body.vendor ?? "").trim() || "On-chain payment";
    const costShape = validateCostInput({ incurredOn: day, category: body.category, vendor, description: `${description}${description ? " " : ""}(tx ${input.txHash})`.slice(0, 500), amount: input.out.amount, currency: "USD" }, { nowMs: nowMs() });
    await guardMovementMonth(input.occurredAt);
    await guardClosed(costShape, "The month");
    const priced = await priceMovement(input, actor, accountsById);
    const usdPerEur = priced.usdPerEur ?? (await fx().rate(day).catch(() => null))?.usdPerEur ?? null;
    if (!(usdPerEur > 0)) throw new FinanceInputError(`No USD/EUR rate for ${day}: the cost cannot be put in USD. Try again later.`, "valueEur");
    const amountUsd = priced.priceUsd != null ? roundUsd(Number(input.out.amount) * priced.priceUsd) : roundUsd(priced.valueEur * usdPerEur);
    const nativeCurrency = !input.out.address && COST_CURRENCIES.includes(input.out.asset);
    const cost = {
      ...costShape,
      currency: nativeCurrency ? input.out.asset : "USD",
      amount: nativeCurrency ? input.out.amount : String(amountUsd),
      recurring: "none",
      recurringUntil: null,
      attachmentUrl: null,
      amountUsd,
      fxRate: nativeCurrency ? (priced.priceUsd ?? amountUsd / Number(input.out.amount)) : 1,
      fxSource: nativeCurrency ? priced.valueSource : `${input.out.amount} ${input.out.asset}${input.out.address ? ` (${input.out.address})` : ""} paid; ${priced.valueSource}`,
      fxAt: input.occurredAt,
      eurUsdRate: usdPerEur,
      eurUsdDate: day,
    };
    try {
      const out = await withTransaction(db(), async (client) => {
        const costRow = await insertCost(client, cost, actor);
        await writeAudit(client, { actor, action: "cost.create", entityType: "finance_cost", entityId: costRow.id, before: null, after: costRow });
        const movement = await insertMovement(client, { ...priced, costId: costRow.id }, actor);
        await writeAudit(client, { actor, action: "movement.create", entityType: "finance_treasury_movement", entityId: movement.id, before: null, after: movement });
        return { cost: costRow, movement };
      });
      invalidateTreasury();
      return res.status(201).json({ ok: true, ...out, costEur: round2(out.cost.amountUsd / usdPerEur), rule: "The cost is the market value at the time. The crypto leaves at its FIFO cost; the difference is a realized gain or loss." });
    } catch (error) {
      throw treasuryWriteError(error);
    }
  }

  // ---------------------------------------------------------------- entity

  async function entity() {
    const { value, columnMissing } = await (deps.readEntitySetting || readEntitySetting)(db()).catch(() => ({ value: null, columnMissing: true }));
    return { ...effectiveEntity(value), installed: !columnMissing };
  }

  async function getEntity(req, res, principal) {
    const [current, history] = await Promise.all([entity(), settingsHistory("settings.entity", describeEntityChange).catch(() => [])]);
    return res.status(200).json({ schemaVersion: "finance-entity-v1", source: "dashboard-api", entity: current, statuses: ENTITY_STATUSES.map((key) => ({ key, label: ENTITY_STATUS_LABELS[key] })), history, migration: current.installed ? null : CRYPTO_COSTS_NOT_INSTALLED, canManage: dashboardPrincipalCan(principal, "finance.manage") });
  }

  async function putEntity(req, res, actor) {
    const next = validateEntityInput(req.body?.entity ?? req.body, { today: todayIso(nowMs()) });
    try {
      await withTransaction(db(), async (client) => {
        const previous = await saveSetting(client, "entity", next, actor);
        await writeAudit(client, { actor, action: "settings.entity", entityType: "finance_settings", entityId: "entity", before: previous, after: next });
      });
    } catch (error) {
      if (cryptoCostsMissing(error) || error?.code === "42703") throw new HttpError(503, CRYPTO_COSTS_NOT_INSTALLED, { code: "FINANCE_CRYPTO_COSTS_NOT_INSTALLED" });
      throw error;
    }
    return res.status(200).json({ ok: true, entity: { ...effectiveEntity(next), installed: true } });
  }

  async function getValuePreview(req, res) {
    const q = req.query || {};
    const asset = String(q.asset || "").toUpperCase();
    if (!TREASURY_ASSETS.includes(asset)) throw new FinanceInputError(`asset must be one of: ${TREASURY_ASSETS.join(", ")}.`, "asset");
    const amount = String(q.amount || "1");
    if (!/^\d{1,20}(\.\d{1,18})?$/.test(amount)) throw new FinanceInputError("amount must be a number.", "amount");
    const at = q.at ? String(q.at) : new Date(nowMs()).toISOString();
    const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(at) ? `${at}T12:00:00Z` : at);
    if (!Number.isFinite(parsed)) throw new FinanceInputError("at must be a date or date-time.", "at");
    const v = await valueInEur({ asset, amount, at: new Date(Math.min(parsed, nowMs())).toISOString(), prices: prices(), fx: fx() });
    return res.status(200).json({ ok: true, asset, amount, at, ...v });
  }

  // ---------------------------------------------------------------- tax

  async function getTaxCalendar(req, res, principal) {
    const w = await weeklyModel();
    const { taxCal, tr } = w;
    const cal = w.s.taxRules.calendar;
    return res.status(200).json({
      schemaVersion: "finance-tax-v1",
      generatedAt: new Date(nowMs()).toISOString(),
      source: "dashboard-api",
      installed: tr.installed,
      migration: tr.installed ? null : TREASURY_NOT_INSTALLED,
      label: taxLabel(w.s.taxRules),
      today: w.today,
      upcomingDays: UPCOMING_DAYS,
      next: taxCal.next,
      upcoming: taxCal.upcoming,
      obligations: taxCal.obligations,
      held: taxCal.held,
      reserved: { vpbEur: w.decision.reserves.reservedEur.vpbEur, vatEur: w.decision.reserves.reservedEur.vatEur, dividendTaxEur: w.decision.reserves.reservedEur.dividendTaxEur },
      releasedByPaymentsEur: w.decision.reserves.releasedByPaymentsEur,
      releaseRule: RESERVE_RELEASE_RULE,
      firstPeriodOn: taxCal.firstPeriodOn,
      vat: vatView(w),
      rules: [cal.vatPeriod, cal.vpbProvisional, cal.vpbReturn, cal.firstPeriodOn, w.s.taxRules.filing].map((r) => ({ condition: r.condition, source: r.source, checkedOn: r.checkedOn, confidence: r.confidence })),
      items: tr.taxItems.map((t) => ({ ...t, kindLabel: TAX_ITEM_KIND_LABELS[t.kind], typeLabel: TAX_TYPE_LABELS[t.taxType] })),
      types: TAX_TYPES.map((key) => ({ key, label: TAX_TYPE_LABELS[key] })),
      kinds: TAX_ITEM_KINDS.map((key) => ({ key, label: TAX_ITEM_KIND_LABELS[key] })),
      accounts: tr.accounts.filter((a) => !a.archivedAt && (a.kind === "bank" || a.kind === "exchange")).map((a) => ({ id: a.id, name: a.name })),
      distributions: w.records.filter((r) => r.status === "approved" || r.status === "paid").map((r) => ({ id: r.id, week: r.week, status: r.status, availableOn: r.availableOn, totalWithholdingEur: r.totalWithholdingEur })),
      entity: await entity(),
      canManage: dashboardPrincipalCan(principal, "finance.manage"),
    });
  }

  /** The VAT section of the Tax page: return figures per period, release by evidence, evidence events. */
  function vatView(w) {
    const v = w.s.taxRules.vat;
    const released = w.vatReturns.reduce((sum, r) => sum + r.releasedByEvidenceEur, 0);
    return {
      period: w.s.taxRules.calendar.vatPeriod.period,
      returns: w.vatReturns.slice().reverse(),
      releasedByEvidenceEur: round2(released),
      reserveDefaultEur: round2(w.vatReturns.reduce((sum, r) => sum + r.reserveDefaultEur, 0)),
      reserveEur: round2(w.vatReturns.reduce((sum, r) => sum + r.reserveEur, 0)),
      evidenceEvents: w.vatResolved.slice(-200).reverse().map((e) => ({ at: e.at, laneId: e.laneId, vatLane: e.vatLane, eur: round2(e.eur), treatment: e.treatment, treatmentLabel: VAT_TREATMENT_LABELS[e.treatment] || e.treatment, country: e.country, vatEur: round2(e.vatEur), defaultVatEur: round2(e.defaultVatEur), reason: e.reason, subjectKind: e.customer?.subjectKind, subjectId: e.customer?.subjectId })),
      lanes: VAT_LANES.map((key) => ({ key, ...v.lanes[key], treatmentLabel: VAT_TREATMENT_LABELS[v.lanes[key].treatment] || v.lanes[key].treatment })),
      oss: { thresholdEur: v.oss.thresholdEur, condition: v.oss.condition, source: v.oss.source, checkedOn: v.oss.checkedOn, confidence: v.oss.confidence },
      evidenceRule: { condition: v.evidence.condition, source: v.evidence.source, checkedOn: v.evidence.checkedOn, confidence: v.evidence.confidence },
      boxes: "Dutch return: rubriek 1a = Dutch VAT at 21% (base and VAT), 3b = services to EU businesses under reverse charge (base) plus the ICP return per VAT number; services to businesses or consumers outside the EU and exempt services are not reported. OSS return: base and VAT per EU country, only once EU cross-border consumer sales go over EUR 10,000.",
      note: w.vatEvidenceNote,
    };
  }

  // ---------------------------------------------------------------- VAT customer evidence

  function vatSubjectParams(kind, id) {
    if (!VAT_SUBJECT_KINDS.includes(kind)) throw new FinanceInputError(`kind must be ${VAT_SUBJECT_KINDS.join(" or ")}.`, "kind");
    if (!/^[A-Za-z0-9-]{1,40}$/.test(id)) throw new FinanceInputError("Invalid customer id.", "id");
    return { subjectKind: kind, subjectId: id };
  }

  function vatTablesMissing(error) {
    return error?.code === "42P01" && /finance_vat_customers/.test(String(error?.message || ""));
  }

  async function getVatCustomers(req, res, principal) {
    let customers = [];
    let installed = true;
    try {
      customers = await listVatCustomers(db());
    } catch (error) {
      if (!vatTablesMissing(error) && error?.code !== "42P01") throw error;
      installed = false;
    }
    const subjects = await listVatSubjects(db());
    const byKey = new Map(customers.map((c) => [`${c.subjectKind}:${c.subjectId}`, c]));
    const rows = subjects.map((s) => {
      const c = byKey.get(`${s.subjectKind}:${s.subjectId}`) || null;
      byKey.delete(`${s.subjectKind}:${s.subjectId}`);
      return { ...s, evidence: c, status: evidenceStatus(c) };
    });
    for (const c of byKey.values()) rows.push({ subjectKind: c.subjectKind, subjectId: c.subjectId, name: "", wallet: null, payments: 0, firstAt: null, lastAt: null, evidence: c, status: evidenceStatus(c) });
    return res.status(200).json({
      schemaVersion: "finance-vat-customers-v1",
      generatedAt: new Date(nowMs()).toISOString(),
      source: "dashboard-api",
      installed,
      migration: installed ? null : `Recording customer VAT evidence needs ${VAT_EVIDENCE_MIGRATION} on this database.`,
      customers: rows,
      euCountries: EU_COUNTRIES,
      evidenceKinds: VAT_EVIDENCE_KINDS.map((key) => ({ key, label: evidenceLabel(key) })),
      privacy: "Only what the VAT rules need: customer type, country, VAT or business number, the VIES result and name, and up to 6 location items (kind and country). No IP addresses or bank numbers.",
      canManage: dashboardPrincipalCan(principal, "finance.manage"),
    });
  }

  async function putVatCustomer(req, res, actor, kind, id) {
    const subject = vatSubjectParams(kind, id);
    const input = validateVatCustomerInput(req.body);
    const before = await readVatCustomer(db(), subject.subjectKind, subject.subjectId).catch((error) => {
      if (error?.code === "42P01") throw new HttpError(503, `Recording customer VAT evidence needs ${VAT_EVIDENCE_MIGRATION} on this database.`, { code: "FINANCE_VAT_NOT_INSTALLED" });
      throw error;
    });
    // VIES only for an EU business number; a non-EU number is kept as business evidence.
    const sameNumber = before && before.vatId === input.vatId && before.viesStatus === "valid" && !req.body?.recheck;
    const result = input.customerType === "business" && input.vatId && EU_COUNTRIES.includes(input.country) && input.country !== "NL"
      ? (sameNumber ? { status: before.viesStatus, name: before.viesName, checkedAt: before.viesCheckedAt } : await vies(input.vatId))
      : { status: "not_checked", name: null, checkedAt: null };
    const saved = await withTransaction(db(), async (client) => {
      const row = await upsertVatCustomer(client, { ...subject, input, vies: result, actor });
      await writeAudit(client, { actor, action: "vat_customer.update", entityType: "finance_vat_customer", entityId: `${subject.subjectKind}:${subject.subjectId}`, before, after: row });
      return row;
    });
    return res.status(200).json({ ok: true, customer: saved, status: evidenceStatus(saved), vies: result });
  }

  async function removeVatCustomer(req, res, actor, kind, id) {
    const subject = vatSubjectParams(kind, id);
    const removed = await withTransaction(db(), async (client) => {
      const row = await deleteVatCustomer(client, subject.subjectKind, subject.subjectId);
      if (row) await writeAudit(client, { actor, action: "vat_customer.delete", entityType: "finance_vat_customer", entityId: `${subject.subjectKind}:${subject.subjectId}`, before: row, after: null });
      return row;
    });
    if (!removed) return res.status(404).json({ ok: false, error: "No evidence recorded for this customer." });
    return res.status(200).json({ ok: true });
  }

  async function checkTaxLinks(item, rows) {
    if (item.accountId) {
      const a = rows.accounts.find((x) => x.id === item.accountId);
      if (!a) throw new FinanceInputError("accountId: no such account.", "accountId");
      if (a.kind !== "bank" && a.kind !== "exchange") throw new FinanceInputError("Tax is paid from (or refunded to) a bank or exchange account.", "accountId");
    }
    if (item.distributionId) {
      const d = await getDistribution(db(), item.distributionId);
      if (!d) throw new FinanceInputError("distributionId: no such distribution.", "distributionId");
      if (d.week !== item.period) throw new FinanceInputError(`That distribution is for ${d.week}; use that week as the period.`, "period");
    }
  }

  async function createTaxItem(req, res, actor) {
    const input = validateTaxItemInput(req.body, { today: todayIso(nowMs()) });
    checkMergedTaxItem(input);
    const rows = await treasuryRows();
    requireTreasury(rows);
    await checkTaxLinks(input, rows);
    try {
      const created = await withTransaction(db(), async (client) => {
        const row = await insertTaxItem(client, input, actor);
        await writeAudit(client, { actor, action: "tax_item.create", entityType: "finance_tax_item", entityId: row.id, before: null, after: row });
        return row;
      });
      invalidateTreasury();
      return res.status(201).json({ ok: true, item: created });
    } catch (error) {
      throw treasuryWriteError(error);
    }
  }

  async function patchTaxItem(req, res, actor, id) {
    const input = validateTaxItemInput(req.body, { partial: true, today: todayIso(nowMs()) });
    const rows = await treasuryRows();
    const result = await withTransaction(db(), async (client) => {
      const before = await getTaxItem(client, id, { forUpdate: true });
      if (!before || before.deletedAt) throw new HttpError(404, "Tax item not found.");
      const next = { ...before, ...input };
      checkMergedTaxItem(next);
      await checkTaxLinks(next, rows);
      const after = await updateTaxItem(client, id, next, actor);
      await writeAudit(client, { actor, action: "tax_item.update", entityType: "finance_tax_item", entityId: id, before, after });
      return after;
    });
    invalidateTreasury();
    return res.status(200).json({ ok: true, item: result });
  }

  async function deleteTaxItem(req, res, actor, id) {
    const result = await withTransaction(db(), async (client) => {
      const before = await getTaxItem(client, id, { forUpdate: true });
      if (!before || before.deletedAt) throw new HttpError(404, "Tax item not found.");
      const after = await softDeleteTaxItem(client, id, actor);
      await writeAudit(client, { actor, action: "tax_item.delete", entityType: "finance_tax_item", entityId: id, before, after });
      return after;
    });
    invalidateTreasury();
    return res.status(200).json({ ok: true, item: result });
  }

  // ---------------------------------------------------------------- exports

  async function closeSummaryRows(from, to) {
    const rows = [];
    for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year += 1) {
      const data = await buildYear(year);
      const closes = await listCloses(db(), `${year}-01`, `${year}-12`);
      for (const m of data.months) {
        if (m.month < from || m.month > to) continue;
        const snap = closes.get(m.month)?.status === "closed" ? closes.get(m.month).snapshot : null;
        const price = (asset) => snap?.prices?.find((p) => p.asset === asset)?.priceUsd ?? null;
        const eurOf = (usd) => (usd != null && m.usdPerEur ? round2(usd / m.usdPerEur) : null);
        rows.push({
          month: m.month,
          status: m.status,
          source: m.source,
          revenueUsd: m.revenueUsd,
          costsUsd: m.costsUsd,
          profitUsd: m.profitUsd,
          taxReserveUsd: m.reserveUsd,
          ytdTaxReserveUsd: m.ytdReserveUsd,
          revenueEur: eurOf(m.revenueUsd),
          costsEur: eurOf(m.costsUsd),
          profitEur: eurOf(m.profitUsd),
          usdPerEur: m.usdPerEur,
          fxSource: snap?.fx?.source ?? m.eurSource ?? null,
          oursUsd: snap?.balances?.oursUsd ?? null,
          owedUsd: snap?.balances?.owedUsd ?? null,
          solUsd: price("SOL"),
          bnbUsd: price("BNB"),
          ethUsd: price("ETH"),
          priceSources: snap?.prices?.map((p) => `${p.asset}: ${p.source}`).join("; ") ?? null,
          closedBy: m.closedBy || null,
          closedAt: m.closedAt || null,
        });
      }
    }
    return rows;
  }

  async function costExportRows(from, to) {
    const costs = await listCosts(db());
    const closes = await listCloses(db(), from, to);
    const rows = [];
    const byId = new Map(costs.map((c) => [c.id, c]));
    for (const month of monthRange(from, to)) {
      const close = closes.get(month);
      const list = close?.status === "closed" ? close.snapshot?.costs?.occurrences || [] : costs.flatMap((c) => expandCost(c, month, month));
      for (const o of list) {
        const entry = byId.get(String(o.costId));
        rows.push({
          date: o.date,
          month,
          monthStatus: close?.status === "closed" ? "closed (snapshot)" : "open",
          costId: o.costId,
          category: o.category,
          vendor: o.vendor,
          description: o.description,
          recurring: o.recurring,
          amountNative: o.amount,
          currency: o.currency,
          fxRateUsdPerUnit: o.fxRate,
          fxSource: o.fxSource,
          amountUsd: o.amountUsd,
          usdPerEur: o.eurUsdRate ?? null,
          amountEur: o.eurUsdRate ? round2(o.amountUsd / o.eurUsdRate) : null,
          attachmentUrl: entry?.attachmentUrl ?? null,
          createdBy: entry?.createdBy ?? null,
        });
      }
    }
    return rows;
  }

  /** Treasury movements of [from, to] (months) for the CSV, newest first, with the realized gain per movement. */
  function movementExportRows(tr, from, to) {
    const names = new Map(tr.accounts.map((x) => [x.id, x.name]));
    const gains = new Map();
    for (const d of tr.lots.disposals) {
      const id = /^movement (\d+)/.exec(d.ref || "")?.[1];
      if (id) gains.set(id, (gains.get(id) || 0) + d.gainEur);
    }
    return tr.movements.filter((m) => m.occurredAt.slice(0, 7) >= from && m.occurredAt.slice(0, 7) <= to).reverse().map((m) => ({
      occurredAt: m.occurredAt, kind: m.kind, from: names.get(m.fromAccountId) || "", to: names.get(m.toAccountId) || "",
      assetOut: m.out?.asset || "", amountOut: m.out?.amount || "", assetIn: m.in?.asset || "", amountIn: m.in?.amount || "", assetAddress: m.out?.address || m.in?.address || "",
      valueEur: m.valueEur, valueSource: m.valueSource, feeAsset: m.fee?.asset || "", feeAmount: m.fee?.amount || "", feeEur: m.feeEur ?? "", feeSource: m.feeSource || "",
      realizedGainEur: gains.has(m.id) ? round2(gains.get(m.id)) : "", costMethod: tr.method, costId: m.costId || "", revenueLane: m.revenueLane || "", txHash: m.txHash || "", reference: m.reference, note: m.note, createdBy: m.createdBy,
    }));
  }

  async function getExport(req, res, kind) {
    const { from, to } = parseRange(req.query || {}, nowMs(), { defaultMonths: 12 });
    const suffix = `${from}_${to}`;
    if (kind === "costs") {
      return sendCsv(res, `mwz-costs-${suffix}.csv`, COST_EXPORT_COLUMNS, await costExportRows(from, to));
    }
    if (kind === "close-summaries") {
      return sendCsv(res, `mwz-close-summaries-${suffix}.csv`, CLOSE_SUMMARY_COLUMNS, await closeSummaryRows(from, to));
    }
    if (kind === "revenue-events") {
      const out = await revenueEvents({ fromMonth: from, toMonth: to });
      if (out.truncated) res.setHeader("X-Export-Truncated", "1");
      return sendCsv(res, `mwz-revenue-events-${suffix}.csv`, REVENUE_EVENT_COLUMNS, out.rows);
    }
    if (kind === "payouts") {
      // The payouts read model (/api/admin/finance/payouts, financePayouts.js)
      // is a window of days ending now, so "paid in period" runs from the first
      // day of `from` to today; owed and vault coverage are as of now.
      const days = payoutsDays(Math.max(1, Math.ceil((nowMs() - Date.parse(`${from}-01T00:00:00Z`)) / 86_400_000)));
      const data = await payouts(days);
      const eur = await fx().rate(null).catch(() => null);
      const eurOf = (usd) => (usd != null && eur?.usdPerEur ? round2(usd / eur.usdPerEur) : null);
      const rows = [];
      for (const section of data.networks || []) {
        if (section.status !== "ok") {
          rows.push({ chainId: section.chainId, chain: section.chain, type: "read failed", note: section.error || "The payouts read failed for this chain." });
          continue;
        }
        for (const t of section.data.types || []) {
          const paid = t.paid?.recorded ? t.paid.period : null;
          const owed = t.owed?.known ? t.owed.total : null;
          rows.push({
            chainId: section.chainId,
            chain: section.chain,
            type: t.id,
            label: t.label,
            asset: t.asset,
            periodFrom: section.data.period?.from ?? null,
            periodTo: section.data.period?.to ?? null,
            paidNative: paid?.amount ?? null,
            paidUsd: paid?.amountUsd ?? null,
            paidEur: eurOf(paid?.amountUsd ?? null),
            paidCount: paid?.count ?? null,
            paidPriceSource: paid?.priceSource ?? null,
            owedNative: owed?.amount ?? null,
            owedUsd: owed?.amountUsd ?? null,
            owedEur: eurOf(owed?.amountUsd ?? null),
            owedPriceSource: owed?.priceSource ?? null,
            coverage: t.coverage?.status ?? null,
            lastPayoutAt: t.paid?.lastPayout?.at ?? null,
            lastPayoutNative: t.paid?.lastPayout?.amount ?? null,
            lastPayoutTxHash: t.paid?.lastPayout?.txHash ?? null,
            usdPerEur: eur?.usdPerEur ?? null,
            fxSource: eur?.source ?? null,
            note: [t.paid?.note, t.owed?.note].filter(Boolean).join(" ") || null,
          });
        }
      }
      return sendCsv(res, `mwz-payouts-${suffix}.csv`, [
        { key: "chainId", label: "chain_id" }, { key: "chain", label: "chain" }, { key: "type", label: "payout_type" }, { key: "label", label: "label" }, { key: "asset", label: "asset" },
        { key: "periodFrom", label: "paid_period_from" }, { key: "periodTo", label: "paid_period_to" },
        { key: "paidNative", label: "paid_native" }, { key: "paidUsd", label: "paid_usd" }, { key: "paidEur", label: "paid_eur" }, { key: "paidCount", label: "paid_count" }, { key: "paidPriceSource", label: "paid_price_source" },
        { key: "owedNative", label: "owed_now_native" }, { key: "owedUsd", label: "owed_now_usd" }, { key: "owedEur", label: "owed_now_eur" }, { key: "owedPriceSource", label: "owed_price_source" },
        { key: "coverage", label: "vault_coverage" }, { key: "lastPayoutAt", label: "last_payout_at" }, { key: "lastPayoutNative", label: "last_payout_native" }, { key: "lastPayoutTxHash", label: "last_payout_tx_hash" },
        { key: "usdPerEur", label: "usd_per_eur" }, { key: "fxSource", label: "fx_source" }, { key: "note", label: "note" },
      ], rows);
    }
    if (kind === "treasury-movements") {
      return sendCsv(res, `mwz-treasury-movements-${suffix}.csv`, MOVEMENT_EXPORT_COLUMNS, movementExportRows(await treasury(), from, to));
    }
    return res.status(404).json({ ok: false, error: "Unknown export. Use revenue-events, costs, close-summaries, payouts or treasury-movements." });
  }

  // ---------------------------------------------------------------- year end

  /**
   * Market value in EUR of an amount of an asset key at the end of a day: the
   * Binance 1h close of 23:00 UTC (past days; no spot fallback, so a missing
   * close stays unknown), $1 for USD and stablecoins, our market data for a
   * platform coin, at the ECB rate of that day. Today: the current price.
   */
  async function valueAtDate(key, amount, date) {
    const { asset, address } = splitAssetKey(key);
    if (asset === "EUR" && !address) return { eur: amount, source: "EUR" };
    const today = todayIso(nowMs());
    if (date >= today) return marketEur(key, amount, (await fx().rate(null).catch(() => null))?.usdPerEur ?? null);
    const rate = (await fx().rate(date).catch(() => null))?.usdPerEur ?? null;
    if (!(rate > 0)) return { eur: null, source: `no ECB rate for ${date}` };
    if (address) {
      const p = await tokenPriceAt({ chainId: null, address, at: `${date}T23:59:59.000Z` }).catch(() => null);
      return p?.priceUsd ? { eur: (amount * p.priceUsd) / rate, source: `${p.source}; ECB ${date}` } : { eur: null, source: `no ${asset} price for ${date} in our market data` };
    }
    if (asset === "USD" || asset === "USDC" || asset === "USDT") return { eur: amount / rate, source: `${asset} at $1; ECB ${date}` };
    const hour = Date.parse(`${date}T23:00:00.000Z`);
    const closes = typeof prices().hourly === "function" ? await prices().hourly(asset, [hour]).catch(() => new Map()) : new Map();
    const close = closes.get(hour);
    return close ? { eur: (amount * close) / rate, source: `Binance ${asset}USDT 1h close ${date} 23:00 UTC; ECB ${date}` } : { eur: null, source: `no ${asset} close for ${date} 23:00 UTC` };
  }

  /** The year-end view (buildYearEnd) plus what the schedules need from the model. */
  async function yearEndModel(year) {
    const w = await weeklyModel();
    const today = w.today;
    const { asOf, provisional } = balanceDate(year, today);
    const [closes, costs, ent] = await Promise.all([listCloses(db(), `${year}-01`, `${year}-12`), listCosts(db()), entity()]);
    const owedRead = provisional
      // "Owed now" does not depend on the window: the default window is the one the snapshot cron keeps warm.
      ? withTimeout(payouts(payoutsDays(undefined)), YEAR_END_TIMEOUT_MS, "The payouts read").catch((error) => ({ error: `The payouts read failed: ${String(error?.message || error).slice(0, 160)}` }))
      : Promise.resolve({ error: "Money owed to users is only read for the running year (the Payouts read model has no history at 31 December)." });
    const wallets = w.tr.accounts.filter((a) => a.address && !a.archivedAt);
    const unmatchedRead = !w.tr.installed || !wallets.length
      ? Promise.resolve({ unmatched: [], note: "No wallets are recorded on the Treasury page, so outflows cannot be matched." })
      : withTimeout((deps.unmatchedOutflows || unmatchedOutflows)({ accounts: w.tr.accounts, movements: w.tr.movements, sinceMs: Math.max(Date.parse(`${year}-01-01T00:00:00Z`), nowMs() - 365 * 86_400_000), nowMs: Math.min(nowMs(), Date.parse(`${asOf}T23:59:59Z`)) }), YEAR_END_TIMEOUT_MS, "The unmatched-outflow check")
        .catch((error) => ({ unmatched: [], note: `The unmatched-outflow check failed: ${String(error?.message || error).slice(0, 160)}` }));
    const [owed, unmatched] = await Promise.all([owedRead, unmatchedRead]);
    const view = await buildYearEnd({
      year,
      today,
      rules: w.s.taxRules,
      vpbOverride: w.s.tax.isDefault ? null : w.s.tax,
      entity: ent,
      model: w.model,
      revDays: w.revDays,
      usdPerEur: w.usdPerEur,
      latestUsdPerEur: w.latestRate,
      costsByMonth: w.costsByMonth,
      closeMonths: w.months,
      closes,
      costs: costs.filter((c) => !c.deletedAt),
      treasury: { installed: w.tr.installed, accounts: w.tr.accounts, movements: w.tr.movements, taxItems: w.tr.taxItems, lotInputs: w.tr.lotInputs, method: w.tr.method },
      records: w.records,
      taxCal: w.taxCal,
      valueAt: valueAtDate,
      payouts: owed,
      chainBalances: provisional ? (w.bal.chains || null) : null,
      unmatched,
      notes: w.notes,
    });
    if (!w.tr.installed) view.warnings.push({ level: "warning", area: "treasury", text: TREASURY_NOT_INSTALLED });
    if (!w.recordsInstalled) view.warnings.push({ level: "warning", area: "distributions", text: `Recording distributions needs ${DISTRIBUTIONS_MIGRATION} on this database.` });
    for (const e of w.bal.errors || []) view.warnings.push({ level: "info", area: "chain", text: e });
    return { w, view };
  }

  /** Rows the schedules read besides the view: revenue events (only when asked), costs, movements, closes. */
  async function yearEndExtra(year, w, { withEvents }) {
    const from = `${year}-01`;
    const nowMonth = currentMonth(nowMs());
    const to = `${year}` === nowMonth.slice(0, 4) ? nowMonth : `${year}-12`;
    const [events, costRows, closeRows] = await Promise.all([
      withEvents ? revenueEvents({ fromMonth: from, toMonth: to }) : Promise.resolve({ rows: [], truncated: false }),
      costExportRows(from, to),
      closeSummaryRows(from, to),
    ]);
    return {
      revenueEvents: events.rows,
      revenueEventsTruncated: Boolean(events.truncated),
      revenueEventColumns: REVENUE_EVENT_COLUMNS,
      costs: costRows,
      costColumns: COST_EXPORT_COLUMNS,
      movements: movementExportRows(w.tr, from, to),
      movementColumns: MOVEMENT_EXPORT_COLUMNS,
      closeSummaries: closeRows,
      closeColumns: CLOSE_SUMMARY_COLUMNS,
      records: w.records,
      taxItems: w.tr.taxItems,
    };
  }

  async function getYearEnd(req, res, principal) {
    const query = req.query || {};
    const year = parseYear(query.year, nowMs());
    const format = String(query.format || "json").toLowerCase();
    if (!["json", "csv", "zip"].includes(format)) throw new FinanceInputError("format must be json, csv or zip.", "format");
    const wanted = format === "csv" ? String(query.schedule || "").replace(/\.csv$/, "") : null;
    if (format === "csv" && !/^\d{2}-[a-z-]+$/.test(wanted)) throw new FinanceInputError("schedule is required for format=csv (for example 01-profit-and-loss).", "schedule");
    const { w, view } = await yearEndModel(year);
    const generatedAt = new Date(nowMs()).toISOString();
    if (format === "json") {
      const { _lots, ...json } = view;
      const schedules = yearEndSchedules(view, {});
      return res.status(200).json({
        ...json,
        generatedAt,
        source: "dashboard-api",
        schedules: schedules.map((x) => ({ name: x.name.replace(/\.csv$/, ""), title: x.title, what: x.what })),
        downloads: { zip: `${BASE}/year-end?year=${year}&format=zip`, csv: `${BASE}/year-end?year=${year}&format=csv&schedule=` },
        canManage: dashboardPrincipalCan(principal, "finance.manage"),
      });
    }
    const withEvents = format === "zip" || wanted === "06-revenue-events";
    const extra = await yearEndExtra(year, w, { withEvents });
    if (extra.revenueEventsTruncated) view.warnings.push({ level: "warning", area: "revenue", text: "The revenue events file is cut off at 20,000 rows per lane; the totals are not affected." });
    const schedules = yearEndSchedules(view, extra);
    const suffix = view.provisional ? `${year}-provisional-${view.asOf}` : String(year);
    if (format === "csv") {
      const schedule = schedules.find((x) => x.name === `${wanted}.csv`);
      if (!schedule) throw new FinanceInputError(`Unknown schedule. Use one of: ${schedules.map((x) => x.name.replace(/\.csv$/, "")).join(", ")}.`, "schedule");
      if (extra.revenueEventsTruncated) res.setHeader("X-Export-Truncated", "1");
      return sendFile(res, `mwz-year-end-${suffix}-${schedule.name}`, "text/csv; charset=utf-8", scheduleCsv(schedule));
    }
    const zip = yearEndZip(view, schedules, { generatedAt, generatedBy: principal.email || null, date: new Date(nowMs()) });
    return sendFile(res, `mwz-year-end-${suffix}.zip`, "application/zip", zip);
  }

  // ---------------------------------------------------------------- router

  return async function financeAccounting(req, res) {
    const pathname = String(req.path || new URL(req.url, "http://localhost").pathname).replace(/\/+$/, "");
    const method = String(req.method || "GET").toUpperCase();
    const principal = req.dashboardPrincipal;
    if (!principal || !dashboardPrincipalCan(principal, "finance.view")) {
      return res.status(401).json({ ok: false, error: "Dashboard sign-in with finance.view is required.", code: "FINANCE_VIEW_REQUIRED" });
    }
    const read = method === "GET" || method === "HEAD";
    if (!read && !dashboardPrincipalCan(principal, "finance.manage")) {
      return res.status(403).json({ ok: false, error: "finance.manage is required to change accounting data.", code: "FINANCE_MANAGE_REQUIRED" });
    }
    if (!principal.email) return res.status(401).json({ ok: false, error: "Your dashboard sign-in has no email.", code: "FINANCE_ACTOR_REQUIRED" });
    const actor = { id: principal.authUserId || null, email: String(principal.email).toLowerCase() };
    const rel = pathname.slice(BASE.length + 1);
    const parts = rel.split("/");
    const allow = (methods) => {
      res.setHeader("Allow", methods.join(", "));
      return res.status(405).json({ ok: false, error: "Method not allowed." });
    };

    try {
      await assertAccountingTables(db());
      if (parts[0] === "costs" && parts.length === 1) {
        if (read) return await getCosts(req, res, principal);
        if (method === "POST") return await createCost(req, res, actor);
        return allow(["GET", "POST"]);
      }
      if (parts[0] === "costs" && parts.length === 2) {
        if (!/^[1-9]\d{0,17}$/.test(parts[1])) return res.status(400).json({ ok: false, error: "Invalid cost id." });
        if (method === "PATCH") return await patchCost(req, res, actor, parts[1]);
        if (method === "DELETE") return await deleteCost(req, res, actor, parts[1]);
        return allow(["PATCH", "DELETE"]);
      }
      if (rel === "fx") return read ? await getFxQuote(req, res) : allow(["GET"]);
      if (rel === "tax-reserves") {
        if (read) return await getTax(req, res, principal);
        if (method === "PUT") return await putTax(req, res, actor);
        return allow(["GET", "PUT"]);
      }
      if (rel === "close") return read ? await getCloseYear(req, res, principal) : allow(["GET"]);
      if (parts[0] === "close" && parts.length === 2) {
        if (!isValidMonth(parts[1])) return res.status(400).json({ ok: false, error: "Month must be YYYY-MM." });
        if (read) return await getCloseMonth(req, res, principal, parts[1]);
        if (method === "POST") return await postCloseMonth(req, res, actor, parts[1]);
        return allow(["GET", "POST"]);
      }
      if (rel === "distributions") {
        if (read) return await getDistributions(req, res, principal);
        if (method === "PUT") return await putDistributions(req, res, actor);
        return allow(["GET", "PUT"]);
      }
      if (rel === "weekly") return read ? await getWeekly(req, res, principal) : allow(["GET"]);
      if (rel === "tax-rules") {
        if (read) return await getTaxRules(req, res, principal);
        if (method === "PUT") return await putTaxRules(req, res, actor);
        return allow(["GET", "PUT"]);
      }
      if (rel === "distributions/records") {
        if (read) return await getRecords(req, res, principal);
        if (method === "POST") return await createRecord(req, res, actor);
        return allow(["GET", "POST"]);
      }
      if (parts[0] === "distributions" && parts[1] === "records" && parts.length === 3) {
        if (!/^[1-9]\d{0,17}$/.test(parts[2])) return res.status(400).json({ ok: false, error: "Invalid distribution id." });
        if (method === "PATCH") return await patchRecord(req, res, actor, parts[2]);
        return allow(["PATCH"]);
      }
      if (rel === "distributions/safe-batch") return read ? await getSafeBatch(req, res) : allow(["GET"]);
      if (rel === "distributions/squads-proposal") return read ? await getSquadsProposal(req, res) : allow(["GET"]);
      if (rel === "treasury") return read ? await getTreasury(req, res, principal) : allow(["GET"]);
      if (rel === "treasury/accounts") return method === "POST" ? await createAccount(req, res, actor) : allow(["POST"]);
      if (parts[0] === "treasury" && parts[1] === "accounts" && parts.length === 3) {
        if (!/^[1-9]\d{0,17}$/.test(parts[2])) return res.status(400).json({ ok: false, error: "Invalid account id." });
        return method === "PATCH" ? await patchAccount(req, res, actor, parts[2]) : allow(["PATCH"]);
      }
      if (rel === "treasury/movements") return method === "POST" ? await createMovement(req, res, actor) : allow(["POST"]);
      if (parts[0] === "treasury" && parts[1] === "movements" && parts.length === 3) {
        if (!/^[1-9]\d{0,17}$/.test(parts[2])) return res.status(400).json({ ok: false, error: "Invalid movement id." });
        if (method === "PATCH") return await patchMovement(req, res, actor, parts[2]);
        if (method === "DELETE") return await deleteMovement(req, res, actor, parts[2]);
        return allow(["PATCH", "DELETE"]);
      }
      if (rel === "treasury/unmatched") return read ? await getUnmatched(req, res, principal) : allow(["GET"]);
      if (rel === "treasury/value") return read ? await getValuePreview(req, res) : allow(["GET"]);
      if (rel === "treasury/crypto-costs") return method === "POST" ? await bookCryptoCost(req, res, actor) : allow(["POST"]);
      if (rel === "entity") {
        if (read) return await getEntity(req, res, principal);
        if (method === "PUT") return await putEntity(req, res, actor);
        return allow(["GET", "PUT"]);
      }
      if (rel === "tax") return read ? await getTaxCalendar(req, res, principal) : allow(["GET"]);
      if (rel === "tax/items") return method === "POST" ? await createTaxItem(req, res, actor) : allow(["POST"]);
      if (parts[0] === "tax" && parts[1] === "items" && parts.length === 3) {
        if (!/^[1-9]\d{0,17}$/.test(parts[2])) return res.status(400).json({ ok: false, error: "Invalid tax item id." });
        if (method === "PATCH") return await patchTaxItem(req, res, actor, parts[2]);
        if (method === "DELETE") return await deleteTaxItem(req, res, actor, parts[2]);
        return allow(["PATCH", "DELETE"]);
      }
      if (rel === "vat/customers") return read ? await getVatCustomers(req, res, principal) : allow(["GET"]);
      if (parts[0] === "vat" && parts[1] === "customers" && parts.length === 4) {
        if (method === "PUT") return await putVatCustomer(req, res, actor, parts[2], parts[3]);
        if (method === "DELETE") return await removeVatCustomer(req, res, actor, parts[2], parts[3]);
        return allow(["PUT", "DELETE"]);
      }
      if (rel === "year-end") return read ? await getYearEnd(req, res, principal) : allow(["GET"]);
      if (parts[0] === "exports" && parts.length === 2) return read ? await getExport(req, res, parts[1].replace(/\.csv$/, "")) : allow(["GET"]);
      return res.status(404).json({ ok: false, error: "Unknown finance accounting route." });
    } catch (error) {
      if (res.headersSent) return undefined;
      if (accountingTablesMissing(error)) return notInstalled(res);
      if (error instanceof FinanceInputError) return res.status(400).json({ ok: false, error: error.message, ...(error.field ? { field: error.field } : {}) });
      if (error instanceof HttpError) return res.status(error.status).json({ ok: false, error: error.message, ...error.extra });
      console.error("[api/admin/finance accounting]", pathname, error);
      return res.status(500).json({ ok: false, error: "Finance accounting request failed." });
    }
  };
}

let defaultHandler = null;
export default function financeAccounting(req, res) {
  defaultHandler ||= createFinanceAccountingHandler();
  return defaultHandler(req, res);
}
