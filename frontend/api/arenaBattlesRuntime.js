import { pool } from "../server/db.js";
import arenaBattles from "./arenaBattles.js";
import { activateNormalBattleSettlementOnRead } from "./lib/arenaBattleSettlementRuntime.js";
import { claimAuthoritativeSettlement, releaseAuthoritativeSettlement } from "./lib/arenaBattleSettlementGuard.js";
import {
  battleIdFromPath,
  chainIdFromMutation,
  chainIdFromQuery,
  filterBattleFeedByChain,
  loadBattleOnChain,
} from "./lib/arenaBattleChainIdentity.js";

function routePath(req) {
  return String(req.path || new URL(req.url, "http://localhost").pathname);
}

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function interceptFeedResponse(res, chainId) {
  if (chainId == null) return () => {};
  const originalEnd = res.end.bind(res);
  let restored = false;
  const restore = () => {
    if (!restored) {
      res.end = originalEnd;
      restored = true;
    }
  };
  res.end = (chunk, ...args) => {
    restore();
    try {
      const raw = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
      const payload = JSON.parse(raw);
      const filtered = filterBattleFeedByChain(payload, chainId);
      return originalEnd(JSON.stringify(filtered), ...args);
    } catch {
      return originalEnd(chunk, ...args);
    }
  };
  return restore;
}

async function requestedChain(req) {
  const method = String(req.method || "GET").toUpperCase();
  return method === "GET" ? chainIdFromQuery(req) : (await chainIdFromMutation(req)).chainId;
}

export default async function handler(req, res) {
  const path = routePath(req);
  let chainId = null;
  try {
    chainId = await requestedChain(req);
  } catch {
    return json(res, 400, { ok: false, error: "Invalid Arena chain id", code: "INVALID_CHAIN" });
  }

  const battleId = battleIdFromPath(path);
  if (battleId && chainId != null) {
    const row = await loadBattleOnChain((text, params) => pool.query(text, params), battleId, chainId);
    if (!row) return json(res, 404, { ok: false, error: "Battle not found on requested chain", code: "BATTLE_CHAIN_MISMATCH" });
  }

  const outcomes = await activateNormalBattleSettlementOnRead(req, { chainId });
  const authoritativeIds = [...new Set(outcomes.filter((item) => item?.authoritative === true).map((item) => String(item.battleId)))];
  for (const id of authoritativeIds) claimAuthoritativeSettlement(id);
  const blocked = outcomes.filter((item) => item && item.settled === false && item.reason && item.reason !== "not_due_already_settled_or_not_normal" && item.reason !== "not_due_already_settled_or_not_v2_locked");
  if (blocked.length) {
    console.warn("[arena-battle-settlement-runtime] recoverable settlement blocks", blocked.map((item) => ({
      battleId: item.battleId,
      scoringGeneration: item.scoringGeneration,
      reason: item.reason,
    })));
  }

  const restore = path === "/arena/battles" ? interceptFeedResponse(res, chainId) : () => {};
  try {
    return await arenaBattles(req, res);
  } finally {
    restore();
    for (const id of authoritativeIds) releaseAuthoritativeSettlement(id);
  }
}
