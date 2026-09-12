import crypto from "node:crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import { getTokenMetadata, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { pumpBondingCurveAddress, assertSolanaImportMainnet } from "./projectSolanaProjectAuthority.js";

const BNB_CHAIN_ID = 56;
const SOLANA_CHAIN_ID = 101;
const ROBINHOOD_CHAIN_ID = 4663;
const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const COOKIE_NAME = "mwz_x_claim";
const OAUTH_TTL_MS = 10 * 60 * 1000;
const ALLOWED_METADATA_HOSTS = new Set([
  "cf-ipfs.com",
  "ipfs.io",
  "gateway.pinata.cloud",
  "pump.mypinata.cloud",
  "cloudflare-ipfs.com",
  "arweave.net",
]);

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw Object.assign(new Error(`${name} is not configured`), { code: "PROJECT_IMPORT_X_OAUTH_NOT_CONFIGURED" });
  return value;
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function randomUrlSafe(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function stateSecret() {
  return String(process.env.X_OAUTH_STATE_SECRET || process.env.X_OAUTH_CLIENT_SECRET || "").trim();
}

function signState(payload) {
  const secret = stateSecret();
  if (!secret) throw Object.assign(new Error("X OAuth state secret is not configured"), { code: "PROJECT_IMPORT_X_OAUTH_NOT_CONFIGURED" });
  const encoded = base64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

function verifyState(token) {
  const secret = stateSecret();
  if (!secret) throw Object.assign(new Error("X OAuth state secret is not configured"), { code: "PROJECT_IMPORT_X_OAUTH_NOT_CONFIGURED" });
  const [encoded, supplied] = String(token || "").split(".");
  if (!encoded || !supplied) throw Object.assign(new Error("Invalid X OAuth state"), { code: "PROJECT_IMPORT_X_OAUTH_STATE_INVALID" });
  const expected = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw Object.assign(new Error("Invalid X OAuth state"), { code: "PROJECT_IMPORT_X_OAUTH_STATE_INVALID" });
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
  catch { throw Object.assign(new Error("Invalid X OAuth state"), { code: "PROJECT_IMPORT_X_OAUTH_STATE_INVALID" }); }
  if (!payload?.exp || Date.now() > Number(payload.exp)) throw Object.assign(new Error("X OAuth request expired"), { code: "PROJECT_IMPORT_X_OAUTH_STATE_EXPIRED" });
  if (![BNB_CHAIN_ID, SOLANA_CHAIN_ID, ROBINHOOD_CHAIN_ID].includes(Number(payload.chainId))) throw Object.assign(new Error("Unsupported X claim chain"), { code: "INVALID_CHAIN" });
  return payload;
}

function parseCookies(req) {
  const raw = String(req.headers?.cookie || "");
  const out = {};
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
  }
  return out;
}

function setClaimCookie(res, payload) {
  const value = base64url(JSON.stringify(payload));
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/api/project-imports/image/x; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
}

function clearClaimCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/api/project-imports/image/x; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

function readClaimCookie(req) {
  const raw = parseCookies(req)[COOKIE_NAME];
  if (!raw) throw Object.assign(new Error("X OAuth browser session is missing"), { code: "PROJECT_IMPORT_X_OAUTH_SESSION_MISSING" });
  try { return JSON.parse(Buffer.from(raw, "base64url").toString("utf8")); }
  catch { throw Object.assign(new Error("X OAuth browser session is invalid"), { code: "PROJECT_IMPORT_X_OAUTH_SESSION_MISSING" }); }
}

function readMetadataString(data, offset, maxBytes) {
  if (offset + 4 > data.length) throw new Error("metadata string length missing");
  const length = data.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + length;
  if (length > maxBytes || end > data.length) throw new Error("metadata string invalid");
  return { value: data.subarray(start, end).toString("utf8").replace(/\0/g, "").trim(), next: end };
}

function normalizeMetadataUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  if (value.startsWith("ipfs://")) {
    const cidPath = value.slice("ipfs://".length).replace(/^ipfs\//, "");
    return `https://cf-ipfs.com/ipfs/${cidPath}`;
  }
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || !ALLOWED_METADATA_HOSTS.has(url.hostname.toLowerCase())) return null;
  return url.toString();
}

function normalizeImageUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  if (value.startsWith("ipfs://")) {
    const cidPath = value.slice("ipfs://".length).replace(/^ipfs\//, "");
    return `https://cf-ipfs.com/ipfs/${cidPath}`;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizeXUsername(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (/^@[A-Za-z0-9_]{1,15}$/.test(value)) return value.slice(1).toLowerCase();
  if (/^[A-Za-z0-9_]{1,15}$/.test(value)) return value.toLowerCase();
  try {
    const url = new URL(value.startsWith("http") ? value : `https://${value}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "x.com" && host !== "twitter.com") return "";
    const username = String(url.pathname.split("/").filter(Boolean)[0] || "");
    if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) return "";
    if (["home", "intent", "share", "search", "i"].includes(username.toLowerCase())) return "";
    return username.toLowerCase();
  } catch { return ""; }
}

function solanaRpcUrl() {
  return String(process.env.SOLANA_RPC_URL || process.env.SOLANA_MAINNET_RPC_URL || "").trim();
}

function getSolanaConnection() {
  const rpc = solanaRpcUrl();
  if (!rpc) throw Object.assign(new Error("Solana RPC is not configured"), { code: "PROJECT_IMPORT_RPC_UNAVAILABLE" });
  return new Connection(rpc, "confirmed");
}

async function readSolanaMetadataReference(connection, mintKey) {
  const [metadataAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mintKey.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID,
  );
  try {
    const account = await connection.getAccountInfo(metadataAddress, "confirmed");
    if (account?.data && account.owner?.equals?.(TOKEN_METADATA_PROGRAM_ID)) {
      const data = Buffer.from(account.data);
      if (data.length >= 65) {
        const name = readMetadataString(data, 65, 256);
        const symbol = readMetadataString(data, name.next, 64);
        const uri = readMetadataString(data, symbol.next, 2048);
        const metadataUrl = normalizeMetadataUrl(uri.value);
        if (metadataUrl) {
          return {
            metadataUrl,
            metadataAddress: metadataAddress.toBase58(),
            metadataSource: "pump_metaplex_metadata",
          };
        }
      }
    }
  } catch {
    // Token-2022 fallback below.
  }

  try {
    const mintAccount = await connection.getAccountInfo(mintKey, "confirmed");
    if (!mintAccount?.owner?.equals?.(TOKEN_2022_PROGRAM_ID)) return null;
    const metadata = await getTokenMetadata(connection, mintKey, "confirmed", TOKEN_2022_PROGRAM_ID);
    const metadataUrl = normalizeMetadataUrl(metadata?.uri);
    if (!metadataUrl) return null;
    return {
      metadataUrl,
      metadataAddress: mintKey.toBase58(),
      metadataSource: "pump_token2022_metadata",
    };
  } catch {
    return null;
  }
}

async function readSolanaMetadataJson(mint, { requirePump = false } = {}) {
  const connection = getSolanaConnection();
  await assertSolanaImportMainnet(connection);
  const mintKey = new PublicKey(mint);
  let curve = null;
  if (requirePump) {
    curve = pumpBondingCurveAddress(mintKey);
    const curveInfo = await connection.getAccountInfo(curve, "confirmed");
    if (!curveInfo) throw Object.assign(new Error("This token is not recognized as a Pump.fun launch"), { code: "PROJECT_IMPORT_X_NOT_PUMP" });
  }
  const reference = await readSolanaMetadataReference(connection, mintKey);
  if (!reference) throw Object.assign(new Error("Pump.fun project metadata could not be resolved"), { code: "PROJECT_IMPORT_X_METADATA_UNAVAILABLE" });
  const response = await fetch(reference.metadataUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(7000),
  });
  if (!response.ok) throw Object.assign(new Error("Pump.fun metadata is temporarily unavailable"), { code: "PROJECT_IMPORT_X_METADATA_UNAVAILABLE" });
  const json = await response.json().catch(() => null);
  if (!json || typeof json !== "object") throw Object.assign(new Error("Pump.fun project metadata is invalid"), { code: "PROJECT_IMPORT_X_METADATA_UNAVAILABLE" });
  return {
    ...reference,
    bondingCurve: curve?.toBase58?.() || null,
    json,
  };
}

async function readPumpMetadataUri(mint) {
  const source = await readSolanaMetadataJson(mint, { requirePump: true });
  return {
    metadataUrl: source.metadataUrl,
    metadataAddress: source.metadataAddress,
    metadataSource: source.metadataSource,
    curve: source.bondingCurve,
    json: source.json,
  };
}

export async function resolvePumpOfficialX(mint) {
  const source = await readPumpMetadataUri(mint);
  const username = normalizeXUsername(source.json?.twitter);
  if (!username) throw Object.assign(new Error("No official X account is attached to this Pump.fun token"), { code: "PROJECT_IMPORT_X_NOT_FOUND" });
  return {
    username,
    xUrl: `https://x.com/${username}`,
    source: source.metadataSource,
    metadataUrl: source.metadataUrl,
    metadataAddress: source.metadataAddress,
    bondingCurve: source.curve,
  };
}

function dexScreenerChain(chainId) {
  if (Number(chainId) === BNB_CHAIN_ID) return String(process.env.DEXSCREENER_BNB_CHAIN_ID || "bsc").trim();
  if (Number(chainId) === SOLANA_CHAIN_ID) return "solana";
  if (Number(chainId) === ROBINHOOD_CHAIN_ID) return String(process.env.DEXSCREENER_ROBINHOOD_CHAIN_ID || "robinhood").trim();
  return "";
}

function tokenAddressMatches(chainId, left, right) {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  if (Number(chainId) === SOLANA_CHAIN_ID) return a === b;
  return a.toLowerCase() === b.toLowerCase();
}

async function readDexScreenerPairs(chainId, tokenAddress) {
  const chain = dexScreenerChain(chainId);
  if (!chain) throw Object.assign(new Error("DexScreener lookup is unavailable for this chain"), { code: "PROJECT_IMPORT_X_UNSUPPORTED_CHAIN" });
  const url = `https://api.dexscreener.com/tokens/v1/${encodeURIComponent(chain)}/${encodeURIComponent(tokenAddress)}`;
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(7000) });
  if (!response.ok) throw Object.assign(new Error("DexScreener project metadata is temporarily unavailable"), { code: "PROJECT_IMPORT_X_METADATA_UNAVAILABLE" });
  const json = await response.json().catch(() => []);
  const pairs = Array.isArray(json) ? json : [];
  return {
    chain,
    pairs: pairs.filter((pair) => String(pair?.chainId || "").toLowerCase() === chain.toLowerCase() && tokenAddressMatches(chainId, pair?.baseToken?.address, tokenAddress)),
  };
}

export async function resolveDexScreenerOfficialX(chainId, tokenAddress) {
  const { chain, pairs } = await readDexScreenerPairs(chainId, tokenAddress);
  const usernames = new Set();
  for (const pair of pairs) {
    for (const social of Array.isArray(pair?.info?.socials) ? pair.info.socials : []) {
      const platform = String(social?.platform || social?.type || "").toLowerCase();
      if (platform !== "twitter" && platform !== "x") continue;
      const username = normalizeXUsername(social?.handle || social?.url || "");
      if (username) usernames.add(username);
    }
  }
  if (usernames.size === 0) throw Object.assign(new Error("No official X account is attached to this token on DexScreener"), { code: "PROJECT_IMPORT_X_NOT_FOUND" });
  if (usernames.size > 1) throw Object.assign(new Error("Conflicting X accounts were found for this token on DexScreener"), { code: "PROJECT_IMPORT_X_CONFLICT" });
  const username = [...usernames][0];
  return { username, xUrl: `https://x.com/${username}`, source: "dexscreener_token_profile", chain };
}

export async function resolveProjectImportImage(chainId, tokenAddress) {
  try {
    const { pairs } = await readDexScreenerPairs(chainId, tokenAddress);
    for (const pair of pairs) {
      const imageUrl = normalizeImageUrl(pair?.info?.imageUrl);
      if (imageUrl) return { imageUrl, source: "dexscreener" };
    }
  } catch {
    // Program metadata fallback below for Solana.
  }

  if (Number(chainId) === SOLANA_CHAIN_ID) {
    try {
      const metadata = await readSolanaMetadataJson(tokenAddress);
      const imageUrl = normalizeImageUrl(metadata?.json?.image);
      if (imageUrl) return { imageUrl, source: metadata.metadataSource };
    } catch {
      // Missing image must not block import or claim.
    }
  }
  return { imageUrl: null, source: null };
}

export async function resolveOfficialProjectX(chainId, tokenAddress) {
  const id = Number(chainId);
  if (id === SOLANA_CHAIN_ID) return resolvePumpOfficialX(tokenAddress);
  if (id === BNB_CHAIN_ID || id === ROBINHOOD_CHAIN_ID) return resolveDexScreenerOfficialX(id, tokenAddress);
  throw Object.assign(new Error("X project verification is not supported on this chain"), { code: "INVALID_CHAIN" });
}

function redirectUri() {
  return requiredEnv("X_OAUTH_REDIRECT_URI");
}

function publicSiteUrl() {
  return String(process.env.PUBLIC_SITE_URL || process.env.X_OAUTH_SUCCESS_URL || "https://app.memewar.zone").replace(/\/$/, "");
}

export async function startProjectXClaim({ req, res, project, walletAddress }) {
  const chainId = Number(project?.chain_id);
  if (![BNB_CHAIN_ID, SOLANA_CHAIN_ID, ROBINHOOD_CHAIN_ID].includes(chainId)) throw Object.assign(new Error("X project verification is not supported on this chain"), { code: "INVALID_CHAIN" });
  if (project?.ownership_status === "ownership_suspended") throw Object.assign(new Error("Project ownership is suspended"), { code: "OWNERSHIP_SUSPENDED" });
  if (project?.ownership_status === "ownership_verified") throw Object.assign(new Error("This project is already verified"), { code: "OWNERSHIP_CONFLICT" });
  if (project?.ownership_status === "ownership_manual_review" && project?.manual_claim_wallet && project.manual_claim_wallet !== walletAddress) {
    throw Object.assign(new Error("Another project claim is already pending"), { code: "OWNERSHIP_CONFLICT" });
  }

  const expected = await resolveOfficialProjectX(chainId, project.token_address);
  const verifier = randomUrlSafe(48);
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const nonce = randomUrlSafe(20);
  const payload = {
    v: 1,
    nonce,
    projectId: String(project.id),
    chainId,
    tokenAddress: String(project.token_address),
    walletAddress: String(walletAddress),
    expectedUsername: expected.username,
    source: expected.source,
    exp: Date.now() + OAUTH_TTL_MS,
  };
  const state = signState(payload);
  setClaimCookie(res, { nonce, verifier, exp: payload.exp });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: requiredEnv("X_OAUTH_CLIENT_ID"),
    redirect_uri: redirectUri(),
    scope: "users.read tweet.read",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return {
    authorizeUrl: `https://x.com/i/oauth2/authorize?${params.toString()}`,
    expectedUsername: expected.username,
    xUrl: expected.xUrl,
    source: expected.source,
  };
}

async function exchangeCode(code, verifier) {
  const clientId = requiredEnv("X_OAUTH_CLIENT_ID");
  const clientSecret = String(process.env.X_OAUTH_CLIENT_SECRET || "").trim();
  const body = new URLSearchParams({
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri(),
    code_verifier: verifier,
    client_id: clientId,
  });
  const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (clientSecret) headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  const response = await fetch("https://api.x.com/2/oauth2/token", { method: "POST", headers, body, signal: AbortSignal.timeout(7000) });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json?.access_token) throw Object.assign(new Error("X authorization could not be completed"), { code: "PROJECT_IMPORT_X_OAUTH_EXCHANGE_FAILED" });
  return String(json.access_token);
}

