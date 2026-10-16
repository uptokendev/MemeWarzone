/**
 * The app's client for EVM generation 8 coins (docs/evm-launch/EVM_GEN8_V4_DESIGN.md on build/evm-gen8, sections 4 and
 * 6): create (signed create authorization, then MwzV4Launcher.launch exactly as the API returned it), trades in the
 * coin's own Uniswap V4 pool before and after graduation (V4Quoter quotes, UniversalRouter V4_SWAP execution, Permit2
 * for sells), the creator's escrowed buys (MwzCreatorEscrow, D5) and the creator panel's claims.
 *
 * Plain ESM over ethers, no React and no app globals, so the node tests run exactly this code against a local chain
 * with the real gen-8 contracts. Every function takes its provider / signer and addresses explicitly.
 *
 * Why the app builds its own trades (the widget's are built by the API, api/gen8Swap.js): trading is permissionless and
 * the fee is taken by the hook on chain, so there are no fee terms for the API to enforce; the partner fingerprint only
 * exists for widget builds. Both use the one encoder in shared/evmGen8Swap.mjs, so app and widget calldata have the
 * same shape, and the app keeps trading when the API is slow.
 *
 * App env (Vite, per chain id; the same addresses as the API's EVM_GEN8_* env):
 *   VITE_EVM_GEN8_LAUNCHER_<id>      MwzV4Launcher: set = native launches on this chain use generation 8
 *   VITE_EVM_GEN8_HOOK_<id>          MwzLaunchHook: required for any gen-8 trade or claim in the app
 *   VITE_EVM_GEN8_LENS_<id>          MwzLaunchLens: current fee and price-limited fills
 *   VITE_EVM_GEN8_ESCROW_<id>        MwzCreatorEscrow: the creator's own buys in the app
 *   VITE_EVM_GEN8_CHOICE_VAULT_<id>  MwzCreatorChoiceVault: holders / split / buyback coins
 *   VITE_EVM_GEN8_RESERVE_LOCK_<id>  MwzReserveLock: the creator's 2% reserve, released after graduation
 *   VITE_EVM_GEN8_UNIVERSAL_ROUTER_<id> (+ _LAYOUT_<id> for a router not in GEN8_KNOWN_ROUTERS), VITE_EVM_GEN8_V4_QUOTER_<id>:
 *                                    defaults on 56 / 4663 (shared/evmGen8Swap.mjs); testnets need them set
 *
 * Barkswap venue (DogeOS 6281971, GEN8_CHAIN_VENUE; barkswap plan t22, spec section 4 App): the same entry points branch
 * to src/lib/barkswapSwap.mjs. The coin trades in its Barkswap custom pool through Barkswap's SwapRouter and QuoterV2
 * (deployer = our launcher); everything Bark is keyed by the coin address (no pool id, no hook). App env:
 *   VITE_EVM_GEN8_LAUNCHER_6281971   MwzBarkLauncher (create, launch records, the creator ledger)  } both required
 *   VITE_EVM_GEN8_PLUGIN_6281971     MwzBarkPlugin (the pool plugin)                               }
 *   VITE_EVM_GEN8_LENS_ / _ESCROW_ / _CHOICE_VAULT_ / _RESERVE_LOCK_6281971: the Bark variants (optional, as above)
 *   VITE_EVM_GEN8_BARKSWAP_ROUTER_ / _BARKSWAP_QUOTER_ / _WNATIVE_6281971: overrides of Barkswap's SwapRouter, QuoterV2
 *                                    and WDOGE (defaults in barkswapSwap.mjs BARKSWAP_PERIPHERY)
 * Uniswap V4 names (HOOK / POOL_MANAGER / UNIVERSAL_ROUTER / V4_QUOTER) on 6281971 disable it, as in the API: a DogeOS
 * coin is never traded or read through V4 or through another chain's contracts.
 */
import { Contract, ethers } from "ethers";
import {
  GEN8_FIRST_BUY_MAX,
  GEN8_RATES,
  GEN8_REVERTS,
  GEN8_TARGET_DEFAULT_USD,
  GEN8_TARGET_FAST_USD,
  GEN8_TARGET_TEST_USD,
  GEN8_TEST_TARGET_CHAIN_IDS,
  GEN8_TOTAL_SUPPLY,
  gen8FeeRate,
  gen8FirstBuyEstimate,
  gen8PoolId,
  gen8PoolKey,
  gen8RevertReason,
  gen8VenueFor,
  GEN8_VENUE_BARKSWAP,
  sqrtAtTick,
} from "../../shared/evmGen8.mjs";
import {
  GEN8_REFERRER_APP,
  GEN8_SWAP_DEADLINE_SECONDS,
  PERMIT2_ABI,
  PERMIT2_ADDRESS,
  V4_QUOTER_ABI,
  assertGen8NativeRefund,
  buildGen8RouterCall,
  decodeGen8RouterCall,
  gen8BuyFeeSplit,
  gen8CreatorShareWei,
  gen8HookData,
  gen8MinOut,
  gen8PermitTypedData,
  gen8PriceImpactBps,
  gen8QuoterFor,
  gen8ReferenceAmount,
  gen8RouterFor,
  gen8SellFeeSplit,
  gen8SizedSlippageBps,
} from "../../shared/evmGen8Swap.mjs";
import { gasWithHeadroom, legacyGasPriceFor } from "./evmGasHeadroom.mjs";
import {
  BARK_CHOICE_VAULT_APP_ABI,
  BARK_LAUNCHER_APP_ABI,
  BARK_RESERVE_LOCK_APP_ABI,
  assertBarkCreateAuthorization,
  barkFirstBuyOnPlan,
  barkMaxSellable,
  barkswapPeripheryFor,
  buildBarkTradeCall,
  parseBarkLaunch,
  quoteBarkTrade,
  readBarkFeeBps,
  readBarkLaunchPlan,
  readBarkPoolRecord,
} from "./barkswapSwap.mjs";
import { DOGEOS_DEX_LABEL } from "./dogeosPresentation.mjs";

export const GEN8_DEFAULT_SLIPPAGE_BPS = 100;
/** Pass as slippageBps for the chain's default: sized from the price impact on BNB Chain (F13), 1% elsewhere. */
export const GEN8_AUTO_SLIPPAGE = "auto";
/** MAX first buy stays this far under the 70% cap, so a small oracle move between quote and launch cannot revert it. */
export const GEN8_FIRST_BUY_MAX_HEADROOM_BPS = 50n;

