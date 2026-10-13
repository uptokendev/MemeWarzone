/**
 * EVM generation 8 configuration per chain (docs/evm-launch/EVM_GEN8_V4_DESIGN.md 6.3). Everything gen-8 is inert
 * until both EVM_GEN8_LAUNCHER_<chainId> and EVM_GEN8_HOOK_<chainId> are set: no loop starts, no query runs, no
 * filter in the shared code changes what it selects (gen-8 rows only exist once the gen-8 loop wrote them).
 *
 * Env, one contract per variable (same "0xaddr@startBlock" convention as EVM_GEN7_ROUTER_<chainId>):
 *   EVM_GEN8_LAUNCHER_<id>       "0xaddr@startBlock"  MwzV4Launcher: Launched, LaunchMetadata, pause / signer events
 *   EVM_GEN8_HOOK_<id>           "0xaddr@startBlock"  MwzLaunchHook: PoolLaunched, HookFee, Graduated, creator + router events
 *   EVM_GEN8_POOL_MANAGER_<id>   "0xaddr"             Uniswap V4 PoolManager (default: the canonical one on 56 / 4663)
 *   EVM_GEN8_SPLITTER_<id>       "0xaddr@startBlock"  MwzFeeSplitter: Routed; the D1 route worker's target
 *   EVM_GEN8_CHOICE_VAULT_<id>   "0xaddr"             MwzCreatorChoiceVault: owner hand-over of choice coins, holder exclusion
 *   EVM_GEN8_RESERVE_LOCK_<id>   "0xaddr"             MwzReserveLock: holder exclusion
 *   EVM_GEN8_ESCROW_<id>         "0xaddr"             MwzCreatorEscrow: holder exclusion, league exclusion (swap sender)
 * The start block of the scan is the smaller of the launcher's and the hook's (both are deployed together).
 */
import { ethers } from "ethers";

export type Gen8Entry = { address: string; startBlock: number };

export type Gen8ChainConfig = {
  chainId: number;
  launcher: Gen8Entry;
  hook: Gen8Entry;
  poolManager: string;
  splitter: Gen8Entry | null;
  choiceVault: string | null;
  reserveLock: string | null;
  escrow: string | null;
  startBlock: number;
};

export type Gen8ConfigResult = { config: Gen8ChainConfig | null; invalid: string[]; reason: string | null };

/** Canonical Uniswap V4 PoolManager per mainnet (design 2.1, verified on the forks). Testnets: env only. */
export const CANONICAL_V4_POOL_MANAGER: Record<number, string> = {
  56: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df",
  4663: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
};

export const GEN8_EVM_CHAIN_IDS = [56, 97, 4663, 46630] as const;

function parseEntry(name: string, raw: string | undefined, invalid: string[]): Gen8Entry | null {
  const text = String(raw || "").trim();
  if (!text) return null;
  const [addressPart, blockPart] = text.split("@").map((s) => String(s || "").trim());
  if (!/^0x[0-9a-fA-F]{40}$/.test(addressPart) || /^0x0{40}$/i.test(addressPart) || (blockPart && !/^\d+$/.test(blockPart))) {
    invalid.push(`${name}: ${text}`);
    return null;
  }
  return { address: ethers.getAddress(addressPart).toLowerCase(), startBlock: blockPart ? Number(blockPart) : 0 };
}

function parseAddress(name: string, raw: string | undefined, invalid: string[]): string | null {
  const entry = parseEntry(name, raw, invalid);
  return entry ? entry.address : null;
}

