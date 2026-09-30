import crypto from "node:crypto";
import { ethers } from "ethers";
import { badMethod, json, readJson } from "../server/http.js";
import { signTradeAuthorization } from "./dev-fix/routeAuthorizationSigner.js";

/**
 * EVM creator-choice operator (launch generation, CreatorRewardsVaultV2), API side.
 *
 * POST /api/internal/evm/creator-choice/buyback-authorization   (internal, shared secret)
 *   The route authority's trade authorization for the vault's pre-graduation buyback,
 *   CreatorRewardsVaultV2.buybackCurve -> LaunchCampaign.buyExactBnbAuthorized with actor = the vault, profile
 *   StandardUnlinked (1), action buy-exact-native (1). The route authority key stays on the API; the indexer's
 *   operator worker asks here. Signed only when every one of these holds, read from chain in this request:
 *   - header x-mwz-internal-secret equals EVM_CREATOR_CHOICE_API_SECRET (fail closed when unset);
 *   - the vault is the configured EVM_CREATOR_VAULT_V2_<chainId> and the actor is that vault;
 *   - the campaign is a generation 6 factory's campaign, the factory is the vault's factory, and both the factory
 *     (campaignFeeChoice) and the vault (cfg) say its fee choice is buyback;
 *   - the operator is not paused, amountIn <= limits().buyPerTx and <= buybackBalance(campaign);
 *   - the curve is still trading (not launched, not pending), and minOut is within 5% under the campaign's own
 *     quote for amountIn;
 *   - the factory's routeAuthority() is this API's signer;
 *   - the deadline is at most 10 minutes out (the campaign accepts up to a day).
 *   Request:  { chainId, campaign, vault, amountIn, minOut, ttlSeconds? }   (uints as decimal strings)
 *   Response: { ok, signature, deadline, routeProfile: 1, action: 1, actor, campaign, amountIn, minOut, routeAuthority }
 *
 * GET /api/evm/creator-choice?chainId=           the buyback / snapshot week commitments (secret after the week)
 * GET /api/evm/holder-batch?chainId=&weekId=     a published holder leaf file (also &batchId=)
 */

export const BUYBACK_ROUTE_PROFILE = 1; // StandardUnlinked, CreatorRewardsVaultV2.BUYBACK_ROUTE_PROFILE
export const TRADE_AUTH_BUY_EXACT_NATIVE = 1; // LaunchCampaign.TRADE_AUTH_BUY_EXACT_BNB
export const MAX_TTL_SECONDS = 600;
export const MIN_TTL_SECONDS = 60;
export const MIN_OUT_FLOOR_BPS = 9_500;
export const EVM_CHOICE_CHAINS = new Set([56, 4663, 97, 46630]);
const FEE_CHOICE_BUYBACK = 4;
const MIN_FACTORY_GENERATION = 6;

const CAMPAIGN_ABI = [
  "function factory() view returns (address)",
  "function launched() view returns (bool)",
  "function graduationPending() view returns (bool)",
  "function quoteBuyExactBnb(uint256 totalInWei) view returns (uint256 tokensOut, uint256 totalCostWei, uint256 feeWei)",
];
const FACTORY_ABI = [
  "function FACTORY_GENERATION() view returns (uint32)",
  "function isCampaign(address) view returns (bool)",
  "function campaignFeeChoice(address) view returns (address vault, uint8 choice, uint8 creatorPct)",
  "function routeAuthority() view returns (address)",
];
const VAULT_ABI = [
  "function factory() view returns (address)",
  "function cfg(address) view returns (address creator, uint8 choice, uint8 creatorPct, address pool, address quote)",
  "function limits() view returns (bool paused, uint256 buyPerTx, uint256 buybackPerCampaignWeek, uint256 buyInterval, uint256 impactBps, uint256 holderBatchPerWeek)",
  "function buybackBalance(address) view returns (uint256)",
];

class Refusal extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sameSecret(expected, provided) {
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(provided || ""));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function headerValue(req, name) {
  const h = req.headers || {};
  const v = h[name] ?? h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function address(value, label) {
  const raw = String(value || "").trim();
  if (!ethers.isAddress(raw)) throw new Refusal(400, "BAD_REQUEST", `${label} must be an address`);
  return ethers.getAddress(raw);
}

function uint(value, label) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) throw new Refusal(400, "BAD_REQUEST", `${label} must be a decimal integer`);
  return BigInt(raw);
}

