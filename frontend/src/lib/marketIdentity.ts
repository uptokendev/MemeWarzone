import { apiFetch } from "@/lib/apiBase";
import { getDefaultChainId, getEvmReadChainIdForTokenPage, pinTokenDetailsChainId, type SupportedChainId } from "@/lib/chainConfig";
import { normalizeEvmAddress } from "@/lib/tokenDetailsPath";

export type MarketIdentity = {
  chainId: number;
  campaignAddress: string;
  tokenAddress: string;
  matchedBy: "campaign" | "token";
  inputAddress: string;
  publicUrlAddress: string;
  /** True when indexer has no campaigns row yet (discovery/cleanup lag). */
  provisional?: boolean;
};

/**
 * Resolve public token URL id or campaign address to both identities via Railway indexer.
 */
export async function resolveMarketIdentity(input: {
  address: string;
  chainId: number;
  signal?: AbortSignal;
  /** When false (default), ignore soft provisional identities with no DB row. */
  acceptProvisional?: boolean;
}): Promise<MarketIdentity | null> {
  const address = normalizeEvmAddress(input.address);
  const chainId = Number(input.chainId || getDefaultChainId());
  if (!address || !Number.isFinite(chainId)) return null;

  try {
    const response = await apiFetch(
      `/api/market/resolve?chainId=${chainId}&address=${address}`,
      { method: "GET", cache: "no-store", signal: input.signal },
    );
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    if (!body?.ok) return null;
    const provisional = Boolean(body.provisional);
    if (provisional && !input.acceptProvisional) return null;
    const campaignAddress = normalizeEvmAddress(body.campaignAddress);
    const tokenAddress = normalizeEvmAddress(body.tokenAddress);
    if (!campaignAddress) return null;
    return {
      chainId,
      campaignAddress,
      tokenAddress,
      matchedBy: body.matchedBy === "token" ? "token" : "campaign",
      inputAddress: normalizeEvmAddress(body.inputAddress) || address,
      publicUrlAddress: normalizeEvmAddress(body.publicUrlAddress) || tokenAddress || campaignAddress,
      provisional,
    };
  } catch {
    return null;
  }
}

/**
 * Find which EVM chain (97/56) hosts this token or campaign.
 * Prefer the app's token-page read chain, then the other EVM chain.
 * Pins the result so launchpad metrics use the same network as the page.
 * Skips provisional identities so a missing DB row on chain A cannot hide a real row on chain B.
 */
export async function resolveMarketIdentityAcrossEvm(input: {
  address: string;
  signal?: AbortSignal;
}): Promise<MarketIdentity | null> {
  const address = normalizeEvmAddress(input.address);
  if (!address) return null;

  const preferred = getEvmReadChainIdForTokenPage();
  const order = Array.from(
    new Set(
      [preferred, 56, 97, 46630, 4663].filter((id) => Number.isInteger(id) && id > 0),
    ),
  ) as SupportedChainId[];

  for (const chainId of order) {
    const identity = await resolveMarketIdentity({
      address,
      chainId,
      signal: input.signal,
      acceptProvisional: false,
    });
    if (identity?.campaignAddress && !identity.provisional) {
      pinTokenDetailsChainId(identity.chainId as SupportedChainId);
      return identity;
    }
  }
  return null;
}