export const GEN8_LAUNCHER_ABI = Object.freeze([
  "function launch((string name,string symbol,string logoURI,string xAccount,string website,string extraLink,bytes32 metadataHash,uint256 targetUsd,uint8 feeChoice,uint8 feeCreatorPct,uint256 firstBuyValue,uint256 minFirstBuyOut,uint256 salt,uint64 openAt) req, (uint64 deadline, bytes signature) auth) payable returns (address token, bytes32 id, uint256 firstBuyOut)",
  "function plan(uint256 targetUsdWad) view returns (uint256 mc, uint256 vN, uint256 vT, int24 tickStart, int24 tickGrad)",
  "function createPaused() view returns (bool)",
  "function hook() view returns (address)",
  "event Launched(address indexed token, bytes32 indexed id, address indexed creator, address hookCreator, uint256 targetUsd, uint256 marketCapNative, uint256 virtualNative, uint256 virtualToken, int24 tickStart, int24 tickGrad, uint8 feeChoice, uint8 feeCreatorPct, uint256 firstBuyIn, uint256 firstBuyOut, uint40 openAt)",
  "error AuthorizationExpired()",
  "error AuthorizationReplayed()",
  "error InvalidAuthorization()",
  "error CreatePaused()",
  "error FirstBuyTooLarge()",
  "error FirstBuyTooSmall()",
  "error FirstBuyValueMismatch()",
  "error OraclePriceOutOfBand()",
  "error OraclePriceUnavailable()",
  "error UnsupportedGraduationTarget()",
  "error TargetOutOfRangeAtPrice()",
  "error OpenAtTooFar()",
]);
export const GEN8_HOOK_ABI = Object.freeze([
  "function claimCreator(bytes32 id, address to) returns (uint256 amount)",
  "function proposeCreator(bytes32 id, address next)",
  "function acceptCreator(bytes32 id)",
  "function creatorOwed(bytes32 id) view returns (uint256)",
  "function pendingCreator(bytes32 id) view returns (address)",
  "function pools(bytes32) view returns (address creator, uint40 openAt, bool graduated, int24 tickGrad, int24 tickStart, uint128 liqA, uint128 liqB, uint160 sqrtGrad, tuple(uint16 bondingBps, uint16 postBps, uint16 creatorPostBps, uint16 sniperStartBps, uint16 creatorBondingBps) fees, uint40 graduatedAt)",
  "event Graduated(bytes32 indexed id, uint256 gradFeeNative, uint256 nativeInA, uint128 liquidityRemoved)",
  "event HookFee(bytes32 indexed id, address indexed swapSender, address indexed referrer, bool buy, bool graduated, uint256 curveAmount, uint256 fee, uint256 feeBps, uint256 creatorShare)",
  "error NotCreator()",
  "error NotPendingCreator()",
  "error NothingOwed()",
  "error TradingNotOpen()",
  "error PriceAboveStart()",
  "error BadOpenAt()",
  "error UnknownPool()",
]);
export const GEN8_LENS_ABI = Object.freeze([
  "function currentFeeBps(bytes32 id, address sender) view returns (uint256)",
  "function previewFill(bytes32 id, bool zeroForOne, int256 amountSpecified, uint160 limit) view returns (uint256)",
  "function grossForNet(uint256 net, uint256 rate) pure returns (uint256)",
  "function progress(bytes32 id) view returns (tuple(bool graduated, bool postPhase, uint40 graduatedAt, uint160 sqrtPriceX96, uint256 coinsSoldFromA, uint256 coinsInA, uint256 nativeInA, uint256 nativeTargetA))",
  "function tradingOpen(bytes32 id) view returns (bool open, uint256 openAt)",
]);
export const GEN8_CHOICE_VAULT_ABI = Object.freeze([
  "function pull(bytes32 id) returns (uint256 amount)",
  "function claimCreatorFees(bytes32 id, address to) returns (uint256 amount)",
  "function proposeCreator(bytes32 id, address next)",
  "function acceptCreator(bytes32 id)",
  "function creatorBalance(bytes32) view returns (uint256)",
  "function creatorOf(bytes32 id) view returns (address)",
  "error NotCreator()",
  "error NotPendingCreator()",
  "error NothingToClaim()",
  "error WrongChoice()",
]);
export const GEN8_RESERVE_LOCK_ABI = Object.freeze([
  "function release(bytes32 id) returns (uint256 amount)",
  "function reserves(bytes32) view returns (address token, uint96 amount)",
  "error NotGraduated()",
  "error NothingLocked()",
  "error ReserveTooEarly()",
  "error PriceBelowGraduation()",
  "error PoolManagerUnlocked()",
]);
export const GEN8_ESCROW_ABI = Object.freeze([
  "function buy(address token, uint256 minOut) payable returns (uint256 coinsOut, uint256 spent)",
  "function claim(address token) returns (uint256 amount)",
  "function claimable(address token, address beneficiary) view returns (uint256)",
  "event EscrowBuy(bytes32 indexed id, address indexed token, address indexed beneficiary, uint256 nativeSpent, uint256 coinsEscrowed)",
  "error Slippage()",
  "error NothingToClaim()",
]);
const ERC20_ABI = Object.freeze([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
]);

// ------------------------------------------------------------------ config

function moduleEnv() {
  let vite = {};
  try {
    vite = import.meta.env || {};
  } catch {
    vite = {};
  }
  const node = typeof process !== "undefined" && process?.env ? process.env : {};
  return { ...node, ...vite };
}

function envAddress(env, name) {
  const raw = String(env?.[`VITE_${name}`] ?? env?.[name] ?? "").trim().split("@")[0].trim();
  return /^0x[0-9a-fA-F]{40}$/.test(raw) && !/^0x0{40}$/i.test(raw) ? ethers.getAddress(raw) : null;
}

/**
 * The chain's gen-8 setup in the app, or null when the hook is not configured (no gen-8 trades or claims there).
 * `launcher` null = trading works, launches stay on the chain's current generation.
 */
export function gen8AppConfig(chainId, env = moduleEnv()) {
  const id = Number(chainId);
  if (gen8VenueFor(id) === GEN8_VENUE_BARKSWAP) return barkAppConfig(id, env);
  const hook = envAddress(env, `EVM_GEN8_HOOK_${id}`);
  if (!hook) return null;
  return {
    chainId: id,
    hook,
    launcher: envAddress(env, `EVM_GEN8_LAUNCHER_${id}`),
    lens: envAddress(env, `EVM_GEN8_LENS_${id}`),
    escrow: envAddress(env, `EVM_GEN8_ESCROW_${id}`),
    choiceVault: envAddress(env, `EVM_GEN8_CHOICE_VAULT_${id}`),
    reserveLock: envAddress(env, `EVM_GEN8_RESERVE_LOCK_${id}`),
    router: gen8RouterFor(id, env),
    quoter: gen8QuoterFor(id, env),
  };
}

const V4_ONLY_ENV = ["EVM_GEN8_HOOK", "EVM_GEN8_POOL_MANAGER", "EVM_GEN8_UNIVERSAL_ROUTER", "EVM_GEN8_V4_QUOTER"];

/**
 * A Barkswap chain's app config (see the header), or null: launcher and plugin both required; any Uniswap V4 setting
 * on the chain disables it. `router` / `quoter` / `wNative` are Barkswap's; a malformed override leaves the router or
 * quoter null, so the panel shows "not set up" instead of trading anywhere else. No `hook`: Bark coins are keyed by
 * their address.
 */
