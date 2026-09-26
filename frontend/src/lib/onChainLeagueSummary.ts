import { Contract, ethers } from "ethers";
import LaunchCampaignArtifact from "@/abi/LaunchCampaign.json";
import { fetchOnChainCampaignPage } from "@/lib/onChainCampaignFeed";
import { type SupportedChainId } from "@/lib/chainConfig";
import { getReadProvider } from "@/lib/readProvider";
import type { LeaguePeriod } from "@/lib/leagues";
import type { LeaguePrizeMeta, LeagueSummaryCard } from "@/lib/leagueApi";
import { pokerPaidPlaces, pokerSplitRaw } from "../../shared/pokerPayout.mjs";

const CAMPAIGN_ABI = LaunchCampaignArtifact.abi as ethers.InterfaceAbi;
const MAX_CAMPAIGNS = 100;
const LOOKBACK_BLOCKS = 50_000;
const LOG_CHUNK_SIZE = 700;

type CampaignMeta = {
  campaign: string;
  token: string;
  name: string;
  symbol: string;
  logoURI: string;
};

type TradeRow = {
  campaign_address: string;
  campaignAddress: string;
  token?: string;
  name?: string;
  symbol?: string;
  logo_uri?: string;
  wallet?: string;
  buyer_address?: string;
  bnb_amount_raw?: string;
  profit_raw?: string;
  trades_count?: number;
  tx_hash?: string;
  log_index?: number;
  block_number?: number;
};

export type OnChainLeagueSummary = {
  prize: LeaguePrizeMeta;
  cards: Partial<Record<"biggest_hit" | "top_earner", LeagueSummaryCard>>;
};

function toRaw(value: bigint) {
  return value > 0n ? value.toString() : "0";
}

// Poker payout, the settlement job's rule (shared/pokerPayout.mjs). The fallback has no per-category
// field, so the campaigns that traded this epoch stand in for it.
function splitPayouts(potRaw: bigint, places: number): string[] {
  return pokerSplitRaw(potRaw, places).map((x: bigint) => toRaw(x));
}

function addWei(map: Map<string, bigint>, key: string, delta: bigint) {
  map.set(key, (map.get(key) ?? 0n) + delta);
}

async function getLogsChunked(
  provider: ethers.Provider,
  params: { address: string; topics?: (string | string[] | null)[] },
  fromBlock: number,
  toBlock: number,
) {
  const logs: ethers.Log[] = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK_SIZE) {
    const end = Math.min(toBlock, start + LOG_CHUNK_SIZE - 1);
    logs.push(...(await provider.getLogs({ ...params, fromBlock: start, toBlock: end } as any)));
  }
  return logs;
}

function normalizeAddress(value: unknown) {
  const raw = String(value ?? "").trim();
  return ethers.isAddress(raw) ? raw.toLowerCase() : "";
}

