/**
 * Continuous holder census for gen-8 coins (design 4.2 / 6.5). Gen-8 coins are transferable from block one and have no
 * curve contract, so the Transfer replay into token_holder_balances / token_holder_sync (the tables tokenHolders.ts
 * keeps for the on-demand census) runs every pass for every gen-8 coin, many coins per getLogs. Each batch applies its
 * balance deltas and moves the coins' sync cursors in ONE database transaction, so a crash never applies a range twice.
 *
 * Holder count = positive balances minus the exclusion list (PoolManager, hook, 0xdEaD, launcher, reserve lock, escrow,
 * choice vault, PancakeSwap Infinity Vault, and every side-pool contract the watcher found: V2 pairs, V3 and Topaz
 * pools; the coin itself and 0x0 never count), written to evm_gen8_pools.holder_count and, once graduated, to
 * market_stats.holders (campaigns-base.js already prefers market_stats.holders over the buyer count).
 */
import { ethers } from "ethers";
import { intEnv, type Gen8ChainConfig } from "./evmGen8Config.js";
import type { Queryable } from "./evmGen8Store.js";
import { INFINITY_VAULT } from "./evmGen8SidePools.js";

const TRANSFER_IFACE = new ethers.Interface(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
export const TRANSFER_TOPIC = TRANSFER_IFACE.getEvent("Transfer")!.topicHash;
export const DEAD = "0x000000000000000000000000000000000000dead";
const ZERO = ethers.ZeroAddress.toLowerCase();

export function gen8HolderExclusions(cfg: Gen8ChainConfig): Array<{ wallet: string; reason: string }> {
  const out: Array<{ wallet: string; reason: string }> = [
    { wallet: cfg.poolManager, reason: "pool_manager" },
    { wallet: cfg.hook.address, reason: "hook" },
    { wallet: DEAD, reason: "dead" },
    { wallet: cfg.launcher.address, reason: "launcher" },
  ];
  if (cfg.reserveLock) out.push({ wallet: cfg.reserveLock, reason: "reserve_lock" });
  if (cfg.escrow) out.push({ wallet: cfg.escrow, reason: "escrow" });
  if (cfg.choiceVault) out.push({ wallet: cfg.choiceVault, reason: "choice_vault" });
  // PancakeSwap Infinity Vault: holds the coins of every Infinity pool (step-2 fork suite finding).
  if (INFINITY_VAULT[cfg.chainId]) out.push({ wallet: INFINITY_VAULT[cfg.chainId]!, reason: "pancake_infinity_vault" });
  return out.map((x) => ({ wallet: x.wallet.toLowerCase(), reason: x.reason }));
}

/** Net balance change per (token, wallet) from Transfer logs (pure). */
export function transferDeltas(logs: Array<{ address: string; topics: readonly string[]; data: string }>): Map<string, Map<string, bigint>> {
  const out = new Map<string, Map<string, bigint>>();
  const add = (token: string, wallet: string, d: bigint) => {
    if (wallet === ZERO || d === 0n) return;
    const m = out.get(token) || new Map<string, bigint>();
    m.set(wallet, (m.get(wallet) ?? 0n) + d);
    out.set(token, m);
  };
  for (const log of logs) {
    if (String(log.topics[0]).toLowerCase() !== TRANSFER_TOPIC) continue;
    const parsed = TRANSFER_IFACE.parseLog({ topics: [...log.topics], data: log.data });
    if (!parsed) continue;
    const token = String(log.address).toLowerCase();
    const value = BigInt(parsed.args.value);
    add(token, String(parsed.args.from).toLowerCase(), -value);
    add(token, String(parsed.args.to).toLowerCase(), value);
  }
  return out;
}

type Tx = { query: Queryable["query"]; release?: () => void };
type DbWithConnect = Queryable & { connect?: () => Promise<Tx> };

export type HolderProvider = {
  getBlockNumber(): Promise<number>;
  getLogs(filter: { address: string[]; topics: string[]; fromBlock: number; toBlock: number }): Promise<Array<{ address: string; topics: readonly string[]; data: string; blockNumber: number }>>;
};

async function inTx<T>(db: DbWithConnect, fn: (q: Queryable) => Promise<T>): Promise<T> {
  if (!db.connect) {
    await db.query("begin");
    try {
      const r = await fn(db);
      await db.query("commit");
      return r;
    } catch (e) {
      await db.query("rollback").catch(() => undefined);
      throw e;
    }
  }
  const client = await db.connect();
  try {
    await client.query("begin");
    const r = await fn(client);
    await client.query("commit");
    return r;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release?.();
  }
}

export async function runGen8HolderCensusOnce(opts: { db: DbWithConnect; cfg: Gen8ChainConfig; provider: HolderProvider; env?: NodeJS.ProcessEnv }): Promise<{ tokens: number; applied: number; to: number | null }> {
  const { db, cfg, provider } = opts;
  const env = opts.env || process.env;
  for (const x of gen8HolderExclusions(cfg)) {
    await db.query(
      `insert into public.evm_gen8_holder_exclusions(chain_id, wallet, reason) values ($1,$2,$3)
       on conflict (chain_id, wallet) do update set reason = excluded.reason, updated_at = now()`,
      [cfg.chainId, x.wallet, x.reason],
    );
  }
  // Side-pool contracts found by the watcher (it also inserts them as it finds them; this is the backstop).
  await db.query(
    `insert into public.evm_gen8_holder_exclusions(chain_id, wallet, reason)
     select chain_id, pool_key, 'side_pool_' || venue from public.evm_gen8_side_pools
      where chain_id = $1 and venue in ('v2', 'v3', 'v3_pancake', 'solidly')
     on conflict (chain_id, wallet) do nothing`,
    [cfg.chainId],
  );
  const tokensRes = await db.query(
    `select p.token_address, p.launch_block, s.last_block
       from public.evm_gen8_pools p
       left join public.token_holder_sync s on s.chain_id = p.chain_id and s.token_address = p.token_address
      where p.chain_id = $1 and p.hook_address = $2`,
    [cfg.chainId, cfg.hook.address],
  );
  if (!tokensRes.rows.length) return { tokens: 0, applied: 0, to: null };
  const confirmations = intEnv(env.EVM_GEN8_CONFIRMATIONS, 1, 0, 64);
  const head = (await provider.getBlockNumber()) - confirmations;
  const span = intEnv(env.EVM_GEN8_HOLDER_CHUNK, 2_000, 1, 50_000);
  const perCall = intEnv(env.EVM_GEN8_HOLDER_ADDRESSES_PER_CALL, 100, 1, 1_000);
  // next block per token: one past its cursor, or its launch block (the mint to the launcher is in the launch tx).
  const next = new Map<string, number>();
  for (const r of tokensRes.rows) {
    const last = r.last_block != null ? Number(r.last_block) : null;
    next.set(String(r.token_address), last != null && last >= Number(r.launch_block) ? last + 1 : Number(r.launch_block));
  }
  const from = Math.min(...next.values());
  if (from > head) return { tokens: next.size, applied: 0, to: null };
  const to = Math.min(head, from + span - 1);
  const due = [...next.entries()].filter(([, n]) => n <= to).map(([t]) => t);
  let applied = 0;
  for (let i = 0; i < due.length; i += perCall) {
    const batch = due.slice(i, i + perCall);
    const batchFrom = Math.min(...batch.map((t) => next.get(t)!));
    const logs = await provider.getLogs({ address: batch, topics: [TRANSFER_TOPIC], fromBlock: batchFrom, toBlock: to });
    // Each token only from its own next block (a token whose cursor is ahead skips the older logs).
    const fresh = logs.filter((l) => {
      const n = next.get(String(l.address).toLowerCase());
      return n !== undefined && Number(l.blockNumber) >= n;
    });
    const deltas = transferDeltas(fresh);
    await inTx(db, async (q) => {
      for (const [token, wallets] of deltas) {
        for (const [wallet, d] of wallets) {
          await q.query(
            `insert into public.token_holder_balances(chain_id, token_address, wallet, balance_raw) values ($1,$2,$3,$4)
             on conflict (chain_id, token_address, wallet) do update set balance_raw = public.token_holder_balances.balance_raw + excluded.balance_raw, updated_at = now()`,
            [cfg.chainId, token, wallet, d.toString()],
          );
        }
      }
      for (const token of batch) {
        await q.query(
          `insert into public.token_holder_sync(chain_id, token_address, campaign_address, last_block, saw_mint) values ($1,$2,$2,$3,true)
           on conflict (chain_id, token_address) do update set campaign_address = excluded.campaign_address,
             last_block = greatest(public.token_holder_sync.last_block, excluded.last_block), saw_mint = true, updated_at = now()`,
          [cfg.chainId, token, to],
        );
      }
    });
    applied += fresh.length;
  }
  await db.query(
    `update public.evm_gen8_pools p
        set holder_count = (
              select count(*)::int from public.token_holder_balances b
               where b.chain_id = p.chain_id and b.token_address = p.token_address and b.balance_raw > 0
                 and b.wallet <> p.token_address
                 and not exists (select 1 from public.evm_gen8_holder_exclusions x where x.chain_id = b.chain_id and x.wallet = b.wallet)),
            holders_updated_at = now()
      where p.chain_id = $1 and p.hook_address = $2`,
    [cfg.chainId, cfg.hook.address],
  );
  await db.query(
    `update public.market_stats m set holders = p.holder_count, updated_at = now()
       from public.evm_gen8_pools p
      where p.chain_id = $1 and p.hook_address = $2 and p.graduated_block is not null
        and m.chain_id = p.chain_id and m.campaign_address = p.token_address and p.holder_count is not null`,
    [cfg.chainId, cfg.hook.address],
  );
  return { tokens: next.size, applied, to };
}
