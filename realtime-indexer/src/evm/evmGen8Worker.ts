/**
 * Starts every gen-8 loop (ingest, holder census, side-pool watcher, fee routing). Nothing starts, and no RPC or DB
 * call is made, unless EVM_GEN8_LAUNCHER_<id> and EVM_GEN8_HOOK_<id> are set for at least one chain.
 *   EVM_GEN8_RPC_<id>             optional RPC for gen-8 (default: the chain's indexer RPC, BSC_RPC_HTTP_<id> / ROBINHOOD_RPC_HTTP_<id>)
 *   EVM_GEN8_POLL_MS              ingest interval (4000)          EVM_GEN8_CONFIRMATIONS  blocks behind head (1)
 *   EVM_GEN8_HOLDERS_POLL_MS      holder census interval (15000)  EVM_GEN8_SIDE_POLL_MS   side-pool watcher interval (60000)
 *   EVM_GEN8_SIDE_POOLS=0         turns the side-pool watcher off
 *   EVM_GEN8_FEE_ROUTING_ENABLED / _SEND / EVM_GEN8_OPERATOR_KEY_<id>: evmGen8FeeRouting.ts
 */
import { ethers } from "ethers";
import { pool } from "../db.js";
import { bscRpcUrls } from "../canonicalCandleMaterializer.js";
import { createStaticJsonRpcProvider, parseRpcList } from "../rpcProvider.js";
import { configuredGen8Chains, intEnv } from "./evmGen8Config.js";
import { startEvmGen8Indexer } from "./evmGen8Pool.js";
import { startEvmGen8FeeRoutingWorker } from "./evmGen8FeeRouting.js";
import { runGen8HolderCensusOnce } from "./evmGen8Holders.js";
import { GEN8_SIDE_ALERT_TYPE, runGen8SidePoolWatcherOnce } from "./evmGen8SidePools.js";

const providers = new Map<number, ethers.JsonRpcProvider>();

export function gen8Provider(chainId: number, env: NodeJS.ProcessEnv = process.env): ethers.JsonRpcProvider | null {
  const hit = providers.get(chainId);
  if (hit) return hit;
  const own = parseRpcList(String(env[`EVM_GEN8_RPC_${chainId}`] || ""));
  const url = own[0] || bscRpcUrls(chainId)[0];
  if (!url) return null;
  const p = createStaticJsonRpcProvider(url, chainId, { timeoutMs: 15_000 });
  providers.set(chainId, p);
  return p;
}

function loop(label: string, ms: number, fn: () => Promise<unknown>) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (error) {
      console.error(`[gen8] ${label} failed`, error instanceof Error ? error.message : String(error));
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), 5_000);
  first.unref?.();
  const t = setInterval(() => void tick(), ms);
  t.unref?.();
}

export function startEvmGen8Workers(env: NodeJS.ProcessEnv = process.env) {
  const chains = configuredGen8Chains(env);
  if (!chains.length) {
    console.log("[gen8] off (set EVM_GEN8_LAUNCHER_<chainId> and EVM_GEN8_HOOK_<chainId>)");
    return;
  }
  startEvmGen8Indexer({ db: pool, providerFor: (id) => gen8Provider(id, env), env });
  startEvmGen8FeeRoutingWorker({ db: pool, providerFor: (id) => gen8Provider(id, env), env });
  void (async () => {
    const { ensureTokenHolderSchema } = await import("../tokenHolders.js");
    await ensureTokenHolderSchema();
    const watchdog = await import("./payoutWatchdogWorker.js");
    for (const cfg of chains) {
      const provider = gen8Provider(cfg.chainId, env);
      if (!provider) continue;
      loop(`holders ${cfg.chainId}`, intEnv(env.EVM_GEN8_HOLDERS_POLL_MS, 15_000, 2_000), () => runGen8HolderCensusOnce({ db: pool as any, cfg, provider: provider as any, env }));
      if (String(env.EVM_GEN8_SIDE_POOLS ?? "1").trim() !== "0") {
        loop(`side pools ${cfg.chainId}`, intEnv(env.EVM_GEN8_SIDE_POLL_MS, 60_000, 5_000), () =>
          runGen8SidePoolWatcherOnce({ db: pool, cfg, provider: provider as any, env, alert: (a) => watchdog.raiseAlert(pool as any, { ...a, rewardType: GEN8_SIDE_ALERT_TYPE }) }),
        );
      }
    }
  })().catch((error) => console.error("[gen8] holder / side-pool start failed", error));
}
