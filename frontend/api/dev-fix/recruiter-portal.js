import crypto from "crypto";
import { ethers } from "ethers";
import { pool } from "../../server/db.js";
import { badMethod, getQuery, isAddress, isSolanaAddress, json, readJson } from "../../server/http.js";

const COOKIE_NAME = "mwz_recruiter_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NONCE_CHAIN_ID = 0;
const CHAINS = { bnb: { token: "BNB" }, solana: { token: "SOL" } };
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function methodAllowed(req, res, allowed) {
  if (allowed.includes(req.method)) return true;
  badMethod(res);
  return false;
}

function normalizeAddress(value) {
  const raw = String(value || "").trim();
  if (isSolanaAddress(raw)) return raw;
  const lower = raw.toLowerCase();
  return isAddress(lower) ? lower : "";
}

function isSolanaWallet(value) {
  return isSolanaAddress(String(value || "").trim());
}

function walletForStorage(value) {
  const wallet = normalizeAddress(value);
  return isSolanaWallet(wallet) ? wallet : wallet.toLowerCase();
}

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 12);
}

function normalizeImageUrl(value) {
  const raw = String(value || "").trim().slice(0, 1000);
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^ipfs:\/\//i.test(raw)) return raw;
  throw new Error("Squad image must be a full http(s) or ipfs URL.");
}

function schemaMissing(error) {
  return error?.code === "42P01" || error?.code === "42703";
}

function sessionSecret() {
  const secret = String(
    process.env.RECRUITER_PORTAL_SESSION_SECRET ||
      process.env.SESSION_SECRET ||
      process.env.JWT_SECRET ||
      "",
  ).trim();
  if (secret) return secret;
  // No soft fallback in production — sessions must use a real secret.
  if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
    throw new Error(
      "RECRUITER_PORTAL_SESSION_SECRET is required in production. Set it on the frontend-api Railway service.",
    );
  }
  return "memewarzone-local-dev-secret";
}

function sessionSecretOrError(res) {
  try {
    return sessionSecret();
  } catch (error) {
    json(res, 503, {
      error: String(error?.message || error),
      code: "RECRUITER_SESSION_SECRET_MISSING",
      hint: "Railway → frontend-api → Variables → set RECRUITER_PORTAL_SESSION_SECRET to a long random string, then redeploy.",
    });
    return null;
  }
}

function signPayload(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function encodeSession(data, secret) {
  const payload = Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
  return `${payload}.${signPayload(payload, secret)}`;
}

function decodeSession(token) {
  const raw = String(token || "").trim();
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  let secret;
  try {
    secret = sessionSecret();
  } catch {
    return null;
  }
  if (signPayload(payload, secret) !== sig) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data?.recruiterId || !data?.walletAddress || !data?.exp) return null;
    if (Date.now() > Number(data.exp)) return null;
    return data;
  } catch {
    return null;
  }
}

function readCookie(req, name) {
  const header = String(req.headers?.cookie || "");
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1));
  }
  return "";
}

function readBearerToken(req) {
  const header = String(req.headers?.authorization || req.headers?.Authorization || "").trim();
  return header.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
}

function isSecureRequest(req) {
  const proto = String(req.headers?.["x-forwarded-proto"] || req.protocol || "").toLowerCase();
  const host = String(req.headers?.host || "").toLowerCase();
  return proto === "https" || host.endsWith(".memewar.zone") || host.endsWith(".netlify.app") || host.endsWith(".railway.app");
}

function cookieAttributes(req, maxAgeSeconds) {
  const attrs = ["Path=/", "HttpOnly", `Max-Age=${maxAgeSeconds}`];
  if (isSecureRequest(req)) attrs.push("SameSite=None", "Secure");
  else attrs.push("SameSite=Lax");
  return attrs.join("; ");
}

function setSessionCookie(req, res, token) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(token)}; ${cookieAttributes(req, Math.floor(SESSION_TTL_MS / 1000))}`);
}

function clearSessionCookie(req, res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; ${cookieAttributes(req, 0)}`);
}

function buildAuthMessage({ walletAddress, nonce }) {
  return ["MemeWarzone Recruiter Portal", "Action: RECRUITER_PORTAL_LOGIN", `Wallet: ${walletAddress}`, `Nonce: ${nonce}`].join("\n");
}

