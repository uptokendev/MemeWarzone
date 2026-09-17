import path from "node:path";
import { pathToFileURL } from "node:url";
import { ethers } from "ethers";

export const RH46630_CHAIN_ID = 46630;
export const FORBIDDEN_PRODUCTION_CHAIN_ID = 4663;
export const GREEN_FACTORY = "0xd03D1CC03d108B7F9b2195489DC6CFda1FB1a943";
export const FORBIDDEN_STAGED_FACTORY = "0xF170F31dCeaBd2d0b3D32A14FbB6d22661148242";
export const DEFAULT_RPC_URL = "https://rpc.testnet.chain.robinhood.com";
export const TRADE_AUTH_BUY_EXACT_TOKENS = 0;
export const TRADE_AUTH_SELL_EXACT_TOKENS = 2;

const FACTORY_ABI = [
  "function FACTORY_GENERATION() view returns (uint32)",
  "function CAMPAIGN_GENERATION() view returns (uint32)",
  "function tradeRouteProfile() view returns (uint8)",
  "function finalizeRouteProfile() view returns (uint8)",
  "function campaignsCount() view returns (uint256)",
  "function getCampaign(uint256) view returns (address campaign, address token)",
  "function createCampaignAuthorized((string name,string symbol,string logoURI,string xAccount,string website,string extraLink,uint256 graduationTarget) req,(uint8 tradeRouteProfile,uint8 finalizeRouteProfile,uint64 deadline,bytes signature) auth) returns (address campaignAddr,address tokenAddr)",
];

const CAMPAIGN_ABI = [
  "function tradeRouteProfile() view returns (uint8)",
  "function quoteBuyExactTokens(uint256 amountOut) view returns (uint256)",
  "function quoteSellExactTokens(uint256 amountIn) view returns (uint256)",
  "function buyExactTokensAuthorized(uint256 amountOut,uint256 maxCost,uint8 routeProfile,uint64 routeDeadline,bytes routeSignature) payable returns (uint256)",
  "function sellExactTokensAuthorized(uint256 amountIn,uint256 minPayout,uint8 routeProfile,uint64 routeDeadline,bytes routeSignature) returns (uint256)",
];

const TOKEN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
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

export function assertLiveFactory(address) {
  const raw = String(address || GREEN_FACTORY).trim();
  if (sameAddress(raw, FORBIDDEN_STAGED_FACTORY)) throw new Error("STAGED_F170_FACTORY_FORBIDDEN");
  const factory = ethers.getAddress(raw);
  if (!sameAddress(factory, GREEN_FACTORY)) throw new Error(`LIVE_FACTORY_MISMATCH_${factory}`);
  return factory;
}

export function liveRequested(env = process.env) {
  return String(env.RH46630_CREATE_BUY_SELL || "").trim() === "1";
}

export function planCreateBuySell(input = {}, env = process.env) {
  const chainId = assertChainId(input.chainId ?? env.T2_CHAIN_ID ?? RH46630_CHAIN_ID);
  const factory = assertLiveFactory(input.factory ?? env.FACTORY_ADDRESS_46630 ?? GREEN_FACTORY);
  const live = liveRequested(env);
  const buyTokensWei = BigInt(String(input.buyTokensWei || env.RH46630_BUY_TOKENS_WEI || ethers.parseEther("1")));
  const graduationTargetWei = BigInt(
    String(input.graduationTargetWei || env.RH46630_GRADUATION_TARGET_WEI || ethers.parseEther("10")),
  );
  const runId = String(input.runId || env.GITHUB_RUN_ID || Date.now());
  const symbol = String(input.symbol || `QA${String(runId).slice(-4)}`).slice(0, 8);
  const creatorKey = String(env.ROBINHOOD_TESTNET_DEPLOYER_PRIVATE_KEY || "").trim();
  const buyerKey = String(env.ROBINHOOD_TESTNET_TRADER_A_PRIVATE_KEY || env.ROBINHOOD_TEST_BUYER_PRIVATE_KEY || "").trim();
  const routeKey = String(env.ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY || "").trim();
  if (live && (!creatorKey || !buyerKey || !routeKey)) throw new Error("MISSING_CREATE_BUY_SELL_KEYS");
  return {
    mode: live ? "live-gated" : "dry-run",
    chainId,
    native: "ETH",
    factory,
    forbiddenFactory: FORBIDDEN_STAGED_FACTORY,
    buyTokensWei: buyTokensWei.toString(),
    graduationTargetWei: graduationTargetWei.toString(),
    request: {
      name: `QA Bond ${symbol}`,
      symbol,
      logoURI: "ipfs://qa",
      xAccount: "",
      website: "",
      extraLink: "",
      graduationTarget: graduationTargetWei.toString(),
    },
    steps: ["createCampaignAuthorized", "buyExactTokensAuthorized", "sellExactTokensAuthorized"],
    liveRequested: live,
    sendRequired: live,
  };
}