export function evmGen8Config(chainId: number, env: NodeJS.ProcessEnv = process.env): Gen8ConfigResult {
  const invalid: string[] = [];
  const v = (base: string) => `${base}_${chainId}`;
  const launcher = parseEntry(v("EVM_GEN8_LAUNCHER"), env[v("EVM_GEN8_LAUNCHER")], invalid);
  const hook = parseEntry(v("EVM_GEN8_HOOK"), env[v("EVM_GEN8_HOOK")], invalid);
  const pmRaw = String(env[v("EVM_GEN8_POOL_MANAGER")] || "").trim();
  const poolManager = pmRaw ? parseAddress(v("EVM_GEN8_POOL_MANAGER"), pmRaw, invalid) : CANONICAL_V4_POOL_MANAGER[chainId] ?? null;
  const splitter = parseEntry(v("EVM_GEN8_SPLITTER"), env[v("EVM_GEN8_SPLITTER")], invalid);
  const choiceVault = parseAddress(v("EVM_GEN8_CHOICE_VAULT"), env[v("EVM_GEN8_CHOICE_VAULT")], invalid);
  const reserveLock = parseAddress(v("EVM_GEN8_RESERVE_LOCK"), env[v("EVM_GEN8_RESERVE_LOCK")], invalid);
  const escrow = parseAddress(v("EVM_GEN8_ESCROW"), env[v("EVM_GEN8_ESCROW")], invalid);
  if (!launcher && !hook) return { config: null, invalid, reason: "unset" };
  if (!launcher || !hook) return { config: null, invalid, reason: "launcher and hook must both be set" };
  if (!poolManager) return { config: null, invalid, reason: `no PoolManager for chain ${chainId} (set ${v("EVM_GEN8_POOL_MANAGER")})` };
  if (invalid.length) return { config: null, invalid, reason: "invalid gen-8 env" };
  return {
    config: {
      chainId,
      launcher,
      hook,
      poolManager,
      splitter,
      choiceVault,
      reserveLock,
      escrow,
      startBlock: Math.min(launcher.startBlock || hook.startBlock, hook.startBlock || launcher.startBlock),
    },
    invalid,
    reason: null,
  };
}

/** Every chain with a complete gen-8 config. Empty (and nothing runs) when no gen-8 env is set. */
export function configuredGen8Chains(env: NodeJS.ProcessEnv = process.env): Gen8ChainConfig[] {
  const out: Gen8ChainConfig[] = [];
  for (const chainId of GEN8_EVM_CHAIN_IDS) {
    const { config, invalid, reason } = evmGen8Config(chainId, env);
    if (config) out.push(config);
    else if (reason && reason !== "unset") console.warn(`[gen8] chain ${chainId} disabled: ${reason}`, invalid);
  }
  return out;
}

