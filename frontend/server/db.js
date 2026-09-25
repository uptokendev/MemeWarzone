import pg from "pg";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

/**
 * Standardize on Supabase Postgres.
 *
 * Supabase uses a public CA-signed certificate, so you typically do NOT need
 * to provide a custom CA. Keep TLS enabled by default.
 *
 * If you are connecting to a local Postgres for development, you can disable
 * TLS by setting PG_DISABLE_SSL=1.
 */
function loadOptionalCaPem() {
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
    user: decodeURIComponent(u.username || ""),
    password: decodeURIComponent(u.password || ""),
    database: (u.pathname || "").replace(/^\//, "") || "postgres",
  };
}

// Reuse pool across invocations
let _pool = globalThis.__memewarzone_pool;

if (!_pool) {
  if (!DATABASE_URL) throw new Error("DATABASE_URL missing");

  const { host, port, user, password, database } = parseDbUrl(DATABASE_URL);
  const ca = loadOptionalCaPem();
  const sslDisabled = String(process.env.PG_DISABLE_SSL || "").trim() === "1";
  // Some serverless/container environments ship with a minimal CA bundle.
  // If you hit SELF_SIGNED_CERT_IN_CHAIN when connecting to Supabase pooler,
  // set PG_SSL_ALLOW_SELF_SIGNED=1 to keep TLS on but skip certificate verification.
  const allowSelfSigned = String(process.env.PG_SSL_ALLOW_SELF_SIGNED || "").trim() === "1";

  console.log("[api/_db] PG host:", host, "port:", port, "db:", database);
  console.log(
    "[api/_db] CA loaded:",
    Boolean(ca),
    "CA bytes:",
    ca ? ca.length : 0,
    "allowSelfSigned:",
    allowSelfSigned
  );

  _pool = new Pool({
    host,
    port,
    user,
    password,
    database,

    ssl: sslDisabled
      ? false
      : ca
        ? { ca, rejectUnauthorized: true, servername: host }
        : allowSelfSigned
          ? { rejectUnauthorized: false, servername: host }
          : { rejectUnauthorized: true, servername: host },

    // One long-lived server on Coolify serves every request plus the in-process battle worker.
    // max: 2 was a serverless leftover; under launch traffic every request queued behind two
    // connections, timed out after 10 s and the proxy answered 502/503 (2026-09-25).
    max: Math.max(2, Math.min(40, Number(process.env.PG_POOL_MAX || 15))),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // A query the pooler never answers fails instead of holding its connection forever.
    query_timeout: Math.max(5_000, Number(process.env.PG_QUERY_TIMEOUT_MS || 30_000)),
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });

  globalThis.__memewarzone_pool = _pool;

  _pool.on("error", (err) => console.error("[api/_db] Pool error", err));
}

export const pool = _pool;