function barkAppConfig(id, env) {
  if (V4_ONLY_ENV.some((base) => String(env?.[`VITE_${base}_${id}`] ?? env?.[`${base}_${id}`] ?? "").trim())) return null;
  const launcher = envAddress(env, `EVM_GEN8_LAUNCHER_${id}`);
  const plugin = envAddress(env, `EVM_GEN8_PLUGIN_${id}`);
  if (!launcher || !plugin) return null;
  const periphery = barkswapPeripheryFor(id, env);
  const tradable = Boolean(periphery?.router && periphery?.wNative);
  return {
    chainId: id,
    venue: GEN8_VENUE_BARKSWAP,
    hook: null,
    plugin,
    launcher,
    lens: envAddress(env, `EVM_GEN8_LENS_${id}`),
    escrow: envAddress(env, `EVM_GEN8_ESCROW_${id}`),
    choiceVault: envAddress(env, `EVM_GEN8_CHOICE_VAULT_${id}`),
    reserveLock: envAddress(env, `EVM_GEN8_RESERVE_LOCK_${id}`),
    router: tradable ? { address: periphery.router, layout: GEN8_VENUE_BARKSWAP, label: `${DOGEOS_DEX_LABEL} SwapRouter` } : null,
    quoter: periphery?.quoter || null,
    wNative: periphery?.wNative || null,
  };
}

/** True for an app config on the Barkswap venue (gen8AppConfig of a Barkswap chain). */
export function isGen8BarkAppConfig(cfg) {
  return cfg?.venue === GEN8_VENUE_BARKSWAP;
}

/** The DEX the coin's pool lives in, for the panels' words: "Barkswap" on DogeOS, "Uniswap" on the V4 chains. */
export function gen8PoolVenueLabel(cfgOrChainId) {
  const bark = typeof cfgOrChainId === "object" && cfgOrChainId ? isGen8BarkAppConfig(cfgOrChainId) : gen8VenueFor(cfgOrChainId) === GEN8_VENUE_BARKSWAP;
  return bark ? DOGEOS_DEX_LABEL : "Uniswap";
}

/** The launcher the create page uses on this chain, or null (launches stay on the chain's current generation). */
export function gen8LauncherFor(chainId, env = moduleEnv()) {
  const cfg = gen8AppConfig(chainId, env);
  return cfg?.launcher || null;
}

/** True when an API campaign item or coin state says generation 8. */
export function isGen8Coin(item) {
  if (!item) return false;
  if (Number(item.generation) === 8) return true;
  if (Number(item.generation?.factoryGeneration) === 8) return true;
  return String(item.tradePath || item.gen8?.tradePath || "") === "gen8_pool";
}

/**
 * The API's answer for a coin must name the hook this app trades with; a different hook would be a different pool.
 * Throws the sentence the panel shows.
 */
export function assertGen8HookMatches(cfg, apiHook) {
  if (!cfg) throw new Error("Trading for this coin is not set up in this app yet.");
  if (apiHook && ethers.getAddress(apiHook) !== cfg.hook) throw new Error("This coin's pool does not match the app's setup. Trading is paused for it.");
}

/**
 * assertGen8HookMatches for either venue, from the API's `gen8` block: on Barkswap the coin's state must name this
 * app's plugin and launcher and no hook (a V4 answer for a DogeOS coin, or another plugin, is a different pool).
 */
export function assertGen8PoolMatches(cfg, gen8) {
  if (!isGen8BarkAppConfig(cfg)) return assertGen8HookMatches(cfg, gen8?.hook);
  const mismatch = () => new Error("This coin's pool does not match the app's setup. Trading is paused for it.");
  if (gen8?.venue && gen8.venue !== GEN8_VENUE_BARKSWAP) throw mismatch();
  if (gen8?.hook) throw mismatch();
  if (gen8?.plugin && ethers.getAddress(gen8.plugin) !== cfg.plugin) throw mismatch();
  if (gen8?.launcher && ethers.getAddress(gen8.launcher) !== cfg.launcher) throw mismatch();
}

// ------------------------------------------------------------------ create (6.1)

/** The create page's graduation choices for a gen-8 launcher ($150 on testnets with the test tier on). */
export function gen8GraduationTiers(chainId, { testTierEnabled = false } = {}) {
  const venue = gen8PoolVenueLabel(chainId);
  const tiers = [
    { id: "fast", label: "$30K MC", title: "Fast grad", description: `Graduates when the market cap reaches $30K. It keeps trading in the same ${venue} pool.`, targetWei: GEN8_TARGET_FAST_USD },
    { id: "normal", label: "$50K MC", title: "Normal", description: `Graduates when the market cap reaches $50K. It keeps trading in the same ${venue} pool.`, targetWei: GEN8_TARGET_DEFAULT_USD },
  ];
  if (testTierEnabled && GEN8_TEST_TARGET_CHAIN_IDS.includes(Number(chainId))) {
    tiers.unshift({ id: "test", label: "$150", title: "Testnet rehearsal", description: "Testnet only: graduates at a $150 market cap.", targetWei: GEN8_TARGET_TEST_USD, testOnly: true });
  }
  return tiers;
}

export const GEN8_DEFAULT_GRADUATION_TARGET_WEI = GEN8_TARGET_DEFAULT_USD;

/**
 * launcher.plan(target): the curve the launcher would size in this block. Throws when the oracle cannot size it. On a
 * Barkswap chain (chainId) MwzBarkLauncher.plan, whose plan also carries liqA / liqB and `venue: "barkswap"`.
 */
export async function readGen8LaunchPlan({ provider, launcher, targetUsd, chainId = null }) {
  if (chainId != null && gen8VenueFor(chainId) === GEN8_VENUE_BARKSWAP) return readBarkLaunchPlan({ provider, launcher, targetUsd });
  const c = new Contract(launcher, GEN8_LAUNCHER_ABI, provider);
  const p = await c.plan(BigInt(targetUsd));
  return { marketCapNative: BigInt(p[0]), virtualNative: BigInt(p[1]), virtualToken: BigInt(p[2]), tickStart: Number(p[3]), tickGrad: Number(p[4]) };
}

/** The launch's own first-buy swap replayed on `plan`: V4 (gen8FirstBuyEstimate), or Algebra for a Barkswap plan. */
function firstBuyEstimateOn(plan, valueWei) {
  if (plan?.venue === GEN8_VENUE_BARKSWAP) return barkFirstBuyOnPlan({ valueWei, plan });
  return gen8FirstBuyEstimate({ valueWei, tickStart: plan.tickStart, tickGrad: plan.tickGrad });
}

/** The first buy at `valueWei` on `plan`: coins out (the launch's V4 swap replayed), fee, supply share, cap check. */
export function gen8FirstBuyPlan({ valueWei, plan }) {
  const value = BigInt(valueWei || 0n);
  const est = firstBuyEstimateOn(plan, value);
  const supplyBps = Number((est.coinsOut * 10_000n) / GEN8_TOTAL_SUPPLY);
  return { valueWei: value, coinsOut: est.coinsOut, feeWei: est.feeWei, curveWei: est.costWei, supplyBps, exceedsCap: value > 0n && est.overCap };
}

/**
 * MAX: the largest native value whose first buy stays under the 70% cap less GEN8_FIRST_BUY_MAX_HEADROOM_BPS
 * (binary search on the exact swap replay; about 70 steps).
 */
