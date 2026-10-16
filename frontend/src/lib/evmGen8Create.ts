/**
 * Generation 8 create from the create page (design 6.1, D3 signed create only): the same steps as the gen-7 create
 * (wallet on the right chain, create preflight, POST /api/routing/create-authorization, the transaction, the metadata
 * mirror), with the gen-8 launcher: launcher.launch(launchRequest, { deadline, signature }, { value: firstBuyValue })
 * exactly as the API returned it, and the coin read from the Launched event. A gen-8 coin's campaign address is its
 * token address (one V4 pool, no campaign contract).
 */
import type { Signer } from "ethers";
import { apiFetch } from "@/lib/apiBase";
import { runCatalogAction } from "@/lib/analytics/actions";
import { fetchLaunchpadCreatePreflight } from "@/lib/recruiterApi";
import { assertWalletOnChain } from "@/lib/walletChainGuard.mjs";
import { gen8CreateAuthorizationBody, gen8ErrorMessage, launchGen8Coin } from "@/lib/evmGen8Client.mjs";
import { getReadProvider } from "@/lib/readProvider";
import type { SupportedChainId } from "@/lib/chainConfig";
import { GEN8_VENUE_BARKSWAP, gen8VenueFor } from "../../shared/evmGen8.mjs";

/** The app's read provider for a Barkswap launch; null on the V4 chains (unchanged) or when the chain has no RPC. */
function barkReadProvider(chainId: number) {
  if (gen8VenueFor(chainId) !== GEN8_VENUE_BARKSWAP) return null;
  try {
    return getReadProvider(chainId as SupportedChainId);
  } catch {
    return null;
  }
}

export type Gen8CreateInput = {
  signer: Signer;
  account: string;
  chainId: number;
  launcher: string;
  name: string;
  symbol: string;
  logoURI: string;
  xAccount: string;
  website: string;
  extraLink: string;
  description: string;
  targetUsd: bigint;
  feeChoice: "keep" | "holders" | "split" | "buyback";
  feeCreatorPct: number;
  firstBuyValueWei: bigint;
  /** Unix seconds. 0 (default) opens trading at launch; a future time creates the pool now and opens trading then. */
  openAt?: number;
};

async function postJson(path: string, body: unknown) {
  const res = await apiFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(String((json as any)?.error || (json as any)?.message || `Request failed (${res.status})`));
    (error as any).code = (json as any)?.code;
    throw error;
  }
  return json as any;
}

/** Same best-effort mirror the gen-7 create runs (token_metadata_registry via /api/campaigns/upsert). */
async function mirrorMetadata(input: Gen8CreateInput, token: string) {
  try {
    let authFields: Record<string, string | number> = {};
    try {
      const { signWalletAction } = await import("@/lib/walletActionAuth");
      const auth = await signWalletAction({
        action: "campaign_upsert",
        walletAddress: input.account.toLowerCase(),
        chainId: input.chainId,
        signer: input.signer as any,
        extraLines: [`Campaign: ${token.toLowerCase()}`],
      });
      authFields = {
        action: auth.action,
        walletAddress: auth.walletAddress,
        nonce: auth.nonce,
        message: auth.message,
        signature: auth.signature,
        ...(auth.walletType ? { walletType: auth.walletType } : {}),
      };
    } catch (signErr) {
      console.warn("[evmGen8Create] campaign upsert auth sign skipped", signErr);
    }
    await apiFetch("/api/campaigns/upsert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chainId: input.chainId,
        campaignAddress: token.toLowerCase(),
        tokenAddress: token.toLowerCase(),
        creatorAddress: input.account.toLowerCase(),
        name: input.name,
        symbol: input.symbol,
        logoURI: input.logoURI,
        xAccount: input.xAccount,
        website: input.website,
        extraLink: input.extraLink,
        description: input.description,
        ...authFields,
      }),
    });
  } catch (error) {
    console.warn("[evmGen8Create] Campaign metadata mirror failed", error);
  }
}

export async function createGen8Campaign(input: Gen8CreateInput) {
  return runCatalogAction({
    fn: "token_create",
    start: "token_create_started",
    success: "token_create_succeeded",
    fail: "token_create_failed",
    properties: { surface: "launchpad", chain: String(input.chainId), generation: "8" },
    work: async () => {
      await assertWalletOnChain(input.signer, input.chainId, input.launcher);
      await fetchLaunchpadCreatePreflight(input.account, input.chainId);
      const authorization = await postJson(
        "/api/routing/create-authorization",
        gen8CreateAuthorizationBody({
          chainId: input.chainId,
          walletAddress: input.account,
          launcher: input.launcher,
          name: input.name,
          symbol: input.symbol,
          logoURI: input.logoURI,
          xAccount: input.xAccount,
          website: input.website,
          extraLink: input.extraLink,
          description: input.description,
          targetUsd: input.targetUsd,
          feeChoice: input.feeChoice,
          feeCreatorPct: input.feeCreatorPct,
          firstBuyValueWei: input.firstBuyValueWei,
          openAt: input.openAt ?? 0,
        }),
      );
      let launched;
      let receipt;
      try {
        ({ launched, receipt } = await launchGen8Coin({
          signer: input.signer,
          chainId: input.chainId,
          launcher: input.launcher,
          authorization,
          firstBuyValueWei: input.firstBuyValueWei,
          // Barkswap (DogeOS): the 6.3M-gas launch is estimated and its receipt polled on the app's read provider,
          // not the wallet's block poll. The V4 launch ignores it.
          readProvider: barkReadProvider(input.chainId),
        }));
      } catch (error) {
        const words = gen8ErrorMessage(error);
        if (words) throw new Error(words);
        throw error;
      }
      await mirrorMetadata(input, launched.token);
      try {
        window.dispatchEvent(
          new CustomEvent("memewarzone:txConfirmed", {
            detail: { kind: "create", chainId: input.chainId, txHash: receipt?.hash, campaignAddress: launched.token.toLowerCase(), tokenAddress: launched.token.toLowerCase() },
          }),
        );
      } catch {
        // non-fatal
      }
      return { campaignAddress: launched.token.toLowerCase(), tokenAddress: launched.token.toLowerCase(), poolId: launched.poolId, firstBuyOut: launched.firstBuyOut, txHash: receipt?.hash ?? null };
    },
  });
}
