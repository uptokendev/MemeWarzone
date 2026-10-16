/**
 * DogeOS keepers (barkswap plan t20; spec docs/templar/specs/2026-10-14-dogeos-barkswap-launch-design.md section 4
 * "Keepers", B9). Only on DogeOS Chikyu (6281971, the Barkswap venue); every lane is off by default and dry-runs
 * (simulate + log, nothing signed) until DOGEOS_BARK_SEND_6281971=true.
 *
 * Keys (B9). The DogeOS keeper key holds no contract role and only sends the permissionless steps (BARK_KEEPER_CALLS);
 * the DogeOS operator key holds the splitter, router-claim and choice-vault operator roles and only sends those
 * (BARK_OPERATOR_CALLS). createBarkSender refuses any other pairing before anything is simulated, and sends one
 * transaction per key at a time.
 *
 * Lanes, each behind its own flag:
 *   collect     DOGEOS_BARK_COLLECT_ENABLED_6281971      keeper    launcher.collect(coin) when its uncollected DOGE fees
 *               reach DOGEOS_BARK_COLLECT_MIN_WEI or its coin fees can convert; launcher.convert(coin) once its interval
 *               allows; choiceVault.pull(coin) for choice coins whose creator balance reaches DOGEOS_BARK_PULL_MIN_WEI
 *   gradFee     DOGEOS_BARK_GRAD_FEE_ENABLED_6281971     keeper    graduation-fee fallback: launcher.takeGraduationFee(pool)
 *               for a graduated coin whose fee the plugin's inline call did not take
 *   reserve     DOGEOS_BARK_RESERVE_ENABLED_6281971      keeper    MwzBarkReserveLock.release(coin) once the release delay
 *               after graduation passed
 *   adminWatch  DOGEOS_BARK_ADMIN_WATCH_ENABLED_6281971  keeper    reads each of our pools' plugin(), globalState()
 *               (lastFee, plugin config, community fee) and tickSpacing() every DOGEOS_BARK_ADMIN_WATCH_MS; any change from
 *               the launch values raises an alert, and a changed plugin / lastFee / config is put back with
 *               launcher.restore(coin) (the community fee and tick spacing are not ours to set: alert only)
 *   sidePools   DOGEOS_BARK_SIDE_POOLS_ENABLED_6281971   none      side-pool watch (evmGen8SidePools.ts
 *               runBarkSidePoolWatcherOnce: Barkswap Pool / CustomPool and MuchFi), read only, alerts
 *   route       DOGEOS_BARK_ROUTE_ENABLED_6281971        operator  t19's route worker (evmGen8FeeRouting.ts
 *               runGen8RoutePass on the Barkswap venue: claimRouter -> splitter.route), every DOGEOS_BARK_ROUTE_INTERVAL_MS
 *   buyback     EVM_CREATOR_CHOICE_ENABLED_6281971       operator  MwzBarkCreatorChoiceVault.buyback(coin, amount) at the
 *               coin's secret moments (EVM_BUYBACK_SEED_SECRET, evmCreatorChoice.ts dueMomentKey), sized to the vault's
 *               per-tx / per-week caps and interval, never below EVM_BUYBACK_MIN_WEI_6281971 (evmCreatorChoiceConfig.ts)
 *
 * Env:
 *   DOGEOS_BARK_SEND_6281971=true            real sends (each lane still needs its flag and its key)
 *   DOGEOS_BARK_KEEPER_PRIVATE_KEY_6281971   the DogeOS keeper key (refused when it is DOGEOS_OPERATOR_ADDRESS, a deployer,
 *                                            the route authority or an EVM_KEEPER_FORBIDDEN_ADDRESSES entry)
 *   EVM_GEN8_OPERATOR_KEY_6281971            the DogeOS operator key; must be DOGEOS_OPERATOR_ADDRESS's key. The V4 name
 *                                            without the chain suffix is never read here.
 *   EVM_GEN8_LENS_6281971                    MwzBarkLaunchLens (collect, grad fee and reserve read it)
 *   DOGEOS_BARK_KEEPER_POLL_MS (300000), DOGEOS_BARK_ADMIN_WATCH_MS (180000), DOGEOS_BARK_BUYBACK_POLL_MS (60000),
 *   DOGEOS_BARK_ROUTE_INTERVAL_MS (3600000): intervals, floor 60000. EVM_GEN8_SIDE_POLL_MS: side-pool watch.
 *   DOGEOS_BARK_COLLECT_MIN_WEI / DOGEOS_BARK_PULL_MIN_WEI (1e17 = 0.1 DOGE each)
 *   DOGEOS_BARK_COMMUNITY_FEE_6281971        Barkswap's community fee at launch (30 = 3%, docs/dogeos/barkswap-facts.md)
 *   EVM_GEN8_ROUTE_MIN_WEI / _BACKLOG_HOURS / _DROP_MINUTES, EVM_GEN8_PAID_MISMATCH_ALERT_AFTER: as the V4 route worker
 */
import { ethers } from "ethers";
import { dueMomentKey } from "./evmCreatorChoice.js";
import { assertOperatorKeyAllowed, choiceConfig, enabledChoiceChains, truthy } from "./evmCreatorChoiceConfig.js";
import type { ChoiceConfig } from "./evmCreatorChoicePass.js";
import { gen8SidePollMs, intEnv, type Gen8BarkChainConfig } from "./evmGen8Config.js";
import { GEN8_ROUTING_ALERT_TYPE, checkGen8Backlog, ethersRouteChain, runGen8RoutePass, type Gen8RouteChain } from "./evmGen8FeeRouting.js";
import { GEN8_SIDE_ALERT_TYPE, runBarkSidePoolWatcherOnce } from "./evmGen8SidePools.js";
import { loadGen8Pools, type Queryable } from "./evmGen8Store.js";
import { assertKeeperKeyAllowed } from "./evmGraduationKeeper.js";