export function gen8MaxFirstBuyValue({ plan, headroomBps = GEN8_FIRST_BUY_MAX_HEADROOM_BPS }) {
  const capCoins = (GEN8_FIRST_BUY_MAX * (10_000n - BigInt(headroomBps))) / 10_000n;
  let lo = 0n;
  let hi = 10n ** 30n;
  // hi must be over the cap: A's whole native capacity bounds it well below 1e30 wei.
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    const est = firstBuyEstimateOn(plan, mid);
    if (!est.overCap && est.coinsOut <= capCoins) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

/** Balance check before the wallet opens: first buy + gas reserve must fit. Returns the max first buy that fits. */
export function gen8MaxFirstBuyByBalance({ balanceWei, gasReserveWei }) {
  const left = BigInt(balanceWei) - BigInt(gasReserveWei);
  return left > 0n ? left : 0n;
}

/** The campaignRequest body of POST /api/routing/create-authorization for a gen-8 launcher. openAt 0 = trading opens at launch. */
export function gen8CreateAuthorizationBody({ chainId, walletAddress, launcher, name, symbol, logoURI, xAccount = "", website = "", extraLink = "", description = "", targetUsd, feeChoice, feeCreatorPct = 0, firstBuyValueWei = 0n, firstBuySlippageBps = 300, openAt = 0 }) {
  return {
    walletAddress,
    chainId: Number(chainId),
    factoryAddress: launcher,
    generation: 8,
    campaignRequest: {
      name,
      symbol,
      logoURI,
      xAccount,
      website,
      extraLink,
      description,
      graduationTarget: BigInt(targetUsd).toString(),
      feeChoice,
      feeCreatorPct: feeChoice === "split" || Number(feeChoice) === 3 ? Number(feeCreatorPct) : 0,
      firstBuyValue: BigInt(firstBuyValueWei).toString(),
      firstBuySlippageBps,
      openAt: BigInt(openAt ?? 0).toString(),
    },
  };
}

/**
 * Checks the API's create authorization against what the app asked for and its own config, then returns the exact
 * launch() arguments (values as returned; msg.value = launchRequest.firstBuyValue).
 */
export function gen8LaunchArgs(auth, { chainId, launcher, firstBuyValueWei = null }) {
  if (!auth?.authorization?.signature || !auth?.launchRequest) throw new Error("The create authorization is incomplete.");
  if (Number(auth.chainId) !== Number(chainId)) throw new Error("The create authorization is for another chain.");
  if (!launcher || ethers.getAddress(auth.launcher) !== ethers.getAddress(launcher)) throw new Error("The create authorization names another launcher.");
  const r = auth.launchRequest;
  if (firstBuyValueWei != null && BigInt(r.firstBuyValue) !== BigInt(firstBuyValueWei)) throw new Error("The first buy in the authorization differs from yours. Try again.");
  const req = [r.name, r.symbol, r.logoURI, r.xAccount, r.website, r.extraLink, r.metadataHash, BigInt(r.targetUsd), Number(r.feeChoice), Number(r.feeCreatorPct), BigInt(r.firstBuyValue), BigInt(r.minFirstBuyOut), BigInt(r.salt), BigInt(r.openAt ?? 0)];
  const authTuple = [BigInt(auth.authorization.deadline), auth.authorization.signature];
  return { req, auth: authTuple, value: BigInt(r.firstBuyValue) };
}

/** The coin a launch created, from its Launched event (and the pool id). */
export function parseGen8Launch(receipt, launcher) {
  const iface = new ethers.Interface(GEN8_LAUNCHER_ABI);
  for (const log of receipt?.logs || []) {
    if (launcher && String(log.address).toLowerCase() !== String(launcher).toLowerCase()) continue;
    try {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name !== "Launched") continue;
      return {
        token: ethers.getAddress(parsed.args.token),
        poolId: String(parsed.args.id).toLowerCase(),
        creator: ethers.getAddress(parsed.args.creator),
        hookCreator: ethers.getAddress(parsed.args.hookCreator),
        firstBuyIn: BigInt(parsed.args.firstBuyIn),
        firstBuyOut: BigInt(parsed.args.firstBuyOut),
        tickStart: Number(parsed.args.tickStart),
        tickGrad: Number(parsed.args.tickGrad),
      };
    } catch {
      // other contracts' logs in the same transaction
    }
  }
  return null;
}

/** Legacy-priced gas overrides as every EVM write in the app sends them (Robinhood: price headroom, PR #563). */
export async function gen8GasOverrides(provider, chainId) {
  try {
    const hex = await provider.send("eth_gasPrice", []);
    const price = legacyGasPriceFor(Number(chainId), BigInt(hex));
    return price > 0n ? { gasPrice: price, type: 0 } : {};
  } catch {
    return {};
  }
}

/**
 * Sends a contract call with the app's gas rules: estimate + 25% + 50,000 (gasWithHeadroom), legacy gas price with the
 * Robinhood headroom. Waits for the receipt and throws on a revert.
 */
export async function sendGen8Call({ signer, chainId, contract, method, args = [], value = 0n, floor = null }) {
  const provider = signer.provider;
  const overrides = { ...(await gen8GasOverrides(provider, chainId)), ...(value > 0n ? { value } : {}) };
  const gasLimit = await gasWithHeadroom(() => contract.getFunction(method).estimateGas(...args, overrides), floor);
  const tx = await contract.getFunction(method)(...args, { ...overrides, ...(gasLimit ? { gasLimit } : {}) });
  const receipt = await tx.wait();
  if (!receipt || Number(receipt.status) !== 1) throw new Error("The transaction reverted.");
  return receipt;
}

/** Sends a raw { to, data, value } with the same gas rules. */
export async function sendGen8Tx({ signer, chainId, tx, floor = null }) {
  const provider = signer.provider;
  const overrides = await gen8GasOverrides(provider, chainId);
  const req = { to: tx.to, data: tx.data, value: BigInt(tx.value || 0n), ...overrides };
  const gasLimit = await gasWithHeadroom(() => signer.estimateGas(req), floor);
  const sent = await signer.sendTransaction({ ...req, ...(gasLimit ? { gasLimit } : {}) });
  const receipt = await sent.wait();
  if (!receipt || Number(receipt.status) !== 1) throw new Error("The transaction reverted.");
  return receipt;
}

/** launcher.launch(...) exactly as authorized; returns { receipt, launched }. */
export async function launchGen8Coin({ signer, chainId, launcher, authorization, firstBuyValueWei = null, cfg = null }) {
  if (gen8VenueFor(chainId) === GEN8_VENUE_BARKSWAP) return launchBarkCoin({ signer, chainId, launcher, authorization, firstBuyValueWei, cfg: cfg || gen8AppConfig(chainId) });
  const args = gen8LaunchArgs(authorization, { chainId, launcher, firstBuyValueWei });
  const c = new Contract(launcher, GEN8_LAUNCHER_ABI, signer);
  // Launch measured at 1.67M gas on BSC and 1.10M on Robinhood (design 1): the floor keeps a failed estimate from
  // leaving the limit to a wallet default that is too low.
  const receipt = await sendGen8Call({ signer, chainId, contract: c, method: "launch", args: [args.req, args.auth], value: args.value, floor: 2_500_000n });
  const launched = parseGen8Launch(receipt, launcher);
  if (!launched) throw new Error("The launch landed but its coin could not be read from the receipt.");
  return { receipt, launched };
}

/**
 * The Barkswap create answer as launch() arguments: gen8LaunchArgs' checks (chain, launcher, first buy) plus the Bark
 * ones (venue, our plugin, a coin that sorts below WDOGE). MwzBarkLauncher.launch takes gen-8's request and auth.
 */
