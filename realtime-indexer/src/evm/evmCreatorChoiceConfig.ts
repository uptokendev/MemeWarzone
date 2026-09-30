/** Pure configuration of the EVM creator-choice operator (env names: see evmCreatorChoiceWorker.ts). */
import { ethers } from "ethers";
import { FORBIDDEN_KEEPER_ADDRESSES } from "./evmGraduationKeeper.js";
import { DEFAULT_CHOICE_CONFIG, type BuybackAuthClient, type ChoiceConfig } from "./evmCreatorChoicePass.js";

export function truthy(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

/** The Safe that owns every launch-generation contract on 56 and 4663 (deploy-evm-treasury-router-v4.ts PINS). */
export const SAFE_ADDRESSES = ["0x1edcedf5e5d9c2fad5f9f6b964077dd74020a7a7"];

export function assertOperatorKeyAllowed(address: string, env: NodeJS.ProcessEnv = process.env): void {
  const extra = String(env.EVM_CREATOR_CHOICE_FORBIDDEN_ADDRESSES || "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
  const forbidden = new Set([...FORBIDDEN_KEEPER_ADDRESSES, ...SAFE_ADDRESSES, ...extra]);
  if (forbidden.has(address.toLowerCase())) {
    throw new Error(`EVM creator-choice operator refuses key ${address}: it is a deployer, the Safe or a forbidden address`);
  }
}

function perChain(env: NodeJS.ProcessEnv, name: string, chainId: number): string {
  return String(env[`${name}_${chainId}`] ?? env[name] ?? "").trim();
}

export function enabledChoiceChains(env: NodeJS.ProcessEnv = process.env): number[] {
  return [56, 4663, 97, 46630].filter((id) => truthy(env[`EVM_CREATOR_CHOICE_ENABLED_${id}`]));
}

export function operatorWallet(chainId: number, env: NodeJS.ProcessEnv = process.env): ethers.Wallet | null {
  const raw = perChain(env, "EVM_CREATOR_CHOICE_OPERATOR_PRIVATE_KEY", chainId);
  if (!raw) return null;
  const wallet = new ethers.Wallet(raw.startsWith("0x") ? raw : `0x${raw}`);
  assertOperatorKeyAllowed(wallet.address, env);
  return wallet;
}

export function vaultAddress(chainId: number, env: NodeJS.ProcessEnv = process.env): string | null {
  const first = String(env[`EVM_CREATOR_VAULT_V2_${chainId}`] || "").split(",")[0]?.trim() || "";
  const address = first.split("@")[0]?.trim() || "";
  return ethers.isAddress(address) ? ethers.getAddress(address) : null;
}

const DEFAULT_MIN_SPEND: Record<number, bigint> = { 56: 3_000_000_000_000_000n, 97: 3_000_000_000_000_000n, 4663: 1_000_000_000_000_000n, 46630: 1_000_000_000_000_000n };
const DEFAULT_MIN_PAYOUT: Record<number, bigint> = { 56: 1_300_000_000_000_000n, 97: 1_300_000_000_000_000n, 4663: 370_000_000_000_000n, 46630: 370_000_000_000_000n };

function uintEnv(raw: string, fallback: bigint): bigint {
  return /^\d+$/.test(raw) ? BigInt(raw) : fallback;
}

export function choiceConfig(chainId: number, env: NodeJS.ProcessEnv = process.env): ChoiceConfig {
  const masterSecret = String(env.EVM_BUYBACK_SEED_SECRET || "").trim();
  const excluded = new Set(
    perChain(env, "EVM_HOLDER_EXCLUDED_WALLETS", chainId)
      .split(",")
      .map((w) => w.trim().toLowerCase())
      .filter((w) => /^0x[a-f0-9]{40}$/.test(w)),
  );
  const maxBatch = perChain(env, "EVM_HOLDER_BATCH_MAX_WEI", chainId);
  return {
    ...DEFAULT_CHOICE_CONFIG,
    masterSecret,
    perDay: Math.max(1, Math.min(24, Number(env.EVM_BUYBACK_MAX_PER_DAY || 4) || 4)),
    minSpendWei: uintEnv(perChain(env, "EVM_BUYBACK_MIN_WEI", chainId), DEFAULT_MIN_SPEND[chainId] ?? 10n ** 15n),
    minPayoutWei: uintEnv(perChain(env, "EVM_HOLDER_MIN_PAYOUT_WEI", chainId), DEFAULT_MIN_PAYOUT[chainId] ?? 10n ** 15n),
    claimWindowDays: Math.max(7, Math.min(365, Number(env.EVM_HOLDER_CLAIM_WINDOW_DAYS || 60) || 60)),
    holderBatchMaxWei: /^\d+$/.test(maxBatch) ? BigInt(maxBatch) : null,
    excluded,
    maxGas: uintEnv(perChain(env, "EVM_CREATOR_CHOICE_MAX_GAS", chainId), DEFAULT_CHOICE_CONFIG.maxGas),
  };
}

/** HTTP client for the API's internal buyback authorization endpoint. */
export function createHttpBuybackAuthClient(baseUrl: string, secret: string, fetchImpl: typeof fetch = fetch): BuybackAuthClient {
  const base = baseUrl.replace(/\/+$/, "");
  const url = base.endsWith("/api") ? `${base}/internal/evm/creator-choice/buyback-authorization` : `${base}/api/internal/evm/creator-choice/buyback-authorization`;
  return async (req) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mwz-internal-secret": secret },
      body: JSON.stringify({ chainId: req.chainId, campaign: req.campaign, vault: req.vault, amountIn: req.amountIn.toString(), minOut: req.minOut.toString() }),
    });
    const body: any = await response.json().catch(() => ({}));
    if (!response.ok || !body?.signature) throw new Error(`buyback authorization refused (${response.status}): ${body?.code || body?.error || "no signature"}`);
    return { signature: String(body.signature), deadline: BigInt(String(body.deadline)) };
  };
}

