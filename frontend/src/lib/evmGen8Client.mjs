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
 */
import { Contract, ethers } from "ethers";
import {
  GEN8_FIRST_BUY_MAX,
  GEN8_RATES,
  GEN8_TARGET_DEFAULT_USD,
  GEN8_TARGET_FAST_USD,
  GEN8_TARGET_TEST_USD,
  GEN8_TEST_TARGET_CHAIN_IDS,
  GEN8_TOTAL_SUPPLY,
  gen8FeeRate,
  gen8FirstBuyEstimate,
  gen8PoolId,
  gen8PoolKey,
} from "../../shared/evmGen8.mjs";
import {
  GEN8_REFERRER_APP,
  GEN8_SWAP_DEADLINE_SECONDS,
  PERMIT2_ABI,
  PERMIT2_ADDRESS,
  V4_QUOTER_ABI,
  buildGen8RouterCall,
  gen8BuyFeeSplit,
  gen8CreatorShareWei,
  gen8HookData,
  gen8MinOut,
  gen8PermitTypedData,
  gen8QuoterFor,
  gen8RouterFor,
  gen8SellFeeSplit,
} from "../../shared/evmGen8Swap.mjs";
import { gasWithHeadroom, legacyGasPriceFor } from "./evmGasHeadroom.mjs";

export const GEN8_DEFAULT_SLIPPAGE_BPS = 100;
/** MAX first buy stays this far under the 70% cap, so a small oracle move between quote and launch cannot revert it. */
export const GEN8_FIRST_BUY_MAX_HEADROOM_BPS = 50n;