export const DOGEOS_BARK_CHAIN_ID = 6281971;

/** Our launch values (MwzBarkPlugin.PLUGIN_CONFIG, the launcher's TICK_SPACING, Barkswap's default community fee). */
export const BARK_PLUGIN_CONFIG = 135;
export const BARK_TICK_SPACING = 10;
export const BARK_LAUNCH_COMMUNITY_FEE = 30;

export const BARK_KEEPER_ALERT_TYPE = "dogeos_bark_keeper";

export type BarkLane = "collect" | "gradFee" | "reserve" | "adminWatch" | "sidePools" | "route" | "buyback";
export const BARK_LANES: readonly BarkLane[] = Object.freeze(["collect", "gradFee", "reserve", "adminWatch", "sidePools", "route", "buyback"]);

export const BARK_LANE_FLAG: Readonly<Record<BarkLane, string>> = Object.freeze({
  collect: "DOGEOS_BARK_COLLECT_ENABLED_6281971",
  gradFee: "DOGEOS_BARK_GRAD_FEE_ENABLED_6281971",
  reserve: "DOGEOS_BARK_RESERVE_ENABLED_6281971",
  adminWatch: "DOGEOS_BARK_ADMIN_WATCH_ENABLED_6281971",
  sidePools: "DOGEOS_BARK_SIDE_POOLS_ENABLED_6281971",
  route: "DOGEOS_BARK_ROUTE_ENABLED_6281971",
  buyback: "EVM_CREATOR_CHOICE_ENABLED_6281971",
});

export type BarkKeyRole = "keeper" | "operator";

/** B9: which key each lane signs with (the side-pool watch only reads). */
export const BARK_LANE_KEY: Readonly<Record<BarkLane, BarkKeyRole | null>> = Object.freeze({
  collect: "keeper",
  gradFee: "keeper",
  reserve: "keeper",
  adminWatch: "keeper",
  sidePools: null,
  route: "operator",
  buyback: "operator",
});

export const BARK_SEND_FLAG = "DOGEOS_BARK_SEND_6281971";
export const BARK_KEEPER_KEY_ENV = "DOGEOS_BARK_KEEPER_PRIVATE_KEY_6281971";
export const BARK_OPERATOR_KEY_ENV = "EVM_GEN8_OPERATOR_KEY_6281971";
export const BARK_LENS_ENV = "EVM_GEN8_LENS_6281971";

export type BarkContract = "launcher" | "reserveLock" | "choiceVault" | "splitter";

/** The permissionless steps, the only functions the keeper key ever sends (B9: it holds no contract role). */
export const BARK_KEEPER_CALLS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  launcher: Object.freeze(["collect", "convert", "restore", "takeGraduationFee"]),
  reserveLock: Object.freeze(["release"]),
  choiceVault: Object.freeze(["pull"]),
});

/**
 * What the operator key sends: its roles (launcher.claimRouter as the splitter's operator F4, splitter.route,
 * choiceVault.buyback / holder batches) and launcher.payParkedRouter, which the route worker sends with it (F3).
 */
export const BARK_OPERATOR_CALLS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  launcher: Object.freeze(["claimRouter", "payParkedRouter"]),
  splitter: Object.freeze(["route"]),
  choiceVault: Object.freeze(["buyback", "executeHolderBatch", "proposeHolderBatch"]),
});

/**
 * ABI fragments the keepers use, from the t7 export (contracts/dogeos/barkswap/abi/*.abi.json; pinned in
 * dogeosBarkKeepers.test.ts) and Algebra Integral 1.2.1's pool (contracts/dogeos/barkswap/interfaces/core/pool).
 * The custom errors turn a failed simulation into a readable skip reason.
 */
export const BARK_FRAGMENTS = Object.freeze({
  launcher: [
    "function collect(address coin)",
    "function convert(address coin) returns (uint256 coinsIn, uint256 nativeOut)",
    "function restore(address coin)",
    "function takeGraduationFee(address pool)",
    "error ConversionFeeNotZero()",
    "error ConversionInLaunchWindow()",
    "error ConversionTooSoon()",
    "error ForeignPlugin()",
    "error GraduationFeeAlreadyTaken()",
    "error NotGraduated()",
    "error NothingToCollect()",
    "error NothingToConvert()",
    "error NothingToRestore()",
    "error PoolBusy()",
    "error PriceBelowGraduation()",
    "error ReentrancyGuardReentrantCall()",
    "error UnknownCoin()",
    "error UnknownPool()",
  ],
  reserveLock: [
    "function release(address coin) returns (uint256 amount)",
    "function reserves(address coin) view returns (address token, uint96 amount)",
    "function RESERVE_RELEASE_DELAY() view returns (uint256)",
    "error NothingLocked()",
    "error NotGraduated()",
    "error PoolBusy()",
    "error PriceBelowGraduation()",
    "error ReserveTooEarly()",
  ],
  choiceVault: [
    "function pull(address coin) returns (uint256 amount)",
    "function buyback(address coin, uint256 amountIn) returns (uint256 spent, uint256 burned)",
    "function cfg(address coin) view returns (address creator, uint8 choice, uint8 creatorPct, address token)",
    "function buybackBalance(address coin) view returns (uint256)",
    "function buybackSpentInWeek(address coin) view returns (uint256)",
    "function lastBuybackAt(address coin) view returns (uint256)",
    "function maxBuyPerTx() view returns (uint256)",
    "function maxBuybackPerCoinWeek() view returns (uint256)",
    "function minBuyInterval() view returns (uint256)",
    "function operator() view returns (address)",
    "function operatorPaused() view returns (bool)",
    "error CapExceeded()",
    "error CurveState()",
    "error ImpactTooHigh()",
    "error Insufficient()",
    "error NothingSwapped()",
    "error OnlyOperator()",
    "error PoolNotRestored()",
    "error PullMismatch()",
    "error TooSoon()",
    "error WrongChoice()",
  ],
  lens: [
    "function owed(address coin) view returns ((address feeCreator, address pendingCreator, uint256 creatorOwed, uint256[4] coinBooks, uint256[4] uncollectedNative, uint256[4] uncollectedCoin, uint40 lastConvertAt, uint256 nextConvertAt, bool gradFeeTaken, uint256 graduationFee) o)",
    "function progress(address coin) view returns ((bool graduated, bool postPhase, uint40 graduatedAt, uint160 sqrtPriceX96, uint256 coinsSoldFromA, uint256 coinsInA, uint256 nativeInA, uint256 nativeTargetA) p)",
    "error UnknownCoin()",
  ],
  pool: [
    "function plugin() view returns (address pluginAddress)",
    "function globalState() view returns (uint160 price, int24 tick, uint16 lastFee, uint8 pluginConfig, uint16 communityFee, bool unlocked)",
    "function tickSpacing() view returns (int24)",
  ],
});

