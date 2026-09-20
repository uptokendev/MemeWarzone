export function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

export function badMethod(res) {
  json(res, 405, { error: "Method not allowed" });
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function parseJsonLikeBody(value) {
  if (value == null) return null;

  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const raw = Buffer.from(value).toString("utf8");
    if (!raw.trim()) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  if (typeof value === "string") {
    if (!value.trim()) return {};
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && typeof value.body === "string") {
      return parseJsonLikeBody(value.body);
    }
    if (keys.length === 0) return null;
    return value;
  }

  return null;
}

export async function readJson(req) {
  const direct = parseJsonLikeBody(req.body);
  if (direct != null) return direct;

  const chunks = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function getQuery(req) {
  const u = new URL(req.url, "http://localhost");
  const out = {};
  for (const [k, v] of u.searchParams.entries()) out[k] = v;
  return out;
}

export function isAddress(v) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(v ?? ""));
}

export function isSolanaChain(chainId) {
  const n = Number(chainId);
  return n === 101 || n === 102;
}

/**
 * Check if a string looks like a Solana base58 address (32-44 chars, base58 alphabet).
 * This is the plain JS version for the server (no TS types).
 */
export function isSolanaAddress(value) {
  const s = String(value || "").trim();
  return s.length >= 32 && s.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

export function normalizeAddress(value, chainId) {
  const raw = String(value || "").trim();
  if (isSolanaChain(chainId)) {
    // Solana base58 pubkey - preserve exact case and format (never lowercase)
    if (raw.length >= 32 && raw.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(raw)) {
      return raw;
    }
    return "";
  }
  const lower = raw.toLowerCase();
  return isAddress(lower) ? lower : "";
}

/**
 * Accept either EVM (0x…) or Solana base58 regardless of draft/campaign chain.
 * Used for social actions (follow / arm notifications) where an EVM user may
 * engage with a Solana draft and vice versa.
 */
export function normalizeWalletFlexible(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (isAddress(raw)) return raw.toLowerCase();
  if (isSolanaAddress(raw)) return raw;
  return "";
}

/**
 * Default chain for a request that does not name one.
 *
 * This used to be the literal 97, BSC testnet, in four separate handlers. The
 * browser always sends an explicit chainId so it never showed there, but any
 * other caller — a curl, an integration, a webhook — silently got testnet data
 * from the production API.
 *
 * PUBLIC_DEFAULT_CHAIN_ID overrides it. The fallback is 56, BNB mainnet, and a
 * testnet value is refused outright when RUNTIME_ENVIRONMENT says production:
 * a misconfigured env should not be able to serve testnet campaigns to real
 * visitors.
 */
export const TESTNET_CHAIN_IDS = new Set([97, 102, 46630]);

export function defaultPublicChainId() {
  const raw = Number(String(process.env.PUBLIC_DEFAULT_CHAIN_ID || "").trim());
  if (!Number.isFinite(raw) || raw <= 0) return 56;
  const isProduction = String(process.env.RUNTIME_ENVIRONMENT || "").trim().toLowerCase() === "production";
  if (isProduction && TESTNET_CHAIN_IDS.has(raw)) {
    console.warn(`[http] PUBLIC_DEFAULT_CHAIN_ID=${raw} is a testnet; refusing it in production and using 56`);
    return 56;
  }
  return raw;
}