export function barkLaunchArgs(auth, { chainId, cfg, firstBuyValueWei = null }) {
  if (!isGen8BarkAppConfig(cfg)) throw new Error("Launches on Barkswap are not set up in this app yet.");
  const args = gen8LaunchArgs(auth, { chainId, launcher: cfg.launcher, firstBuyValueWei });
  return { ...args, coin: assertBarkCreateAuthorization(auth, cfg) };
}

// The worst Bark launch measured 6,293,026 gas on the Chikyu fork (t8: buyback choice + first buy; gate 7M).
const BARK_LAUNCH_GAS_FLOOR = 7_000_000n;
const BARK_LAUNCHER_IFACE = new ethers.Interface(BARK_LAUNCHER_APP_ABI);

/** MwzBarkLauncher.launch(...) exactly as authorized (Barkswap venue of launchGen8Coin); returns { receipt, launched }. */
async function launchBarkCoin({ signer, chainId, launcher, authorization, firstBuyValueWei, cfg }) {
  if (!isGen8BarkAppConfig(cfg) || !launcher || ethers.getAddress(launcher) !== cfg.launcher) throw new Error("The create authorization names another launcher.");
  const args = barkLaunchArgs(authorization, { chainId, cfg, firstBuyValueWei });
  const data = BARK_LAUNCHER_IFACE.encodeFunctionData("launch", [args.req, args.auth]);
  const receipt = await sendGen8Tx({ signer, chainId, tx: { to: cfg.launcher, data, value: args.value }, floor: BARK_LAUNCH_GAS_FLOOR });
  const launched = parseBarkLaunch(receipt, cfg.launcher);
  if (!launched) throw new Error("The launch landed but its coin could not be read from the receipt.");
  return { receipt, launched };
}

// ------------------------------------------------------------------ trade panel (6.2)

/** The rate a swap through `sender` (the router, or the escrow) pays now: the lens, else the gen-7 formula from the hook. */
export async function readGen8FeeBps({ provider, cfg, poolId, sender }) {
  // Barkswap: keyed by the coin (pass it as poolId), MwzBarkLaunchLens.currentFeeBps(coin, sender).
  if (isGen8BarkAppConfig(cfg)) return readBarkFeeBps({ provider, cfg, coin: poolId, sender });
  if (cfg.lens) {
    const lens = new Contract(cfg.lens, GEN8_LENS_ABI, provider);
    return Number(await lens.currentFeeBps(poolId, sender));
  }
  const hook = new Contract(cfg.hook, GEN8_HOOK_ABI, provider);
  const [p, block] = await Promise.all([hook.pools(poolId), provider.getBlock("latest")]);
  const f = p.fees;
  const openAt = Number(p.openAt);
  return gen8FeeRate({
    graduated: Boolean(p.graduated),
    openAt,
    nowTs: Number(block.timestamp),
    fees: { bondingBps: Number(f.bondingBps ?? f[0]), postBps: Number(f.postBps ?? f[1]), sniperStartBps: Number(f.sniperStartBps ?? f[3]) },
  });
}

/** Reads the hook's record of the coin's pool (graduated flag and fee config), or null for a token that is not gen-8. */
export async function readGen8PoolRecord({ provider, cfg, token }) {
  // Barkswap: the launcher's and the plugin's record of the coin (poolId null, `pool` = its Algebra pool).
  if (isGen8BarkAppConfig(cfg)) return readBarkPoolRecord({ provider, cfg, token });
  const poolId = gen8PoolId(token, cfg.hook);
  const hook = new Contract(cfg.hook, GEN8_HOOK_ABI, provider);
  const p = await hook.pools(poolId);
  const creator = p.creator;
  if (!creator || creator === ethers.ZeroAddress) return null;
  const f = p.fees;
  const openAt = Number(p.openAt);
  const graduatedAt = Number(p.graduatedAt);
  return {
    poolId,
    poolKey: gen8PoolKey(token, cfg.hook),
    creator: ethers.getAddress(creator),
    openAt,
    launchTime: openAt,
    graduated: Boolean(p.graduated),
    graduatedAt: graduatedAt > 0 ? graduatedAt : null,
    tickGrad: Number(p.tickGrad),
    tickStart: Number(p.tickStart),
    fees: {
      bondingBps: Number(f.bondingBps ?? f[0]),
      postBps: Number(f.postBps ?? f[1]),
      creatorPostBps: Number(f.creatorPostBps ?? f[2]),
      sniperStartBps: Number(f.sniperStartBps ?? f[3]),
      creatorBondingBps: Number(f.creatorBondingBps ?? f[4]),
    },
  };
}

function quoterKey(poolKey) {
  return [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks];
}

/**
 * Exact-input quote in the coin's pool through Uniswap's V4Quoter (proven equal to execution on the forks), with the
 * fee split for the panel. side "buy": amountIn native; "sell": amountIn coins.
 * The price impact comes from a second quote of 1/1000 of the amount in the same block (gen8PriceImpactBps; null when
 * that reference cannot be quoted). slippageBps GEN8_AUTO_SLIPPAGE = the chain's default (gen8SizedSlippageBps).
 * Returns { side, amountIn, amountOut, minOut, slippageBps, slippageAuto, priceImpactBps, feeBps, feeWei, curveWei,
 * creatorShareWei, graduated, poolId, poolKey }.
 */
export async function quoteGen8Trade({ provider, cfg, token, side, amountIn, slippageBps = GEN8_DEFAULT_SLIPPAGE_BPS, sender = null, record = null }) {
  // Barkswap: QuoterV2 with deployer = our launcher; a sell is limited at the start price (barkswapSwap.mjs).
  if (isGen8BarkAppConfig(cfg)) return quoteBarkTrade({ provider, cfg, token, side, amountIn, slippageBps, sender, record });
  if (!cfg?.quoter) throw new Error("No Uniswap quoter is configured for this chain.");
  const amount = BigInt(amountIn);
  if (amount <= 0n) throw new Error("Enter an amount.");
  const pool = record || (await readGen8PoolRecord({ provider, cfg, token }));
  if (!pool) throw new Error("This token has no MemeWarzone pool on this chain.");
  const now = Number((await provider.getBlock("latest")).timestamp);
  if (now < Number(pool.openAt || 0)) throw new Error(GEN8_REVERTS["0xe09f0331"].message);
  if (side === "sell" && cfg.lens) {
    const maxSellable = await gen8MaxSellable({ provider, cfg, poolId: pool.poolId, tickStart: pool.tickStart });
    if (amount > maxSellable) throw new Error(GEN8_REVERTS["0x2fcb916e"].message);
  }
  const swapSender = sender || cfg.router?.address;
  const quoter = new Contract(cfg.quoter, V4_QUOTER_ABI, provider);
  const refIn = gen8ReferenceAmount(amount);
  const [feeBps, quoted, refQuoted] = await Promise.all([
    readGen8FeeBps({ provider, cfg, poolId: pool.poolId, sender: swapSender }),
    quoter.quoteExactInputSingle.staticCall([quoterKey(pool.poolKey), side === "buy", amount, gen8HookData(GEN8_REFERRER_APP)]),
    refIn == null ? null : quoter.quoteExactInputSingle.staticCall([quoterKey(pool.poolKey), side === "buy", refIn, gen8HookData(GEN8_REFERRER_APP)]).catch(() => null),
  ]);
  const amountOut = BigInt(quoted[0] ?? quoted.amountOut);
  const refOut = refQuoted ? BigInt(refQuoted[0] ?? refQuoted.amountOut) : null;
  const priceImpactBps = gen8PriceImpactBps({ amountIn: amount, amountOut, refIn, refOut });
  const slippageAuto = slippageBps === GEN8_AUTO_SLIPPAGE;
  const slippage = slippageAuto ? gen8SizedSlippageBps({ chainId: cfg.chainId, priceImpactBps }) : Number(slippageBps);
  const split = side === "buy" ? gen8BuyFeeSplit(amount, feeBps) : gen8SellFeeSplit(amountOut, feeBps);
  return {
    side,
    amountIn: amount,
    amountOut,
    minOut: gen8MinOut(amountOut, slippage),
    slippageBps: slippage,
    slippageAuto,
    priceImpactBps,
    feeBps,
    feeWei: split.feeWei,
    curveWei: split.curveWei,
    creatorShareWei: gen8CreatorShareWei({ graduated: pool.graduated, curveWei: split.curveWei, feeWei: split.feeWei, creatorBondingBps: pool.fees.creatorBondingBps, creatorPostBps: pool.fees.creatorPostBps }),
    graduated: pool.graduated,
    poolId: pool.poolId,
    poolKey: pool.poolKey,
  };
}

