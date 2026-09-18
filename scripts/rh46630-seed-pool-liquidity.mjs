import { ethers } from "ethers";

export const RH46630_CHAIN_ID = 46630;
export const FORBIDDEN_PRODUCTION_CHAIN_ID = 4663;
export const DEFAULT_RPC_URL = "https://rpc.testnet.chain.robinhood.com";

// Live 46630 V3 surface reachable from the green launch factory 0xd03D.
export const V3_FACTORY = "0x948463E91d63a7A51cEeC0342735D1B738044aea";
export const POSITION_MANAGER = "0xfF64Bd6970966dB58F0dd65BA76669D3b8BE9eC4";
export const WETH9 = "0x52A47A33930B8a90a2000b1bA3CB96e879569670";
export const RH5661_CAMPAIGN = "0xB69E19C4387905170aa17E986aAA3b805dAfe440";
export const V3_FEE_TIER = 3000;
export const TICK_SPACING = 60;

// The staged 0xF170 surface has its own V3 contracts. Seeding into it would put
// real liquidity somewhere the live factory's tokens never trade.
export const STAGED_POSITION_MANAGER = "0xfF64Bd6970966dB58F0dd65BA76669D3b8BE9eC4";
export const STAGED_WETH9 = "0x632061cA786f7B585Bbd46A792FDA92B02f70671";

// Widest range the 0.3% tier allows, so the position is never out of range.
export const MIN_TICK = -887220;
export const MAX_TICK = 887220;

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function liquidity() view returns (uint128)",
];
const FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const POSITION_MANAGER_ABI = [
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  "function factory() view returns (address)",
  "function WETH9() view returns (address)",
];
const WETH_ABI = [
  "function deposit() payable",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
];
const CAMPAIGN_ABI = ["function token() view returns (address)"];

