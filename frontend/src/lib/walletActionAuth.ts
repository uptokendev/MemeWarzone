/**
 * Client-side wallet action auth matching frontend/api/lib/walletActionAuth.js
 * Message brand: "MemeWarzone API Action"
 */
import type { JsonRpcSigner } from "ethers";
import { apiFetch } from "@/lib/apiBase";
import { isSolanaAddress } from "@/lib/address";
import { isSolanaChainId } from "@/lib/chainConfig";

export type WalletApiAction =
  | "claim_intent"
  | "claim_record"
  | "follow_user"
  | "unfollow_user"
  | "follow_campaign"
  | "unfollow_campaign"
  | "upload_avatar"
  | "upload_logo"
  | "campaign_upsert"
  | "arena_open_battle"
  | "arena_war_pool_support";

export type WalletActionAuthPayload = {
  action: WalletApiAction | string;
  walletAddress: string;
  chainId: number;
  nonce: string;
  message: string;
  signature: string;
  walletType?: "evm" | "solana";
};

function normalizeWallet(value: string, chainId: number) {
  const raw = String(value || "").trim();
  if (isSolanaChainId(chainId) || isSolanaAddress(raw)) return raw;
  return raw.toLowerCase();
}

export function buildWalletActionMessage(input: {
  action: string;
  walletAddress: string;
  chainId: number;
  nonce: string;
  extraLines?: string[];
}) {
  const lines = [
    "MemeWarzone API Action",
    `Action: ${input.action}`,
    `Wallet: ${normalizeWallet(input.walletAddress, input.chainId)}`,
    `Chain ID: ${Number(input.chainId)}`,
  ];
  for (const line of input.extraLines || []) {
    if (line) lines.push(String(line));
  }
  lines.push(`Nonce: ${String(input.nonce || "")}`);
  return lines.join("\n");
}

async function fetchNonce(chainId: number, walletAddress: string): Promise<string> {
  const qs = new URLSearchParams({
    chainId: String(chainId),
    address: normalizeWallet(walletAddress, chainId),
  });
  const res = await apiFetch(`/api/auth/nonce?${qs.toString()}`, { cache: "no-store" });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.nonce) {
    throw new Error(String(json?.error || json?.message || "Could not create wallet auth nonce."));
  }
  return String(json.nonce);
}

type SignInput = {
  action: WalletApiAction | string;
  walletAddress: string;
  chainId: number;
  extraLines?: string[] | Promise<string[]>;
  /** EVM: ethers signer.signMessage. Solana: base64 signature producer. */
  signer?: JsonRpcSigner | null;
  signMessage?: (message: string) => Promise<string>;
  walletType?: "evm" | "solana";
};

/**
 * Build a signed wallet action auth payload for API user writes.
 * Prefer passing `signMessage` for Solana; EVM can use `signer.signMessage`.
 *
 * Important: all features use this same signer path. Project import must not
 * introduce a provider-specific signing implementation of its own.
 */
export async function signWalletAction(input: SignInput): Promise<WalletActionAuthPayload> {
  const chainId = Number(input.chainId);
  const walletAddress = normalizeWallet(input.walletAddress, chainId);
  if (!walletAddress) throw new Error("Wallet address required for signed API action.");
  if (!Number.isFinite(chainId)) throw new Error("Chain id required for signed API action.");

  const isSolana =
    input.walletType === "solana" || isSolanaChainId(chainId) || isSolanaAddress(walletAddress);

  const extraLinesPromise = Promise.resolve(input.extraLines || []);
  const [nonce, extraLines] = await Promise.all([fetchNonce(chainId, walletAddress), extraLinesPromise]);
  const message = buildWalletActionMessage({
    action: input.action,
    walletAddress,
    chainId,
    nonce,
    extraLines,
  });

  let signature = "";
  if (input.signMessage) {
    signature = String(await input.signMessage(message));
  } else if (input.signer && typeof input.signer.signMessage === "function") {
    signature = String(await input.signer.signMessage(message));
  } else {
    throw new Error("Wallet signer unavailable. Reconnect and try again.");
  }

  return {
    action: input.action,
    walletAddress,
    chainId,
    nonce,
    message,
    signature,
    walletType: isSolana ? "solana" : "evm",
  };
}

/** Append signed auth fields to an upload query string (multipart-safe). */
export function appendAuthToSearchParams(qs: URLSearchParams, auth: WalletActionAuthPayload) {
  qs.set("action", auth.action);
  qs.set("walletAddress", auth.walletAddress);
  qs.set("address", auth.walletAddress);
  qs.set("chainId", String(auth.chainId));
  qs.set("nonce", auth.nonce);
  qs.set("message", auth.message);
  qs.set("signature", auth.signature);
  if (auth.walletType) qs.set("walletType", auth.walletType);
  return qs;
}