function buildPayoutWalletMessage({ recruiterId, chain, walletAddress, nonce }) {
  return ["MemeWarzone Recruiter Payout Wallet", "Action: LINK_PAYOUT_WALLET", `RecruiterId: ${recruiterId}`, `Chain: ${chain}`, `Wallet: ${walletAddress}`, `Nonce: ${nonce}`].join("\n");
}

function base58Decode(value) {
  const raw = String(value || "").trim();
  if (!raw) return Buffer.alloc(0);
  let n = 0n;
  for (const char of raw) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index < 0) return Buffer.alloc(0);
    n = n * 58n + BigInt(index);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let out = hex === "00" ? Buffer.alloc(0) : Buffer.from(hex, "hex");
  let leadingZeros = 0;
  for (const char of raw) {
    if (char !== "1") break;
    leadingZeros += 1;
  }
  if (leadingZeros) out = Buffer.concat([Buffer.alloc(leadingZeros), out]);
  return out;
}

function verifySolanaSignature({ walletAddress, message, signature }) {
  const publicKeyBytes = base58Decode(walletAddress);
  if (publicKeyBytes.length !== 32) return false;
  const signatureBytes = Buffer.from(String(signature || ""), "base64");
  if (signatureBytes.length !== 64) return false;
  const keyObject = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]), format: "der", type: "spki" });
  return crypto.verify(null, Buffer.from(message, "utf8"), keyObject, signatureBytes);
}

function verifyWalletSignature({ walletAddress, message, signature }) {
  if (isSolanaWallet(walletAddress)) return verifySolanaSignature({ walletAddress, message, signature });
  const recovered = ethers.verifyMessage(message, signature).toLowerCase();
  return recovered === walletAddress.toLowerCase();
}

function recruiterShape(row) {
  return {
    id: Number(row.id),
    name: row.display_name || row.code,
    x_handle: row.metadata?.signup?.xHandle || row.metadata?.signup?.x_handle || "",
    telegram_handle: row.metadata?.signup?.telegram || row.metadata?.signup?.telegram_handle || "",
    wallet_address: row.metadata?.signup?.solanaWalletAddress || row.wallet_address,
    status: row.status,
    focus: row.metadata?.signup?.focus || row.metadata?.focus || null,
    recruiter_code: row.code,
    squad_image_url: row.squad_image_url || null,
    created_at: row.created_at || null,
    approved_at: row.updated_at || row.created_at || null,
  };
}

function normalizeChain(value) {
  const chain = String(value || "").trim().toLowerCase();
  return chain === "bnb" || chain === "solana" ? chain : "";
}

function normalizePayoutWallet(chain, value) {
  const raw = String(value || "").trim();
  if (chain === "bnb") return isAddress(raw.toLowerCase()) ? raw.toLowerCase() : "";
  if (chain === "solana") return isSolanaAddress(raw) ? raw : "";
  return "";
}

function rawAmount(value) {
  if (value == null) return "0";
  return String(value).replace(/\.0+$/, "");
}

function balanceStatus({ claimableRaw, pendingRaw, payoutWallet }) {
  const claimable = BigInt(claimableRaw || "0");
  const pending = BigInt(pendingRaw || "0");
  if (!payoutWallet && (claimable > 0n || pending > 0n)) return "missing_payout_wallet";
  if (claimable > 0n) return "claimable";
  if (pending > 0n) return "pending_finality";
  return payoutWallet ? "pending_finality" : "missing_payout_wallet";
}

function emptyBalance(chain, payoutWallet = null) {
  return { chain, token: CHAINS[chain].token, claimableRaw: "0", pendingRaw: "0", payoutWallet, status: payoutWallet ? "pending_finality" : "missing_payout_wallet" };
}

async function findRecruiterByWallet(walletAddress) {
  const solana = isSolanaWallet(walletAddress);
  const { rows } = await pool.query(
    `select id, wallet_address, code, display_name, is_og, status, closed_at, metadata, squad_image_url, created_at, updated_at
       from public.recruiters
      where case when $2::boolean then wallet_address = $1 or metadata #>> '{signup,solanaWalletAddress}' = $1 else lower(wallet_address) = lower($1) end
      limit 1`,
    [walletAddress, solana],
  );
  return rows[0] || null;
}

async function findRecruiterById(recruiterId) {
  const { rows } = await pool.query(
    `select id, wallet_address, code, display_name, is_og, status, closed_at, metadata, squad_image_url, created_at, updated_at
       from public.recruiters
      where id = $1
      limit 1`,
    [recruiterId],
  );
  return rows[0] || null;
}

