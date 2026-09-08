import { useEffect, useState } from "react";
import { Contract, ethers } from "ethers";
import type { CampaignSummary } from "@/lib/launchpadClient";
import type { TokenBalanceRow } from "@/types/profilePage";
import { pickTokenAddressFromSummary } from "@/lib/profile/profileFormatters";
import { resolveImageUri } from "@/lib/media";
import {
  derivePortfolioMetrics,
  calculateHoldingValueUsd,
  type PortfolioMetrics,
} from "@/lib/profile/portfolioCalculations";
import { getReadProvider } from "@/lib/readProvider";
import {
  getActiveChainId,
  isEvmChainId,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_TESTNET_CHAIN_ID,
} from "@/lib/chainConfig";
import { useNativeUsdPrice } from "@/hooks/useNativeUsdPrice";
import { isSolanaAddress } from "@/lib/address";
import { getSolanaReadConnection } from "@/lib/solanaReadConnection";

const ERC20_ABI_MIN = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "decimals", type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "symbol", type: "string" }],
  },
] as const;

const MAX_BALANCE_SCAN_CAMPAIGNS = 40;
const MAX_VALUED_HOLDINGS = 12;
const BALANCE_BATCH_SIZE = 8;

type FetchCampaigns = () => Promise<any[]>;
type FetchCampaignSummary = (campaign: any) => Promise<CampaignSummary>;

