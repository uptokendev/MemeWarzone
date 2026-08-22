/**
 * Solana V1 bonding trade authorization (buy exact SOL in / sell exact tokens in).
 * Signs a 32-byte digest for Ed25519 verify immediately before buy_tokens / sell_tokens.
 * Fail-closed until SOLANA_TRADE_AUTH_ENABLED=true.
 *
 * Digest layout matches programs/memewarzone_solana/src/authorized_trade.rs:
 *   TRADE_AUTH_DOMAIN | u16 schema | program_id | campaign | mint | trader |
 *   u8 side | u64 amount_in | u64 min_out | i64 deadline | nonce[32] |
 *   u64 native_target | u8 route_profile
 *
 * Vault resolution order:
 *   1. Client-provided tokenVault / solVault / campaignId
 *   2. campaigns.meta.solana (persisted at create/mark-deploy)
 *   3. RPC decode of Campaign account → token_vault / sol_vault / campaign_id
 */
import crypto from "node:crypto";

import { pool } from "../../server/db.js";
import { badMethod, isSolanaChain, json, readJson, isSolanaAddress } from "../../server/http.js";
import {
  resolveCampaignByAddress,
  solanaMetaFromRow,
  normalizeCampaignIdHex,
} from "./campaign-registry.js";
import { getSolanaChainUnixTime } from "./solana-chain-unix-time.js";
import {
  SYSVAR_INSTRUCTIONS_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createEd25519Signer,
  decodeCampaignAccount,
  decodeCampaignCurveFields,
  decodeClusterProfile,
  decodeGlobalConfig,
  decodeRiskProfile,
  findProgramAddressSync,
  nativeTargetLamportsFromUsd,
  publicKeyBytes,
  publicKeyString,
  sha256,
  toBigInt,
  u16,
  u64,
  u8,
  i64,
} from "./solana-v4-primitives.js";

const TRADE_AUTH_DOMAIN = Buffer.from("MEMEWARZONE_SOLANA_TRADE_V1", "utf8");
const TRADE_AUTH_SCHEMA_VERSION = 3;
const ROUTE_PROFILE_LINKED = 0;
const ROUTE_PROFILE_UNLINKED = 1;
const ROUTE_PROFILE_OG = 2;
const TRADE_SIDE_BUY = 1;
const TRADE_SIDE_SELL = 2;
const DEFAULT_AUTH_TTL_SECONDS = 5 * 60;
const MAX_AUTH_TTL_SECONDS = 30 * 60;
const TRADE_AUTH_SEED = Buffer.from("trade-auth", "utf8");
const TOKEN_VAULT_SEED = Buffer.from("token-vault", "utf8");
const SOL_VAULT_SEED = Buffer.from("sol-vault", "utf8");
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const REWARDS_TREASURY_PROGRAM_ID = String(
  process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID || "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX",
).trim();
const LEAGUE_VAULT_SEED = Buffer.from("league_vault", "utf8");
const AIRDROP_VAULT_SEED = Buffer.from("airdrop_vault", "utf8");
const FEE_ESCROW_SEED = Buffer.from("fee-escrow", "utf8");

function deriveRewardsVaults() {
  if (!REWARDS_TREASURY_PROGRAM_ID) return { leagueVault: null, airdropVault: null, programId: "" };
  const pid = REWARDS_TREASURY_PROGRAM_ID;
  return {
    programId: pid,
    leagueVault: findProgramAddressSync([LEAGUE_VAULT_SEED], pid).publicKey,
    airdropVault: findProgramAddressSync([AIRDROP_VAULT_SEED], pid).publicKey,
    monthlyLeagueVault: findProgramAddressSync([Buffer.from("monthly_league_vault")], pid).publicKey,
    recruiterVault: findProgramAddressSync([Buffer.from("recruiter_vault")], pid).publicKey,
    squadVault: findProgramAddressSync([Buffer.from("squad_vault")], pid).publicKey,
    protocolVault: findProgramAddressSync([Buffer.from("protocol_vault")], pid).publicKey,
  };
}

function rewardVaultAddressList(vaults) {
  return [
    vaults.leagueVault,
    vaults.airdropVault,
    vaults.monthlyLeagueVault,
    vaults.recruiterVault,
    vaults.squadVault,
    vaults.protocolVault,
  ];
}