function recruiterBoundWallets(recruiter) {
  const wallets = new Set();
  const primary = walletForStorage(recruiter?.wallet_address);
  const solanaMeta = walletForStorage(recruiter?.metadata?.signup?.solanaWalletAddress);
  const bnbMeta = walletForStorage(recruiter?.metadata?.signup?.bnbWalletAddress || recruiter?.metadata?.signup?.evmWalletAddress);
  if (primary) wallets.add(primary);
  if (solanaMeta) wallets.add(solanaMeta);
  if (bnbMeta) wallets.add(bnbMeta);
  return wallets;
}

function isPortalBlockedStatus(status) {
  const s = String(status || "").trim().toLowerCase();
  // Only hard-block closed/suspended. Empty/active/approved/inactive can use tools after wallet proof.
  return s === "closed" || s === "suspended";
}

async function getSessionRecruiter(req) {
  const session = decodeSession(readCookie(req, COOKIE_NAME) || readBearerToken(req));
  if (!session) return null;
  const recruiter = await findRecruiterById(Number(session.recruiterId));
  if (!recruiter) return null;
  const sessionWallet = walletForStorage(session.walletAddress);
  if (!sessionWallet) return null;
  // Match EVM login against wallet_address even when metadata has a Solana address.
  if (!recruiterBoundWallets(recruiter).has(sessionWallet)) return null;
  if (isPortalBlockedStatus(recruiter.status)) return null;
  return recruiter;
}

async function getSquadRows(recruiterId) {
  const { rows } = await pool.query(
    `select s.wallet_address, s.recruiter_id, coalesce(nullif(s.member_role, ''), 'member') as role, coalesce(nullif(s.link_source, ''), 'recruiter') as source, coalesce(s.joined_at, s.created_at) as bound_at
       from public.wallet_squad_memberships s
       join public.recruiters r on r.id = s.recruiter_id
       left join public.wallet_risk_profiles swr on lower(swr.wallet_address) = lower(s.wallet_address)
       left join public.wallet_risk_profiles rwr on lower(rwr.wallet_address) = lower(r.wallet_address)
      where s.recruiter_id = $1 and s.is_active = true
        and lower(s.wallet_address) <> lower(r.wallet_address)
        and not (swr.cluster_id is not null and rwr.cluster_id is not null and swr.cluster_id = rwr.cluster_id)
      order by coalesce(s.joined_at, s.created_at) desc
      limit 250`,
    [recruiterId],
  );
  return rows;
}

function summarizeSquad(rows) {
  return rows.reduce((acc, row) => {
    acc.total += 1;
    const role = String(row.role || "").trim().toLowerCase();
    if (role === "creator") {
      acc.creators += 1;
    } else if (role === "trader") {
      acc.traders += 1;
    } else if (role === "both") {
      acc.creators += 1;
      acc.traders += 1;
    } else {
      acc.unknown += 1;
    }
    return acc;
  }, { total: 0, creators: 0, traders: 0, unknown: 0 });
}

async function portalResponse(recruiter) {
  const rows = await getSquadRows(recruiter.id);
  const imageUrl = recruiter.squad_image_url || null;
  return {
    ok: true,
    recruiter: recruiterShape(recruiter),
    squad: {
      imageUrl,
      image_url: imageUrl,
      counts: summarizeSquad(rows),
      rows: rows.map((row) => ({ wallet_address: row.wallet_address, recruiter_id: Number(row.recruiter_id), recruiter_code: recruiter.code, role: row.role || "member", source: row.source || "recruiter", bound_at: row.bound_at })),
    },
  };
}

async function ensureRecruiterAccount(recruiter) {
  const wallet = walletForStorage(recruiter.metadata?.signup?.solanaWalletAddress || recruiter.wallet_address);
  const code = recruiter.code || null;
  const displayName = recruiter.display_name || code || null;
  const { rows } = await pool.query(
    `insert into public.recruiter_accounts (signup_wallet, code, display_name, status, updated_at)
     values ($1, $2, $3, 'active', now())
     on conflict (code) do update set signup_wallet = coalesce(public.recruiter_accounts.signup_wallet, excluded.signup_wallet), display_name = coalesce(excluded.display_name, public.recruiter_accounts.display_name), updated_at = now()
     returning recruiter_id, signup_wallet, code, display_name, total_estimated_usd, status`,
    [wallet, code, displayName],
  );
  return rows[0];
}

