/**
 * Gen-8 creator-choice operator loop (MwzCreatorChoiceVault, BNB 56 + Robinhood 4663), started from evmGen8Worker.ts.
 * Off unless enabled per chain; dry run unless EVM_GEN8_CHOICE_SEND=true. The pass: evmGen8ChoicePass.ts.
 *
 *   EVM_GEN8_CHOICE_ENABLED_<chainId>=true      turns the pass on for the chain (needs the chain's gen-8 config and
 *                                               EVM_GEN8_CHOICE_VAULT_<chainId>, evmGen8Config.ts)
 *   EVM_GEN8_CHOICE_SEND=true                   real sends; otherwise decisions are only logged (week commitments and
 *                                               holder checks are data and are recorded in a dry run too)
 *   EVM_GEN8_OPERATOR_KEY_<chainId>             the vault operator key, the same key the gen-8 fee-routing worker uses
 *   (or EVM_GEN8_OPERATOR_KEY)                  (one process lock per key, evmGen8OperatorLock.ts); refused when it is
 *                                               the deployer, the Safe or EVM_CREATOR_CHOICE_FORBIDDEN_ADDRESSES; the
 *                                               pass also refuses to send unless it is vault.operator() and not paused
 *   EVM_BUYBACK_SEED_SECRET                     master secret of the weekly moments and checks (never logged)
 *   EVM_BUYBACK_MAX_PER_DAY                     buyback moments per coin per day, at most 4 (default 4)
 *   EVM_BUYBACK_MIN_WEI[_<chainId>]             smallest buyback; default 56: 0.003 BNB, 4663: 0.001 ETH
 *   EVM_HOLDER_MIN_PAYOUT_WEI[_<chainId>]       smallest weekly holder payout; default 56: 0.0013 BNB, 4663: 0.00037 ETH
 *   EVM_GEN8_PULL_MIN_WEI[_<chainId>]           smallest hook creator ledger worth a pull (default: the holder minimum)
 *   EVM_HOLDER_CLAIM_WINDOW_DAYS                claim window after the batch can execute (default 60)
 *   EVM_HOLDER_EXCLUDED_WALLETS[_<chainId>]     comma list of wallets that never count as holders (soft exclusions)
 *   EVM_GEN8_HOLDER_BATCH_MAX_WEI[_<chainId>]   cap per weekly batch while the distributor authorization is not set yet
 *                                               (when it is set, its maxAmount is the cap)
 *   EVM_GEN8_CHOICE_MAX_GAS[_<chainId>]         gas limit cap per transaction (default 3,000,000)
 *   EVM_GEN8_CHOICE_MAX_FEE_GWEI[_<chainId>]    refuse to sign above this network fee per gas (default: no cap)
 *   EVM_GEN8_CHOICE_INTERVAL_MS                 pass interval (default 60000, floor 15000)
 *   EVM_GEN8_CHOICE_MAX_SENDS_PER_TICK          passes run back to back while each one confirmed a send (default 10)
 *   EVM_GEN8_CHOICE_CENSUS_WAIT_HOURS           Monday build waits this long for a census behind the week end (6)
 */
import { ethers } from "ethers";
import { choiceConfig, truthy, assertOperatorKeyAllowed } from "./evmCreatorChoiceConfig.js";
import { holderBatchesKeyedByVault } from "./evmCreatorChoiceLanes.js";
import { configuredGen8Chains, intEnv } from "./evmGen8Config.js";
import { createEthersGen8ChoiceChain, createEthersGen8ChoiceSender } from "./evmGen8ChoiceChain.js";
import { DEFAULT_GEN8_CHOICE_CONFIG, GEN8_CHOICE_ALERT_TYPE, runGen8ChoicePass, type Gen8ChoiceConfig, type Gen8PassReport, type Queryable } from "./evmGen8ChoicePass.js";

function perChain(env: NodeJS.ProcessEnv, name: string, chainId: number): string {
  return String(env[`${name}_${chainId}`] ?? env[name] ?? "").trim();
}

function uintOr(raw: string, fallback: bigint | null): bigint | null {
  return /^\d+$/.test(raw) ? BigInt(raw) : fallback;
}

export function gen8ChoiceEnabled(chainId: number, env: NodeJS.ProcessEnv = process.env): boolean {
  return truthy(env[`EVM_GEN8_CHOICE_ENABLED_${chainId}`]);
}

/** The pass configuration of one chain from env (gen-6/7 names where the meaning is the same). */
export function gen8ChoiceConfig(chainId: number, env: NodeJS.ProcessEnv = process.env): Gen8ChoiceConfig {
  const base = choiceConfig(chainId, env);
  const gwei = perChain(env, "EVM_GEN8_CHOICE_MAX_FEE_GWEI", chainId);
  return {
    ...DEFAULT_GEN8_CHOICE_CONFIG,
    masterSecret: base.masterSecret,
    perDay: Math.min(4, base.perDay),
    buybackMinWei: base.minSpendWei,
    minPayoutWei: base.minPayoutWei,
    pullMinWei: uintOr(perChain(env, "EVM_GEN8_PULL_MIN_WEI", chainId), base.minPayoutWei)!,
    claimWindowDays: base.claimWindowDays,
    holderBatchMaxWei: uintOr(perChain(env, "EVM_GEN8_HOLDER_BATCH_MAX_WEI", chainId), null),
    excluded: base.excluded,
    maxGas: uintOr(perChain(env, "EVM_GEN8_CHOICE_MAX_GAS", chainId), DEFAULT_GEN8_CHOICE_CONFIG.maxGas)!,
    maxFeePerGasWei: /^\d+(\.\d+)?$/.test(gwei) ? ethers.parseUnits(gwei, "gwei") : null,
    censusWaitHours: intEnv(env.EVM_GEN8_CHOICE_CENSUS_WAIT_HOURS, DEFAULT_GEN8_CHOICE_CONFIG.censusWaitHours, 0, 72),
  };
}

