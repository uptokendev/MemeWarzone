/**
 * POST /api/solana/graduation-handoff
 *
 * Crossing-buy signal: the curve is closed and Meteora graduation should start
 * immediately. This route never waits for the operator transaction. If an
 * operator command is configured it is spawned in the background; otherwise
 * a watcher/keeper is expected to pick the campaign up within seconds.
 */
import { spawn } from "node:child_process";

import { pool } from "../../server/db.js";
import { badMethod, isSolanaChain, json, readJson } from "../../server/http.js";
import { decodeCampaignCurveFields, publicKeyString } from "./solana-v4-primitives.js";
import { notifyCampaignGraduated } from "../lib/campaignLifecycleNotifications.js";

class SolanaGraduationHandoffError extends Error {
  constructor(message, { code = "SOLANA_GRADUATION_HANDOFF_ERROR", httpStatus = 409 } = {}) {
    super(message);
    this.name = "SolanaGraduationHandoffError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const kicked = new Map();
const KICK_TTL_MS = 20_000;

function methodAllowed(req, res, allowed) {
  if (allowed.includes(req.method)) return true;
  badMethod(res);
  return false;
}

function requiredEnv(name) {
  return String(process.env[name] || "").trim();
}

async function rpcCall(rpcUrl, method, params) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = await response.json().catch(() => ({}));
  if (payload.error) {
    throw new SolanaGraduationHandoffError(`Solana RPC ${method} failed: ${payload.error.message || "unknown"}`, {
      code: "SOLANA_RPC_ERROR",
      httpStatus: 503,
    });
  }
  return payload.result;
}

function kickOperator(campaignAddress) {
  const now = Date.now();
  const last = kicked.get(campaignAddress) || 0;
  if (now - last < KICK_TTL_MS) return false;
  kicked.set(campaignAddress, now);

  const command = requiredEnv("SOLANA_GRADUATION_HANDOFF_COMMAND");
  if (!command) return false;

  const parts = command.split(" ").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return false;
  const env = {
    ...process.env,
    SOLANA_GRADUATION_SEND: "true",
    SOLANA_GRADUATION_CAMPAIGN: campaignAddress,
  };
  const child = spawn(parts[0], [...parts.slice(1), campaignAddress], {
    env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return true;
}

export async function solanaGraduationHandoff(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;

  try {
    const body = await readJson(req);
    const chainId = Number(body.chainId || 101);
    if (!isSolanaChain(chainId)) {
      throw new SolanaGraduationHandoffError("chainId must be Solana (101).", {
        code: "NOT_A_SOLANA_CHAIN",
        httpStatus: 400,
      });
    }

    const campaignAddress = publicKeyString(body.campaignAddress, "campaignAddress");
    const rpcUrl = requiredEnv("SOLANA_RPC_URL");
    if (!rpcUrl) {
      throw new SolanaGraduationHandoffError("SOLANA_RPC_URL is not configured.", {
        code: "SOLANA_TRADE_CONFIGURATION_INCOMPLETE",
        httpStatus: 503,
      });
    }

    const info = await rpcCall(rpcUrl, "getAccountInfo", [
      campaignAddress,
      { encoding: "base64", commitment: "confirmed" },
    ]);
    const dataB64 = info?.value?.data?.[0];
    if (!dataB64) {
      throw new SolanaGraduationHandoffError("Campaign account was not found on-chain.", {
        code: "SOLANA_CAMPAIGN_MISSING",
        httpStatus: 409,
      });
    }
    const curve = decodeCampaignCurveFields(Buffer.from(dataB64, "base64"));
    if (curve.graduated) {
      return json(res, 200, { ok: true, status: "graduated", campaignAddress });
    }
    if (!curve.curveClosed) {
      return json(res, 200, { ok: true, status: "bonding", campaignAddress });
    }

    const kickedOperator = kickOperator(campaignAddress);
    console.log("[solana-handoff] curve closed", { campaignAddress, kickedOperator });
    
    await notifyCampaignGraduated(pool, {
      chainId,
      campaignAddress,
      market: { venue: "meteora", quoteAsset: "WSOL" },
    });

    return json(res, 200, {
      ok: true,
      status: "handoff",
      campaignAddress,
      kickedOperator,
    });
  } catch (error) {
    if (error instanceof SolanaGraduationHandoffError) {
      return json(res, error.httpStatus || 409, { ok: false, error: error.message, code: error.code });
    }
    console.error("[solana-handoff] failed", error);
    return json(res, 500, {
      ok: false,
      error: "Solana graduation handoff failed.",
      code: "SOLANA_GRADUATION_HANDOFF_INTERNAL_ERROR",
    });
  }
}
