import { pool } from "../../server/db.js";
import { badMethod, json, normalizeAddress, readJson } from "../../server/http.js";
import { getExpectedInternalToken, readInternalToken } from "../lib/apiAuth.js";
import { requireWalletActionAuth } from "../lib/walletActionAuth.js";

function cleanText(value, max = 280) {
  return String(value ?? "").trim().slice(0, max);
}

function cleanAddress(value, chainId) {
  return normalizeAddress(value, chainId);
}

function metadataUrlFromRequest(req, chainId, tokenAddress, campaignAddress) {
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim() || "https";
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  const address = cleanAddress(tokenAddress, chainId) || cleanAddress(campaignAddress, chainId);
  if (!host || !address) return "";
  return `${proto}://${host}/api/token-metadata/${chainId}/${address}`;
}

async function mirrorTokenMetadata(req, body) {
  const chainId = Number(body.chainId);
  const campaignAddress = cleanAddress(body.campaignAddress, chainId);
  const tokenAddress = cleanAddress(body.tokenAddress, chainId);
  const creatorAddress = cleanAddress(body.creatorAddress, chainId);
  const name = cleanText(body.name, 64);
  const symbol = cleanText(body.symbol, 16);
  const description = cleanText(body.description, 1000) || null;
  const logoUri = cleanText(body.logoURI ?? body.logoUri ?? body.logo_url, 1000) || null;
  const website = cleanText(body.website, 500) || null;
  const xAccount = cleanText(body.xAccount ?? body.twitter, 500) || null;
  const extraLink = cleanText(body.extraLink ?? body.extra_link ?? body.otherUrl ?? body.other_url, 1000) || null;
  const telegram = cleanText(body.telegram, 500) || null;
  const discord = cleanText(body.discord, 500) || null;
  const externalUrl = cleanText(body.externalUrl ?? body.external_url, 1000) || null;
  const metadataUri = cleanText(body.metadataURI ?? body.metadataUri ?? body.metadata_url, 1000)
    || metadataUrlFromRequest(req, chainId, tokenAddress, campaignAddress)
    || null;

  if (!Number.isFinite(chainId) || (!campaignAddress && !tokenAddress)) return;

  const metadata = JSON.stringify({
    mirroredAt: new Date().toISOString(),
    rawSource: "campaigns_upsert",
    ...(extraLink ? { extraLink } : {}),
  });

  try {
    const existing = await pool.query(
      `select id
         from public.token_metadata_registry
        where chain_id = $1
          and (
            ($2::text is not null and campaign_address = $2::text)
            or ($3::text is not null and token_address = $3::text)
          )
        order by id asc
        limit 1`,
      [chainId, campaignAddress || null, tokenAddress || null],
    );

    if (existing.rows[0]?.id) {
      await pool.query(
        `update public.token_metadata_registry
            set campaign_address = coalesce($2, campaign_address),
                token_address = coalesce($3, token_address),
                creator_address = coalesce($4, creator_address),
                name = coalesce(nullif($5, ''), name),
                symbol = coalesce(nullif($6, ''), symbol),
                description = coalesce($7, description),
                logo_uri = coalesce($8, logo_uri),
                metadata_uri = coalesce($9, metadata_uri),
                external_url = coalesce($10, external_url),
                website = coalesce($11, website),
                x_account = coalesce($12, x_account),
                telegram = coalesce($13, telegram),
                discord = coalesce($14, discord),
                source = 'campaigns_upsert',
                metadata = metadata || $15::jsonb
          where id = $1`,
        [
          existing.rows[0].id,
          campaignAddress || null,
          tokenAddress || null,
          creatorAddress || null,
          name || null,
          symbol || null,
          description,
          logoUri,
          metadataUri,
          externalUrl,
          website,
          xAccount,
          telegram,
          discord,
          metadata,
        ],
      );
      return;
    }

    await pool.query(
      `insert into public.token_metadata_registry (
         chain_id,
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
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8,
         $9, $10, $11, $12, $13, $14, 'campaigns_upsert', $15::jsonb
       )`,
      [
        chainId,
        campaignAddress || null,
        tokenAddress || null,
        creatorAddress || null,
        name || null,
        symbol || null,
        description,
        logoUri,
        metadataUri,
        externalUrl,
        website,
        xAccount,
        telegram,
        discord,
        metadata,
      ],
    );
  } catch (error) {
    if (error?.code === "42P01" || error?.code === "42703") {
      console.warn("[api/campaigns/upsert] token metadata registry unavailable; skipping metadata mirror");
      return;
    }
    console.warn("[api/campaigns/upsert] metadata mirror failed", error);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return badMethod(res);

  try {
    const b = await readJson(req);
    const chainId = Number(b.chainId);
    const campaignAddress = cleanAddress(b.campaignAddress, chainId);
    const tokenAddress = cleanAddress(b.tokenAddress, chainId);
    const creatorAddress = cleanAddress(b.creatorAddress, chainId);
    const name = cleanText(b.name, 64);
    const symbol = cleanText(b.symbol, 16);

    if (!Number.isFinite(chainId)) return json(res, 400, { error: "Invalid chainId" });
    if (!campaignAddress) return json(res, 400, { error: "Invalid campaignAddress" });
    if (!tokenAddress) return json(res, 400, { error: "Invalid tokenAddress" });
    if (!creatorAddress) return json(res, 400, { error: "Invalid creatorAddress" });

    // Dual-auth: valid internal token (service) OR creator wallet signature (legacy open until enforce).
    const expectedInternal = getExpectedInternalToken();
    const providedInternal = readInternalToken(req);
    const internalAuthed = Boolean(expectedInternal && providedInternal && providedInternal === expectedInternal);
    if (!internalAuthed) {
      const verified = await requireWalletActionAuth({
        res,
        pool,
        auth: b.auth || b,
        expectedWallet: creatorAddress,
        chainId,
        action: "campaign_upsert",
        routeLabel: "campaigns/upsert",
        extraLines: ["Campaign: " + campaignAddress],
      });
      if (!verified) return;
    }

    const logoUri = cleanText(b.logoURI ?? b.logoUri ?? b.logo_url, 1000) || null;

    await pool.query(
      `INSERT INTO campaigns (chain_id, campaign_address, token_address, creator_address, name, symbol, logo_uri)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (chain_id, campaign_address)
       DO UPDATE SET
         token_address = EXCLUDED.token_address,
         creator_address = EXCLUDED.creator_address,
         name = EXCLUDED.name,
         symbol = EXCLUDED.symbol,
         logo_uri = COALESCE(NULLIF(BTRIM(EXCLUDED.logo_uri), ''), public.campaigns.logo_uri),
         updated_at = NOW()`,
      [chainId, campaignAddress, tokenAddress, creatorAddress, name, symbol, logoUri]
    );

    await mirrorTokenMetadata(req, b);

    return json(res, 200, {
      ok: true,
      metadataUri: metadataUrlFromRequest(req, chainId, tokenAddress, campaignAddress) || null,
    });
  } catch (e) {
    console.error("[api/campaigns/upsert]", e);
    return json(res, 500, { error: "Server error" });
  }
}