export function gen8OperatorWallet(chainId: number, env: NodeJS.ProcessEnv = process.env): ethers.Wallet | null {
  const raw = String(env[`EVM_GEN8_OPERATOR_KEY_${chainId}`] || env.EVM_GEN8_OPERATOR_KEY || "").trim();
  if (!raw) return null;
  const wallet = new ethers.Wallet(raw.startsWith("0x") ? raw : `0x${raw}`);
  assertOperatorKeyAllowed(wallet.address, env);
  return wallet;
}

/** One tick: passes back to back while each one confirmed a transaction (Monday pulls, then the proposal). */
export async function runGen8ChoiceTick(input: {
  db: Queryable;
  run: (keyedByVault: boolean) => Promise<Gen8PassReport>;
  maxSends: number;
  log?: (r: Gen8PassReport) => void;
}): Promise<Gen8PassReport[]> {
  const keyedByVault = await holderBatchesKeyedByVault(input.db).catch(() => false);
  const out: Gen8PassReport[] = [];
  for (let i = 0; i < Math.max(1, input.maxSends); i += 1) {
    const r = await input.run(keyedByVault);
    out.push(r);
    input.log?.(r);
    if (!r.sent?.confirmed) break;
  }
  return out;
}

let started = false;

export function startEvmGen8ChoiceWorker(opts: { db: Queryable; providerFor: (chainId: number) => ethers.JsonRpcProvider | null; env?: NodeJS.ProcessEnv }) {
  if (started) return;
  started = true;
  const env = opts.env || process.env;
  const chains = configuredGen8Chains(env).filter((c) => gen8ChoiceEnabled(c.chainId, env));
  if (!chains.length) {
    console.log("[gen8-choice] off (set EVM_GEN8_CHOICE_ENABLED_<chainId>=true)");
    return;
  }
  const send = truthy(env.EVM_GEN8_CHOICE_SEND);
  const intervalMs = intEnv(env.EVM_GEN8_CHOICE_INTERVAL_MS, 60_000, 15_000);
  const maxSends = intEnv(env.EVM_GEN8_CHOICE_MAX_SENDS_PER_TICK, 10, 1, 100);
  void (async () => {
    const watchdog = await import("./payoutWatchdogWorker.js");
    const alert = (a: any) => watchdog.raiseAlert(opts.db as any, { ...a, rewardType: GEN8_CHOICE_ALERT_TYPE });
    for (const cfg of chains) {
      const chainId = cfg.chainId;
      const provider = opts.providerFor(chainId);
      const passCfg = gen8ChoiceConfig(chainId, env);
      let wallet: ethers.Wallet | null = null;
      try {
        wallet = gen8OperatorWallet(chainId, env);
      } catch (error) {
        console.error("[gen8-choice] operator key refused", { chainId, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      if (!provider || !cfg.choiceVault || !passCfg.masterSecret || !wallet) {
        console.warn("[gen8-choice] chain skipped (needs its RPC, EVM_GEN8_CHOICE_VAULT_<id>, EVM_BUYBACK_SEED_SECRET and EVM_GEN8_OPERATOR_KEY_<id>)", { chainId });
        continue;
      }
      const chain = createEthersGen8ChoiceChain(provider, cfg.choiceVault, wallet.address);
      const sender = createEthersGen8ChoiceSender(provider, wallet, chainId, cfg.choiceVault, passCfg.maxFeePerGasWei);
      console.log("[gen8-choice] on", { chainId, vault: cfg.choiceVault, operator: wallet.address, send, intervalMs });
      let running = false;
      const tick = async () => {
        if (running) return;
        running = true;
        try {
          await runGen8ChoiceTick({
            db: opts.db,
            maxSends,
            run: (keyedByVault) => runGen8ChoicePass({ db: opts.db, chainId, chain, sender, cfg: passCfg, send, alert, keyedByVault }),
            log: (r) => {
              const acted = r.steps.filter((s) => s.decision !== "skip");
              if (acted.length) console.log("[gen8-choice] pass", JSON.stringify({ chainId, send: r.send, operatorOk: r.operatorOk, steps: acted, sent: r.sent }));
            },
          });
        } catch (error) {
          console.error("[gen8-choice] pass failed", { chainId, error: error instanceof Error ? error.message : String(error) });
        } finally {
          running = false;
        }
      };
      const first = setTimeout(() => void tick(), 30_000);
      first.unref?.();
      const timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    }
  })().catch((error) => console.error("[gen8-choice] start failed", error));
}
