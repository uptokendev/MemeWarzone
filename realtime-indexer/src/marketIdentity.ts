import { pool } from "./db.js";

/**
 * Public TokenDetails URLs use the token address/mint (stable, human-facing).
 * All market / trade / candle tables are keyed by the bonding campaign address.
 *
 * EVM addresses are normalized to lowercase. Solana base58 addresses are
 * case-sensitive and MUST be preserved exactly.
 */

export type MarketIdentity = {
  chainId: number;
  /** LaunchCampaign / Solana Campaign PDA (API + DB key). */
  campaignAddress: string;
  /** ERC-20 token / SPL mint (public URL id). */
  tokenAddress: string;
  /** Which form the caller supplied. */
  matchedBy: "campaign" | "token";
  /** Raw normalized input. */
  inputAddress: string;
};

function isSolanaChain(chainId: number) {
  return chainId === 101 || chainId === 102;
}

function normalizeAddress(chainId: number, value: unknown): string {
  const raw = String(value ?? "").trim();
  return isSolanaChain(chainId) ? raw : raw.toLowerCase();
}

export function isEvmAddress(value: string): boolean {
  return /^0x[a-f0-9]{40}$/.test(value);
}

export function isSolanaAddress(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function isMarketAddress(chainId: number, value: string): boolean {
  return isSolanaChain(chainId) ? isSolanaAddress(value) : isEvmAddress(value);
}

/**
 * Resolve a path/query address that may be either the campaign or the token.
 * Returns null when neither matches a known campaigns row on this chain.
 */
export async function resolveMarketIdentity(
  chainId: number,
  addressOrToken: string,
): Promise<MarketIdentity | null> {
  const input = normalizeAddress(chainId, addressOrToken);
  if (!Number.isInteger(chainId) || chainId <= 0 || !isMarketAddress(chainId, input)) {
    return null;
  }

  // Prefer exact campaign match, then token match (token/mint is the public URL id).
  // Solana URLs sometimes lose base58 case; fall back to lower() only after exact match.
  const result = await pool.query(
    `select
       campaign_address,
       token_address
     from public.campaigns
     where chain_id = $1
       and (
         campaign_address = $2
         or token_address = $2
         or ($3::boolean and lower(campaign_address) = lower($2))
         or ($3::boolean and lower(token_address) = lower($2))
       )
     order by
       case
         when campaign_address = $2 then 0
         when token_address = $2 then 1
         else 2
       end,
       updated_at desc nulls last
     limit 1`,
    [chainId, input, isSolanaChain(chainId)],
  );

  const row = result.rows[0];
  if (!row) return null;

  const campaignAddress = normalizeAddress(chainId, row.campaign_address);
  const tokenAddress = normalizeAddress(chainId, row.token_address);
  if (!isMarketAddress(chainId, campaignAddress)) return null;

  return {
    chainId,
    campaignAddress,
    tokenAddress: isMarketAddress(chainId, tokenAddress) ? tokenAddress : "",
    matchedBy: campaignAddress === input ? "campaign" : "token",
    inputAddress: input,
  };
}

/**
 * Like resolveMarketIdentity, but if the address is valid and not in DB yet,
 * still return it as a provisional campaign address so legacy campaign-only
 * callers keep working during discovery lag.
 */
export async function resolveMarketIdentityOrPassthrough(
  chainId: number,
  addressOrToken: string,
): Promise<MarketIdentity> {
  const input = normalizeAddress(chainId, addressOrToken);
  const resolved = await resolveMarketIdentity(chainId, input);
  if (resolved) return resolved;

  return {
    chainId,
    campaignAddress: input,
    tokenAddress: "",
    matchedBy: "campaign",
    inputAddress: input,
  };
}
