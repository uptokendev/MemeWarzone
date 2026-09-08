import { Contract, ethers } from "ethers";
import { apiFetch } from "@/lib/apiBase";
import type { RobinhoodStockToken } from "@/lib/marketContinuityApi";
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_TESTNET_CHAIN_ID } from "@/lib/chainConfig";
import { signWalletAction } from "@/lib/walletActionAuth";

const STOCK_FACTORY_ABI = [
  "function createStockCampaignAuthorized((string name,string symbol,string logoURI,string xAccount,string website,string extraLink,uint256 graduationTarget) req,address stockToken,(uint8 tradeRouteProfile,uint8 finalizeRouteProfile,uint64 deadline,bytes signature) routeAuth) returns (address campaignAddr,address tokenAddr)",
  "event CampaignCreated(uint256 indexed id,address indexed campaign,address indexed token,address creator,string name,string symbol,string logoURI,string metadataURI)",
] as const;

const STOCK_FACTORY_INTERFACE = new ethers.Interface(STOCK_FACTORY_ABI);

export type RobinhoodGraduationMarketKind = "NATIVE" | "STOCK_TOKEN";

export type RobinhoodStockGraduationSelection = {
  kind: "STOCK_TOKEN";
  stockToken: RobinhoodStockToken;
  marketPolicyVersion: "robinhood_market_v1";
};

export type RobinhoodStockCreateParams = {
  signer: ethers.Signer;
  chainId: number;
  factoryAddress: string;
  creatorAddress: string;
  name: string;
  symbol: string;
  logoURI: string;
  xAccount: string;
  website: string;
  extraLink: string;
  graduationTargetWei: bigint;
  stockToken: RobinhoodStockToken;
};

export type RobinhoodStockCreateResult = {
  receipt: ethers.ContractTransactionReceipt;
  campaignAddress: string;
  tokenAddress: string;
  graduationMarket: {
    kind: "STOCK_TOKEN";
    quoteAsset: string;
    marketPolicyVersion: string;
  };
};

function requireRobinhoodChain(chainId: number) {
  if (chainId !== ROBINHOOD_CHAIN_ID && chainId !== ROBINHOOD_TESTNET_CHAIN_ID) {
    throw new Error("Stock Battlefield creation is available only on Robinhood Chain.");
  }
}

function normalizeAddress(value: unknown, label: string) {
  const raw = String(value || "").trim();
  if (!ethers.isAddress(raw) || raw === ethers.ZeroAddress) throw new Error(`Invalid ${label}.`);
  return ethers.getAddress(raw);
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(String(body?.error || body?.message || `Request failed (${response.status})`));
  }
  return body as T;
}

export async function fetchRobinhoodStockGraduationAssets(chainId: number): Promise<RobinhoodStockToken[]> {
  requireRobinhoodChain(chainId);
  const response = await apiFetch(
    `/api/robinhood/stock-tokens?chainId=${encodeURIComponent(String(chainId))}&includePrices=true&includeDisabled=true`,
    { method: "GET", cache: "no-store" },
  );
  const body = await readJson<{ items?: RobinhoodStockToken[] }>(response);
  return Array.isArray(body?.items) ? body.items : [];
}

function extractCampaignCreated(receipt: ethers.ContractTransactionReceipt) {
  for (const log of receipt.logs) {
    try {
      const parsed = STOCK_FACTORY_INTERFACE.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name !== "CampaignCreated") continue;
      const campaignAddress = normalizeAddress(parsed.args?.campaign, "created campaign address");
      const tokenAddress = normalizeAddress(parsed.args?.token, "created token address");
      return { campaignAddress, tokenAddress };
    } catch {
      // Ignore unrelated logs from contracts called by the factory transaction.
    }
  }
  throw new Error("Stock campaign transaction confirmed without CampaignCreated evidence.");
}

