// In-memory stand-in for the four accounting tables, matching the SQL in
// lib/financeAccountingStore.js. Test helper only (imported by the tests).

function missingTable() {
  const error = new Error('relation "public.finance_costs" does not exist');
  error.code = "42P01";
  return error;
}

function missingColumn() {
  const error = new Error('column "tax_rules" does not exist');
  error.code = "42703";
  return error;
}

// distributionsInstalled: false = 20261005_000001_finance_distributions.sql not applied yet.
// treasuryInstalled: false = 20261005_000002_finance_treasury_tax.sql not applied yet.
// cryptoCostsInstalled: false = 20261005_000003_finance_crypto_costs.sql not applied yet.
// market: { campaigns: [], curveTrades: [], marketStats: [] } read-only market data.
export function createFakeAccountingDb({ installed = true, distributionsInstalled = true, treasuryInstalled = true, cryptoCostsInstalled = true, market = {} } = {}) {
  const state = { costs: [], audit: [], closes: new Map(), settings: null, distributions: [], accounts: [], movements: [], taxItems: [], nextId: 1, queries: [], installed, distributionsInstalled, treasuryInstalled, cryptoCostsInstalled, market: { campaigns: [], curveTrades: [], marketStats: [], ...market } };
  const nowIso = () => new Date().toISOString();
  const costRow = (c) => ({ ...c });

  async function query(sql, params = []) {
    const text = String(sql).replace(/\s+/g, " ").trim();
    state.queries.push(text);
    // A transaction keeps a copy of the tables; ROLLBACK puts it back.
    if (text === "BEGIN") {
      state.snapshot = structuredClone({ costs: state.costs, audit: state.audit, closes: state.closes, settings: state.settings, distributions: state.distributions, accounts: state.accounts, movements: state.movements, taxItems: state.taxItems, nextId: state.nextId });
      return { rows: [] };
    }
    if (text === "ROLLBACK") {
      if (state.snapshot) Object.assign(state, state.snapshot, { snapshot: null });
      return { rows: [] };
    }
    if (text === "COMMIT") {
      state.snapshot = null;
      return { rows: [] };
    }
    if (!state.installed && /finance_/.test(text)) throw missingTable();

    if (text.startsWith("select (select 1 from public.finance_costs")) return { rows: [{}] };
    if (!state.distributionsInstalled && (/finance_distributions/.test(text) || /\btax_rules\b/.test(text))) throw /finance_distributions/.test(text) ? missingTable() : missingColumn();
    if (!state.distributionsInstalled && text.startsWith("insert into public.finance_audit_log") && /^(settings\.tax_rules|distribution\.)/.test(String(params[2]))) {
      const error = new Error('new row violates check constraint "finance_audit_log_action_chk"');
      error.code = "23514";
      error.constraint = "finance_audit_log_action_chk";
      throw error;
    }

    // read-only market data
    if (text.includes("from public.curve_trades t join public.campaigns c")) {
      const hashes = params[0];
      const rows = state.market.curveTrades.filter((t) => hashes.includes(t.tx_hash)).map((t) => {
        const c = state.market.campaigns.find((x) => x.chain_id === t.chain_id && x.campaign_address === t.campaign_address);
        return c ? { ...t, native_amount: t.bnb_amount, name: c.name, symbol: c.symbol, token_address: c.token_address } : null;
      }).filter(Boolean);
      return { rows };
    }
    if (text.startsWith("select chain_id, campaign_address, token_address, name, symbol, graduated_at_chain from public.campaigns")) {
      const [chainId, address] = params;
      const c = state.market.campaigns.find((x) => (chainId == null || x.chain_id === chainId) && (x.token_address === address || (address.startsWith("0x") && x.token_address.toLowerCase() === address.toLowerCase())));
      return { rows: c ? [{ graduated_at_chain: null, ...c }] : [] };
    }
    if (text.startsWith("select price_bnb::text as price_native, block_time from public.curve_trades")) {
      const [chainId, campaign, at] = params;
      const t = state.market.curveTrades.filter((x) => x.chain_id === chainId && x.campaign_address === campaign && x.block_time <= at && Number(x.price_bnb) > 0).sort((a, b) => (a.block_time < b.block_time ? 1 : -1))[0];
      return { rows: t ? [{ price_native: String(t.price_bnb), block_time: t.block_time }] : [] };
    }
    if (text.startsWith("select last_price_usd::text as last_price_usd")) {
      const [chainId, campaign] = params;
      const m = state.market.marketStats.find((x) => x.chain_id === chainId && x.campaign_address === campaign);
      return { rows: m ? [{ ...m, last_price_usd: String(m.last_price_usd) }] : [] };
    }
    if (!state.cryptoCostsInstalled && (/\basset_address\b/.test(text) || /^select entity from|set entity =|select entity as value/.test(text))) {
      const error = new Error(`column "${/asset_address/.test(text) ? "asset_address" : "entity"}" does not exist`);
      error.code = "42703";
      throw error;
    }
    if (!state.cryptoCostsInstalled && text.startsWith("insert into public.finance_treasury_movements") && params[1] === "crypto_payment") {
      const error = new Error('new row violates check constraint "finance_treasury_movements_kind_chk"');
      error.code = "23514";
      error.constraint = "finance_treasury_movements_kind_chk";
      throw error;
    }
    if (!state.cryptoCostsInstalled && text.startsWith("insert into public.finance_audit_log") && params[2] === "settings.entity") {
      const error = new Error('new row violates check constraint "finance_audit_log_action_chk"');
      error.code = "23514";
      error.constraint = "finance_audit_log_action_chk";
      throw error;
    }

    // treasury: accounts, movements, tax items
    if (/finance_(accounts|treasury_movements|tax_items)/.test(text)) {
      if (!state.treasuryInstalled) throw missingTable();
      return treasuryQuery(text, params);
    }
    if (!state.treasuryInstalled && text.startsWith("insert into public.finance_audit_log") && /^(account|movement|tax_item)\./.test(String(params[2]))) {
      const error = new Error('new row violates check constraint "finance_audit_log_action_chk"');
      error.code = "23514";
      error.constraint = "finance_audit_log_action_chk";
      throw error;
    }

    // distributions
    const distOut = (d) => ({ ...d });
    if (text.startsWith("insert into public.finance_distributions")) {
      const [week, availableOn, usdPerEur, ge, we, ne, gu, nu, shares, perChain, checklist, dueOn, note, by] = params;
      if (state.distributions.some((d) => d.week === week && d.status !== "cancelled")) {
        const error = new Error("duplicate key value violates unique constraint");
        error.code = "23505";
        throw error;
      }
      const row = { id: String(state.nextId++), week, status: "proposed", available_on: availableOn, usd_per_eur: usdPerEur == null ? null : String(usdPerEur), total_gross_eur: String(ge), total_withholding_eur: String(we), total_net_eur: String(ne), total_gross_usd: gu == null ? null : String(gu), total_net_usd: nu == null ? null : String(nu), shares: JSON.parse(shares), per_chain: JSON.parse(perChain), tx_hashes: {}, checklist: JSON.parse(checklist), dividend_tax_due_on: dueOn, dividend_tax_return_filed_on: null, dividend_tax_paid_on: null, note, decided_by: null, decided_at: null, created_by: by, created_at: nowIso(), updated_by: by, updated_at: nowIso() };
      state.distributions.push(row);
      return { rows: [distOut(row)] };
    }
    if (text.startsWith("select id, week, status") && text.includes("where id = $1")) {
      const row = state.distributions.find((d) => d.id === String(params[0]));
      return { rows: row ? [distOut(row)] : [] };
    }
    if (text.startsWith("select id, week, status")) {
      return { rows: [...state.distributions].sort((a, b) => (a.week < b.week ? 1 : -1)).map(distOut) };
    }
    if (text.startsWith("update public.finance_distributions")) {
      const row = state.distributions.find((d) => d.id === String(params[0]));
      if (!row) return { rows: [] };
      const [, status, availableOn, txHashes, checklist, dueOn, filedOn, paidOn, note, decidedBy, decidedAt, by] = params;
      Object.assign(row, { status, available_on: availableOn, tx_hashes: JSON.parse(txHashes), checklist: JSON.parse(checklist), dividend_tax_due_on: dueOn, dividend_tax_return_filed_on: filedOn, dividend_tax_paid_on: paidOn, note, decided_by: decidedBy, decided_at: decidedAt, updated_by: by, updated_at: nowIso() });
      return { rows: [distOut(row)] };
    }

    // costs
    if (text.startsWith("insert into public.finance_costs")) {
      const [incurredOn, category, vendor, description, amount, currency, amountUsd, fxRate, fxSource, fxAt, eurUsdRate, eurUsdDate, recurring, recurringUntil, attachmentUrl, by] = params;
      const row = {
        id: String(state.nextId++), incurred_on: incurredOn, category, vendor, description, amount: String(amount), currency,
        amount_usd: String(amountUsd), fx_rate: String(fxRate), fx_source: fxSource, fx_at: fxAt, eur_usd_rate: eurUsdRate == null ? null : String(eurUsdRate),
        eur_usd_date: eurUsdDate, recurring, recurring_until: recurringUntil, attachment_url: attachmentUrl, created_by: by, created_at: nowIso(),
        updated_by: by, updated_at: nowIso(), deleted_by: null, deleted_at: null,
      };
      state.costs.push(row);
      return { rows: [costRow(row)] };
    }
    if (text.startsWith("select id, incurred_on::text") && text.includes("where id = $1")) {
      const row = state.costs.find((c) => c.id === String(params[0]));
      return { rows: row ? [costRow(row)] : [] };
    }
    if (text.startsWith("select id, incurred_on::text")) {
      const all = text.includes("where deleted_at is null") ? state.costs.filter((c) => !c.deleted_at) : state.costs;
      return { rows: all.map(costRow) };
    }
    if (text.startsWith("update public.finance_costs set incurred_on")) {
      const row = state.costs.find((c) => c.id === String(params[0]) && !c.deleted_at);
      if (!row) return { rows: [] };
      const [, incurredOn, category, vendor, description, amount, currency, amountUsd, fxRate, fxSource, fxAt, eurUsdRate, eurUsdDate, recurring, recurringUntil, attachmentUrl, by] = params;
      Object.assign(row, { incurred_on: incurredOn, category, vendor, description, amount: String(amount), currency, amount_usd: String(amountUsd), fx_rate: String(fxRate), fx_source: fxSource, fx_at: fxAt, eur_usd_rate: eurUsdRate == null ? null : String(eurUsdRate), eur_usd_date: eurUsdDate, recurring, recurring_until: recurringUntil, attachment_url: attachmentUrl, updated_by: by, updated_at: nowIso() });
      return { rows: [costRow(row)] };
    }
    if (text.startsWith("update public.finance_costs set deleted_at")) {
      const row = state.costs.find((c) => c.id === String(params[0]) && !c.deleted_at);
      if (!row) return { rows: [] };
      Object.assign(row, { deleted_at: nowIso(), deleted_by: params[1], updated_at: nowIso() });
      return { rows: [costRow(row)] };
    }

    // audit
    if (text.startsWith("insert into public.finance_audit_log")) {
      const [actorId, actorEmail, action, entityType, entityId, before, after] = params;
      state.audit.push({ actorId, actorEmail, action, entityType, entityId, before: before == null ? null : JSON.parse(before), after: after == null ? null : JSON.parse(after), occurredAt: nowIso() });
      return { rows: [] };
    }
    if (text.startsWith("select occurred_at, actor_email, before, after from public.finance_audit_log")) {
      const rows = state.audit.filter((a) => a.action === params[0]).reverse().slice(0, params[1]);
      return { rows: rows.map((a) => ({ occurred_at: a.occurredAt, actor_email: a.actorEmail, before: a.before, after: a.after })) };
    }

    // close
    const closeOut = (c) => ({ month: c.month, status: c.status, snapshot: c.snapshot, closed_by: c.closedBy, closed_at: c.closedAt, reopened_by: c.reopenedBy, reopened_at: c.reopenedAt, reopen_reason: c.reason });
    if (text.startsWith("select month::text as month") && text.includes("month >= $1::date")) {
      const rows = [...state.closes.values()].filter((c) => c.month >= params[0] && c.month <= params[1]).sort((a, b) => (a.month < b.month ? -1 : 1));
      return { rows: rows.map(closeOut) };
    }
    if (text.startsWith("insert into public.finance_month_close")) {
      if (!state.closes.has(params[0])) state.closes.set(params[0], { month: params[0], status: "open", snapshot: null });
      return { rows: [] };
    }
    if (text.startsWith("select month::text as month") && text.includes("for update")) {
      return { rows: [closeOut(state.closes.get(params[0]))] };
    }
    if (text.startsWith("update public.finance_month_close set status = 'closed'")) {
      const c = state.closes.get(params[0]);
      Object.assign(c, { status: "closed", snapshot: JSON.parse(params[1]), closedBy: params[2], closedAt: nowIso() });
      return { rows: [closeOut(c)] };
    }
    if (text.startsWith("update public.finance_month_close set status = 'open'")) {
      const c = state.closes.get(params[0]);
      Object.assign(c, { status: "open", reopenedBy: params[1], reopenedAt: nowIso(), reason: params[2] });
      return { rows: [closeOut(c)] };
    }

    // settings
    if (text.startsWith("select tax_reserve_rules, distribution")) return { rows: state.settings ? [{ ...state.settings }] : [] };
    if (text.startsWith("select entity from public.finance_settings")) return { rows: state.settings ? [{ entity: state.settings.entity ?? null }] : [] };
    if (text.startsWith("insert into public.finance_settings")) {
      state.settings ||= { tax_reserve_rules: null, distribution: null, tax_rules: null, updated_by: null, updated_at: nowIso() };
      return { rows: [] };
    }
    const settingSelect = /^select (tax_reserve_rules|distribution|tax_rules|entity) as value from public.finance_settings/.exec(text);
    if (settingSelect) return { rows: [{ value: state.settings?.[settingSelect[1]] ?? null }] };
    const settingUpdate = /^update public.finance_settings set (tax_reserve_rules|distribution|tax_rules|entity) = \$1::jsonb/.exec(text);
    if (settingUpdate) {
      state.settings[settingUpdate[1]] = JSON.parse(params[0]);
      state.settings.updated_by = params[1];
      return { rows: [] };
    }
    throw new Error(`fake db: unhandled query: ${text.slice(0, 120)}`);
  }

  function duplicate() {
    const error = new Error("duplicate key value violates unique constraint");
    error.code = "23505";
    return error;
  }

  function treasuryQuery(text, params) {
    const by = (list, id) => list.find((r) => r.id === String(id));
    // accounts
    if (text.startsWith("insert into public.finance_accounts")) {
      const [name, kind, chainId, address, iban, currency, note, actor] = params;
      if (state.accounts.some((a) => !a.archived_at && (a.name.toLowerCase() === name.toLowerCase() || (address && a.chain_id === chainId && a.address?.toLowerCase() === address.toLowerCase())))) throw duplicate();
      const row = { id: String(state.nextId++), name, kind, chain_id: chainId, address, iban_masked: iban, currency, note, archived_at: null, created_by: actor, created_at: nowIso(), updated_by: actor, updated_at: nowIso() };
      state.accounts.push(row);
      return { rows: [{ ...row }] };
    }
    if (text.startsWith("select id, name, kind") && text.includes("where id = $1")) {
      const row = by(state.accounts, params[0]);
      return { rows: row ? [{ ...row }] : [] };
    }
    if (text.startsWith("select id, name, kind")) return { rows: state.accounts.map((a) => ({ ...a })) };
    if (text.startsWith("update public.finance_accounts")) {
      const row = by(state.accounts, params[0]);
      if (!row) return { rows: [] };
      Object.assign(row, { name: params[1], iban_masked: params[2], currency: params[3], note: params[4], archived_at: params[5], updated_by: params[6], updated_at: nowIso() });
      return { rows: [{ ...row }] };
    }
    // movements
    const mvCols = ["occurred_at", "kind", "from_account_id", "to_account_id", "asset_out", "amount_out", "asset_in", "amount_in", "value_eur", "value_source", "usd_per_eur", "price_usd", "fee_asset", "fee_amount", "fee_eur", "fee_source", "cost_id", "revenue_lane", "tx_hash", "reference", "note"];
    const str = (v) => (v == null ? null : String(v));
    const mvFrom = (vals) => Object.fromEntries(mvCols.map((c, i) => [c, ["amount_out", "amount_in", "value_eur", "usd_per_eur", "price_usd", "fee_amount", "fee_eur"].includes(c) ? str(vals[i]) : vals[i]]));
    const txTaken = (row, except = null) => row.tx_hash && state.movements.some((m) => m.id !== except && !m.deleted_at && m.tx_hash && m.tx_hash.toLowerCase() === row.tx_hash.toLowerCase() && String(m.from_account_id || 0) === String(row.from_account_id || 0));
    if (text.startsWith("select asset_address from public.finance_treasury_movements limit 0")) return { rows: [] };
    if (text.startsWith("insert into public.finance_treasury_movements")) {
      const row = { id: String(state.nextId++), ...mvFrom(params), asset_address: params[22] ?? null, created_by: params[21], created_at: nowIso(), updated_by: params[21], updated_at: nowIso(), deleted_by: null, deleted_at: null };
      if (txTaken(row)) throw duplicate();
      state.movements.push(row);
      return { rows: [{ ...row }] };
    }
    if (text.startsWith("select id, occurred_at, kind") && text.includes("where id = $1")) {
      const row = by(state.movements, params[0]);
      return { rows: row ? [{ ...row }] : [] };
    }
    if (text.startsWith("select id, occurred_at, kind")) {
      const list = text.includes("where deleted_at is null") ? state.movements.filter((m) => !m.deleted_at) : state.movements;
      return { rows: [...list].sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1)).map((m) => ({ ...m })) };
    }
    if (text.startsWith("update public.finance_treasury_movements set occurred_at")) {
      const row = by(state.movements, params[0]);
      if (!row || row.deleted_at) return { rows: [] };
      const next = { ...row, ...mvFrom(params.slice(1)), ...(text.includes("asset_address = $24") ? { asset_address: params[23] } : {}), updated_by: params[22], updated_at: nowIso() };
      if (txTaken(next, row.id)) throw duplicate();
      Object.assign(row, next);
      return { rows: [{ ...row }] };
    }
    if (text.startsWith("update public.finance_treasury_movements set deleted_at")) {
      const row = by(state.movements, params[0]);
      if (!row || row.deleted_at) return { rows: [] };
      Object.assign(row, { deleted_at: nowIso(), deleted_by: params[1], updated_at: nowIso() });
      return { rows: [{ ...row }] };
    }
    // tax items
    const taxCols = ["tax_type", "period", "kind", "amount_eur", "due_on", "done_on", "account_id", "distribution_id", "reference", "note"];
    const taxFrom = (vals) => Object.fromEntries(taxCols.map((c, i) => [c, c === "amount_eur" ? String(vals[i]) : vals[i]]));
    if (text.startsWith("insert into public.finance_tax_items")) {
      const row = { id: String(state.nextId++), ...taxFrom(params), created_by: params[10], created_at: nowIso(), updated_by: params[10], updated_at: nowIso(), deleted_by: null, deleted_at: null };
      state.taxItems.push(row);
      return { rows: [{ ...row }] };
    }
    if (text.startsWith("select id, tax_type") && text.includes("where id = $1")) {
      const row = by(state.taxItems, params[0]);
      return { rows: row ? [{ ...row }] : [] };
    }
    if (text.startsWith("select id, tax_type")) {
      const list = text.includes("where deleted_at is null") ? state.taxItems.filter((t) => !t.deleted_at) : state.taxItems;
      return { rows: list.map((t) => ({ ...t })) };
    }
    if (text.startsWith("update public.finance_tax_items set tax_type")) {
      const row = by(state.taxItems, params[0]);
      if (!row || row.deleted_at) return { rows: [] };
      Object.assign(row, taxFrom(params.slice(1)), { updated_by: params[11], updated_at: nowIso() });
      return { rows: [{ ...row }] };
    }
    if (text.startsWith("update public.finance_tax_items set deleted_at")) {
      const row = by(state.taxItems, params[0]);
      if (!row || row.deleted_at) return { rows: [] };
      Object.assign(row, { deleted_at: nowIso(), deleted_by: params[1], updated_at: nowIso() });
      return { rows: [{ ...row }] };
    }
    throw new Error(`fake db: unhandled treasury query: ${text.slice(0, 120)}`);
  }

  return { query, state };
}
