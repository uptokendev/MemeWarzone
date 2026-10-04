/**
 * ProtocolRevenueForwarder keeper (contracts/ProtocolRevenueForwarder.sol, PR #507).
 *
 * The LP lockers route the protocol 20% of LP fees as WBNB (56) / WETH (4663) into the forwarder; it reaches the
 * ProtocolRevenueVault (operator fill, overflow to the Safe) only when someone calls the permissionless `flush()`.
 * This loop calls it. Off by default; dry unless PROTOCOL_FORWARDER_KEEPER=send.
 *
 *   PROTOCOL_FORWARDER_KEEPER                 off | dry | send   (default off; anything else is off)
 *   PROTOCOL_FORWARDER_ADDRESS_56             forwarder on BNB; unset = chain skipped
 *   PROTOCOL_FORWARDER_ADDRESS_4663           forwarder on Robinhood; unset = chain skipped
 *   PROTOCOL_FORWARDER_KEEPER_PK              dedicated gas-only key, read in send mode only. There is NO fallback
 *                                             to DEPLOYER_PK, HARVEST_OPS_PRIVATE_KEY or any other key; a missing
 *                                             key, the EVM deployer 0x77F96A7d… or any EVM_KEEPER_FORBIDDEN_ADDRESSES
 *                                             entry refuses to start.
 *   PROTOCOL_FORWARDER_KEEPER_INTERVAL_MS     default 3600000 (hourly), min 60000
 *   PROTOCOL_FORWARDER_MIN_FLUSH_USD          default 1 (USD, priced with the vault's own nativeUsdPrice())
 *   PROTOCOL_FORWARDER_MIN_FLUSH_WEI_<id>     used when the vault price is 0; default 56: 0.002 BNB, 4663: 0.0005 ETH
 *   PROTOCOL_FORWARDER_MAX_GAS_COST_BPS       default 500: skip unless gas cost <= 5% of the value flushed
 *   PROTOCOL_FORWARDER_TICK_TIMEOUT_MS        default 60000: a tick never runs longer (bounded, own timer)
 *
 * Fail closed: before any action the configured forwarder must report nativeSink() == the chain's known
 * ProtocolRevenueVault, admin() == the Safe and wrappedNative() == the chain's WBNB / WETH. A mismatch refuses that
 * chain until restart. RPC errors are logged into the chain's status and retried next tick; they never touch the
 * trade loop (separate timer, own provider, every await bounded by the tick timeout).
 */
import { ethers } from "ethers";
import { FORBIDDEN_KEEPER_ADDRESSES, assertKeeperKeyAllowed } from "./evm/evmGraduationKeeper.js";

export const EVM_DEPLOYER = "0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714";
export const SAFE = "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7";

