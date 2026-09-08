import { getQuery } from "../../server/http.js";

export function optionalChainId(value) {
  if (value == null || String(value).trim() === "") return null;
  const chainId = Number(value);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("Invalid Arena chain id");
  return chainId;
}

export function chainIdFromQuery(req) {
  const query = getQuery(req);
  return optionalChainId(query.chainId ?? query.chain_id);
}

export function chainIdFromBody(body) {
  return optionalChainId(body?.chainId ?? body?.chain_id ?? body?.auth?.chainId ?? body?.auth?.chain_id);
}

export function tournamentBelongsToChain(row, chainId) {
  if (!row || chainId == null) return Boolean(row);
  return Number(row.chain_id ?? row.chainId) === Number(chainId);
}

export function filterTournamentFeedByChain(payload, chainId) {
  if (!payload || chainId == null) return payload;
  const expected = Number(chainId);
  const filterRows = (rows) => Array.isArray(rows)
    ? rows.filter((row) => Number(row?.chainId ?? row?.chain_id) === expected)
    : rows;
  return {
    ...payload,
    events: filterRows(payload.events),
    archivedEvents: filterRows(payload.archivedEvents),
  };
}
