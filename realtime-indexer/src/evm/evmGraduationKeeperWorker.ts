/**
 * EVM graduation keeper loop (launch generation, campaign 5). Off unless enabled per chain; dry-run
 * unless EVM_GRADUATION_KEEPER_SEND=true.
 *
 *   EVM_GRADUATION_KEEPER_ENABLED_<chainId>=true    56, 4663 (97, 46630 for testnets)
 *   EVM_GRADUATION_KEEPER_SEND=true                 real sends; otherwise decisions are only logged
 *   EVM_GRADUATION_KEEPER_PRIVATE_KEY[_<chainId>]   keeper key (never a deployer: refused at start)
 *   EVM_GRADUATION_KEEPER_INTERVAL_MS               default 10000
 *   EVM_GRADUATION_KEEPER_MAX_GAS[_<chainId>]       default 56: 15,000,000; 4663: 30,000,000 (Nitro cap 32M)
 *   EVM_GRADUATION_KEEPER_MIN_FLUSH_WEI             default 1
 *   EVM_GRADUATION_KEEPER_REPAIR_HALVINGS           default 8
 *   EVM_GRADUATION_KEEPER_DUE_SLACK_BPS             default 200 (due-but-not-pending pre-filter slack)
 *   EVM_GRADUATION_KEEPER_MAX_DUE_CANDIDATES        default 25 per pass (0 turns the due filter off)
 *   EVM_GRADUATION_KEEPER_TARGET_TTL_MS             default 60000 (cached graduationNativeTarget())
 *   EVM_KEEPER_V3_FACTORY_<id> / EVM_KEEPER_WETH_<id> / EVM_KEEPER_V3_FEE_<id>  partial-repair price read
 *   EVM_KEEPER_FORBIDDEN_ADDRESSES                  extra refused keeper addresses
 *   EVM_KEEPER_V3_OBSERVATION_SLOTS[_<chainId>]     default 180 on 4663 / 46630 (0 = off): grow a graduated V3
 *                                                   pool's observationCardinalityNext once, for TWAP reads
 */
import type { ethers } from "ethers";
import { pool } from "../db.js";
import { ENV } from "../env.js";
import { createStaticJsonRpcProvider, parseRpcList } from "../rpcProvider.js";
import {
  createEthersKeeperReader,
  createEthersKeeperSender,
  runEvmGraduationKeeperPass,
} from "./evmGraduationKeeper.js";
import { enabledKeeperChains, keeperConfig, keeperWallet, truthy } from "./evmGraduationKeeperConfig.js";

export function keeperRpc(chainId: number): string {
  const raw =
    chainId === 56 ? ENV.BSC_RPC_HTTP_56
    : chainId === 97 ? ENV.BSC_RPC_HTTP_97
    : chainId === 4663 ? ENV.ROBINHOOD_RPC_HTTP_4663
    : chainId === 46630 ? ENV.ROBINHOOD_RPC_HTTP_46630
    : "";
  return parseRpcList(raw)[0] || "";
}

let started = false;

export function startEvmGraduationKeeperWorker() {
  if (started) return;
  started = true;
  const chains = enabledKeeperChains();
  if (chains.length === 0) {
    console.log("[evm-grad] disabled (set EVM_GRADUATION_KEEPER_ENABLED_<chainId>=true)");
    return;
  }
  const send = truthy(process.env.EVM_GRADUATION_KEEPER_SEND);
  const intervalMs = Math.max(3_000, Number(process.env.EVM_GRADUATION_KEEPER_INTERVAL_MS || 10_000));

  for (const chainId of chains) {
    const url = keeperRpc(chainId);
    let wallet: ethers.Wallet | null = null;
    try {
      wallet = keeperWallet(chainId);
    } catch (error) {
      console.error("[evm-grad] keeper key refused", { chainId, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (!url || !wallet) {
      console.warn("[evm-grad] chain skipped (needs its RPC and EVM_GRADUATION_KEEPER_PRIVATE_KEY)", { chainId });
      continue;
    }
    const provider = createStaticJsonRpcProvider(url, chainId, { timeoutMs: ENV.RPC_REQUEST_TIMEOUT_MS });
    const reader = createEthersKeeperReader(provider, chainId, wallet.address);
    const sender = createEthersKeeperSender(provider, wallet, chainId);
    const cfg = keeperConfig(chainId);
    let running = false;
    console.log("[evm-grad] enabled", { chainId, send, keeper: wallet.address, maxGas: cfg.maxGas.toString(), intervalMs });

    const tick = async () => {
      if (running) return;
      running = true;
      try {
        const result = await runEvmGraduationKeeperPass({ db: pool, chainId, reader, sender, cfg, send });
        const acted = result.steps.filter((s) => s.decision.kind !== "idle");
        if (acted.length || result.resolved.confirmed || result.resolved.reverted || result.resolved.dropped) {
          console.log("[evm-grad] pass", {
            chainId,
            send,
            resolved: result.resolved,
            steps: acted.map((s) => ({
              campaign: s.campaign,
              kind: s.decision.kind,
              action: s.decision.kind === "send" ? s.decision.call.action : undefined,
              args: s.decision.kind === "send" ? s.decision.call.args.map(String) : undefined,
              reason: s.decision.reason,
              txHash: s.txHash,
              error: s.error,
            })),
          });
        }
      } catch (error) {
        console.error("[evm-grad] pass failed", { chainId, error: error instanceof Error ? error.message : String(error) });
      } finally {
        running = false;
      }
    };
    const first = setTimeout(() => void tick(), 10_000);
    first.unref?.();
    const timer = setInterval(() => void tick(), intervalMs);
    timer.unref?.();
  }
}
