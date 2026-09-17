import { ethers } from "ethers";

export const RH46630_CHAIN_ID = 46630;
export const FORBIDDEN_PRODUCTION_CHAIN_ID = 4663;
export const FORBIDDEN_STAGED_FACTORY = "0xF170F31dCeaBd2d0b3D32A14FbB6d22661148242";
export const DEFAULT_RPC_URL = "https://rpc.testnet.chain.robinhood.com";

// Live 46630 V3 surface reachable from the green launch factory 0xd03D.
// Read from chain in live mode; these are the expected identities.
export const V3_FACTORY = "0x948463E91d63a7A51cEeC0342735D1B738044aea";
export const SWAP_ROUTER_02 = "0xDfd381ECfA6D4CcD4248e319C6fecD76A6bf3296";
export const WETH9 = "0x52A47A33930B8a90a2000b1bA3CB96e879569670";
export const RH5661_CAMPAIGN = "0xB69E19C4387905170aa17E986aAA3b805dAfe440";
export const V3_FEE_TIER = 3000;
// Post-grad probe size. Large enough that the pool prints a non-dust Swap and
// Token Details 24h volume stops rendering as $0.000000.
export const SWAP_ETH_WEI = ethers.parseEther("0.0001");

const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
  "function factory() view returns (address)",
];
const V3_FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
// SwapRouter02: params carry no deadline (that is the older SwapRouter shape).
const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
  "function WETH9() view returns (address)",
  "function factory() view returns (address)",
];
const CAMPAIGN_ABI = [
  "function launched() view returns (bool)",
  "function token() view returns (address)",
  "function getGraduationState() view returns (address dexPair,uint256 finalCurvePrice,uint256 initialDexPrice,uint256 graduatedLiquidityTokens,uint256 graduatedLiquidityBnb,uint256 graduatedLiquidityLp,uint256 burnedUnsoldTokens,uint256 burnedUnusedLpTokens,uint256 postBurnTotalSupply,uint256 graduationBalance,uint256 graduationOvershoot)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function symbol() view returns (string)",
];

