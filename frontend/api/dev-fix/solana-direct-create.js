import crypto from "node:crypto";

import { pool } from "../../server/db.js";
import { badMethod, isSolanaChain, json, readJson } from "../../server/http.js";
import { requireWalletActionAuth } from "../lib/walletActionAuth.js";
import { emitNotification } from "../lib/notifications.js";
import { getLaunchChainReadiness } from "../lib/launchChainReadiness.js";
import {
  TickerReservationError,
  canonicalClusterForChain,
  isTickerReservationSchemaMissing,
  mapTickerReservationRow,
  normalizeTicker,
  refreshExpiredTickerReservations,
  withTickerReservationTransaction,
} from "./ticker-reservation-service.js";
import { upsertCampaignFromDraft } from "./campaign-registry.js";
import {
  enforceCreatorLaunchLimits,
  loadOnchainPolicy,
  publicGeneration,
  validateDeploymentEvidence,
  validateGraduationTarget,
} from "./solana-create-authorization-v4.js";
import {
  CREATE_AUTH_SCHEMA_VERSION,
  SYSVAR_INSTRUCTIONS_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  buildCreateAuthorizationPayload,
  bytes32,
  createAuthorizationDigest,
  createEd25519Signer,
  decodeCampaignAccount,
  findProgramAddressSync,
  nonZeroBytes32,
  publicKeyBytes,
  publicKeyString,
  sha256,
  sha256Hex,
  toBigInt,
} from "./solana-v4-primitives.js";

const DIRECT_SESSION_PURPOSE = "MEMEWARZONE_SOLANA_DIRECT_SESSION_V1";
const DIRECT_FINALIZE_PURPOSE = "MEMEWARZONE_SOLANA_DIRECT_FINALIZE_V1";
const DIRECT_CAMPAIGN_ID_DOMAIN = Buffer.from("MEMEWARZONE_SOLANA_DIRECT_CAMPAIGN_ID_V1\0", "utf8");
const DIRECT_SESSION_TTL_SECONDS = 15 * 60;
const DIRECT_FINALIZE_TTL_SECONDS = 60 * 60;
const DEFAULT_AUTH_TTL_SECONDS = 10 * 60;
const MAX_AUTH_TTL_SECONDS = 60 * 60;
const PLACEHOLDER_PROGRAM_IDS = new Set([
  SYSTEM_PROGRAM_ID,
  "Fg6PaFpoGXkYsidMpWxTWqjRZ6LkZXoC3XgXvAqUixG",
]);

class SolanaDirectCreateError extends Error {
  constructor(message, { code = "SOLANA_DIRECT_CREATE_ERROR", httpStatus = 409, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SolanaDirectCreateError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function methodAllowed(req, res, allowed) {
  if (allowed.includes(req.method)) return true;
  badMethod(res);
  return false;
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new SolanaDirectCreateError(`${name} is not configured.`, {
      code: "SOLANA_CREATE_CONFIGURATION_INCOMPLETE",
      httpStatus: 503,
    });
  }
  return value;
}

function parsePositiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) return fallback;
  return Math.min(number, maximum);
}

function samePublicKey(left, right) {
  try {
    return publicKeyBytes(left).equals(publicKeyBytes(right));
  } catch {
    return false;
  }
}

function sameBytes32(left, right) {
  try {
    return bytes32(left).equals(bytes32(right));
  } catch {
    return false;
  }
}

function hex32(value) {
  return bytes32(value).toString("hex");
}

function bufferArray(value) {
  return Array.from(Buffer.from(value));
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function tokenKey() {
  const routeSecret = requiredEnv("SOLANA_ROUTE_SIGNER_SECRET_KEY");
  return crypto
    .createHash("sha256")
    .update("MEMEWARZONE_SOLANA_DIRECT_TOKEN_KEY_V1\0", "utf8")
    .update(routeSecret, "utf8")
    .digest();
}

function signOpaqueToken(payload, purpose) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto
    .createHmac("sha256", tokenKey())
    .update(`${purpose}.${body}`, "utf8")
    .digest("base64url");
  return `${body}.${signature}`;
}

function verifyOpaqueToken(token, purpose) {
  const raw = String(token || "").trim();
  const parts = raw.split(".");
  if (parts.length !== 2) {
    throw new SolanaDirectCreateError("Direct session token is invalid.", {
      code: "SOLANA_DIRECT_SESSION_INVALID",
      httpStatus: 401,
    });
  }
  const [body, signature] = parts;
  const expected = crypto
    .createHmac("sha256", tokenKey())
    .update(`${purpose}.${body}`, "utf8")
    .digest();
  let provided;
  try {
    provided = Buffer.from(signature, "base64url");
  } catch {
    provided = Buffer.alloc(0);
  }
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    throw new SolanaDirectCreateError("Direct session token signature is invalid.", {
      code: "SOLANA_DIRECT_SESSION_INVALID",
      httpStatus: 401,
    });
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new SolanaDirectCreateError("Direct session token payload is invalid.", {
      code: "SOLANA_DIRECT_SESSION_INVALID",
      httpStatus: 401,
    });
  }
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(payload?.exp) || payload.exp <= now) {
    throw new SolanaDirectCreateError("Direct session expired. Sign Direct deploy again.", {
      code: "SOLANA_DIRECT_SESSION_EXPIRED",
      httpStatus: 401,
    });
  }
  return payload;
}

export function verifySolanaDirectSessionToken(token) {
  return verifyOpaqueToken(token, DIRECT_SESSION_PURPOSE);
}

function createDirectSessionToken({ reservation, creatorWallet, chainId, cluster, ticker }) {
  const now = Math.floor(Date.now() / 1000);
  return signOpaqueToken(
    {
      v: 1,
      type: "solana_direct_session",
      reservationId: String(reservation.id),
      creatorWallet: publicKeyString(creatorWallet),
      chainId: Number(chainId),
      cluster: String(cluster),
      ticker: String(ticker),
      iat: now,
      exp: now + DIRECT_SESSION_TTL_SECONDS,
    },
    DIRECT_SESSION_PURPOSE,
  );
}