const CHOICE_BUYBACK = 4; // MwzBarkCreatorChoiceVault.Choice.Buyback
const WEEK_SECONDS = 7 * 24 * 3600;
const lc = (s: string) => String(s).toLowerCase();
const sum = (xs: readonly bigint[]) => xs.reduce((a, b) => a + b, 0n);

// ------------------------------------------------------------------------------------------------ keys

function walletFrom(raw: string): ethers.Wallet {
  return new ethers.Wallet(raw.startsWith("0x") ? raw : `0x${raw}`);
}

/** The DogeOS keeper key, DOGEOS_BARK_KEEPER_PRIVATE_KEY_6281971 only; throws when the keeper guard refuses it. */
export function barkKeeperWallet(env: NodeJS.ProcessEnv = process.env): ethers.Wallet | null {
  const raw = String(env[BARK_KEEPER_KEY_ENV] || "").trim();
  if (!raw) return null;
  const wallet = walletFrom(raw);
  assertKeeperKeyAllowed(wallet.address, env, DOGEOS_BARK_CHAIN_ID);
  return wallet;
}

/**
 * The DogeOS operator key, EVM_GEN8_OPERATOR_KEY_6281971 only. Throws unless it is the key of DOGEOS_OPERATOR_ADDRESS
 * (B9; that is also the address the keeper guard refuses, so the two keys can never be the same) and passes the
 * operator guard (never a deployer, the Safe or the route authority).
 */
export function barkOperatorWallet(env: NodeJS.ProcessEnv = process.env): ethers.Wallet | null {
  const raw = String(env[BARK_OPERATOR_KEY_ENV] || "").trim();
  if (!raw) return null;
  const wallet = walletFrom(raw);
  const expected = String(env.DOGEOS_OPERATOR_ADDRESS || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(expected)) {
    throw new Error(`${BARK_OPERATOR_KEY_ENV} needs DOGEOS_OPERATOR_ADDRESS (the operator's public address, spec B9) to be checked against`);
  }
  if (lc(expected) !== lc(wallet.address)) throw new Error(`${BARK_OPERATOR_KEY_ENV} ${wallet.address} is not the DogeOS operator DOGEOS_OPERATOR_ADDRESS ${expected}`);
  assertOperatorKeyAllowed(wallet.address, env);
  return wallet;
}

// ------------------------------------------------------------------------------------------------ config

export type DogeosBarkKeeperConfig = {
  chainId: number;
  send: boolean;
  lanes: Record<BarkLane, boolean>;
  keeper: ethers.Wallet | null;
  operator: ethers.Wallet | null;
  lens: string | null;
  /** Why a flagged lane does not run, or runs without its key (logged at start). */
  errors: string[];
  pollMs: number;
  adminWatchMs: number;
  buybackPollMs: number;
  routeMs: number;
  sidePollMs: number;
  minCollectWei: bigint;
  minPullWei: bigint;
  expected: { communityFee: number; tickSpacing: number };
  choice: ChoiceConfig;
};

function weiEnv(raw: unknown, fallback: bigint): bigint {
  const s = String(raw ?? "").trim();
  return /^\d+$/.test(s) ? BigInt(s) : fallback;
}