/** EVM_CREATOR_VAULT_V2_<chainId>: "0xaddr@startBlock[,...]", the same variable the indexer reads. */
export function configuredCreatorVault(chainId, env = process.env) {
  const first = String(env[`EVM_CREATOR_VAULT_V2_${chainId}`] || "").split(",")[0]?.trim() || "";
  const addr = first.split("@")[0]?.trim() || "";
  return ethers.isAddress(addr) ? ethers.getAddress(addr) : "";
}

function routeAuthorityKey(env) {
  return (
    String(env.ROUTE_AUTHORITY_PRIVATE_KEY || "").trim() ||
    String(env.MWZ_ROUTE_AUTHORITY_PRIVATE_KEY || "").trim() ||
    String(env.ROUTE_AUTH_PRIVATE_KEY || "").trim()
  );
}

export function createEvmBuybackAuthorizationHandler(deps = {}) {
  const env = deps.env || process.env;
  const nowMs = deps.nowMs || (() => Date.now());
  async function provider(chainId) {
    if (deps.getProvider) return deps.getProvider(chainId);
    const mod = await import("./lib/getServerReadProvider.js");
    return mod.getServerReadProvider(chainId);
  }
  function signer() {
    if (deps.signer) return deps.signer;
    const key = routeAuthorityKey(env);
    if (!key) return null;
    try {
      return new ethers.Wallet(key);
    } catch {
      return null;
    }
  }
  async function log(entry) {
    try {
      if (deps.logAuthorization) return await deps.logAuthorization(entry);
      const mod = await import("./dev-fix/route-auth-log.js");
      await mod.logRouteAuthorization(entry);
    } catch (error) {
      console.warn("[evm-choice-auth] authorization log failed", error?.message || error);
    }
  }

  return async function handle(req, res) {
    if (req.method !== "POST") return badMethod(res);
    const secret = String(env.EVM_CREATOR_CHOICE_API_SECRET || "").trim();
    if (!secret) return json(res, 503, { ok: false, code: "EVM_CREATOR_CHOICE_API_SECRET_MISSING", error: "The creator-choice endpoint is not configured." });
    if (!sameSecret(secret, headerValue(req, "x-mwz-internal-secret"))) return json(res, 401, { ok: false, code: "UNAUTHORIZED", error: "Unauthorized." });
    const routeSigner = signer();
    if (!routeSigner) return json(res, 503, { ok: false, code: "ROUTE_SIGNER_UNAVAILABLE", error: "Route authority signer is not configured." });

    try {
      const body = (await readJson(req)) || {};
      const chainId = Number(body.chainId);
      if (!EVM_CHOICE_CHAINS.has(chainId)) throw new Refusal(400, "CHAIN_NOT_SUPPORTED", "chainId must be 56, 4663, 97 or 46630");
      const campaign = address(body.campaign, "campaign");
      const vault = address(body.vault, "vault");
      if (body.actor != null && address(body.actor, "actor") !== vault) throw new Refusal(403, "ACTOR_NOT_VAULT", "The actor of a buyback authorization is the vault.");
      const amountIn = uint(body.amountIn, "amountIn");
      const minOut = uint(body.minOut, "minOut");
      if (amountIn <= 0n || minOut <= 0n) throw new Refusal(400, "BAD_REQUEST", "amountIn and minOut must be positive");
      const configured = configuredCreatorVault(chainId, env);
      if (!configured) throw new Refusal(503, "VAULT_NOT_CONFIGURED", `EVM_CREATOR_VAULT_V2_${chainId} is not set`);
      if (configured !== vault) throw new Refusal(403, "VAULT_MISMATCH", "Not the configured creator vault.");
      const ttlRaw = body.ttlSeconds == null ? MAX_TTL_SECONDS : Number(body.ttlSeconds);
      const ttl = Math.max(MIN_TTL_SECONDS, Math.min(MAX_TTL_SECONDS, Number.isFinite(ttlRaw) ? Math.floor(ttlRaw) : MAX_TTL_SECONDS));

      const p = await provider(chainId);
      const network = await p.getNetwork();
      if (Number(network.chainId) !== chainId) throw new Refusal(503, "RPC_CHAIN_MISMATCH", "RPC answered for another chain.");
      const c = new ethers.Contract(campaign, CAMPAIGN_ABI, p);
      const v = new ethers.Contract(vault, VAULT_ABI, p);
      const [campaignFactory, vaultFactory] = await Promise.all([c.factory(), v.factory()]);
      if (ethers.getAddress(campaignFactory) !== ethers.getAddress(vaultFactory)) throw new Refusal(403, "FACTORY_MISMATCH", "The campaign is not from the vault's factory.");
      const f = new ethers.Contract(vaultFactory, FACTORY_ABI, p);
      const [isCampaign, generation, choiceRead, cfg, limits, balance, launched, pending, quote, authority] = await Promise.all([
        f.isCampaign(campaign), f.FACTORY_GENERATION(), f.campaignFeeChoice(campaign), v.cfg(campaign), v.limits(),
        v.buybackBalance(campaign), c.launched(), c.graduationPending(), c.quoteBuyExactBnb(amountIn), f.routeAuthority(),
      ]);
      if (!isCampaign) throw new Refusal(403, "NOT_A_CAMPAIGN", "Not a campaign of this factory.");
      if (Number(generation) < MIN_FACTORY_GENERATION) throw new Refusal(403, "GENERATION_NOT_SUPPORTED", "Not a launch-generation factory.");
      if (ethers.getAddress(choiceRead[0]) !== vault || Number(choiceRead[1]) !== FEE_CHOICE_BUYBACK || Number(cfg[1]) !== FEE_CHOICE_BUYBACK) {
        throw new Refusal(403, "NOT_BUYBACK", "The campaign's fee choice in this vault is not buyback.");
      }
      if (Boolean(limits[0])) throw new Refusal(409, "OPERATOR_PAUSED", "The vault operator is paused.");
      if (amountIn > BigInt(limits[1])) throw new Refusal(403, "ABOVE_BUY_CAP", "amountIn is above the vault's per-buy cap.");
      if (amountIn > BigInt(balance)) throw new Refusal(403, "ABOVE_BUYBACK_BALANCE", "amountIn is above the campaign's buyback balance.");
      if (launched || pending) throw new Refusal(409, "CURVE_CLOSED", "The curve is graduating or graduated.");
      const tokensOut = BigInt(quote[0]);
      if (tokensOut <= 0n || minOut > tokensOut || minOut * 10_000n < tokensOut * BigInt(MIN_OUT_FLOOR_BPS)) {
        throw new Refusal(403, "MIN_OUT_OUT_OF_RANGE", "minOut must be within 5% under the campaign's quote.");
      }
      if (ethers.getAddress(authority) !== ethers.getAddress(routeSigner.address)) {
        throw new Refusal(503, "ROUTE_AUTHORITY_MISMATCH", "Configured route signer does not match the factory route authority.");
      }

      const deadline = Math.floor(nowMs() / 1000) + ttl;
      const signature = await signTradeAuthorization({
        signer: routeSigner,
        chainId,
        campaignAddress: campaign,
        actor: vault,
        routeProfileId: BUYBACK_ROUTE_PROFILE,
        action: TRADE_AUTH_BUY_EXACT_NATIVE,
        amount: amountIn,
        limit: minOut,
        deadline,
      });
      await log({
        chainId,
        walletAddress: vault,
        routeKind: "trade",
        routeProfileId: BUYBACK_ROUTE_PROFILE,
        campaignAddress: campaign,
        factoryAddress: ethers.getAddress(vaultFactory),
        routeAuthority: routeSigner.address,
        authorizationDeadline: deadline,
        validUntil: new Date(deadline * 1000).toISOString(),
        metadata: { endpoint: "/api/internal/evm/creator-choice/buyback-authorization", action: TRADE_AUTH_BUY_EXACT_NATIVE, amount: amountIn.toString(), limit: minOut.toString(), purpose: "creator_vault_buyback" },
      });
      return json(res, 200, {
        ok: true,
        signature,
        deadline: String(deadline),
        routeProfile: BUYBACK_ROUTE_PROFILE,
        action: TRADE_AUTH_BUY_EXACT_NATIVE,
        actor: vault,
        campaign,
        amountIn: amountIn.toString(),
        minOut: minOut.toString(),
        routeAuthority: routeSigner.address,
      });
    } catch (error) {
      if (error instanceof Refusal) return json(res, error.status, { ok: false, code: error.code, error: error.message });
      console.error("[evm-choice-auth]", error?.shortMessage || error?.message || error);
      return json(res, 502, { ok: false, code: "CHAIN_READ_FAILED", error: "Chain read failed." });
    }
  };
}