/**
 * Exact fill of a price-limited swap (MwzLaunchLens.previewFill; V4Quoter has no price limit). For callers that swap
 * with a limit directly against the PoolManager; UniversalRouter V4 swaps carry none. Exact-input buy: pass the curve
 * part (gen8BuyFeeSplit) as a negative amount; exact-output sell: the gross payout as a positive amount.
 */
export async function previewGen8Fill({ provider, cfg, poolId, zeroForOne, amountSpecified, sqrtPriceLimitX96 }) {
  if (!cfg?.lens) throw new Error("No gen-8 lens is configured for this chain.");
  return BigInt(await new Contract(cfg.lens, GEN8_LENS_ABI, provider).previewFill(poolId, zeroForOne, BigInt(amountSpecified), BigInt(sqrtPriceLimitX96)));
}

/**
 * Coins the pool will take back on an exact-input sell before the price would pass the start tick (F2 PriceAboveStart).
 * UniversalRouter V4 swaps carry no price limit, so the app clamps MAX and refuses a larger sell.
 */
export async function gen8MaxSellable({ provider, cfg, poolId, tickStart, token = null }) {
  // Barkswap: from the lens's progress (previewFill does not exist there); null = no cap (the sell's limit cuts it).
  if (isGen8BarkAppConfig(cfg)) return barkMaxSellable({ provider, cfg, coin: token || poolId });
  if (tickStart == null || !Number.isFinite(Number(tickStart))) return 0n;
  return previewGen8Fill({
    provider,
    cfg,
    poolId,
    zeroForOne: false,
    amountSpecified: -GEN8_TOTAL_SUPPLY,
    sqrtPriceLimitX96: sqrtAtTick(Number(tickStart)),
  });
}

/** The UniversalRouter call for a quoted trade (exact input). */
export function buildGen8TradeCall({ cfg, quote, deadline, permit = null, referrer = GEN8_REFERRER_APP }) {
  if (!cfg?.router) throw new Error("No Uniswap router is configured for this chain.");
  const call = buildGen8RouterCall({
    router: cfg.router.address,
    layout: cfg.router.layout,
    poolKey: quote.poolKey,
    side: quote.side,
    exactIn: true,
    amount: quote.amountIn,
    limit: quote.minOut,
    deadline,
    hookData: gen8HookData(referrer),
    permit,
  });
  // F14: no native buy may leave unspent native in the router.
  assertGen8NativeRefund(decodeGen8RouterCall(call.data, cfg.router.layout));
  return call;
}

/**
 * Sells pull the coin through Permit2: an exact ERC20 approval to Permit2 when the current one is short (one
 * transaction), then a signed permit for exactly this sell to the router, valid 30 minutes (no transaction).
 */
export async function prepareGen8SellPermit({ signer, chainId, token, amountIn, router, nowSec = null }) {
  const owner = await signer.getAddress();
  const erc20 = new Contract(token, ERC20_ABI, signer);
  if (BigInt(await erc20.allowance(owner, PERMIT2_ADDRESS)) < BigInt(amountIn)) {
    await sendGen8Call({ signer, chainId, contract: erc20, method: "approve", args: [PERMIT2_ADDRESS, BigInt(amountIn)] });
  }
  const permit2 = new Contract(PERMIT2_ADDRESS, PERMIT2_ABI, signer);
  const [, , nonce] = await permit2.allowance(owner, token, router);
  const now = nowSec ?? Number((await signer.provider.getBlock("latest")).timestamp);
  const typed = gen8PermitTypedData({ chainId, token, amount: amountIn, nonce, spender: router, nowSec: now });
  const signature = await signer.signTypedData(typed.domain, typed.types, typed.message);
  return { permitSingle: typed.message, signature };
}

/**
 * One trade in the coin's pool from the app: re-quotes, then (sell) the Permit2 steps, then the router call with gas
 * headroom. Returns { receipt, quote, call }.
 */
export async function executeGen8Trade({ signer, chainId, cfg, token, side, amountIn, slippageBps = GEN8_DEFAULT_SLIPPAGE_BPS, readProvider = null, quote = null }) {
  if (isGen8BarkAppConfig(cfg)) return executeBarkTrade({ signer, chainId, cfg, token, side, amountIn, slippageBps, readProvider, quote });
  const reads = readProvider || signer.provider;
  const q = quote || (await quoteGen8Trade({ provider: reads, cfg, token, side, amountIn, slippageBps }));
  const now = Number((await reads.getBlock("latest")).timestamp);
  const permit = side === "sell" ? await prepareGen8SellPermit({ signer, chainId, token, amountIn: q.amountIn, router: cfg.router.address, nowSec: now }) : null;
  const call = buildGen8TradeCall({ cfg, quote: q, deadline: BigInt(now + GEN8_SWAP_DEADLINE_SECONDS), permit });
  const receipt = await sendGen8Tx({ signer, chainId, tx: call, floor: 400_000n });
  return { receipt, quote: q, call };
}

// A Bark trade can cross graduation and take the 2% graduation fee inline (MwzBarkPlugin afterSwap calls the
// launcher), more than a plain swap; the floor keeps a failed estimate from leaving the limit to a wallet default.
const BARK_TRADE_GAS_FLOOR = 1_000_000n;
const ERC20_IFACE = new ethers.Interface(ERC20_ABI);

/** One Bark contract call sent as a raw transaction with the gen-8 gas rules (sendGen8Tx). */
async function sendBarkCall({ signer, chainId, to, abi, method, args = [], value = 0n, floor = null }) {
  const data = new ethers.Interface(abi).encodeFunctionData(method, args);
  return sendGen8Tx({ signer, chainId, tx: { to, data, value }, floor });
}