export function dogeosBarkKeeperConfig(cfg: Gen8BarkChainConfig, env: NodeJS.ProcessEnv = process.env): DogeosBarkKeeperConfig {
  if (cfg.chainId !== DOGEOS_BARK_CHAIN_ID) throw new Error(`the DogeOS keepers run on ${DOGEOS_BARK_CHAIN_ID} only, not ${cfg.chainId}`);
  const errors: string[] = [];
  const lanes = Object.fromEntries(
    BARK_LANES.map((lane) => [lane, lane === "buyback" ? enabledChoiceChains(env).includes(DOGEOS_BARK_CHAIN_ID) : truthy(env[BARK_LANE_FLAG[lane]])]),
  ) as Record<BarkLane, boolean>;
  const off = (lane: BarkLane, why: string) => {
    if (!lanes[lane]) return;
    lanes[lane] = false;
    errors.push(`${lane} off: ${why}`);
  };

  const lensRaw = String(env[BARK_LENS_ENV] || "").split("@")[0]!.trim();
  const lens = /^0x[0-9a-fA-F]{40}$/.test(lensRaw) && !/^0x0{40}$/i.test(lensRaw) ? lc(lensRaw) : null;
  if (!lens) for (const lane of ["collect", "gradFee", "reserve"] as const) off(lane, `${BARK_LENS_ENV} is unset or not an address`);
  if (!cfg.reserveLock) off("reserve", "EVM_GEN8_RESERVE_LOCK_6281971 is unset");
  if (!cfg.splitter) off("route", "EVM_GEN8_SPLITTER_6281971 is unset");
  if (!cfg.choiceVault) off("buyback", "EVM_GEN8_CHOICE_VAULT_6281971 is unset");
  const choice = choiceConfig(DOGEOS_BARK_CHAIN_ID, env);
  if (!choice.masterSecret) off("buyback", "EVM_BUYBACK_SEED_SECRET is unset (the secret buyback moments)");

  const needs = (role: BarkKeyRole) => BARK_LANES.filter((lane) => lanes[lane] && BARK_LANE_KEY[lane] === role);
  let operator: ethers.Wallet | null = null;
  if (needs("operator").length) {
    try {
      operator = barkOperatorWallet(env);
      if (!operator) errors.push(`${BARK_OPERATOR_KEY_ENV} unset: ${needs("operator").join(", ")} dry-run only`);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      for (const lane of needs("operator")) off(lane, why);
    }
  }
  let keeper: ethers.Wallet | null = null;
  if (needs("keeper").length) {
    try {
      keeper = barkKeeperWallet(env);
      if (keeper && operator && lc(keeper.address) === lc(operator.address)) throw new Error(`${BARK_KEEPER_KEY_ENV} refuses key ${keeper.address}: it is the operator key`);
      if (!keeper) errors.push(`${BARK_KEEPER_KEY_ENV} unset: ${needs("keeper").join(", ")} report what is due and send nothing`);
    } catch (error) {
      keeper = null;
      const why = error instanceof Error ? error.message : String(error);
      for (const lane of needs("keeper")) off(lane, why);
    }
  }

  const ms = (name: string, fallback: number) => intEnv(env[name], fallback, 60_000);
  return {
    chainId: cfg.chainId,
    send: truthy(env[BARK_SEND_FLAG]),
    lanes,
    keeper,
    operator,
    lens,
    errors,
    pollMs: ms("DOGEOS_BARK_KEEPER_POLL_MS", 300_000),
    adminWatchMs: ms("DOGEOS_BARK_ADMIN_WATCH_MS", 180_000),
    buybackPollMs: ms("DOGEOS_BARK_BUYBACK_POLL_MS", 60_000),
    routeMs: ms("DOGEOS_BARK_ROUTE_INTERVAL_MS", 3_600_000),
    sidePollMs: gen8SidePollMs(env),
    minCollectWei: weiEnv(env.DOGEOS_BARK_COLLECT_MIN_WEI, 10n ** 17n),
    minPullWei: weiEnv(env.DOGEOS_BARK_PULL_MIN_WEI, 10n ** 17n),
    expected: { communityFee: intEnv(env.DOGEOS_BARK_COMMUNITY_FEE_6281971, BARK_LAUNCH_COMMUNITY_FEE, 0, 1_000), tickSpacing: BARK_TICK_SPACING },
    choice,
  };
}

// ------------------------------------------------------------------------------------------------ sender

export type BarkCall = { contract: BarkContract; fn: string; args: unknown[]; coin: string };
export type BarkExecResult = { ok: true; hash?: string } | { ok: false; error: string };
/** The chain side of a send: simulate (eth_call from the signer) or send and wait for the receipt. */
export type BarkExec = (input: { who: BarkKeyRole; signer: ethers.Wallet; call: BarkCall; mode: "simulate" | "send" }) => Promise<BarkExecResult>;
export type BarkStep = { who: BarkKeyRole; call: string; coin: string; decision: "sent" | "dry-run" | "skip"; reason?: string; hash?: string };

/** B9: throws unless `who` may send `call` (keeper: permissionless steps only; operator: operator-role steps only). */
export function assertBarkCallKey(who: BarkKeyRole, call: Pick<BarkCall, "contract" | "fn">): void {
  const allowed = who === "keeper" ? BARK_KEEPER_CALLS : BARK_OPERATOR_CALLS;
  if (!(allowed[call.contract] ?? []).includes(call.fn)) {
    const why = who === "keeper" ? "not a permissionless step (B9: the keeper holds no contract role)" : "not an operator-role step (B9)";
    throw new Error(`DogeOS ${who} key refuses ${call.contract}.${call.fn}: ${why}`);
  }
}

export type BarkSender = {
  send: boolean;
  address(who: BarkKeyRole): string | null;
  call(who: BarkKeyRole, call: BarkCall): Promise<BarkStep>;
  /** Runs `fn` while no other transaction of `who`'s key is in flight (the route worker sends through its own chain). */
  exclusive<T>(who: BarkKeyRole, fn: () => Promise<T>): Promise<T>;
};

export function createBarkSender(input: { keeper: ethers.Wallet | null; operator: ethers.Wallet | null; exec: BarkExec; send: boolean }): BarkSender {
  const tails: Record<BarkKeyRole, Promise<unknown>> = { keeper: Promise.resolve(), operator: Promise.resolve() };
  const exclusive = <T>(who: BarkKeyRole, fn: () => Promise<T>): Promise<T> => {
    const run = tails[who].then(fn, fn);
    tails[who] = run.catch(() => undefined);
    return run;
  };
  return {
    send: input.send,
    address: (who) => (who === "keeper" ? input.keeper : input.operator)?.address ?? null,
    exclusive,
    async call(who, call) {
      assertBarkCallKey(who, call);
      const signer = who === "keeper" ? input.keeper : input.operator;
      const base = { who, call: `${call.contract}.${call.fn}`, coin: call.coin };
      if (!signer) return { ...base, decision: "skip", reason: `no ${who} key` };
      return exclusive(who, async (): Promise<BarkStep> => {
        const sim = await input.exec({ who, signer, call, mode: "simulate" });
        if (!sim.ok) return { ...base, decision: "skip", reason: `simulation: ${sim.error}` };
        if (!input.send) return { ...base, decision: "dry-run" };
        const sent = await input.exec({ who, signer, call, mode: "send" });
        if (!sent.ok) return { ...base, decision: "skip", reason: `send failed: ${sent.error}` };
        return { ...base, decision: "sent", hash: sent.hash };
      });
    },
  };
}

