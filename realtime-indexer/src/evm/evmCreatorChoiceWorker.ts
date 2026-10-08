/**
 * EVM creator-choice operator loop (launch generation, CreatorRewardsVaultV2). Off unless enabled per chain; dry
 * run unless EVM_CREATOR_CHOICE_SEND=true. The pass itself: evmCreatorChoicePass.ts.
 *
 *   EVM_CREATOR_CHOICE_ENABLED_<chainId>=true          56, 4663 (97, 46630 for testnets)
 *   EVM_CREATOR_CHOICE_SEND=true                       real sends; otherwise decisions are only logged
 *   EVM_CREATOR_CHOICE_OPERATOR_PRIVATE_KEY[_<chainId>] the vault operator key (never the deployer, the Safe or the
 *                                                      route authority: refused)
 *   EVM_CREATOR_VAULT_V2_<chainId>                     the vault, "0xaddr@startBlock" (same variable the indexer uses)
 *   EVM_GEN7_CREATOR_VAULT_<chainId>                   gen-7's own vault, "0xaddr@startBlock" (evmGen7Fees.ts); operated by
 *                                                      the same key, holder program "airdrop_holders_gen7"
 *   EVM_BUYBACK_SEED_SECRET                            master secret of the weekly moments (never logged)
 *   EVM_CREATOR_CHOICE_API_URL                         API base, for the buybackCurve route authority signature
 *   EVM_CREATOR_CHOICE_API_SECRET                      shared secret header for that internal endpoint
 *   EVM_CREATOR_CHOICE_INTERVAL_MS                     default 30000
 *   EVM_BUYBACK_MAX_PER_DAY                            default 4 moments per coin per day
 *   EVM_BUYBACK_MIN_WEI[_<chainId>]                    smallest buyback; default 56: 0.003 BNB, 4663: 0.001 ETH
 *   EVM_HOLDER_MIN_PAYOUT_WEI[_<chainId>]              smallest weekly holder payout; default 56: 0.0013 BNB, 4663: 0.00037 ETH
 *   EVM_HOLDER_CLAIM_WINDOW_DAYS                       default 60
 *   EVM_HOLDER_BATCH_MAX_WEI[_<chainId>]               optional ceiling per weekly batch (match EVMGEN_HOLDER_BATCH_AUTH_MAX)
 *   EVM_GEN7_HOLDER_BATCH_MAX_WEI[_<chainId>]          the same for gen-7's own vault (default: the line above)
 *   EVM_HOLDER_EXCLUDED_WALLETS[_<chainId>]            comma list of wallets that never count as holders
 *   EVM_CREATOR_CHOICE_MAX_GAS[_<chainId>]             default 3,000,000
 *   EVM_CREATOR_CHOICE_FORBIDDEN_ADDRESSES             extra refused operator addresses
 */
import { ethers } from "ethers";
import { pool } from "../db.js";
import { ENV } from "../env.js";
import { createStaticJsonRpcProvider } from "../rpcProvider.js";
import { catchUpTokenHolders } from "../tokenHolders.js";
import { keeperRpc } from "./evmGraduationKeeperWorker.js";
import { createEthersChoiceChain, createEthersChoiceSender, type Census } from "./evmCreatorChoiceChain.js";
import { choiceConfig, createHttpBuybackAuthClient, enabledChoiceChains, operatedVaults, operatorWallet, truthy, vaultChoiceConfig } from "./evmCreatorChoiceConfig.js";
import { runChoiceLanes, type ChoiceLane } from "./evmCreatorChoiceLanes.js";

export { assertOperatorKeyAllowed, choiceConfig, createHttpBuybackAuthClient, enabledChoiceChains, operatedVaults, operatorWallet, vaultAddress } from "./evmCreatorChoiceConfig.js";
export { holderBatchesKeyedByVault, runChoiceLanes, type ChoiceLane } from "./evmCreatorChoiceLanes.js";

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
    const vaults = operatedVaults(chainId);
    const url = keeperRpc(chainId);
    let wallet: ethers.Wallet | null = null;
    try {
      wallet = operatorWallet(chainId);
    } catch (error) {
      console.error("[evm-choice] operator key refused", { chainId, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (!cfg.masterSecret || !vaults.length || !url || !wallet) {
      console.warn("[evm-choice] chain skipped (needs EVM_BUYBACK_SEED_SECRET, EVM_CREATOR_VAULT_V2_<id> and/or EVM_GEN7_CREATOR_VAULT_<id>, its RPC and EVM_CREATOR_CHOICE_OPERATOR_PRIVATE_KEY)", { chainId });
      continue;
    }
    if (send && !api) console.warn("[evm-choice] no EVM_CREATOR_CHOICE_API_URL / _SECRET: curve buybacks are skipped", { chainId });
    const provider = createStaticJsonRpcProvider(url, chainId, { timeoutMs: ENV.RPC_REQUEST_TIMEOUT_MS });
    const lanes: ChoiceLane[] = vaults.map((v) => ({
      ...v,
      chain: createEthersChoiceChain(provider, v.vault, wallet!.address),
      sender: createEthersChoiceSender(provider, wallet!, chainId, v.vault),
      cfg: vaultChoiceConfig(cfg, chainId, v),
    }));
    const census = createDbCensus(provider as ethers.JsonRpcProvider, chainId);
    let running = false;
    let round = 0;
    console.log("[evm-choice] enabled", { chainId, send, vaults: vaults.map((v) => `${v.label} ${v.vault}`), operator: wallet.address, intervalMs });

    const tick = async () => {
      if (running) return;
      running = true;
      try {
        const reports = await runChoiceLanes({ db: pool, chainId, lanes, cfg, send, census, api, round: round++ });
        for (const { lane, report, error } of reports) {
          if (error) {
            console.error("[evm-choice] pass failed", { chainId, vault: lane.vault, label: lane.label, error });
            continue;
          }
          const acted = report!.steps.filter((s) => s.decision !== "skip");
          if (acted.length) console.log("[evm-choice] pass", JSON.stringify({ chainId, vault: lane.vault, label: lane.label, send: report!.send, operatorOk: report!.operatorOk, steps: acted }));
        }
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