/** Read on chain 2026-10-04 (router.protocolRevenueVault(), vault.admin()). */
export const FORWARDER_CHAIN_PINS: Record<number, { vault: string; wrappedNative: string; native: string; defaultMinFlushWei: bigint }> = {
  56: { vault: "0xc2d4E6f846446f3921a34A34e007295dbc19Bc4c", wrappedNative: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", native: "BNB", defaultMinFlushWei: 2_000_000_000_000_000n },
  4663: { vault: "0x632061cA786f7B585Bbd46A792FDA92B02f70671", wrappedNative: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", native: "ETH", defaultMinFlushWei: 500_000_000_000_000n },
};

const WAD = 10n ** 18n;
const BPS = 10_000n;

export type KeeperMode = "off" | "dry" | "send";

export type ForwarderKeeperConfig = {
  mode: KeeperMode;
  chains: Array<{ chainId: number; forwarder: string }>;
  intervalMs: number;
  tickTimeoutMs: number;
  minFlushUsdWad: bigint;
  minFlushWei: Record<number, bigint>;
  maxGasCostBps: bigint;
};

function parseUsdWad(raw: string, fallback: bigint): bigint {
  const s = String(raw || "").trim();
  if (!s) return fallback;
  if (!/^\d+(\.\d+)?$/.test(s)) return fallback;
  try {
    return ethers.parseUnits(s, 18);
  } catch {
    return fallback;
  }
}

function parseBig(raw: unknown, fallback: bigint): bigint {
  const s = String(raw ?? "").trim();
  return /^\d+$/.test(s) ? BigInt(s) : fallback;
}

export function forwarderKeeperConfig(env: NodeJS.ProcessEnv = process.env): ForwarderKeeperConfig {
  const rawMode = String(env.PROTOCOL_FORWARDER_KEEPER || "off").trim().toLowerCase();
  const mode: KeeperMode = rawMode === "dry" || rawMode === "send" ? rawMode : "off";
  const chains: Array<{ chainId: number; forwarder: string }> = [];
  for (const chainId of Object.keys(FORWARDER_CHAIN_PINS).map(Number)) {
    const raw = String(env[`PROTOCOL_FORWARDER_ADDRESS_${chainId}`] || "").trim();
    if (!raw) continue;
    if (!ethers.isAddress(raw)) throw new Error(`PROTOCOL_FORWARDER_ADDRESS_${chainId} is not an address`);
    chains.push({ chainId, forwarder: ethers.getAddress(raw) });
  }
  const minFlushWei: Record<number, bigint> = {};
  for (const [id, pin] of Object.entries(FORWARDER_CHAIN_PINS)) minFlushWei[Number(id)] = parseBig(env[`PROTOCOL_FORWARDER_MIN_FLUSH_WEI_${id}`], pin.defaultMinFlushWei);
  const interval = Number(env.PROTOCOL_FORWARDER_KEEPER_INTERVAL_MS || 3_600_000);
  const tickTimeout = Number(env.PROTOCOL_FORWARDER_TICK_TIMEOUT_MS || 60_000);
  const gasBps = parseBig(env.PROTOCOL_FORWARDER_MAX_GAS_COST_BPS, 500n);
  return {
    mode,
    chains,
    intervalMs: Number.isFinite(interval) ? Math.max(60_000, interval) : 3_600_000,
    tickTimeoutMs: Number.isFinite(tickTimeout) ? Math.max(5_000, Math.min(600_000, tickTimeout)) : 60_000,
    minFlushUsdWad: parseUsdWad(String(env.PROTOCOL_FORWARDER_MIN_FLUSH_USD ?? ""), WAD),
    minFlushWei,
    maxGasCostBps: gasBps > BPS ? BPS : gasBps,
  };
}

/**
 * The keeper's signer. Only `send` needs one and it comes from PROTOCOL_FORWARDER_KEEPER_PK alone. Refuses a
 * missing key, the EVM deployer and every other forbidden keeper address.
 */
export function forwarderKeeperWallet(mode: KeeperMode, env: NodeJS.ProcessEnv = process.env): ethers.Wallet | null {
  if (mode !== "send") return null;
  const raw = String(env.PROTOCOL_FORWARDER_KEEPER_PK || "").trim();
  if (!raw) throw new Error("PROTOCOL_FORWARDER_KEEPER=send needs PROTOCOL_FORWARDER_KEEPER_PK (no fallback to any other key)");
  const wallet = new ethers.Wallet(raw.startsWith("0x") ? raw : `0x${raw}`);
  if (wallet.address.toLowerCase() === EVM_DEPLOYER.toLowerCase()) throw new Error(`PROTOCOL_FORWARDER_KEEPER_PK is the EVM deployer ${EVM_DEPLOYER}; the deployer never signs recurring operations`);
  if (FORBIDDEN_KEEPER_ADDRESSES.includes(wallet.address.toLowerCase())) throw new Error(`PROTOCOL_FORWARDER_KEEPER_PK ${wallet.address} is a forbidden (deployer) address`);
  assertKeeperKeyAllowed(wallet.address, env);
  return wallet;
}

/** Chain access the keeper needs; the ethers implementation is below, tests inject their own. */
export interface ForwarderReader {
  forwarderIdentity(forwarder: string): Promise<{ admin: string; nativeSink: string; wrappedNative: string; hasCode: boolean }>;
  balances(forwarder: string, wrappedNative: string): Promise<{ wrapped: bigint; native: bigint }>;
  vaultNativeUsdPrice(vault: string): Promise<bigint>;
  /** eth_call flush() from `from`; ok=false carries the revert text. */
  simulateFlush(forwarder: string, from: string): Promise<{ ok: boolean; error?: string }>;
  estimateFlushGas(forwarder: string, from: string): Promise<bigint>;
  gasPrice(): Promise<bigint>;
  receiptStatus(hash: string): Promise<null | { status: number; blockNumber: number }>;
}

export interface ForwarderSender {
  address: string;
  sendFlush(forwarder: string, gasLimit: bigint): Promise<{ hash: string }>;
}

export type FlushDecision =
  | { kind: "skip"; reason: string; valueWei: bigint; usdWad: bigint | null }
  | { kind: "flush"; valueWei: bigint; usdWad: bigint | null };

/** Pure threshold rule: value above the USD (or wei) minimum, and gas cost a small fraction of the value. */
export function decideFlush(input: { wrapped: bigint; native: bigint; priceWad: bigint; gasCostWei: bigint | null; minFlushUsdWad: bigint; minFlushWei: bigint; maxGasCostBps: bigint }): FlushDecision {
  const valueWei = input.wrapped + input.native;
  const usdWad = input.priceWad > 0n ? (valueWei * input.priceWad) / WAD : null;
  if (valueWei === 0n) return { kind: "skip", reason: "empty", valueWei, usdWad };
  if (usdWad !== null) {
    if (usdWad < input.minFlushUsdWad) return { kind: "skip", reason: "below-min-usd", valueWei, usdWad };
  } else if (valueWei < input.minFlushWei) {
    return { kind: "skip", reason: "below-min-wei", valueWei, usdWad };
  }
  if (input.gasCostWei !== null && input.gasCostWei * BPS > valueWei * input.maxGasCostBps) return { kind: "skip", reason: "gas-too-expensive", valueWei, usdWad };
  return { kind: "flush", valueWei, usdWad };
}

export type ChainStatus = {
  chainId: number;
  forwarder: string;
  verified: boolean;
  refused: string | null;
  lastTickAt: string | null;
  lastDecision: string | null;
  balances: { wrapped: string; native: string } | null;
  lastFlush: { txHash: string; at: string; valueWei: string; status: "pending" | "confirmed" | "reverted" | "unknown" } | null;
  inFlight: string | null;
  lastError: { at: string; message: string } | null;
  flushes: number;
};

export function newChainStatus(chainId: number, forwarder: string): ChainStatus {
  return { chainId, forwarder, verified: false, refused: null, lastTickAt: null, lastDecision: null, balances: null, lastFlush: null, inFlight: null, lastError: null, flushes: 0 };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300);

/** Fail closed: the forwarder must point at the known vault, be administered by the Safe and unwrap the known token. */
export async function verifyForwarder(reader: ForwarderReader, chainId: number, forwarder: string): Promise<string | null> {
  const pin = FORWARDER_CHAIN_PINS[chainId];
  if (!pin) return `chain ${chainId} has no forwarder pins`;
  const id = await reader.forwarderIdentity(forwarder);
  if (!id.hasCode) return `no code at ${forwarder}`;
  if (!same(id.nativeSink, pin.vault)) return `nativeSink ${id.nativeSink} != ProtocolRevenueVault ${pin.vault}`;
  if (!same(id.admin, SAFE)) return `admin ${id.admin} != Safe ${SAFE}`;
  if (!same(id.wrappedNative, pin.wrappedNative)) return `wrappedNative ${id.wrappedNative} != ${pin.wrappedNative}`;
  return null;
}

/** Anyone may flush; in dry mode the simulation runs from this placeholder when no key is loaded. */
const DRY_FROM = "0x000000000000000000000000000000000000dEaD";
const PENDING_DROP_MS = 30 * 60_000;

/**
 * One tick for one chain. Never throws: every failure lands in status.lastError. At most one flush transaction
 * per chain is outstanding; the next tick polls its receipt before doing anything else.
 */
export async function runForwarderTick(ctx: {
  chainId: number;
  status: ChainStatus;
  reader: ForwarderReader;
  sender: ForwarderSender | null;
  cfg: ForwarderKeeperConfig;
  now?: () => Date;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}): Promise<ChainStatus> {
  const { chainId, status, reader, sender, cfg } = ctx;
  const now = ctx.now ?? (() => new Date());
  const log = ctx.log ?? ((m, d) => console.log(`[forwarder-keeper] ${m}`, d ?? {}));
  status.lastTickAt = now().toISOString();
  if (cfg.mode === "off") {
    status.lastDecision = "off";
    return status;
  }
  if (status.refused) {
    status.lastDecision = "refused";
    return status;
  }
  try {
    if (!status.verified) {
      const why = await verifyForwarder(reader, chainId, status.forwarder);
      if (why) {
        status.refused = why;
        status.lastDecision = "refused";
        log("forwarder refused (fail closed)", { chainId, forwarder: status.forwarder, why });
        return status;
      }
      status.verified = true;
    }

    if (status.inFlight) {
      const r = await reader.receiptStatus(status.inFlight);
      if (!r) {
        const sentAt = status.lastFlush ? Date.parse(status.lastFlush.at) : 0;
        if (now().getTime() - sentAt < PENDING_DROP_MS) {
          status.lastDecision = "in-flight";
          return status;
        }
        if (status.lastFlush) status.lastFlush.status = "unknown";
        log("in-flight flush not mined after 30 min; releasing (the next static call decides)", { chainId, txHash: status.inFlight });
      } else if (status.lastFlush) {
        status.lastFlush.status = r.status === 1 ? "confirmed" : "reverted";
      }
      status.inFlight = null;
    }

    const pin = FORWARDER_CHAIN_PINS[chainId];
    const bal = await reader.balances(status.forwarder, pin.wrappedNative);
    status.balances = { wrapped: bal.wrapped.toString(), native: bal.native.toString() };
    const priceWad = await reader.vaultNativeUsdPrice(pin.vault);
    const base = { wrapped: bal.wrapped, native: bal.native, priceWad, minFlushUsdWad: cfg.minFlushUsdWad, minFlushWei: cfg.minFlushWei[chainId] ?? pin.defaultMinFlushWei, maxGasCostBps: cfg.maxGasCostBps };
    const pre = decideFlush({ ...base, gasCostWei: null });
    if (pre.kind === "skip") {
      status.lastDecision = pre.reason;
      return status;
    }

    const from = sender?.address ?? DRY_FROM;
    const sim = await reader.simulateFlush(status.forwarder, from);
    if (!sim.ok) {
      status.lastDecision = "simulation-reverted";
      status.lastError = { at: now().toISOString(), message: `flush() static call reverted: ${sim.error ?? "unknown"}` };
      return status;
    }
    const gas = await reader.estimateFlushGas(status.forwarder, from);
    const gasPrice = await reader.gasPrice();
    const decision = decideFlush({ ...base, gasCostWei: gas * gasPrice });
    if (decision.kind === "skip") {
      status.lastDecision = decision.reason;
      return status;
    }
    if (cfg.mode !== "send" || !sender) {
      status.lastDecision = "would-flush (dry)";
      log("dry: would flush", { chainId, forwarder: status.forwarder, valueWei: decision.valueWei.toString(), usd: decision.usdWad === null ? null : ethers.formatUnits(decision.usdWad, 18), gas: gas.toString() });
      return status;
    }
    const tx = await sender.sendFlush(status.forwarder, (gas * 12n) / 10n);
    status.inFlight = tx.hash;
    status.flushes += 1;
    status.lastFlush = { txHash: tx.hash, at: now().toISOString(), valueWei: decision.valueWei.toString(), status: "pending" };
    status.lastDecision = "flush-sent";
    status.lastError = null;
    log("flush sent", { chainId, forwarder: status.forwarder, txHash: tx.hash, valueWei: decision.valueWei.toString() });
    return status;
  } catch (error) {
    status.lastError = { at: now().toISOString(), message: errText(error) };
    status.lastDecision = "error";
    log("tick failed", { chainId, error: errText(error) });
    return status;
  }
}

/** Resolves to the tick's result or rejects after `ms`, so a hung RPC never stretches a tick. */
export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const FORWARDER_IFACE = new ethers.Interface([
  "function admin() view returns (address)",
  "function nativeSink() view returns (address)",
  "function wrappedNative() view returns (address)",
  "function flush() returns (uint256 unwrapped, uint256 forwarded)",
]);
const ERC20_IFACE = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);
const VAULT_IFACE = new ethers.Interface(["function nativeUsdPrice() view returns (uint256)"]);
const FLUSH_DATA = FORWARDER_IFACE.encodeFunctionData("flush", []);

export function createEthersForwarderReader(provider: ethers.Provider): ForwarderReader {
  const read = async (to: string, iface: ethers.Interface, fn: string, args: unknown[] = []) => iface.decodeFunctionResult(fn, await provider.call({ to, data: iface.encodeFunctionData(fn, args) }))[0];
  return {
    async forwarderIdentity(forwarder) {
      const code = await provider.getCode(forwarder);
      if (code === "0x") return { admin: ethers.ZeroAddress, nativeSink: ethers.ZeroAddress, wrappedNative: ethers.ZeroAddress, hasCode: false };
      return {
        admin: String(await read(forwarder, FORWARDER_IFACE, "admin")),
        nativeSink: String(await read(forwarder, FORWARDER_IFACE, "nativeSink")),
        wrappedNative: String(await read(forwarder, FORWARDER_IFACE, "wrappedNative")),
        hasCode: true,
      };
    },
    async balances(forwarder, wrappedNative) {
      return { wrapped: BigInt(await read(wrappedNative, ERC20_IFACE, "balanceOf", [forwarder])), native: await provider.getBalance(forwarder) };
    },
    async vaultNativeUsdPrice(vault) {
      return BigInt(await read(vault, VAULT_IFACE, "nativeUsdPrice"));
    },
    async simulateFlush(forwarder, from) {
      try {
        await provider.call({ from, to: forwarder, data: FLUSH_DATA });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errText(error) };
      }
    },
    async estimateFlushGas(forwarder, from) {
      return provider.estimateGas({ from, to: forwarder, data: FLUSH_DATA });
    },
    async gasPrice() {
      const fee = await provider.getFeeData();
      return fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
    },
    async receiptStatus(hash) {
      const r = await provider.getTransactionReceipt(hash);
      return r ? { status: Number(r.status ?? 0), blockNumber: r.blockNumber } : null;
    },
  };
}