async function assertTradeGlobalPreflight({ rpcUrl, programId, expectedRouteSigner, signerPublicKey, side }) {
  const globalConfig = findProgramAddressSync([Buffer.from("global", "utf8")], programId).publicKey;
  const info = await rpcCall(rpcUrl, "getAccountInfo", [
    globalConfig,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  const b64 = info?.value?.data?.[0];
  if (!b64) {
    throw new SolanaTradeAuthorizationError("GlobalConfig account is missing on-chain.", {
      code: "SOLANA_GLOBAL_CONFIG_MISSING",
      httpStatus: 503,
    });
  }

  const global = decodeGlobalConfig(Buffer.from(b64, "base64"));
  if (global.paused) {
    throw new SolanaTradeAuthorizationError("Solana launchpad is globally paused.", {
      code: "SOLANA_LAUNCHPAD_PAUSED",
      httpStatus: 503,
    });
  }
  if (side === TRADE_SIDE_BUY && global.buyPaused) {
    throw new SolanaTradeAuthorizationError("Solana bonding buys are paused.", {
      code: "SOLANA_BUYS_PAUSED",
      httpStatus: 503,
    });
  }
  if (side === TRADE_SIDE_SELL && global.sellPaused) {
    throw new SolanaTradeAuthorizationError("Solana bonding sells are paused.", {
      code: "SOLANA_SELLS_PAUSED",
      httpStatus: 503,
    });
  }
  if (!global.securityDefaultsLocked || !global.routeAuthorizationRequired || !global.authorizedTradingRequired) {
    throw new SolanaTradeAuthorizationError("Solana trade security defaults are not locked to signed authorization.", {
      code: "SOLANA_TRADE_SECURITY_NOT_LOCKED",
      httpStatus: 503,
    });
  }

  const onChainRouteSigner = publicKeyString(global.routeSigner, "GlobalConfig.routeSigner");
  if (!samePublicKey(onChainRouteSigner, expectedRouteSigner) || !samePublicKey(onChainRouteSigner, signerPublicKey)) {
    throw new SolanaTradeAuthorizationError("Configured trade signer does not match GlobalConfig.route_signer.", {
      code: "SOLANA_ROUTE_SIGNER_ONCHAIN_MISMATCH",
      httpStatus: 503,
    });
  }

  return { globalConfig, onChainRouteSigner };
}

async function assertRewardVaultPreflight(rpcUrl, rewardsVaults) {
  const addresses = rewardVaultAddressList(rewardsVaults);
  if (addresses.some((address) => !address)) {
    throw new SolanaTradeAuthorizationError("The six Solana reward vault addresses could not be resolved.", {
      code: "SOLANA_REWARD_VAULT_CONFIGURATION_INCOMPLETE",
      httpStatus: 503,
    });
  }

  const result = await rpcCall(rpcUrl, "getMultipleAccounts", [
    addresses,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  const accounts = result?.value;
  if (!Array.isArray(accounts) || accounts.length !== addresses.length) {
    throw new SolanaTradeAuthorizationError("Solana RPC did not return all six reward vault accounts.", {
      code: "SOLANA_REWARD_VAULTS_UNAVAILABLE",
      httpStatus: 503,
    });
  }

  const missing = accounts
    .map((account, index) => (!account || Number(account.lamports || 0) <= 0 ? addresses[index] : null))
    .filter(Boolean);
  if (missing.length > 0) {
    throw new SolanaTradeAuthorizationError(`Solana reward vaults are not initialized: ${missing.join(", ")}`, {
      code: "SOLANA_REWARD_VAULTS_NOT_READY",
      httpStatus: 503,
    });
  }
}

function deriveFeeEscrow(programId, campaignAddress) {
  return findProgramAddressSync(
    [FEE_ESCROW_SEED, publicKeyBytes(campaignAddress)],
    programId,
  ).publicKey;
}

async function assertFeeEscrowPreflight(rpcUrl, programId, campaignAddress) {
  const feeEscrow = deriveFeeEscrow(programId, campaignAddress);
  const info = await rpcCall(rpcUrl, "getAccountInfo", [
    feeEscrow,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  const owner = info?.value?.owner ? String(info.value.owner) : "";
  const dataLen = info?.value?.data?.[0]
    ? Buffer.from(info.value.data[0], "base64").length
    : 0;
  if (!info?.value || owner !== programId || dataLen < 8) {
    throw new SolanaTradeAuthorizationError("market initializing", {
      code: "SOLANA_MARKET_INITIALIZING",
      httpStatus: 409,
    });
  }
  return feeEscrow;
}

async function resolveTraderClusterProfile(rpcUrl, programId, traderAddress) {
  const emptyClusterId = Buffer.alloc(32);
  const riskPda = findProgramAddressSync(
    [Buffer.from("risk", "utf8"), publicKeyBytes(traderAddress)],
    programId,
  );
  const riskInfo = await rpcCall(rpcUrl, "getAccountInfo", [
    riskPda.publicKey,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  let clusterId = emptyClusterId;
  const riskB64 = riskInfo?.value?.data?.[0];
  if (riskB64) {
    const risk = decodeRiskProfile(Buffer.from(riskB64, "base64"));
    if (risk.restricted) {
      throw new SolanaTradeAuthorizationError("Trader wallet is restricted from bonding trades.", {
        code: "SOLANA_WALLET_RESTRICTED",
        httpStatus: 403,
      });
    }
    if (risk.manualReviewRequired) {
      throw new SolanaTradeAuthorizationError("Trader wallet requires manual review before bonding trades.", {
        code: "SOLANA_WALLET_MANUAL_REVIEW",
        httpStatus: 403,
      });
    }
    clusterId = Buffer.from(risk.clusterId);
  }
  const clusterPda = findProgramAddressSync(
    [Buffer.from("cluster", "utf8"), clusterId],
    programId,
  );
  if (!clusterId.equals(emptyClusterId)) {
    const clusterInfo = await rpcCall(rpcUrl, "getAccountInfo", [
      clusterPda.publicKey,
      { encoding: "base64", commitment: "confirmed" },
    ]);
    const clusterB64 = clusterInfo?.value?.data?.[0];
    if (!clusterB64) {
      throw new SolanaTradeAuthorizationError("Trader cluster profile is missing on-chain.", {
        code: "SOLANA_CLUSTER_PROFILE_MISSING",
        httpStatus: 409,
      });
    }
    const cluster = decodeClusterProfile(Buffer.from(clusterB64, "base64"));
    if (cluster.restricted) {
      throw new SolanaTradeAuthorizationError("Trader cluster is restricted from bonding trades.", {
        code: "SOLANA_CLUSTER_RESTRICTED",
        httpStatus: 403,
      });
    }
  }
  return clusterPda.publicKey;
}

async function resolveRouteProfile(walletAddress) {
  if (!pool || !walletAddress) return ROUTE_PROFILE_UNLINKED;
  try {
    const { rows } = await pool.query(
      `select r.is_og
         from public.wallet_recruiter_links l
         join public.recruiters r
           on r.id = l.recruiter_id
        where l.wallet_address = $1
        limit 1`,
      [walletAddress],
    );
    if (!rows[0]) return ROUTE_PROFILE_UNLINKED;
    return rows[0].is_og ? ROUTE_PROFILE_OG : ROUTE_PROFILE_LINKED;
  } catch {
    return ROUTE_PROFILE_UNLINKED;
  }
}

class SolanaTradeAuthorizationError extends Error {
  constructor(message, { code = "SOLANA_TRADE_AUTHORIZATION_ERROR", httpStatus = 409, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SolanaTradeAuthorizationError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function normalizeHex32(value) {
  const normalized = String(value || "").trim().replace(/^0x/i, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new SolanaTradeAuthorizationError(`${name} is not configured.`, {
      code: "SOLANA_TRADE_CONFIGURATION_INCOMPLETE",
      httpStatus: 503,
    });
  }
  return value;
}

function parsePositiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(maximum, Math.trunc(n));
}

function methodAllowed(req, res, allowed) {
  if (allowed.includes(req.method)) return true;
  badMethod(res);
  return false;
}

function samePublicKey(left, right) {
  try {
    return publicKeyBytes(left).equals(publicKeyBytes(right));
  } catch {
    return false;
  }
}

async function rpcCall(rpcUrl, method, params) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = await response.json().catch(() => ({}));
  if (payload.error) {
    throw new SolanaTradeAuthorizationError(`Solana RPC ${method} failed: ${payload.error.message || "unknown"}`, {
      code: "SOLANA_RPC_ERROR",
      httpStatus: 503,
    });
  }
  return payload.result;
}

async function getChainUnixTime(rpcUrl) {
  try {
    return await getSolanaChainUnixTime(rpcUrl);
  } catch (error) {
    throw new SolanaTradeAuthorizationError(error instanceof Error ? error.message : String(error), {
      code: "SOLANA_CHAIN_TIME_UNAVAILABLE",
      httpStatus: 503,
      cause: error,
    });
  }
}

function findAssociatedTokenAddress(owner, mint) {
  return findProgramAddressSync(
    [publicKeyBytes(owner), publicKeyBytes(TOKEN_PROGRAM_ID), publicKeyBytes(mint)],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

function parseCampaignId(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value) && value.length === 32) return value;
  if (Array.isArray(value) && value.length === 32) return Buffer.from(value);
  const raw = String(value).replace(/^0x/i, "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  return null;
}

function vaultsFromCampaignId(campaignId, programId) {
  if (!campaignId) return { tokenVault: null, solVault: null };
  return {
    tokenVault: findProgramAddressSync([TOKEN_VAULT_SEED, campaignId], programId).publicKey,
    solVault: findProgramAddressSync([SOL_VAULT_SEED, campaignId], programId).publicKey,
  };
}

/**
 * Resolve tokenVault/solVault for a trade:
 * body → campaigns.meta.solana → RPC Campaign account decode (+ optional PDA derive).
 * When the client passes a mint as campaignAddress, DB lookup recovers the campaign PDA.
 */
async function resolveTradeVaults({
  body,
  chainId,
  campaignAddress,
  mintAddress,
  programId,
  rpcUrl,
}) {
  let tokenVault = body.tokenVault ? publicKeyString(body.tokenVault, "tokenVault") : null;
  let solVault = body.solVault ? publicKeyString(body.solVault, "solVault") : null;
  let campaignId = parseCampaignId(body.campaignId ?? body.campaignIdHex);
  let source = "client";
  /** Prefer registry campaign PDA for RPC decode (URL may be mint). */
  let rpcCampaignAddress = campaignAddress;

  if (tokenVault && solVault) {
    return {
      tokenVault,
      solVault,
      campaignId,
      campaignIdHex: campaignId ? campaignId.toString("hex") : null,
      source,
      rpcCampaignAddress,
    };
  }

  // DB meta (persisted at create / mark-deploy).
  if (!tokenVault || !solVault || !campaignId) {
    try {
      const row =
        (await resolveCampaignByAddress(pool, { chainId, address: campaignAddress })) ||
        (mintAddress && mintAddress !== campaignAddress
          ? await resolveCampaignByAddress(pool, { chainId, address: mintAddress })
          : null);
      if (row?.campaign_address) {
        rpcCampaignAddress = String(row.campaign_address).trim() || rpcCampaignAddress;
      }
      const meta = solanaMetaFromRow(row);
      if (meta) {
        if (!campaignId && meta.campaignIdHex) campaignId = parseCampaignId(meta.campaignIdHex);
        if (!tokenVault && meta.tokenVault) tokenVault = publicKeyString(meta.tokenVault, "meta.tokenVault");
        if (!solVault && meta.solVault) solVault = publicKeyString(meta.solVault, "meta.solVault");
        if (tokenVault && solVault) source = "campaigns.meta";
      }
    } catch (error) {
      console.warn("[solana-trade-v1] campaigns.meta vault lookup failed", error?.message || error);
    }
  }

  if (campaignId && (!tokenVault || !solVault)) {
    const derived = vaultsFromCampaignId(campaignId, programId);
    if (!tokenVault) tokenVault = derived.tokenVault;
    if (!solVault) solVault = derived.solVault;
    if (tokenVault && solVault) source = source === "client" ? "campaignId+derive" : source;
  }

  // RPC Campaign account — authoritative for already-deployed campaigns without meta.
  // Try registry campaign PDA first, then the client-supplied address (may already be campaign).
  if (!tokenVault || !solVault || !campaignId) {
    const candidates = [...new Set([rpcCampaignAddress, campaignAddress].filter(Boolean))];
    for (const addr of candidates) {
      try {
        const info = await rpcCall(rpcUrl, "getAccountInfo", [
          addr,
          { encoding: "base64", commitment: "confirmed" },
        ]);
        const dataB64 = info?.value?.data?.[0];
        if (!dataB64) continue;
        const data = Buffer.from(dataB64, "base64");
        const decoded = decodeCampaignAccount(data);
        if (!campaignId) campaignId = Buffer.from(decoded.campaignId);
        if (!tokenVault) tokenVault = decoded.tokenVault;
        if (!solVault) solVault = decoded.solVault;
        rpcCampaignAddress = addr;
        source = "rpc.campaign";
        break;
      } catch (error) {
        console.warn("[solana-trade-v1] RPC campaign decode failed", addr, error?.message || error);
      }
    }
  }

  // Final derive if we got campaignId from RPC/meta but vaults still missing.
  if (campaignId && (!tokenVault || !solVault)) {
    const derived = vaultsFromCampaignId(campaignId, programId);
    if (!tokenVault) tokenVault = derived.tokenVault;
    if (!solVault) solVault = derived.solVault;
    if (source === "client") source = "campaignId+derive";
  }

  return {
    tokenVault,
    solVault,
    campaignId,
    campaignIdHex: campaignId ? campaignId.toString("hex") : normalizeCampaignIdHex(body.campaignId) || null,
    source,
    rpcCampaignAddress,
  };
}

function buildTradeAuthorizationDigest({
  programId,
  campaign,
  mint,
  trader,
  side,
  amountIn,
  minOut,
  deadline,
  nonce,
  nativeTargetLamports,
  routeProfile,
}) {
  return sha256(
    TRADE_AUTH_DOMAIN,
    u16(TRADE_AUTH_SCHEMA_VERSION, "schemaVersion"),
    publicKeyBytes(programId, "programId"),
    publicKeyBytes(campaign, "campaign"),
    publicKeyBytes(mint, "mint"),
    publicKeyBytes(trader, "trader"),
    u8(side, "side"),
    u64(amountIn, "amountIn"),
    u64(minOut, "minOut"),
    i64(deadline, "deadline"),
    Buffer.from(nonce),
    u64(nativeTargetLamports, "nativeTargetLamports"),
    u8(routeProfile, "routeProfile"),
  );
}

async function fetchSolUsdMicros() {
  const override = String(process.env.SOLANA_GRADUATION_SOL_USD_MICROS || "").trim();
  if (override) {
    const value = BigInt(override);
    if (value <= 0n) throw new Error("SOLANA_GRADUATION_SOL_USD_MICROS must be > 0");
    return value;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      { headers: { accept: "application/json" }, signal: controller.signal },
    );
    if (!response.ok) throw new Error(`CoinGecko HTTP ${response.status}`);
    const body = await response.json();
    const price = Number(body?.solana?.usd);
    if (!Number.isFinite(price) || price <= 0) throw new Error("Invalid SOL/USD response");
    const micros = BigInt(Math.round(price * 1_000_000));
    if (micros <= 0n) throw new Error("Invalid SOL/USD micro price");
    return micros;
  } finally {
    clearTimeout(timer);
  }
}

async function loadCampaignCurve(rpcUrl, campaignAddress) {
  const info = await rpcCall(rpcUrl, "getAccountInfo", [
    campaignAddress,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  const dataB64 = info?.value?.data?.[0];
  if (!dataB64) {
    throw new SolanaTradeAuthorizationError("Campaign account was not found on-chain.", {
      code: "SOLANA_CAMPAIGN_MISSING",
      httpStatus: 409,
    });
  }
  return decodeCampaignCurveFields(Buffer.from(dataB64, "base64"));
}

function assertCurveOpen(curve, nativeTargetLamports) {
  const soldOut = curve.soldTokens >= curve.curveTokenSupply;
  const raiseMet = nativeTargetLamports > 0n && curve.netRaisedLamports >= nativeTargetLamports;
  if (curve.graduated || curve.curveClosed || soldOut || raiseMet) {
    throw new SolanaTradeAuthorizationError(
      "Bonding curve is closed after the graduation threshold. Awaiting Meteora.",
      { code: "SOLANA_CURVE_CLOSED", httpStatus: 409 },
    );
  }
}

/**
 * GET /api/solana/trade-status
 * Public read-only deployment/auth-health probe. Never returns secret material.
 * Exposes the public Railway identity fields required by deterministic S0 verification.
 */
export async function solanaTradeStatus(req, res) {
  if (!methodAllowed(req, res, ["GET", "POST"])) return;

  try {
    const createAuthEnabled = isTruthy(process.env.SOLANA_CREATE_AUTH_ENABLED);
    const tradeAuthEnabled = isTruthy(process.env.SOLANA_TRADE_AUTH_ENABLED);
    const programIdRaw = String(process.env.SOLANA_LAUNCHPAD_PROGRAM_ID || "").trim();
    const routeSignerRaw = String(process.env.SOLANA_ROUTE_SIGNER_PUBLIC_KEY || "").trim();
    const routeSecretRaw = String(process.env.SOLANA_ROUTE_SIGNER_SECRET_KEY || "").trim();
    const rpcUrl = String(process.env.SOLANA_RPC_URL || "").trim();
    const cluster = String(process.env.SOLANA_CLUSTER || "").trim() || null;
    const manifestHash = normalizeHex32(process.env.SOLANA_GENERATION_MANIFEST_HASH);
    const idlSha256 = normalizeHex32(process.env.SOLANA_LAUNCHPAD_IDL_SHA256);
    const programSha256 = normalizeHex32(process.env.SOLANA_LAUNCHPAD_PROGRAM_SHA256);
    const clusterHash = normalizeHex32(process.env.SOLANA_CLUSTER_HASH_HEX);

    let programId = null;
    let routeSigner = null;
    try {
      programId = programIdRaw ? publicKeyString(programIdRaw, "programId") : null;
    } catch {
      programId = null;
    }
    try {
      routeSigner = routeSignerRaw ? publicKeyString(routeSignerRaw, "routeSigner") : null;
    } catch {
      routeSigner = null;
    }

    let routeSignerSecretMatchesPublicKey = null;
    if (routeSecretRaw && routeSigner) {
      try {
        const signer = createEd25519Signer(routeSecretRaw);
        routeSignerSecretMatchesPublicKey = samePublicKey(signer.publicKeyBase58, routeSigner);
      } catch {
        routeSignerSecretMatchesPublicKey = false;
      }
    }

    let pauses = null;
    let rpcOk = false;
    let rpcError = null;
    let onChainRouteSigner = null;
    let securityDefaultsLocked = null;
    let routeAuthorizationRequired = null;
    let authorizedTradingRequired = null;
    if (rpcUrl && programId) {
      try {
        const globalPda = findProgramAddressSync([Buffer.from("global", "utf8")], programId).publicKey;
        const info = await rpcCall(rpcUrl, "getAccountInfo", [
          globalPda,
          { encoding: "base64", commitment: "confirmed" },
        ]);
        const b64 = info?.value?.data?.[0];
        if (b64) {
          const { decodeGlobalConfig } = await import("./solana-v4-primitives.js");
          const decoded = decodeGlobalConfig(Buffer.from(b64, "base64"));
          try {
            onChainRouteSigner = decoded.routeSigner ? publicKeyString(decoded.routeSigner, "GlobalConfig.routeSigner") : null;
          } catch {
            onChainRouteSigner = null;
          }
          securityDefaultsLocked = Boolean(decoded.securityDefaultsLocked);
          routeAuthorizationRequired = Boolean(decoded.routeAuthorizationRequired);
          authorizedTradingRequired = Boolean(decoded.authorizedTradingRequired);
          pauses = {
            paused: Boolean(decoded.paused),
            createPaused: Boolean(decoded.createPaused),
            buyPaused: Boolean(decoded.buyPaused),
            sellPaused: Boolean(decoded.sellPaused),
            graduationPaused: Boolean(decoded.graduationPaused),
            claimsPaused: Boolean(decoded.claimsPaused),
            authorizedTradingRequired,
          };
          rpcOk = true;
        } else {
          rpcError = "GlobalConfig account missing on RPC";
        }
      } catch (e) {
        rpcError = String(e?.message || e);
      }
    } else {
      rpcError = !rpcUrl ? "SOLANA_RPC_URL not set" : "SOLANA_LAUNCHPAD_PROGRAM_ID not set";
    }

    const routeSignerMatchesOnChain = Boolean(
      routeSigner && onChainRouteSigner && samePublicKey(routeSigner, onChainRouteSigner),
    );
    const buyOpen = tradeAuthEnabled && pauses && !pauses.paused && !pauses.buyPaused;
    const sellOpen = tradeAuthEnabled && pauses && !pauses.paused && !pauses.sellPaused;
    const createOpen = createAuthEnabled && pauses && !pauses.paused && !pauses.createPaused;
    const protocolLive = Boolean(createOpen && buyOpen && sellOpen);

    const missingOrInvalid = [];
    if (!cluster) missingOrInvalid.push("SOLANA_CLUSTER");
    if (!rpcUrl) missingOrInvalid.push("SOLANA_RPC_URL");
    if (!programId) missingOrInvalid.push("SOLANA_LAUNCHPAD_PROGRAM_ID");
    if (!routeSigner) missingOrInvalid.push("SOLANA_ROUTE_SIGNER_PUBLIC_KEY");
    if (!routeSecretRaw) missingOrInvalid.push("SOLANA_ROUTE_SIGNER_SECRET_KEY");
    else if (routeSignerSecretMatchesPublicKey !== true) missingOrInvalid.push("SOLANA_ROUTE_SIGNER_SECRET_KEY does not match public key");
    if (!manifestHash) missingOrInvalid.push("SOLANA_GENERATION_MANIFEST_HASH");
    if (!idlSha256) missingOrInvalid.push("SOLANA_LAUNCHPAD_IDL_SHA256");
    if (!programSha256) missingOrInvalid.push("SOLANA_LAUNCHPAD_PROGRAM_SHA256");
    if (!clusterHash) missingOrInvalid.push("SOLANA_CLUSTER_HASH_HEX");
    if (!createAuthEnabled) missingOrInvalid.push("SOLANA_CREATE_AUTH_ENABLED=true");
    if (!tradeAuthEnabled) missingOrInvalid.push("SOLANA_TRADE_AUTH_ENABLED=true");
    if (!rpcOk) missingOrInvalid.push("Solana RPC / GlobalConfig read");
    if (routeSigner && onChainRouteSigner && !routeSignerMatchesOnChain) missingOrInvalid.push("Railway route signer != GlobalConfig.routeSigner");
    if (securityDefaultsLocked !== true) missingOrInvalid.push("GlobalConfig.securityDefaultsLocked=true");
    if (routeAuthorizationRequired !== true) missingOrInvalid.push("GlobalConfig.routeAuthorizationRequired=true");
    if (authorizedTradingRequired !== true) missingOrInvalid.push("GlobalConfig.authorizedTradingRequired=true");
    if (pauses?.paused) missingOrInvalid.push("GlobalConfig.paused=false");
    if (pauses?.createPaused) missingOrInvalid.push("GlobalConfig.createPaused=false");
    if (pauses?.buyPaused) missingOrInvalid.push("GlobalConfig.buyPaused=false");
    if (pauses?.sellPaused) missingOrInvalid.push("GlobalConfig.sellPaused=false");

    const healthy = missingOrInvalid.length === 0;

    return json(res, 200, {
      healthy,
      chainId: 101,
      cluster,
      createAuthEnabled,
      tradeAuthEnabled,
      protocolLive,
      createOpen: Boolean(createOpen),
      buyOpen: Boolean(buyOpen),
      sellOpen: Boolean(sellOpen),
      programId,
      routeSigner,
      manifestHash,
      idlSha256,
      programSha256,
      clusterHash,
      routeSignerSecretConfigured: Boolean(routeSecretRaw),
      routeSignerSecretMatchesPublicKey,
      routeSignerMatchesOnChain,
      onChainRouteSigner,
      securityDefaultsLocked,
      routeAuthorizationRequired,
      authorizedTradingRequired,
      pauses,
      rpcOk,
      rpcError,
      missingOrInvalid,
      message: healthy
        ? "Solana Railway auth identity and create/buy/sell readiness are healthy."
        : `Solana Railway auth health has ${missingOrInvalid.length} blocker(s).`,
    });
  } catch (error) {
    console.error("[solana-trade-status]", error);
    return json(res, 500, {
      healthy: false,
      error: "Solana trade status failed.",
      code: "SOLANA_TRADE_STATUS_ERROR",
    });
  }
}

/**
 * POST /api/solana/trade-authorize
 */
export async function solanaTradeAuthorizationV1(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;

  try {
    if (!isTruthy(process.env.SOLANA_TRADE_AUTH_ENABLED)) {
      throw new SolanaTradeAuthorizationError(
        "Solana trade authorization is disabled. Set SOLANA_TRADE_AUTH_ENABLED=true after program upgrade + buy/sell unpause.",
        { code: "SOLANA_TRADE_AUTH_DISABLED", httpStatus: 503 },
      );
    }

    const body = await readJson(req);
    const chainId = Number(body.chainId || 101);
    if (!isSolanaChain(chainId)) {
      throw new SolanaTradeAuthorizationError("chainId must be a Solana chain (101).", {
        code: "NOT_A_SOLANA_CHAIN",
        httpStatus: 400,
      });
    }

    const sideRaw = String(body.side || "").trim().toLowerCase();
    if (sideRaw !== "buy" && sideRaw !== "sell") {
      throw new SolanaTradeAuthorizationError('side must be "buy" or "sell".', {
        code: "INVALID_TRADE_SIDE",
        httpStatus: 400,
      });
    }
    const side = sideRaw === "buy" ? TRADE_SIDE_BUY : TRADE_SIDE_SELL;

    const campaignAddress = publicKeyString(body.campaignAddress, "campaignAddress");
    const mintAddress = publicKeyString(
      body.mintAddress || body.tokenAddress || body.campaignAddress,
      "mintAddress",
    );
    const traderAddress = publicKeyString(body.traderAddress || body.walletAddress, "traderAddress");
    if (!isSolanaAddress(traderAddress)) {
      throw new SolanaTradeAuthorizationError("traderAddress must be a Solana base58 public key.", {
        code: "INVALID_TRADER",
        httpStatus: 400,
      });
    }

    const amountIn = toBigInt(body.amountIn, "amountIn");
    const minOut = toBigInt(body.minOut ?? 0, "minOut");
    if (amountIn <= 0n) {
      throw new SolanaTradeAuthorizationError("amountIn must be > 0.", {
        code: "INVALID_AMOUNT",
        httpStatus: 400,
      });
    }

    const rpcUrl = requiredEnv("SOLANA_RPC_URL");
    const programId = publicKeyString(requiredEnv("SOLANA_LAUNCHPAD_PROGRAM_ID"), "SOLANA_LAUNCHPAD_PROGRAM_ID");
    const routeSecret = requiredEnv("SOLANA_ROUTE_SIGNER_SECRET_KEY");
    const expectedRouteSigner = publicKeyString(
      requiredEnv("SOLANA_ROUTE_SIGNER_PUBLIC_KEY"),
      "SOLANA_ROUTE_SIGNER_PUBLIC_KEY",
    );
    const signer = createEd25519Signer(routeSecret);
    if (!samePublicKey(signer.publicKeyBase58, expectedRouteSigner)) {
      throw new SolanaTradeAuthorizationError("Route signer secret does not match SOLANA_ROUTE_SIGNER_PUBLIC_KEY.", {
        code: "SOLANA_ROUTE_SIGNER_CONFIGURATION_MISMATCH",
        httpStatus: 503,
      });
    }

    // This endpoint is the application-policy preflight gate. Never issue an
    // Ed25519 authorization unless protocol security, side pause state and all
    // mandatory fee destinations are ready on-chain.
    const rewardsVaults = deriveRewardsVaults();
    const globalPreflight = await assertTradeGlobalPreflight({
      rpcUrl,
      programId,
      expectedRouteSigner,
      signerPublicKey: signer.publicKeyBase58,
      side,
    });
    await assertRewardVaultPreflight(rpcUrl, rewardsVaults);

    const chainNow = await getChainUnixTime(rpcUrl);
    const ttlSeconds = parsePositiveInteger(
      process.env.SOLANA_TRADE_AUTH_TTL_SECONDS,
      DEFAULT_AUTH_TTL_SECONDS,
      MAX_AUTH_TTL_SECONDS,
    );
    const deadline = BigInt(chainNow + ttlSeconds);
    const nonce = crypto.randomBytes(32);

    const vaults = await resolveTradeVaults({
      body,
      chainId,
      campaignAddress,
      mintAddress,
      programId,
      rpcUrl,
    });
    const { tokenVault, solVault, campaignId } = vaults;
    // Prefer registry/RPC campaign PDA over client address (may be mint from /token/:mint URL).
    const resolvedCampaign = vaults.rpcCampaignAddress
      ? publicKeyString(vaults.rpcCampaignAddress, "resolvedCampaign")
      : campaignAddress;

    if (!tokenVault || !solVault) {
      throw new SolanaTradeAuthorizationError(
        "Could not resolve tokenVault/solVault. Re-run Push Live (mark-deploy) to persist vaults, or pass tokenVault/solVault/campaignId.",
        { code: "SOLANA_TRADE_VAULTS_UNRESOLVED", httpStatus: 409 },
      );
    }
    const feeEscrow = await assertFeeEscrowPreflight(rpcUrl, programId, resolvedCampaign);

    const tradeAuth = findProgramAddressSync(
      [TRADE_AUTH_SEED, publicKeyBytes(traderAddress), nonce],
      programId,
    );
    const traderAta = body.traderTokenAccount
      ? publicKeyString(body.traderTokenAccount, "traderTokenAccount")
      : findAssociatedTokenAddress(traderAddress, mintAddress).publicKey;

    const curve = await loadCampaignCurve(rpcUrl, resolvedCampaign);
    if (curve.paused) {
      throw new SolanaTradeAuthorizationError("This campaign is paused.", {
        code: "SOLANA_CAMPAIGN_PAUSED",
        httpStatus: 409,
      });
    }
    let eligibilityTargetLamports = 0n;
    try {
      const oraclePriceUsdMicros = await fetchSolUsdMicros();
      eligibilityTargetLamports = nativeTargetLamportsFromUsd(
        curve.graduationTargetUsdMicros,
        oraclePriceUsdMicros,
      );
    } catch (error) {
      console.warn("[solana-trade-v1] native target oracle unavailable", error?.message || error);
      if (side === TRADE_SIDE_BUY && curve.graduationTargetUsdMicros > 0n) {
        throw new SolanaTradeAuthorizationError("SOL/USD oracle is required to authorize a bonding buy.", {
          code: "SOLANA_GRADUATION_ORACLE_UNAVAILABLE",
          httpStatus: 503,
        });
      }
    }
    assertCurveOpen(curve, eligibilityTargetLamports);
    const signedNativeTargetLamports = side === TRADE_SIDE_BUY ? eligibilityTargetLamports : 0n;
    const routeProfile = await resolveRouteProfile(traderAddress);
    const clusterProfile = await resolveTraderClusterProfile(rpcUrl, programId, traderAddress);

    const digest = buildTradeAuthorizationDigest({
      programId,
      campaign: resolvedCampaign,
      mint: mintAddress,
      trader: traderAddress,
      side,
      amountIn,
      minOut,
      deadline,
      nonce,
      nativeTargetLamports: signedNativeTargetLamports,
      routeProfile,
    });
    const signature = signer.sign(digest);

    if (pool) {
      await pool.query(
        `insert into public.solana_trade_authorizations (
           chain_id, campaign_address, trader, nonce_hex, trade_auth_pda, deadline, side, cleanup_status
         ) values (101, $1, $2, $3, $4, to_timestamp($5), $6, 'pending')
         on conflict (chain_id, trade_auth_pda) do update set
           deadline = excluded.deadline,
           updated_at = now()`,
        [
          resolvedCampaign,
          traderAddress,
          Buffer.from(nonce).toString("hex"),
          tradeAuth.publicKey,
          Number(deadline),
          sideRaw,
        ],
      ).catch((error) => {
        console.warn(
          "[solana-trade-v1] trade-auth persist skipped",
          error instanceof Error ? error.message : String(error),
        );
      });
    }

    return json(res, 200, {
      schemaVersion: TRADE_AUTH_SCHEMA_VERSION,
      side: sideRaw,
      sideCode: side,
      chainId,
      programId,
      chainNow,
      vaultResolution: {
        source: vaults.source,
        campaignIdHex: vaults.campaignIdHex || (campaignId ? campaignId.toString("hex") : null),
        resolvedCampaign,
      },
      createArgs: {
        amountIn: amountIn.toString(),
        minOut: minOut.toString(),
        deadline: deadline.toString(),
        nonce: Array.from(nonce),
        nativeTargetLamports: signedNativeTargetLamports.toString(),
        routeProfile,
      },
      accounts: {
        trader: traderAddress,
        globalConfig: findProgramAddressSync([Buffer.from("global", "utf8")], programId).publicKey,
        campaign: resolvedCampaign,
        mint: mintAddress,
        tokenVault,
        solVault,
        traderTokenAccount: traderAta,
        riskProfile: findProgramAddressSync(
          [Buffer.from("risk", "utf8"), publicKeyBytes(traderAddress)],
          programId,
        ).publicKey,
        clusterProfile,
        tradeAuthorization: tradeAuth.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SYSTEM_PROGRAM_ID,
        feeEscrow,
        leagueVault: rewardsVaults.leagueVault,
        airdropVault: rewardsVaults.airdropVault,
        monthlyLeagueVault: rewardsVaults.monthlyLeagueVault,
        recruiterVault: rewardsVaults.recruiterVault,
        squadVault: rewardsVaults.squadVault,
        protocolVault: rewardsVaults.protocolVault,
        rewardsTreasuryProgramId: rewardsVaults.programId,
      },
      preflight: {
        policyPassed: true,
        globalConfig: globalPreflight.globalConfig,
        routeSigner: globalPreflight.onChainRouteSigner,
        rewardVaultsReady: true,
      },
      authorization: {
        signedMessageMode: "sha256_canonical_payload",
        digestHex: digest.toString("hex"),
        digestBase64: digest.toString("base64"),
        signatureBase64: signature.toString("base64"),
        routeSigner: signer.publicKeyBase58,
        deadline: deadline.toString(),
        validUntil: new Date(Number(deadline) * 1000).toISOString(),
        ed25519InstructionMustImmediatelyPrecedeTrade: true,
      },
      transactionPolicy:
        "Trader wallet constructs Ed25519 verify + buy_tokens/sell_tokens. Railway signs only the 32-byte trade digest.",
    });
  } catch (error) {
    if (error instanceof SolanaTradeAuthorizationError) {
      return json(res, error.httpStatus || 409, { error: error.message, code: error.code });
    }
    console.error("[solana-trade-v1] authorization failed", error);
    return json(res, 500, {
      error: "Solana trade authorization failed.",
      code: "SOLANA_TRADE_AUTHORIZATION_INTERNAL_ERROR",
    });
  }
}