interface UseProfileBalancesArgs {
  viewedAddress: string | null;
  account: string | null;
  wallet: any;
  fetchCampaigns: FetchCampaigns;
  fetchCampaignSummary: FetchCampaignSummary;
  profileCreatedAt?: string | null;
  chainId?: number | null;
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function metadataFromCampaign(campaign: any) {
  const nested = campaign?.campaign && typeof campaign.campaign === "object" ? campaign.campaign : null;
  return {
    campaignAddress: firstText(
      campaign?.campaignAddress,
      nested?.campaignAddress,
      nested?.campaign,
      typeof campaign?.campaign === "string" ? campaign.campaign : "",
    ),
    tokenAddress: firstText(
      campaign?.tokenAddress,
      campaign?.token,
      nested?.tokenAddress,
      nested?.token,
      nested?.mint,
    ),
    name: firstText(campaign?.name, nested?.name),
    ticker: firstText(campaign?.ticker, campaign?.symbol, nested?.ticker, nested?.symbol),
    image: resolveImageUri(firstText(
      campaign?.image,
      campaign?.logoURI,
      campaign?.logoUri,
      campaign?.logoUrl,
      nested?.image,
      nested?.logoURI,
      nested?.logoUri,
      nested?.logoUrl,
    )) || "",
  };
}

function metadataFromSummary(summary?: CampaignSummary | null) {
  const anySummary: any = summary as any;
  const campaign = anySummary?.campaign && typeof anySummary.campaign === "object" ? anySummary.campaign : anySummary;
  return metadataFromCampaign({
    ...campaign,
    campaignAddress: firstText(campaign?.campaignAddress, campaign?.campaign, anySummary?.campaignAddress),
    tokenAddress: firstText(
      pickTokenAddressFromSummary(summary as CampaignSummary),
      campaign?.tokenAddress,
      campaign?.token,
      anySummary?.tokenAddress,
      anySummary?.token,
    ),
    name: firstText(campaign?.name, anySummary?.name),
    ticker: firstText(campaign?.ticker, campaign?.symbol, anySummary?.ticker, anySummary?.symbol),
    image: firstText(
      campaign?.image,
      campaign?.logoURI,
      campaign?.logoUri,
      campaign?.logoUrl,
      anySummary?.image,
      anySummary?.logoURI,
      anySummary?.logoUri,
      anySummary?.logoUrl,
    ),
  });
}

function enrichBalanceRow(row: TokenBalanceRow, campaign?: any, summary?: CampaignSummary | null): TokenBalanceRow {
  const campaignMeta = metadataFromCampaign(campaign);
  const summaryMeta = metadataFromSummary(summary);
  const tokenFallback = firstText(row.tokenAddress);
  return {
    ...row,
    campaignAddress: firstText(summaryMeta.campaignAddress, campaignMeta.campaignAddress, row.campaignAddress, tokenFallback),
    tokenAddress: firstText(summaryMeta.tokenAddress, campaignMeta.tokenAddress, row.tokenAddress),
    image: firstText(summaryMeta.image, campaignMeta.image, resolveImageUri(row.image), "/placeholder.svg"),
    name: firstText(summaryMeta.name, campaignMeta.name, row.name, "Unknown token"),
    ticker: firstText(summaryMeta.ticker, campaignMeta.ticker, row.ticker, tokenFallback.slice(0, 4)),
  };
}

export function useProfileBalances({
  viewedAddress,
  account,
  wallet,
  fetchCampaigns,
  fetchCampaignSummary,
  profileCreatedAt,
  chainId: chainIdOverride,
}: UseProfileBalancesArgs) {
  const [nativeBalance, setNativeBalance] = useState<string>("");
  const [tokenBalances, setTokenBalances] = useState<TokenBalanceRow[]>([]);
  const [loadingBalances, setLoadingBalances] = useState(false);
  const [portfolioMetrics, setPortfolioMetrics] = useState<PortfolioMetrics | null>(null);
  const [loadingPortfolioMetrics, setLoadingPortfolioMetrics] = useState(false);
  const walletChainId = wallet?.chainId ?? wallet?.network?.chainId;
  const requestedChainId = Number(chainIdOverride);
  const effectiveEvmChainId = isEvmChainId(requestedChainId)
    ? requestedChainId
    : getActiveChainId(walletChainId);
  const robinhood = effectiveEvmChainId === ROBINHOOD_CHAIN_ID || effectiveEvmChainId === ROBINHOOD_TESTNET_CHAIN_ID;
  const nativeSymbol = robinhood ? "ETH" : "BNB";
  const { price: nativeUsdPrice } = useNativeUsdPrice(effectiveEvmChainId);

  useEffect(() => {
    let cancelled = false;

    const resolveReadProvider = (): ethers.Provider | null => {
      const chainId = Number(chainIdOverride);
      const resolved = isEvmChainId(chainId) ? chainId : getActiveChainId(walletChainId);
      return isEvmChainId(resolved) ? getReadProvider(resolved) as ethers.Provider : null;
    };

    const loadBalances = async () => {
      try {
        const targetRaw = String(viewedAddress || account || "").trim();
        if (isSolanaAddress(targetRaw)) {
          setLoadingBalances(true);
          setLoadingPortfolioMetrics(true);
          try {
            const { PublicKey } = await import("@solana/web3.js");
            const conn = getSolanaReadConnection();
            const owner = new PublicKey(targetRaw);
            const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
            const lamports = await conn.getBalance(owner, "confirmed");
            const sol = (Number(lamports) / 1_000_000_000).toFixed(4);
            if (!cancelled) setNativeBalance(`${sol} SOL`);

            let rows: TokenBalanceRow[] = [];
            try {
              const [tokenAccounts, campaigns] = await Promise.all([
                conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM }).catch(() => ({ value: [] as any[] })),
                fetchCampaigns().catch(() => [] as any[]),
              ]);
              const campaignByMint = new Map<string, any>();
              for (const campaign of campaigns || []) {
                const meta = metadataFromCampaign(campaign);
                if (meta.tokenAddress) campaignByMint.set(meta.tokenAddress, campaign);
              }

              const owned: Array<{ row: TokenBalanceRow; campaign?: any }> = [];
              for (const item of tokenAccounts.value || []) {
                const info = item?.account?.data?.parsed?.info;
                const mint = String(info?.mint || "").trim();
                const amount = String(info?.tokenAmount?.amount || "0");
                const ui = Number(info?.tokenAmount?.uiAmount ?? 0);
                if (!mint || !Number.isFinite(ui) || ui <= 0) continue;
                const campaign = campaignByMint.get(mint);
                const baseMeta = metadataFromCampaign(campaign);
                owned.push({
                  campaign,
                  row: {
                    campaignAddress: firstText(baseMeta.campaignAddress, mint),
                    tokenAddress: mint,
                    image: firstText(baseMeta.image, "/placeholder.svg"),
                    name: firstText(baseMeta.name, "Solana token"),
                    ticker: firstText(baseMeta.ticker, mint.slice(0, 4)),
                    balanceRaw: BigInt(amount),
                    balanceFormatted: String(info?.tokenAmount?.uiAmountString || ui),
                  },
                });
              }

              const summaries = await Promise.allSettled(
                owned.map(({ campaign }) => campaign ? fetchCampaignSummary(campaign) : Promise.resolve(null as any)),
              );
              rows = owned.map(({ row, campaign }, index) => {
                const result = summaries[index];
                const summary = result?.status === "fulfilled" ? result.value : null;
                return enrichBalanceRow(row, campaign, summary);
              });
            } catch {
              rows = [];
            }

            if (!cancelled) {
              setTokenBalances(rows);
              setPortfolioMetrics({
                totalValueUsd: null,
                topHolding: rows[0]
                  ? { ticker: rows[0].ticker, percentOfPortfolio: 0, valueUsd: 0 }
                  : null,
                coinsCount: rows.length,
                walletAge: profileCreatedAt ? "on-chain" : "new",
              });
            }
          } catch {
            if (!cancelled) {
              setNativeBalance("");
              setTokenBalances([]);
              setPortfolioMetrics(null);
            }
          } finally {
            if (!cancelled) {
              setLoadingBalances(false);
              setLoadingPortfolioMetrics(false);
            }
          }
          return;
        }

        if (!targetRaw || !ethers.isAddress(targetRaw)) {
          setNativeBalance("");
          setTokenBalances([]);
          return;
        }
        const target = ethers.getAddress(targetRaw);
        const readProvider = resolveReadProvider();
        if (!readProvider) {
          setNativeBalance("");
          setTokenBalances([]);
          return;
        }

        setLoadingBalances(true);
        setLoadingPortfolioMetrics(true);

        const bal = await readProvider.getBalance(target);
        const native = Number(ethers.formatUnits(bal, 18)).toFixed(4);
        const nativeForMetrics = Number.parseFloat(native) || 0;
        if (!cancelled) setNativeBalance(`${native} ${nativeSymbol}`);

        const campaigns = ((await fetchCampaigns()) ?? [])
          .filter((campaign) => ethers.isAddress(metadataFromCampaign(campaign).tokenAddress))
          .slice(0, MAX_BALANCE_SCAN_CAMPAIGNS);
        const rows: TokenBalanceRow[] = [];
        const ownedCampaigns: any[] = [];

        for (let start = 0; start < campaigns.length; start += BALANCE_BATCH_SIZE) {
          if (cancelled) return;
          const batch = campaigns.slice(start, start + BALANCE_BATCH_SIZE);
          const settled = await Promise.allSettled(batch.map(async (campaign) => {
            const meta = metadataFromCampaign(campaign);
            const tokenAddr = meta.tokenAddress.toLowerCase();
            if (!tokenAddr || !ethers.isAddress(tokenAddr)) return null;

            const erc20 = new Contract(tokenAddr as any, ERC20_ABI_MIN as any, readProvider);
            const rawBal = await erc20.balanceOf(target) as bigint;
            if (typeof rawBal !== "bigint" || rawBal <= 0n) return null;

            const [decimalsAny, symbolMaybe] = await Promise.all([
              (erc20.decimals() as Promise<any>).catch(() => 18),
              (erc20.symbol() as Promise<string>).catch(() => null) as Promise<string | null>,
            ]);

            const decimals = Number(decimalsAny);
            const formatted = ethers.formatUnits(rawBal, Number.isFinite(decimals) ? decimals : 18);
            return {
              campaign,
              row: {
                campaignAddress: firstText(meta.campaignAddress, tokenAddr),
                tokenAddress: tokenAddr,
                image: firstText(meta.image, "/placeholder.svg"),
                name: firstText(meta.name, "Unknown token"),
                ticker: firstText(meta.ticker, symbolMaybe, ""),
                balanceRaw: rawBal,
                balanceFormatted: formatted,
              } as TokenBalanceRow,
            };
          }));

          for (const result of settled) {
            if (result.status !== "fulfilled" || !result.value) continue;
            rows.push(result.value.row);
            ownedCampaigns.push(result.value.campaign);
          }
        }

        try {
          const valuedSummaries = await Promise.allSettled(
            ownedCampaigns.slice(0, MAX_VALUED_HOLDINGS).map((campaign) => fetchCampaignSummary(campaign)),
          );
          const fulfilled = valuedSummaries
            .filter((r): r is PromiseFulfilledResult<CampaignSummary> => r.status === "fulfilled")
            .map((r) => r.value);

          const enrichedRows = rows.map((row, index) => {
            const campaign = ownedCampaigns[index];
            const matchingSummary = fulfilled.find((summary) => {
              const summaryToken = String(pickTokenAddressFromSummary(summary) || "").toLowerCase();
              return summaryToken === row.tokenAddress.toLowerCase();
            });
            return enrichBalanceRow(row, campaign, matchingSummary);
          }).sort((a, b) => (a.balanceRaw > b.balanceRaw ? -1 : 1));

          if (!cancelled) setTokenBalances(enrichedRows);

          const tokenHoldingsWithValues = enrichedRows.map((row) => {
            const matchingSummary = fulfilled.find(
              (summary) => String(pickTokenAddressFromSummary(summary) || "").toLowerCase() === row.tokenAddress.toLowerCase(),
            );
            const marketCapNative = matchingSummary?.stats?.marketCapBnb;
            const valueUsd = calculateHoldingValueUsd(row.balanceFormatted, marketCapNative, nativeUsdPrice ?? 0);
            return {
              ticker: row.ticker || row.name || "???",
              valueUsd,
            };
          });

          const effectiveTimestamp = profileCreatedAt
            ? Math.floor(new Date(profileCreatedAt).getTime() / 1000)
            : null;

          // Portfolio calculation retains legacy field names, but the values are native-chain
          // amounts/prices. On Robinhood this is ETH + ETH/USD, never BNB + BNB/USD.
          const metrics = derivePortfolioMetrics({
            nativeBnb: nativeForMetrics,
            tokenHoldingsWithValues,
            bnbUsd: nativeUsdPrice ?? 0,
            firstActivityTimestamp: effectiveTimestamp,
          });

          if (!cancelled) setPortfolioMetrics(metrics);
        } catch (calcErr) {
          console.warn("[Profile] Portfolio metrics derivation failed (non-fatal)", calcErr);
          if (!cancelled) {
            setTokenBalances(rows.map((row, index) => enrichBalanceRow(row, ownedCampaigns[index], null)));
            setPortfolioMetrics(null);
          }
        }
      } catch (e) {
        console.error("[Profile] Failed to load balances", e);
        if (!cancelled) {
          setNativeBalance("");
          setTokenBalances([]);
          setPortfolioMetrics(null);
        }
      } finally {
        if (!cancelled) {
          setLoadingBalances(false);
          setLoadingPortfolioMetrics(false);
        }
      }
    };

    loadBalances();

    return () => {
      cancelled = true;
    };
  }, [
    viewedAddress,
    account,
    fetchCampaigns,
    fetchCampaignSummary,
    walletChainId,
    profileCreatedAt,
    nativeUsdPrice,
    chainIdOverride,
    nativeSymbol,
  ]);

  return {
    nativeBalance,
    tokenBalances,
    loadingBalances,
    portfolioMetrics,
    loadingPortfolioMetrics: loadingBalances || loadingPortfolioMetrics,
  };
}