export function createEthersForwarderSender(provider: ethers.Provider, wallet: ethers.Wallet): ForwarderSender {
  const signer = wallet.connect(provider);
  return {
    address: wallet.address,
    async sendFlush(forwarder, gasLimit) {
      const tx = await signer.sendTransaction({ to: forwarder, data: FLUSH_DATA, gasLimit });
      return { hash: tx.hash };
    },
  };
}

// ---------------------------------------------------------------- loop + health

const statuses = new Map<number, ChainStatus>();
let health: { mode: KeeperMode; intervalMs: number; keeper: string | null; startError: string | null } = { mode: "off", intervalMs: 0, keeper: null, startError: null };

export function protocolForwarderKeeperHealth() {
  return { ...health, chains: Object.fromEntries([...statuses.entries()].map(([id, s]) => [String(id), s])) };
}

export type StartDeps = {
  env?: NodeJS.ProcessEnv;
  rpcUrl?: (chainId: number) => string;
  makeReader?: (chainId: number, url: string) => ForwarderReader;
  makeSender?: (chainId: number, url: string, wallet: ethers.Wallet) => ForwarderSender;
};

let started = false;

/** Starts one independent timer per configured chain. Returns false (and logs why) when it does not start. */
export async function startProtocolForwarderKeeper(deps: StartDeps = {}): Promise<boolean> {
  if (started) return true;
  const env = deps.env ?? process.env;
  let cfg: ForwarderKeeperConfig;
  try {
    cfg = forwarderKeeperConfig(env);
  } catch (error) {
    health = { mode: "off", intervalMs: 0, keeper: null, startError: errText(error) };
    console.error("[forwarder-keeper] config refused", { error: errText(error) });
    return false;
  }
  health = { mode: cfg.mode, intervalMs: cfg.intervalMs, keeper: null, startError: null };
  for (const c of cfg.chains) statuses.set(c.chainId, newChainStatus(c.chainId, c.forwarder));
  if (cfg.mode === "off") {
    console.log("[forwarder-keeper] off (PROTOCOL_FORWARDER_KEEPER=dry|send to enable)");
    return false;
  }
  if (cfg.chains.length === 0) {
    console.log("[forwarder-keeper] no chain configured (PROTOCOL_FORWARDER_ADDRESS_56 / _4663)");
    return false;
  }
  let wallet: ethers.Wallet | null = null;
  try {
    wallet = forwarderKeeperWallet(cfg.mode, env);
  } catch (error) {
    health.startError = errText(error);
    console.error("[forwarder-keeper] refused to start", { error: errText(error) });
    return false;
  }
  health.keeper = wallet?.address ?? null;

  const rpcUrl = deps.rpcUrl ?? (await defaultRpcUrl());
  const makeReader = deps.makeReader ?? (await defaultReaderFactory());
  const makeSender = deps.makeSender ?? (await defaultSenderFactory());
  started = true;
  for (const c of cfg.chains) {
    const url = rpcUrl(c.chainId);
    const status = statuses.get(c.chainId)!;
    if (!url) {
      status.lastError = { at: new Date().toISOString(), message: "no RPC configured for this chain" };
      console.warn("[forwarder-keeper] chain skipped: no RPC", { chainId: c.chainId });
      continue;
    }
    const reader = makeReader(c.chainId, url);
    const sender = wallet ? makeSender(c.chainId, url, wallet) : null;
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await withTimeout(runForwarderTick({ chainId: c.chainId, status, reader, sender, cfg }), cfg.tickTimeoutMs, `forwarder tick ${c.chainId}`);
      } catch (error) {
        status.lastError = { at: new Date().toISOString(), message: errText(error) };
      } finally {
        running = false;
      }
    };
    console.log("[forwarder-keeper] enabled", { chainId: c.chainId, mode: cfg.mode, forwarder: c.forwarder, keeper: wallet?.address ?? null, intervalMs: cfg.intervalMs });
    const first = setTimeout(() => void tick(), 30_000);
    first.unref?.();
    const timer = setInterval(() => void tick(), cfg.intervalMs);
    timer.unref?.();
  }
  return true;
}

async function defaultRpcUrl() {
  const { ENV } = await import("./env.js");
  const { parseRpcList } = await import("./rpcProvider.js");
  return (chainId: number) => parseRpcList(chainId === 56 ? ENV.BSC_RPC_HTTP_56 : chainId === 4663 ? ENV.ROBINHOOD_RPC_HTTP_4663 : "")[0] || "";
}

async function defaultReaderFactory() {
  const { createStaticJsonRpcProvider } = await import("./rpcProvider.js");
  return (chainId: number, url: string) => createEthersForwarderReader(createStaticJsonRpcProvider(url, chainId, { timeoutMs: 20_000 }));
}

async function defaultSenderFactory() {
  const { createStaticJsonRpcProvider } = await import("./rpcProvider.js");
  return (chainId: number, url: string, wallet: ethers.Wallet) => createEthersForwarderSender(createStaticJsonRpcProvider(url, chainId, { timeoutMs: 20_000 }), wallet);
}

/** Test hook: forget the started flag and every chain status. */
export function resetProtocolForwarderKeeperForTests() {
  started = false;
  statuses.clear();
  health = { mode: "off", intervalMs: 0, keeper: null, startError: null };
}
