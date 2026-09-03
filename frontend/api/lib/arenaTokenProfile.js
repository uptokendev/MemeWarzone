import { isSolanaChainId } from "./chainNative.js";
import { getArenaMarketSnapshot } from "./arenaMarketSnapshot.js";

async function defaultQuery(text, params) {
  const { pool } = await import("../../server/db.js");
  return pool.query(text, params);
}

function text(value) {
  const result = String(value || "").trim();
  return result || null;
}

function safeImage(value) {
  const result = text(value);
  return result && !/^data:/i.test(result) ? result : null;
}

function identityPredicate(chainId, column, param) {
  return isSolanaChainId(Number(chainId))
    ? `${column} = ${param}`
    : `lower(coalesce(${column}, '')) = lower(${param})`;
}

async function loadNativeProfile(query, chainId, identity) {
  const campaignMatch = identityPredicate(chainId, "c.campaign_address::text", "$2");
  const tokenMatch = identityPredicate(chainId, "c.token_address::text", "$2");
  const metadataTokenMatch = identityPredicate(chainId, "m.token_address", "coalesce(c.token_address::text, '')");
  const metadataCampaignMatch = identityPredicate(chainId, "m.campaign_address", "c.campaign_address::text");
  const result = await query(
    `select c.chain_id, c.campaign_address, c.token_address, c.creator_address, c.name, c.symbol,
            meta.logo_uri, meta.description, meta.website, meta.external_url,
            meta.x_account, meta.telegram, meta.updated_at as metadata_updated_at
       from public.campaigns c
       left join lateral (
         select m.logo_uri, m.description, m.website, m.external_url, m.x_account, m.telegram, m.updated_at
           from public.token_metadata_registry m
          where m.chain_id = c.chain_id
            and (
              (m.token_address is not null and ${metadataTokenMatch})
              or (m.campaign_address is not null and ${metadataCampaignMatch})
            )
          order by m.updated_at desc
          limit 1
       ) meta on true
      where c.chain_id = $1
        and (${campaignMatch} or ${tokenMatch})
      order by c.created_block desc nulls last
      limit 1`,
    [chainId, identity],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    origin: "native",
    chainId: Number(row.chain_id),
    tokenAddress: text(row.token_address) || text(row.campaign_address),
    campaignAddress: text(row.campaign_address),
    creatorWallet: text(row.creator_address),
    name: text(row.name),
    symbol: text(row.symbol),
    imageUrl: safeImage(row.logo_uri),
    description: text(row.description),
    website: text(row.website || row.external_url),
    x: text(row.x_account),
    telegram: text(row.telegram),
    verifiedAt: null,
    metadataUpdatedAt: row.metadata_updated_at || null,
  };
}

async function loadImportedProfile(query, chainId, identity) {
  const tokenMatch = identityPredicate(chainId, "token_address", "$2");
  const result = await query(
    `select chain_id, token_address, owner_wallet, name, symbol,
            image_url, description, website, x_url, telegram_url,
            verified_at, metadata_updated_at
       from public.arena_token_imports
      where chain_id = $1 and ${tokenMatch}
      limit 1`,
    [chainId, identity],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    origin: "import",
    chainId: Number(row.chain_id),
    tokenAddress: text(row.token_address),
    campaignAddress: null,
    creatorWallet: text(row.owner_wallet),
    name: text(row.name),
    symbol: text(row.symbol),
    imageUrl: safeImage(row.image_url),
    description: text(row.description),
    website: text(row.website),
    x: text(row.x_url),
    telegram: text(row.telegram_url),
    verifiedAt: row.verified_at || null,
    metadataUpdatedAt: row.metadata_updated_at || null,
  };
}

export async function getArenaTokenProfile(chainId, tokenIdentity, deps = {}) {
  const idNum = Number(chainId);
  const identity = String(tokenIdentity || "").trim();
  if (!idNum || !identity) return null;
  const query = deps.query || defaultQuery;
  const base = await loadNativeProfile(query, idNum, identity) || await loadImportedProfile(query, idNum, identity);
  if (!base) return null;

  const getSnapshot = deps.getMarketSnapshot || getArenaMarketSnapshot;
  const market = await getSnapshot(idNum, base.tokenAddress || base.campaignAddress, {
    query,
    nowMs: deps.nowMs,
    resolveNativeUsd: deps.resolveNativeUsd,
  });
  return {
    identity: `${idNum}:${base.tokenAddress || base.campaignAddress}`,
    chainId: idNum,
    origin: base.origin,
    tokenAddress: base.tokenAddress,
    campaignAddress: base.campaignAddress,
    name: base.name,
    symbol: base.symbol,
    imageUrl: base.imageUrl,
    creatorWallet: base.creatorWallet,
    creatorDisplay: base.creatorWallet,
    description: base.description,
    website: base.website,
    x: base.x,
    telegram: base.telegram,
    verifiedAt: base.verifiedAt,
    metadataUpdatedAt: base.metadataUpdatedAt,
    marketCapUsd: market?.marketCapUsd ?? null,
    priceUsd: null,
    volume24hUsd: market?.volume24hUsd ?? null,
    holders: market?.holders ?? null,
    liquidityUsd: market?.liquidityUsd ?? null,
    marketDataUpdatedAt: market?.updatedAt ?? null,
    marketDataSource: market?.dataSource || "none",
    marketDataHealthy: market?.healthy === true,
    marketDataReasons: Array.isArray(market?.reasons) ? market.reasons : [],
  };
}
