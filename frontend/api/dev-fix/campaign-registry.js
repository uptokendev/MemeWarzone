/**
 * Upsert a deployed draft into public.campaigns so home/token feeds can see it
 * without waiting for an indexer (critical for Solana V4 create).
 */
import { isSolanaChain } from "../../server/http.js";
import { findProgramAddressSync, publicKeyBytes } from "./solana-v4-primitives.js";

const FEE_ESCROW_SEED = Buffer.from("fee-escrow", "utf8");
const DEFAULT_SOLANA_PROGRAM_ID = "3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt";

async function enqueueSolanaFeeEscrowInit(db, { chainId, campaignAddress, programId }) {
  if (!isSolanaChain(chainId) || !campaignAddress) return;
  try {
    const program = String(programId || process.env.SOLANA_LAUNCHPAD_PROGRAM_ID || DEFAULT_SOLANA_PROGRAM_ID).trim();
    const escrow = findProgramAddressSync(
      [FEE_ESCROW_SEED, publicKeyBytes(campaignAddress)],
      program,
    ).publicKey;
    await db.query(
      `insert into public.solana_fee_escrow_accruals(chain_id, campaign_address, escrow_address, init_status)
       values ($1, $2, $3, 'pending')
       on conflict (chain_id, campaign_address) do update set
         escrow_address = excluded.escrow_address,
         updated_at = now()`,
      [Number(chainId), campaignAddress, escrow],
    );
  } catch (error) {
    console.warn("[campaign-registry] fee escrow enqueue failed", error?.message || error);
  }
}

function normalizeRegistryAddress(value, chainId) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (isSolanaChain(chainId)) return raw;
  return raw.toLowerCase();
}

function normalizeSolanaPubkey(value) {
  const raw = String(value || "").trim();
  return raw || null;
}

/**
 * Normalize campaignId from hex string, byte array, or Buffer → 64-char hex.
 */
