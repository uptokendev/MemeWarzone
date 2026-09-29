import { json, badMethod, getQuery } from "../../server/http.js";
import {
  DBC_DEVNET_TEST_TARGET_USD_MICROS,
  DBC_QUOTE_MINT,
  DBC_SOL_USD_MAX_STALE_MS,
  isCreatorFeeMode,
  parseTargetUsdToMicros,
} from "../../shared/dbcEconomics.mjs";
import { readSolUsdMicros } from "../lib/solUsdMicros.js";
import { solPriceStep } from "../lib/dbc/dbcPriceSteps.mjs";
import { requiredCluster, createDbcConfigLadder } from "../lib/dbc/dbcConfigLadder.js";
import { requireEnabledQuote, stableStep } from "../../shared/dbcQuotes.mjs";
import { Connection } from "@solana/web3.js";
import { DbcStockQuoteError, stockPriceStep } from "../lib/dbc/dbcStockQuote.mjs";

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

export function dbcLaunchDisabledPayload() {
  return { disabled: true, featureFlag: "DBC_LAUNCH_ENABLED", warning: "Postgrad API route is disabled.", ok: false };
}

export function isDbcLaunchEnabled(env = process.env) {
  return truthy(env.DBC_LAUNCH_ENABLED);
}

function stalePriceError(error) {
  const message = String(error?.message || error || "");
  return /SOL\/USD|stale|unavailable/i.test(message);
}

export async function handleDbcLaunchConfig(req, res, deps = {}) {
  if (String(req.method || "GET").toUpperCase() !== "GET") return badMethod(res);
  const env = deps.env || process.env;
  if (!isDbcLaunchEnabled(env)) return json(res, 200, dbcLaunchDisabledPayload());

  const q = getQuery(req);
  const chainId = Number(q.chainId);
  if (chainId !== 101) return json(res, 400, { ok: false, error: "chainId must be 101", code: "DBC_BAD_CHAIN" });

  let cluster;
  try {
    cluster = (deps.cluster || requiredCluster(env));
  } catch (error) {
    return json(res, 503, { ok: false, error: error.message, code: error.code || "DBC_CLUSTER_UNCONFIGURED" });
  }

  const creatorFeeMode = String(q.creatorFeeMode || "").trim();
  if (!isCreatorFeeMode(creatorFeeMode)) {
    return json(res, 400, { ok: false, error: "creatorFeeMode must be creator or platform", code: "DBC_BAD_FEE_MODE" });
  }

  const targetUsdMicros = parseTargetUsdToMicros(q.targetUsd);
  if (targetUsdMicros == null) {
    return json(res, 400, { ok: false, error: "targetUsd must be 15000, 30000 or 50000", code: "DBC_BAD_TARGET" });
  }
  if (targetUsdMicros === DBC_DEVNET_TEST_TARGET_USD_MICROS && cluster !== "devnet") {
    return json(res, 400, { ok: false, error: "the $150 target is only for devnet", code: "DBC_TEST_TARGET_REFUSED" });
  }

  let quote;
  try {
    quote = requireEnabledQuote(cluster, String(q.quoteMint || q.quote || DBC_QUOTE_MINT).trim() || DBC_QUOTE_MINT);
  } catch (error) {
    return json(res, 400, { ok: false, error: error.message, code: error.code || "DBC_QUOTE_UNKNOWN" });
  }

  let step;
  try {
    if (quote.kind === "native") {
      const readPrice = deps.readSolUsdMicros || readSolUsdMicros;
      const solUsdMicros = await readPrice({ maxStaleMs: DBC_SOL_USD_MAX_STALE_MS });
      step = (deps.solPriceStep || solPriceStep)(solUsdMicros);
    } else if (quote.kind === "stock") {
      const url = String(env.SOLANA_RPC_URL || env.SOLANA_RPC_HTTP || "").trim();
      if (!deps.connection && !url) {
        return json(res, 503, { ok: false, error: "SOLANA_RPC_URL is required", code: "DBC_RPC_MISSING" });
      }
      step = await (deps.stockPriceStep || stockPriceStep)(deps.connection || new Connection(url, "confirmed"), quote);
    } else {
      step = stableStep();
    }
  } catch (error) {
    if (error instanceof DbcStockQuoteError) {
      return json(res, error.httpStatus || 400, { ok: false, error: error.message, code: error.code });
    }
    if (stalePriceError(error) || error?.code === "DBC_PRICE_STALE") {
      return json(res, 503, { ok: false, error: "SOL/USD price is missing or stale", code: "DBC_PRICE_STALE" });
    }
    throw error;
  }

  let db = deps.db;
  if (!db && !deps.ladder) {
    ({ pool: db } = await import("../../server/db.js"));
  }
  const ladder = deps.ladder || createDbcConfigLadder({ db, env, cluster });
  let ensured;
  try {
    ensured = await ladder.ensureLaunchConfig({
      targetUsdMicros,
      stepIndex: step.stepIndex,
      stepUsdMicros: step.stepUsdMicros,
      creatorFeeMode,
      quoteMint: quote.mint,
    });
  } catch (error) {
    if (error?.code === "DBC_CONFIG_FAILED" || error?.code === "DBC_CONFIG_MISMATCH") {
      return json(res, 503, {
        ok: false,
        error: error.message,
        code: "DBC_CONFIG_FAILED",
      });
    }
    throw error;
  }

  return json(res, 200, {
    config: ensured.configAddress,
    targetUsdMicros: targetUsdMicros.toString(),
    stepIndex: step.stepIndex,
    stepUsdMicros: step.stepUsdMicros.toString(),
    creatorFeeMode,
    thresholdLamports: ensured.expected.thresholdLamports.toString(),
    totalTokenSupply: ensured.expected.totalTokenSupply.toString(),
    paramsHash: ensured.paramsHash,
    feeClaimer: String(env.DBC_FEE_COLLECTOR || ""),
    quoteMint: quote.mint,
    quoteSymbol: quote.symbol,
    quoteDecimals: quote.decimals,
  });
}

export default async function dbcLaunchConfig(req, res) {
  try {
    return await handleDbcLaunchConfig(req, res);
  } catch (error) {
    if (error?.code === "DBC_PRICE_STALE" || stalePriceError(error)) {
      return json(res, 503, { ok: false, error: "SOL/USD price is missing or stale", code: "DBC_PRICE_STALE" });
    }
    if (error?.code === "DBC_CLUSTER_MISMATCH" || error?.code === "DBC_CLUSTER_UNCONFIGURED") {
      return json(res, 503, { ok: false, error: error.message, code: error.code });
    }
    if (error?.code === "DBC_CONFIG_FAILED" || error?.code === "DBC_CONFIG_MISMATCH") {
      return json(res, 503, { ok: false, error: error.message, code: error.code === "DBC_CONFIG_MISMATCH" ? "DBC_CONFIG_FAILED" : error.code });
    }
    console.error("[dbc/launch-config]", error);
    return json(res, 500, { ok: false, error: "Server error", code: error?.code || undefined });
  }
}
