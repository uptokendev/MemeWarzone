import { Pool } from "pg";
import { ENV } from "./env.js";

function dbHostFromUrl(dbUrl: string): string {
  const u = new URL(dbUrl);
  return u.hostname;
}

function dbPortFromUrl(dbUrl: string): number | null {
  const u = new URL(dbUrl);
  const p = u.port ? Number(u.port) : null;
  return Number.isFinite(p as number) ? (p as number) : null;
}

function loadCustomCaIfEnabled(): string | null {
  // Only use a custom CA if explicitly enabled.
  const enabled = String(process.env.PG_USE_CUSTOM_CA || "").trim() === "1";
  if (!enabled) return null;

  const b64 = process.env.PG_CA_CERT_B64;
  if (b64) {
    const pem = Buffer.from(b64, "base64").toString("utf8");
    if (!pem.includes("BEGIN CERTIFICATE")) {
      throw new Error("PG_CA_CERT_B64 does not decode to a PEM certificate");
    }
    return pem;
  }

  const pem = process.env.PG_CA_CERT;
  if (pem) return pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;

  return null;
}

const host = dbHostFromUrl(ENV.DATABASE_URL);
const port = dbPortFromUrl(ENV.DATABASE_URL);

// Keep this for local debugging only; do not set in production.
const disableSsl = String(process.env.PG_DISABLE_SSL || "").trim() === "1";

// Some serverless/container environments ship with a minimal CA bundle.
// If you hit SELF_SIGNED_CERT_IN_CHAIN when connecting to Supabase pooler,
// set PG_SSL_ALLOW_SELF_SIGNED=1 to keep TLS on but skip certificate verification.
const allowSelfSigned = String(process.env.PG_SSL_ALLOW_SELF_SIGNED || "").trim() === "1";

let customCa: string | null = null;
try {
  customCa = loadCustomCaIfEnabled();
} catch (e) {
  console.error("[db] Custom CA load error:", e);
  throw e; // fail fast; misconfigured CA should not silently degrade security
}

const ssl =
  disableSsl
    ? false
    : customCa
      ? { ca: customCa, rejectUnauthorized: true, servername: host }
      : allowSelfSigned
        ? { rejectUnauthorized: false, servername: host }
        : { rejectUnauthorized: true, servername: host };

// This process runs many concurrent loops (BNB scan, Solana tip, Solana backfill,
// Meteora, candles, FeeEscrow, HTTP). PG_POOL_MAX=3 starves token-summary and
// lease queries with "timeout exceeded when trying to connect".
const poolMax = (() => {
  const raw = String(process.env.PG_POOL_MAX || "").trim();
  const n = raw ? Number(raw) : NaN;
  const requested = Number.isFinite(n) && n > 0 ? Math.floor(n) : 12;
  return Math.max(8, Math.min(20, requested));
})();

// Supabase Transaction Pooler (port 6543) does not support PREPARE statements.
// Force pg "simple query" protocol to avoid prepared/extended protocol.
// Enable automatically if port == 6543, or override with PG_SIMPLE_PROTOCOL=1/0.
const forceSimpleProtocol = (() => {
  const override = String(process.env.PG_SIMPLE_PROTOCOL || "").trim();
  if (override === "1") return true;
  if (override === "0") return false;
  return port === 6543; // auto-enable for transaction pooler
})();

// Log connection mode once at boot for fast diagnosis.
console.log(
  `[db] host=${host}:${port ?? "?"} ssl=${disableSsl ? "off" : "on"} verify=${disableSsl ? "n/a" : allowSelfSigned ? "off" : "on"} ca=${
    customCa ? "custom" : "system"
  } poolMax=${poolMax} simple=${forceSimpleProtocol ? "on" : "off"}`
);

export const pool = new Pool({
  connectionString: ENV.DATABASE_URL,
  ssl,
  max: poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

// Force simple protocol globally for this pool (transaction pooler safe).
if (forceSimpleProtocol) {
  const origQuery: any = (pool as any).query.bind(pool);

  (pool as any).query = (...args: any[]) => {
    // query(text, values?)
    if (typeof args[0] === "string") {
      const text = args[0];
      const values = Array.isArray(args[1]) ? args[1] : undefined;

      return origQuery({
        text,
        values,
        simple: true, // <-- supported by pg runtime, not in TS types
      } as any);
    }

    // query({ text, values, ... })
    if (args[0] && typeof args[0] === "object" && typeof (args[0] as any).text === "string") {
      return origQuery({
        ...(args[0] as any),
        simple: true,
      } as any);
    }

    // fallback (callback signatures etc.)
    return origQuery.apply(pool, args);
  };
}


pool.on("error", (err) => {
  console.error("[db] pool error:", err);
});

setInterval(() => {
  if (pool.waitingCount > 0) {
    console.warn("[db] pool waiters", {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
      max: poolMax,
    });
  }
}, 15_000).unref();