import pg from "pg";

const { Pool } = pg;

function redact(value, keepStart = 6, keepEnd = 4) {
  const s = String(value ?? "");
  if (!s) return "";
  if (s.length <= keepStart + keepEnd) return "*".repeat(s.length);
  return `${s.slice(0, keepStart)}…${s.slice(-keepEnd)}`;
}

function safeError(e) {
  return {
    name: e?.name || "Error",
    message: String(e?.message || e),
    code: e?.code,
    detail: e?.detail,
    where: e?.where,
    hint: e?.hint,
  };
}

function b64urlToUtf8(input) {
  const s = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  return Buffer.from(s + pad, "base64").toString("utf8");
}

function decodeJwtUnsafe(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return { looksJwt: false };
    const payload = JSON.parse(b64urlToUtf8(parts[1]));
    const issHost = payload?.iss ? (() => { try { return new URL(payload.iss).host; } catch { return null; } })() : null;
    return {
      looksJwt: true,
      role: payload?.role || payload?.user_role || null,
      iss: payload?.iss || null,
      issHost,
      exp: payload?.exp || null,
      iat: payload?.iat || null,
    };
  } catch {
    return { looksJwt: false };
  }
}

function loadOptionalCaPem() {
  // Optional escape hatch: allow providing a custom CA PEM via env.
  // Supabase uses a public CA-signed certificate; you typically do NOT need this.
  const b64 = process.env.PG_CA_CERT_B64;
  if (b64) {
    const pem = Buffer.from(b64, "base64").toString("utf8");
    if (pem.includes("BEGIN CERTIFICATE")) return pem;
    throw new Error("PG_CA_CERT_B64 does not decode to a PEM certificate");
  }

  const pem = process.env.PG_CA_CERT;
  if (pem) return pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;

  return null;
}

function parseDbUrl(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    user: u.username,
    password: u.password,
    database: (u.pathname || "").replace(/^\//, "") || "postgres",
  };
}

