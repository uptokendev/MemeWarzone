/**
 * Starts every gen-8 loop (ingest, holder census, side-pool watcher, fee routing). Nothing starts, and no RPC or DB
 * call is made, unless EVM_GEN8_LAUNCHER_<id> and EVM_GEN8_HOOK_<id> are set for at least one chain.
 *   EVM_GEN8_RPC_<id>             optional RPC for gen-8 (default: the chain's indexer RPC, BSC_RPC_HTTP_<id> / ROBINHOOD_RPC_HTTP_<id>)
 *   EVM_GEN8_POLL_MS              display fast poll (4000; floor 4000). One head read per tick. A higher value slows it.
 *   EVM_GEN8_IDLE_POLL_MS         after 20 ticks with no gen-8 log (15000; never faster than the fast poll)
 *   EVM_GEN8_MONEY_POLL_MS        money lane (60000; floor 60000). Safe on Robinhood, finalized on BNB. Not every tick.
 *   EVM_GEN8_DISPLAY_HEAD_TAG(_<id>)  what the UI rows follow: latest (Robinhood) / finalized (BNB); rolled back on a reorg
 *   EVM_GEN8_MONEY_HEAD_TAG(_<id>)    what the money rows wait for: safe (Robinhood) / finalized (BNB); never rolled back
 *   EVM_GEN8_CONFIRMATIONS        blocks behind head for a `latest` tag (1)
 *   EVM_GEN8_LINK_ROUTERS_<id> / EVM_GEN8_LINK_DENY(_<id>) / EVM_GEN8_LINK_MAX_SWAP_SENDERS: link eligibility (evmGen8Config.ts)
 *   EVM_GEN8_ROUTER_CLAIMERS_<id>: wallets besides the splitter operator allowed to claimRouter() without an alert
 *   EVM_GEN8_HOLDERS_POLL_MS      holder census interval (60000; floor 60000)  EVM_GEN8_SIDE_POLL_MS   side-pool watcher (60000; floor 60000)
 *   EVM_GEN8_SIDE_POOLS=0         turns the side-pool watcher off
 *   EVM_GEN8_FEE_ROUTING_ENABLED / _SEND / EVM_GEN8_OPERATOR_KEY_<id>: evmGen8FeeRouting.ts
 *   EVM_GEN8_CHOICE_ENABLED_<id> / EVM_GEN8_CHOICE_SEND and the creator-choice operator env: evmGen8ChoiceWorker.ts
 *   GEN8_PARTNER_FEES_ENABLED / _BATCH / _POLL_MS: widget partner ledger of graduated swaps, gen8PartnerFees.ts (off by default)
 */
import { ethers } from "ethers";
import { pool } from "../db.js";
import { bscRpcUrls } from "../canonicalCandleMaterializer.js";
import { createStaticJsonRpcProvider, parseRpcList } from "../rpcProvider.js";
import { configuredGen8Chains, gen8HolderPollMs, gen8SidePollMs, intEnv, truthyEnv } from "./evmGen8Config.js";
import { startEvmGen8Indexer } from "./evmGen8Pool.js";
import { startEvmGen8FeeRoutingWorker } from "./evmGen8FeeRouting.js";
import { startEvmGen8ChoiceWorker } from "./evmGen8ChoiceWorker.js";
import { runGen8HolderCensusOnce } from "./evmGen8Holders.js";
import { GEN8_SIDE_ALERT_TYPE, runGen8SidePoolWatcherOnce } from "./evmGen8SidePools.js";
import { runGen8PartnerAttributionOnce } from "./gen8PartnerFees.js";

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
  // First tick waits the same interval. There is no 5 s startup timer.
  const first = setTimeout(() => void tick(), ms);
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
  startEvmGen8ChoiceWorker({ db: pool, providerFor: (id) => gen8Provider(id, env), env });
  void (async () => {
    const { ensureTokenHolderSchema } = await import("../tokenHolders.js");
    await ensureTokenHolderSchema();
    const watchdog = await import("./payoutWatchdogWorker.js");
    for (const cfg of chains) {
      const provider = gen8Provider(cfg.chainId, env);
      if (!provider) continue;
      loop(`holders ${cfg.chainId}`, gen8HolderPollMs(env), () => runGen8HolderCensusOnce({ db: pool as any, cfg, provider: provider as any, env }));
      if (String(env.EVM_GEN8_SIDE_POOLS ?? "1").trim() !== "0") {
        loop(`side pools ${cfg.chainId}`, gen8SidePollMs(env), () =>
          runGen8SidePoolWatcherOnce({ db: pool, cfg, provider: provider as any, env, alert: (a) => watchdog.raiseAlert(pool as any, { ...a, rewardType: GEN8_SIDE_ALERT_TYPE }) }),
        );
      }
      if (truthyEnv(env.GEN8_PARTNER_FEES_ENABLED)) {
        const batch = intEnv(env.GEN8_PARTNER_FEES_BATCH, 200, 1, 1000);
        loop(`partner fees ${cfg.chainId}`, intEnv(env.GEN8_PARTNER_FEES_POLL_MS, 60_000, 60_000), async () => {
          const r = await runGen8PartnerAttributionOnce({ db: pool, chainId: cfg.chainId, hook: cfg.hook.address, provider, batch });
          // A failed read is retried quietly; a stall logs its own error (gen8PartnerFees.ts, after 10 runs, then hourly).
          if (r.inserted || (r.skipped && !r.skipped.startsWith("no active partner"))) console.log("[gen8] partner fees", JSON.stringify(r));
        });
      }
    }
  })().catch((error) => console.error("[gen8] holder / side-pool start failed", error));
}