function createFinalizeToken({ reservation, creatorWallet, chainId, cluster, accounts, campaignId, generationId }) {
  const now = Math.floor(Date.now() / 1000);
  return signOpaqueToken(
    {
      v: 1,
      type: "solana_direct_finalize",
      reservationId: String(reservation.id),
      creatorWallet: publicKeyString(creatorWallet),
      chainId: Number(chainId),
      cluster: String(cluster),
      campaign: accounts.campaign,
      mint: accounts.mint,
      tokenVault: accounts.tokenVault,
      solVault: accounts.solVault,
      campaignIdHex: hex32(campaignId),
      generationIdHex: hex32(generationId),
      iat: now,
      exp: now + DIRECT_FINALIZE_TTL_SECONDS,
    },
    DIRECT_FINALIZE_PURPOSE,
  );
}

function validateProgramConfiguration(programId) {
  const canonical = publicKeyString(programId, "SOLANA_LAUNCHPAD_PROGRAM_ID");
  if (PLACEHOLDER_PROGRAM_IDS.has(canonical) && !isTruthy(process.env.SOLANA_ALLOW_PLACEHOLDER_PROGRAM_ID)) {
    throw new SolanaDirectCreateError("The configured Solana program ID is a placeholder.", {
      code: "SOLANA_PROGRAM_NOT_DEPLOYED",
      httpStatus: 503,
    });
  }
  return canonical;
}

function validateCreatorWallet(value) {
  try {
    return publicKeyString(value, "creatorWallet");
  } catch (error) {
    throw new SolanaDirectCreateError("Invalid Solana creator wallet.", {
      code: "SOLANA_DIRECT_CREATOR_INVALID",
      httpStatus: 400,
      cause: error,
    });
  }
}

function normalizeDirectMetadata(body, { creatorWallet, chainId, cluster, ticker }) {
  const name = String(body.name || "").trim();
  const logoUrl = String(body.logoUrl || "").trim();
  if (!name) {
    throw new SolanaDirectCreateError("Token name is required for Direct deploy.", {
      code: "SOLANA_DIRECT_NAME_REQUIRED",
      httpStatus: 400,
    });
  }
  if (!logoUrl) {
    throw new SolanaDirectCreateError("Token logo is required for Direct deploy.", {
      code: "SOLANA_DIRECT_LOGO_REQUIRED",
      httpStatus: 400,
    });
  }
  return {
    schemaVersion: 1,
    mode: "direct_create",
    chainId: Number(chainId),
    cluster: String(cluster),
    creatorWallet: publicKeyString(creatorWallet),
    name,
    ticker: String(ticker),
    description: String(body.description || "").trim(),
    category: String(body.category || "meme").trim() || "meme",
    logoUrl,
    websiteUrl: String(body.websiteUrl || "").trim(),
    xUrl: String(body.xUrl || "").trim(),
    telegramUrl: String(body.telegramUrl || "").trim(),
    discordUrl: String(body.discordUrl || "").trim(),
    otherUrl: String(body.otherUrl || "").trim(),
  };
}

function directCampaignId({ reservationIdHash, generationId, programId, creator }) {
  return sha256(
    DIRECT_CAMPAIGN_ID_DOMAIN,
    bytes32(reservationIdHash, "reservationIdHash"),
    bytes32(generationId, "generationId"),
    publicKeyBytes(creator, "creator"),
    publicKeyBytes(programId, "programId"),
  );
}

function deriveDirectCampaignAccounts({ reservationIdHash, generationId, programId, creator, nonce }) {
  const campaignId = directCampaignId({ reservationIdHash, generationId, programId, creator });
  const campaign = findProgramAddressSync([Buffer.from("campaign", "utf8"), campaignId], programId);
  const mint = findProgramAddressSync([Buffer.from("campaign-mint", "utf8"), campaignId], programId);
  const tokenVault = findProgramAddressSync([Buffer.from("token-vault", "utf8"), campaignId], programId);
  const solVault = findProgramAddressSync([Buffer.from("sol-vault", "utf8"), campaignId], programId);
  const createAuthorization = findProgramAddressSync(
    [Buffer.from("create-auth", "utf8"), publicKeyBytes(creator), nonce || Buffer.alloc(32)],
    programId,
  );
  return { campaignId, campaign, mint, tokenVault, solVault, createAuthorization };
}

