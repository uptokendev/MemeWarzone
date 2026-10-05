// Database access for finance_accounts, finance_treasury_movements and
// finance_tax_items (db/migrations/20261005_000002_finance_treasury_tax.sql).
// Writes run inside the caller's transaction (withTransaction from
// financeAccountingStore.js) together with their finance_audit_log row. Until
// the migration is applied reads fail with 42P01: the handler treats that as
// "nothing recorded yet" for the weekly view and answers 503 on writes.

export const TREASURY_MIGRATION = "db/migrations/20261005_000002_finance_treasury_tax.sql";

export function treasuryTablesMissing(error) {
  return error?.code === "42P01" || error?.code === "42703"
    || (error?.code === "23514" && /finance_audit_log_(action|entity)_chk/.test(String(error?.constraint || error?.message || "")));
}

const iso = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
const dateOnly = (v) => (v == null ? null : String(v).slice(0, 10));
const decimalOut = (v) => {
  if (v == null) return null;
  const t = String(v);
  return t.includes(".") ? t.replace(/0+$/, "").replace(/\.$/, "") : t;
};
const num = (v) => (v == null ? null : Number(v));

// ------------------------------------------------------------------ accounts

const ACCOUNT_COLUMNS = `id, name, kind, chain_id, address, iban_masked, currency, note, archived_at, created_by, created_at, updated_by, updated_at`;

export function accountFromRow(row) {
  return {
    id: String(row.id),
    name: row.name,
    kind: row.kind,
    chainId: row.chain_id == null ? null : Number(row.chain_id),
    address: row.address || null,
    ibanMasked: row.iban_masked || null,
    currency: row.currency,
    note: row.note || "",
    archivedAt: iso(row.archived_at),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedBy: row.updated_by || null,
    updatedAt: iso(row.updated_at),
  };
}

export async function listAccounts(db) {
  const { rows } = await db.query(`select ${ACCOUNT_COLUMNS} from public.finance_accounts order by archived_at nulls first, kind, name limit 500`);
  return rows.map(accountFromRow);
}

export async function getAccount(db, id, { forUpdate = false } = {}) {
  const { rows } = await db.query(`select ${ACCOUNT_COLUMNS} from public.finance_accounts where id = $1${forUpdate ? " for update" : ""}`, [id]);
  return rows[0] ? accountFromRow(rows[0]) : null;
}

export async function insertAccount(client, a, actor) {
  const { rows } = await client.query(
    `insert into public.finance_accounts (name, kind, chain_id, address, iban_masked, currency, note, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $8)
     returning ${ACCOUNT_COLUMNS}`,
    [a.name, a.kind, a.chainId, a.address, a.ibanMasked, a.currency, a.note || "", actor.email],
  );
  return accountFromRow(rows[0]);
}

export async function updateAccount(client, id, a, actor) {
  const { rows } = await client.query(
    `update public.finance_accounts
        set name = $2, iban_masked = $3, currency = $4, note = $5, archived_at = $6, updated_by = $7, updated_at = now()
      where id = $1
      returning ${ACCOUNT_COLUMNS}`,
    [id, a.name, a.ibanMasked, a.currency, a.note || "", a.archivedAt, actor.email],
  );
  return rows[0] ? accountFromRow(rows[0]) : null;
}

// ------------------------------------------------------------------ movements

const MOVEMENT_COLUMNS = `id, occurred_at, kind, from_account_id, to_account_id, asset_out, amount_out::text as amount_out, asset_in,
  amount_in::text as amount_in, value_eur::text as value_eur, value_source, usd_per_eur::text as usd_per_eur, price_usd::text as price_usd,
  fee_asset, fee_amount::text as fee_amount, fee_eur::text as fee_eur, fee_source, cost_id, revenue_lane, tx_hash, reference, note,
  created_by, created_at, updated_by, updated_at, deleted_by, deleted_at`;

export function movementFromRow(row) {
  return {
    id: String(row.id),
    occurredAt: iso(row.occurred_at),
    kind: row.kind,
    fromAccountId: row.from_account_id == null ? null : String(row.from_account_id),
    toAccountId: row.to_account_id == null ? null : String(row.to_account_id),
    out: row.asset_out ? { asset: row.asset_out, amount: decimalOut(row.amount_out) } : null,
    in: row.asset_in ? { asset: row.asset_in, amount: decimalOut(row.amount_in) } : null,
    valueEur: num(row.value_eur),
    valueSource: row.value_source,
    usdPerEur: num(row.usd_per_eur),
    priceUsd: num(row.price_usd),
    fee: row.fee_asset ? { asset: row.fee_asset, amount: decimalOut(row.fee_amount) } : null,
    feeEur: num(row.fee_eur),
    feeSource: row.fee_source || null,
    costId: row.cost_id == null ? null : String(row.cost_id),
    revenueLane: row.revenue_lane || null,
    txHash: row.tx_hash || null,
    reference: row.reference || "",
    note: row.note || "",
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedBy: row.updated_by || null,
    updatedAt: iso(row.updated_at),
    deletedBy: row.deleted_by || null,
    deletedAt: iso(row.deleted_at),
  };
}

export async function listMovements(db, { includeDeleted = false } = {}) {
  const { rows } = await db.query(
    `select ${MOVEMENT_COLUMNS} from public.finance_treasury_movements
      ${includeDeleted ? "" : "where deleted_at is null"}
      order by occurred_at desc, id desc
      limit 5000`,
  );
  return rows.map(movementFromRow);
}

export async function getMovement(db, id, { forUpdate = false } = {}) {
  const { rows } = await db.query(`select ${MOVEMENT_COLUMNS} from public.finance_treasury_movements where id = $1${forUpdate ? " for update" : ""}`, [id]);
  return rows[0] ? movementFromRow(rows[0]) : null;
}