function revertReason(error: unknown): string {
  const e = error as any;
  if (e?.revert?.name) return `${e.revert.name}()`;
  return String(e?.shortMessage || e?.message || error).slice(0, 300);
}

/** The ethers exec: Bark contract by role, from the signer connected to the chain's provider. */
export function ethersBarkExec(addresses: { launcher: string; reserveLock: string | null; choiceVault: string | null }, provider: ethers.Provider): BarkExec {
  return async ({ signer, call, mode }) => {
    const address = call.contract === "splitter" ? null : addresses[call.contract];
    if (!address) return { ok: false, error: `no ${call.contract} address for ${call.fn}` };
    const contract = new ethers.Contract(address, BARK_FRAGMENTS[call.contract as "launcher" | "reserveLock" | "choiceVault"], signer.connect(provider)) as any;
    try {
      if (mode === "simulate") {
        await contract[call.fn].staticCall(...call.args);
        return { ok: true };
      }
      const tx = await contract[call.fn](...call.args);
      const rc = await tx.wait();
      if (!rc || Number(rc.status) !== 1) return { ok: false, error: `reverted: ${tx.hash}` };
      return { ok: true, hash: String(tx.hash) };
    } catch (error) {
      return { ok: false, error: revertReason(error) };
    }
  };
}

// ------------------------------------------------------------------------------------------------ chain reads

export type BarkCoin = { coin: string; pool: string; graduated: boolean };
export type BarkOwed = { feeCreator: string; creatorOwed: bigint; coinBooks: bigint[]; uncollectedNative: bigint[]; uncollectedCoin: bigint[]; nextConvertAt: number; gradFeeTaken: boolean };
export type BarkPoolSettings = { plugin: string; lastFee: number; pluginConfig: number; communityFee: number; tickSpacing: number; unlocked: boolean };
export type BarkChoiceState = {
  choice: number;
  buybackBalance: bigint;
  spentInWeek: bigint;
  lastBuybackAt: number;
  maxBuyPerTx: bigint;
  maxBuybackPerCoinWeek: bigint;
  minBuyInterval: number;
  operator: string;
  operatorPaused: boolean;
};

export interface BarkKeeperReader {
  /** Latest block time (unix seconds). */
  blockTime(): Promise<number>;
  owed(coin: string): Promise<BarkOwed>;
  progress(coin: string): Promise<{ graduated: boolean; graduatedAt: number }>;
  reserveAmount(coin: string): Promise<bigint>;
  reserveReleaseDelay(): Promise<number>;
  poolSettings(pool: string): Promise<BarkPoolSettings>;
  choiceState(coin: string): Promise<BarkChoiceState>;
}

export function ethersBarkReader(a: { lens: string | null; reserveLock: string | null; choiceVault: string | null }, provider: ethers.Provider): BarkKeeperReader {
  const make = (address: string | null, fragments: readonly string[], what: string) => {
    let c: any = null;
    return () => {
      if (!address) throw new Error(`no ${what} address`);
      c ??= new ethers.Contract(address, fragments as string[], provider);
      return c;
    };
  };
  const lens = make(a.lens, BARK_FRAGMENTS.lens, `lens (${BARK_LENS_ENV})`);
  const reserveLock = make(a.reserveLock, BARK_FRAGMENTS.reserveLock, "reserve lock");
  const vault = make(a.choiceVault, BARK_FRAGMENTS.choiceVault, "choice vault");
  const big4 = (xs: unknown) => [...(xs as unknown[])].map((x) => BigInt(x as bigint));
  return {
    async blockTime() {
      const b = await provider.getBlock("latest");
      if (!b) throw new Error("no latest block");
      return Number(b.timestamp);
    },
    async owed(coin) {
      const o = await lens().owed(coin);
      return {
        feeCreator: lc(o.feeCreator), creatorOwed: BigInt(o.creatorOwed), coinBooks: big4(o.coinBooks), uncollectedNative: big4(o.uncollectedNative),
        uncollectedCoin: big4(o.uncollectedCoin), nextConvertAt: Number(o.nextConvertAt), gradFeeTaken: Boolean(o.gradFeeTaken),
      };
    },
    async progress(coin) {
      const p = await lens().progress(coin);
      return { graduated: Boolean(p.graduated), graduatedAt: Number(p.graduatedAt) };
    },
    async reserveAmount(coin) {
      return BigInt((await reserveLock().reserves(coin)).amount);
    },
    async reserveReleaseDelay() {
      return Number(await reserveLock().RESERVE_RELEASE_DELAY());
    },
    async poolSettings(pool) {
      const c = new ethers.Contract(pool, BARK_FRAGMENTS.pool as unknown as string[], provider) as any;
      const [plugin, g, spacing] = await Promise.all([c.plugin(), c.globalState(), c.tickSpacing()]);
      return { plugin: lc(plugin), lastFee: Number(g.lastFee), pluginConfig: Number(g.pluginConfig), communityFee: Number(g.communityFee), tickSpacing: Number(spacing), unlocked: Boolean(g.unlocked) };
    },
    async choiceState(coin) {
      const v = vault();
      const [cfg, balance, spent, last, perTx, perWeek, interval, operator, paused] = await Promise.all([
        v.cfg(coin), v.buybackBalance(coin), v.buybackSpentInWeek(coin), v.lastBuybackAt(coin), v.maxBuyPerTx(), v.maxBuybackPerCoinWeek(), v.minBuyInterval(), v.operator(), v.operatorPaused(),
      ]);
      return {
        choice: Number(cfg.choice), buybackBalance: BigInt(balance), spentInWeek: BigInt(spent), lastBuybackAt: Number(last), maxBuyPerTx: BigInt(perTx),
        maxBuybackPerCoinWeek: BigInt(perWeek), minBuyInterval: Number(interval), operator: lc(operator), operatorPaused: Boolean(paused),
      };
    },
  };
}

