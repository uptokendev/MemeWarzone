import { pool } from "../server/db.js";
import { badMethod, getQuery, isSolanaChain, json, normalizeAddress } from "../server/http.js";

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function cleanAddress(value, chainId) {
  return normalizeAddress(value, chainId);
}

function addressMatchSql(chainId) {
  if (isSolanaChain(chainId)) {
    return "(campaign_address = $2 or token_address = $2)";
  }
  return "(lower(campaign_address) = $2 or lower(token_address) = $2)";
}

function schemaMissing(error) {
  return error?.code === "42P01" || error?.code === "42703";
}

function safeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function absoluteUrl(req, path) {
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim() || "https";
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  if (!host) return path;
  return `${proto}://${host}${path}`;
}

function campaignUrl(req, chainId, campaignAddress, tokenAddress) {
  // Public token pages use the ERC-20 address; campaign is only a fallback.
  const identifier = tokenAddress || campaignAddress || "";
  return absoluteUrl(req, `/token/${identifier}?chainId=${chainId}`);
}

function metadataPayload(req, row) {
  const metadata = safeMetadata(row.metadata);
  const chainId = Number(row.chain_id);
  const campaignAddress = row.campaign_address
    ? (isSolanaChain(chainId) ? String(row.campaign_address) : String(row.campaign_address).toLowerCase())
    : null;
  const tokenAddress = row.token_address
    ? (isSolanaChain(chainId) ? String(row.token_address) : String(row.token_address).toLowerCase())
    : null;
  const logoUri = row.logo_uri || row.image || null;
  const externalUrl = row.external_url || campaignUrl(req, chainId, campaignAddress, tokenAddress);

  return {
    name: row.name || row.symbol || "MemeWarzone Token",
    symbol: row.symbol || "MWZ",
    description: row.description || metadata.description || "Launched on MemeWarzone.",
    image: logoUri,
    image_url: logoUri,
    external_url: externalUrl,
    animation_url: metadata.animation_url || null,
    attributes: [
      { trait_type: "Launchpad", value: "MemeWarzone" },
      { trait_type: "Chain ID", value: chainId },
      ...(campaignAddress ? [{ trait_type: "Campaign", value: campaignAddress }] : []),
      ...(tokenAddress ? [{ trait_type: "Token", value: tokenAddress }] : []),
    ],
    properties: {
      launchpad: "MemeWarzone",
      chainId,
      campaignAddress,
      tokenAddress,
      creatorAddress: row.creator_address
        ? (isSolanaChain(chainId) ? String(row.creator_address) : String(row.creator_address).toLowerCase())
        : null,
      website: row.website || null,
      x: row.x_account || null,
      telegram: row.telegram || null,
      discord: row.discord || null,
      extraLink: metadata.extraLink || metadata.extra_link || null,
      source: row.source || "memewarzone",
    },
  };
}

function emptyMetadataPayload(req, chainId, address) {
  return {
    name: "",
    symbol: "",
    description: "",
    image: null,
    image_url: null,
    external_url: campaignUrl(req, chainId, address, address),
    animation_url: null,
    attributes: [
      { trait_type: "Launchpad", value: "MemeWarzone" },
      { trait_type: "Chain ID", value: chainId },
      { trait_type: "Campaign", value: address },
    ],
    properties: {
      launchpad: "MemeWarzone",
      chainId,
      campaignAddress: address,
      tokenAddress: null,
      creatorAddress: null,
      website: null,
      x: null,
      telegram: null,
      discord: null,
      source: "empty-fallback",
    },
  };
}

async function findRegistryMetadata({ chainId, address }) {
  try {
    const registry = await pool.query(
      `select chain_id,
              campaign_address,
              token_address,
              creator_address,
              name,
              symbol,
              description,
              logo_uri,
              metadata_uri,
              external_url,
              website,
              x_account,
              telegram,
              discord,
              source,
              metadata
         from public.token_metadata_registry
        where chain_id = $1
          and ${addressMatchSql(chainId)}
        limit 1`,
      [chainId, address],
    );
    return registry.rows[0] || null;
  } catch (error) {
    if (schemaMissing(error)) return null;
    console.warn("[api/token-metadata] registry lookup failed; falling back to campaigns", error);
    return null;
  }
}

async function findCampaignMetadata({ chainId, address }) {
  try {
    const campaigns = await pool.query(
      `select chain_id,
              campaign_address,
              token_address,
              creator_address,
              name,
              symbol,
              null::text as description,
              logo_uri,
              null::text as metadata_uri,
              null::text as external_url,
              null::text as website,
              null::text as x_account,
              null::text as telegram,
              null::text as discord,
              'campaigns'::text as source,
              '{}'::jsonb as metadata
         from public.campaigns
        where chain_id = $1
          and ${addressMatchSql(chainId)}
        limit 1`,
      [chainId, address],
    );
    return campaigns.rows[0] || null;
  } catch (error) {
    if (schemaMissing(error)) return null;
    console.warn("[api/token-metadata] campaign lookup failed", error);
    return null;
  }
}

async function findMetadata({ chainId, address }) {
  const registry = await findRegistryMetadata({ chainId, address });
  if (registry) return registry;
  return findCampaignMetadata({ chainId, address });
}

export default async function handler(req, res) {
  if (req.method !== "GET") return badMethod(res);

  try {
    const q = getQuery(req);
    const chainId = toInt(req.params?.chainId || q.chainId, 97);
    const address = cleanAddress(req.params?.address || q.address || q.token || q.campaign, chainId);

    if (!address) return json(res, 400, { error: "Invalid or missing token/campaign address" });

    const row = await findMetadata({ chainId, address });
    res.setHeader("cache-control", "public, max-age=60, s-maxage=300");
    if (!row) return json(res, 200, emptyMetadataPayload(req, chainId, address));

    return json(res, 200, metadataPayload(req, row));
  } catch (error) {
    console.error("[api/token-metadata]", error);
    return json(res, 500, { error: "Server error" });
  }
}