async function mirrorCampaign(input: RobinhoodStockCreateParams, created: { campaignAddress: string; tokenAddress: string }) {
  try {
    const auth = await signWalletAction({
      action: "campaign_upsert",
      walletAddress: input.creatorAddress,
      chainId: input.chainId,
      signer: input.signer,
      extraLines: [`Campaign: ${created.campaignAddress.toLowerCase()}`],
    });
    await apiFetch("/api/campaigns/upsert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chainId: input.chainId,
        campaignAddress: created.campaignAddress.toLowerCase(),
        tokenAddress: created.tokenAddress.toLowerCase(),
        creatorAddress: input.creatorAddress.toLowerCase(),
        name: input.name,
        symbol: input.symbol,
        logoURI: input.logoURI,
        xAccount: input.xAccount,
        website: input.website,
        extraLink: input.extraLink,
        graduationMarketKind: "STOCK_TOKEN",
        graduationQuoteAsset: input.stockToken.contractAddress,
        graduationMarketPolicyVersion: "robinhood_market_v1",
        action: auth.action,
        walletAddress: auth.walletAddress,
        nonce: auth.nonce,
        message: auth.message,
        signature: auth.signature,
        ...(auth.walletType ? { walletType: auth.walletType } : {}),
      }),
    });
  } catch (error) {
    console.warn("[robinhoodStockCreate] campaign metadata mirror failed", error);
  }
}

export async function createRobinhoodStockCampaign(input: RobinhoodStockCreateParams): Promise<RobinhoodStockCreateResult> {
  requireRobinhoodChain(input.chainId);
  const factoryAddress = normalizeAddress(input.factoryAddress, "Robinhood factory address");
  const creatorAddress = normalizeAddress(input.creatorAddress, "creator address");
  const stockTokenAddress = normalizeAddress(input.stockToken.contractAddress, "Stock Token address");
  if (!input.stockToken.canonical || !input.stockToken.enabledForGraduation) {
    throw new Error("Select a canonical Stock Token that is enabled for graduation.");
  }

  const network = await input.signer.provider?.getNetwork();
  if (!network || Number(network.chainId) !== input.chainId) {
    throw new Error(`Wrong network. Connect Robinhood chain ${input.chainId}.`);
  }
  const signerAddress = normalizeAddress(await input.signer.getAddress(), "connected signer");
  if (signerAddress !== creatorAddress) throw new Error("Connected signer does not match the creator wallet.");

  const campaignRequest = {
    name: input.name,
    symbol: input.symbol,
    logoURI: input.logoURI,
    xAccount: input.xAccount,
    website: input.website,
    extraLink: input.extraLink,
    graduationTarget: input.graduationTargetWei.toString(),
  };

  const authResponse = await readJson<any>(await apiFetch("/api/routing/create-authorization", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      walletAddress: creatorAddress,
      chainId: input.chainId,
      factoryAddress,
      campaignRequest,
      stockToken: stockTokenAddress,
      graduationMarketKind: "STOCK_TOKEN",
      graduationMarketPolicyVersion: "robinhood_market_v1",
    }),
  }));

  const auth = authResponse?.authorization;
  const market = authResponse?.graduationMarket;
  if (!auth?.signature || !auth?.validUntil) throw new Error("Stock create authorization is incomplete.");
  if (String(market?.kind || "") !== "STOCK_TOKEN") throw new Error("Server did not authorize a Stock Battlefield market.");
  if (normalizeAddress(market?.quoteAsset, "authorized Stock Token") !== stockTokenAddress) {
    throw new Error("Authorized Stock Token does not match the creator selection.");
  }
  if (String(market?.marketPolicyVersion || "") !== "robinhood_market_v1") {
    throw new Error("Unsupported Stock Battlefield market policy version.");
  }

  const factory = new Contract(factoryAddress, STOCK_FACTORY_ABI, input.signer) as any;
  const tx = await factory.createStockCampaignAuthorized(
    campaignRequest,
    stockTokenAddress,
    {
      tradeRouteProfile: Number(auth.tradeRouteProfileId),
      finalizeRouteProfile: Number(auth.finalizeRouteProfileId),
      deadline: Math.floor(new Date(auth.validUntil).getTime() / 1000),
      signature: auth.signature,
    },
  );
  const receipt = await tx.wait();
  if (!receipt) throw new Error("Stock campaign transaction did not return a receipt.");
  const created = extractCampaignCreated(receipt);
  await mirrorCampaign(input, created);

  return {
    receipt,
    ...created,
    graduationMarket: {
      kind: "STOCK_TOKEN",
      quoteAsset: stockTokenAddress,
      marketPolicyVersion: "robinhood_market_v1",
    },
  };
}

export const robinhoodStockCreateInternals = {
  requireRobinhoodChain,
};
