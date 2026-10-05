// Database access for the accounting tables (db/migrations/
// 20261004_000002_finance_accounting.sql). Every write runs in a transaction
// that also inserts its finance_audit_log row, so a change without an audit
// row cannot happen. Until the migration is applied the reads and writes fail
// with 42P01 and the handler answers "accounting tables not installed yet".

import { costFromRow } from "./financeAccountingCosts.js";

export const ACCOUNTING_MIGRATION = "db/migrations/20261004_000002_finance_accounting.sql";
// Weekly distributions: finance_distributions, finance_settings.tax_rules and the
// new audit actions. Until it is applied the weekly view still works (records
// list empty, rules from code); recording and saving rules answer 503.
export const DISTRIBUTIONS_MIGRATION = "db/migrations/20261005_000001_finance_distributions.sql";

export function distributionTablesMissing(error) {
  return error?.code === "42P01" || error?.code === "42703" || (error?.code === "23514" && /finance_audit_log_(action|entity)_chk/.test(String(error?.constraint || error?.message || "")));
}

export function accountingTablesMissing(error) {
  return error?.code === "42P01" || error?.code === "42703";
}

const COST_COLUMNS = `id, incurred_on::text as incurred_on, category, vendor, description, amount::text as amount, currency,
  amount_usd::text as amount_usd, fx_rate::text as fx_rate, fx_source, fx_at, eur_usd_rate::text as eur_usd_rate,
  eur_usd_date::text as eur_usd_date, recurring, recurring_until::text as recurring_until, attachment_url,
  created_by, created_at, updated_by, updated_at, deleted_by, deleted_at`;

export async function withTransaction(db, fn) {
  const client = typeof db.connect === "function" ? await db.connect() : db;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (client !== db && typeof client.release === "function") client.release();
  }
}

