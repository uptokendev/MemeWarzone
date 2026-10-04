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
export function createFakeAccountingDb({ installed = true, distributionsInstalled = true } = {}) {
  const state = { costs: [], audit: [], closes: new Map(), settings: null, distributions: [], nextId: 1, queries: [], installed, distributionsInstalled };
  const nowIso = () => new Date().toISOString();
  const costRow = (c) => ({ ...c });

  async function query(sql, params = []) {
    const text = String(sql).replace(/\s+/g, " ").trim();
    state.queries.push(text);
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rows: [] };
    if (!state.installed && /finance_/.test(text)) throw missingTable();

    if (text.startsWith("select (select 1 from public.finance_costs")) return { rows: [{}] };
    if (!state.distributionsInstalled && (/finance_distributions/.test(text) || /\btax_rules\b/.test(text))) throw /finance_distributions/.test(text) ? missingTable() : missingColumn();
    if (!state.distributionsInstalled && text.startsWith("insert into public.finance_audit_log") && /^(settings\.tax_rules|distribution\.)/.test(String(params[2]))) {
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
    if (text.startsWith("insert into public.finance_settings")) {
      state.settings ||= { tax_reserve_rules: null, distribution: null, tax_rules: null, updated_by: null, updated_at: nowIso() };
      return { rows: [] };
    }
    const settingSelect = /^select (tax_reserve_rules|distribution|tax_rules) as value from public.finance_settings/.exec(text);
    if (settingSelect) return { rows: [{ value: state.settings?.[settingSelect[1]] ?? null }] };
    const settingUpdate = /^update public.finance_settings set (tax_reserve_rules|distribution|tax_rules) = \$1::jsonb/.exec(text);
    if (settingUpdate) {
      state.settings[settingUpdate[1]] = JSON.parse(params[0]);
      state.settings.updated_by = params[1];
      return { rows: [] };
    }
    throw new Error(`fake db: unhandled query: ${text.slice(0, 120)}`);
  }

  return { query, state };
}
