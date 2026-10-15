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
 *
 * Venue (barkswap spec section 4, B7): each gen-8 chain is on one pool venue, GEN8_CHAIN_VENUE. `v4` (Uniswap V4 +
 * MwzLaunchHook) is everything above; evmGen8Config / configuredGen8Chains serve only `v4` chains. `barkswap`
 * (Barkswap / Algebra Integral custom pools; DogeOS 6281971) has its own reader, evmGen8BarkConfig, inert until both
 *   EVM_GEN8_LAUNCHER_<id>       "0xaddr@startBlock"  MwzBarkLauncher: Launched, claims, router events, CoinFeesConverted
 *   EVM_GEN8_PLUGIN_<id>         "0xaddr@startBlock"  MwzBarkPlugin: one event per swap, Graduated
 * are set, with the same SPLITTER / CHOICE_VAULT / RESERVE_LOCK / ESCROW names. EVM_GEN8_HOOK_<id> or
 * EVM_GEN8_POOL_MANAGER_<id> on a Barkswap chain disables it. Rows keep the gen-8 identity on both venues.
 */
import { ethers } from "ethers";

export type Gen8Entry = { address: string; startBlock: number };

export type Gen8Venue = "v4" | "barkswap";

/** Pool venue per gen-8 chain. Same map as frontend/shared/evmGen8.mjs GEN8_CHAIN_VENUE (plus the local chain there). */
export const GEN8_CHAIN_VENUE: Readonly<Record<number, Gen8Venue>> = Object.freeze({ 56: "v4", 97: "v4", 4663: "v4", 46630: "v4", 6281971: "barkswap" });

/** The chain's gen-8 venue, or null for a chain without gen-8. */
export function gen8Venue(chainId: number): Gen8Venue | null {
  return Number.isInteger(chainId) && Object.hasOwn(GEN8_CHAIN_VENUE, chainId) ? GEN8_CHAIN_VENUE[chainId]! : null;
}

/** A `v4` chain's config (the original gen-8 shape). */
export type Gen8ChainConfig = {
  chainId: number;
  venue: "v4";
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

/**
 * Wrapped native the rest of the market stack already uses. dex_trades inserts must name this quote:
 * set_dex_trade_quote_identity rejects a row whose pair is not in dex_pools, and a gen-8 pair is the hook.
 * WRAPPED_NATIVE_ADDRESS_<id> (or the VITE_ form) overrides. 97 is the public BSC testnet WBNB. 6281971 is WDOGE,
 * the WNativeToken() of Barkswap's router and quoters (docs/dogeos/barkswap-facts.md).
 */
export const GEN8_WRAPPED_NATIVE: Record<number, string> = {
  56: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
  97: "0xae13d989dac2f0debff460ac112a837c89baa7cd",
  4663: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
  46630: "0x52a47a33930b8a90a2000b1ba3cb96e879569670",
  6281971: "0xf6bdb158a5ddf77f1b83bc9074f6a472c58d78ae",
};

export function gen8WrappedNative(chainId: number, env: NodeJS.ProcessEnv = process.env): string {
  const raw = String(env[`WRAPPED_NATIVE_ADDRESS_${chainId}`] || env[`VITE_WRAPPED_NATIVE_ADDRESS_${chainId}`] || "").trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(raw)) return raw.toLowerCase();
  const known = GEN8_WRAPPED_NATIVE[chainId];
  if (!known) throw new Error(`gen8: no wrapped native for chain ${chainId} (set WRAPPED_NATIVE_ADDRESS_${chainId})`);
  return known;
}

export const GEN8_EVM_CHAIN_IDS = [56, 97, 4663, 46630, 6281971] as const;

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