async function getBalances(recruiterId) {
  const { rows } = await pool.query(
    `with ledger as (
       select chain, token,
              coalesce(sum(amount_raw) filter (where status = 'claimable' and claim_id is null), 0)::numeric(78,0) as claimable_raw,
              coalesce(sum(amount_raw) filter (where status in ('pending', 'pending_finality')), 0)::numeric(78,0) as pending_raw
         from public.recruiter_reward_ledger
        where recruiter_id = $1
        group by chain, token
     ), wallets as (
       select chain, max(wallet_address) filter (where verified_at is not null) as payout_wallet
         from public.recruiter_payout_wallets
        where recruiter_id = $1
        group by chain
     )
     select coalesce(l.chain, w.chain) as chain,
            coalesce(l.token, case when coalesce(l.chain, w.chain) = 'solana' then 'SOL' else 'BNB' end) as token,
            coalesce(l.claimable_raw, 0)::text as claimable_raw,
            coalesce(l.pending_raw, 0)::text as pending_raw,
            w.payout_wallet
       from ledger l full join wallets w on w.chain = l.chain`,
    [recruiterId],
  );
  const byChain = new Map();
  for (const row of rows) {
    const chain = normalizeChain(row.chain);
    if (!chain) continue;
    const claimableRaw = rawAmount(row.claimable_raw);
    const pendingRaw = rawAmount(row.pending_raw);
    const payoutWallet = row.payout_wallet || null;
    byChain.set(chain, { chain, token: row.token || CHAINS[chain].token, claimableRaw, pendingRaw, payoutWallet, status: balanceStatus({ claimableRaw, pendingRaw, payoutWallet }) });
  }
  for (const chain of Object.keys(CHAINS)) if (!byChain.has(chain)) byChain.set(chain, emptyBalance(chain));
  return Array.from(byChain.values());
}

async function getClaims(recruiterId) {
  const { rows } = await pool.query(
    `select id, chain, token, amount_raw::text as amount_raw, payout_wallet, status, tx_hash, error, created_at, updated_at
       from public.recruiter_reward_claims
      where recruiter_id = $1
      order by created_at desc
      limit 50`,
    [recruiterId],
  );
  return rows.map((row) => ({ id: String(row.id), chain: row.chain, token: row.token, amountRaw: rawAmount(row.amount_raw), payoutWallet: row.payout_wallet, status: row.status, txHash: row.tx_hash || null, error: row.error || null, createdAt: row.created_at, updatedAt: row.updated_at }));
}

async function payoutResponse(recruiter) {
  const account = await ensureRecruiterAccount(recruiter);
  return { recruiterId: String(account.recruiter_id), code: account.code || recruiter.code || null, displayName: account.display_name || recruiter.display_name || null, totalEstimatedUsd: Number(account.total_estimated_usd || 0), balances: await getBalances(account.recruiter_id), claims: await getClaims(account.recruiter_id) };
}

async function saveNonce(walletAddress, nonce) {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await pool.query(
    `insert into public.auth_nonces (chain_id, address, nonce, expires_at)
     values ($1, $2, $3, $4)
     on conflict (chain_id, address)
     do update set nonce = excluded.nonce, expires_at = excluded.expires_at, used_at = null`,
    [NONCE_CHAIN_ID, walletAddress, nonce, expiresAt],
  );
  return expiresAt;
}

async function consumeNonce(walletAddress, nonce) {
  const solana = isSolanaWallet(walletAddress);
  const { rows } = await pool.query(
    `select nonce, expires_at, used_at
       from public.auth_nonces
      where chain_id = $1
        and case when $3::boolean then address = $2 else lower(address) = lower($2) end
      limit 1`,
    [NONCE_CHAIN_ID, walletAddress, solana],
  );
  const row = rows[0];
  if (!row) throw new Error("Nonce not found. Request a new recruiter login challenge.");
  if (row.used_at) throw new Error("Nonce already used. Request a new recruiter login challenge.");
  if (String(row.nonce) !== String(nonce)) throw new Error("Nonce mismatch. Request a new recruiter login challenge.");
  const exp = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (!exp || Date.now() > exp) throw new Error("Nonce expired. Request a new recruiter login challenge.");
  await pool.query(
    `update public.auth_nonces set used_at = now()
      where chain_id = $1
        and case when $3::boolean then address = $2 else lower(address) = lower($2) end`,
    [NONCE_CHAIN_ID, walletAddress, solana],
  );
}