export function truthyEnv(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

export function intEnv(value: unknown, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(String(value ?? "").trim());
  if (!String(value ?? "").trim() || !Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

// ------------------------------------------------------------------ reorg safety (audit C-M5, F10)

export type Gen8HeadTag = "finalized" | "safe" | "latest";

/**
 * Hybrid ingestion (founder 2026-10-12). Two cursors per chain:
 *   display  curve_trades / dex_trades, candles, token_stats / market_stats, activity, Ably, the side-pool watcher.
 *            Reads up to `latest` on Robinhood (4663, 46630) and `finalized` on BNB (56, 97; about 1 s behind the
 *            head). A reorg at the tip (block hash mismatch) rolls the display rows above the common ancestor back
 *            and re-ingests (evmGen8Pool.ts rollbackGen8Display).
 *   money    evm_gen8_fee_accruals, reward_events, route runs, recruiter credit, the holder census. Reads only up to
 *            `safe` on Robinhood (the batch posted to Ethereum, about 10 minutes behind on 2026-10-12) and `finalized`
 *            on BNB, and never past the display cursor. Money rows are written once and need no rollback.
 * EVM_GEN8_DISPLAY_HEAD_TAG(_<id>) and EVM_GEN8_MONEY_HEAD_TAG(_<id>) override (finalized | safe | latest); `latest`
 * is EVM_GEN8_CONFIRMATIONS blocks behind the head and, for the money tag, meant for local chains only.
 */
function headTagEnv(raw: unknown): Gen8HeadTag | null {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "finalized" || v === "safe" || v === "latest" ? v : null;
}

const isRobinhood = (chainId: number) => chainId === 4663 || chainId === 46630;

export function gen8DisplayHeadTag(chainId: number, env: NodeJS.ProcessEnv = process.env): Gen8HeadTag {
  return headTagEnv(env[`EVM_GEN8_DISPLAY_HEAD_TAG_${chainId}`]) ?? headTagEnv(env.EVM_GEN8_DISPLAY_HEAD_TAG) ?? (isRobinhood(chainId) ? "latest" : "finalized");
}

export function gen8MoneyHeadTag(chainId: number, env: NodeJS.ProcessEnv = process.env): Gen8HeadTag {
  return headTagEnv(env[`EVM_GEN8_MONEY_HEAD_TAG_${chainId}`]) ?? headTagEnv(env.EVM_GEN8_MONEY_HEAD_TAG) ?? (isRobinhood(chainId) ? "safe" : "finalized");
}

export type Gen8HeadProvider = {
  getBlockNumber(): Promise<number>;
  getBlock(tag: any): Promise<{ number?: number | bigint | null } | null>;
};

/**
 * The highest block a gen-8 loop may read for `tag`. Fails closed: when the RPC cannot answer the tag, the pass
 * throws (logged, retried next tick) instead of falling back to the unsafe head.
 */
export async function gen8HeadBlock(provider: Gen8HeadProvider, chainId: number, tag: Gen8HeadTag, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (tag === "latest") return (await provider.getBlockNumber()) - intEnv(env.EVM_GEN8_CONFIRMATIONS, 1, 0, 64);
  const b = await provider.getBlock(tag);
  const n = b?.number;
  if (n === null || n === undefined || !Number.isFinite(Number(n))) throw new Error(`gen8: the RPC for chain ${chainId} did not return the '${tag}' block`);
  return Number(n);
}

/** The money head: gen8HeadBlock with the chain's money tag. */
export function gen8MoneyHead(provider: Gen8HeadProvider, chainId: number, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return gen8HeadBlock(provider, chainId, gen8MoneyHeadTag(chainId, env), env);
}

/** The display head: gen8HeadBlock with the chain's display tag. */
export function gen8DisplayHead(provider: Gen8HeadProvider, chainId: number, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return gen8HeadBlock(provider, chainId, gen8DisplayHeadTag(chainId, env), env);
}

// ------------------------------------------------------------------ recruiter / squad link eligibility (audit C-M4, F9)

/**
 * UniversalRouters a linked trade may come through, per mainnet: the routers the app and the swap widget build for
 * (frontend/shared/evmGen8Swap.mjs GEN8_KNOWN_ROUTERS, the first entry is the app's default) and Uniswap's canonical
 * ones on the chain. Testnets and local chains: env only.
 */
export const GEN8_LINK_ROUTERS: Record<number, readonly string[]> = {
  56: ["0xdc264714f68d84cf29bc605589405e78bdbe7c9f", "0x1906c1d672b88cd1b9ac7593301ca990f94eae07", "0x8b844f885672f333bc0042cb669255f93a4c1e6b"],
  4663: ["0x8876789976decbfcbbbe364623c63652db8c0904", "0x204faca1764b154221e35c0d20abb3c525710498"],
};

function addressList(raw: unknown): string[] {
  return String(raw ?? "")
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s))
    .map((s) => s.toLowerCase());
}

export type Gen8LinkPolicy = { routers: Set<string>; deny: Set<string>; maxSwapSenders: number };

/**
 * Who can carry a recruiter / squad link (finding C-M4: a relayer or 4337 bundler sends many users' trades from one
 * wallet). A trade is linked only when
 *   - its swap sender (PoolManager Swap.sender = HookFee.swapSender) is an allowed router: GEN8_LINK_ROUTERS, the
 *     chain's EVM_GEN8_UNIVERSAL_ROUTER_<id> (the router the API builds for), our launcher (creator first buy) and
 *     escrow, plus EVM_GEN8_LINK_ROUTERS_<id>;
 *   - tx.to is that same router (the signer called the router itself: no forwarder, multicall, EntryPoint or 7702
 *     self-call in between, so tx.from is the trader and not a relayer);
 *   - tx.from is not on EVM_GEN8_LINK_DENY_<id> / EVM_GEN8_LINK_DENY (known bundler and relayer wallets);
 *   - tx.from has not traded through EVM_GEN8_LINK_MAX_SWAP_SENDERS (4) or more different swap senders (a wallet
 *     that submits through many contracts is a relayer, not a person).
 * Otherwise the trade is UNLINKED (airdrop share), as a wallet without a link.
 */
export function gen8LinkPolicy(cfg: Gen8ChainConfig, env: NodeJS.ProcessEnv = process.env): Gen8LinkPolicy {
  const routers = new Set<string>([
    ...(GEN8_LINK_ROUTERS[cfg.chainId] ?? []),
    ...addressList(env[`EVM_GEN8_UNIVERSAL_ROUTER_${cfg.chainId}`]),
    ...addressList(env[`EVM_GEN8_LINK_ROUTERS_${cfg.chainId}`]),
    cfg.launcher.address,
    ...(cfg.escrow ? [cfg.escrow] : []),
  ]);
  const deny = new Set<string>([...addressList(env.EVM_GEN8_LINK_DENY), ...addressList(env[`EVM_GEN8_LINK_DENY_${cfg.chainId}`])]);
  return { routers, deny, maxSwapSenders: intEnv(env.EVM_GEN8_LINK_MAX_SWAP_SENDERS, 4, 2, 1_000) };
}

export type Gen8LinkCheck = { linkable: boolean; reason: string | null };

/** The pure part of the rule above (the many-senders count is passed in). */
export function gen8LinkCheck(policy: Gen8LinkPolicy, t: { txFrom: string; txTo: string | null; swapSender: string; distinctSwapSenders: number }): Gen8LinkCheck {
  const from = t.txFrom.toLowerCase();
  const sender = t.swapSender.toLowerCase();
  if (!policy.routers.has(sender)) return { linkable: false, reason: "swap_sender_not_allowed" };
  if (!t.txTo || t.txTo.toLowerCase() !== sender) return { linkable: false, reason: "tx_to_is_not_the_router" };
  if (policy.deny.has(from)) return { linkable: false, reason: "tx_from_denylisted" };
  if (t.distinctSwapSenders >= policy.maxSwapSenders) return { linkable: false, reason: "tx_from_uses_many_swap_senders" };
  return { linkable: true, reason: null };
}

// ------------------------------------------------------------------ league exclusion (audit D-L2, F12)

/**
 * League exclusion of a gen-8 trade (audit 10.2, D-L2 / F12): the trade counts for no trader League when tx.from OR
 * the swap sender is the coin's current creator or its hook creator (the human creator for keep coins, our choice
 * vault for choice coins), or when the swap came through the escrow, the launcher (the creator's first buy) or the
 * choice vault (buybacks). Matching the swap sender as well catches a creator trading from a contract wallet.
 */
export function gen8LeagueExcluded(cfg: Pick<Gen8ChainConfig, "launcher" | "escrow" | "choiceVault">, pool: { creator: string; hookCreator: string | null }, txFrom: string, swapSender: string): boolean {
  const from = txFrom.toLowerCase();
  const sender = swapSender.toLowerCase();
  const creatorSide = new Set([pool.creator, pool.hookCreator].filter((a): a is string => Boolean(a)).map((a) => a.toLowerCase()));
  if (creatorSide.has(from) || creatorSide.has(sender)) return true;
  if (cfg.escrow && sender === cfg.escrow) return true;
  if (sender === cfg.launcher.address) return true;
  if (cfg.choiceVault && (sender === cfg.choiceVault || from === cfg.choiceVault)) return true;
  return false;
}