/**
 * executeGen8Trade on Barkswap: re-quotes, approves Barkswap's router for exactly this sell when the allowance is short
 * (one transaction), then the router call built from the quote (barkswapSwap.mjs buildBarkTradeCall).
 */
async function executeBarkTrade({ signer, chainId, cfg, token, side, amountIn, slippageBps, readProvider, quote }) {
  const reads = readProvider || signer.provider;
  if (!cfg?.router?.address || !cfg?.quoter) throw new Error("Trading on Barkswap is not set up on this chain yet.");
  const q = quote || (await quoteGen8Trade({ provider: reads, cfg, token, side, amountIn, slippageBps }));
  const account = ethers.getAddress(await signer.getAddress());
  if (side === "sell") {
    const coin = new Contract(q.coin, ERC20_ABI, reads);
    if (BigInt(await coin.allowance(account, cfg.router.address)) < q.amountIn) {
      await sendGen8Tx({ signer, chainId, tx: { to: q.coin, data: ERC20_IFACE.encodeFunctionData("approve", [cfg.router.address, q.amountIn]), value: 0n } });
    }
  }
  const now = Number((await reads.getBlock("latest")).timestamp);
  const call = buildBarkTradeCall({ cfg, quote: q, account, deadline: BigInt(now + GEN8_SWAP_DEADLINE_SECONDS) });
  const receipt = await sendGen8Tx({ signer, chainId, tx: call, floor: BARK_TRADE_GAS_FLOOR });
  return { receipt, quote: q, call };
}

/** The creator's own buy in the app (D5): through MwzCreatorEscrow, coins held on the gen-7 schedule. */
export async function executeGen8EscrowBuy({ signer, chainId, cfg, token, amountIn, slippageBps = GEN8_DEFAULT_SLIPPAGE_BPS, readProvider = null }) {
  if (!cfg?.escrow) throw new Error("Creator buys are not set up on this chain yet.");
  const reads = readProvider || signer.provider;
  const q = await quoteGen8Trade({ provider: reads, cfg, token, side: "buy", amountIn, slippageBps, sender: cfg.escrow });
  if (isGen8BarkAppConfig(cfg)) {
    // MwzBarkCreatorEscrow keeps gen-8's buy(token, minOut) and swaps in the coin's Barkswap pool itself.
    const receipt = await sendBarkCall({ signer, chainId, to: cfg.escrow, abi: GEN8_ESCROW_ABI, method: "buy", args: [ethers.getAddress(token), q.minOut], value: q.amountIn, floor: BARK_TRADE_GAS_FLOOR });
    return { receipt, quote: q };
  }
  const escrow = new Contract(cfg.escrow, GEN8_ESCROW_ABI, signer);
  const receipt = await sendGen8Call({ signer, chainId, contract: escrow, method: "buy", args: [token, q.minOut], value: q.amountIn, floor: 400_000n });
  return { receipt, quote: q };
}

// ------------------------------------------------------------------ creator panel (4)

/** hook.claimCreator(id, to): the whole hook ledger to any address (keep coins; the hook creator only). */
export async function claimGen8HookCreatorFees({ signer, chainId, cfg, poolId, to }) {
  // Barkswap: MwzBarkLauncher.claimCreator(coin, to); `poolId` is the coin there.
  if (isGen8BarkAppConfig(cfg)) return sendBarkCall({ signer, chainId, to: cfg.launcher, abi: BARK_LAUNCHER_APP_ABI, method: "claimCreator", args: [ethers.getAddress(poolId), ethers.getAddress(to)] });
  const hook = new Contract(cfg.hook, GEN8_HOOK_ABI, signer);
  return sendGen8Call({ signer, chainId, contract: hook, method: "claimCreator", args: [poolId, ethers.getAddress(to)] });
}

/** Two-step creator transfer: on the hook for keep coins, in the choice vault for holders / split / buyback coins. */
export async function proposeGen8Creator({ signer, chainId, target, poolId, next }) {
  // Barkswap: the launcher (keep coins) or the Bark choice vault, both keyed by the coin (`poolId`).
  if (gen8VenueFor(chainId) === GEN8_VENUE_BARKSWAP) {
    return sendBarkCall({ signer, chainId, to: target, abi: BARK_CHOICE_VAULT_APP_ABI, method: "proposeCreator", args: [ethers.getAddress(poolId), next ? ethers.getAddress(next) : ethers.ZeroAddress] });
  }
  const c = new Contract(target, ["function proposeCreator(bytes32 id, address next)"], signer);
  return sendGen8Call({ signer, chainId, contract: c, method: "proposeCreator", args: [poolId, next ? ethers.getAddress(next) : ethers.ZeroAddress] });
}

export async function acceptGen8Creator({ signer, chainId, target, poolId }) {
  if (gen8VenueFor(chainId) === GEN8_VENUE_BARKSWAP) return sendBarkCall({ signer, chainId, to: target, abi: BARK_CHOICE_VAULT_APP_ABI, method: "acceptCreator", args: [ethers.getAddress(poolId)] });
  const c = new Contract(target, ["function acceptCreator(bytes32 id)"], signer);
  return sendGen8Call({ signer, chainId, contract: c, method: "acceptCreator", args: [poolId] });
}

/** vault.pull(id): permissionless, moves the hook ledger into the vault and credits it by the coin's fee choice. */
export async function pullGen8VaultFees({ signer, chainId, cfg, poolId }) {
  if (isGen8BarkAppConfig(cfg)) return sendBarkCall({ signer, chainId, to: cfg.choiceVault, abi: BARK_CHOICE_VAULT_APP_ABI, method: "pull", args: [ethers.getAddress(poolId)] });
  const v = new Contract(cfg.choiceVault, GEN8_CHOICE_VAULT_ABI, signer);
  return sendGen8Call({ signer, chainId, contract: v, method: "pull", args: [poolId] });
}

/** vault.claimCreatorFees(id, to): the split coin's creator part, to any address. */
export async function claimGen8VaultCreatorFees({ signer, chainId, cfg, poolId, to }) {
  if (isGen8BarkAppConfig(cfg)) return sendBarkCall({ signer, chainId, to: cfg.choiceVault, abi: BARK_CHOICE_VAULT_APP_ABI, method: "claimCreatorFees", args: [ethers.getAddress(poolId), ethers.getAddress(to)] });
  const v = new Contract(cfg.choiceVault, GEN8_CHOICE_VAULT_ABI, signer);
  return sendGen8Call({ signer, chainId, contract: v, method: "claimCreatorFees", args: [poolId, ethers.getAddress(to)] });
}

/** reserveLock.release(id): permissionless once graduated; pays the coin's current creator. */
export async function releaseGen8Reserve({ signer, chainId, cfg, poolId }) {
  if (isGen8BarkAppConfig(cfg)) return sendBarkCall({ signer, chainId, to: cfg.reserveLock, abi: BARK_RESERVE_LOCK_APP_ABI, method: "release", args: [ethers.getAddress(poolId)] });
  const r = new Contract(cfg.reserveLock, GEN8_RESERVE_LOCK_ABI, signer);
  return sendGen8Call({ signer, chainId, contract: r, method: "release", args: [poolId] });
}