export function sameAddress(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

export function assertChainId(chainId) {
  const id = Number(chainId);
  if (id === FORBIDDEN_PRODUCTION_CHAIN_ID) throw new Error("PRODUCTION_4663_FORBIDDEN");
  if (id !== RH46630_CHAIN_ID) throw new Error(`WRONG_CHAIN_${id}`);
  return id;
}

export function assertNotStagedFactory(address) {
  if (sameAddress(address, FORBIDDEN_STAGED_FACTORY)) throw new Error("STAGED_F170_FACTORY_FORBIDDEN");
  return ethers.getAddress(String(address));
}

export function liveRequested(env = process.env) {
  return String(env.RH46630_POSTGRAD_SWAP_LIVE || "").trim().toLowerCase() === "true";
}

export function planPostGradSwap(input = {}, env = process.env) {
  const chainId = assertChainId(input.chainId ?? env.T2_CHAIN_ID ?? RH46630_CHAIN_ID);
  const campaign = assertNotStagedFactory(input.campaign ?? env.RH46630_POSTGRAD_CAMPAIGN ?? RH5661_CAMPAIGN);
  const live = liveRequested(env);
  const swapEthWei = BigInt(String(input.swapEthWei || env.RH46630_POSTGRAD_SWAP_WEI || SWAP_ETH_WEI));
  return {
    mode: live ? "live-gated" : "dry-run",
    chainId,
    native: "ETH",
    campaign,
    v3Factory: V3_FACTORY,
    swapRouter: SWAP_ROUTER_02,
    weth9: WETH9,
    feeTier: V3_FEE_TIER,
    forbiddenFactory: FORBIDDEN_STAGED_FACTORY,
    swapEthWei: swapEthWei.toString(),
    steps: ["exactInputSingle:ETH->TOKEN", "approve:TOKEN->router", "exactInputSingle:TOKEN->WETH"],
    liveRequested: live,
    sendRequired: live,
    sent: false,
  };
}

/**
 * Post-graduation proof. The bonding create/buy/sell flow cannot produce these:
 * once a campaign graduates, further volume only exists as V3 pool swaps, which
 * is what Token Details 24h volume and the pool indexer read after the bonding
 * prints age out of the window.
 */
export async function runPostGradSwap(input = {}, env = process.env) {
  const plan = planPostGradSwap(input, env);
  if (!plan.liveRequested) return { ...plan, sent: false };

  const rpcUrl = String(env.ROBINHOOD_TESTNET_RPC_URL || DEFAULT_RPC_URL).trim();
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  assertChainId((await provider.getNetwork()).chainId);

  const traderKey = String(env.ROBINHOOD_TESTNET_TRADER_A_PRIVATE_KEY || "").trim();
  if (!traderKey) throw new Error("MISSING_POSTGRAD_TRADER_KEY");
  const trader = new ethers.Wallet(traderKey, provider);

  const campaign = new ethers.Contract(plan.campaign, CAMPAIGN_ABI, provider);
  if (!(await campaign.launched())) throw new Error("CAMPAIGN_NOT_GRADUATED");
  const token = ethers.getAddress(await campaign.token());
  const state = await campaign.getGraduationState();
  const onChainPair = ethers.getAddress(String(state.dexPair ?? state[0]));

  // Never trust a manifest address here: the staged 0xF170 deployment has its own
  // V3 surface, so the pool must resolve from the configured factory AND match
  // what the graduated campaign itself reports.
  const resolvedPair = ethers.getAddress(
    await new ethers.Contract(plan.v3Factory, V3_FACTORY_ABI, provider).getPool(token, plan.weth9, plan.feeTier),
  );
  if (!sameAddress(resolvedPair, onChainPair)) {
    throw new Error(`POOL_MISMATCH factory=${resolvedPair} campaign=${onChainPair}`);
  }
  const pool = new ethers.Contract(resolvedPair, POOL_ABI, provider);
  if (!sameAddress(await pool.factory(), plan.v3Factory)) throw new Error("POOL_FACTORY_MISMATCH");
  if ((await pool.liquidity()) === 0n) throw new Error("POOL_HAS_NO_LIQUIDITY");

  const router = new ethers.Contract(plan.swapRouter, ROUTER_ABI, trader);
  if (!sameAddress(await router.WETH9(), plan.weth9)) throw new Error("ROUTER_WETH_MISMATCH");
  if (!sameAddress(await router.factory(), plan.v3Factory)) throw new Error("ROUTER_FACTORY_MISMATCH");

  const erc20 = new ethers.Contract(token, ERC20_ABI, trader);
  const before = await erc20.balanceOf(trader.address);

  // Buy: SwapRouter02 wraps msg.value when tokenIn is WETH9.
  const buyTx = await router.exactInputSingle(
    {
      tokenIn: plan.weth9,
      tokenOut: token,
      fee: plan.feeTier,
      recipient: trader.address,
      amountIn: BigInt(plan.swapEthWei),
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    },
    { value: BigInt(plan.swapEthWei) },
  );
  const buyReceipt = await buyTx.wait();
  const afterBuy = await erc20.balanceOf(trader.address);
  const bought = afterBuy - before;
  if (bought <= 0n) throw new Error("POSTGRAD_BUY_RECEIVED_NOTHING");

  // Sell half back so the pool prints both directions.
  const sellAmount = bought / 2n;
  if (sellAmount <= 0n) throw new Error("POSTGRAD_SELL_AMOUNT_ZERO");
  if ((await erc20.allowance(trader.address, plan.swapRouter)) < sellAmount) {
    await (await erc20.approve(plan.swapRouter, ethers.MaxUint256)).wait();
  }
  const sellTx = await router.exactInputSingle({
    tokenIn: token,
    tokenOut: plan.weth9,
    fee: plan.feeTier,
    recipient: trader.address,
    amountIn: sellAmount,
    amountOutMinimum: 0n,
    sqrtPriceLimitX96: 0n,
  });
  const sellReceipt = await sellTx.wait();

  return {
    ...plan,
    sent: true,
    trader: trader.address,
    token,
    pair: resolvedPair,
    boughtRaw: bought.toString(),
    soldRaw: sellAmount.toString(),
    buyTxHash: buyReceipt?.hash || buyTx.hash,
    sellTxHash: sellReceipt?.hash || sellTx.hash,
    explorer: "https://explorer.testnet.chain.robinhood.com",
  };
}