function normalizeHttpUrl(input) {
  const s = String(input || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  return "https://" + s;
}

async function checkTelemetry() {
  // Prefer dedicated telemetry status; fall back to indexer /health so dashboards
  // are not stuck on SKIPPED when only RAILWAY_INDEXER_URL is configured.
  const explicit = String(process.env.TELEMETRY_STATUS_URL || "").trim();
  const indexerBase = normalizeHttpUrl(
    process.env.RAILWAY_INDEXER_URL || process.env.VITE_SECURITY_API_BASE || "",
  ).replace(/\/+$/, "");
  const url =
    explicit ||
    (indexerBase ? `${indexerBase.replace(/\/api$/i, "")}/health` : "");

  if (!url) {
    return {
      ok: false,
      skipped: true,
      error: {
        message:
          "Missing TELEMETRY_STATUS_URL (or RAILWAY_INDEXER_URL for /health fallback)",
      },
    };
  }

  try {
    const r = await fetchJson(url);
    if (!r.ok) {
      return {
        ok: false,
        latencyMs: r.latencyMs,
        httpStatus: r.status,
        url,
        error: { message: "Telemetry/indexer health non-200", detail: r.json || r.text },
      };
    }

    const svc = r.json?.services?.["realtime-indexer"] || null;
    if (svc) {
      return {
        ok: true,
        latencyMs: r.latencyMs,
        httpStatus: r.status,
        url,
        indexer: {
          ok: !!svc.ok,
          rps_1m: svc.rps_1m,
          errors_1m: svc.errors_1m,
          head_block: svc.head_block,
          last_indexed_block: svc.last_indexed_block,
          lag_blocks: svc.lag_blocks,
          last_indexer_run_ms_ago: svc.last_indexer_run_ms_ago,
          mem_mb: svc.mem_mb,
        },
      };
    }

    // Indexer /health shape: { ok, db, indexerBuild, ... }
    if (r.json && (r.json.ok === true || r.json.db != null || r.json.indexerBuild)) {
      return {
        ok: true,
        latencyMs: r.latencyMs,
        httpStatus: r.status,
        url,
        note: "Using indexer /health (TELEMETRY_STATUS_URL not set)",
        indexer: {
          ok: r.json.ok !== false,
          indexerBuild: r.json.indexerBuild ?? null,
          normalScope: r.json.normalScope ?? null,
          db: r.json.db ?? null,
        },
      };
    }

    return {
      ok: false,
      latencyMs: r.latencyMs,
      httpStatus: r.status,
      url,
      error: { message: "No realtime-indexer telemetry payload and body is not a known /health shape" },
    };
  } catch (e) {
    return { ok: false, error: safeError(e) };
  }
}

async function checkRpcHeadBlock() {
  const candidates = [
    ...String(process.env.BSC_RPC_HTTP_97 || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    ...String(process.env.BSC_RPC_HTTP || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    "https://data-seed-prebsc-1-s1.binance.org:8545/",
  ];
  // de-dupe
  const urls = [...new Set(candidates)];
  if (!urls.length) {
    return { ok: false, skipped: true, error: { message: "No RPC candidates for chain 97" } };
  }

  const body = { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] };
  const errors = [];
  for (const url of urls) {
    const t0 = Date.now();
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      const latencyMs = Date.now() - t0;
      if (!resp.ok) {
        errors.push({ url, latencyMs, httpStatus: resp.status });
        continue;
      }
      const j = await resp.json();
      const hex = j?.result;
      if (typeof hex !== "string" || !hex.startsWith("0x")) {
        errors.push({ url, latencyMs, httpStatus: resp.status, error: "bad result" });
        continue;
      }
      const head = parseInt(hex, 16);
      return {
        ok: true,
        latencyMs,
        httpStatus: resp.status,
        url,
        head_block: head,
        tried: urls.length,
      };
    } catch (e) {
      errors.push({ url, latencyMs: Date.now() - t0, error: safeError(e) });
    }
  }

  return {
    ok: false,
    error: { message: "All RPC candidates failed for eth_blockNumber", detail: errors.slice(0, 4) },
    tried: urls.length,
  };
}

async function checkAblyRestAuth() {
  const key = String(process.env.ABLY_API_KEY || "");
  if (!key) return { ok: false, skipped: true, error: { message: "Missing ABLY_API_KEY" } };

  const [name, secret] = key.split(":");
  if (!name || !secret) return { ok: false, error: { message: "ABLY_API_KEY is not in keyName:keySecret format" } };

  const auth = Buffer.from(`${name}:${secret}`).toString("base64");
  const url = "https://rest.ably.io/time"; // safe endpoint
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Basic ${auth}` },
      cache: "no-store",
    });
    const latencyMs = Date.now() - t0;
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}

    // 200 means creds ok; 401 means bad key
    return {
      ok: r.ok,
      latencyMs,
      httpStatus: r.status,
      note: r.ok ? "REST auth OK" : "REST auth failed (check ABLY_API_KEY)",
      body: json || text.slice(0, 200),
    };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, error: safeError(e) };
  }
}

async function pgCheck() {
  const DATABASE_URL = process.env.DATABASE_URL || "";
  if (!DATABASE_URL) {
    return { ok: false, error: { message: "DATABASE_URL is missing on this deployment" } };
  }

  let host = "";
  try {
    host = parseDbUrl(DATABASE_URL).host;
  } catch (e) {
    return { ok: false, error: { message: "DATABASE_URL is not a valid URL", detail: safeError(e) } };
  }

  let ca = null;
  try {
    ca = loadOptionalCaPem();
  } catch (e) {
    return { ok: false, error: { message: "Failed to load CA cert", detail: safeError(e) } };
  }

  const sslDisabled = String(process.env.PG_DISABLE_SSL || "").trim() === "1";
  const allowSelfSigned = String(process.env.PG_SSL_ALLOW_SELF_SIGNED || "").trim() === "1";
  const ssl = sslDisabled
    ? false
    : ca
      ? { ca, rejectUnauthorized: true, servername: host }
      : allowSelfSigned
        ? { rejectUnauthorized: false, servername: host }
        : { rejectUnauthorized: true, servername: host };

  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl,
    max: 1,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });

  try {
    const t0 = Date.now();
    await pool.query("select 1 as ok");
    const latencyMs = Date.now() - t0;

    // minimal schema checks (these are what your profile/comments features rely on)
    const checks = {};
    const reg1 = await pool.query(`select to_regclass('public.user_profiles') as reg`);
    checks.user_profiles = Boolean(reg1.rows?.[0]?.reg);

    const reg2 = await pool.query(`select to_regclass('public.token_comments') as reg`);
    checks.token_comments = Boolean(reg2.rows?.[0]?.reg);

    const reg3 = await pool.query(`select to_regclass('public.auth_nonces') as reg`);
    checks.auth_nonces = Boolean(reg3.rows?.[0]?.reg);

    if (checks.auth_nonces) {
      const cols = await pool.query(
        `select column_name
         from information_schema.columns
         where table_schema='public' and table_name='auth_nonces'`
      );
      const names = new Set((cols.rows || []).map((r) => String(r.column_name)));
      checks.auth_nonces_used_at = names.has("used_at");
      checks.auth_nonces_expires_at = names.has("expires_at");
      checks.auth_nonces_nonce = names.has("nonce");
    }

    return { ok: true, latencyMs, ssl: { hasCa: Boolean(ca), rejectUnauthorized: true }, checks };
  } catch (e) {
    return { ok: false, error: safeError(e), ssl: { hasCa: Boolean(ca) } };
  } finally {
    try { await pool.end(); } catch {}
  }
}

async function fetchJson(url, opts = {}) {
  const t0 = Date.now();
  const r = await fetch(url, { ...opts, cache: "no-store" });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return {
    ok: r.ok,
    status: r.status,
    latencyMs: Date.now() - t0,
    json,
    text: json ? null : text.slice(0, 300),
  };
}

async function checkRailway() {
  const baseRaw = process.env.RAILWAY_INDEXER_URL || "";
  if (!baseRaw) {
    return { ok: false, error: { message: "Missing RAILWAY_INDEXER_URL" } };
  }

  // Accept either:
  // - https://service.up.railway.app
  // - service.up.railway.app
  // - https://service.up.railway.app/health
  const base = normalizeHttpUrl(baseRaw).replace(/\/+$/, "");
  const url = base.endsWith("/health") ? base : base + "/health";

  try {
    const r = await fetchJson(url);
    const appOk = Boolean(r.json?.ok);
    return {
      ok: r.ok && appOk,
      latencyMs: r.latencyMs,
      url,
      httpStatus: r.status,
      body: r.json || r.text,
      note: baseRaw.startsWith("http") ? "" : "Tip: include https:// in RAILWAY_INDEXER_URL",
    };
  } catch (e) {
    return { ok: false, error: safeError(e), url };
  }
}

async function checkSupabasePublic() {
  // We only validate presence + basic URL sanity here (no secrets required).
  const url = process.env.SUPABASE_URL || "";
  if (!url) return { ok: false, error: { message: "Missing SUPABASE_URL" } };

  // Lightweight reachability: hit Supabase storage public endpoint root (should return 400/404 but reachable)
  const pingUrl = url.replace(/\/+$/, "") + "/rest/v1/";
  try {
    const t0 = Date.now();
    const r = await fetch(pingUrl, { method: "GET", cache: "no-store" });
    const latencyMs = Date.now() - t0;

    // Any response (even 401) confirms reachability from Vercel runtime
    return {
      ok: true,
      latencyMs,
      urlHost: (() => { try { return new URL(url).host; } catch { return "invalid"; } })(),
      pingUrl,
      httpStatus: r.status,
      note: "Reachability only (no service role key used).",
    };
  } catch (e) {
    return { ok: false, error: safeError(e), pingUrl };
  }
}

async function checkSupabaseServiceRole() {
  const baseUrl = process.env.SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const bucket = process.env.SUPABASE_BUCKET || "MemeBattles";

  const supaHost = (() => { try { return new URL(baseUrl).host; } catch { return null; } })();
  const jwt = decodeJwtUnsafe(key);
  const issuerMismatch = Boolean(jwt.looksJwt && jwt.issHost && supaHost && jwt.issHost !== supaHost);

  const jwtInfo = {
    looksJwt: jwt.looksJwt,
    role: jwt.role,
    issHost: jwt.issHost,
    supabaseHost: supaHost,
    issuerMismatch,
  };
  const headers = jwtInfo.looksJwt
  ? { Authorization: `Bearer ${key}`, apikey: key }   // legacy JWT keys
  : { apikey: key }; 

  if (!baseUrl || !key) {
    return {
      ok: false,
      skipped: true,
      error: { message: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (required for /api/upload)" },
      bucket,
      jwt: jwtInfo,
    };
  }

  const url = baseUrl.replace(/\/+$/, "") + "/storage/v1/bucket";

  try {
    const t0 = Date.now();
    const r = await fetch(url, {
  method: "GET",
  headers,
  cache: "no-store",
});
    const latencyMs = Date.now() - t0;

    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}

    if (!r.ok) {
      return {
        ok: false,
        latencyMs,
        httpStatus: r.status,
        error: {
          message: "Supabase Storage API request failed",
          detail: json || text.slice(0, 400),
        },
        bucket,
        url,
        jwt: jwtInfo,              // <-- add here (failure path)
      };
    }

    const buckets = Array.isArray(json) ? json : [];
    const bucketExists = buckets.some((b) => b?.name === bucket);

    return {
      ok: true,
      latencyMs,
      httpStatus: r.status,
      url,
      bucket: { name: bucket, exists: bucketExists, total: buckets.length },
      jwt: jwtInfo,                // <-- add here (success path)
    };
  } catch (e) {
    return {
      ok: false,
      error: safeError(e),
      bucket,
      url,
      jwt: jwtInfo,                // <-- optional but recommended
    };
  }
}


async function checkAblyServerKey() {
  // Ably server key must NOT be exposed to browser; check server-side env only
  const key = process.env.ABLY_API_KEY || "";
  if (!key) return { ok: false, error: { message: "Missing ABLY_API_KEY (server-side)" } };

  // Validate format without revealing it: should contain ":" (keyName:keySecret)
  const looksValid = key.includes(":") && key.length >= 20;
  return {
    ok: looksValid,
    looksValid,
    preview: redact(key, 10, 6),
    note: looksValid
      ? "Server key present and format looks valid."
      : "ABLY_API_KEY present but format does not look like keyName:keySecret.",
  };
}

async function collectSupabaseMetrics() {
  const DATABASE_URL = process.env.DATABASE_URL || "";
  if (!DATABASE_URL) return null;

  const sslDisabled = String(process.env.PG_DISABLE_SSL || "").trim() === "1";
  const allowSelfSigned = String(process.env.PG_SSL_ALLOW_SELF_SIGNED || "").trim() === "1";
  let ca = null;
  try { ca = loadOptionalCaPem(); } catch { return null; }

  let host = "";
  try { host = parseDbUrl(DATABASE_URL).host; } catch { return null; }

  const ssl = sslDisabled
    ? false
    : ca
      ? { ca, rejectUnauthorized: true, servername: host }
      : allowSelfSigned
        ? { rejectUnauthorized: false, servername: host }
        : { rejectUnauthorized: true, servername: host };

  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl,
    max: 1,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });

  try {
    const [sizeRes, rowsRes, connsRes] = await Promise.all([
      pool.query("SELECT pg_database_size(current_database()) AS size"),
      pool.query("SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC"),
      pool.query("SELECT count(*)::int AS count FROM pg_stat_activity"),
    ]);

    const db_size_mb = Math.round((Number(sizeRes.rows[0]?.size) / (1024 * 1024)) * 100) / 100;
    const row_counts = {};
    for (const row of rowsRes.rows) {
      row_counts[row.relname] = Number(row.n_live_tup);
    }
    const active_connections = Number(connsRes.rows[0]?.count) || 0;

    // storage_size_mb deferred — Supabase Storage API doesn't expose total size via bucket listing.
    // Would require iterating all objects. Acceptable to leave null for v1.
    return { db_size_mb, row_counts, active_connections, storage_size_mb: null };
  } catch (e) {
    console.error("[collectSupabaseMetrics]", e?.message);
    return null;
  } finally {
    try { await pool.end(); } catch {}
  }
}

async function collectAblyStats() {
  const key = String(process.env.ABLY_API_KEY || "");
  if (!key || !key.includes(":")) return null;

  const auth = Buffer.from(key).toString("base64");
  const url = "https://rest.ably.io/stats?unit=day&limit=1&direction=backwards";

  try {
    const r = await fetch(url, {
      method: "GET",
      headers: { Authorization: "Basic " + auth },
      cache: "no-store",
    });

    if (!r.ok) {
      console.error("[collectAblyStats] HTTP " + r.status);
      return null;
    }

    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) return null;

    const s = data[0];
    return {
      messages_today: {
        inbound: s?.inbound?.all?.messages?.count ?? 0,
        outbound: s?.outbound?.all?.messages?.count ?? 0,
      },
      peak_connections: s?.connections?.all?.peak ?? 0,
      channels: s?.channels?.peak ?? 0,
      api_requests: s?.apiRequests?.succeeded ?? 0,
    };
  } catch (e) {
    console.error("[collectAblyStats]", e?.message);
    return null;
  }
}

export default async function handler(req, res) {
  try {
    const want = String(process.env.DIAGNOSTICS_TOKEN || "");
    const got = String(req.query?.token || "");

    // Hide endpoint if not authorized
    if (!want || got !== want) {
      return res.status(404).json({ error: "Not found" });
    }


    // Optional UI: /api/diagnostics-ui?token=... is rewritten here as /api/diagnostics?ui=1&token=...
    // We keep it inside this single function to save function slots on Vercel Hobby.
    const ui = String(req.query?.ui || "");
    if (ui === "1") {
      const token = got; // token comes from querystring

      const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>MemeWarzone Diagnostics</title>
  <style>
    :root{
      --bg:#0b1020;
      --panel:#0f1733;
      --panel2:#0c132b;
      --text:#e8ecff;
      --muted:#a9b3da;
      --line:rgba(255,255,255,.08);
      --ok:#22c55e;
      --warn:#f59e0b;
      --bad:#ef4444;
      --info:#60a5fa;
      --chip:#121c3e;
      --shadow: 0 20px 70px rgba(0,0,0,.35);
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono","Courier New", monospace;
      --sans: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
    }
    body{ margin:0; background: radial-gradient(1200px 700px at 20% 0%, rgba(96,165,250,.12), transparent 60%),
                           radial-gradient(900px 600px at 90% 10%, rgba(34,197,94,.10), transparent 55%),
                           var(--bg);
          color:var(--text); font-family:var(--sans); }
    td { word-break: break-word; }
.v, .mono { white-space: normal; }
    .wrap{
  max-width: min(1900px, calc(100vw - 32px));
  margin: 24px auto;
  padding: 0 16px;
}
    header{ display:flex; gap:16px; align-items:flex-start; justify-content:space-between; margin-bottom:18px; }
    h1{ margin:0; font-size:22px; letter-spacing:.2px; }
    .sub{ margin-top:6px; color:var(--muted); font-size:13px; }
    .actions{ display:flex; gap:10px; align-items:center; flex-wrap:wrap; justify-content:flex-end; }
    button{ border:1px solid var(--line); background:linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.02));
            color:var(--text); padding:10px 12px; border-radius:12px; cursor:pointer; box-shadow:0 10px 30px rgba(0,0,0,.25);
            font-size:13px; }
    button:hover{ border-color:rgba(255,255,255,.18); }
    .pill{ display:inline-flex; align-items:center; gap:8px; padding:8px 10px; border:1px solid var(--line);
           background:rgba(255,255,255,.03); border-radius:999px; font-size:12px; color:var(--muted); }
    .dot{ width:8px; height:8px; border-radius:999px; background:var(--muted); }
    .dot.ok{ background:var(--ok); }
    .dot.warn{ background:var(--warn); }
    .dot.bad{ background:var(--bad); }
    .dot.info{ background:var(--info); }

    .grid{ display:grid; grid-template-columns: 1fr 1fr; gap:14px; }
    @media (max-width: 900px){ .grid{ grid-template-columns:1fr; } }

    .card{ background:linear-gradient(180deg, rgba(255,255,255,.04), rgba(255,255,255,.02));
           border:1px solid var(--line); border-radius:18px; box-shadow:var(--shadow); overflow:hidden; }
    .card h2{ margin:0; padding:14px 14px 0 14px; font-size:14px; color:var(--muted); font-weight:600; letter-spacing:.3px; text-transform:uppercase; }
    .card .body{ padding:14px; }

    table{
  width:100%;
  border-collapse:collapse;
  font-size:13px;

  /* NEW: keep columns stable and prevent the “Status” column from collapsing */
  table-layout: fixed;
}

th, td{
  padding:10px 10px;
  border-bottom:1px solid var(--line);
  vertical-align:top;

  /* NEW: allow long text/URLs/JSON to wrap instead of exploding the layout */
  word-break: break-word;
}

th{
  color:var(--muted);
  font-weight:600;
  text-align:left;
  background:rgba(0,0,0,.12);
}

tr:last-child td{ border-bottom:none; }

/* NEW: fixed 3-column widths for all 3-column tables */
th:nth-child(1), td:nth-child(1){ width:28%; }
th:nth-child(2), td:nth-child(2){ width:16%; }
th:nth-child(3), td:nth-child(3){ width:56%; }

/* Keep your existing semantics */
.k{ color:var(--muted); }          /* removed width:44% */
.v{ font-family:var(--mono); }
    .k{ color:var(--muted); width:44%; }
    .v{ font-family:var(--mono); }
    .badge{ display:inline-flex; align-items:center; gap:8px; padding:6px 10px; border-radius:999px; font-size:12px; font-weight:600;
            border:1px solid var(--line); background:rgba(255,255,255,.03); }
    .badge.ok{ color:var(--ok); border-color:rgba(34,197,94,.35); background:rgba(34,197,94,.08); }
    .badge.bad{ color:var(--bad); border-color:rgba(239,68,68,.35); background:rgba(239,68,68,.08); }
    .badge.warn{ color:var(--warn); border-color:rgba(245,158,11,.35); background:rgba(245,158,11,.08); }
    .badge.info{ color:var(--info); border-color:rgba(96,165,250,.35); background:rgba(96,165,250,.08); }

    .muted{ color:var(--muted); }
    .mono{ font-family:var(--mono); }
    pre{
  margin:0;
  padding:12px;
  border-radius:14px;
  border:1px solid var(--line);
  background:rgba(0,0,0,.20);
  color:var(--text);
  overflow:auto;
  font-size:12px;
  line-height:1.5;
  max-height: 520px;
}
    .footer{ margin-top:14px; color:var(--muted); font-size:12px; }
    .row{ display:flex; gap:10px; flex-wrap:wrap; align-items:center; justify-content:space-between; margin-top:8px; }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <h1>MemeWarzone Diagnostics</h1>
        <div class="sub">Readable health view for Supabase Postgres (single DB) and integrations. Token is required via <span class="mono">?token=</span>.</div>
        <div class="row">
          <span id="overall" class="pill"><span class="dot info"></span><span>Loading…</span></span>
          <span class="pill"><span class="dot info"></span><span class="mono" id="ts">—</span></span>
          <span class="pill"><span class="dot info"></span><span class="mono" id="nodeEnv">—</span></span>
        </div>
      </div>
      <div class="actions">
        <button id="refreshBtn">Refresh</button>
        <button id="copyBtn">Copy JSON</button>
      </div>
    </header>

    <div class="grid">
    <div class="card" style="grid-column: 1 / -1;">
  <h2>Readiness</h2>
  <div class="body">
    <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:12px;">
      <span id="corePill" class="pill"><span class="dot info"></span><span>Core: —</span></span>
      <span id="goLivePill" class="pill"><span class="dot info"></span><span>Go-live: —</span></span>
    </div>

    <div class="grid" style="grid-template-columns: 1fr 1fr;">
      <div class="card" style="box-shadow:none;">
        <h2 style="padding-top:0;">Core gates</h2>
        <div class="body" style="padding:0;">
          <table>
            <thead><tr><th>Gate</th><th>Status</th></tr></thead>
            <tbody id="coreGateRows"></tbody>
          </table>
        </div>
      </div>

      <div class="card" style="box-shadow:none;">
        <h2 style="padding-top:0;">Go-live gates</h2>
        <div class="body" style="padding:0;">
          <table>
            <thead><tr><th>Gate</th><th>Status</th></tr></thead>
            <tbody id="goLiveGateRows"></tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="card" style="grid-column: 1 / -1;">
  <h2>Monitoring / Scale signals</h2>
  <div class="body">
    <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:12px;">
      <span id="mRpc" class="pill"><span class="dot info"></span><span>RPC: —</span></span>
      <span id="mDb" class="pill"><span class="dot info"></span><span>DB: —</span></span>
      <span id="mRail" class="pill"><span class="dot info"></span><span>Indexer: —</span></span>
      <span id="mLag" class="pill"><span class="dot info"></span><span>Lag: —</span></span>
      <span id="mAbly" class="pill"><span class="dot info"></span><span>Ably: —</span></span>
    </div>

    <table>
      <thead><tr><th>Signal</th><th>Status</th><th>Action</th></tr></thead>
      <tbody id="monitorRows"></tbody>
    </table>
  </div>
</div>

<div class="card">
  <h2>Vercel Runtime</h2>
  <div class="body">
    <table>
      <thead><tr><th>Item</th><th>Status</th><th>Details</th></tr></thead>
      <tbody id="vercelRows"></tbody>
    </table>
  </div>
</div>

<div class="card">
  <h2>Supabase Postgres (DATABASE_URL)</h2>
  <div class="body">
    <table>
      <thead><tr><th>Check</th><th>Status</th><th>Details</th></tr></thead>
      <tbody id="dbRows"></tbody>
    </table>
  </div>
</div>

<div class="card">
  <h2>Supabase (Token Data)</h2>
  <div class="body">
    <table>
      <thead><tr><th>Check</th><th>Status</th><th>Details</th></tr></thead>
      <tbody id="supabaseRows"></tbody>
    </table>
  </div>
</div>

<div class="card">
  <h2>Railway (Indexer)</h2>
  <div class="body">
    <table>
      <thead><tr><th>Check</th><th>Status</th><th>Details</th></tr></thead>
      <tbody id="railwayRows"></tbody>
    </table>
  </div>
</div>

<div class="card">
  <h2>Ably (Realtime)</h2>
  <div class="body">
    <table>
      <thead><tr><th>Check</th><th>Status</th><th>Details</th></tr></thead>
      <tbody id="ablyRows"></tbody>
    </table>
  </div>
</div>

      <div class="card">
        <h2>Recommendations</h2>
        <div class="body">
          <div id="recs" class="muted">Loading…</div>
        </div>
      </div>

      <div class="card" style="grid-column: 1 / -1;">
        <h2>Environment summary</h2>
        <div class="body">
          <table>
            <thead><tr><th>Key</th><th>Present</th><th>Extra</th></tr></thead>
            <tbody id="envRows"></tbody>
          </table>
        </div>
      </div>

      <div class="card" style="grid-column: 1 / -1;">
        <h2>Raw JSON</h2>
        <div class="body">
          <pre id="raw">Loading…</pre>
          <div class="footer">This page intentionally never displays secrets. If you add more checks, keep them redacted.</div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const TOKEN = ${JSON.stringify(token)};
    let lastJson = null;


    function setPill(id, level, text) {
      const el = document.getElementById(id);
      if (!el) return;
      el.innerHTML = '<span class="dot ' + level + '"></span><span>' + text + '</span>';
    }

    function levelFromLatency(ms, warnMs, badMs) {
      if (!isFinite(ms)) return "info";
      if (ms >= badMs) return "bad";
      if (ms >= warnMs) return "warn";
      return "ok";
    }

    function setMonitoring(j) {
      const rowsEl = document.getElementById("monitorRows");
      if (!rowsEl) return;

      const tel = j?.checks?.telemetry;
      const rpc = j?.checks?.rpc;
      const db = j?.checks?.supabase_postgres;
      const rail = j?.checks?.railway;
      const ablyRest = j?.checks?.ably_rest;

      // Pills
      setPill(
        "mRpc",
        rpc?.ok ? levelFromLatency(rpc.latencyMs, 800, 2000) : (rpc?.skipped ? "warn" : "bad"),
        rpc?.ok ? ("RPC: " + rpc.latencyMs + "ms") : (rpc?.skipped ? "RPC: not configured" : "RPC: FAIL")
      );

      setPill(
        "mDb",
        db?.ok ? levelFromLatency(db.latencyMs, 800, 2000) : "bad",
        db?.ok ? ("DB: " + db.latencyMs + "ms") : "DB: FAIL"
      );

      setPill(
        "mRail",
        rail?.ok ? levelFromLatency(rail.latencyMs, 1200, 3000) : "bad",
        rail?.ok ? ("Indexer: " + rail.latencyMs + "ms") : "Indexer: FAIL"
      );

      const lag = tel?.ok ? Number(tel.indexer?.lag_blocks ?? NaN) : NaN;
      const lagLevel = !isFinite(lag)
        ? (tel?.ok ? "info" : (tel?.skipped ? "warn" : "bad"))
        : lag > 1000 ? "bad" : lag > 200 ? "warn" : "ok";

      setPill(
        "mLag",
        lagLevel,
        isFinite(lag) ? ("Lag: " + lag + " blocks") : (tel?.ok ? "Lag: —" : "Lag: n/a")
      );

      setPill(
        "mAbly",
        ablyRest?.ok ? levelFromLatency(ablyRest.latencyMs, 800, 2000) : (ablyRest?.skipped ? "warn" : "bad"),
        ablyRest?.ok ? ("Ably: " + ablyRest.latencyMs + "ms") : (ablyRest?.skipped ? "Ably: not checked" : "Ably: FAIL")
      );

      // Rows + actions
      const rows = [];

      rows.push([
        "RPC latency / head block",
        rpc?.ok
          ? badge(levelFromLatency(rpc.latencyMs, 800, 2000), "OK")
          : badge(rpc?.skipped ? "warn" : "bad", rpc?.skipped ? "Skipped" : "FAIL"),
        rpc?.ok
          ? ("If latency stays high or timeouts: add better RPC(s) / rotate providers; consider rate limits. Head: <span class='mono'>" + (rpc.head_block ?? "—") + "</span>")
          : "Set <span class='mono'>BSC_RPC_HTTP_97</span> on Vercel to validate RPC independently of the indexer.",
      ]);

      rows.push([
        "Supabase Postgres latency",
        db?.ok ? badge(levelFromLatency(db.latencyMs, 800, 2000), "OK") : badge("bad", "FAIL"),
        db?.ok
          ? "If this trends upward: move to higher Supabase compute tier, reduce query load, add indexes."
          : "DB failing: check DATABASE_URL / SSL / pooler availability.",
      ]);

      rows.push([
        "Indexer health (Railway /health)",
        rail?.ok ? badge(levelFromLatency(rail.latencyMs, 1200, 3000), "OK") : badge("bad", "FAIL"),
        rail?.ok
          ? "If /health latency rises and lag rises: scale Railway CPU/RAM for indexer."
          : "Indexer unhealthy: inspect Railway logs immediately.",
      ]);

      rows.push([
        "Indexer lag (telemetry)",
        tel?.ok
          ? badge(lagLevel, lagLevel === "ok" ? "OK" : lagLevel === "warn" ? "Rising" : "High")
          : badge(tel?.skipped ? "warn" : "bad", tel?.skipped ? "Skipped" : "FAIL"),
        tel?.ok
          ? ("If lag steadily increases: CPU bound or RPC throttled. Scale indexer and/or improve RPC. Errors/1m: <span class='mono'>" + (tel.indexer?.errors_1m ?? "—") + "</span>, mem: <span class='mono'>" + (tel.indexer?.mem_mb ?? "—") + "</span>MB")
          : "Set TELEMETRY_STATUS_URL on Vercel to surface indexer lag/errors/memory.",
      ]);

      rows.push([
        "Ably REST auth",
        ablyRest?.ok
          ? badge(levelFromLatency(ablyRest.latencyMs, 800, 2000), "OK")
          : badge(ablyRest?.skipped ? "warn" : "bad", ablyRest?.skipped ? "Skipped" : "FAIL"),
        ablyRest?.ok
          ? "If FAIL: ABLY_API_KEY invalid or blocked. Fix before launch; realtime will break."
          : "Add/validate ABLY_API_KEY server-side.",
      ]);

      rowsEl.innerHTML = rows
        .map(([k, st, d]) => "<tr><td class='k'>" + k + "</td><td>" + st + "</td><td class='muted'>" + d + "</td></tr>")
        .join("");
    }


    function setReadiness(j) {
  const status = j?.status || {};
  const coreReady = !!status.coreReady;
  const goLiveReady = !!status.goLiveReady;

  const corePill = document.getElementById("corePill");
  const goLivePill = document.getElementById("goLivePill");


  if (corePill) corePill.innerHTML = coreReady
    ? '<span class="dot ok"></span><span>Core: READY</span>'
    : '<span class="dot bad"></span><span>Core: NOT READY</span>';

  if (goLivePill) goLivePill.innerHTML = goLiveReady
    ? '<span class="dot ok"></span><span>Go-live: READY</span>'
    : '<span class="dot warn"></span><span>Go-live: NOT READY</span>';

  const coreRows = document.getElementById("coreGateRows");
  const goRows = document.getElementById("goLiveGateRows");

  const core = status.gates?.core || [];
  const go = status.gates?.goLive || [];

  if (coreRows) coreRows.innerHTML = core.map(g =>
    '<tr><td class="k">' + g.name + '</td><td>' + (g.ok ? badge("ok","PASS") : badge("bad","FAIL")) + '</td></tr>'
  ).join("");

  if (goRows) goRows.innerHTML = go.map(g =>
    '<tr><td class="k">' + g.name + '</td><td>' + (g.ok ? badge("ok","PASS") : badge("warn","FAIL")) + '</td></tr>'
  ).join("");
}

    function badge(status, label) {
      const cls = status === "ok" ? "ok" : status === "bad" ? "bad" : status === "warn" ? "warn" : "info";
      return '<span class="badge ' + cls + '"><span class="dot ' + cls + '"></span>' + label + '</span>';
    }

    function fmtBool(b){ return b ? badge("ok","Yes") : badge("bad","No"); }

    function setOverall(ok) {
      const el = document.getElementById("overall");
      if (!el) return;
      el.innerHTML = ok
        ? '<span class="dot ok"></span><span>Overall: OK</span>'
        : '<span class="dot bad"></span><span>Overall: Issues detected</span>';
    }

    function setVercelRows(j) {
  const tbody = document.getElementById("vercelRows");
  const env = j?.env_presence || {};
  const host = j?.redacted?.DATABASE_URL_host || "—";

  const rows = [
    ["NODE_ENV", badge("info", j?.runtime?.nodeEnv || "—"), "<span class='mono'>runtime</span>"],
    ["DATABASE_URL", env.DATABASE_URL ? badge("ok", "Present") : badge("bad", "Missing"), "host: <span class='mono'>" + host + "</span>"],
    ["RAILWAY_INDEXER_URL", env.RAILWAY_INDEXER_URL ? badge("ok","Present") : badge("warn","Missing"),
      env.RAILWAY_INDEXER_URL ? "used for /health checks" : "optional until you wire it"
    ],
  ];

  tbody.innerHTML = rows.map(([k,s,d]) =>
    "<tr><td class='k'>" + k + "</td><td>" + s + "</td><td class='muted'>" + d + "</td></tr>"
  ).join("");
}

function setDbRows(j) {
  const tbody = document.getElementById("dbRows");
  const a = j?.checks?.supabase_postgres;
  const env = j?.env_presence || {};
  const host = j?.redacted?.DATABASE_URL_host || "—";

  const rows = [];

  // --- Section: Configuration ---
  rows.push([
    "<span class='mono'>Configuration</span>",
    badge("info", "Section"),
    "Validates DB env presence and TLS settings used for the Supabase Postgres connection."
  ]);

  rows.push([
    "DATABASE_URL",
    env.DATABASE_URL ? badge("ok", "Present") : badge("bad", "Missing"),
    env.DATABASE_URL ? ("host: <span class='mono'>" + host + "</span>") : "Add DATABASE_URL on Vercel (Production)."
  ]);

  const sslDisabled = String(env.PG_DISABLE_SSL || "") === "1";
  rows.push([
    "TLS",
    sslDisabled ? badge("warn", "Disabled") : badge("ok", "Enabled"),
    sslDisabled
      ? "TLS is disabled via <span class='mono'>PG_DISABLE_SSL=1</span>. Use this only for local Postgres."
      : "TLS is enabled. Supabase uses a public CA-signed certificate; a custom CA is optional."
  ]);

  // spacer
  rows.push(["", "", ""]);

  // --- Section: Connectivity ---
  rows.push([
    "<span class='mono'>Connectivity</span>",
    badge("info", "Section"),
    "Attempts <span class='mono'>select 1</span> with current SSL settings."
  ]);

  if (!a) {
    rows.push(["DB check", badge("bad", "No data"), "No diagnostics data for Postgres connectivity."]);
  } else if (!a.ok) {
    const code = a.error?.code ? ("<span class='mono'>" + a.error.code + "</span> ") : "";
    const msg = a.error?.message || "Unknown error";
    rows.push(["DB check", badge("bad", "FAIL"), code + msg]);

    // If you ever add these fields later, they will appear automatically
    if (a.ssl?.hasCa !== undefined) {
      rows.push(["SSL", badge("info", "Info"), "hasCa: <span class='mono'>" + String(!!a.ssl.hasCa) + "</span>"]);
    }
  } else {
    rows.push([
      "DB check",
      badge("ok", "OK"),
      "Latency: <span class='mono'>" + (a.latencyMs ?? "—") + "ms</span>"
    ]);

    rows.push([
      "SSL verification",
      a.ssl?.rejectUnauthorized ? badge("ok", "Verified") : badge("warn", "Unverified"),
      "hasCa: <span class='mono'>" + String(!!a.ssl?.hasCa) + "</span>"
    ]);
  }

  // spacer
  rows.push(["", "", ""]);

  // --- Section: Schema ---
  rows.push([
    "<span class='mono'>Schema</span>",
    badge("info", "Section"),
    "Checks required tables/columns for profiles, comments, and nonces."
  ]);

  const c = a?.checks || {};

  // If no schema data (because connectivity failed or older diagnostics), show guidance
  if (!a?.ok) {
    rows.push([
      "Schema checks",
      badge("warn", "Skipped"),
      "Schema checks run only when DB connectivity is OK."
    ]);
  } else {
    rows.push(["Table: user_profiles", c.user_profiles ? badge("ok", "Present") : badge("bad", "Missing"), "Profiles (displayName/avatar/bio)."]);
    rows.push(["Table: token_comments", c.token_comments ? badge("ok", "Present") : badge("bad", "Missing"), "Comments feed on token pages."]);
    rows.push(["Table: auth_nonces", c.auth_nonces ? badge("ok", "Present") : badge("bad", "Missing"), "Wallet signature nonces."]);

    // Columns (only meaningful if auth_nonces exists)
    if (c.auth_nonces) {
      rows.push(["Column: auth_nonces.nonce", c.auth_nonces_nonce ? badge("ok", "Present") : badge("warn", "Missing"), "Nonce value."]);
      rows.push(["Column: auth_nonces.expires_at", c.auth_nonces_expires_at ? badge("ok", "Present") : badge("warn", "Missing"), "Expiration timestamp."]);
      rows.push(["Column: auth_nonces.used_at", c.auth_nonces_used_at ? badge("ok", "Present") : badge("warn", "Missing"), "Replay protection (used marker)."]);
    } else {
      rows.push(["auth_nonces columns", badge("warn", "Skipped"), "auth_nonces table missing."]);
    }
  }

  tbody.innerHTML = rows
    .map(([k, st, d]) => "<tr><td class='k'>" + k + "</td><td>" + st + "</td><td class='muted'>" + d + "</td></tr>")
    .join("");
}


function setSupabaseRows(j) {
  const tbody = document.getElementById("supabaseRows");
  const s = j?.checks?.supabase;                 // reachability-only
  const sr = j?.checks?.supabase_service_role;   // service-role storage check

  const rows = [];

  // --- Section: Reachability (public) ---
  rows.push([
    "<span class='mono'>Reachability (public)</span>",
    badge("info", "Section"),
    "Checks if Supabase is reachable from Vercel runtime (no secrets)."
  ]);

  if (!s) {
    rows.push(["Reachability", badge("bad", "No data"), "No response from diagnostics."]);
  } else if (!s.ok) {
    rows.push(["Reachability", badge("bad", "FAIL"), (s.error?.message || "Unknown error")]);
  } else {
    rows.push([
      "Reachability",
      badge("ok", "OK"),
      "Latency: <span class='mono'>" + (s.latencyMs ?? "—") + "ms</span>, HTTP: <span class='mono'>" + (s.httpStatus ?? "—") + "</span>"
    ]);
    rows.push(["Host", badge("info", s.urlHost || "—"), "<span class='mono'>" + (s.pingUrl || "—") + "</span>"]);
    rows.push(["Note", badge("info", "Info"), s.note || "—"]);
  }

  // spacer row
  rows.push(["", "", ""]);

  // --- Section: Service Role / Storage (server-side) ---
  rows.push([
    "<span class='mono'>Service role / Storage</span>",
    badge("info", "Section"),
    "Validates SUPABASE_SERVICE_ROLE_KEY and checks bucket access (used by /api/upload)."
  ]);

  if (!sr) {
    rows.push(["Service role", badge("warn", "Not checked"), "supabase_service_role check not present in /api/diagnostics yet."]);
  } else if (!sr.ok) {
    const msg =
      sr.error?.message ||
      sr.error?.detail?.message ||
      sr.note ||
      "Missing or invalid SUPABASE_SERVICE_ROLE_KEY.";

    // If diagnostics marks it skipped, show WARN instead of FAIL
    const level = sr.skipped ? "warn" : "bad";
    rows.push(["Service role", badge(level, sr.skipped ? "Missing" : "FAIL"), msg]);

    if (sr.bucket) {
      rows.push(["Bucket", badge("info", "Info"), "Expected bucket: <span class='mono'>" + sr.bucket + "</span>"]);
    }
  } else {
    rows.push([
      "Service role",
      badge("ok", "OK"),
      "Latency: <span class='mono'>" + (sr.latencyMs ?? "—") + "ms</span>"
    ]);

    if (sr.bucket) {
      rows.push([
        "Bucket",
        sr.bucket.exists ? badge("ok", "Exists") : badge("warn", "Missing"),
        "Name: <span class='mono'>" + sr.bucket.name + "</span>, buckets: <span class='mono'>" + (sr.bucket.total ?? "—") + "</span>"
      ]);
    }
  }

  tbody.innerHTML = rows
    .map(([k, st, d]) => "<tr><td class='k'>" + k + "</td><td>" + st + "</td><td class='muted'>" + d + "</td></tr>")
    .join("");
}

function setRailwayRows(j) {
  const tbody = document.getElementById("railwayRows");
  const r = j?.checks?.railway;
  const env = j?.env_presence || {};

  const rows = [];

  // --- Section: Configuration ---
  rows.push([
    "<span class='mono'>Configuration</span>",
    badge("info", "Section"),
    "Checks Vercel env + URL normalization for the Railway indexer."
  ]);

  rows.push([
    "RAILWAY_INDEXER_URL",
    env.RAILWAY_INDEXER_URL ? badge("ok", "Present") : badge("warn", "Missing"),
    env.RAILWAY_INDEXER_URL
      ? "Configured. Diagnostics will call <span class='mono'>/health</span>."
      : "Add <span class='mono'>RAILWAY_INDEXER_URL</span> in Vercel (prefer full <span class='mono'>https://…</span>)."
  ]);

  // spacer
  rows.push(["", "", ""]);

  // --- Section: Health (/health) ---
  rows.push([
    "<span class='mono'>Health check</span>",
    badge("info", "Section"),
    "Calls <span class='mono'>GET /health</span> on the Railway service and validates response body."
  ]);

  if (!r) {
    rows.push(["/health", badge("warn", "Not checked"), "No diagnostics data for Railway."]);
  } else if (!r.ok) {
    const bodyStr =
      typeof r.body === "string"
        ? r.body
        : r.body
        ? JSON.stringify(r.body)
        : "";

    const errStr =
      r.error?.message
        ? r.error.message
        : bodyStr
        ? bodyStr
        : "Unreachable or unhealthy.";

    rows.push([
      "/health",
      badge("bad", "FAIL"),
      "HTTP: <span class='mono'>" + (r.httpStatus ?? "—") + "</span> " +
      (errStr ? ("<span class='mono'>" + errStr + "</span>") : "")
    ]);

    if (r.url) {
      rows.push(["URL", badge("info", "Info"), "<span class='mono'>" + r.url + "</span>"]);
    }
    if (r.note) {
      rows.push(["Note", badge("info", "Info"), r.note]);
    }
  } else {
    rows.push([
      "/health",
      badge("ok", "OK"),
      "Latency: <span class='mono'>" + (r.latencyMs ?? "—") + "ms</span>, HTTP: <span class='mono'>" + (r.httpStatus ?? "—") + "</span>"
    ]);

    rows.push(["URL", badge("info", "Info"), "<span class='mono'>" + (r.url || "—") + "</span>"]);

    // Show the Railway payload (your /health returns {ok:false,error:"..."} etc.)
    if (r.body) {
      rows.push([
        "Body",
        badge("info", "Info"),
        "<span class='mono'>" + (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) + "</span>"
      ]);
    }

    if (r.note) {
      rows.push(["Note", badge("info", "Info"), r.note]);
    }
  }

  tbody.innerHTML = rows
    .map(([k, st, d]) => "<tr><td class='k'>" + k + "</td><td>" + st + "</td><td class='muted'>" + d + "</td></tr>")
    .join("");
}


function setAblyRows(j) {
  const tbody = document.getElementById("ablyRows");
  const a = j?.checks?.ably; // server-side check
  const env = j?.env_presence || {};
  const preview = j?.redacted?.ABLY_API_KEY_preview || a?.preview || "";

  const rows = [];

  // --- Section: Server-side (Vercel) ---
  rows.push([
    "<span class='mono'>Server-side key</span>",
    badge("info", "Section"),
    "ABLY_API_KEY is required server-side. Never expose this key to the browser."
  ]);

  if (!a) {
    rows.push(["ABLY_API_KEY", badge("warn", "Not checked"), "No diagnostics data for Ably server key."]);
  } else if (!a.ok) {
    rows.push([
      "ABLY_API_KEY",
      badge("bad", "Missing/Invalid"),
      a.error?.message || a.note || "Server key missing or invalid."
    ]);
  } else {
    rows.push([
      "ABLY_API_KEY",
      badge("ok", "OK"),
      "Preview: <span class='mono'>" + (preview || "—") + "</span>"
    ]);
    rows.push(["Note", badge("info", "Info"), a.note || "—"]);
  }

  // spacer
  rows.push(["", "", ""]);

  // --- Section: Client-side (Browser) ---
  rows.push([
    "<span class='mono'>Client-side config</span>",
    badge("info", "Section"),
    "Browser should ideally use <span class='mono'>authUrl</span> (token auth), not a raw key. Wrong key causes <span class='mono'>invalid key parameter</span>."
  ]);

  rows.push([
    "VITE_ABLY_CLIENT_KEY",
    env.VITE_ABLY_CLIENT_KEY_on_server ? badge("warn", "Present") : badge("info", "Unknown"),
    env.VITE_ABLY_CLIENT_KEY_on_server
      ? "Client key appears to be set at build time. Ensure it is a valid Ably key, or remove it and rely on <span class='mono'>authUrl</span> only."
      : "Not visible server-side (can still be set client-side at build time)."
  ]);

  rows.push([
    "Recommendation",
    badge("info", "Info"),
    "For production: use <span class='mono'>authUrl: /api/ably/auth</span> and remove <span class='mono'>key</span> from the browser client constructor. This prevents key-format errors and avoids exposing secrets."
  ]);

  tbody.innerHTML = rows
    .map(([k, st, d]) => "<tr><td class='k'>" + k + "</td><td>" + st + "</td><td class='muted'>" + d + "</td></tr>")
    .join("");
}


    function setEnvRows(j) {
      const tbody = document.getElementById("envRows");
      const e = j?.env_presence || {};
      const rows = [
        ["DATABASE_URL", !!e.DATABASE_URL, j?.redacted?.DATABASE_URL_host ? ("host: " + j.redacted.DATABASE_URL_host) : ""],
        ["PG_CA_CERT_B64", !!e.PG_CA_CERT_B64, ""],
        ["PG_CA_CERT", !!e.PG_CA_CERT, ""],
        ["PG_DISABLE_SSL", String(e.PG_DISABLE_SSL || "") === "1", "set to 1 only for local Postgres"],
        ["SUPABASE_URL", !!e.SUPABASE_URL, ""],
        ["SUPABASE_SERVICE_ROLE_KEY", !!e.SUPABASE_SERVICE_ROLE_KEY, ""],
        ["ABLY_API_KEY", !!e.ABLY_API_KEY, ""],
        ["VITE_ABLY_CLIENT_KEY (server presence)", !!e.VITE_ABLY_CLIENT_KEY_on_server, "build-time var (client)"],
      ];

      tbody.innerHTML = rows.map(([k,p,extra]) => (
        '<tr>'
        + '<td class="k">' + k + '</td>'
        + '<td>' + (p ? badge("ok","Present") : badge("bad","Missing")) + '</td>'
        + '<td class="muted">' + (extra || "—") + '</td>'
        + '</tr>'
      )).join("");
    }

    function setRecommendations(j) {
      const el = document.getElementById("recs");
      const recs = Array.isArray(j?.recommendations) ? j.recommendations : [];
      if (recs.length === 0) {
        el.innerHTML = badge("ok","No recommendations");
        return;
      }
      el.innerHTML = '<ol style="margin:0; padding-left:18px;">'
        + recs.map(r => '<li style="margin:8px 0;">' + r + '</li>').join("")
        + '</ol>';
    }

    function setHeaderMeta(j) {
      document.getElementById("ts").textContent = new Date().toISOString();
      document.getElementById("nodeEnv").textContent = "NODE_ENV=" + (j?.runtime?.nodeEnv || "—");
    }

    async function load() {
    
      setOverall(false);
      const rawEl = document.getElementById("raw");
      rawEl.textContent = "Loading…";

      const r = await fetch('/api/diagnostics?token=' + encodeURIComponent(TOKEN), { cache: 'no-store' });
      const j = await r.json();
      lastJson = j;

      setHeaderMeta(j);
      setReadiness(j);
      setMonitoring(j);
      setVercelRows(j);
setDbRows(j);
setSupabaseRows(j);
setRailwayRows(j);
setAblyRows(j);
setEnvRows(j); // keep the global env table too (optional)
      setRecommendations(j);

      rawEl.textContent = JSON.stringify(j, null, 2);
    }

    document.getElementById("refreshBtn").addEventListener("click", load);
    document.getElementById("copyBtn").addEventListener("click", async () => {
      try {
        const text = lastJson ? JSON.stringify(lastJson, null, 2) : "";
        await navigator.clipboard.writeText(text);
      } catch {}
    });

    load();
  </script>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      return res.status(200).send(html);
    }

    const out = {
      ok: false,
      runtime: {
        nodeEnv: process.env.NODE_ENV || "",
      },
      env_presence: {
        TELEMETRY_STATUS_URL: Boolean(process.env.TELEMETRY_STATUS_URL),
        BSC_RPC_HTTP_97: Boolean(process.env.BSC_RPC_HTTP_97),
        DATABASE_URL: Boolean(process.env.DATABASE_URL),
        PG_CA_CERT_B64: Boolean(process.env.PG_CA_CERT_B64),
        PG_CA_CERT: Boolean(process.env.PG_CA_CERT),
        PG_DISABLE_SSL: Boolean(process.env.PG_DISABLE_SSL),
        SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
        SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
        // Ably: server side should have ABLY_API_KEY (do not expose it)
        ABLY_API_KEY: Boolean(process.env.ABLY_API_KEY),
        // Client side uses VITE_ABLY_CLIENT_KEY at build time; may be absent here
        VITE_ABLY_CLIENT_KEY_on_server: Boolean(process.env.VITE_ABLY_CLIENT_KEY),
        RAILWAY_INDEXER_URL: Boolean(process.env.RAILWAY_INDEXER_URL),
      },
      redacted: {
        // helpful to verify you're pointing to the expected Postgres without leaking secrets
        DATABASE_URL_host: process.env.DATABASE_URL ? (() => {
          try { return parseDbUrl(process.env.DATABASE_URL).host; } catch { return "invalid"; }
        })() : "",
        ABLY_API_KEY_preview: process.env.ABLY_API_KEY ? redact(process.env.ABLY_API_KEY, 10, 6) : "",
      },
      checks: {},
      recommendations: [],
    };

    out.checks.telemetry = await checkTelemetry();
out.checks.rpc = await checkRpcHeadBlock();
out.checks.ably_rest = await checkAblyRestAuth();

    // DATABASE_URL should point at Supabase Postgres (single source of truth)
    out.checks.supabase_postgres = await pgCheck();

    // Railway (indexer health)
out.checks.railway = await checkRailway();

// Supabase (reachability only; token data lives here)
out.checks.supabase = await checkSupabasePublic();

out.checks.supabase_service_role = await checkSupabaseServiceRole();

const sr = out.checks.supabase_service_role;
if (sr && sr.jwt?.issuerMismatch) {
  out.recommendations.push(
    "SUPABASE_SERVICE_ROLE_KEY issuer does not match SUPABASE_URL host. You likely pasted a key from a different Supabase project. Copy the service_role key from the SAME project as SUPABASE_URL."
  );
}
if (sr && sr.jwt?.looksJwt && sr.jwt?.role && String(sr.jwt.role).toLowerCase() !== "service_role") {
  out.recommendations.push(
    "SUPABASE_SERVICE_ROLE_KEY JWT role is not service_role. Ensure you copied the service_role key (not anon) from Supabase Settings → API."
  );
}

if (!out.checks.supabase_service_role?.ok) {
  out.recommendations.push(
    "Supabase service role key is missing/invalid. This will break /api/upload. Set SUPABASE_SERVICE_ROLE_KEY on Vercel."
  );
}

// Ably (server key presence/format only)
out.checks.ably = await checkAblyServerKey();

if (!out.checks.railway?.ok) {
  out.recommendations.push(
    "Railway /health is failing or unreachable. Set RAILWAY_INDEXER_URL on Vercel and confirm the indexer can connect to Supabase Postgres."
  );
}

if (!out.checks.supabase?.ok) {
  out.recommendations.push(
    "Supabase reachability failed. Verify SUPABASE_URL on Vercel."
  );
}

if (!out.checks.ably?.ok) {
  out.recommendations.push(
    "Ably server key is missing/invalid on Vercel. Set ABLY_API_KEY (keyName:keySecret). Client-side should not use the server key."
  );
}
    if (!out.checks.supabase_postgres.ok) {
      out.recommendations.push(
        "Postgres DB check failed. Look at checks.supabase_postgres.error for the exact TLS/auth/host issue."
      );
      if (!out.env_presence.DATABASE_URL) {
        out.recommendations.push(
          "DATABASE_URL is missing on Vercel Production env. Add it and redeploy."
        );
      }
    } else {
      const c = out.checks.supabase_postgres.checks || {};
      if (!c.user_profiles) out.recommendations.push("Missing table user_profiles. Apply db/migrations/002_social.sql.");
      if (!c.token_comments) out.recommendations.push("Missing table token_comments. Apply db/migrations/002_social.sql.");
      if (c.auth_nonces && !c.auth_nonces_used_at) {
        out.recommendations.push(
          "auth_nonces.used_at column is missing but your API expects it. Add the column or update the queries/migration."
        );
      }
    }

    // Collect detailed metrics (run in parallel)
    const [supabaseMetrics, ablyStats, railwayMetrics] = await Promise.all([
      collectSupabaseMetrics(),
      collectAblyStats(),
      Promise.resolve(null), // placeholder — implemented in Task 3
    ]);

    out.metrics = {
      supabase: supabaseMetrics,
      ably: ablyStats,
      railway: railwayMetrics,
    };

    const gates = {
      core: [
        { name: "Supabase Postgres (DATABASE_URL)", ok: Boolean(out.checks.supabase_postgres?.ok) },
        { name: "Supabase reachability (REST)", ok: Boolean(out.checks.supabase?.ok) },
      ],
      goLive: [
        { name: "Supabase Postgres (DATABASE_URL)", ok: Boolean(out.checks.supabase_postgres?.ok) },
        { name: "Railway indexer /health", ok: Boolean(out.checks.railway?.ok) },
        { name: "Supabase reachability", ok: Boolean(out.checks.supabase?.ok) },
        { name: "Supabase service role (uploads)", ok: Boolean(out.checks.supabase_service_role?.ok) },
        { name: "Ably server key", ok: Boolean(out.checks.ably?.ok) },
      ],
    };

    out.status = {
      coreReady: gates.core.every((g) => g.ok),
      goLiveReady: gates.goLive.every((g) => g.ok),
      gates,
    };

    out.ok = out.status.coreReady;

    return res.status(200).json(out);
  } catch (e) {
    console.error("[api/diagnostics] crashed", e);
    return res.status(500).json({ error: "Server error", detail: safeError(e) });
  }
}
