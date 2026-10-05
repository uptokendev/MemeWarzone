// Database access for finance_accounts, finance_treasury_movements and
// finance_tax_items (db/migrations/20261005_000002_finance_treasury_tax.sql).
// Writes run inside the caller's transaction (withTransaction from
// financeAccountingStore.js) together with their finance_audit_log row. Until
// the migration is applied reads fail with 42P01: the handler treats that as
// "nothing recorded yet" for the weekly view and answers 503 on writes.

export const TREASURY_MIGRATION = "db/migrations/20261005_000002_finance_treasury_tax.sql";
// Crypto payments, token legs (asset_address) and the entity setting.
export const CRYPTO_COSTS_MIGRATION = "db/migrations/20261005_000003_finance_crypto_costs.sql";

/** A write that needs CRYPTO_COSTS_MIGRATION (the new kind, the token column or the entity column is not there yet). */
export function cryptoCostsMissing(error) {
  const where = String(error?.constraint || error?.message || "");
  return (error?.code === "42703" && /asset_address|entity/.test(where))
    || (error?.code === "23514" && /finance_treasury_movements_(kind|cost|assets)_chk|finance_audit_log_action_chk/.test(where));
}

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

const LEGACY_MOVEMENT_COLUMNS = `id, occurred_at, kind, from_account_id, to_account_id, asset_out, amount_out::text as amount_out, asset_in,
  amount_in::text as amount_in, value_eur::text as value_eur, value_source, usd_per_eur::text as usd_per_eur, price_usd::text as price_usd,
  fee_asset, fee_amount::text as fee_amount, fee_eur::text as fee_eur, fee_source, cost_id, revenue_lane, tx_hash, reference, note,
  created_by, created_at, updated_by, updated_at, deleted_by, deleted_at`;
const MOVEMENT_COLUMNS = `${LEGACY_MOVEMENT_COLUMNS}, asset_address`;

const CORE = new Set(["EUR", "USD", "SOL", "BNB", "ETH", "USDC", "USDT"]);
// The one leg outside the core assets is the token asset_address belongs to.
const legOut = (asset, amount, address) => (asset ? { asset, amount: decimalOut(amount), ...(address && !CORE.has(asset) ? { address } : {}) } : null);

/**
 * Whether finance_treasury_movements has asset_address (CRYPTO_COSTS_MIGRATION).
 * Run on the pool, never inside a transaction: a failed query would abort it.
 */
export async function movementTokenColumn(db) {
  try {
    await db.query(`select asset_address from public.finance_treasury_movements limit 0`);
    return true;
  } catch (error) {
    if (error?.code === "42703") return false;
    throw error;
  }
}

/**
 * Reads movements with asset_address when the column is there. tokenColumn
 * known (inside a transaction): use it; unknown (on the pool): check first.
 */
async function selectMovements(db, tail, params = [], tokenColumn = undefined) {
  const withToken = tokenColumn === undefined ? await movementTokenColumn(db) : tokenColumn;
  return (await db.query(`select ${withToken ? MOVEMENT_COLUMNS : LEGACY_MOVEMENT_COLUMNS} from public.finance_treasury_movements ${tail}`, params)).rows;
}

