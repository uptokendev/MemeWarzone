/**
 * EVM creator-choice operator loop (launch generation, CreatorRewardsVaultV2). Off unless enabled per chain; dry
 * run unless EVM_CREATOR_CHOICE_SEND=true. The pass itself: evmCreatorChoicePass.ts.
 *
 *   EVM_CREATOR_CHOICE_ENABLED_<chainId>=true          56, 4663 (97, 46630 for testnets)
 *   EVM_CREATOR_CHOICE_SEND=true                       real sends; otherwise decisions are only logged
 *   EVM_CREATOR_CHOICE_OPERATOR_PRIVATE_KEY[_<chainId>] the vault operator key (never the deployer, the Safe or the
 *                                                      route authority: refused)
 *   EVM_CREATOR_VAULT_V2_<chainId>                     the vault, "0xaddr@startBlock" (same variable the indexer uses)
 *   EVM_BUYBACK_SEED_SECRET                            master secret of the weekly moments (never logged)
 *   EVM_CREATOR_CHOICE_API_URL                         API base, for the buybackCurve route authority signature
 *   EVM_CREATOR_CHOICE_API_SECRET                      shared secret header for that internal endpoint
 *   EVM_CREATOR_CHOICE_INTERVAL_MS                     default 30000
 *   EVM_BUYBACK_MAX_PER_DAY                            default 4 moments per coin per day
 *   EVM_BUYBACK_MIN_WEI[_<chainId>]                    smallest buyback; default 56: 0.003 BNB, 4663: 0.001 ETH
 *   EVM_HOLDER_MIN_PAYOUT_WEI[_<chainId>]              smallest weekly holder payout; default 56: 0.0013 BNB, 4663: 0.00037 ETH
 *   EVM_HOLDER_CLAIM_WINDOW_DAYS                       default 60
 *   EVM_HOLDER_BATCH_MAX_WEI[_<chainId>]               optional ceiling per weekly batch (match EVMGEN_HOLDER_BATCH_AUTH_MAX)
 *   EVM_HOLDER_EXCLUDED_WALLETS[_<chainId>]            comma list of wallets that never count as holders
 *   EVM_CREATOR_CHOICE_MAX_GAS[_<chainId>]             default 3,000,000
 *   EVM_CREATOR_CHOICE_FORBIDDEN_ADDRESSES             extra refused operator addresses
 */
import { ethers } from "ethers";
import { pool } from "../db.js";
import { ENV } from "../env.js";
import { createStaticJsonRpcProvider } from "../rpcProvider.js";
import { catchUpTokenHolders } from "../tokenHolders.js";
import { FORBIDDEN_KEEPER_ADDRESSES } from "./evmGraduationKeeper.js";
import { keeperRpc } from "./evmGraduationKeeperWorker.js";
import { createEthersChoiceChain, createEthersChoiceSender, type Census } from "./evmCreatorChoiceChain.js";
import { DEFAULT_CHOICE_CONFIG, runEvmCreatorChoicePass, type BuybackAuthClient, type ChoiceConfig } from "./evmCreatorChoicePass.js";

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

/**
 * The indexer's holder census (token_holder_balances, replayed from Transfer logs by tokenHolders.ts), brought up
 * to the snapshot block first. Balances are those at the census block, which is the snapshot block or later.
 */
export function createDbCensus(provider: ethers.JsonRpcProvider, chainId: number): Census {
  return async ({ campaign, token, createdBlock, atBlock }) => {
    const deadline = Date.now() + 90_000;
    for (let i = 0; i < 50; i += 1) {
      const r = await catchUpTokenHolders(provider, { chainId, campaign, token, createdBlock, target: atBlock, deadlineMs: deadline, maxBlocks: 20_000 });
      if (r.lastBlock >= atBlock) break;
      if (Date.now() >= deadline) throw new Error(`holder census for ${token} is behind (block ${r.lastBlock} of ${atBlock}); retried next pass`);
    }
    const { rows } = await pool.query(
      `select wallet, balance_raw::text as balance from public.token_holder_balances where chain_id = $1 and token_address = $2 and balance_raw > 0`,
      [chainId, token.toLowerCase()],
    );
    return rows.map((r: any) => ({ wallet: String(r.wallet), amount: BigInt(String(r.balance)) }));
  };
}

let started = false;

export function startEvmCreatorChoiceWorker() {
  if (started) return;
  started = true;
  const chains = enabledChoiceChains();
  if (!chains.length) {
    console.log("[evm-choice] disabled (set EVM_CREATOR_CHOICE_ENABLED_<chainId>=true)");
    return;
  }
  const send = truthy(process.env.EVM_CREATOR_CHOICE_SEND);
  const intervalMs = Math.max(10_000, Number(process.env.EVM_CREATOR_CHOICE_INTERVAL_MS || 30_000));
  const apiUrl = String(process.env.EVM_CREATOR_CHOICE_API_URL || "").trim();
  const apiSecret = String(process.env.EVM_CREATOR_CHOICE_API_SECRET || "").trim();
  const api = apiUrl && apiSecret ? createHttpBuybackAuthClient(apiUrl, apiSecret) : null;

  for (const chainId of chains) {
    const cfg = choiceConfig(chainId);
    const vault = vaultAddress(chainId);
    const url = keeperRpc(chainId);
    let wallet: ethers.Wallet | null = null;
    try {
      wallet = operatorWallet(chainId);
    } catch (error) {
      console.error("[evm-choice] operator key refused", { chainId, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (!cfg.masterSecret || !vault || !url || !wallet) {
      console.warn("[evm-choice] chain skipped (needs EVM_BUYBACK_SEED_SECRET, EVM_CREATOR_VAULT_V2_<id>, its RPC and EVM_CREATOR_CHOICE_OPERATOR_PRIVATE_KEY)", { chainId });
      continue;
    }
    if (send && !api) console.warn("[evm-choice] no EVM_CREATOR_CHOICE_API_URL / _SECRET: curve buybacks are skipped", { chainId });
    const provider = createStaticJsonRpcProvider(url, chainId, { timeoutMs: ENV.RPC_REQUEST_TIMEOUT_MS });
    const chain = createEthersChoiceChain(provider, vault, wallet.address);
    const sender = createEthersChoiceSender(provider, wallet, chainId, vault);
    const census = createDbCensus(provider as ethers.JsonRpcProvider, chainId);
    let running = false;
    console.log("[evm-choice] enabled", { chainId, send, vault, operator: wallet.address, intervalMs });

    const tick = async () => {
      if (running) return;
      running = true;
      try {
        const report = await runEvmCreatorChoicePass({ db: pool, chainId, chain, sender, cfg, send, census, api });
        const acted = report.steps.filter((s) => s.decision !== "skip");
        if (acted.length) console.log("[evm-choice] pass", JSON.stringify({ chainId, send: report.send, operatorOk: report.operatorOk, steps: acted }));
      } catch (error) {
        console.error("[evm-choice] pass failed", { chainId, error: error instanceof Error ? error.message : String(error) });
      } finally {
        running = false;
      }
    };
    const first = setTimeout(() => void tick(), 20_000);
    first.unref?.();
    const timer = setInterval(() => void tick(), intervalMs);
    timer.unref?.();
  }
}
