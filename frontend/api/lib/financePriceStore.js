// Database stores for the finance price service (financePrices.js) and the
// ECB EUR/USD source (financeAccountingFx.js):
//
//   finance_price_hourly  Binance 1h closes. A closed hour never changes, so
//                         each hour is fetched from Binance once, ever.
//   finance_snapshots     the last spot per asset (key spot:<ASSET>), so a new
//                         API process has a price before its first Binance read.
//   finance_fx_daily      ECB USD per EUR per business day.
//
// Every read and write is best effort: if the table is missing (migration not
// applied) or the database refuses, the services behave as before (in-process
// caches only). Nothing here signs or moves funds.

const TABLE_RECHECK_MS = 5 * 60_000;
const ASSETS = new Set(["SOL", "BNB", "ETH"]);

function tableMissing(error) {
  return error?.code === "42P01" || error?.code === "42703";
}

/** The API pool, loaded lazily so tests without DATABASE_URL never open one. */
async function defaultDb() {
  try {
    if (!process.env.DATABASE_URL && !globalThis.__memewarzone_pool) return null;
    const { pool } = await import("../../server/db.js");
    return pool;
  } catch {
    return null;
  }
}

function guarded(getDb) {
  let missingUntil = 0;
  return async (fn, fallback) => {
    if (Date.now() < missingUntil) return fallback;
    const db = await getDb();
    if (!db) return fallback;
    try {
      return await fn(db);
    } catch (error) {
      if (tableMissing(error)) missingUntil = Date.now() + TABLE_RECHECK_MS;
      return fallback;
    }
  };
}

/** finance_price_hourly as a history store for createPriceService. */
export function createHourlyPriceStore({ getDb = defaultDb } = {}) {
  const run = guarded(getDb);
  const toMap = (rows) => new Map((rows || []).map((r) => [new Date(r.hour).getTime(), Number(r.close_usd)]).filter(([h, c]) => Number.isFinite(h) && Number.isFinite(c) && c > 0));
  return {
    load: (asset) => (ASSETS.has(asset)
      ? run(async (db) => toMap((await db.query("select hour, close_usd from public.finance_price_hourly where asset = $1", [asset])).rows), new Map())
      : Promise.resolve(new Map())),
    loadHours: (asset, hours) => (ASSETS.has(asset) && hours.length
      ? run(async (db) => toMap((await db.query(
        "select hour, close_usd from public.finance_price_hourly where asset = $1 and hour = any($2::timestamptz[])",
        [asset, hours.map((h) => new Date(h).toISOString())],
      )).rows), new Map())
      : Promise.resolve(new Map())),
    save: (asset, rows) => (ASSETS.has(asset) && rows.length
      ? run(async (db) => {
        for (let i = 0; i < rows.length; i += 1000) {
          const chunk = rows.slice(i, i + 1000);
          await db.query(
            `insert into public.finance_price_hourly (asset, hour, close_usd)
             select $1, h, c from unnest($2::timestamptz[], $3::numeric[]) as t(h, c)
             on conflict (asset, hour) do nothing`,
            [asset, chunk.map((r) => new Date(r.hour).toISOString()), chunk.map((r) => String(r.close))],
          );
        }
      }, undefined)
      : Promise.resolve()),
  };
}

/** The last spot per asset, in finance_snapshots (key spot:<ASSET>). */
export function createSpotStore({ getDb = defaultDb } = {}) {
  const run = guarded(getDb);
  return {
    load: (asset) => run(async (db) => {
      const { rows } = await db.query("select payload from public.finance_snapshots where key = $1", [`spot:${asset}`]);
      const p = rows?.[0]?.payload;
      if (!p?.value || !Number.isFinite(Number(p.readAt))) return null;
      return { value: p.value, readAt: Number(p.readAt) };
    }, null),
    save: (asset, entry) => run(async (db) => {
      await db.query(
        `insert into public.finance_snapshots (key, kind, payload, built_at, build_ms, updated_at)
         values ($1, 'spot', $2::jsonb, to_timestamp($3 / 1000.0), 0, now())
         on conflict (key) do update set payload = excluded.payload, built_at = excluded.built_at, error = null, error_at = null, updated_at = now()`,
        [`spot:${asset}`, JSON.stringify(entry), entry.readAt],
      );
    }, undefined),
  };
}

/** finance_fx_daily as the store of createEurUsdSource: rows newest first plus when they were last fetched. */
export function createFxStore({ getDb = defaultDb } = {}) {
  const run = guarded(getDb);
  return {
    load: () => run(async (db) => {
      const { rows } = await db.query(
        "select to_char(day, 'YYYY-MM-DD') as day, rate, fetched_at from public.finance_fx_daily where pair = 'USD_PER_EUR' order by day desc",
      );
      let fetchedAt = 0;
      const out = [];
      for (const r of rows || []) {
        const rate = Number(r.rate);
        if (!Number.isFinite(rate) || rate <= 0) continue;
        out.push({ date: r.day, usdPerEur: rate });
        const at = new Date(r.fetched_at).getTime();
        if (Number.isFinite(at) && at > fetchedAt) fetchedAt = at;
      }
      return { rows: out, fetchedAt };
    }, null),
    save: (rows) => (rows.length
      ? run(async (db) => {
        await db.query(
          `insert into public.finance_fx_daily (day, pair, rate)
           select d, 'USD_PER_EUR', r from unnest($1::date[], $2::numeric[]) as t(d, r)
           on conflict (pair, day) do update set rate = excluded.rate, fetched_at = now()`,
          [rows.map((r) => r.date), rows.map((r) => String(r.usdPerEur))],
        );
      }, undefined)
      : Promise.resolve()),
  };
}