export async function writeAudit(client, { actor, action, entityType, entityId, before = null, after = null }) {
  await client.query(
    `insert into public.finance_audit_log (actor_id, actor_email, action, entity_type, entity_id, before, after)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
    [actor.id || null, actor.email, action, entityType, entityId == null ? null : String(entityId), before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after)],
  );
}

/** Checks all four tables exist (one cheap query). Throws 42P01 when one is missing. */
export async function assertAccountingTables(db) {
  await db.query(
    `select (select 1 from public.finance_costs limit 1) as c,
            (select 1 from public.finance_audit_log limit 1) as a,
            (select 1 from public.finance_month_close limit 1) as m,
            (select 1 from public.finance_settings limit 1) as s`,
  );
}

export async function listCosts(db, { includeDeleted = false } = {}) {
  const { rows } = await db.query(
    `select ${COST_COLUMNS} from public.finance_costs
      ${includeDeleted ? "" : "where deleted_at is null"}
      order by incurred_on desc, id desc
      limit 5000`,
  );
  return rows.map(costFromRow);
}

export async function getCost(db, id, { forUpdate = false } = {}) {
  const { rows } = await db.query(`select ${COST_COLUMNS} from public.finance_costs where id = $1${forUpdate ? " for update" : ""}`, [id]);
  return rows[0] ? costFromRow(rows[0]) : null;
}

export async function insertCost(client, cost, actor) {
  const { rows } = await client.query(
    `insert into public.finance_costs
       (incurred_on, category, vendor, description, amount, currency, amount_usd, fx_rate, fx_source, fx_at,
        eur_usd_rate, eur_usd_date, recurring, recurring_until, attachment_url, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16)
     returning ${COST_COLUMNS}`,
    [cost.incurredOn, cost.category, cost.vendor, cost.description, cost.amount, cost.currency, cost.amountUsd, cost.fxRate, cost.fxSource, cost.fxAt,
      cost.eurUsdRate, cost.eurUsdDate, cost.recurring, cost.recurringUntil, cost.attachmentUrl, actor.email],
  );
  return costFromRow(rows[0]);
}

export async function updateCost(client, id, cost, actor) {
  const { rows } = await client.query(
    `update public.finance_costs
        set incurred_on = $2, category = $3, vendor = $4, description = $5, amount = $6, currency = $7, amount_usd = $8,
            fx_rate = $9, fx_source = $10, fx_at = $11, eur_usd_rate = $12, eur_usd_date = $13, recurring = $14,
            recurring_until = $15, attachment_url = $16, updated_by = $17, updated_at = now()
      where id = $1 and deleted_at is null
      returning ${COST_COLUMNS}`,
    [id, cost.incurredOn, cost.category, cost.vendor, cost.description, cost.amount, cost.currency, cost.amountUsd, cost.fxRate, cost.fxSource, cost.fxAt,
      cost.eurUsdRate, cost.eurUsdDate, cost.recurring, cost.recurringUntil, cost.attachmentUrl, actor.email],
  );
  return rows[0] ? costFromRow(rows[0]) : null;
}

export async function softDeleteCost(client, id, actor) {
  const { rows } = await client.query(
    `update public.finance_costs set deleted_at = now(), deleted_by = $2, updated_at = now()
      where id = $1 and deleted_at is null
      returning ${COST_COLUMNS}`,
    [id, actor.email],
  );
  return rows[0] ? costFromRow(rows[0]) : null;
}

function closeFromRow(row) {
  const iso = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
  return {
    month: String(row.month).slice(0, 7),
    status: row.status,
    snapshot: row.snapshot || null,
    closedBy: row.closed_by || null,
    closedAt: iso(row.closed_at),
    reopenedBy: row.reopened_by || null,
    reopenedAt: iso(row.reopened_at),
    reopenReason: row.reopen_reason || null,
  };
}

/** Close rows for months in [fromMonth, toMonth] as a Map month -> row. */
export async function listCloses(db, fromMonth, toMonth) {
  const { rows } = await db.query(
    `select month::text as month, status, snapshot, closed_by, closed_at, reopened_by, reopened_at, reopen_reason
       from public.finance_month_close
      where month >= $1::date and month <= $2::date
      order by month`,
    [`${fromMonth}-01`, `${toMonth}-01`],
  );
  return new Map(rows.map((row) => [String(row.month).slice(0, 7), closeFromRow(row)]));
}

export async function lockClose(client, month) {
  await client.query(`insert into public.finance_month_close (month, status) values ($1::date, 'open') on conflict (month) do nothing`, [`${month}-01`]);
  const { rows } = await client.query(
    `select month::text as month, status, snapshot, closed_by, closed_at, reopened_by, reopened_at, reopen_reason
       from public.finance_month_close where month = $1::date for update`,
    [`${month}-01`],
  );
  return closeFromRow(rows[0]);
}

export async function markClosed(client, month, snapshot, actor) {
  const { rows } = await client.query(
    `update public.finance_month_close
        set status = 'closed', snapshot = $2::jsonb, closed_by = $3, closed_at = now(), updated_at = now()
      where month = $1::date
      returning month::text as month, status, snapshot, closed_by, closed_at, reopened_by, reopened_at, reopen_reason`,
    [`${month}-01`, JSON.stringify(snapshot), actor.email],
  );
  return closeFromRow(rows[0]);
}

export async function markReopened(client, month, reason, actor) {
  const { rows } = await client.query(
    `update public.finance_month_close
        set status = 'open', reopened_by = $2, reopened_at = now(), reopen_reason = $3, updated_at = now()
      where month = $1::date
      returning month::text as month, status, snapshot, closed_by, closed_at, reopened_by, reopened_at, reopen_reason`,
    [`${month}-01`, actor.email, reason],
  );
  return closeFromRow(rows[0]);
}

/** The last changes to one setting ('settings.distribution' / 'settings.tax_reserve_rules'), newest first. */
export async function listSettingsHistory(db, action, limit = 20) {
  const { rows } = await db.query(
    `select occurred_at, actor_email, before, after
       from public.finance_audit_log
      where action = $1
      order by occurred_at desc, id desc
      limit $2`,
    [action, limit],
  );
  return rows.map((row) => ({
    at: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at),
    by: row.actor_email,
    before: row.before ?? null,
    after: row.after ?? null,
  }));
}

export async function readSettings(db) {
  try {
    const { rows } = await db.query(`select tax_reserve_rules, distribution, tax_rules, updated_by, updated_at from public.finance_settings where id = 1`);
    return rows[0] || null;
  } catch (error) {
    // tax_rules arrives with DISTRIBUTIONS_MIGRATION; before that, read the rest.
    if (error?.code !== "42703") throw error;
    const { rows } = await db.query(`select tax_reserve_rules, distribution, updated_by, updated_at from public.finance_settings where id = 1`);
    return { ...(rows[0] || {}), tax_rules: null, taxRulesColumnMissing: true };
  }
}

/** column: 'tax_reserve_rules' | 'distribution' | 'tax_rules' | 'entity'. Returns the previous value. */
export async function saveSetting(client, column, value, actor) {
  if (column !== "tax_reserve_rules" && column !== "distribution" && column !== "tax_rules" && column !== "entity") throw new Error("Unknown finance setting.");
  await client.query(`insert into public.finance_settings (id) values (1) on conflict (id) do nothing`);
  const { rows } = await client.query(`select ${column} as value from public.finance_settings where id = 1 for update`);
  const before = rows[0]?.value ?? null;
  await client.query(`update public.finance_settings set ${column} = $1::jsonb, updated_by = $2, updated_at = now() where id = 1`, [JSON.stringify(value), actor.email]);
  return before;
}

// ------------------------------------------------------------ distributions

const DIST_COLUMNS = `id, week, status, available_on::text as available_on, usd_per_eur::text as usd_per_eur,
  total_gross_eur::text as total_gross_eur, total_withholding_eur::text as total_withholding_eur, total_net_eur::text as total_net_eur,
  total_gross_usd::text as total_gross_usd, total_net_usd::text as total_net_usd, shares, per_chain, tx_hashes, checklist,
  dividend_tax_due_on::text as dividend_tax_due_on, dividend_tax_return_filed_on::text as dividend_tax_return_filed_on,
  dividend_tax_paid_on::text as dividend_tax_paid_on, note, decided_by, decided_at, created_by, created_at, updated_by, updated_at`;

function distributionFromRow(row) {
  const iso = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
  const num = (v) => (v == null ? null : Number(v));
  return {
    id: String(row.id),
    week: row.week,
    status: row.status,
    availableOn: row.available_on || null,
    usdPerEur: num(row.usd_per_eur),
    totalGrossEur: num(row.total_gross_eur),
    totalWithholdingEur: num(row.total_withholding_eur),
    totalNetEur: num(row.total_net_eur),
    totalGrossUsd: num(row.total_gross_usd),
    totalNetUsd: num(row.total_net_usd),
    shares: row.shares || [],
    perChain: row.per_chain || [],
    txHashes: row.tx_hashes || {},
    checklist: row.checklist || {},
    dividendTaxDueOn: row.dividend_tax_due_on || null,
    dividendTaxReturnFiledOn: row.dividend_tax_return_filed_on || null,
    dividendTaxPaidOn: row.dividend_tax_paid_on || null,
    note: row.note || "",
    decidedBy: row.decided_by || null,
    decidedAt: iso(row.decided_at),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedBy: row.updated_by || null,
    updatedAt: iso(row.updated_at),
  };
}

export async function listDistributions(db, { limit = 200 } = {}) {
  const { rows } = await db.query(`select ${DIST_COLUMNS} from public.finance_distributions order by week desc, id desc limit $1`, [limit]);
  return rows.map(distributionFromRow);
}

export async function getDistribution(db, id, { forUpdate = false } = {}) {
  const { rows } = await db.query(`select ${DIST_COLUMNS} from public.finance_distributions where id = $1${forUpdate ? " for update" : ""}`, [id]);
  return rows[0] ? distributionFromRow(rows[0]) : null;
}

export async function insertDistribution(client, rec, actor) {
  const { rows } = await client.query(
    `insert into public.finance_distributions
       (week, status, available_on, usd_per_eur, total_gross_eur, total_withholding_eur, total_net_eur, total_gross_usd, total_net_usd,
        shares, per_chain, tx_hashes, checklist, dividend_tax_due_on, note, created_by, updated_by)
     values ($1, 'proposed', $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, '{}'::jsonb, $11::jsonb, $12, $13, $14, $14)
     returning ${DIST_COLUMNS}`,
    [rec.week, rec.availableOn, rec.usdPerEur, rec.totalGrossEur, rec.totalWithholdingEur, rec.totalNetEur, rec.totalGrossUsd, rec.totalNetUsd,
      JSON.stringify(rec.shares), JSON.stringify(rec.perChain), JSON.stringify(rec.checklist || {}), rec.dividendTaxDueOn, rec.note || "", actor.email],
  );
  return distributionFromRow(rows[0]);
}

export async function updateDistribution(client, id, next, actor) {
  const { rows } = await client.query(
    `update public.finance_distributions
        set status = $2, available_on = $3, tx_hashes = $4::jsonb, checklist = $5::jsonb, dividend_tax_due_on = $6,
            dividend_tax_return_filed_on = $7, dividend_tax_paid_on = $8, note = $9,
            decided_by = $10, decided_at = $11, updated_by = $12, updated_at = now()
      where id = $1
      returning ${DIST_COLUMNS}`,
    [id, next.status, next.availableOn, JSON.stringify(next.txHashes || {}), JSON.stringify(next.checklist || {}), next.dividendTaxDueOn,
      next.dividendTaxReturnFiledOn, next.dividendTaxPaidOn, next.note || "", next.decidedBy, next.decidedAt, actor.email],
  );
  return rows[0] ? distributionFromRow(rows[0]) : null;
}