export function normalizeCampaignIdHex(value) {
  if (!value && value !== 0) return null;
  if (Buffer.isBuffer(value) && value.length === 32) return value.toString("hex");
  if (Array.isArray(value) && value.length === 32) {
    try {
      return Buffer.from(value).toString("hex");
    } catch {
      return null;
    }
  }
  const raw = String(value).replace(/^0x/i, "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return raw.toLowerCase();
  return null;
}

/**
 * Build the `meta.solana` blob for vault / campaignId persistence.
 * @returns {Record<string, unknown> | null}
 */
export function buildSolanaCampaignMeta(input = {}) {
  const tokenVault = normalizeSolanaPubkey(input.tokenVault);
  const solVault = normalizeSolanaPubkey(input.solVault);
  const campaignIdHex = normalizeCampaignIdHex(input.campaignId ?? input.campaignIdHex);
  const programId = normalizeSolanaPubkey(input.programId ?? input.factoryAddress);
  if (!tokenVault && !solVault && !campaignIdHex) return null;
  return {
    ...(campaignIdHex ? { campaignIdHex } : {}),
    ...(tokenVault ? { tokenVault } : {}),
    ...(solVault ? { solVault } : {}),
    ...(programId ? { programId } : {}),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Merge solana vault/campaignId into campaigns.meta without clobbering other keys.
 */
export async function mergeCampaignSolanaMeta(db, { chainId, campaignAddress, solana }) {
  if (!solana || typeof solana !== "object") return { ok: false, skipped: true };
  const chain = Number(chainId);
  const addr = normalizeRegistryAddress(campaignAddress, chain);
  if (!Number.isFinite(chain) || !addr) return { ok: false, error: "Missing chainId/campaignAddress for meta merge." };

  try {
    const result = await db.query(
      `update public.campaigns
          set meta = jsonb_set(
                coalesce(meta, '{}'::jsonb),
                '{solana}',
                coalesce(meta -> 'solana', '{}'::jsonb) || $3::jsonb,
                true
              ),
              updated_at = now()
        where chain_id = $1
          and campaign_address = $2
        returning chain_id, campaign_address, meta`,
      [chain, addr, JSON.stringify(solana)],
    );
    if (!result.rows[0]) return { ok: false, error: "Campaign row not found for meta merge." };
    return { ok: true, row: result.rows[0] };
  } catch (error) {
    console.warn("[campaign-registry] meta merge failed", error?.message || error);
    return { ok: false, error: String(error?.message || error) };
  }
}

/**
 * @param {import("pg").Pool | import("pg").PoolClient} db
 * @param {{
 *   chainId: number,
 *   campaignAddress: string,
 *   tokenAddress?: string | null,
 *   creatorWallet: string,
 *   name?: string | null,
 *   symbol?: string | null,
 *   logoUrl?: string | null,
 *   deployTxHash?: string | null,
 *   factoryAddress?: string | null,
 *   tokenVault?: string | null,
 *   solVault?: string | null,
 *   campaignId?: string | number[] | Buffer | null,
 *   campaignIdHex?: string | null,
 *   programId?: string | null,
 * }} input
 * @returns {Promise<{ ok: boolean, row?: any, error?: string, attempts?: string[], metaMerged?: boolean }>}
 */
export async function upsertCampaignFromDraft(db, input) {
  const chainId = Number(input.chainId);
  const campaignAddress = normalizeRegistryAddress(input.campaignAddress, chainId);
  if (!Number.isFinite(chainId) || !campaignAddress) {
    return { ok: false, error: "Missing chainId or campaignAddress for campaigns upsert." };
  }

  const tokenAddress = normalizeRegistryAddress(input.tokenAddress, chainId);
  const creatorAddress = normalizeRegistryAddress(input.creatorWallet, chainId);
  const name = String(input.name || "").trim() || null;
  const symbol = String(input.symbol || "").trim().toUpperCase() || null;
  const logoUri = String(input.logoUrl || "").trim() || null;
  const factoryAddress = String(input.factoryAddress || input.programId || "").trim() || null;
  const solanaMeta = isSolanaChain(chainId)
    ? buildSolanaCampaignMeta({
        tokenVault: input.tokenVault,
        solVault: input.solVault,
        campaignId: input.campaignId,
        campaignIdHex: input.campaignIdHex,
        programId: input.programId || factoryAddress,
      })
    : null;
  const attempts = [];

  // Try progressively simpler inserts so partial schemas still register the campaign.
  const strategies = [
    {
      label: "full",
      sql: `insert into public.campaigns (
              chain_id, campaign_address, token_address, creator_address,
              name, symbol, logo_uri, factory_address,
              created_block, is_active, launched, created_at_chain, created_at, updated_at
            ) values (
              $1,$2,$3,$4,$5,$6,$7,$8,
              0, true, true, now(), now(), now()
            )
            on conflict (chain_id, campaign_address) do update set
              token_address = coalesce(excluded.token_address, campaigns.token_address),
              creator_address = coalesce(excluded.creator_address, campaigns.creator_address),
              name = coalesce(excluded.name, campaigns.name),
              symbol = coalesce(excluded.symbol, campaigns.symbol),
              logo_uri = coalesce(nullif(excluded.logo_uri, ''), campaigns.logo_uri),
              factory_address = coalesce(excluded.factory_address, campaigns.factory_address),
              is_active = true,
              launched = true,
              updated_at = now()
            returning chain_id, campaign_address, token_address, creator_address, name, symbol`,
      params: [chainId, campaignAddress, tokenAddress, creatorAddress, name, symbol, logoUri, factoryAddress],
    },
    {
      label: "no_logo_factory",
      sql: `insert into public.campaigns (
              chain_id, campaign_address, token_address, creator_address,
              name, symbol, created_block, is_active, created_at_chain, created_at, updated_at
            ) values (
              $1,$2,$3,$4,$5,$6, 0, true, now(), now(), now()
            )
            on conflict (chain_id, campaign_address) do update set
              token_address = coalesce(excluded.token_address, campaigns.token_address),
              creator_address = coalesce(excluded.creator_address, campaigns.creator_address),
              name = coalesce(excluded.name, campaigns.name),
              symbol = coalesce(excluded.symbol, campaigns.symbol),
              is_active = true,
              updated_at = now()
            returning chain_id, campaign_address, token_address, creator_address, name, symbol`,
      params: [chainId, campaignAddress, tokenAddress, creatorAddress, name, symbol],
    },
    {
      label: "minimal",
      sql: `insert into public.campaigns (
              chain_id, campaign_address, token_address, creator_address, name, symbol, is_active
            ) values ($1,$2,$3,$4,$5,$6,true)
            on conflict (chain_id, campaign_address) do update set
              token_address = coalesce(excluded.token_address, campaigns.token_address),
              creator_address = coalesce(excluded.creator_address, campaigns.creator_address),
              name = coalesce(excluded.name, campaigns.name),
              symbol = coalesce(excluded.symbol, campaigns.symbol),
              is_active = true,
              updated_at = now()
            returning chain_id, campaign_address, token_address, creator_address, name, symbol`,
      params: [chainId, campaignAddress, tokenAddress, creatorAddress, name, symbol],
    },
  ];

  let lastError = null;
  let row = null;
  for (const strategy of strategies) {
    try {
      const result = await db.query(strategy.sql, strategy.params);
      row = result.rows[0] || null;
      if (row) {
        attempts.push(`${strategy.label}:ok`);
        console.info("[campaign-registry] upsert ok", {
          strategy: strategy.label,
          chainId,
          campaignAddress,
          tokenAddress,
        });
        break;
      }
      attempts.push(`${strategy.label}:empty`);
    } catch (error) {
      lastError = error;
      attempts.push(`${strategy.label}:${error?.code || error?.message || "error"}`);
      console.warn("[campaign-registry] upsert attempt failed", strategy.label, error?.message || error);
    }
  }

  if (!row) {
    return {
      ok: false,
      error: String(lastError?.message || lastError || "campaigns upsert failed"),
      attempts,
    };
  }

  let metaMerged = false;
  if (solanaMeta) {
    const merged = await mergeCampaignSolanaMeta(db, {
      chainId,
      campaignAddress,
      solana: solanaMeta,
    });
    metaMerged = Boolean(merged?.ok);
    if (merged?.ok && merged.row) {
      row = { ...row, meta: merged.row.meta };
    } else if (!merged?.ok && !merged?.skipped) {
      attempts.push(`meta:${merged?.error || "failed"}`);
      console.warn("[campaign-registry] solana meta not stored", merged?.error);
    }
  }

  if (isSolanaChain(chainId)) {
    await enqueueSolanaFeeEscrowInit(db, {
      chainId,
      campaignAddress,
      programId: input.programId || factoryAddress,
    });
  }

  return { ok: true, row, attempts, metaMerged };
}

/**
 * Resolve a campaign or mint from campaigns + campaign_drafts (Solana-safe, case-preserving).
 */
export async function resolveCampaignByAddress(db, { chainId, address }) {
  const chain = Number(chainId);
  const addr = String(address || "").trim();
  if (!Number.isFinite(chain) || !addr) return null;

  const isSolana = isSolanaChain(chain);
  if (isSolana) {
    const camp = await db.query(
      `select chain_id, campaign_address, token_address, creator_address, name, symbol, logo_uri,
              created_at_chain, created_at, is_active, meta
         from public.campaigns
        where chain_id = $1
          and (campaign_address = $2 or token_address = $2)
        limit 1`,
      [chain, addr],
    );
    if (camp.rows[0]) {
      return { source: "campaigns", ...camp.rows[0] };
    }
    // Case-insensitive fallback for bookmarks that lowercased base58.
    const campCi = await db.query(
      `select chain_id, campaign_address, token_address, creator_address, name, symbol, logo_uri,
              created_at_chain, created_at, is_active, meta
         from public.campaigns
        where chain_id = $1
          and (
            lower(campaign_address) = lower($2)
            or lower(coalesce(token_address, '')) = lower($2)
          )
        limit 1`,
      [chain, addr],
    );
    if (campCi.rows[0]) {
      return { source: "campaigns", ...campCi.rows[0] };
    }
    const draft = await db.query(
      `select chain_id, campaign_address, token_address, creator_wallet as creator_address,
              name, ticker as symbol, logo_url as logo_uri,
              deployed_at as created_at_chain, created_at, true as is_active,
              id as draft_id, slug, status, visibility
         from public.campaign_drafts
        where chain_id = $1
          and campaign_address is not null
          and (campaign_address = $2 or token_address = $2)
        order by updated_at desc
        limit 1`,
      [chain, addr],
    );
    if (draft.rows[0]) {
      return { source: "campaign_drafts", ...draft.rows[0] };
    }
    return null;
  }

  const lower = addr.toLowerCase();
  const camp = await db.query(
    `select chain_id, campaign_address, token_address, creator_address, name, symbol, logo_uri,
            created_at_chain, created_at, is_active, meta
       from public.campaigns
      where chain_id = $1
        and (lower(campaign_address) = $2 or lower(coalesce(token_address,'')) = $2)
      limit 1`,
    [chain, lower],
  );
  return camp.rows[0] ? { source: "campaigns", ...camp.rows[0] } : null;
}

/**
 * Extract solana vault fields from a campaigns.meta JSON blob.
 */
export function solanaMetaFromRow(row) {
  const meta = row?.meta && typeof row.meta === "object" ? row.meta : null;
  const solana = meta?.solana && typeof meta.solana === "object" ? meta.solana : null;
  if (!solana) return null;
  return {
    campaignIdHex: normalizeCampaignIdHex(solana.campaignIdHex || solana.campaignId) || null,
    tokenVault: normalizeSolanaPubkey(solana.tokenVault) || null,
    solVault: normalizeSolanaPubkey(solana.solVault) || null,
    programId: normalizeSolanaPubkey(solana.programId) || null,
  };
}