export async function runCreateBuySell({
  env = process.env,
  plan,
  loadSigner,
  sendCreate,
  sendBuy,
  sendApprove,
  sendSell,
} = {}) {
  const resolved = plan || planCreateBuySell({}, env);
  if (!resolved.sendRequired) return { ...resolved, sent: false };
  if (![sendCreate, sendBuy, sendApprove, sendSell].every((fn) => typeof fn === "function")) {
    throw new Error("SENDERS_REQUIRED");
  }
  const signerMod = loadSigner
    ? await loadSigner()
    : await import(pathToFileURL(path.join(process.cwd(), "frontend/api/dev-fix/routeAuthorizationSigner.js")).href);

  const rpcUrl = String(env.ROBINHOOD_TESTNET_RPC_URL || DEFAULT_RPC_URL).trim();
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  assertChainId(network.chainId);

  const creator = new ethers.Wallet(String(env.ROBINHOOD_TESTNET_DEPLOYER_PRIVATE_KEY), provider);
  const buyer = new ethers.Wallet(
    String(env.ROBINHOOD_TESTNET_TRADER_A_PRIVATE_KEY || env.ROBINHOOD_TEST_BUYER_PRIVATE_KEY),
    provider,
  );
  const routeAuthority = new ethers.Wallet(String(env.ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY), provider);
  const factory = new ethers.Contract(resolved.factory, FACTORY_ABI, creator);
  const tradeRouteProfile = Number(await factory.tradeRouteProfile());
  const finalizeRouteProfile = Number(await factory.finalizeRouteProfile());
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const request = {
    ...resolved.request,
    graduationTarget: BigInt(resolved.request.graduationTarget),
  };
  const createSignature = await signerMod.signCreateAuthorization({
    signer: routeAuthority,
    chainId: resolved.chainId,
    factoryAddress: resolved.factory,
    creator: creator.address,
    request,
    tradeRouteProfileId: tradeRouteProfile,
    finalizeRouteProfileId: finalizeRouteProfile,
    deadline,
  });
  const created = await sendCreate({
    factory,
    request,
    auth: { tradeRouteProfile, finalizeRouteProfile, deadline, signature: createSignature },
  });
  const campaignAddress = ethers.getAddress(created.campaign);
  const tokenAddress = ethers.getAddress(created.token);
  const campaign = new ethers.Contract(campaignAddress, CAMPAIGN_ABI, buyer);
  const token = new ethers.Contract(tokenAddress, TOKEN_ABI, buyer);
  const buyAmount = BigInt(resolved.buyTokensWei);
  const maxCost = await campaign.quoteBuyExactTokens(buyAmount);
  const buyAuth = await signerMod.signTradeAuthorization({
    signer: routeAuthority,
    chainId: resolved.chainId,
    campaignAddress,
    actor: buyer.address,
    routeProfileId: Number(await campaign.tradeRouteProfile()),
    action: TRADE_AUTH_BUY_EXACT_TOKENS,
    amount: buyAmount,
    limit: maxCost,
    deadline,
  });
  const buyTx = await sendBuy({ campaign, buyAmount, maxCost, buyAuth, deadline, tradeRouteProfile: Number(await campaign.tradeRouteProfile()) });
  const sellAmount = buyAmount / 2n;
  const minPayout = await campaign.quoteSellExactTokens(sellAmount);
  await sendApprove({ token, campaignAddress, sellAmount });
  const sellAuth = await signerMod.signTradeAuthorization({
    signer: routeAuthority,
    chainId: resolved.chainId,
    campaignAddress,
    actor: buyer.address,
    routeProfileId: Number(await campaign.tradeRouteProfile()),
    action: TRADE_AUTH_SELL_EXACT_TOKENS,
    amount: sellAmount,
    limit: minPayout,
    deadline,
  });
  const sellTx = await sendSell({
    campaign,
    sellAmount,
    minPayout,
    sellAuth,
    deadline,
    tradeRouteProfile: Number(await campaign.tradeRouteProfile()),
  });
  return {
    ...resolved,
    sent: true,
    campaign: campaignAddress,
    token: tokenAddress,
    createTx: created.txHash || null,
    buyTx: buyTx?.txHash || null,
    sellTx: sellTx?.txHash || null,
    explorer: `https://explorer.testnet.chain.robinhood.com/address/${campaignAddress}`,
  };
}

async function main() {
  const plan = planCreateBuySell();
  if (!plan.sendRequired) {
    console.log(JSON.stringify({ ...plan, sent: false }, null, 2));
    return;
  }
  const report = await runCreateBuySell({
    plan,
    sendCreate: async ({ factory, request, auth }) => {
      const tx = await factory.createCampaignAuthorized(request, auth);
      const receipt = await tx.wait();
      const count = await factory.campaignsCount();
      const info = await factory.getCampaign(count - 1n);
      return { campaign: info.campaign, token: info.token, txHash: receipt?.hash || tx.hash };
    },
    sendBuy: async ({ campaign, buyAmount, maxCost, buyAuth, deadline, tradeRouteProfile }) => {
      const tx = await campaign.buyExactTokensAuthorized(
        buyAmount,
        maxCost,
        tradeRouteProfile,
        deadline,
        buyAuth,
        { value: maxCost },
      );
      const receipt = await tx.wait();
      return { txHash: receipt?.hash || tx.hash };
    },
    sendApprove: async ({ token, campaignAddress, sellAmount }) => {
      const tx = await token.approve(campaignAddress, sellAmount);
      await tx.wait();
    },
    sendSell: async ({ campaign, sellAmount, minPayout, sellAuth, deadline, tradeRouteProfile }) => {
      const tx = await campaign.sellExactTokensAuthorized(
        sellAmount,
        minPayout,
        tradeRouteProfile,
        deadline,
        sellAuth,
      );
      const receipt = await tx.wait();
      return { txHash: receipt?.hash || tx.hash };
    },
  });
  console.log(JSON.stringify(report, null, 2));
}

const isDirect = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirect) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
