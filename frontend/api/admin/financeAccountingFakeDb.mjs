// In-memory stand-in for the four accounting tables, matching the SQL in
// lib/financeAccountingStore.js. Test helper only (imported by the tests).

function missingTable() {
  const error = new Error('relation "public.finance_costs" does not exist');
  error.code = "42P01";
  return error;
}

export function createFakeAccountingDb({ installed = true } = {}) {
  const state = { costs: [], audit: [], closes: new Map(), settings: null, nextId: 1, queries: [], installed };
  const nowIso = () => new Date().toISOString();
  const costRow = (c) => ({ ...c });

  async function query(sql, params = []) {
    const text = String(sql).replace(/\s+/g, " ").trim();
    state.queries.push(text);
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rows: [] };
    if (!state.installed && /finance_/.test(text)) throw missingTable();

    if (text.startsWith("select (select 1 from public.finance_costs")) return { rows: [{}] };

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
      state.audit.push({ actorId, actorEmail, action, entityType, entityId, before: before == null ? null : JSON.parse(before), after: after == null ? null : JSON.parse(after) });
      return { rows: [] };
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
      state.settings ||= { tax_reserve_rules: null, distribution: null, updated_by: null, updated_at: nowIso() };
      return { rows: [] };
    }
    const settingSelect = /^select (tax_reserve_rules|distribution) as value from public.finance_settings/.exec(text);
    if (settingSelect) return { rows: [{ value: state.settings?.[settingSelect[1]] ?? null }] };
    const settingUpdate = /^update public.finance_settings set (tax_reserve_rules|distribution) = \$1::jsonb/.exec(text);
    if (settingUpdate) {
      state.settings[settingUpdate[1]] = JSON.parse(params[0]);
      state.settings.updated_by = params[1];
      return { rows: [] };
    }
    throw new Error(`fake db: unhandled query: ${text.slice(0, 120)}`);
  }

  return { query, state };
}