export function sameAddress(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

export function assertChainId(chainId) {
  const id = Number(chainId);
  if (id === FORBIDDEN_PRODUCTION_CHAIN_ID) throw new Error("PRODUCTION_4663_FORBIDDEN");
  if (id !== RH46630_CHAIN_ID) throw new Error(`WRONG_CHAIN_${id}`);
  return id;
}

export function assertLiveSurface(weth9) {
  if (sameAddress(weth9, STAGED_WETH9)) throw new Error("STAGED_WETH9_FORBIDDEN");
  if (!sameAddress(weth9, WETH9)) throw new Error(`UNEXPECTED_WETH9_${weth9}`);
  return ethers.getAddress(weth9);
}

export function liveRequested(env = process.env) {
  return String(env.RH46630_SEED_LIQUIDITY_LIVE || "").trim().toLowerCase() === "true";
}

/**
 * Token side needed to pair a given native side over the widest range.
 *
 * Across the full range a position holds equal value on both sides at the
 * current price, so the token amount is simply the native amount divided by the
 * pool price. Deriving it keeps the deposit balanced instead of leaving one
 * side mostly unused.
 */
export function tokenAmountForNative(nativeWei, sqrtPriceX96, baseIsToken0) {
  const sqrt = BigInt(sqrtPriceX96);
  if (sqrt <= 0n) throw new Error("POOL_HAS_NO_PRICE");
  const Q96 = 1n << 96n;
  const PRECISION = 10n ** 18n;
  // price of token0 in token1, scaled by PRECISION
  const price0In1 = (sqrt * sqrt * PRECISION) / (Q96 * Q96);
  if (price0In1 <= 0n) throw new Error("POOL_PRICE_UNDERFLOW");
  return baseIsToken0
    ? (BigInt(nativeWei) * PRECISION) / price0In1
    : (BigInt(nativeWei) * price0In1) / PRECISION;
}

export function planSeedLiquidity(input = {}, env = process.env) {
  const chainId = assertChainId(input.chainId ?? env.T2_CHAIN_ID ?? RH46630_CHAIN_ID);
  const weth = assertLiveSurface(input.weth9 ?? env.ROBINHOOD_V3_WETH9_ADDRESS_46630 ?? WETH9);
  const campaign = ethers.getAddress(String(input.campaign ?? env.RH46630_SEED_CAMPAIGN ?? RH5661_CAMPAIGN));
  // Nullish, not falsy: an explicit 0 must be refused, never replaced by a default.
  const requestedNative = input.nativeWei ?? env.RH46630_SEED_NATIVE_WEI ?? ethers.parseEther("0.1");
  const nativeWei = BigInt(String(requestedNative));
  if (nativeWei <= 0n) throw new Error("SEED_AMOUNT_MUST_BE_POSITIVE");
  const live = liveRequested(env);
  return {
    mode: live ? "live-gated" : "dry-run",
    chainId,
    native: "ETH",
    campaign,
    positionManager: ethers.getAddress(POSITION_MANAGER),
    v3Factory: ethers.getAddress(V3_FACTORY),
    weth9: weth,
    feeTier: V3_FEE_TIER,
    tickLower: MIN_TICK,
    tickUpper: MAX_TICK,
    nativeWei: nativeWei.toString(),
    steps: ["wrap:ETH->WETH", "approve:WETH+TOKEN->positionManager", "mint:full-range-position"],
    liveRequested: live,
    sendRequired: live,
    sent: false,
  };
}

/**
 * Adds a full-range position to the graduated pool.
 *
 * The pool graduated with roughly a dollar of liquidity, so every QA trade moved
 * price by multiples and nothing on the page looked representative. This does not
 * touch the locked graduation position; it mints a separate one owned by the
 * depositor, which can be withdrawn later.
 */
export async function runSeedLiquidity(input = {}, env = process.env) {
  const plan = planSeedLiquidity(input, env);
  if (!plan.liveRequested) return { ...plan, sent: false };

  const rpcUrl = String(env.ROBINHOOD_TESTNET_RPC_URL || DEFAULT_RPC_URL).trim();
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  assertChainId((await provider.getNetwork()).chainId);

  const key = String(env.ROBINHOOD_TESTNET_DEPLOYER_PRIVATE_KEY || "").trim();
  if (!key) throw new Error("MISSING_DEPLOYER_KEY");
  const wallet = new ethers.Wallet(key, provider);

  const tokenAddress = ethers.getAddress(
    await new ethers.Contract(plan.campaign, CAMPAIGN_ABI, provider).token(),
  );
  const poolAddress = ethers.getAddress(
    await new ethers.Contract(plan.v3Factory, FACTORY_ABI, provider).getPool(tokenAddress, plan.weth9, plan.feeTier),
  );
  if (poolAddress === ethers.ZeroAddress) throw new Error("POOL_NOT_FOUND");

  const poolContract = new ethers.Contract(poolAddress, POOL_ABI, provider);
  const [slot0, token0, token1] = await Promise.all([
    poolContract.slot0(),
    poolContract.token0(),
    poolContract.token1(),
  ]);
  const baseIsToken0 = sameAddress(token0, tokenAddress);

  const manager = new ethers.Contract(plan.positionManager, POSITION_MANAGER_ABI, wallet);
  const [pmFactory, pmWeth] = await Promise.all([manager.factory(), manager.WETH9()]);
  if (!sameAddress(pmFactory, plan.v3Factory)) throw new Error(`POSITION_MANAGER_FACTORY_MISMATCH_${pmFactory}`);
  if (!sameAddress(pmWeth, plan.weth9)) throw new Error(`POSITION_MANAGER_WETH_MISMATCH_${pmWeth}`);

  const nativeWei = BigInt(plan.nativeWei);
  const tokenWei = tokenAmountForNative(nativeWei, slot0.sqrtPriceX96 ?? slot0[0], baseIsToken0);

  const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
  const tokenBalance = await token.balanceOf(wallet.address);
  if (tokenBalance < tokenWei) {
    // Fail with the exact shortfall rather than half-seeding a lopsided position.
    throw new Error(
      `INSUFFICIENT_TOKEN_BALANCE need=${ethers.formatUnits(tokenWei, 18)} have=${ethers.formatUnits(tokenBalance, 18)} ` +
        `holder=${wallet.address} token=${tokenAddress}`,
    );
  }

  const weth = new ethers.Contract(plan.weth9, WETH_ABI, wallet);
  const wethBalance = await weth.balanceOf(wallet.address);
  if (wethBalance < nativeWei) {
    await (await weth.deposit({ value: nativeWei - wethBalance })).wait();
  }

  if ((await weth.allowance(wallet.address, plan.positionManager)) < nativeWei) {
    await (await weth.approve(plan.positionManager, ethers.MaxUint256)).wait();
  }
  if ((await token.allowance(wallet.address, plan.positionManager)) < tokenWei) {
    await (await token.approve(plan.positionManager, ethers.MaxUint256)).wait();
  }

  const amount0Desired = baseIsToken0 ? tokenWei : nativeWei;
  const amount1Desired = baseIsToken0 ? nativeWei : tokenWei;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);

  const tx = await manager.mint({
    token0: ethers.getAddress(token0),
    token1: ethers.getAddress(token1),
    fee: plan.feeTier,
    tickLower: plan.tickLower,
    tickUpper: plan.tickUpper,
    amount0Desired,
    amount1Desired,
    // Price can move between quoting and mining; accept whatever ratio lands.
    amount0Min: 0n,
    amount1Min: 0n,
    recipient: wallet.address,
    deadline,
  });
  const receipt = await tx.wait();

  const [poolLiquidity, tokenReserve, wethReserve] = await Promise.all([
    poolContract.liquidity(),
    token.balanceOf(poolAddress),
    weth.balanceOf(poolAddress),
  ]);

  return {
    ...plan,
    sent: true,
    depositor: wallet.address,
    tokenAddress,
    poolAddress,
    tokenWei: tokenWei.toString(),
    txHash: receipt?.hash || tx.hash,
    blockNumber: receipt?.blockNumber ?? null,
    poolLiquidityAfter: poolLiquidity.toString(),
    poolTokenReserveAfter: ethers.formatUnits(tokenReserve, 18),
    poolNativeReserveAfter: ethers.formatUnits(wethReserve, 18),
    explorer: "https://explorer.testnet.chain.robinhood.com",
  };
}
