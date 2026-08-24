import { pool } from "../server/db.js";
import { badMethod, json, readJson } from "../server/http.js";
import { requireDashboardAdmin } from "./dashboard/_auth.js";

const HOUSE_KEY = "featured_house_ad";

let ensured = false;

async function ensureSettingsTable() {
  if (ensured) return;
  if (!pool) throw new Error("DATABASE_URL is not configured on the API.");

  await pool.query(`
    create table if not exists public.sponsorship_settings (
      key text primary key,
      value jsonb not null default '{}'::jsonb,
      updated_at timestamptz not null default now()
    )
  `);

  await pool.query(`alter table public.sponsorship_settings enable row level security`).catch(() => {});

  await pool.query(
    `insert into public.sponsorship_settings (key, value)
     values ($1, jsonb_build_object('enabled', true))
     on conflict (key) do nothing`,
    [HOUSE_KEY],
  );

  ensured = true;
}

function parseEnabled(value) {
  if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "enabled")) {
    return Boolean(value.enabled);
  }
  if (typeof value === "boolean") return value;
  return true;
}

async function getHouseEnabled() {
  await ensureSettingsTable();
  const result = await pool.query(
    `select value from public.sponsorship_settings where key = $1 limit 1`,
    [HOUSE_KEY],
  );
  return parseEnabled(result.rows[0]?.value);
}

async function setHouseEnabled(enabled) {
  await ensureSettingsTable();
  await pool.query(
    `insert into public.sponsorship_settings (key, value, updated_at)
     values ($1, jsonb_build_object('enabled', $2::boolean), now())
     on conflict (key) do update
       set value = jsonb_build_object('enabled', $2::boolean),
           updated_at = now()`,
    [HOUSE_KEY, Boolean(enabled)],
  );
  return Boolean(enabled);
}

function allowWriteWithoutAdmin(req) {
  const opsKey = String(process.env.DASHBOARD_OPS_KEY || process.env.OPS_READ_KEY || "").trim();
  const provided = String(req.headers["x-ops-key"] || "").trim();
  return Boolean(opsKey && provided && opsKey === provided);
}

export default async function handler(req, res) {
  if (!["GET", "PUT", "POST", "PATCH"].includes(req.method)) return badMethod(res);

  try {
    if (req.method === "GET") {
      const enabled = await getHouseEnabled();
      return json(res, 200, {
        featuredHouseAd: { enabled },
        houseAdEnabled: enabled,
        updatedAt: new Date().toISOString(),
      });
    }

    // Writes: dashboard admin session or shared ops key.
    if (!allowWriteWithoutAdmin(req)) {
      const admin = await requireDashboardAdmin(req, res);
      if (!admin) return;
    }

    const body = await readJson(req);
    if (body?.enabled == null && body?.featuredHouseAd?.enabled == null && body?.houseAdEnabled == null) {
      return json(res, 400, { error: "Body must include enabled: true|false." });
    }
    const enabled = Boolean(
      body.enabled ?? body.houseAdEnabled ?? body.featuredHouseAd?.enabled,
    );
    const next = await setHouseEnabled(enabled);
    return json(res, 200, {
      featuredHouseAd: { enabled: next },
      houseAdEnabled: next,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[api/sponsorship-settings]", error);
    return json(res, 500, {
      error: error?.message || "Failed to load/update sponsorship settings.",
    });
  }
}
