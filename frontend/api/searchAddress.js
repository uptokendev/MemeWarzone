/**
 * GET /api/search/address?address=<0x... or Solana mint>
 *
 * The search box for a pasted contract address (founder, 2026-10-09: a Robinhood import could not be found
 * and its address opened a wallet profile). Looks the address up on every chain at once, so search does not
 * depend on which chain the visitor is on:
 *   campaigns            our own coins by token or campaign address (test coins hidden by meta.publicHidden
 *                        are left out, as on every public listing)
 *   arena_token_imports  imported coins by token address, whatever their Arena status: a coin declined for
 *                        the Arena still has its page, and the visitor pasted its exact address
 * Solana addresses match exactly (case matters); EVM addresses match case-insensitively.
 */
import { pool } from "../server/db.js";
import { badMethod, getQuery, json } from "../server/http.js";
import { publicHiddenOrBlockedWhere } from "./lib/publicHiddenSql.js";

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function parseSearchAddress(raw) {
  const value = String(raw ?? "").trim();
  if (EVM_RE.test(value)) return { address: value.toLowerCase(), evm: true };
  if (SOLANA_RE.test(value)) return { address: value, evm: false };
  return null;
}

export const SEARCH_ADDRESS_SQL = {
  campaigns: `
    select c.chain_id, c.campaign_address, c.token_address, c.name, c.symbol, c.logo_uri, c.graduated_at_chain, c.launch_type
      from public.campaigns c
     where (case when $2::boolean
                 then (lower(c.token_address) = $1 or lower(c.campaign_address) = $1) and c.chain_id not in (101, 102)
                 else (c.token_address = $1 or c.campaign_address = $1) and c.chain_id in (101, 102) end)
       and not (${publicHiddenOrBlockedWhere("c")})
     order by c.created_at desc nulls last
     limit 10`,
  imports: `
    select i.chain_id, i.token_address, i.name, i.symbol, i.image_url, i.status
      from public.arena_token_imports i
     where (case when $2::boolean then lower(i.token_address) = $1 and i.chain_id not in (101, 102)
                 else i.token_address = $1 and i.chain_id in (101, 102) end)
     order by (i.status = 'passed') desc, i.created_at desc
     limit 10`,
};

export function mapAddressMatches({ campaigns, imports }) {
  const out = [];
  const seen = new Set();
  for (const row of campaigns) {
    const key = `${row.chain_id}:${String(row.token_address || row.campaign_address).toLowerCase()}`;
    seen.add(key);
    out.push({
      kind: "campaign",
      chainId: Number(row.chain_id),
      campaignAddress: String(row.campaign_address || row.token_address),
      tokenAddress: row.token_address ? String(row.token_address) : null,
      name: row.name || null,
      symbol: row.symbol || null,
      logoURI: row.logo_uri || null,
      graduated: Boolean(row.graduated_at_chain),
    });
  }
  for (const row of imports) {
    // Our own coin is never also listed as an import.
    if (seen.has(`${row.chain_id}:${String(row.token_address).toLowerCase()}`)) continue;
    out.push({
      kind: "import",
      chainId: Number(row.chain_id),
      campaignAddress: String(row.token_address),
      tokenAddress: String(row.token_address),
      name: row.name || null,
      symbol: row.symbol ? String(row.symbol).replace(/^\$/, "") : null,
      logoURI: row.image_url || null,
      graduated: true,
    });
  }
  return out;
}

export default async function searchAddress(req, res, db = pool) {
  if (String(req.method || "GET").toUpperCase() !== "GET") return badMethod(res);
  const parsed = parseSearchAddress(getQuery(req).address);
  if (!parsed) return json(res, 400, { ok: false, error: "address must be a 0x address or a Solana address" });
  if (!db) return json(res, 503, { ok: false, error: "Database unavailable" });
  try {
    const params = [parsed.address, parsed.evm];
    const [campaigns, imports] = await Promise.all([
      db.query(SEARCH_ADDRESS_SQL.campaigns, params),
      db.query(SEARCH_ADDRESS_SQL.imports, params).catch((error) => (error?.code === "42P01" ? { rows: [] } : Promise.reject(error))),
    ]);
    res.setHeader("Cache-Control", "public, max-age=30");
    return json(res, 200, { ok: true, address: parsed.address, items: mapAddressMatches({ campaigns: campaigns.rows, imports: imports.rows }) });
  } catch (error) {
    console.error("[api/search/address]", error?.message || error);
    return json(res, 500, { ok: false, error: "Address lookup failed" });
  }
}