export async function fetchOnChainLeagueSummary(chainId: SupportedChainId, period: LeaguePeriod): Promise<OnChainLeagueSummary | null> {
  const page = await fetchOnChainCampaignPage(chainId, { limit: MAX_CAMPAIGNS });
  const campaigns = page.campaigns.filter((campaign) => ethers.isAddress(campaign.campaign));
  if (!campaigns.length) return null;

  const provider = getReadProvider(chainId) as ethers.Provider;
  const iface = new ethers.Interface(CAMPAIGN_ABI);
  const buyTopic = iface.getEvent("TokensPurchased")?.topicHash;
  const sellTopic = iface.getEvent("TokensSold")?.topicHash;
  const latestBlock = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latestBlock - LOOKBACK_BLOCKS);

  let totalLeagueFeeRaw = 0n;
  let activeCampaigns = 0;
  const biggestBuys: TradeRow[] = [];
  const traderPnl = new Map<string, bigint>();
  const traderTrades = new Map<string, number>();

  await Promise.all(
    campaigns.map(async (info) => {
      const address = normalizeAddress(info.campaign);
      if (!address) return;

      const campaign = new Contract(address, CAMPAIGN_ABI, provider) as any;
      const [totalBuyRaw, totalSellRaw, leagueFeeBpsRaw] = await Promise.all([
        campaign.totalBuyVolumeWei().catch(() => 0n),
        campaign.totalSellVolumeWei().catch(() => 0n),
        campaign.leagueFeeBps().catch(() => 0n),
      ]);

      const totalBuy = BigInt(String(totalBuyRaw ?? 0n));
      const totalSell = BigInt(String(totalSellRaw ?? 0n));
      const leagueFeeBps = BigInt(String(leagueFeeBpsRaw ?? 0n));
      const leagueFee = ((totalBuy + totalSell) * leagueFeeBps) / 10_000n;
      totalLeagueFeeRaw += leagueFee;
      if (totalBuy > 0n || totalSell > 0n) activeCampaigns += 1;

      const meta: CampaignMeta = {
        campaign: address,
        token: normalizeAddress(info.token),
        name: info.name || "Unknown",
        symbol: info.symbol || "",
        logoURI: info.logoURI || "",
      };

      if (!buyTopic || !sellTopic) return;
      const [buyLogs, sellLogs] = await Promise.all([
        getLogsChunked(provider, { address, topics: [buyTopic] }, fromBlock, latestBlock).catch(() => []),
        getLogsChunked(provider, { address, topics: [sellTopic] }, fromBlock, latestBlock).catch(() => []),
      ]);

      for (const log of buyLogs) {
        const parsed = iface.parseLog(log);
        if (!parsed) continue;
        const buyer = normalizeAddress(parsed.args.buyer);
        const cost = BigInt(String(parsed.args.cost ?? 0n));
        if (buyer) {
          addWei(traderPnl, buyer, -cost);
          traderTrades.set(buyer, (traderTrades.get(buyer) ?? 0) + 1);
        }
        biggestBuys.push({
          campaign_address: meta.campaign,
          campaignAddress: meta.campaign,
          token: meta.token,
          name: meta.name,
          symbol: meta.symbol,
          logo_uri: meta.logoURI,
          buyer_address: buyer,
          bnb_amount_raw: toRaw(cost),
          tx_hash: String(log.transactionHash || ""),
          log_index: Number(log.index ?? 0),
          block_number: Number(log.blockNumber ?? 0),
        });
      }

      for (const log of sellLogs) {
        const parsed = iface.parseLog(log);
        if (!parsed) continue;
        const seller = normalizeAddress(parsed.args.seller);
        const payout = BigInt(String(parsed.args.payout ?? 0n));
        if (!seller) continue;
        addWei(traderPnl, seller, payout);
        traderTrades.set(seller, (traderTrades.get(seller) ?? 0) + 1);
      }
    }),
  );

  const nowIso = new Date().toISOString();
  const potRaw = totalLeagueFeeRaw;
  const paidPlaces = pokerPaidPlaces(activeCampaigns, period);
  const payoutsRaw = splitPayouts(potRaw, paidPlaces);
  const prize: LeaguePrizeMeta = {
    basis: "onchain_live_campaign_counters",
    period,
    computedAt: nowIso,
    totalLeagueFeeRaw: toRaw(totalLeagueFeeRaw),
    leagueCount: activeCampaigns,
    winners: paidPlaces,
    splitBps: payoutsRaw.map((x) => (potRaw > 0n ? Number((BigInt(x) * 10_000n) / potRaw) : 0)),
    potRaw: toRaw(potRaw),
    availablePotRaw: toRaw(potRaw),
    payoutsRaw,
    warning: "Live on-chain fallback until the league indexer catches up.",
  };

  const biggestHitRows = biggestBuys
    .sort((a, b) => {
      const av = BigInt(a.bnb_amount_raw ?? "0");
      const bv = BigInt(b.bnb_amount_raw ?? "0");
      if (av === bv) return Number(b.block_number ?? 0) - Number(a.block_number ?? 0);
      return bv > av ? 1 : -1;
    })
    .slice(0, 50);

  const topEarnerRows = Array.from(traderPnl.entries())
    .filter(([, pnl]) => pnl > 0n)
    .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
    .slice(0, 50)
    .map(([wallet, pnl]) => ({
      wallet,
      profit_raw: toRaw(pnl),
      trades_count: traderTrades.get(wallet) ?? 0,
    }));

  return {
    prize,
    cards: {
      biggest_hit: {
        key: "biggest_hit",
        title: "Biggest Hit",
        status: biggestHitRows.length ? "ready" : "empty",
        entrants: biggestHitRows.length,
        rows: biggestHitRows,
        prize,
        warning: prize.warning,
      },
      top_earner: {
        key: "top_earner",
        title: "Top Earner",
        status: topEarnerRows.length ? "ready" : "empty",
        entrants: topEarnerRows.length,
        rows: topEarnerRows,
        prize,
        warning: prize.warning,
      },
    },
  };
}