function movementParams(m) {
  return [m.occurredAt, m.kind, m.fromAccountId, m.toAccountId, m.out?.asset ?? null, m.out?.amount ?? null, m.in?.asset ?? null, m.in?.amount ?? null,
    m.valueEur, m.valueSource, m.usdPerEur ?? null, m.priceUsd ?? null, m.fee?.asset ?? null, m.fee?.amount ?? null, m.fee ? m.feeEur : null, m.fee ? m.feeSource : null,
    m.costId, m.revenueLane, m.txHash, m.reference || "", m.note || ""];
}

export async function insertMovement(client, m, actor) {
  const { rows } = await client.query(
    `insert into public.finance_treasury_movements
       (occurred_at, kind, from_account_id, to_account_id, asset_out, amount_out, asset_in, amount_in, value_eur, value_source, usd_per_eur, price_usd,
        fee_asset, fee_amount, fee_eur, fee_source, cost_id, revenue_lane, tx_hash, reference, note, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $22)
     returning ${MOVEMENT_COLUMNS}`,
    [...movementParams(m), actor.email],
  );
  return movementFromRow(rows[0]);
}

export async function updateMovement(client, id, m, actor) {
  const { rows } = await client.query(
    `update public.finance_treasury_movements
        set occurred_at = $2, kind = $3, from_account_id = $4, to_account_id = $5, asset_out = $6, amount_out = $7, asset_in = $8, amount_in = $9,
            value_eur = $10, value_source = $11, usd_per_eur = $12, price_usd = $13, fee_asset = $14, fee_amount = $15, fee_eur = $16, fee_source = $17,
            cost_id = $18, revenue_lane = $19, tx_hash = $20, reference = $21, note = $22, updated_by = $23, updated_at = now()
      where id = $1 and deleted_at is null
      returning ${MOVEMENT_COLUMNS}`,
    [id, ...movementParams(m), actor.email],
  );
  return rows[0] ? movementFromRow(rows[0]) : null;
}

export async function softDeleteMovement(client, id, actor) {
  const { rows } = await client.query(
    `update public.finance_treasury_movements set deleted_at = now(), deleted_by = $2, updated_at = now()
      where id = $1 and deleted_at is null
      returning ${MOVEMENT_COLUMNS}`,
    [id, actor.email],
  );
  return rows[0] ? movementFromRow(rows[0]) : null;
}

// ------------------------------------------------------------------ tax items

const TAX_COLUMNS = `id, tax_type, period, kind, amount_eur::text as amount_eur, due_on::text as due_on, done_on::text as done_on, account_id,
  distribution_id, reference, note, created_by, created_at, updated_by, updated_at, deleted_by, deleted_at`;

export function taxItemFromRow(row) {
  return {
    id: String(row.id),
    taxType: row.tax_type,
    period: row.period,
    kind: row.kind,
    amountEur: Number(row.amount_eur),
    dueOn: dateOnly(row.due_on),
    doneOn: dateOnly(row.done_on),
    accountId: row.account_id == null ? null : String(row.account_id),
    distributionId: row.distribution_id == null ? null : String(row.distribution_id),
    reference: row.reference || "",
    note: row.note || "",
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedBy: row.updated_by || null,
    updatedAt: iso(row.updated_at),
    deletedBy: row.deleted_by || null,
    deletedAt: iso(row.deleted_at),
  };
}

export async function listTaxItems(db, { includeDeleted = false } = {}) {
  const { rows } = await db.query(
    `select ${TAX_COLUMNS} from public.finance_tax_items
      ${includeDeleted ? "" : "where deleted_at is null"}
      order by done_on desc, id desc
      limit 2000`,
  );
  return rows.map(taxItemFromRow);
}

export async function getTaxItem(db, id, { forUpdate = false } = {}) {
  const { rows } = await db.query(`select ${TAX_COLUMNS} from public.finance_tax_items where id = $1${forUpdate ? " for update" : ""}`, [id]);
  return rows[0] ? taxItemFromRow(rows[0]) : null;
}

function taxParams(t) {
  return [t.taxType, t.period, t.kind, t.amountEur, t.dueOn, t.doneOn, t.accountId, t.distributionId, t.reference || "", t.note || ""];
}

export async function insertTaxItem(client, t, actor) {
  const { rows } = await client.query(
    `insert into public.finance_tax_items (tax_type, period, kind, amount_eur, due_on, done_on, account_id, distribution_id, reference, note, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
     returning ${TAX_COLUMNS}`,
    [...taxParams(t), actor.email],
  );
  return taxItemFromRow(rows[0]);
}

export async function updateTaxItem(client, id, t, actor) {
  const { rows } = await client.query(
    `update public.finance_tax_items
        set tax_type = $2, period = $3, kind = $4, amount_eur = $5, due_on = $6, done_on = $7, account_id = $8, distribution_id = $9,
            reference = $10, note = $11, updated_by = $12, updated_at = now()
      where id = $1 and deleted_at is null
      returning ${TAX_COLUMNS}`,
    [id, ...taxParams(t), actor.email],
  );
  return rows[0] ? taxItemFromRow(rows[0]) : null;
}

export async function softDeleteTaxItem(client, id, actor) {
  const { rows } = await client.query(
    `update public.finance_tax_items set deleted_at = now(), deleted_by = $2, updated_at = now()
      where id = $1 and deleted_at is null
      returning ${TAX_COLUMNS}`,
    [id, actor.email],
  );
  return rows[0] ? taxItemFromRow(rows[0]) : null;
}
