import { getQuery, readJson } from "../../server/http.js";

export function optionalChainId(value) {
  if (value == null || String(value).trim() === "") return null;
  const chainId = Number(value);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("Invalid Arena chain id");
  return chainId;
}

export function chainIdFromQuery(req) {
  return optionalChainId(getQuery(req).chainId);
}

export async function chainIdFromMutation(req, deps = {}) {
  const readBody = deps.readJson || readJson;
  const body = await readBody(req);
  if (req && body && typeof body === "object") req.body = body;
  const chainId = optionalChainId(body?.chainId ?? body?.auth?.chainId);
  return { chainId, body };
}

export function battleBelongsToChain(row, chainId) {
  if (!row || chainId == null) return Boolean(row);
  return Number(row.chain_id ?? row.chainId) === Number(chainId);
}

export async function loadBattleOnChain(query, battleId, chainId) {
  const result = await query(
    `select id, chain_id, state, source, tournament_id
       from public.arena_battles
      where id = $1 and chain_id = $2
      limit 1`,
    [String(battleId), Number(chainId)],
  );
  return result?.rows?.[0] || null;
}

export function filterBattleFeedByChain(payload, chainId) {
  if (!payload || chainId == null) return payload;
  const id = Number(chainId);
  const filterBattles = (rows) => Array.isArray(rows)
    ? rows.filter((battle) => Number(battle?.chainId ?? battle?.chain_id) === id)
    : rows;
  const filterArchive = (rows) => Array.isArray(rows)
    ? rows.filter((entry) => Number(entry?.battle?.chainId ?? entry?.battle?.chain_id) === id)
    : rows;
  return {
    ...payload,
    liveBattles: filterBattles(payload.liveBattles),
    openForBattleQueue: filterBattles(payload.openForBattleQueue),
    archivedBattles: filterArchive(payload.archivedBattles),
  };
}

/**
 * Named routes under /arena/battles/ that are not battle ids. Every GET route added to
 * arenaBattles.js belongs here: the runtime looks any other segment up as a battle id on the
 * requested chain and answers 404 BATTLE_CHAIN_MISMATCH before the route runs. `opponents`
 * was missing, so the challenge popup's opponent list 404'd on every chain-scoped call.
 */
export const ARENA_BATTLE_NAMED_ROUTES = Object.freeze(["creator-status", "matches", "opponents", "inbox", "open", "challenge"]);

export function battleIdFromPath(path) {
  const value = String(path || "");
  const match = value.match(/^\/arena\/battles\/([^/]+)(?:\/(?:accept|counter|decline|cancel-open|transition))?$/);
  if (!match) return "";
  const decoded = decodeURIComponent(match[1]);
  if (ARENA_BATTLE_NAMED_ROUTES.includes(decoded)) return "";
  return decoded;
}
