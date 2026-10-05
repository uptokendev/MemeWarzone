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
//   GET    exports/:kind              CSV (revenue-events, costs, close-summaries, payouts)

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
import { currentBalances, dailyRevenue, monthlyRevenue, revenueEventRows } from "../lib/financeAccountingSources.js";
import { buildPayoutsAllChains, cachedPayouts, payoutsDays } from "../lib/financePayouts.js";
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
const ACCOUNTING_PATH = /^\/api\/admin\/finance\/(?:costs|fx|tax-reserves|tax-rules|weekly|close|distributions|exports)(?:\/|$)/;
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
const WEEKLY_FORMULA = "Per week (EUR): revenue - VAT - costs = profit; profit - corporate tax reserve (marginal on the year-to-date profit) = profit after tax. Distributable = profit after tax + what earlier weeks left undistributed. Available to divide now = the lower of that (through the last complete week) and the cash in the multisig minus open costs, all tax reserves held and distributions approved but not paid. Each shareholder: gross = share %, minus dividend withholding from the rules for its entity type = net.";
const MAX_WEEKS = 156;
const EVM_TX = /^0x[0-9a-fA-F]{64}$/;
const SOLANA_TX = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const DIST_STATUSES = ["proposed", "approved", "paid", "cancelled"];

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

  /**
   * Revenue, costs, profit and tax reserve per month of one year, up to the
   * current month. Closed months come from their snapshot; open months live.
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
    const live = openMonths.length ? await revenue({ fromMonth: openMonths[0], toMonth: openMonths[openMonths.length - 1] }) : { months: {}, notes: [] };

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
      rows.push({
        month,
        status: "open",
        source: "live",
        revenueUsd,
        costsUsd,
        profitUsd: revenueUsd == null ? null : roundUsd(revenueUsd - costsUsd),
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

  async function openCostsUsd(costs) {
    const today = todayIso(nowMs());
    const nowMonth = today.slice(0, 7);
    const live = costs.filter((c) => !c.deletedAt);
    if (!live.length) return 0;
    const earliest = live.reduce((m, c) => (monthOf(c.incurredOn) < m ? monthOf(c.incurredOn) : m), nowMonth);
    const from = earliest < addMonths(nowMonth, -(MAX_EXPORT_MONTHS * 3)) ? addMonths(nowMonth, -(MAX_EXPORT_MONTHS * 3)) : earliest;
    const closed = await closedMonthSet(from, nowMonth);
    const open = live.flatMap((c) => expandCost(c, from, nowMonth, { onOrBefore: today })).filter((o) => !closed.has(o.month));
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
    const s = await settings();
    const today = todayIso(nowMs());
    const costs = await listCosts(db());
    const live = costs.filter((c) => !c.deletedAt);
    const [rev, recs, bal, open] = await Promise.all([
      (deps.dailyRevenue || dailyRevenue)({ db: db(), prices: prices(), fromDate: `${FIRST_MONTH}-01`, toDate: today }),
      distributionRecords(),
      balances().catch((error) => ({ chains: [], errors: [String(error?.message || error).slice(0, 160)] })),
      openCostsUsd(costs),
    ]);
    const firstDates = [...Object.keys(rev.days), ...live.map((c) => c.incurredOn)].filter((d) => d <= today).sort();
    const fromDate = firstDates[0] || today;
    const firstYear = Number(fromDate.slice(0, 4));
    const months = new Map();
    const costsByMonth = new Map();
    for (let year = firstYear; year <= Number(today.slice(0, 4)); year += 1) {
      const data = await buildYear(year, { rules: yearTaxRules(s, year), costs });
      const closes = await listCloses(db(), `${year}-01`, `${year}-12`);
      for (const m of data.months) {
        if (m.month < fromDate.slice(0, 7)) continue;
        months.set(m.month, { status: m.status, revenueUsd: m.revenueUsd, costsUsd: m.costsUsd });
        const snap = closes.get(m.month)?.status === "closed" ? closes.get(m.month).snapshot : null;
        costsByMonth.set(m.month, snap ? snap.costs?.occurrences || [] : m.occurrences || live.flatMap((c) => expandCost(c, m.month, m.month)));
      }
    }
    const rates = await ratesByDate(fromDate, today);
    const latestRate = (await fx().rate(null).catch(() => null))?.usdPerEur ?? null;
    const usdPerEur = (date) => rates.get(date) ?? latestRate;
    const model = computeWeeks({ today, fromDate, days: rev.days, usdPerEur, costsByMonth, months, rules: s.taxRules, vpbOverride: s.tax.isDefault ? null : s.tax, records: recs.records });
    const monthlyCostsUsd = live.filter((c) => c.recurring !== "none" && (!c.recurringUntil || c.recurringUntil >= today) && c.incurredOn <= today)
      .reduce((sum, c) => sum + (c.recurring === "yearly" ? c.amountUsd / 12 : c.amountUsd), 0);
    const decision = decideWeek({ model, chains: bal.chains || [], openCostsUsd: open, usdPerEurNow: latestRate, settings: s.distribution, rules: s.taxRules, records: recs.records, today, operatorUsd: bal.operatorUsd ?? null, monthlyCostsUsd });
    return { s, today, model, months, decision, bal, records: recs.records, recordsInstalled: recs.installed, notes: rev.notes || [], latestRate };
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

  async function getExport(req, res, kind) {
    const { from, to } = parseRange(req.query || {}, nowMs(), { defaultMonths: 12 });
    const suffix = `${from}_${to}`;
    if (kind === "costs") {
      return sendCsv(res, `mwz-costs-${suffix}.csv`, [
        { key: "date", label: "date" }, { key: "month", label: "month" }, { key: "monthStatus", label: "month_status" }, { key: "costId", label: "cost_id" },
        { key: "category", label: "category" }, { key: "vendor", label: "vendor" }, { key: "description", label: "description" }, { key: "recurring", label: "recurring" },
        { key: "amountNative", label: "amount_native" }, { key: "currency", label: "currency" }, { key: "fxRateUsdPerUnit", label: "fx_rate_usd_per_unit" }, { key: "fxSource", label: "fx_source" },
        { key: "amountUsd", label: "amount_usd" }, { key: "usdPerEur", label: "usd_per_eur" }, { key: "amountEur", label: "amount_eur" }, { key: "attachmentUrl", label: "attachment_url" }, { key: "createdBy", label: "created_by" },
      ], await costExportRows(from, to));
    }
    if (kind === "close-summaries") {
      return sendCsv(res, `mwz-close-summaries-${suffix}.csv`, [
        { key: "month", label: "month" }, { key: "status", label: "status" }, { key: "source", label: "source" },
        { key: "revenueUsd", label: "revenue_usd" }, { key: "costsUsd", label: "costs_usd" }, { key: "profitUsd", label: "profit_usd" },
        { key: "taxReserveUsd", label: "tax_reserve_usd" }, { key: "ytdTaxReserveUsd", label: "ytd_tax_reserve_usd" },
        { key: "revenueEur", label: "revenue_eur" }, { key: "costsEur", label: "costs_eur" }, { key: "profitEur", label: "profit_eur" },
        { key: "usdPerEur", label: "usd_per_eur" }, { key: "fxSource", label: "fx_source" }, { key: "oursUsd", label: "ours_usd_at_close" }, { key: "owedUsd", label: "owed_usd_at_close" },
        { key: "solUsd", label: "sol_usd_at_close" }, { key: "bnbUsd", label: "bnb_usd_at_close" }, { key: "ethUsd", label: "eth_usd_at_close" }, { key: "priceSources", label: "price_sources" },
        { key: "closedBy", label: "closed_by" }, { key: "closedAt", label: "closed_at" },
      ], await closeSummaryRows(from, to));
    }
    if (kind === "revenue-events") {
      const out = await revenueEvents({ fromMonth: from, toMonth: to });
      if (out.truncated) res.setHeader("X-Export-Truncated", "1");
      return sendCsv(res, `mwz-revenue-events-${suffix}.csv`, [
        { key: "occurredAt", label: "occurred_at" }, { key: "month", label: "month" }, { key: "chainId", label: "chain_id" }, { key: "chain", label: "chain" }, { key: "lane", label: "lane" },
        { key: "source", label: "source" }, { key: "laneId", label: "lane_id" },
        { key: "asset", label: "asset" }, { key: "amountNative", label: "amount_native" }, { key: "priceUsd", label: "price_usd" }, { key: "amountUsd", label: "amount_usd" }, { key: "priceSource", label: "price_source" },
        { key: "usdPerEur", label: "usd_per_eur" }, { key: "amountEur", label: "amount_eur" }, { key: "fxSource", label: "fx_source" },
        { key: "txHash", label: "tx_hash" }, { key: "logIndex", label: "log_index" }, { key: "campaignAddress", label: "campaign_address" },
        { key: "reference", label: "reference" }, { key: "eventId", label: "event_id" },
      ], out.rows);
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
    return res.status(404).json({ ok: false, error: "Unknown export. Use revenue-events, costs, close-summaries or payouts." });
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
