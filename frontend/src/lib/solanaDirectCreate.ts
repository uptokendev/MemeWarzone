import { apiFetch } from "@/lib/apiBase";
import type { WalletActionAuthPayload } from "@/lib/walletActionAuth";
import type { SolanaV4CreateAuthorizationResponse } from "@/lib/solanaCreateAuthorizationV4";
import {
  assertFreshGraduationQuote,
  type GraduationQuoteAsset,
} from "@/lib/graduationQuoteCatalog";

export type SolanaDirectPreflightResponse = {
  ok: true;
  chainId: number;
  cluster: string;
  programId: string;
  preflight: {
    chainNow: number;
    allowed: boolean;
    cooldownActive: boolean;
    liveLimitReached: boolean;
    creatorTier: number;
    creatorLiveBondingCount: number;
    creatorMaxLiveBondingCount: number;
    cooldownSeconds: number;
    nextAllowedAt: number | null;
    creatorProfileImplicitDefault: boolean;
    riskProfileImplicitDefault: boolean;
  };
};

export type SolanaDirectBeginResponse = {
  ok: true;
  chainId: number;
  cluster: string;
  programId: string;
  alreadyOnChain: boolean;
  sessionToken?: string;
  tokenPath?: string;
  accounts?: {
    campaign: string;
    mint: string;
    tokenVault?: string;
    solVault?: string;
  };
  reservation?: Record<string, unknown>;
};

export type SolanaDirectAuthorizationResponse = SolanaV4CreateAuthorizationResponse & {
  ok: true;
  finalizeToken: string;
};

export type SolanaDirectFinalizeResponse = {
  ok: true;
  campaignAddress: string;
  mintAddress: string;
  tokenVault: string;
  solVault: string;
  tokenPath: string;
  tickerReservation: Record<string, unknown>;
  registryUpserted: true;
  registryMetaMerged: true;
};

async function postDirect(body: Record<string, unknown>) {
  const response = await apiFetch("/api/solana/direct-create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = String(payload?.error || payload?.message || `Solana Direct request failed (${response.status}).`);
    const code = payload?.code ? String(payload.code) : "";
    const error = new Error(code ? `${message} [${code}]` : message) as Error & { code?: string; status?: number };
    error.code = code || undefined;
    error.status = response.status;
    throw error;
  }
  return payload;
}

export async function preflightSolanaDirectCreate(input: {
  creatorWallet: string;
  chainId: number;
  graduationTargetUsdMicros: string | number | bigint;
}): Promise<SolanaDirectPreflightResponse> {
  return postDirect({
    operation: "preflight",
    creatorWallet: input.creatorWallet,
    chainId: input.chainId,
    graduationTargetUsdMicros: String(input.graduationTargetUsdMicros),
  }) as Promise<SolanaDirectPreflightResponse>;
}

export async function beginSolanaDirectCreate(input: {
  creatorWallet: string;
  chainId: number;
  ticker: string;
  auth: WalletActionAuthPayload;
}): Promise<SolanaDirectBeginResponse> {
  return postDirect({ operation: "begin", creatorWallet: input.creatorWallet, chainId: input.chainId, ticker: input.ticker, auth: input.auth }) as Promise<SolanaDirectBeginResponse>;
}

export async function authorizeSolanaDirectCreate(input: {
  sessionToken: string;
  name: string;
  ticker: string;
  description?: string | null;
  category?: string | null;
  logoUrl: string;
  websiteUrl?: string | null;
  xUrl?: string | null;
  telegramUrl?: string | null;
  discordUrl?: string | null;
  otherUrl?: string | null;
  graduationTargetUsdMicros: string | number | bigint;
  graduationQuoteAsset: GraduationQuoteAsset;
}): Promise<SolanaDirectAuthorizationResponse | (SolanaDirectBeginResponse & { alreadyOnChain: true })> {
  // Do not authorize from browser-cached eligibility. Re-read the exact catalog asset
  // immediately before the server authorization request and preserve canonical identity.
  const freshQuote = await assertFreshGraduationQuote(input.graduationQuoteAsset);
  return postDirect({
    operation: "authorize",
    sessionToken: input.sessionToken,
    name: input.name,
    ticker: input.ticker,
    description: input.description || null,
    category: input.category || "meme",
    logoUrl: input.logoUrl,
    websiteUrl: input.websiteUrl || null,
    xUrl: input.xUrl || null,
    telegramUrl: input.telegramUrl || null,
    discordUrl: input.discordUrl || null,
    otherUrl: input.otherUrl || null,
    graduationTargetUsdMicros: String(input.graduationTargetUsdMicros),
    graduationQuoteAssetId: freshQuote.id,
    graduationQuoteStateVersion: Number(freshQuote.stateVersion || 0),
    graduationQuoteChainId: String(freshQuote.chainId),
    graduationQuoteProvider: String(freshQuote.provider?.key || ""),
    graduationQuoteIdentity: String(freshQuote.contractAddressOrMint || ""),
  }) as Promise<SolanaDirectAuthorizationResponse | (SolanaDirectBeginResponse & { alreadyOnChain: true })>;
}

export async function finalizeSolanaDirectCreate(input: { finalizeToken: string; deployTxHash: string }): Promise<SolanaDirectFinalizeResponse> {
  return postDirect({ operation: "finalize", finalizeToken: input.finalizeToken, deployTxHash: input.deployTxHash }) as Promise<SolanaDirectFinalizeResponse>;
}