export function createEvmCreatorChoiceReadHandlers(deps = {}) {
  async function db() {
    if (deps.db) return deps.db;
    const mod = await import("../server/db.js");
    return mod.pool;
  }
  function params(req) {
    const url = new URL(req.url || "http://localhost/", "http://localhost");
    return url.searchParams;
  }
  async function weeks(req, res) {
    if (req.method !== "GET") return badMethod(res);
    const chainId = Number(params(req).get("chainId"));
    if (!EVM_CHOICE_CHAINS.has(chainId)) return json(res, 400, { ok: false, code: "CHAIN_NOT_SUPPORTED", error: "chainId must be 56, 4663, 97 or 46630" });
    try {
      const { rows } = await (await db()).query(
        `select week_id, commitment, secret, revealed_at from public.evm_creator_choice_weeks where chain_id = $1 order by week_id desc limit 12`,
        [chainId],
      );
      return json(res, 200, {
        ok: true,
        chainId,
        weeks: rows.map((r) => ({ weekId: String(r.week_id), commitment: String(r.commitment), secret: r.secret ? String(r.secret) : null, revealedAt: r.revealed_at ? new Date(r.revealed_at).toISOString() : null })),
        rule:
          "week secret = HMAC-SHA256(master, 'evm-week:' + chainId + ':' + weekId); commitment = sha256(week secret); "
          + "holder snapshot = HMAC(week secret, 'holders-snapshot:' + chainId) mod week; "
          + "buyback i on day D = HMAC(week secret, chainId + '|' + campaign + '|' + D + '|' + i) mod day; "
          + "conversion i = HMAC(week secret, 'convert|' + chainId + '|' + campaign + '|' + D + '|' + i) mod day (campaign lowercase)",
      });
    } catch (error) {
      console.error("[evm/creator-choice]", error?.message || error);
      return json(res, 500, { ok: false, code: "EVM_CREATOR_CHOICE_FAILED", error: "creator choice lookup failed" });
    }
  }
  async function holderBatch(req, res) {
    if (req.method !== "GET") return badMethod(res);
    const q = params(req);
    const chainId = Number(q.get("chainId"));
    const weekId = String(q.get("weekId") || "").trim();
    const batchId = String(q.get("batchId") || "").trim().toLowerCase();
    if (!EVM_CHOICE_CHAINS.has(chainId)) return json(res, 400, { ok: false, code: "CHAIN_NOT_SUPPORTED", error: "chainId must be 56, 4663, 97 or 46630" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekId) && !/^0x[0-9a-f]{64}$/.test(batchId)) return json(res, 400, { ok: false, code: "BAD_REQUEST", error: "weekId (YYYY-MM-DD) or batchId is required" });
    try {
      const { rows } = await (await db()).query(
        `select week_id, batch_id, status, leaf_file, executable_at, last_reason
           from public.evm_holder_batches
          where chain_id = $1 and (week_id = $2 or batch_id = $3) and leaf_file is not null
          limit 1`,
        [chainId, weekId, batchId],
      );
      if (!rows[0]) return json(res, 404, { ok: false, code: "NOT_FOUND", error: "No published holder batch." });
      const r = rows[0];
      return json(res, 200, {
        ok: true,
        status: String(r.status),
        executableAt: r.executable_at ? new Date(r.executable_at).toISOString() : null,
        reason: r.last_reason || null,
        leafFile: r.leaf_file,
      });
    } catch (error) {
      console.error("[evm/holder-batch]", error?.message || error);
      return json(res, 500, { ok: false, code: "EVM_HOLDER_BATCH_FAILED", error: "holder batch lookup failed" });
    }
  }
  return { weeks, holderBatch };
}

export const evmBuybackAuthorization = createEvmBuybackAuthorizationHandler();
const readHandlers = createEvmCreatorChoiceReadHandlers();
export const evmCreatorChoiceWeeks = readHandlers.weeks;
export const evmHolderBatch = readHandlers.holderBatch;