export function movementFromRow(row) {
  return {
    id: String(row.id),
    occurredAt: iso(row.occurred_at),
    kind: row.kind,
    fromAccountId: row.from_account_id == null ? null : String(row.from_account_id),
    toAccountId: row.to_account_id == null ? null : String(row.to_account_id),
    out: legOut(row.asset_out, row.amount_out, row.asset_address),
    in: legOut(row.asset_in, row.amount_in, row.asset_address),
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
  const rows = await selectMovements(db, `${includeDeleted ? "" : "where deleted_at is null"}
      order by occurred_at desc, id desc
      limit 5000`);
  return rows.map(movementFromRow);
}

export async function getMovement(db, id, { forUpdate = false, tokenColumn = undefined } = {}) {
  const rows = await selectMovements(db, `where id = $1${forUpdate ? " for update" : ""}`, [id], tokenColumn);
  return rows[0] ? movementFromRow(rows[0]) : null;
}

const tokenAddressOf = (m) => m.out?.address || m.in?.address || null;

function movementParams(m) {
  return [m.occurredAt, m.kind, m.fromAccountId, m.toAccountId, m.out?.asset ?? null, m.out?.amount ?? null, m.in?.asset ?? null, m.in?.amount ?? null,
    m.valueEur, m.valueSource, m.usdPerEur ?? null, m.priceUsd ?? null, m.fee?.asset ?? null, m.fee?.amount ?? null, m.fee ? m.feeEur : null, m.fee ? m.feeSource : null,
    m.costId, m.revenueLane, m.txHash, m.reference || "", m.note || ""];
}

// asset_address is written only when a movement has a token leg (or had one
// before an update), so core-asset movements keep working before
// CRYPTO_COSTS_MIGRATION is applied.
export async function insertMovement(client, m, actor) {
  const token = tokenAddressOf(m);
  const { rows } = await client.query(
    `insert into public.finance_treasury_movements
       (occurred_at, kind, from_account_id, to_account_id, asset_out, amount_out, asset_in, amount_in, value_eur, value_source, usd_per_eur, price_usd,
        fee_asset, fee_amount, fee_eur, fee_source, cost_id, revenue_lane, tx_hash, reference, note, created_by, updated_by${token ? ", asset_address" : ""})
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $22${token ? ", $23" : ""})
     returning ${token ? MOVEMENT_COLUMNS : LEGACY_MOVEMENT_COLUMNS}`,
    [...movementParams(m), actor.email, ...(token ? [token] : [])],
  );
  return movementFromRow(rows[0]);
}

export async function updateMovement(client, id, m, actor, { hadToken = false } = {}) {
  const token = tokenAddressOf(m);
  const withToken = Boolean(token) || hadToken;
  const { rows } = await client.query(
    `update public.finance_treasury_movements
        set occurred_at = $2, kind = $3, from_account_id = $4, to_account_id = $5, asset_out = $6, amount_out = $7, asset_in = $8, amount_in = $9,
            value_eur = $10, value_source = $11, usd_per_eur = $12, price_usd = $13, fee_asset = $14, fee_amount = $15, fee_eur = $16, fee_source = $17,
            cost_id = $18, revenue_lane = $19, tx_hash = $20, reference = $21, note = $22, updated_by = $23, updated_at = now()${withToken ? ", asset_address = $24" : ""}
      where id = $1 and deleted_at is null
      returning ${withToken ? MOVEMENT_COLUMNS : LEGACY_MOVEMENT_COLUMNS}`,
    [id, ...movementParams(m), actor.email, ...(withToken ? [token] : [])],
  );
  return rows[0] ? movementFromRow(rows[0]) : null;
}

export async function softDeleteMovement(client, id, actor, { tokenColumn = false } = {}) {
  const { rows } = await client.query(
    `update public.finance_treasury_movements set deleted_at = now(), deleted_by = $2, updated_at = now()
      where id = $1 and deleted_at is null
      returning ${tokenColumn ? MOVEMENT_COLUMNS : LEGACY_MOVEMENT_COLUMNS}`,
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

// ------------------------------------------------------------------ market data (read only)

const WSOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Our curve trades for the given transaction hashes (any chain), with the
 * coin's name, symbol and token address: which coin a wallet bought or sold
 * through the launchpad in that transaction.
 */
export async function curveTradesByTx(db, hashes) {
  const list = [...new Set(hashes.filter(Boolean))].slice(0, 500);
  if (!list.length) return new Map();
  const { rows } = await db.query(
    `select t.chain_id, t.campaign_address, t.tx_hash, t.side, t.wallet, t.token_amount::text as token_amount, t.bnb_amount::text as native_amount,
            t.block_time, c.name, c.symbol, c.token_address
       from public.curve_trades t
       join public.campaigns c on c.chain_id = t.chain_id and c.campaign_address = t.campaign_address
      where t.tx_hash = any($1::text[])
      order by t.block_time, t.log_index`,
    [[...new Set([...list, ...list.map((h) => h.toLowerCase())])]],
  );
  const out = new Map();
  for (const r of rows) {
    const key = String(r.chain_id) === "101" ? r.tx_hash : String(r.tx_hash).toLowerCase();
    out.set(key, [...(out.get(key) || []), {
      chainId: Number(r.chain_id), campaignAddress: r.campaign_address, side: r.side, wallet: r.wallet, tokenAmount: decimalOut(r.token_amount),
      nativeAmount: decimalOut(r.native_amount), at: iso(r.block_time), name: r.name || null, symbol: r.symbol || null, tokenAddress: r.token_address || null,
    }]);
  }
  return out;
}

/** Our platform coin with this token address (on this chain, or any chain when chainId is null), or null. */
export async function platformCoin(db, { chainId = null, address }) {
  const { rows } = await db.query(
    `select chain_id, campaign_address, token_address, name, symbol, graduated_at_chain
       from public.campaigns
      where ($1::integer is null or chain_id = $1) and (token_address = $2 or (left($2, 2) = '0x' and lower(token_address) = lower($2)))
      order by chain_id
      limit 1`,
    [chainId, address],
  );
  const r = rows[0];
  return r ? { chainId: Number(r.chain_id), campaignAddress: r.campaign_address, tokenAddress: r.token_address, name: r.name || null, symbol: r.symbol || null, graduatedAt: iso(r.graduated_at_chain) } : null;
}

/**
 * Price inputs for a token at a time (read only): the last curve trade at or
 * before `at` (price in the chain's native coin per token), when the coin had
 * not graduated by then, and the market_stats row (latest price in USD).
 */
export async function tokenMarketData(db, { chainId, address, at }) {
  const coin = await platformCoin(db, { chainId, address });
  if (!coin) return { coin: null, trade: null, stats: null };
  const before = at && (!coin.graduatedAt || coin.graduatedAt > at);
  const [trade, stats] = await Promise.all([
    before ? db.query(
      `select price_bnb::text as price_native, block_time from public.curve_trades
        where chain_id = $1 and campaign_address = $2 and block_time <= $3 and price_bnb > 0 and (quote_mint is null or quote_mint = $4)
        order by block_time desc, log_index desc limit 1`,
      [coin.chainId, coin.campaignAddress, at, WSOL_MINT],
    ).then((r) => r.rows[0] || null) : null,
    db.query(
      `select last_price_usd::text as last_price_usd, valuation_source, valuation_healthy, updated_at
         from public.market_stats where chain_id = $1 and campaign_address = $2 limit 1`,
      [coin.chainId, coin.campaignAddress],
    ).then((r) => r.rows[0] || null),
  ]);
  return {
    coin,
    trade: trade ? { priceNative: Number(trade.price_native), at: iso(trade.block_time) } : null,
    stats: stats && stats.last_price_usd != null && stats.valuation_healthy !== false ? { priceUsd: Number(stats.last_price_usd), source: stats.valuation_source || "market_stats", at: iso(stats.updated_at) } : null,
  };
}

// ------------------------------------------------------------------ entity setting

/** finance_settings.entity; columnMissing before CRYPTO_COSTS_MIGRATION. */
export async function readEntitySetting(db) {
  try {
    const { rows } = await db.query(`select entity from public.finance_settings where id = 1`);
    return { value: rows[0]?.entity ?? null, columnMissing: false };
  } catch (error) {
    if (error?.code === "42703") return { value: null, columnMissing: true };
    if (error?.code === "42P01") return { value: null, columnMissing: true };
    throw error;
  }
}