export async function recruiterAuthNonce(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  try {
    const q = getQuery(req);
    const walletAddress = normalizeAddress(q.address);
    if (!walletAddress) return json(res, 400, { error: "Invalid or missing address" });
    const recruiter = await findRecruiterByWallet(walletAddress);
    if (!recruiter) return json(res, 403, { error: "This wallet is not an approved recruiter." });
    const nonce = crypto.randomBytes(16).toString("hex");
    await saveNonce(walletAddress, nonce);
    return json(res, 200, { nonce, message: buildAuthMessage({ walletAddress, nonce }) });
  } catch (error) {
    console.error("[api/recruiter auth nonce]", error);
    if (schemaMissing(error)) return json(res, 503, { error: "Recruiter portal schema has not been applied yet." });
    return json(res, 500, { error: "Server error" });
  }
}

export async function recruiterAuthVerify(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;
  try {
    const body = await readJson(req);
    const walletAddress = normalizeAddress(body.address);
    const signature = String(body.signature || "").trim();
    if (!walletAddress) return json(res, 400, { error: "Invalid or missing address" });
    if (!signature) return json(res, 400, { error: "Missing signature" });
    const solana = isSolanaWallet(walletAddress);
    const { rows } = await pool.query(
      `select nonce
         from public.auth_nonces
        where chain_id = $1
          and case when $3::boolean then address = $2 else lower(address) = lower($2) end
          and used_at is null
        order by expires_at desc
        limit 1`,
      [NONCE_CHAIN_ID, walletAddress, solana],
    );
    const nonce = rows[0]?.nonce;
    if (!nonce) return json(res, 401, { error: "Nonce not found. Request a new recruiter login challenge." });
    const message = buildAuthMessage({ walletAddress, nonce });
    if (!verifyWalletSignature({ walletAddress, message, signature })) return json(res, 401, { error: "Invalid signature" });
    await consumeNonce(walletAddress, nonce);
    const recruiter = await findRecruiterByWallet(walletAddress);
    if (!recruiter) return json(res, 403, { error: "This wallet is not an approved recruiter." });
    if (isPortalBlockedStatus(recruiter.status)) {
      return json(res, 403, {
        error: "Recruiter access is blocked for this account.",
        code: "RECRUITER_BLOCKED",
        status: recruiter.status || null,
        hint: "This recruiter is closed or suspended. An admin must reopen the account.",
      });
    }
    // Wallet signature proves control — heal inactive/empty status so tools unlock.
    const status = String(recruiter.status || "").trim().toLowerCase();
    if (status !== "active" && status !== "approved") {
      try {
        await pool.query(
          `update public.recruiters set status = 'active', updated_at = now() where id = $1 and lower(coalesce(status, '')) not in ('closed', 'suspended')`,
          [recruiter.id],
        );
        recruiter.status = "active";
      } catch (healErr) {
        console.warn("[api/recruiter auth verify] status heal failed", healErr?.message || healErr);
      }
    }
    const secret = sessionSecretOrError(res);
    if (!secret) return;
    const token = encodeSession(
      { recruiterId: Number(recruiter.id), walletAddress, exp: Date.now() + SESSION_TTL_MS },
      secret,
    );
    setSessionCookie(req, res, token);
    return json(res, 200, { ok: true, recruiter: recruiterShape(recruiter), sessionToken: token });
  } catch (error) {
    console.error("[api/recruiter auth verify]", error);
    const message = String(error?.message || "");
    if (/RECRUITER_PORTAL_SESSION_SECRET|session secret/i.test(message)) {
      return json(res, 503, {
        error: message,
        code: "RECRUITER_SESSION_SECRET_MISSING",
        hint: "Railway → frontend-api → Variables → set RECRUITER_PORTAL_SESSION_SECRET, redeploy.",
      });
    }
    if (/nonce|signature/i.test(message)) return json(res, 401, { error: message });
    if (schemaMissing(error)) return json(res, 503, { error: "Recruiter portal schema has not been applied yet." });
    return json(res, 500, { error: "Server error" });
  }
}