/** escrow.claim(token): what is released of the caller's escrowed buys. */
export async function claimGen8Escrow({ signer, chainId, cfg, token }) {
  if (isGen8BarkAppConfig(cfg)) return sendBarkCall({ signer, chainId, to: cfg.escrow, abi: GEN8_ESCROW_ABI, method: "claim", args: [ethers.getAddress(token)] });
  const e = new Contract(cfg.escrow, GEN8_ESCROW_ABI, signer);
  return sendGen8Call({ signer, chainId, contract: e, method: "claim", args: [token] });
}

// ------------------------------------------------------------------ coin state (API) helpers for the UI

function formatWait(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** "Trading opens at <time>" plus remaining wait; null once openAt has passed. */
export function gen8TradingOpensLine(openAt, nowSec) {
  const open = Number(openAt) || 0;
  const now = Number(nowSec);
  if (!open || now >= open) return null;
  const when = new Date(open * 1000).toLocaleString();
  return { openAt: open, secondsLeft: open - now, line: `Trading opens at ${when}. ${formatWait(open - now)} left.` };
}

/** "Launch fee: X% now, 2% in N s." from the API's tradeFee and the current time; null outside the window. Decay runs from openAt. */
export function gen8AntiSniperCountdown(tradeFee, nowSec) {
  const start = Number(tradeFee?.openAt ?? tradeFee?.launchAt);
  if (!tradeFee || !start) return null;
  const now = Number(nowSec);
  if (now < start) return null;
  const end = Number(tradeFee.antiSniperEndsAt || start + GEN8_RATES.sniperWindowSeconds);
  if (now >= end) return null;
  const bps = gen8FeeRate({
    graduated: false,
    openAt: start,
    nowTs: now,
    fees: { bondingBps: Number(tradeFee.bondingBps ?? 200), postBps: Number(tradeFee.postGraduationBps ?? 100), sniperStartBps: Number(tradeFee.antiSniperStartBps ?? 9000) },
  });
  return { bps, secondsLeft: end - now, line: `Launch fee ${(bps / 100).toFixed(bps % 100 ? 2 : 0)}% now, ${(Number(tradeFee.bondingBps ?? 200) / 100).toFixed(0)}% in ${end - now} s.` };
}

/** The fee line under the trade box: bonding 2% (creator part), after graduation 1% (0.5% to the creator). */
export function gen8FeeLine({ graduated, feeBps }) {
  const pct = (Number(feeBps) / 100).toFixed(Number(feeBps) % 100 ? 2 : 0);
  return graduated ? `Fee ${pct}% on every trade, half of it to the coin's creator.` : `Fee ${pct}% on every trade until graduation.`;
}

// ------------------------------------------------------------------ errors in plain words

const GEN8_ERROR_WORDS = Object.freeze({
  AuthorizationExpired: "The launch approval expired. Press Deploy again.",
  AuthorizationReplayed: "This launch approval was already used. Press Deploy again.",
  InvalidAuthorization: "The launch approval does not match this wallet. Press Deploy again.",
  CreatePaused: "New launches are paused right now. Try again later.",
  FirstBuyTooLarge: "Your first buy is over 70% of the supply at today's price. Lower it or press MAX.",
  FirstBuyTooSmall: "The price moved before the launch landed. Press Deploy again.",
  FirstBuyValueMismatch: "The first buy amount changed. Press Deploy again.",
  OraclePriceOutOfBand: "The price feed is out of range right now. Try again shortly.",
  OraclePriceUnavailable: "The price feed did not answer. Try again shortly.",
  TargetOutOfRangeAtPrice: "This graduation target does not fit today's price. Pick the other one.",
  UnsupportedGraduationTarget: "This graduation target is not available. Pick another one.",
  V4TooLittleReceived: "The price moved more than your slippage. Try again.",
  V4TooMuchRequested: "The price moved more than your slippage. Try again.",
  TransactionDeadlinePassed: "The swap waited too long. Try again.",
  Slippage: "The price moved more than your slippage. Try again.",
  NotCreator: "Only the coin's creator can do this.",
  NotPendingCreator: "This wallet was not proposed as the new creator.",
  NothingOwed: "There is nothing to claim yet.",
  NothingToClaim: "There is nothing to claim yet.",
  NotGraduated: "The reserve unlocks when the coin graduates.",
  NothingLocked: "The reserve was already released.",
  WrongChoice: "This coin keeps its fees in the hook; claim them there.",
  OpenAtTooFar: "Trading can open at most 30 days after the launch.",
  BadOpenAt: "The trading open time is outside the allowed window (now to 30 days ahead).",
  TradingNotOpen: "Trading on this coin has not opened yet.",
  PriceAboveStart: "This sell is larger than the bonding range can take back. Sell a smaller amount.",
  PriceBelowGraduation: "The creator reserve unlocks only while the price is at or past the graduation price.",
  PoolManagerUnlocked: "The creator reserve cannot be released inside a swap. Send the release as its own transaction.",
  ReserveTooEarly: "The creator reserve unlocks one hour after graduation.",
  NotRouterCaller: "Only the fee router, its operator or the owner can claim the router fees.",
  BadClaimDeadline: "The holder batch claim deadline must be at least 7 days after it becomes executable and at most 365 days ahead.",
});

const GEN8_ERROR_IFACE = new ethers.Interface([
  ...Object.keys(GEN8_ERROR_WORDS).filter((n) => !["V4TooLittleReceived", "V4TooMuchRequested"].includes(n)).map((n) => `error ${n}()`),
  "error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)",
  "error V4TooMuchRequested(uint256 maxAmountInRequested, uint256 amountRequested)",
  "error ExecutionFailed(uint256 commandIndex, bytes message)",
  "error WrappedError(address target, bytes4 selector, bytes reason, bytes details)",
]);

function revertDataOf(error) {
  const seen = new Set();
  const stack = [error];
  while (stack.length) {
    const e = stack.pop();
    if (!e || typeof e !== "object" || seen.has(e)) continue;
    seen.add(e);
    const d = e.data;
    if (typeof d === "string" && /^0x[0-9a-f]{8}/i.test(d)) return d;
    stack.push(e.error, e.info, e.info?.error, e.cause, d && typeof d === "object" ? d : null);
  }
  return null;
}

/** A known gen-8 revert in plain words, or null (the caller shows its own message). */
export function gen8ErrorMessage(error) {
  const fromShared = gen8RevertReason(error);
  if (fromShared) return GEN8_ERROR_WORDS[fromShared.name] || fromShared.message;
  let data = revertDataOf(error);
  for (let depth = 0; data && depth < 4; depth += 1) {
    let parsed = null;
    try {
      parsed = GEN8_ERROR_IFACE.parseError(data);
    } catch {
      parsed = null;
    }
    if (!parsed) break;
    if (parsed.name === "ExecutionFailed") data = parsed.args.message;
    else if (parsed.name === "WrappedError") data = parsed.args.reason;
    else return GEN8_ERROR_WORDS[parsed.name] || gen8RevertReason(data)?.message || null;
  }
  const text = String(error?.shortMessage || error?.reason || error?.message || "");
  for (const [name, words] of Object.entries(GEN8_ERROR_WORDS)) if (text.includes(name)) return words;
  for (const e of Object.values(GEN8_REVERTS)) if (text.includes(e.name)) return e.message;
  if (/user rejected|denied/i.test(text)) return "You rejected the request in your wallet.";
  return null;
}