async function authenticatedXUser(accessToken) {
  const response = await fetch("https://api.x.com/2/users/me?user.fields=verified,profile_image_url", {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    signal: AbortSignal.timeout(7000),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json?.data?.id || !json?.data?.username) throw Object.assign(new Error("X account identity could not be read"), { code: "PROJECT_IMPORT_X_IDENTITY_FAILED" });
  return json.data;
}

export async function finishProjectXClaim({ req, res, pool, state, code }) {
  const payload = verifyState(state);
  const cookie = readClaimCookie(req);
  clearClaimCookie(res);
  if (!cookie?.nonce || cookie.nonce !== payload.nonce || !cookie?.verifier || Date.now() > Number(cookie.exp || 0)) {
    throw Object.assign(new Error("X OAuth browser session does not match this claim"), { code: "PROJECT_IMPORT_X_OAUTH_SESSION_MISSING" });
  }

  const accessToken = await exchangeCode(String(code || ""), cookie.verifier);
  const xUser = await authenticatedXUser(accessToken);
  const actualUsername = String(xUser.username || "").toLowerCase();
  const expectedUsername = String(payload.expectedUsername || "").toLowerCase();
  if (!actualUsername || actualUsername !== expectedUsername) {
    throw Object.assign(new Error(`This X account does not match @${expectedUsername}`), {
      code: "PROJECT_IMPORT_X_ACCOUNT_MISMATCH",
      expectedUsername,
      actualUsername,
    });
  }

  const currentExpected = await resolveOfficialProjectX(payload.chainId, payload.tokenAddress);
  if (currentExpected.username !== expectedUsername) {
    throw Object.assign(new Error("The official project X account changed during verification"), { code: "PROJECT_IMPORT_X_ACCOUNT_CHANGED" });
  }

  const result = await pool.query(
    `UPDATE public.arena_token_imports
        SET project_owner_wallet=$4,
            ownership_status='ownership_verified',
            verified_at=NOW(),
            ownership_verified_at=NOW(),
            manual_claim_wallet=NULL,
            manual_claim_requested_at=NULL,
            manual_claim_note=NULL,
            x_url=$5,
            metadata_updated_at=NOW(),
            updated_at=NOW()
      WHERE id=$1 AND chain_id=$2 AND token_address=$3
        AND ownership_status IN ('ownership_pending','ownership_manual_review')
        AND (ownership_status='ownership_pending' OR manual_claim_wallet IS NULL OR manual_claim_wallet=$4)
      RETURNING *`,
    [payload.projectId, Number(payload.chainId), payload.tokenAddress, payload.walletAddress, currentExpected.xUrl],
  );
  if (!result.rows?.[0]) {
    const current = await pool.query("SELECT * FROM public.arena_token_imports WHERE id=$1 LIMIT 1", [payload.projectId]);
    const row = current.rows?.[0];
    if (row?.ownership_status === "ownership_verified" && String(row?.project_owner_wallet || "").toLowerCase() === String(payload.walletAddress || "").toLowerCase()) return { project: row, xUser };
    throw Object.assign(new Error("Project ownership changed during X verification"), { code: "OWNERSHIP_CONFLICT" });
  }
  return { project: result.rows[0], xUser };
}

export function projectXClaimRedirect({ ok, tokenAddress, chainId = SOLANA_CHAIN_ID, errorCode = null }) {
  const url = new URL(`/token/${encodeURIComponent(String(tokenAddress || ""))}`, `${publicSiteUrl()}/`);
  url.searchParams.set("chainId", String(chainId));
  url.searchParams.set("claim", ok ? "x_verified" : "x_failed");
  if (errorCode) url.searchParams.set("claimError", String(errorCode));
  return url.toString();
}