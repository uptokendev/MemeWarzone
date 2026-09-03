import { normalizeWalletFlexible } from "../../server/http.js";
import { arenaSqlIdentityEquals } from "./arenaSqlIdentity.js";

function ident(value) {
  return normalizeWalletFlexible(value) || String(value || "").trim();
}

export async function resolveArenaVoteToken(pool, chainId, identity) {
  const address = ident(identity);
  if (!address) return null;

  const nativeTokenMatch = arenaSqlIdentityEquals(chainId, "token_address::text", "$2");
  const nativeCampaignMatch = arenaSqlIdentityEquals(chainId, "campaign_address::text", "$2");
  const native = await pool.query(
    `select token_address, campaign_address, name, symbol
       from public.campaigns
      where chain_id = $1
        and (${nativeTokenMatch} or ${nativeCampaignMatch})
        and graduated_at_chain is not null
      order by created_block desc nulls last
      limit 1`,
    [chainId, address],
  );
  if (native.rows[0]) {
    const row = native.rows[0];
    return {
      tokenAddress: ident(row.token_address || row.campaign_address),
      campaignAddress: ident(row.campaign_address) || null,
      origin: "native",
      name: row.name || row.symbol || "Unknown",
      symbol: row.symbol || "---",
    };
  }

  const importedTokenMatch = arenaSqlIdentityEquals(chainId, "token_address", "$2");
  const imported = await pool.query(
    `select token_address, name, symbol
       from public.arena_token_imports
      where chain_id = $1 and ${importedTokenMatch} and status = 'passed'
      limit 1`,
    [chainId, address],
  );
  if (imported.rows[0]) {
    const row = imported.rows[0];
    return {
      tokenAddress: ident(row.token_address),
      campaignAddress: null,
      origin: "import",
      name: row.name || row.symbol || "Unknown",
      symbol: row.symbol || "---",
    };
  }
  return null;
}

export async function tokenEligible(pool, chainId, token) {
  return Boolean(await resolveArenaVoteToken(pool, chainId, token));
}