export async function recruiterPortal(req, res) {
  if (!methodAllowed(req, res, ["GET", "POST"])) return;
  try {
    const recruiter = await getSessionRecruiter(req);
    if (!recruiter) return json(res, 401, { error: "Connect your approved recruiter wallet to access the portal." });
    if (isPortalBlockedStatus(recruiter.status)) {
      return json(res, 403, {
        error: "Recruiter access is blocked for this account.",
        code: "RECRUITER_BLOCKED",
        status: recruiter.status || null,
      });
    }

    if (req.method === "GET") {
      const q = getQuery(req);
      if (String(q.action || "") === "payouts") return json(res, 200, await payoutResponse(recruiter));
      return json(res, 200, await portalResponse(recruiter));
    }

    const body = await readJson(req);
    const action = String(body.action || "").trim();

    if (action === "setCode") {
      const code = normalizeCode(body.code);
      if (code.length < 4) return json(res, 400, { error: "Code must be at least 4 characters." });
      if (code.length > 12) return json(res, 400, { error: "Code must be 12 characters or less." });
      const existing = await pool.query(`select id from public.recruiters where lower(code) = lower($1) limit 1`, [code]);
      if (existing.rows[0] && Number(existing.rows[0].id) !== Number(recruiter.id)) return json(res, 409, { error: "That code is already taken." });
      const { rows } = await pool.query(`update public.recruiters set code = lower($1), updated_at = now() where id = $2 returning code`, [code, recruiter.id]);
      return json(res, 200, { ok: true, recruiter_code: rows[0]?.code || code });
    }

    if (action === "setSquadImage") {
      const imageUrl = normalizeImageUrl(body.imageUrl);
      const { rows } = await pool.query(`update public.recruiters set squad_image_url = nullif($1, ''), updated_at = now() where id = $2 returning squad_image_url`, [imageUrl, recruiter.id]);
      return json(res, 200, { ok: true, squad_image_url: rows[0]?.squad_image_url || "" });
    }

    if (action === "linkPayoutWallet") {
      const account = await ensureRecruiterAccount(recruiter);
      const chain = normalizeChain(body.chain);
      const walletAddress = normalizePayoutWallet(chain, body.walletAddress);
      const signature = String(body.signature || "").trim();
      const nonce = String(body.nonce || crypto.randomBytes(12).toString("hex")).trim();
      if (!chain) return json(res, 400, { error: "Invalid chain. Use bnb or solana." });
      if (!walletAddress) return json(res, 400, { error: `Invalid ${chain} payout wallet.` });
      const message = buildPayoutWalletMessage({ recruiterId: String(account.recruiter_id), chain, walletAddress, nonce });
      if (!signature) return json(res, 400, { error: "Missing signature", message, nonce });
      if (!verifyWalletSignature({ walletAddress, message, signature })) return json(res, 401, { error: `Invalid ${chain === "solana" ? "Solana" : "payout wallet"} signature`, message, nonce });

      await pool.query(
        `insert into public.recruiter_payout_wallets (recruiter_id, chain, wallet_address, verified_at, verification_message, updated_at)
         values ($1, $2, $3, now(), $4, now())
         on conflict (recruiter_id, chain, wallet_address)
         do update set verified_at = now(), verification_message = excluded.verification_message, updated_at = now()`,
        [account.recruiter_id, chain, walletAddress, message],
      );
      return json(res, 200, { ok: true, chain, walletAddress, message, balances: await getBalances(account.recruiter_id) });
    }

    if (action === "createClaim") {
      // Retired 2026-09-26: this created a DB-only claim that nothing paid, and on Solana it parked
      // ledger rows where the weekly batch exporter never sees them. Claims go through
      // POST /api/recruiters/me/claims (Solana batch claim, EVM vault payout).
      return json(res, 410, { error: "Use /api/recruiters/me/claims to claim recruiter rewards.", code: "RECRUITER_CLAIM_MOVED" });
    }

    return json(res, 400, { error: "Unsupported action." });
  } catch (error) {
    console.error("[api/recruiter portal]", error);
    if (schemaMissing(error)) return json(res, 503, { error: "Recruiter payout schema has not been applied yet.", code: "PAYOUT_SCHEMA_MISSING" });
    return json(res, 500, { error: error instanceof Error ? error.message : "Server error" });
  }
}

export async function recruiterLogout(req, res) {
  clearSessionCookie(req, res);
  return json(res, 200, { ok: true });
}