export const GEN8_LAUNCHER_ABI = Object.freeze([
  "function launch((string name,string symbol,string logoURI,string xAccount,string website,string extraLink,bytes32 metadataHash,uint256 targetUsd,uint8 feeChoice,uint8 feeCreatorPct,uint256 firstBuyValue,uint256 minFirstBuyOut,uint256 salt) req, (uint64 deadline, bytes signature) auth) payable returns (address token, bytes32 id, uint256 firstBuyOut)",
  "function plan(uint256 targetUsdWad) view returns (uint256 mc, uint256 vN, uint256 vT, int24 tickStart, int24 tickGrad)",
  "function createPaused() view returns (bool)",
  "function hook() view returns (address)",
  "event Launched(address indexed token, bytes32 indexed id, address indexed creator, address hookCreator, uint256 targetUsd, uint256 marketCapNative, uint256 virtualNative, uint256 virtualToken, int24 tickStart, int24 tickGrad, uint8 feeChoice, uint8 feeCreatorPct, uint256 firstBuyIn, uint256 firstBuyOut)",
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
]);
export const GEN8_HOOK_ABI = Object.freeze([
  "function claimCreator(bytes32 id, address to) returns (uint256 amount)",
  "function proposeCreator(bytes32 id, address next)",
  "function acceptCreator(bytes32 id)",
  "function creatorOwed(bytes32 id) view returns (uint256)",
  "function pendingCreator(bytes32 id) view returns (address)",
  "function pools(bytes32) view returns (address creator, uint40 launchTime, bool graduated, int24 tickGrad, int24 tickStart, uint128 liqA, uint128 liqB, uint160 sqrtGrad, tuple(uint16 bondingBps, uint16 postBps, uint16 creatorPostBps, uint16 sniperStartBps, uint16 creatorBondingBps) fees)",
  "event Graduated(bytes32 indexed id, uint256 gradFeeNative, uint256 nativeInA, uint128 liquidityRemoved)",
  "event HookFee(bytes32 indexed id, address indexed swapSender, address indexed referrer, bool buy, bool graduated, uint256 curveAmount, uint256 fee, uint256 feeBps, uint256 creatorShare)",
  "error NotCreator()",
  "error NotPendingCreator()",
  "error NothingOwed()",
]);
export const GEN8_LENS_ABI = Object.freeze([
  "function currentFeeBps(bytes32 id, address sender) view returns (uint256)",
  "function previewFill(bytes32 id, bool zeroForOne, int256 amountSpecified, uint160 limit) view returns (uint256)",
  "function grossForNet(uint256 net, uint256 rate) pure returns (uint256)",
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

// ------------------------------------------------------------------ create (6.1)

/** The create page's graduation choices for a gen-8 launcher ($150 on testnets with the test tier on). */
export function gen8GraduationTiers(chainId, { testTierEnabled = false } = {}) {
  const tiers = [
    { id: "fast", label: "$30K MC", title: "Fast grad", description: "Graduates when the market cap reaches $30K. It keeps trading in the same Uniswap pool.", targetWei: GEN8_TARGET_FAST_USD },
    { id: "normal", label: "$50K MC", title: "Normal", description: "Graduates when the market cap reaches $50K. It keeps trading in the same Uniswap pool.", targetWei: GEN8_TARGET_DEFAULT_USD },
  ];
  if (testTierEnabled && GEN8_TEST_TARGET_CHAIN_IDS.includes(Number(chainId))) {
    tiers.unshift({ id: "test", label: "$150", title: "Testnet rehearsal", description: "Testnet only: graduates at a $150 market cap.", targetWei: GEN8_TARGET_TEST_USD, testOnly: true });
  }
  return tiers;
}

export const GEN8_DEFAULT_GRADUATION_TARGET_WEI = GEN8_TARGET_DEFAULT_USD;

/** launcher.plan(target): the curve the launcher would size in this block. Throws when the oracle cannot size it. */
export async function readGen8LaunchPlan({ provider, launcher, targetUsd }) {
  const c = new Contract(launcher, GEN8_LAUNCHER_ABI, provider);
  const p = await c.plan(BigInt(targetUsd));
  return { marketCapNative: BigInt(p[0]), virtualNative: BigInt(p[1]), virtualToken: BigInt(p[2]), tickStart: Number(p[3]), tickGrad: Number(p[4]) };
}

/** The first buy at `valueWei` on `plan`: coins out (the launch's V4 swap replayed), fee, supply share, cap check. */
export function gen8FirstBuyPlan({ valueWei, plan }) {
  const value = BigInt(valueWei || 0n);
  const est = gen8FirstBuyEstimate({ valueWei: value, tickStart: plan.tickStart, tickGrad: plan.tickGrad });
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
    const est = gen8FirstBuyEstimate({ valueWei: mid, tickStart: plan.tickStart, tickGrad: plan.tickGrad });
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

/** The campaignRequest body of POST /api/routing/create-authorization for a gen-8 launcher. */
export function gen8CreateAuthorizationBody({ chainId, walletAddress, launcher, name, symbol, logoURI, xAccount = "", website = "", extraLink = "", description = "", targetUsd, feeChoice, feeCreatorPct = 0, firstBuyValueWei = 0n, firstBuySlippageBps = 300 }) {
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
  const req = [r.name, r.symbol, r.logoURI, r.xAccount, r.website, r.extraLink, r.metadataHash, BigInt(r.targetUsd), Number(r.feeChoice), Number(r.feeCreatorPct), BigInt(r.firstBuyValue), BigInt(r.minFirstBuyOut), BigInt(r.salt)];
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
export async function launchGen8Coin({ signer, chainId, launcher, authorization, firstBuyValueWei = null }) {
  const args = gen8LaunchArgs(authorization, { chainId, launcher, firstBuyValueWei });
  const c = new Contract(launcher, GEN8_LAUNCHER_ABI, signer);
  // Launch measured at 1.67M gas on BSC and 1.10M on Robinhood (design 1): the floor keeps a failed estimate from
  // leaving the limit to a wallet default that is too low.
  const receipt = await sendGen8Call({ signer, chainId, contract: c, method: "launch", args: [args.req, args.auth], value: args.value, floor: 2_500_000n });
  const launched = parseGen8Launch(receipt, launcher);
  if (!launched) throw new Error("The launch landed but its coin could not be read from the receipt.");
  return { receipt, launched };
}

// ------------------------------------------------------------------ trade panel (6.2)

/** The rate a swap through `sender` (the router, or the escrow) pays now: the lens, else the gen-7 formula from the hook. */
export async function readGen8FeeBps({ provider, cfg, poolId, sender }) {
  if (cfg.lens) {
    const lens = new Contract(cfg.lens, GEN8_LENS_ABI, provider);
    return Number(await lens.currentFeeBps(poolId, sender));
  }
  const hook = new Contract(cfg.hook, GEN8_HOOK_ABI, provider);
  const [p, block] = await Promise.all([hook.pools(poolId), provider.getBlock("latest")]);
  const f = p.fees ?? p[8];
  return gen8FeeRate({
    graduated: Boolean(p.graduated ?? p[2]),
    launchTime: Number(p.launchTime ?? p[1]),
    nowTs: Number(block.timestamp),
    fees: { bondingBps: Number(f[0]), postBps: Number(f[1]), sniperStartBps: Number(f[3]) },
  });
}

/** Reads the hook's record of the coin's pool (graduated flag and fee config), or null for a token that is not gen-8. */
export async function readGen8PoolRecord({ provider, cfg, token }) {
  const poolId = gen8PoolId(token, cfg.hook);
  const hook = new Contract(cfg.hook, GEN8_HOOK_ABI, provider);
  const p = await hook.pools(poolId);
  const creator = p.creator ?? p[0];
  if (!creator || creator === ethers.ZeroAddress) return null;
  const f = p.fees ?? p[8];
  return {
    poolId,
    poolKey: gen8PoolKey(token, cfg.hook),
    creator: ethers.getAddress(creator),
    launchTime: Number(p.launchTime ?? p[1]),
    graduated: Boolean(p.graduated ?? p[2]),
    fees: { bondingBps: Number(f[0]), postBps: Number(f[1]), creatorPostBps: Number(f[2]), sniperStartBps: Number(f[3]), creatorBondingBps: Number(f[4]) },
  };
}

function quoterKey(poolKey) {
  return [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks];
}

/**
 * Exact-input quote in the coin's pool through Uniswap's V4Quoter (proven equal to execution on the forks), with the
 * fee split for the panel. side "buy": amountIn native; "sell": amountIn coins.
 * Returns { side, amountIn, amountOut, minOut, slippageBps, feeBps, feeWei, curveWei, creatorShareWei, graduated, poolId, poolKey }.
 */
export async function quoteGen8Trade({ provider, cfg, token, side, amountIn, slippageBps = GEN8_DEFAULT_SLIPPAGE_BPS, sender = null, record = null }) {
  if (!cfg?.quoter) throw new Error("No Uniswap quoter is configured for this chain.");
  const amount = BigInt(amountIn);
  if (amount <= 0n) throw new Error("Enter an amount.");
  const pool = record || (await readGen8PoolRecord({ provider, cfg, token }));
  if (!pool) throw new Error("This token has no MemeWarzone pool on this chain.");
  const swapSender = sender || cfg.router?.address;
  const [feeBps, quoted] = await Promise.all([
    readGen8FeeBps({ provider, cfg, poolId: pool.poolId, sender: swapSender }),
    new Contract(cfg.quoter, V4_QUOTER_ABI, provider).quoteExactInputSingle.staticCall([quoterKey(pool.poolKey), side === "buy", amount, gen8HookData(GEN8_REFERRER_APP)]),
  ]);
  const amountOut = BigInt(quoted[0] ?? quoted.amountOut);
  const split = side === "buy" ? gen8BuyFeeSplit(amount, feeBps) : gen8SellFeeSplit(amountOut, feeBps);
  return {
    side,
    amountIn: amount,
    amountOut,
    minOut: gen8MinOut(amountOut, slippageBps),
    slippageBps: Number(slippageBps),
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

/** The UniversalRouter call for a quoted trade (exact input). */
export function buildGen8TradeCall({ cfg, quote, deadline, permit = null, referrer = GEN8_REFERRER_APP }) {
  if (!cfg?.router) throw new Error("No Uniswap router is configured for this chain.");
  return buildGen8RouterCall({
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
  const reads = readProvider || signer.provider;
  const q = quote || (await quoteGen8Trade({ provider: reads, cfg, token, side, amountIn, slippageBps }));
  const now = Number((await reads.getBlock("latest")).timestamp);
  const permit = side === "sell" ? await prepareGen8SellPermit({ signer, chainId, token, amountIn: q.amountIn, router: cfg.router.address, nowSec: now }) : null;
  const call = buildGen8TradeCall({ cfg, quote: q, deadline: BigInt(now + GEN8_SWAP_DEADLINE_SECONDS), permit });
  const receipt = await sendGen8Tx({ signer, chainId, tx: call, floor: 400_000n });
  return { receipt, quote: q, call };
}

/** The creator's own buy in the app (D5): through MwzCreatorEscrow, coins held on the gen-7 schedule. */
export async function executeGen8EscrowBuy({ signer, chainId, cfg, token, amountIn, slippageBps = GEN8_DEFAULT_SLIPPAGE_BPS, readProvider = null }) {
  if (!cfg?.escrow) throw new Error("Creator buys are not set up on this chain yet.");
  const reads = readProvider || signer.provider;
  const q = await quoteGen8Trade({ provider: reads, cfg, token, side: "buy", amountIn, slippageBps, sender: cfg.escrow });
  const escrow = new Contract(cfg.escrow, GEN8_ESCROW_ABI, signer);
  const receipt = await sendGen8Call({ signer, chainId, contract: escrow, method: "buy", args: [token, q.minOut], value: q.amountIn, floor: 400_000n });
  return { receipt, quote: q };
}

// ------------------------------------------------------------------ creator panel (4)

/** hook.claimCreator(id, to): the whole hook ledger to any address (keep coins; the hook creator only). */
export async function claimGen8HookCreatorFees({ signer, chainId, cfg, poolId, to }) {
  const hook = new Contract(cfg.hook, GEN8_HOOK_ABI, signer);
  return sendGen8Call({ signer, chainId, contract: hook, method: "claimCreator", args: [poolId, ethers.getAddress(to)] });
}

/** Two-step creator transfer: on the hook for keep coins, in the choice vault for holders / split / buyback coins. */
export async function proposeGen8Creator({ signer, chainId, target, poolId, next }) {
  const c = new Contract(target, ["function proposeCreator(bytes32 id, address next)"], signer);
  return sendGen8Call({ signer, chainId, contract: c, method: "proposeCreator", args: [poolId, next ? ethers.getAddress(next) : ethers.ZeroAddress] });
}

export async function acceptGen8Creator({ signer, chainId, target, poolId }) {
  const c = new Contract(target, ["function acceptCreator(bytes32 id)"], signer);
  return sendGen8Call({ signer, chainId, contract: c, method: "acceptCreator", args: [poolId] });
}

/** vault.pull(id): permissionless, moves the hook ledger into the vault and credits it by the coin's fee choice. */
export async function pullGen8VaultFees({ signer, chainId, cfg, poolId }) {
  const v = new Contract(cfg.choiceVault, GEN8_CHOICE_VAULT_ABI, signer);
  return sendGen8Call({ signer, chainId, contract: v, method: "pull", args: [poolId] });
}

/** vault.claimCreatorFees(id, to): the split coin's creator part, to any address. */
export async function claimGen8VaultCreatorFees({ signer, chainId, cfg, poolId, to }) {
  const v = new Contract(cfg.choiceVault, GEN8_CHOICE_VAULT_ABI, signer);
  return sendGen8Call({ signer, chainId, contract: v, method: "claimCreatorFees", args: [poolId, ethers.getAddress(to)] });
}

/** reserveLock.release(id): permissionless once graduated; pays the coin's current creator. */
export async function releaseGen8Reserve({ signer, chainId, cfg, poolId }) {
  const r = new Contract(cfg.reserveLock, GEN8_RESERVE_LOCK_ABI, signer);
  return sendGen8Call({ signer, chainId, contract: r, method: "release", args: [poolId] });
}

/** escrow.claim(token): what is released of the caller's escrowed buys. */
export async function claimGen8Escrow({ signer, chainId, cfg, token }) {
  const e = new Contract(cfg.escrow, GEN8_ESCROW_ABI, signer);
  return sendGen8Call({ signer, chainId, contract: e, method: "claim", args: [token] });
}

// ------------------------------------------------------------------ coin state (API) helpers for the UI

/** "Launch fee: X% now, 2% in N s." from the API's tradeFee and the current time; null outside the window. */
export function gen8AntiSniperCountdown(tradeFee, nowSec) {
  if (!tradeFee || !tradeFee.launchAt) return null;
  const end = Number(tradeFee.antiSniperEndsAt || Number(tradeFee.launchAt) + GEN8_RATES.sniperWindowSeconds);
  const now = Number(nowSec);
  if (now >= end) return null;
  const bps = gen8FeeRate({
    graduated: false,
    launchTime: Number(tradeFee.launchAt),
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
    else return GEN8_ERROR_WORDS[parsed.name] || null;
  }
  const text = String(error?.shortMessage || error?.reason || error?.message || "");
  for (const [name, words] of Object.entries(GEN8_ERROR_WORDS)) if (text.includes(name)) return words;
  if (/user rejected|denied/i.test(text)) return "You rejected the request in your wallet.";
  return null;
}
