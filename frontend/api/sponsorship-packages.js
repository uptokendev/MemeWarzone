import { pool } from "../server/db.js";
import { badMethod, getQuery, json } from "../server/http.js";

/**
 * Public list of sponsorship duration packages (prices editable by admin in Supabase/dashboard).
 * GET /api/sponsorship-packages              -> packages for every slot (slot_code is null), as before
 * GET /api/sponsorship-packages?slot=<code>  -> that slot's own packages (e.g. home-top-row, CO-21),
 *                                               falling back to the every-slot packages when it has none
 * slot_code is read through to_jsonb so the route keeps working before the column exists.
 */
export function normalizePackageSlot(value) {
  const slot = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(slot) ? slot : "";
}

export async function listPackagesForSlot(db, slot) {
  const result = await db.query(
    `select
       id::text as "id",
       code,
       label,
       duration_days as "durationDays",
       price_usd::float8 as "priceUsd",
       currency,
       active,
       sort_order as "sortOrder",
       notes,
       nullif(lower(to_jsonb(p) ->> 'slot_code'), '') as "slotCode"
     from public.sponsorship_packages p
     where coalesce(active, true) = true
     order by sort_order asc, duration_days asc`,
  );
  const shared = result.rows.filter((row) => !row.slotCode);
  if (!slot) return shared;
  const own = result.rows.filter((row) => row.slotCode === slot);
  return own.length ? own : shared;
}

export default async function handler(req, res) {
  if (req.method !== "GET") return badMethod(res);
  const slot = normalizePackageSlot(getQuery(req).slot);

  try {
    if (!pool) {
      return json(res, 200, {
        items: defaultPackages(),
        source: "defaults",
        updatedAt: new Date().toISOString(),
        warning: "Database unavailable; using default package catalog.",
      });
    }

    const rows = await listPackagesForSlot(pool, slot);

    if (!rows.length) {
      return json(res, 200, {
        items: defaultPackages(),
        source: "defaults",
        updatedAt: new Date().toISOString(),
        warning: "No packages in DB; using defaults. Run database/sponsorship_packages.sql",
      });
    }

    return json(res, 200, {
      items: rows,
      slot: slot || null,
      source: "database",
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[api/sponsorship-packages]", error);
    return json(res, 200, {
      items: defaultPackages(),
      source: "defaults",
      updatedAt: new Date().toISOString(),
      warning: String(error?.message || error),
    });
  }
}

function defaultPackages() {
  return [
    { id: "d3", code: "d3", label: "3 days", durationDays: 3, priceUsd: 49, currency: "USD", active: true, sortOrder: 10 },
    { id: "w1", code: "w1", label: "1 week", durationDays: 7, priceUsd: 99, currency: "USD", active: true, sortOrder: 20 },
    { id: "w2", code: "w2", label: "2 weeks", durationDays: 14, priceUsd: 179, currency: "USD", active: true, sortOrder: 30 },
    { id: "m1", code: "m1", label: "1 month", durationDays: 30, priceUsd: 299, currency: "USD", active: true, sortOrder: 40 },
    { id: "m3", code: "m3", label: "3 months", durationDays: 90, priceUsd: 699, currency: "USD", active: true, sortOrder: 50 },
  ];
}