async function rpcCall(rpcUrl, method, params = []) {
  const timeoutMs = parsePositiveInteger(process.env.SOLANA_RPC_TIMEOUT_MS, 12_000, 30_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`RPC ${method} returned HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.error) throw new Error(payload.error.message || JSON.stringify(payload.error));
    return payload?.result;
  } catch (error) {
    throw new SolanaDirectCreateError(`Solana RPC ${method} failed.`, {
      code: "SOLANA_RPC_UNAVAILABLE",
      httpStatus: 503,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function getMultipleAccounts(rpcUrl, addresses) {
  const result = await rpcCall(rpcUrl, "getMultipleAccounts", [
    addresses,
    { commitment: "confirmed", encoding: "base64" },
  ]);
  if (!result || !Array.isArray(result.value) || result.value.length !== addresses.length) {
    throw new SolanaDirectCreateError("Solana RPC returned an invalid account response.", {
      code: "SOLANA_ACCOUNT_RESPONSE_INVALID",
      httpStatus: 503,
    });
  }
  return result.value;
}

function decodeCampaignInfo(info, campaignAddress, programId) {
  if (!info || !samePublicKey(info.owner, programId)) return null;
  const encoded = Array.isArray(info.data) ? info.data[0] : null;
  if (!encoded) {
    throw new SolanaDirectCreateError(`Campaign ${campaignAddress} has no account data.`, {
      code: "SOLANA_CAMPAIGN_DATA_INVALID",
      httpStatus: 409,
    });
  }
  try {
    return decodeCampaignAccount(Buffer.from(encoded, "base64"));
  } catch (error) {
    throw new SolanaDirectCreateError(`Campaign ${campaignAddress} could not be decoded.`, {
      code: "SOLANA_CAMPAIGN_DATA_INVALID",
      httpStatus: 409,
      cause: error,
    });
  }
}

async function loadRuntime({ creatorWallet, chainId, skipCreatorLaunchLimits }) {
  if (!isTruthy(process.env.SOLANA_CREATE_AUTH_ENABLED)) {
    throw new SolanaDirectCreateError("Solana create authorization is disabled by the Railway launch gate.", {
      code: "SOLANA_CREATE_AUTH_DISABLED",
      httpStatus: 503,
    });
  }
  if (!isSolanaChain(chainId)) {
    throw new SolanaDirectCreateError("Direct Solana create requires a Solana chain id.", {
      code: "SOLANA_DIRECT_CHAIN_INVALID",
      httpStatus: 400,
    });
  }

  const configuredCluster = requiredEnv("SOLANA_CLUSTER");
  const cluster = canonicalClusterForChain(Number(chainId), configuredCluster);
  const rpcUrl = requiredEnv("SOLANA_RPC_URL");
  const programId = validateProgramConfiguration(requiredEnv("SOLANA_LAUNCHPAD_PROGRAM_ID"));
  const routeSecret = requiredEnv("SOLANA_ROUTE_SIGNER_SECRET_KEY");
  const expectedRouteSigner = publicKeyString(
    requiredEnv("SOLANA_ROUTE_SIGNER_PUBLIC_KEY"),
    "SOLANA_ROUTE_SIGNER_PUBLIC_KEY",
  );
  const signer = createEd25519Signer(routeSecret);
  if (!samePublicKey(signer.publicKey, expectedRouteSigner)) {
    throw new SolanaDirectCreateError(
      "Railway Solana route signer secret does not match SOLANA_ROUTE_SIGNER_PUBLIC_KEY.",
      { code: "SOLANA_ROUTE_SIGNER_CONFIGURATION_MISMATCH", httpStatus: 503 },
    );
  }

  const onchain = await loadOnchainPolicy({
    rpcUrl,
    programId,
    creator: creatorWallet,
    cluster,
    signer,
    skipCreatorLaunchLimits,
  });
  const deploymentEvidence = validateDeploymentEvidence(onchain.generation);
  return { cluster, rpcUrl, programId, signer, onchain, deploymentEvidence };
}

async function loadDirectReservationById(db, reservationId, { forUpdate = false } = {}) {
  const lock = forUpdate ? "for update" : "";
  const result = await db.query(
    `select *
       from public.ticker_reservations
      where id::text = $1
        and draft_id is null
      limit 1
      ${lock}`,
    [String(reservationId)],
  );
  return mapTickerReservationRow(result.rows[0]);
}

async function loadDirectReservationForTicker(db, { chainId, cluster, ticker }, { forUpdate = false } = {}) {
  const lock = forUpdate ? "for update" : "";
  const result = await db.query(
    `select *
       from public.ticker_reservations
      where draft_id is null
        and chain_id = $1
        and cluster = $2
        and normalized_ticker = $3
        and status not in ('DRAFT_UNRESERVED', 'RELEASED')
      order by created_at desc
      limit 1
      ${lock}`,
    [Number(chainId), String(cluster), String(ticker)],
  );
  return mapTickerReservationRow(result.rows[0]);
}

function isDirectReservation(reservation) {
  return reservation?.metadata?.source === "direct_create";
}

async function createOrLoadDirectReservation(db, { creatorWallet, chainId, cluster, ticker }) {
  await db.query(
    `update public.ticker_reservations
        set status = 'RELEASED',
            released_at = coalesce(released_at, now()),
            failure_reason = coalesce(failure_reason, 'Abandoned Direct session expired.'),
            updated_at = now()
      where draft_id is null
        and metadata ->> 'source' = 'direct_create'
        and status = 'ARM_AUTHORIZED'
        and grace_end_at is not null
        and grace_end_at <= now()`
  );

  await refreshExpiredTickerReservations(db, {
    chainId,
    cluster,
    normalizedTicker: ticker,
  });

  const existing = await loadDirectReservationForTicker(
    db,
    { chainId, cluster, ticker },
    { forUpdate: true },
  );
  if (existing) {
    if (!isDirectReservation(existing) || !samePublicKey(existing.creatorWallet, creatorWallet)) {
      throw new TickerReservationError("Ticker already reserved by another active launch.", {
        code: "TICKER_UNAVAILABLE",
        httpStatus: 409,
      });
    }
    return existing;
  }

  const id = crypto.randomUUID();
  try {
    const inserted = await db.query(
      `insert into public.ticker_reservations
         (id, draft_id, creator_wallet, chain_id, cluster, original_ticker, normalized_ticker,
          ticker_hash, reservation_id_hash, status, reserved_at, expires_at, grace_end_at,
          reservation_version, metadata)
       values ($1,null,$2,$3,$4,$5,$6,$7,$8,'SOFT_RESERVED',now(),now() + interval '1 hour',
               now() + interval '2 hours',1,$9::jsonb)
       returning *`,
      [
        id,
        creatorWallet,
        Number(chainId),
        cluster,
        ticker,
        ticker,
        sha256Hex(Buffer.from(ticker, "utf8")),
        sha256Hex(Buffer.from(id, "utf8")),
        JSON.stringify({ source: "direct_create" }),
      ],
    );
    const reservation = mapTickerReservationRow(inserted.rows[0]);
    await db.query(
      `insert into public.ticker_reservation_events
         (reservation_id, event_type, from_status, to_status, actor_type, actor_wallet, reason, metadata)
       values ($1,'direct_reservation_created',null,$2,'creator',$3,$4,$5::jsonb)`,
      [
        reservation.id,
        reservation.status,
        creatorWallet,
        "Direct deploy ticker reserved without creating a draft.",
        JSON.stringify({ chainId: Number(chainId), cluster, ticker }),
      ],
    );
    return reservation;
  } catch (error) {
    if (error?.code === "23505") {
      throw new TickerReservationError("Ticker already reserved by another active launch.", {
        code: "TICKER_UNAVAILABLE",
        httpStatus: 409,
        cause: error,
      });
    }
    throw error;
  }
}

function reservationDirectMetadata(reservation) {
  const value = reservation?.metadata?.directCampaign;
  return value && typeof value === "object" ? value : null;
}

async function finalizeDirectDeployment(db, {
  reservation,
  directMetadata,
  creatorWallet,
  chainId,
  cluster,
  programId,
  generationId,
  accounts,
  campaignId,
  deploymentSignature,
}) {
  const signature = String(deploymentSignature || "already-on-chain").trim() || "already-on-chain";
  const updatedResult = await db.query(
    `update public.ticker_reservations
        set status = 'LIVE',
            armed_at = coalesce(armed_at, now()),
            live_at = coalesce(live_at, now()),
            expires_at = null,
            grace_end_at = null,
            campaign_pda = $2,
            mint = $3,
            deployment_signature = coalesce(nullif(deployment_signature, ''), $4),
            program_id = coalesce(program_id, $5),
            generation_id = coalesce(generation_id, $6),
            failure_reason = null,
            metadata = metadata || $7::jsonb,
            updated_at = now()
      where id = $1
        and draft_id is null
      returning *`,
    [
      reservation.id,
      accounts.campaign,
      accounts.mint,
      signature,
      programId,
      hex32(generationId),
      JSON.stringify({
        source: "direct_create",
        directCampaign: directMetadata,
        finalizedAt: new Date().toISOString(),
      }),
    ],
  );
  const updated = mapTickerReservationRow(updatedResult.rows[0]);
  if (!updated) {
    throw new SolanaDirectCreateError("Direct reservation disappeared during finalization.", {
      code: "SOLANA_DIRECT_RESERVATION_MISSING",
      httpStatus: 409,
    });
  }

  const registry = await upsertCampaignFromDraft(db, {
    chainId: Number(chainId),
    campaignAddress: accounts.campaign,
    tokenAddress: accounts.mint,
    creatorWallet,
    name: directMetadata.name,
    symbol: directMetadata.ticker,
    logoUrl: directMetadata.logoUrl,
    deployTxHash: signature,
    factoryAddress: programId,
    programId,
    tokenVault: accounts.tokenVault,
    solVault: accounts.solVault,
    campaignId,
  });
  if (!registry?.ok || !registry?.metaMerged) {
    throw new SolanaDirectCreateError(
      `Direct campaign registry finalization failed: ${registry?.error || "Solana metadata was not persisted."}`,
      { code: "SOLANA_DIRECT_REGISTRY_FINALIZE_FAILED", httpStatus: 503 },
    );
  }

  await db.query(
    `insert into public.ticker_reservation_events
       (reservation_id, event_type, from_status, to_status, actor_type, actor_wallet, reason, metadata)
     values ($1,'direct_reservation_live',$2,'LIVE','creator',$3,$4,$5::jsonb)`,
    [
      updated.id,
      String(reservation.status || ""),
      creatorWallet,
      "Direct Solana campaign finalized without a campaign_drafts row.",
      JSON.stringify({
        campaignAddress: accounts.campaign,
        mint: accounts.mint,
        tokenVault: accounts.tokenVault,
        solVault: accounts.solVault,
        deploymentSignature: signature,
        cluster,
      }),
    ],
  );

  await emitNotification(db, {
    eventType: "campaign.created",
    chain: "solana",
    dedupKey: `campaign-created:solana:${accounts.campaign}`,
    payload: {
      chain: "solana",
      campaign: accounts.campaign,
      chainId: Number(chainId),
      name: directMetadata.name,
      createdAt: new Date().toISOString(),
    }
  });

  return { reservation: updated, registry };
}

function verifyDecodedCampaign({ decoded, accounts, campaignId, creatorWallet, generationId }) {
  if (!decoded) {
    throw new SolanaDirectCreateError("Direct campaign is not present on-chain yet.", {
      code: "SOLANA_DIRECT_CAMPAIGN_NOT_CONFIRMED",
      httpStatus: 409,
    });
  }
  if (!samePublicKey(decoded.creator, creatorWallet)) {
    throw new SolanaDirectCreateError("On-chain Direct campaign creator does not match the signed creator.", {
      code: "SOLANA_DIRECT_CAMPAIGN_CREATOR_MISMATCH",
      httpStatus: 409,
    });
  }
  if (!samePublicKey(decoded.mint, accounts.mint)) {
    throw new SolanaDirectCreateError("On-chain Direct campaign mint does not match the authorized mint.", {
      code: "SOLANA_DIRECT_CAMPAIGN_MINT_MISMATCH",
      httpStatus: 409,
    });
  }
  if (!samePublicKey(decoded.tokenVault, accounts.tokenVault) || !samePublicKey(decoded.solVault, accounts.solVault)) {
    throw new SolanaDirectCreateError("On-chain Direct campaign vaults do not match the authorization.", {
      code: "SOLANA_DIRECT_CAMPAIGN_VAULT_MISMATCH",
      httpStatus: 409,
    });
  }
  if (!sameBytes32(decoded.campaignId, campaignId) || !sameBytes32(decoded.generationId, generationId)) {
    throw new SolanaDirectCreateError("On-chain Direct campaign identity does not match the authorized generation.", {
      code: "SOLANA_DIRECT_CAMPAIGN_IDENTITY_MISMATCH",
      httpStatus: 409,
    });
  }
}

async function confirmAuthorizedAccounts({ rpcUrl, programId, accounts, campaignId, creatorWallet, generationId }) {
  const [campaignInfo, mintInfo] = await getMultipleAccounts(rpcUrl, [accounts.campaign, accounts.mint]);
  const campaignOwned = Boolean(campaignInfo && samePublicKey(campaignInfo.owner, programId));
  const mintOwned = Boolean(mintInfo && samePublicKey(mintInfo.owner, TOKEN_PROGRAM_ID));

  if (!campaignOwned && mintOwned) {
    throw new SolanaDirectCreateError(
      `Solana mint PDA ${accounts.mint} exists but campaign PDA ${accounts.campaign} does not. A prior create partially landed.`,
      { code: "SOLANA_PARTIAL_CREATE_ORPHAN", httpStatus: 409 },
    );
  }
  if (!campaignOwned) return { exists: false, decoded: null };
  if (!mintOwned) {
    throw new SolanaDirectCreateError("Direct campaign exists but its mint account is missing or invalid.", {
      code: "SOLANA_DIRECT_MINT_MISSING",
      httpStatus: 409,
    });
  }

  const decoded = decodeCampaignInfo(campaignInfo, accounts.campaign, programId);
  verifyDecodedCampaign({ decoded, accounts, campaignId, creatorWallet, generationId });
  return { exists: true, decoded };
}

function publicAccounts({ creatorWallet, onchain, pdas }) {
  return {
    creator: publicKeyString(creatorWallet),
    globalConfig: onchain.accounts.globalConfig,
    generationConfig: onchain.accounts.generationConfig,
    creatorProfile: onchain.accounts.creatorProfile,
    riskProfile: onchain.accounts.riskProfile,
    clusterProfile: onchain.accounts.clusterProfile,
    campaign: pdas.campaign.publicKey,
    mint: pdas.mint.publicKey,
    tokenVault: pdas.tokenVault.publicKey,
    solVault: pdas.solVault.publicKey,
    createAuthorization: pdas.createAuthorization.publicKey,
    instructions: SYSVAR_INSTRUCTIONS_ID,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SYSTEM_PROGRAM_ID,
  };
}

async function handlePreflight(body, res) {
  const creatorWallet = validateCreatorWallet(body.creatorWallet);
  const chainId = Number(body.chainId || 101);
  const launchReadiness = getLaunchChainReadiness(chainId);
  if (!launchReadiness.creationReady) throw new SolanaDirectCreateError("Creator deployment is not enabled for this chain.", { code: "CHAIN_CREATION_NOT_READY", httpStatus: 503 });
  // Read policy without throwing creator cooldown/live-cap so the frontend can show the same rich arm dialog as BNB.
  // Begin/authorize still enforce the limits again server-side to close races.
  const runtime = await loadRuntime({ creatorWallet, chainId, skipCreatorLaunchLimits: true });
  if (body.graduationTargetUsdMicros != null && String(body.graduationTargetUsdMicros).trim()) {
    validateGraduationTarget(
      runtime.onchain.generation,
      toBigInt(body.graduationTargetUsdMicros, "graduationTargetUsdMicros"),
    );
  }
  const profile = runtime.onchain.creatorProfile;
  const nextAllowed =
    profile.lastLaunchTimestamp > 0n
      ? Number(profile.lastLaunchTimestamp + BigInt(profile.cooldownSeconds))
      : 0;
  const cooldownActive = nextAllowed > runtime.onchain.chainNow;
  const liveLimitReached = profile.liveBondingCount >= profile.maxLiveBondingCount;
  return json(res, 200, {
    ok: true,
    chainId,
    cluster: runtime.cluster,
    programId: runtime.programId,
    preflight: {
      chainNow: runtime.onchain.chainNow,
      allowed: !cooldownActive && !liveLimitReached,
      cooldownActive,
      liveLimitReached,
      creatorTier: profile.tier,
      creatorLiveBondingCount: profile.liveBondingCount,
      creatorMaxLiveBondingCount: profile.maxLiveBondingCount,
      cooldownSeconds: profile.cooldownSeconds,
      nextAllowedAt: nextAllowed || null,
      creatorProfileImplicitDefault: Boolean(runtime.onchain.creatorProfileImplicitDefault),
      riskProfileImplicitDefault: Boolean(runtime.onchain.riskProfileImplicitDefault),
    },
  });
}

async function handleBegin(body, res) {
  const creatorWallet = validateCreatorWallet(body.creatorWallet);
  const chainId = Number(body.chainId || 101);
  const launchReadiness = getLaunchChainReadiness(chainId);
  if (!launchReadiness.creationReady) throw new SolanaDirectCreateError("Creator deployment is not enabled for this chain.", { code: "CHAIN_CREATION_NOT_READY", httpStatus: 503 });
  const ticker = normalizeTicker(body.ticker);
  if (!ticker) {
    throw new SolanaDirectCreateError("Ticker is required for Direct deploy.", {
      code: "INVALID_RESERVATION_TICKER",
      httpStatus: 400,
    });
  }

  const runtime = await loadRuntime({ creatorWallet, chainId, skipCreatorLaunchLimits: true });
  const verified = await requireWalletActionAuth({
    res,
    pool,
    auth: body.auth,
    expectedWallet: creatorWallet,
    chainId,
    action: "solana_direct_create",
    extraLines: [`Ticker: ${ticker}`],
    routeLabel: "solana/direct-create/begin",
  });
  if (!verified) return;

  const result = await withTickerReservationTransaction(pool, async (db) => {
    const reservation = await createOrLoadDirectReservation(db, {
      creatorWallet,
      chainId,
      cluster: runtime.cluster,
      ticker,
    });
    const reservationIdHash = nonZeroBytes32(reservation.reservationIdHash, "reservationIdHash");
    const pdas = deriveDirectCampaignAccounts({
      reservationIdHash,
      generationId: runtime.onchain.generation.generationId,
      programId: runtime.programId,
      creator: creatorWallet,
      nonce: Buffer.alloc(32),
    });
    const accounts = publicAccounts({ creatorWallet, onchain: runtime.onchain, pdas });
    const existing = await confirmAuthorizedAccounts({
      rpcUrl: runtime.rpcUrl,
      programId: runtime.programId,
      accounts,
      campaignId: pdas.campaignId,
      creatorWallet,
      generationId: runtime.onchain.generation.generationId,
    });

    if (existing.exists) {
      const metadata = reservationDirectMetadata(reservation);
      if (!metadata) {
        throw new SolanaDirectCreateError(
          "Direct campaign exists on-chain but its saved metadata is unavailable. Use the original session or operator recovery.",
          { code: "SOLANA_DIRECT_METADATA_MISSING", httpStatus: 409 },
        );
      }
      const finalized = await finalizeDirectDeployment(db, {
        reservation,
        directMetadata: metadata,
        creatorWallet,
        chainId,
        cluster: runtime.cluster,
        programId: runtime.programId,
        generationId: runtime.onchain.generation.generationId,
        accounts,
        campaignId: pdas.campaignId,
        deploymentSignature: reservation.deploymentSignature || "already-on-chain",
      });
      return {
        alreadyOnChain: true,
        reservation: finalized.reservation,
        accounts,
        tokenPath: `/token/${encodeURIComponent(accounts.mint)}`,
      };
    }

    // Only a truly fresh Direct launch is subject to the creator cooldown/live cap.
    enforceCreatorLaunchLimits(runtime.onchain.creatorProfile, runtime.onchain.chainNow);
    const sessionToken = createDirectSessionToken({
      reservation,
      creatorWallet,
      chainId,
      cluster: runtime.cluster,
      ticker,
    });
    return { alreadyOnChain: false, reservation, sessionToken, accounts };
  });

  return json(res, 200, {
    ok: true,
    ...result,
    chainId,
    cluster: runtime.cluster,
    programId: runtime.programId,
  });
}

async function handleAuthorize(body, res) {
  const session = verifySolanaDirectSessionToken(body.sessionToken);
  const creatorWallet = validateCreatorWallet(session.creatorWallet);
  const chainId = Number(session.chainId);
  const launchReadiness = getLaunchChainReadiness(chainId);
  if (!launchReadiness.creationReady) throw new SolanaDirectCreateError("Creator deployment is not enabled for this chain.", { code: "CHAIN_CREATION_NOT_READY", httpStatus: 503 });
  const ticker = normalizeTicker(session.ticker);
  const runtime = await loadRuntime({ creatorWallet, chainId, skipCreatorLaunchLimits: true });
  if (runtime.cluster !== session.cluster) {
    throw new SolanaDirectCreateError("Direct session cluster no longer matches Railway configuration.", {
      code: "SOLANA_DIRECT_CLUSTER_MISMATCH",
      httpStatus: 409,
    });
  }

  const graduationTarget = toBigInt(body.graduationTargetUsdMicros, "graduationTargetUsdMicros");
  validateGraduationTarget(runtime.onchain.generation, graduationTarget);
  const directMetadata = normalizeDirectMetadata(body, {
    creatorWallet,
    chainId,
    cluster: runtime.cluster,
    ticker,
  });
  const ttlSeconds = parsePositiveInteger(
    process.env.SOLANA_CREATE_AUTH_TTL_SECONDS,
    DEFAULT_AUTH_TTL_SECONDS,
    MAX_AUTH_TTL_SECONDS,
  );
  const deadline = BigInt(runtime.onchain.chainNow + ttlSeconds);
  const clusterHash = nonZeroBytes32(requiredEnv("SOLANA_CLUSTER_HASH_HEX"), "SOLANA_CLUSTER_HASH_HEX");

  const authorized = await withTickerReservationTransaction(pool, async (db) => {
    const reservation = await loadDirectReservationById(db, session.reservationId, { forUpdate: true });
    if (!reservation || !isDirectReservation(reservation)) {
      throw new SolanaDirectCreateError("Direct reservation is missing or has been released.", {
        code: "SOLANA_DIRECT_RESERVATION_MISSING",
        httpStatus: 409,
      });
    }
    if (!samePublicKey(reservation.creatorWallet, creatorWallet)) {
      throw new SolanaDirectCreateError("Direct reservation owner does not match the signed session.", {
        code: "SOLANA_DIRECT_OWNER_MISMATCH",
        httpStatus: 401,
      });
    }
    if (reservation.cluster !== runtime.cluster || reservation.normalizedTicker !== ticker) {
      throw new SolanaDirectCreateError("Direct reservation no longer matches the signed session.", {
        code: "SOLANA_DIRECT_RESERVATION_MISMATCH",
        httpStatus: 409,
      });
    }

    const reservationIdHash = nonZeroBytes32(reservation.reservationIdHash, "reservationIdHash");
    const recoveryPdas = deriveDirectCampaignAccounts({
      reservationIdHash,
      generationId: runtime.onchain.generation.generationId,
      programId: runtime.programId,
      creator: creatorWallet,
      nonce: Buffer.alloc(32),
    });
    const recoveryAccounts = publicAccounts({ creatorWallet, onchain: runtime.onchain, pdas: recoveryPdas });
    const existing = await confirmAuthorizedAccounts({
      rpcUrl: runtime.rpcUrl,
      programId: runtime.programId,
      accounts: recoveryAccounts,
      campaignId: recoveryPdas.campaignId,
      creatorWallet,
      generationId: runtime.onchain.generation.generationId,
    });
    if (existing.exists) {
      const finalized = await finalizeDirectDeployment(db, {
        reservation,
        directMetadata,
        creatorWallet,
        chainId,
        cluster: runtime.cluster,
        programId: runtime.programId,
        generationId: runtime.onchain.generation.generationId,
        accounts: recoveryAccounts,
        campaignId: recoveryPdas.campaignId,
        deploymentSignature: reservation.deploymentSignature || "already-on-chain",
      });
      return {
        alreadyOnChain: true,
        reservation: finalized.reservation,
        accounts: recoveryAccounts,
        tokenPath: `/token/${encodeURIComponent(recoveryAccounts.mint)}`,
      };
    }

    enforceCreatorLaunchLimits(runtime.onchain.creatorProfile, runtime.onchain.chainNow);

    const nonce = crypto.randomBytes(32);
    const nextVersion = BigInt(reservation.reservationVersion) + 1n;
    const authorizationNonce = BigInt(`0x${nonce.toString("hex")}`).toString();
    const updatedResult = await db.query(
      `update public.ticker_reservations
          set status = 'ARM_AUTHORIZED',
              arm_authorized_at = now(),
              authorization_nonce = $2,
              reservation_version = $3,
              program_id = $4,
              generation_id = $5,
              failure_reason = null,
              expires_at = now() + interval '1 hour',
              grace_end_at = now() + interval '2 hours',
              metadata = metadata || $6::jsonb,
              updated_at = now()
        where id = $1
          and draft_id is null
        returning *`,
      [
        reservation.id,
        authorizationNonce,
        nextVersion.toString(),
        runtime.programId,
        hex32(runtime.onchain.generation.generationId),
        JSON.stringify({
          source: "direct_create",
          directCampaign: directMetadata,
          solanaAuthorizationSchemaVersion: CREATE_AUTH_SCHEMA_VERSION,
          solanaCluster: runtime.cluster,
        }),
      ],
    );
    const updated = mapTickerReservationRow(updatedResult.rows[0]);
    if (!updated) {
      throw new SolanaDirectCreateError("Direct reservation authorization update failed.", {
        code: "SOLANA_DIRECT_AUTHORIZATION_FAILED",
        httpStatus: 409,
      });
    }

    const pdas = deriveDirectCampaignAccounts({
      reservationIdHash,
      generationId: runtime.onchain.generation.generationId,
      programId: runtime.programId,
      creator: creatorWallet,
      nonce,
    });
    const accounts = publicAccounts({ creatorWallet, onchain: runtime.onchain, pdas });
    const metadataHash = sha256(Buffer.from(canonicalJson(directMetadata), "utf8"));
    const tickerHash = nonZeroBytes32(updated.tickerHash, "tickerHash");
    const args = {
      campaignId: pdas.campaignId,
      metadataHash,
      clusterHash,
      tickerHash,
      reservationIdHash,
      reservationVersion: BigInt(updated.reservationVersion),
      launchAt: 0n,
      graduationTargetUsdMicros: graduationTarget,
      deadline,
      nonce,
    };
    const authorizationInput = {
      programId: runtime.programId,
      generationConfigKey: runtime.onchain.accounts.generationConfig,
      generation: runtime.onchain.generation,
      creator: creatorWallet,
      riskClusterId: runtime.onchain.riskProfile.clusterId,
      creatorBuyLockSeconds: runtime.onchain.creatorProfile.creatorBuyLockSeconds,
      creatorBuyCapBps: runtime.onchain.creatorProfile.creatorBuyCapBps,
      campaign: accounts.campaign,
      mint: accounts.mint,
      tokenVault: accounts.tokenVault,
      solVault: accounts.solVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      args,
    };
    const canonicalPayload = buildCreateAuthorizationPayload(authorizationInput);
    const digest = createAuthorizationDigest(authorizationInput);
    const signature = runtime.signer.sign(digest);
    if (!runtime.signer.verify(digest, signature)) {
      throw new SolanaDirectCreateError("Railway failed to verify its own Solana Direct signature.", {
        code: "SOLANA_ROUTE_SIGNATURE_INVALID",
        httpStatus: 503,
      });
    }

    const createArgs = {
      campaignId: bufferArray(args.campaignId),
      metadataHash: bufferArray(args.metadataHash),
      clusterHash: bufferArray(args.clusterHash),
      tickerHash: bufferArray(args.tickerHash),
      reservationIdHash: bufferArray(args.reservationIdHash),
      reservationVersion: args.reservationVersion.toString(),
      launchAt: "0",
      graduationTargetUsdMicros: args.graduationTargetUsdMicros.toString(),
      deadline: args.deadline.toString(),
      nonce: bufferArray(args.nonce),
    };
    const finalizeToken = createFinalizeToken({
      reservation: updated,
      creatorWallet,
      chainId,
      cluster: runtime.cluster,
      accounts,
      campaignId: pdas.campaignId,
      generationId: runtime.onchain.generation.generationId,
    });

    await db.query(
      `insert into public.ticker_reservation_events
         (reservation_id, event_type, from_status, to_status, actor_type, actor_wallet, reason, metadata)
       values ($1,'solana_direct_create_authorized',$2,'ARM_AUTHORIZED','route_signer',$3,$4,$5::jsonb)`,
      [
        updated.id,
        String(reservation.status || ""),
        creatorWallet,
        "Solana V4 Direct create authorization issued without a draft.",
        JSON.stringify({
          schemaVersion: CREATE_AUTH_SCHEMA_VERSION,
          programId: runtime.programId,
          cluster: runtime.cluster,
          generationIdHex: hex32(runtime.onchain.generation.generationId),
          campaign: accounts.campaign,
          mint: accounts.mint,
          reservationVersion: updated.reservationVersion,
          deadline: deadline.toString(),
          digestHex: digest.toString("hex"),
          idlSha256: runtime.deploymentEvidence.idlSha256,
          programBinarySha256: runtime.deploymentEvidence.programBinarySha256,
        }),
      ],
    );

    return {
      alreadyOnChain: false,
      reservation: updated,
      finalizeToken,
      response: {
        schemaVersion: CREATE_AUTH_SCHEMA_VERSION,
        mode: "direct_create",
        cluster: runtime.cluster,
        programId: runtime.programId,
        createArgs,
        accounts,
        authorization: {
          signedMessageMode: "sha256_canonical_payload",
          signedMessageLengthBytes: digest.length,
          canonicalPayloadLengthBytes: canonicalPayload.length,
          digestHex: digest.toString("hex"),
          digestBase64: digest.toString("base64"),
          signatureBase64: signature.toString("base64"),
          routeSigner: runtime.signer.publicKeyBase58,
          deadline: deadline.toString(),
          validUntil: new Date(Number(deadline) * 1000).toISOString(),
          ed25519InstructionMustImmediatelyPrecedeCreate: true,
          railwayTransactionCosignerRequired: false,
        },
        generation: publicGeneration(runtime.onchain.generation),
        deploymentEvidence: runtime.deploymentEvidence,
        metadata: {
          canonical: directMetadata,
          canonicalJsonSha256: sha256Hex(Buffer.from(canonicalJson(directMetadata), "utf8")),
        },
        tickerReservation: updated,
        preflight: {
          chainNow: runtime.onchain.chainNow,
          creatorTier: runtime.onchain.creatorProfile.tier,
          creatorLiveBondingCount: runtime.onchain.creatorProfile.liveBondingCount,
          creatorMaxLiveBondingCount: runtime.onchain.creatorProfile.maxLiveBondingCount,
          creatorProfileImplicitDefault: Boolean(runtime.onchain.creatorProfileImplicitDefault),
          riskProfileImplicitDefault: Boolean(runtime.onchain.riskProfileImplicitDefault),
        },
        transaction: null,
        transactionPolicy: "Creator wallet constructs and signs the Direct transaction. Railway signs only the 32-byte V4 digest.",
      },
    };
  });

  if (authorized.alreadyOnChain) {
    return json(res, 200, {
      ok: true,
      alreadyOnChain: true,
      accounts: authorized.accounts,
      tokenPath: authorized.tokenPath,
      tickerReservation: authorized.reservation,
    });
  }
  return json(res, 200, {
    ok: true,
    ...authorized.response,
    finalizeToken: authorized.finalizeToken,
  });
}

async function handleFinalize(body, res) {
  const token = verifyOpaqueToken(body.finalizeToken, DIRECT_FINALIZE_PURPOSE);
  const creatorWallet = validateCreatorWallet(token.creatorWallet);
  const chainId = Number(token.chainId);
  const cluster = canonicalClusterForChain(chainId, requiredEnv("SOLANA_CLUSTER"));
  if (cluster !== token.cluster) {
    throw new SolanaDirectCreateError("Finalize token cluster no longer matches Railway configuration.", {
      code: "SOLANA_DIRECT_CLUSTER_MISMATCH",
      httpStatus: 409,
    });
  }
  const rpcUrl = requiredEnv("SOLANA_RPC_URL");
  const programId = validateProgramConfiguration(requiredEnv("SOLANA_LAUNCHPAD_PROGRAM_ID"));
  const campaignId = bytes32(token.campaignIdHex, "campaignIdHex");
  const generationId = bytes32(token.generationIdHex, "generationIdHex");
  const accounts = {
    campaign: publicKeyString(token.campaign),
    mint: publicKeyString(token.mint),
    tokenVault: publicKeyString(token.tokenVault),
    solVault: publicKeyString(token.solVault),
  };

  const [campaignInfo, mintInfo] = await getMultipleAccounts(rpcUrl, [accounts.campaign, accounts.mint]);
  if (!campaignInfo || !samePublicKey(campaignInfo.owner, programId)) {
    throw new SolanaDirectCreateError("Direct campaign transaction is not confirmed on-chain yet.", {
      code: "SOLANA_DIRECT_CAMPAIGN_NOT_CONFIRMED",
      httpStatus: 409,
    });
  }
  if (!mintInfo || !samePublicKey(mintInfo.owner, TOKEN_PROGRAM_ID)) {
    throw new SolanaDirectCreateError("Direct mint is not confirmed on-chain yet.", {
      code: "SOLANA_DIRECT_MINT_NOT_CONFIRMED",
      httpStatus: 409,
    });
  }
  const decoded = decodeCampaignInfo(campaignInfo, accounts.campaign, programId);
  verifyDecodedCampaign({ decoded, accounts, campaignId, creatorWallet, generationId });

  const finalized = await withTickerReservationTransaction(pool, async (db) => {
    const reservation = await loadDirectReservationById(db, token.reservationId, { forUpdate: true });
    if (!reservation || !isDirectReservation(reservation)) {
      throw new SolanaDirectCreateError("Direct reservation is missing.", {
        code: "SOLANA_DIRECT_RESERVATION_MISSING",
        httpStatus: 409,
      });
    }
    if (!samePublicKey(reservation.creatorWallet, creatorWallet)) {
      throw new SolanaDirectCreateError("Direct reservation creator mismatch.", {
        code: "SOLANA_DIRECT_OWNER_MISMATCH",
        httpStatus: 401,
      });
    }
    const directMetadata = reservationDirectMetadata(reservation);
    if (!directMetadata) {
      throw new SolanaDirectCreateError("Direct metadata is missing from the reservation.", {
        code: "SOLANA_DIRECT_METADATA_MISSING",
        httpStatus: 409,
      });
    }
    return finalizeDirectDeployment(db, {
      reservation,
      directMetadata,
      creatorWallet,
      chainId,
      cluster,
      programId,
      generationId,
      accounts,
      campaignId,
      deploymentSignature: String(body.deployTxHash || "").trim() || "already-on-chain",
    });
  });

  return json(res, 200, {
    ok: true,
    campaignAddress: accounts.campaign,
    mintAddress: accounts.mint,
    tokenVault: accounts.tokenVault,
    solVault: accounts.solVault,
    tokenPath: `/token/${encodeURIComponent(accounts.mint)}`,
    tickerReservation: finalized.reservation,
    registryUpserted: true,
    registryMetaMerged: true,
  });
}

export async function solanaDirectCreateV4(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;
  try {
    const body = await readJson(req);
    const operation = String(body.operation || "").trim().toLowerCase();
    if (operation === "preflight") return handlePreflight(body, res);
    if (operation === "begin") return handleBegin(body, res);
    if (operation === "authorize") return handleAuthorize(body, res);
    if (operation === "finalize") return handleFinalize(body, res);
    throw new SolanaDirectCreateError("Unknown Solana Direct operation.", {
      code: "SOLANA_DIRECT_OPERATION_INVALID",
      httpStatus: 400,
    });
  } catch (error) {
    if (isTickerReservationSchemaMissing(error)) {
      return json(res, 503, {
        error: "Solana Direct create requires the canonical ticker reservation schema in Postgres.",
        code: "SOLANA_DIRECT_RESERVATION_SCHEMA_MISSING",
      });
    }
    if (error instanceof SolanaDirectCreateError || error instanceof TickerReservationError || error?.httpStatus) {
      return json(res, error.httpStatus || 409, {
        error: String(error.message || error),
        code: error.code || "SOLANA_DIRECT_CREATE_ERROR",
      });
    }
    console.error("[solana-direct-create] failed", error);
    return json(res, 500, {
      error: "Solana Direct create failed.",
      code: "SOLANA_DIRECT_CREATE_INTERNAL_ERROR",
    });
  }
}