/** Our coins on the chain, from the indexer's gen-8 pool rows (hook_address = the plugin, pool_manager_address = the pool). */
export async function loadBarkCoins(db: Queryable, cfg: Gen8BarkChainConfig): Promise<BarkCoin[]> {
  const pools = await loadGen8Pools(db, cfg.chainId, cfg.plugin.address);
  return [...pools.values()].map((p) => ({ coin: lc(p.token), pool: lc(p.poolManager), graduated: p.graduatedBlock !== null }));
}

// ------------------------------------------------------------------------------------------------ lanes

type Alert = (a: { severity: "critical" | "warning" | "info"; kind: string; chainId: number; subject?: string; title: string; message: string; extra?: Record<string, unknown> }) => Promise<unknown>;

function readFailed(who: BarkKeyRole, call: string, coin: string, error: unknown): BarkStep {
  return { who, call, coin, decision: "skip", reason: `read failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) };
}

/** Collect + coin conversion + choice-vault pull (keeper key). */
export async function runBarkCollectPass(input: { cfg: Gen8BarkChainConfig; coins: BarkCoin[]; reader: BarkKeeperReader; sender: BarkSender; minCollectWei: bigint; minPullWei: bigint }): Promise<BarkStep[]> {
  const out: BarkStep[] = [];
  const now = await input.reader.blockTime();
  const vault = input.cfg.choiceVault ? lc(input.cfg.choiceVault) : null;
  for (const c of input.coins) {
    let o: BarkOwed;
    try {
      o = await input.reader.owed(c.coin);
    } catch (error) {
      out.push(readFailed("keeper", "launcher.collect", c.coin, error));
      continue;
    }
    const convertDue = now >= o.nextConvertAt;
    const coinsWaiting = sum(o.uncollectedCoin) > 0n;
    let collected = false;
    if (sum(o.uncollectedNative) >= input.minCollectWei || (coinsWaiting && convertDue)) {
      const r = await input.sender.call("keeper", { contract: "launcher", fn: "collect", args: [c.coin], coin: c.coin });
      out.push(r);
      collected = r.decision !== "skip";
    }
    if (convertDue && (sum(o.coinBooks) > 0n || (collected && coinsWaiting))) {
      out.push(await input.sender.call("keeper", { contract: "launcher", fn: "convert", args: [c.coin], coin: c.coin }));
    }
    if (vault && lc(o.feeCreator) === vault && o.creatorOwed > 0n && o.creatorOwed >= input.minPullWei) {
      out.push(await input.sender.call("keeper", { contract: "choiceVault", fn: "pull", args: [c.coin], coin: c.coin }));
    }
  }
  return out;
}

/** Graduation-fee fallback (keeper key): a coin the indexer saw graduate whose fee is still untaken. */
export async function runBarkGradFeePass(input: { coins: BarkCoin[]; reader: BarkKeeperReader; sender: BarkSender }): Promise<BarkStep[]> {
  const out: BarkStep[] = [];
  for (const c of input.coins) {
    if (!c.graduated) continue;
    try {
      if ((await input.reader.owed(c.coin)).gradFeeTaken) continue;
    } catch (error) {
      out.push(readFailed("keeper", "launcher.takeGraduationFee", c.coin, error));
      continue;
    }
    out.push(await input.sender.call("keeper", { contract: "launcher", fn: "takeGraduationFee", args: [c.pool], coin: c.coin }));
  }
  return out;
}

/** Reserve release (keeper key): a graduated coin with its reserve still locked, once the release delay passed. */
export async function runBarkReservePass(input: { coins: BarkCoin[]; reader: BarkKeeperReader; sender: BarkSender }): Promise<BarkStep[]> {
  const out: BarkStep[] = [];
  const graduated = input.coins.filter((c) => c.graduated);
  if (!graduated.length) return out;
  const now = await input.reader.blockTime();
  const delay = await input.reader.reserveReleaseDelay();
  for (const c of graduated) {
    try {
      if ((await input.reader.reserveAmount(c.coin)) === 0n) continue;
      const p = await input.reader.progress(c.coin);
      if (!p.graduated || now < p.graduatedAt + delay) continue;
    } catch (error) {
      out.push(readFailed("keeper", "reserveLock.release", c.coin, error));
      continue;
    }
    out.push(await input.sender.call("keeper", { contract: "reserveLock", fn: "release", args: [c.coin], coin: c.coin }));
  }
  return out;
}

/** Settings `restore` puts back; the community fee and the tick spacing are Barkswap's to set (alert only). */
const RESTORABLE = new Set(["plugin", "lastFee", "pluginConfig"]);

/** Admin-change watch + restore (keeper key): our launch values on every one of our pools. */
export async function runBarkAdminWatchPass(input: {
  cfg: Gen8BarkChainConfig; coins: BarkCoin[]; reader: BarkKeeperReader; sender: BarkSender; alert: Alert; expected: { communityFee: number; tickSpacing: number };
}): Promise<BarkStep[]> {
  const out: BarkStep[] = [];
  const plugin = lc(input.cfg.plugin.address);
  for (const c of input.coins) {
    let s: BarkPoolSettings;
    try {
      s = await input.reader.poolSettings(c.pool);
    } catch (error) {
      out.push(readFailed("keeper", "launcher.restore", c.coin, error));
      continue;
    }
    const changed: string[] = [];
    if (lc(s.plugin) !== plugin) changed.push("plugin");
    if (s.lastFee !== 0) changed.push("lastFee");
    if (s.pluginConfig !== BARK_PLUGIN_CONFIG) changed.push("pluginConfig");
    if (s.communityFee !== input.expected.communityFee) changed.push("communityFee");
    if (s.tickSpacing !== input.expected.tickSpacing) changed.push("tickSpacing");
    if (!changed.length) continue;
    const restore = changed.some((k) => RESTORABLE.has(k));
    await input.alert({
      severity: restore ? "critical" : "warning",
      kind: "dogeos_bark_admin_change",
      chainId: input.cfg.chainId,
      subject: c.pool,
      title: `Barkswap admin changed our pool ${c.pool} on chain ${input.cfg.chainId}`,
      message:
        `Coin ${c.coin}: ${changed.join(", ")} differ from the launch values (plugin ${plugin}, lastFee 0, config ${BARK_PLUGIN_CONFIG}, ` +
        `community fee ${input.expected.communityFee}, tick spacing ${input.expected.tickSpacing}); now plugin ${s.plugin}, lastFee ${s.lastFee}, ` +
        `config ${s.pluginConfig}, community fee ${s.communityFee}, tick spacing ${s.tickSpacing}. ` +
        (restore ? "The keeper calls restore(coin)." : "Not ours to set: no restore."),
      extra: { coin: c.coin, pool: c.pool, changed, restore, observed: s },
    });
    if (restore) out.push(await input.sender.call("keeper", { contract: "launcher", fn: "restore", args: [c.coin], coin: c.coin }));
  }
  return out;
}

/**
 * Choice-vault buyback (operator key). Per coin at its latest passed secret moment (never caught up, each used once):
 * a buyback coin of a vault we operate, outside the vault's interval, sized min(balance, per-tx cap, week cap left),
 * at least choice.minSpendWei. The vault caps the price impact itself (price limit, partial fill).
 */
export async function runBarkBuybackPass(input: {
  cfg: Gen8BarkChainConfig; coins: BarkCoin[]; reader: BarkKeeperReader; sender: BarkSender; choice: ChoiceConfig; now?: Date; used: Map<string, Set<string>>;
}): Promise<BarkStep[]> {
  const out: BarkStep[] = [];
  if (!input.cfg.choiceVault || !input.choice.masterSecret) return out;
  const now = input.now ?? new Date();
  const operator = input.sender.address("operator");
  let chainNow: number | null = null;
  for (const c of input.coins) {
    const used = input.used.get(c.coin) ?? new Set<string>();
    input.used.set(c.coin, used);
    const key = dueMomentKey({ masterSecret: input.choice.masterSecret, chainId: input.cfg.chainId, campaign: c.coin, now, perDay: input.choice.perDay, used });
    if (!key) continue;
    used.add(key);
    const call = "choiceVault.buyback";
    let st: BarkChoiceState;
    try {
      st = await input.reader.choiceState(c.coin);
      chainNow ??= await input.reader.blockTime();
    } catch (error) {
      out.push(readFailed("operator", call, c.coin, error));
      continue;
    }
    if (st.choice !== CHOICE_BUYBACK) continue;
    const skip = (reason: string) => out.push({ who: "operator", call, coin: c.coin, decision: "skip", reason });
    if (st.operatorPaused) {
      skip("the vault's operator is paused");
      continue;
    }
    if (operator && lc(st.operator) !== lc(operator)) {
      skip(`the vault's operator is ${st.operator}, not ours`);
      continue;
    }
    if (st.lastBuybackAt > 0 && chainNow < st.lastBuybackAt + st.minBuyInterval) {
      skip("inside the vault's buyback interval");
      continue;
    }
    const week = Math.floor(chainNow / WEEK_SECONDS);
    const spent = st.lastBuybackAt > 0 && Math.floor(st.lastBuybackAt / WEEK_SECONDS) === week ? st.spentInWeek : 0n;
    const room = st.maxBuybackPerCoinWeek > spent ? st.maxBuybackPerCoinWeek - spent : 0n;
    let amount = st.buybackBalance;
    if (st.maxBuyPerTx < amount) amount = st.maxBuyPerTx;
    if (room < amount) amount = room;
    if (amount === 0n || amount < input.choice.minSpendWei) {
      skip(`buyback of ${amount} wei is below the minimum ${input.choice.minSpendWei}`);
      continue;
    }
    out.push(await input.sender.call("operator", { contract: "choiceVault", fn: "buyback", args: [c.coin, amount], coin: c.coin }));
  }
  return out;
}

