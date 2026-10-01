import { Contract, ethers } from "ethers";
import LaunchCampaignArtifact from "@/abi/LaunchCampaign.json";
import LaunchTokenArtifact from "@/abi/LaunchToken.json";
import { type SupportedChainId } from "@/lib/chainConfig";
import { getReadProvider } from "@/lib/readProvider";

const CAMPAIGN_ABI = LaunchCampaignArtifact.abi as ethers.InterfaceAbi;
const TOKEN_ABI = LaunchTokenArtifact.abi as ethers.InterfaceAbi;
const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)",
] as const;
const WAD = 10n ** 18n;

export type OnChainCampaignStats = {
  marketCapBnb?: number;
  volumeBnb?: number;
  raisedTotalBnb?: number;
  holdersCount?: number;
  athMarketCapBnb?: number;
  isDexTrading?: boolean;
  status?: "live" | "graduated";
  priceBnb?: number;
  liquidityBnb?: number;
  /** Native held by a bonding campaign right now, 0 included (an emptied curve holds exactly 0). */
  bondingReserveBnb?: number;
  dexPairAddress?: string;
};

function toNumberFromWei(value: bigint): number | undefined {
  try {
    const n = Number(ethers.formatEther(value));
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

function isAddress(value: unknown) {
  return ethers.isAddress(String(value ?? "").trim());
}

export async function fetchOnChainCampaignStats(input: {
  chainId: SupportedChainId;
  campaignAddress: string;
  tokenAddress?: string | null;
}): Promise<OnChainCampaignStats | null> {
  const campaignAddress = String(input.campaignAddress || "").trim().toLowerCase();
  const tokenAddress = String(input.tokenAddress || "").trim().toLowerCase();
  if (!isAddress(campaignAddress)) return null;

  const provider = getReadProvider(input.chainId) as ethers.Provider;
  const campaign = new Contract(campaignAddress, CAMPAIGN_ABI, provider) as any;

  const [
    buyersCount,
    totalBuyVolumeWei,
    totalSellVolumeWei,
    currentPrice,
    sold,
    launched,
    reserveWei,
    graduation,
  ] = await Promise.all([
    campaign.buyersCount().catch(() => 0n),
    campaign.totalBuyVolumeWei().catch(() => 0n),
    campaign.totalSellVolumeWei().catch(() => 0n),
    campaign.currentPrice().catch(() => 0n),
    campaign.sold().catch(() => 0n),
    campaign.launched().catch(() => false),
    provider.getBalance(campaignAddress).catch(() => 0n),
    campaign.getGraduationState().catch(() => null),
  ]);

  let circulating = BigInt(String(sold ?? 0n));
  let postBurnSupply = 0n;
  let dexPairAddress = "";
  if (launched) {
    try {
      const pair = String(graduation?.[0] ?? graduation?.dexPair ?? "");
      if (isAddress(pair)) dexPairAddress = ethers.getAddress(pair).toLowerCase();
      postBurnSupply = BigInt(String(graduation?.[8] ?? graduation?.postBurnTotalSupply ?? 0n));
    } catch {
      // optional
    }
    if (isAddress(tokenAddress)) {
      try {
        const token = new Contract(tokenAddress, TOKEN_ABI, provider) as any;
        circulating = BigInt(String(await token.totalSupply()));
      } catch {
        if (postBurnSupply > 0n) circulating = postBurnSupply;
      }
    } else if (postBurnSupply > 0n) {
      circulating = postBurnSupply;
    }
  }

  const buyVolWei = BigInt(String(totalBuyVolumeWei ?? 0n));
  const sellVolWei = BigInt(String(totalSellVolumeWei ?? 0n));
  const volumeWei = buyVolWei + sellVolWei;
  let priceBnb = toNumberFromWei(BigInt(String(currentPrice ?? 0n)));
  let marketCapBnb =
    priceBnb && circulating > 0n
      ? Number(ethers.formatEther((BigInt(String(currentPrice ?? 0n)) * circulating) / WAD))
      : undefined;
  // Bonding liquidity ≈ curve reserve (BNB held by campaign), not mcap.
  let liquidityBnb = toNumberFromWei(BigInt(String(reserveWei ?? 0n)));
  // Raised = cumulative buy volume (not the same as spot mcap).
  let raisedTotalBnb = toNumberFromWei(buyVolWei);
  if (raisedTotalBnb == null || raisedTotalBnb <= 0) raisedTotalBnb = liquidityBnb;

  // After graduation, bonding reserve is empty — prefer Topaz pool reserves for spot metrics.
  if (launched && isAddress(dexPairAddress) && isAddress(tokenAddress)) {
    try {
      const pool = new Contract(dexPairAddress, POOL_ABI, provider) as any;
      const [token0, token1, reserves] = await Promise.all([
        pool.token0(),
        pool.token1(),
        pool.getReserves(),
      ]);
      const tokenIs0 = String(token0).toLowerCase() === String(tokenAddress).toLowerCase();
      const reserveToken = BigInt(String(tokenIs0 ? reserves[0] : reserves[1]));
      const reserveNative = BigInt(String(tokenIs0 ? reserves[1] : reserves[0]));
      const tokenNum = toNumberFromWei(reserveToken);
      const nativeNum = toNumberFromWei(reserveNative);
      if (tokenNum && tokenNum > 0 && nativeNum && nativeNum > 0) {
        priceBnb = nativeNum / tokenNum;
        liquidityBnb = nativeNum * 2;
        raisedTotalBnb = liquidityBnb;
        if (circulating > 0n && priceBnb > 0) {
          marketCapBnb = priceBnb * Number(ethers.formatUnits(circulating, 18));
        }
      }
    } catch {
      // Keep bonding-derived fallbacks when pool reads fail.
    }
  }

  if (marketCapBnb != null && !Number.isFinite(marketCapBnb)) marketCapBnb = undefined;

  return {
    marketCapBnb,
    volumeBnb: toNumberFromWei(volumeWei),
    raisedTotalBnb,
    holdersCount: Number(buyersCount ?? 0n),
    athMarketCapBnb: marketCapBnb,
    isDexTrading: Boolean(launched),
    status: launched ? "graduated" : "live",
    priceBnb: priceBnb && priceBnb > 0 ? priceBnb : undefined,
    liquidityBnb: liquidityBnb && liquidityBnb > 0 ? liquidityBnb : undefined,
    bondingReserveBnb: launched ? undefined : toNumberFromWei(BigInt(String(reserveWei ?? 0n))),
    dexPairAddress: dexPairAddress || undefined,
  };
}