/** A `v4` chain's config. A Barkswap chain never gets one (its reader is evmGen8BarkConfig). */
export function evmGen8Config(chainId: number, env: NodeJS.ProcessEnv = process.env): Gen8ConfigResult {
  if (gen8Venue(chainId) === "barkswap") return { config: null, invalid: [], reason: `chain ${chainId} is on the barkswap venue (evmGen8BarkConfig)` };
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
      venue: "v4",
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

/** Every `v4` chain with a complete gen-8 config. Empty (and nothing runs) when no gen-8 env is set. */
export function configuredGen8Chains(env: NodeJS.ProcessEnv = process.env): Gen8ChainConfig[] {
  const out: Gen8ChainConfig[] = [];
  for (const chainId of GEN8_EVM_CHAIN_IDS) {
    if (gen8Venue(chainId) !== "v4") continue;
    const { config, invalid, reason } = evmGen8Config(chainId, env);
    if (config) out.push(config);
    else if (reason && reason !== "unset") console.warn(`[gen8] chain ${chainId} disabled: ${reason}`, invalid);
  }
  return out;
}

/** A `barkswap` chain's config: launcher + plugin instead of hook + PoolManager; the gen-8 periphery is the same. */
export type Gen8BarkChainConfig = {
  chainId: number;
  venue: "barkswap";
  launcher: Gen8Entry;
  plugin: Gen8Entry;
  splitter: Gen8Entry | null;
  choiceVault: string | null;
  reserveLock: string | null;
  escrow: string | null;
  startBlock: number;
};

export type Gen8BarkConfigResult = { config: Gen8BarkChainConfig | null; invalid: string[]; reason: string | null };

export function evmGen8BarkConfig(chainId: number, env: NodeJS.ProcessEnv = process.env): Gen8BarkConfigResult {
  if (gen8Venue(chainId) !== "barkswap") return { config: null, invalid: [], reason: `chain ${chainId} is not on the barkswap venue` };
  const invalid: string[] = [];
  const v = (base: string) => `${base}_${chainId}`;
  const launcher = parseEntry(v("EVM_GEN8_LAUNCHER"), env[v("EVM_GEN8_LAUNCHER")], invalid);
  const plugin = parseEntry(v("EVM_GEN8_PLUGIN"), env[v("EVM_GEN8_PLUGIN")], invalid);
  const splitter = parseEntry(v("EVM_GEN8_SPLITTER"), env[v("EVM_GEN8_SPLITTER")], invalid);
  const choiceVault = parseAddress(v("EVM_GEN8_CHOICE_VAULT"), env[v("EVM_GEN8_CHOICE_VAULT")], invalid);
  const reserveLock = parseAddress(v("EVM_GEN8_RESERVE_LOCK"), env[v("EVM_GEN8_RESERVE_LOCK")], invalid);
  const escrow = parseAddress(v("EVM_GEN8_ESCROW"), env[v("EVM_GEN8_ESCROW")], invalid);
  const v4Only = ["EVM_GEN8_HOOK", "EVM_GEN8_POOL_MANAGER"].map(v).filter((key) => String(env[key] || "").trim());
  if (v4Only.length) return { config: null, invalid, reason: `${v4Only.join(", ")}: Uniswap V4 settings on chain ${chainId}, which is on the barkswap venue` };
  if (!launcher && !plugin && !invalid.length) return { config: null, invalid, reason: "unset" };
  if (invalid.length) return { config: null, invalid, reason: "invalid gen-8 env" };
  if (!launcher || !plugin) return { config: null, invalid, reason: "launcher and plugin must both be set" };
  return {
    config: {
      chainId,
      venue: "barkswap",
      launcher,
      plugin,
      splitter,
      choiceVault,
      reserveLock,
      escrow,
      startBlock: Math.min(launcher.startBlock || plugin.startBlock, plugin.startBlock || launcher.startBlock),
    },
    invalid,
    reason: null,
  };
}

/** Every `barkswap` chain with a complete config. Empty when no Barkswap env is set. */
export function configuredGen8BarkChains(env: NodeJS.ProcessEnv = process.env): Gen8BarkChainConfig[] {
  const out: Gen8BarkChainConfig[] = [];
  for (const chainId of GEN8_EVM_CHAIN_IDS) {
    if (gen8Venue(chainId) !== "barkswap") continue;
    const { config, invalid, reason } = evmGen8BarkConfig(chainId, env);
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

/**
 * Gen-8 chain reads. The default and the floor are both 60 s, so a short env (the old 4 s / 15 s values)
 * cannot bring a faster loop back. The coin page refreshes on a new trade; these are the safety polls.
 */
export function gen8IngestPollMs(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(env.EVM_GEN8_POLL_MS, 60_000, 60_000);
}

export function gen8HolderPollMs(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(env.EVM_GEN8_HOLDERS_POLL_MS, 60_000, 60_000);
}

export function gen8SidePollMs(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(env.EVM_GEN8_SIDE_POLL_MS, 60_000, 60_000);
}

// ------------------------------------------------------------------ reorg safety (audit C-M5, F10)

export type Gen8HeadTag = "finalized" | "safe" | "latest";

/**
 * Hybrid ingestion (founder 2026-10-12). Two cursors per chain:
 *   display  curve_trades / dex_trades, candles, token_stats / market_stats, activity, Ably, the side-pool watcher.
 *            Reads up to `latest` on the rollups (Robinhood 4663, 46630; DogeOS 6281971) and `finalized` on BNB (56,
 *            97; about 1 s behind the head). A reorg at the tip (block hash mismatch) rolls the display rows above the
 *            common ancestor back and re-ingests (evmGen8Pool.ts rollbackGen8Display).
 *   money    evm_gen8_fee_accruals, reward_events, route runs, recruiter credit, the holder census. Reads only up to
 *            `safe` on Robinhood (the batch posted to Ethereum, about 10 minutes behind on 2026-10-12), `finalized` on
 *            BNB, and on DogeOS a fixed depth below `latest` (GEN8_MONEY_DEPTH: 20 blocks, founder 2026-10-15; Chikyu's
 *            max reorg is 17 blocks while `safe` lags about 1,059 and `finalized` about 1,217, 2026-10-10 foundation
 *            spec). Never past the display cursor. Money rows are written once and need no rollback.
 * EVM_GEN8_DISPLAY_HEAD_TAG(_<id>) and EVM_GEN8_MONEY_HEAD_TAG(_<id>) override (finalized | safe | latest); `latest`
 * is EVM_GEN8_CONFIRMATIONS blocks behind the head (for the money tag: meant for local chains only), except for the
 * money head of a chain in GEN8_MONEY_DEPTH, which is its depth (EVM_GEN8_MONEY_DEPTH_<id>, never below its max reorg).
 */
function headTagEnv(raw: unknown): Gen8HeadTag | null {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "finalized" || v === "safe" || v === "latest" ? v : null;
}

const isRollup = (chainId: number) => chainId === 4663 || chainId === 46630 || chainId === 6281971;

export function gen8DisplayHeadTag(chainId: number, env: NodeJS.ProcessEnv = process.env): Gen8HeadTag {
  return headTagEnv(env[`EVM_GEN8_DISPLAY_HEAD_TAG_${chainId}`]) ?? headTagEnv(env.EVM_GEN8_DISPLAY_HEAD_TAG) ?? (isRollup(chainId) ? "latest" : "finalized");
}

/** Money head = latest minus `blocks` on these chains (`maxReorg` is the floor of the env override). */
export const GEN8_MONEY_DEPTH: Readonly<Record<number, { blocks: number; maxReorg: number }>> = Object.freeze({
  6281971: { blocks: 20, maxReorg: 17 },
});

export function gen8MoneyHeadTag(chainId: number, env: NodeJS.ProcessEnv = process.env): Gen8HeadTag {
  const byDefault: Gen8HeadTag = Object.hasOwn(GEN8_MONEY_DEPTH, chainId) ? "latest" : isRollup(chainId) ? "safe" : "finalized";
  return headTagEnv(env[`EVM_GEN8_MONEY_HEAD_TAG_${chainId}`]) ?? headTagEnv(env.EVM_GEN8_MONEY_HEAD_TAG) ?? byDefault;
}

/** Blocks below `latest` for the chain's money head (EVM_GEN8_MONEY_DEPTH_<id> overrides), or null: no fixed depth. */
export function gen8MoneyDepth(chainId: number, env: NodeJS.ProcessEnv = process.env): number | null {
  const d = Object.hasOwn(GEN8_MONEY_DEPTH, chainId) ? GEN8_MONEY_DEPTH[chainId]! : null;
  return d ? intEnv(env[`EVM_GEN8_MONEY_DEPTH_${chainId}`], d.blocks, d.maxReorg, 100_000) : null;
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

/** The money head: gen8HeadBlock with the chain's money tag; at `latest` on a GEN8_MONEY_DEPTH chain, head minus its depth. */
export async function gen8MoneyHead(provider: Gen8HeadProvider, chainId: number, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const tag = gen8MoneyHeadTag(chainId, env);
  const depth = gen8MoneyDepth(chainId, env);
  if (tag === "latest" && depth !== null) return (await provider.getBlockNumber()) - depth;
  return gen8HeadBlock(provider, chainId, tag, env);
}

/** The display head: gen8HeadBlock with the chain's display tag. */
export function gen8DisplayHead(provider: Gen8HeadProvider, chainId: number, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return gen8HeadBlock(provider, chainId, gen8DisplayHeadTag(chainId, env), env);
}

// ------------------------------------------------------------------ recruiter / squad link eligibility (audit C-M4, F9)

/**
 * Routers a linked trade may come through. V4 mainnets: the UniversalRouters the app and the swap widget build for
 * (frontend/shared/evmGen8Swap.mjs GEN8_KNOWN_ROUTERS, the first entry is the app's default) and Uniswap's canonical
 * ones on the chain. DogeOS (barkswap venue): Barkswap's SwapRouter, the router the app trades through (barkswap spec
 * section 3 per-swap event fields; address in docs/dogeos/barkswap-facts.md). Other testnets and local chains: env only.
 */
export const GEN8_LINK_ROUTERS: Record<number, readonly string[]> = {
  56: ["0xdc264714f68d84cf29bc605589405e78bdbe7c9f", "0x1906c1d672b88cd1b9ac7593301ca990f94eae07", "0x8b844f885672f333bc0042cb669255f93a4c1e6b"],
  4663: ["0x8876789976decbfcbbbe364623c63652db8c0904", "0x204faca1764b154221e35c0d20abb3c525710498"],
  6281971: ["0x911e5a1630fd1768e5a1710daafabb865cb79531"],
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
export function gen8LinkPolicy(cfg: Pick<Gen8ChainConfig | Gen8BarkChainConfig, "chainId" | "launcher" | "escrow">, env: NodeJS.ProcessEnv = process.env): Gen8LinkPolicy {
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