/**
 * The route worker lane (t19's chain-side code, scheduled here): null unless DOGEOS_BARK_ROUTE_ENABLED_6281971 and a
 * splitter. Signed by the DogeOS operator key only, and only in send mode; otherwise a dry run with no signer.
 */
export function barkRouteLane(
  cfg: Gen8BarkChainConfig,
  env: NodeJS.ProcessEnv,
  provider: ethers.JsonRpcProvider,
  makeChain: (cfg: Gen8BarkChainConfig, provider: ethers.JsonRpcProvider, signer: ethers.Signer | null) => Gen8RouteChain = ethersRouteChain,
): { chain: Gen8RouteChain; send: boolean; operatorAddress: string | null } | null {
  if (cfg.chainId !== DOGEOS_BARK_CHAIN_ID || !truthy(env[BARK_LANE_FLAG.route]) || !cfg.splitter) return null;
  const sendFlag = truthy(env[BARK_SEND_FLAG]);
  let operator: ethers.Wallet | null = null;
  if (sendFlag) {
    try {
      operator = barkOperatorWallet(env);
    } catch (error) {
      console.warn("[dogeos-keepers] route: operator key refused; dry run only", { chainId: cfg.chainId, error: error instanceof Error ? error.message : String(error) });
    }
    if (!operator) console.warn(`[dogeos-keepers] route: send mode without ${BARK_OPERATOR_KEY_ENV}; dry run only`, { chainId: cfg.chainId });
  }
  const signer = operator ? operator.connect(provider) : null;
  return { chain: makeChain(cfg, provider, signer), send: Boolean(sendFlag && operator), operatorAddress: operator?.address ?? null };
}

// ------------------------------------------------------------------------------------------------ scheduling

export type BarkSchedule = (label: string, ms: number, fn: () => Promise<unknown>) => void;

