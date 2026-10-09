/**
 * The EVM creator-choice operator on a chain with more than one CreatorRewardsVaultV2 (gen-6 and gen-7's own vault,
 * founder decision 2026-10-08), one operator key for both. Kept apart from the worker so tests run it without the
 * process database pool.
 */
import type { OperatedVault } from "./evmCreatorChoiceConfig.js";
import { DEFAULT_HOLDER_PROGRAM } from "./evmCreatorChoice.js";
import type { Census, ChoiceChain, ChoiceSender } from "./evmCreatorChoiceChain.js";
import { runEvmCreatorChoicePass, type BuybackAuthClient, type ChoiceConfig, type PassReport, type PlatformCoin, type Queryable } from "./evmCreatorChoicePass.js";

/** One vault on the chain: its chain reader, its sender (same key, `to` = this vault) and optionally its own config. */
export type ChoiceLane = OperatedVault & { chain: ChoiceChain; sender: ChoiceSender; cfg?: ChoiceConfig };

/**
 * True when evm_holder_batches is keyed per vault (migration 20261008_000040: primary key chain_id, vault_address,
 * week_id). Before it, a second vault's weekly batch would collide with the first vault's row for the same week.
 */
export async function holderBatchesKeyedByVault(db: Queryable): Promise<boolean> {
  const { rows } = await db.query(
    `select a.attname
       from pg_index i
       join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = 'public.evm_holder_batches'::regclass and i.indisprimary`,
  );
  return rows.some((r: any) => String(r.attname) === "vault_address");
}

/**
 * One tick on one chain: every vault the operator key works for, one after the other, never in parallel. They share
 * the key's nonce, so they share the chain's single transaction in flight: a pass sees the other vault's 'sending' job
 * in resolveSendingJobs and queues its own sends (the one_in_flight index is the database's backstop). The starting
 * vault rotates each round, so a busy vault cannot starve the other. A vault other than gen-6's runs only once
 * evm_holder_batches is keyed per vault (logged, re-checked every round, gen-6 unaffected).
 */
export async function runChoiceLanes(input: {
  db: Queryable;
  chainId: number;
  lanes: ChoiceLane[];
  cfg: ChoiceConfig;
  send: boolean;
  census: Census;
  api: BuybackAuthClient | null;
  round: number;
  now?: Date;
  coinsFor?: (vault: string) => PlatformCoin[] | undefined;
}): Promise<Array<{ lane: ChoiceLane; report?: PassReport; error?: string }>> {
  const n = input.lanes.length;
  const start = n ? ((input.round % n) + n) % n : 0;
  const ordered = [...input.lanes.slice(start), ...input.lanes.slice(0, start)];
  const byVault = new Map(input.lanes.map((l) => [l.vault.toLowerCase(), l.chain]));
  const chainFor = (vault: string) => byVault.get(String(vault).toLowerCase()) ?? null;
  let keyedByVault: boolean | null = null;
  const out: Array<{ lane: ChoiceLane; report?: PassReport; error?: string }> = [];
  for (const lane of ordered) {
    try {
      if (lane.program !== DEFAULT_HOLDER_PROGRAM) {
        keyedByVault ??= await holderBatchesKeyedByVault(input.db).catch(() => false);
        if (!keyedByVault) {
          out.push({ lane, error: `evm_holder_batches is not keyed per vault yet: apply db/migrations/20261008_000040_evm_holder_batches_per_vault.sql before the ${lane.label} vault ${lane.vault} runs` });
          continue;
        }
      }
      const report = await runEvmCreatorChoicePass({
        db: input.db, chainId: input.chainId, chain: lane.chain, sender: lane.sender, cfg: lane.cfg ?? input.cfg, send: input.send,
        census: input.census, api: input.api, program: lane.program, chainFor, now: input.now, coins: input.coinsFor?.(lane.vault),
      });
      out.push({ lane, report });
    } catch (error) {
      out.push({ lane, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return out;
}

