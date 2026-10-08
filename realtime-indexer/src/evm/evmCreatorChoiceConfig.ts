/** Pure configuration of the EVM creator-choice operator (env names: see evmCreatorChoiceWorker.ts). */
import { ethers } from "ethers";
import { FORBIDDEN_KEEPER_ADDRESSES } from "./evmGraduationKeeper.js";
import { DEFAULT_CHOICE_CONFIG, type BuybackAuthClient, type ChoiceConfig } from "./evmCreatorChoicePass.js";
import { DEFAULT_HOLDER_PROGRAM } from "./evmCreatorChoice.js";
import { EVM_GEN7_HOLDER_PROGRAM, evmGen7FeesStack } from "./evmGen7Fees.js";

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

export type OperatedVault = { vault: string; program: string; label: "gen-6" | "gen-7" };

/**
 * Every CreatorRewardsVaultV2 the operator key works for on a chain: the gen-6 vault (EVM_CREATOR_VAULT_V2_<id>, first
 * entry, program "airdrop_holders") and gen-7's own vault (EVM_GEN7_CREATOR_VAULT_<id>, program
 * "airdrop_holders_gen7"). The same address twice is operated once, as gen-6.
 */
export function operatedVaults(chainId: number, env: NodeJS.ProcessEnv = process.env): OperatedVault[] {
  const out: OperatedVault[] = [];
  const gen6 = vaultAddress(chainId, env);
  if (gen6) out.push({ vault: gen6, program: DEFAULT_HOLDER_PROGRAM, label: "gen-6" });
  const gen7 = evmGen7FeesStack(chainId, env).creatorVault;
  if (gen7 && !out.some((v) => v.vault.toLowerCase() === gen7.address.toLowerCase())) {
    out.push({ vault: gen7.address, program: EVM_GEN7_HOLDER_PROGRAM, label: "gen-7" });
  }
  return out;
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

/**
 * The configuration of one vault on the chain. Gen-6 keeps the chain's values. Gen-7's own vault has its own Safe
 * authorization max on its own holder distributor, so EVM_GEN7_HOLDER_BATCH_MAX_WEI[_<id>] caps its weekly batch
 * (falling back to EVM_HOLDER_BATCH_MAX_WEI[_<id>] when unset, the deploy default of equal caps).
 */
export function vaultChoiceConfig(base: ChoiceConfig, chainId: number, vault: OperatedVault, env: NodeJS.ProcessEnv = process.env): ChoiceConfig {
  if (vault.program === DEFAULT_HOLDER_PROGRAM) return base;
  const raw = perChain(env, "EVM_GEN7_HOLDER_BATCH_MAX_WEI", chainId);
  return /^\d+$/.test(raw) ? { ...base, holderBatchMaxWei: BigInt(raw) } : base;
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