function defaultSchedule(label: string, ms: number, fn: () => Promise<unknown>) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (error) {
      console.error(`[dogeos-keepers] ${label} failed`, error instanceof Error ? error.message : String(error));
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), Math.min(ms, 60_000));
  first.unref?.();
  const t = setInterval(() => void tick(), ms);
  t.unref?.();
}

function logSteps(lane: BarkLane, chainId: number, steps: BarkStep[]) {
  if (steps.length) console.log("[dogeos-keepers] pass", JSON.stringify({ chainId, lane, steps }));
}

/**
 * Starts the flagged DogeOS lanes (6281971 only) and returns them. Nothing is scheduled, read or signed for a lane whose
 * flag is off; with every flag off (the default) this does nothing.
 */
export function startDogeosBarkKeepers(opts: {
  db: Queryable;
  cfgs: Gen8BarkChainConfig[];
  providerFor: (chainId: number) => ethers.JsonRpcProvider | null;
  env?: NodeJS.ProcessEnv;
  schedule?: BarkSchedule;
}): BarkLane[] {
  const env = opts.env || process.env;
  const schedule = opts.schedule ?? defaultSchedule;
  const started: BarkLane[] = [];
  for (const cfg of opts.cfgs) {
    if (cfg.chainId !== DOGEOS_BARK_CHAIN_ID) continue;
    const kc = dogeosBarkKeeperConfig(cfg, env);
    for (const error of kc.errors) console.warn("[dogeos-keepers]", { chainId: cfg.chainId, error });
    const lanes = BARK_LANES.filter((lane) => kc.lanes[lane]);
    if (!lanes.length) {
      console.log("[dogeos-keepers] off (every DOGEOS_BARK_*_ENABLED_6281971 flag is off)");
      continue;
    }
    const provider = opts.providerFor(cfg.chainId);
    if (!provider) {
      console.warn("[dogeos-keepers] no RPC for chain; keepers off there", { chainId: cfg.chainId });
      continue;
    }
    const addresses = { launcher: cfg.launcher.address, reserveLock: cfg.reserveLock, choiceVault: cfg.choiceVault, lens: kc.lens };
    const reader = ethersBarkReader(addresses, provider);
    const sender = createBarkSender({ keeper: kc.keeper, operator: kc.operator, exec: ethersBarkExec(addresses, provider), send: kc.send });
    const alertAs = (rewardType: string): Alert => async (a) => (await import("./payoutWatchdogWorker.js")).raiseAlert(opts.db as any, { ...a, rewardType });
    const label = (lane: BarkLane) => `dogeos ${cfg.chainId} ${lane}`;
    console.log("[dogeos-keepers] on", { chainId: cfg.chainId, lanes, send: kc.send, keeper: kc.keeper?.address ?? null, operator: kc.operator?.address ?? null });
    const coins = () => loadBarkCoins(opts.db, cfg);
    const run = (lane: BarkLane, ms: number, pass: () => Promise<BarkStep[]>) => {
      schedule(label(lane), ms, async () => logSteps(lane, cfg.chainId, await pass()));
      started.push(lane);
    };

    if (kc.lanes.collect) run("collect", kc.pollMs, async () => runBarkCollectPass({ cfg, coins: await coins(), reader, sender, minCollectWei: kc.minCollectWei, minPullWei: kc.minPullWei }));
    if (kc.lanes.gradFee) run("gradFee", kc.pollMs, async () => runBarkGradFeePass({ coins: await coins(), reader, sender }));
    if (kc.lanes.reserve) run("reserve", kc.pollMs, async () => runBarkReservePass({ coins: await coins(), reader, sender }));
    if (kc.lanes.adminWatch) {
      run("adminWatch", kc.adminWatchMs, async () => runBarkAdminWatchPass({ cfg, coins: await coins(), reader, sender, alert: alertAs(BARK_KEEPER_ALERT_TYPE), expected: kc.expected }));
    }
    if (kc.lanes.sidePools) {
      schedule(label("sidePools"), kc.sidePollMs, async () => {
        const r = await runBarkSidePoolWatcherOnce({ db: opts.db, cfg, provider: provider as any, env, alert: alertAs(GEN8_SIDE_ALERT_TYPE) });
        if (r && (r.created || r.swaps)) console.log("[dogeos-keepers] side pools", { chainId: cfg.chainId, ...r });
      });
      started.push("sidePools");
    }
    if (kc.lanes.route) {
      const lane = barkRouteLane(cfg, env, provider);
      if (lane) {
        const backlogHours = intEnv(env.EVM_GEN8_ROUTE_BACKLOG_HOURS, 48, 1);
        const minWei = weiEnv(env.EVM_GEN8_ROUTE_MIN_WEI, 10n ** 15n);
        const mismatchMemory = new Map<string, number>();
        const paidMismatchStreak = new Map<string, number>();
        const paidMismatchAlertAfter = intEnv(env.EVM_GEN8_PAID_MISMATCH_ALERT_AFTER, 3, 1);
        const dropAfterMs = intEnv(env.EVM_GEN8_ROUTE_DROP_MINUTES, 15, 1) * 60_000;
        const alert = alertAs(GEN8_ROUTING_ALERT_TYPE);
        schedule(label("route"), kc.routeMs, () =>
          sender.exclusive("operator", async () => {
            const r = await runGen8RoutePass({ db: opts.db, cfg, chain: lane.chain, send: lane.send, operatorAddress: lane.operatorAddress, minWei, alert, mismatchMemory, paidMismatchStreak, paidMismatchAlertAfter, dropAfterMs });
            console.log("[dogeos-keepers] route pass", { chainId: cfg.chainId, ...r });
            await checkGen8Backlog(opts.db, cfg, backlogHours, alert);
          }),
        );
        started.push("route");
      }
    }
    if (kc.lanes.buyback) {
      const used = new Map<string, Set<string>>();
      run("buyback", kc.buybackPollMs, async () => runBarkBuybackPass({ cfg, coins: await coins(), reader, sender, choice: kc.choice, used }));
    }
  }
  return started;
}
