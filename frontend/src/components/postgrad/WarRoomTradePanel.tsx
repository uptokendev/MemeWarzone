import { useCallback, useEffect, useMemo, useState } from "react";
import { assertWalletOnChain } from "@/lib/walletChainGuard.mjs";
import { gasWithHeadroom } from "@/lib/evmGasHeadroom.mjs";
import { Contract, ethers } from "ethers";
import type { CampaignInfo, CampaignMetrics } from "@/lib/launchpadClient";
import { isUnsupportedContractMethod } from "@/lib/launchpadClient";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { campaignWalletMatches } from "@/lib/activeWalletChain";
import { useActiveWalletKind } from "@/hooks/useActiveWalletKind";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { isSolanaChainId, SOLANA_CHAIN_ID, type SupportedChainId } from "@/lib/chainConfig";
import { isSolanaAddress } from "@/lib/address";
import { getReadProvider } from "@/lib/readProvider";
import { apiFetch } from "@/lib/apiBase";
import type { SolanaCampaignCurveState } from "@/lib/solanaCampaignRead";
import {
  ensureTopazSellAllowance,
  executeTopazBuy,
  executeTopazSell,
  quoteTopazBuy,
  quoteTopazSell,
  resolveVerifiedTopazRoute,
  solveNativeForExactTokens,
  solveTokensForExactNative,
} from "@/lib/topazV2Trade";
import { recordTopazFill } from "@/lib/recordTopazFill";
import LaunchCampaignArtifact from "@/abi/LaunchCampaign.json";
import LaunchTokenArtifact from "@/abi/LaunchToken.json";
import { SOLANA_BUY_FEE_RESERVE_LAMPORTS, evmBuyGasReserveWei } from "@/lib/tradeBalanceReserve";

const CAMPAIGN_ABI = [
  ...((LaunchCampaignArtifact.abi as any[]) ?? []),
  "function buyExactTokens(uint256 amountOut,uint256 maxCost) payable returns (uint256 cost)",
  "function sellExactTokens(uint256 amountIn,uint256 minPayout) returns (uint256 payout)",
  "function buyExactTokensAuthorized(uint256 amountOut,uint256 maxCost,uint8 routeProfile,uint64 routeDeadline,bytes routeSignature) payable returns (uint256 cost)",
  "function sellExactTokensAuthorized(uint256 amountIn,uint256 minPayout,uint8 routeProfile,uint64 routeDeadline,bytes routeSignature) returns (uint256 payout)",
] as ethers.InterfaceAbi;
const TOKEN_ABI = LaunchTokenArtifact.abi as ethers.InterfaceAbi;
const TOKEN_DECIMALS = 18;
const SLIPPAGE_PCT = 5;
const MAX_UINT256 = (1n << 256n) - 1n;
const LEGACY_TRADE_GAS_LIMIT = 650_000n;
const TRADE_AUTH_BUY_EXACT_TOKENS = 0;
const TRADE_AUTH_SELL_EXACT_TOKENS = 2;

async function fetchEvmCampaignMetrics(campaignAddress: string, chainId: number): Promise<CampaignMetrics | null> {
  if (!campaignAddress || isSolanaChainId(chainId)) return null;
  const provider = getReadProvider(chainId as SupportedChainId);
  const campaign = new Contract(campaignAddress, CAMPAIGN_ABI, provider) as any;
  const readBig = async (method: string, fallback = 0n): Promise<bigint> => {
    try {
      const fn = campaign?.[method];
      if (typeof fn !== "function") return fallback;
      return (await fn()) as bigint;
    } catch {
      return fallback;
    }
  };
  const [
    sold,
    curveSupply,
    liquiditySupply,
    creatorReserve,
    basePrice,
    priceSlope,
    graduationTarget,
    liquidityBps,
    protocolFeeBps,
    currentPrice,
  ] = await Promise.all([
    readBig("sold"),
    readBig("curveSupply"),
    readBig("liquiditySupply"),
    readBig("creatorReserve"),
    readBig("basePrice"),
    readBig("priceSlope"),
    readBig("graduationTarget"),
    readBig("liquidityBps"),
    readBig("protocolFeeBps"),
    readBig("currentPrice"),
  ]);
  const [launched, finalizedAt] = await Promise.all([
    campaign.launched().catch(() => false),
    campaign.finalizedAt().catch(() => 0n),
  ]);
  const graduated = Boolean(launched) || BigInt(finalizedAt || 0n) > 0n;
  const graduationNativeTarget = graduated
    ? graduationTarget
    : await readBig("graduationNativeTarget", graduationTarget);
  return {
    sold,
    curveSupply,
    liquiditySupply,
    creatorReserve,
    basePrice,
    priceSlope,
    graduationTarget,
    graduationNativeTarget,
    liquidityBps,
    protocolFeeBps,
    currentPrice,
    launched,
    finalizedAt,
  };
}

function authLooksRequired(error: unknown) {
  return !isUnsupportedContractMethod(error) && !String((error as any)?.message || error || "").includes("trade-authorization HTTP");
}

async function requestCampaignTradeAuthorization(params: {
  walletAddress: string;
  campaignAddress: string;
  chainId: number;
  action: number;
  amount: bigint;
  limit: bigint;
}) {
  const response = await apiFetch("/api/routing/trade-authorization", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      walletAddress: params.walletAddress,
      campaignAddress: params.campaignAddress,
      chainId: params.chainId,
      action: params.action,
      amount: params.amount.toString(),
      limit: params.limit.toString(),
    }),
  });
  if (!response.ok) throw new Error(`trade-authorization HTTP ${response.status}`);
  return response.json();
}

function formatBnbFromWei(wei?: bigint | null): string {
  if (wei == null) return "—";
  try {
    const raw = ethers.formatEther(wei);
    const n = Number(raw);
    if (!Number.isFinite(n)) return `${raw} BNB`;
    const pretty = n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(4) : n.toFixed(6);
    return `${pretty} BNB`;
  } catch {
    return "—";
  }
}

function formatTokenFromWei(wei?: bigint | null): string {
  if (wei == null) return "—";
  try {
    const raw = ethers.formatUnits(wei, TOKEN_DECIMALS);
    const n = Number(raw);
    if (!Number.isFinite(n)) return raw;
    const pretty = n >= 1 ? n.toFixed(4) : n >= 0.01 ? n.toFixed(6) : n.toFixed(8);
    return pretty;
  } catch {
    return "—";
  }
}

function parseTokenAmountWei(value: string): bigint {
  const v = (value ?? "").trim();
  if (!v || v === "." || v === "-") return 0n;
  const cleaned = v.replace(/,/g, ".").replace(/[^0-9.]/g, "");
  const parts = cleaned.split(".");
  const normalized = parts.length <= 2 ? cleaned : `${parts[0]}.${parts.slice(1).join("")}`;
  try {
    return ethers.parseUnits(normalized || "0", TOKEN_DECIMALS);
  } catch {
    return 0n;
  }
}

function parseSolLamports(value: string): bigint {
  const v = (value ?? "").trim();
  if (!v || v === "." || v === "-") return 0n;
  const cleaned = v.replace(/,/g, ".").replace(/[^0-9.]/g, "");
  const parts = cleaned.split(".");
  const whole = BigInt(parts[0] || "0");
  const frac = (parts[1] || "").slice(0, 9).padEnd(9, "0");
  try {
    return whole * 1_000_000_000n + BigInt(frac || "0");
  } catch {
    return 0n;
  }
}

function parseTokenAmountDecimals(value: string, decimals: number): bigint {
  const v = (value ?? "").trim();
  if (!v || v === "." || v === "-") return 0n;
  const cleaned = v.replace(/,/g, ".").replace(/[^0-9.]/g, "");
  const parts = cleaned.split(".");
  const whole = BigInt(parts[0] || "0");
  const frac = (parts[1] || "").slice(0, decimals).padEnd(decimals, "0");
  try {
    return whole * 10n ** BigInt(decimals) + BigInt(frac || "0");
  } catch {
    return 0n;
  }
}

function formatAmount(raw?: bigint | null, decimals = 18, symbol = ""): string {
  if (raw == null) return "—";
  try {
    const text = ethers.formatUnits(raw, decimals);
    const n = Number(text);
    if (!Number.isFinite(n)) return symbol ? `${text} ${symbol}` : text;
    const pretty = n >= 1 ? n.toFixed(decimals >= 9 ? 4 : 2) : n >= 0.01 ? n.toFixed(6) : n.toFixed(Math.min(8, decimals));
    return symbol ? `${pretty} ${symbol}` : pretty;
  } catch {
    return "—";
  }
}

function parseBnbAmountWei(value: string): bigint {
  const v = (value ?? "").trim();
  if (!v || v === "." || v === "-") return 0n;
  const cleaned = v.replace(/,/g, ".").replace(/[^0-9.]/g, "");
  const parts = cleaned.split(".");
  const normalized = parts.length <= 2 ? cleaned : `${parts[0]}.${parts.slice(1).join("")}`;
  try {
    return ethers.parseEther(normalized || "0");
  } catch {
    return 0n;
  }
}

export function WarRoomTradePanel({ campaign }: { campaign: CampaignInfo }) {
  const { toast } = useToast();
  const wallet = useWallet();
  const solanaWallet = useSolanaWallet();
  const activeWalletKind = useActiveWalletKind();
  const [metrics, setMetrics] = useState<CampaignMetrics | null>(null);
  const [solanaCurve, setSolanaCurve] = useState<SolanaCampaignCurveState | null>(null);
  const [tradeAmount, setTradeAmount] = useState("0");
  const [tradeInputDenom, setTradeInputDenom] = useState<"TOKEN" | "BNB">("BNB");
  const [effectiveTokenWei, setEffectiveTokenWei] = useState<bigint>(0n);
  const [effectiveBnbWei, setEffectiveBnbWei] = useState<bigint>(0n);
  const [tradeTab, setTradeTab] = useState<"buy" | "sell">("buy");
  const [quoteWei, setQuoteWei] = useState<bigint | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [tradePending, setTradePending] = useState(false);
  const [approvePending, setApprovePending] = useState(false);
  const [bnbBalanceWei, setBnbBalanceWei] = useState<bigint | null>(null);
  const [tokenBalanceWei, setTokenBalanceWei] = useState<bigint | null>(null);
  const [topazSlippageBps] = useState(100);

  const isSolanaCampaign =
    isSolanaAddress(campaign.campaign) ||
    isSolanaAddress(campaign.token) ||
    Number((campaign as { chainId?: number }).chainId) === SOLANA_CHAIN_ID;
  const nativeUnit = isSolanaCampaign ? "SOL" : "BNB";
  const walletMatchesCampaign = campaignWalletMatches({
    isSolanaCampaign,
    storedKind: activeWalletKind,
    solanaConnected: Boolean(solanaWallet.isSolanaConnected && solanaWallet.solanaAccount),
    bnbConnected: Boolean(wallet.isConnected && wallet.account),
  });
  const connectTradeWalletLabel = isSolanaCampaign ? "Connect SOL wallet" : "Connect BNB wallet";
  const openWalletModal = () => {
    try { window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal")); } catch { /* ignore */ }
  };
  const tokenDecimals = isSolanaCampaign ? Number(solanaCurve?.tokenDecimals ?? 6) : TOKEN_DECIMALS;
  const solanaDex = Boolean(solanaCurve?.graduated || solanaCurve?.curveClosed);

  const chainId = useMemo(() => {
    if (isSolanaCampaign) return SOLANA_CHAIN_ID;
    const fromCampaign = Number((campaign as { chainId?: number }).chainId);
    if (fromCampaign === 56 || fromCampaign === 97) return fromCampaign;
    return 97;
  }, [campaign, isSolanaCampaign]);
  const readProvider = useMemo(() => {
    if (isSolanaCampaign || isSolanaChainId(chainId)) return null;
    return getReadProvider(chainId);
  }, [chainId, isSolanaCampaign]);

  // UI redesign: artboard trade panel classes (presentation only).
  const segListClass = "grid h-auto w-full grid-cols-2 gap-1 rounded-[10px] border border-[#242A31] bg-[#13171C] p-1";
  const segTriggerClass =
    "min-h-10 rounded-lg border-0 bg-transparent font-mw-body text-[15px] font-bold text-mw-muted shadow-none hover:text-mw-text";
  const chipClass =
    "mw-focus inline-flex min-h-[30px] items-center justify-center rounded-lg border border-[#2E353D] bg-[#171B20] px-2.5 font-mw-mono text-[13px] text-[#C9CED4] hover:border-[#3A424C]";
  const chipOnClass = "border-mw-accent bg-[#2A1609] text-mw-accent-soft hover:border-mw-accent";
  const amountClass =
    "mw-focus h-12 w-full rounded-[10px] border border-[#2E353D] bg-mw-input pl-3.5 pr-20 font-mw-mono text-lg text-mw-text placeholder:text-[#5C6670] focus:border-mw-accent focus:outline-none";
  const isDexStage = useMemo(() => {
    if (isSolanaCampaign) return solanaDex;
    const hasLaunchFlag = (metrics as any)?.launched !== undefined || (metrics as any)?.finalizedAt !== undefined;
    return hasLaunchFlag
      ? Boolean((metrics as any)?.launched) ||
          (typeof (metrics as any)?.finalizedAt === "bigint"
            ? (metrics as any).finalizedAt > 0n
            : Number((metrics as any)?.finalizedAt ?? 0) > 0)
      : Boolean(metrics && metrics.curveSupply > 0n && metrics.sold >= metrics.curveSupply);
  }, [isSolanaCampaign, metrics, solanaDex]);
  const isTopazTradingActive = !isSolanaCampaign && isDexStage;

  const loadMetrics = useCallback(async () => {
    try {
      if (isSolanaCampaign) {
        const { resolveSolanaCampaignCurve } = await import("@/lib/solanaCampaignRead");
        const curve = await resolveSolanaCampaignCurve(String(campaign.campaign || campaign.token || ""));
        setSolanaCurve(curve);
        setMetrics(null);
        return;
      }
      const next = await fetchEvmCampaignMetrics(campaign.campaign, chainId);
      setMetrics(next);
    } catch (error) {
      console.warn("[WarRoomTradePanel] Failed to load metrics", error);
      setMetrics(null);
    }
  }, [campaign.campaign, campaign.token, chainId, isSolanaCampaign]);

  const loadBalances = useCallback(async () => {
    try {
      if (!walletMatchesCampaign) {
        setBnbBalanceWei(null);
        setTokenBalanceWei(null);
        return;
      }
      if (isSolanaCampaign) {
        const { getSolanaProvider } = await import("@/lib/solanaWallet");
        const { loadSolanaWeb3 } = await import("@/lib/solanaWeb3");
        const { getPublicRpcUrl } = await import("@/lib/chainConfig");
        const { getSolanaTokenBalanceRaw } = await import("@/lib/solanaTradeV1");
        const provider = getSolanaProvider();
        const pubkey = String(provider?.publicKey?.toString?.() || solanaWallet.solanaAccount || "").trim();
        if (!pubkey) {
          setBnbBalanceWei(null);
          setTokenBalanceWei(null);
          return;
        }
        const web3 = await loadSolanaWeb3();
        const connection = new web3.Connection(
          String(import.meta.env.VITE_SOLANA_RPC || "").trim() || getPublicRpcUrl(SOLANA_CHAIN_ID),
          { commitment: "confirmed", disableRetryOnRateLimit: true },
        );
        const lamports = BigInt(await connection.getBalance(new web3.PublicKey(pubkey)));
        const mint = String(campaign.token || campaign.campaign || "").trim();
        const tokenRaw = mint ? await getSolanaTokenBalanceRaw({ mint, owner: pubkey }) : 0n;
        setBnbBalanceWei(lamports);
        setTokenBalanceWei(tokenRaw);
        return;
      }

      if (!wallet.provider || !wallet.account) {
        setBnbBalanceWei(null);
        setTokenBalanceWei(null);
        return;
      }

      const [bnbBal, tokenBal] = await Promise.all([
        wallet.provider.getBalance(wallet.account),
        (async () => {
          try {
            if (!campaign.token) return 0n;
            const token = new Contract(campaign.token, TOKEN_ABI, wallet.provider) as any;
            return (await token.balanceOf(wallet.account)) as bigint;
          } catch {
            return 0n;
          }
        })(),
      ]);

      setBnbBalanceWei(bnbBal);
      setTokenBalanceWei(tokenBal);
    } catch (error) {
      console.warn("[WarRoomTradePanel] Failed to load balances", error);
      setBnbBalanceWei(null);
      setTokenBalanceWei(null);
    }
  }, [campaign.campaign, campaign.token, isSolanaCampaign, solanaWallet.solanaAccount, wallet.account, wallet.provider, walletMatchesCampaign]);

  useEffect(() => {
    loadMetrics();
  }, [loadMetrics]);

  useEffect(() => {
    loadBalances();
  }, [loadBalances]);

  const toggleTradeInputDenom = () => {
    setTradeAmount("0");
    setQuoteWei(null);
    setQuoteError(null);
    setEffectiveTokenWei(0n);
    setEffectiveBnbWei(0n);
    setTradeInputDenom((value) => (value === "TOKEN" ? "BNB" : "TOKEN"));
  };

  useEffect(() => {
    let cancelled = false;

    const loadQuote = async () => {
      try {
        setQuoteError(null);

        if (isSolanaCampaign) {
          const amountStr = String(tradeAmount || "0").trim();
          const dec = tokenDecimals;
          let curve = solanaCurve;
          if (!curve && campaign.campaign) {
            const { resolveSolanaCampaignCurve } = await import("@/lib/solanaCampaignRead");
            curve = await resolveSolanaCampaignCurve(String(campaign.campaign));
            if (!cancelled && curve) setSolanaCurve(curve);
          }
          if (!curve) {
            setQuoteWei(null);
            setQuoteError("Could not load this Solana campaign.");
            return;
          }
          if (curve?.graduated || curve?.curveClosed) {
            const { quoteSolanaMeteoraExactIn } = await import("@/lib/solanaMeteoraTrade");
            const mint = String(curve?.mint || campaign.token || campaign.campaign);
            const amountIn =
              tradeTab === "buy" && tradeInputDenom === "BNB"
                ? parseSolLamports(amountStr)
                : parseTokenAmountDecimals(amountStr, dec);
            if (amountIn <= 0n) {
              setEffectiveTokenWei(0n);
              setEffectiveBnbWei(0n);
              setQuoteWei(null);
              return;
            }
            setQuoteLoading(true);
            const quote = await quoteSolanaMeteoraExactIn({
              side: tradeTab === "buy" ? "buy" : "sell",
              mint,
              tokenDecimals: dec,
              amountInRaw: amountIn,
              slippagePct: SLIPPAGE_PCT,
            });
            if (cancelled) return;
            if (tradeTab === "buy") {
              setEffectiveBnbWei(amountIn);
              setEffectiveTokenWei(quote.amountOutRaw);
              setQuoteWei(amountIn);
            } else {
              setEffectiveTokenWei(amountIn);
              setEffectiveBnbWei(quote.amountOutRaw);
              setQuoteWei(quote.amountOutRaw);
            }
            return;
          }

          const {
            quoteBuyExactSolIn,
            quoteSellExactTokensIn,
            checkedLinearCurveCost,
          } = await import("@/lib/solanaTradeV1");
          const econ = Number(curve?.economicsVersion ?? 2);
          const basePrice = curve?.basePriceLamports ?? 1n;
          const slope = curve?.priceSlopeLamports ?? 1n;
          const sold = curve?.soldTokens ?? 0n;
          const supply = curve?.curveTokenSupply ?? 800_000_000_000_000n;
          const buyFeeBps = curve?.buyFeeBps ?? 200;
          const sellFeeBps = curve?.sellFeeBps ?? 200;
          setQuoteLoading(true);

          if (tradeTab === "buy") {
            if (tradeInputDenom === "BNB") {
              const lamportsIn = parseSolLamports(amountStr);
              if (lamportsIn <= 0n) {
                setEffectiveBnbWei(0n);
                setEffectiveTokenWei(0n);
                setQuoteWei(null);
                return;
              }
              const q = quoteBuyExactSolIn({
                lamportsIn,
                basePrice,
                slope,
                sold,
                curveSupply: supply,
                buyFeeBps,
                economicsVersion: econ,
                tokenDecimals: dec,
              });
              if (!cancelled) {
                setEffectiveBnbWei(lamportsIn);
                setEffectiveTokenWei(q.tokensOut);
                setQuoteWei(lamportsIn);
                setQuoteError(q.tokensOut <= 0n ? "Amount too small for curve quote." : null);
              }
            } else {
              const tokensWanted = parseTokenAmountDecimals(amountStr, dec);
              if (tokensWanted <= 0n) {
                setEffectiveBnbWei(0n);
                setEffectiveTokenWei(0n);
                setQuoteWei(null);
                return;
              }
              const grossCost = checkedLinearCurveCost(basePrice, slope, sold, tokensWanted, econ, dec);
              const feeBps = BigInt(buyFeeBps);
              const lamportsIn =
                feeBps >= 10_000n
                  ? grossCost
                  : (grossCost * 10_000n + (10_000n - feeBps - 1n)) / (10_000n - feeBps);
              if (!cancelled) {
                setEffectiveTokenWei(tokensWanted);
                setEffectiveBnbWei(lamportsIn);
                setQuoteWei(lamportsIn);
              }
            }
          } else if (tradeInputDenom === "BNB") {
            const targetLamports = parseSolLamports(amountStr);
            if (targetLamports <= 0n) {
              setEffectiveTokenWei(0n);
              setEffectiveBnbWei(0n);
              setQuoteWei(null);
              return;
            }
            const walletMax = tokenBalanceWei != null && tokenBalanceWei > 0n ? tokenBalanceWei : sold;
            const maxTokens = walletMax < sold ? walletMax : sold;
            if (maxTokens <= 0n) {
              setQuoteError("No token balance available to sell.");
              return;
            }
            const quoteFor = (tokensIn: bigint) =>
              quoteSellExactTokensIn({
                tokensIn,
                basePrice,
                slope,
                sold,
                sellFeeBps,
                economicsVersion: econ,
                tokenDecimals: dec,
              });
            let lo = 1n;
            let hi = maxTokens;
            for (let i = 0; i < 64 && lo < hi; i += 1) {
              const mid = (lo + hi) / 2n;
              if (quoteFor(mid).lamportsOut >= targetLamports) hi = mid;
              else lo = mid + 1n;
            }
            const q = quoteFor(lo);
            if (!cancelled) {
              setEffectiveTokenWei(lo);
              setEffectiveBnbWei(q.lamportsOut);
              setQuoteWei(q.lamportsOut);
            }
          } else {
            const tokensIn = parseTokenAmountDecimals(amountStr, dec);
            if (tokensIn <= 0n) {
              setEffectiveTokenWei(0n);
              setEffectiveBnbWei(0n);
              setQuoteWei(null);
              return;
            }
            const q = quoteSellExactTokensIn({
              tokensIn,
              basePrice,
              slope,
              sold,
              sellFeeBps,
              economicsVersion: econ,
              tokenDecimals: dec,
            });
            if (!cancelled) {
              setEffectiveTokenWei(tokensIn);
              setEffectiveBnbWei(q.lamportsOut);
              setQuoteWei(q.lamportsOut);
            }
          }
          return;
        }

        if (isDexStage) {
          if (!isTopazTradingActive || !campaign.campaign || !campaign.token) {
            setQuoteWei(null);
            setQuoteError("Topaz market verification is still in progress.");
            return;
          }
          const hasAmount =
            tradeInputDenom === "BNB"
              ? parseBnbAmountWei(tradeAmount) > 0n
              : parseTokenAmountWei(tradeAmount) > 0n;
          if (!hasAmount) {
            setEffectiveTokenWei(0n);
            setEffectiveBnbWei(0n);
            setQuoteWei(null);
            setQuoteError(null);
            return;
          }
          setQuoteLoading(true);
          const resolved = await resolveVerifiedTopazRoute({
            provider: readProvider,
            campaignAddress: campaign.campaign,
            expectedTokenAddress: campaign.token,
            chainId,
          });
          if (tradeInputDenom === "BNB") {
            const targetNativeWei = parseBnbAmountWei(tradeAmount);
            setEffectiveBnbWei(targetNativeWei);
            if (targetNativeWei <= 0n) {
              setEffectiveTokenWei(0n);
              setQuoteWei(null);
              return;
            }
            if (tradeTab === "buy") {
              const quote = await quoteTopazBuy({
                provider: readProvider,
                resolved,
                nativeAmountInRaw: targetNativeWei,
                slippageBps: topazSlippageBps,
              });
              if (!cancelled) {
                setEffectiveTokenWei(quote.amountOutRaw);
                setQuoteWei(targetNativeWei);
              }
              return;
            }
            const tokenInputWei = await solveTokensForExactNative({
              provider: readProvider,
              resolved,
              targetNativeOutRaw: targetNativeWei,
              initialTokenHighRaw: tokenBalanceWei && tokenBalanceWei > 0n ? tokenBalanceWei : 10n ** 24n,
            });
            const quote = await quoteTopazSell({
              provider: readProvider,
              resolved,
              tokenAmountInRaw: tokenInputWei,
              slippageBps: topazSlippageBps,
            });
            if (!cancelled) {
              setEffectiveTokenWei(tokenInputWei);
              setEffectiveBnbWei(quote.amountOutRaw);
              setQuoteWei(quote.amountOutRaw);
            }
            return;
          }
          const tokenInputWei = parseTokenAmountWei(tradeAmount);
          setEffectiveTokenWei(tokenInputWei);
          if (tokenInputWei <= 0n) {
            setEffectiveBnbWei(0n);
            setQuoteWei(null);
            return;
          }
          if (tradeTab === "buy") {
            const nativeInputWei = await solveNativeForExactTokens({
              provider: readProvider,
              resolved,
              targetTokenOutRaw: tokenInputWei,
              initialNativeHighRaw: 10n ** 15n,
            });
            const quote = await quoteTopazBuy({
              provider: readProvider,
              resolved,
              nativeAmountInRaw: nativeInputWei,
              slippageBps: topazSlippageBps,
            });
            if (!cancelled) {
              setEffectiveBnbWei(nativeInputWei);
              setEffectiveTokenWei(quote.amountOutRaw);
              setQuoteWei(nativeInputWei);
            }
            return;
          }
          const quote = await quoteTopazSell({
            provider: readProvider,
            resolved,
            tokenAmountInRaw: tokenInputWei,
            slippageBps: topazSlippageBps,
          });
          if (!cancelled) {
            setEffectiveBnbWei(quote.amountOutRaw);
            setQuoteWei(quote.amountOutRaw);
          }
          return;
        }
        if (!campaign.campaign) {
          setQuoteWei(null);
          return;
        }

        let amountWei = 0n;
        let inputBnbWei = 0n;
        if (tradeInputDenom === "BNB") {
          inputBnbWei = parseBnbAmountWei(tradeAmount);
          setEffectiveBnbWei(inputBnbWei);
          if (inputBnbWei <= 0n) {
            setEffectiveTokenWei(0n);
            setQuoteWei(null);
            return;
          }
        } else {
          amountWei = parseTokenAmountWei(tradeAmount);
          setEffectiveTokenWei(amountWei);
          if (amountWei <= 0n) {
            setQuoteWei(null);
            return;
          }
        }

        setQuoteLoading(true);

        if (!wallet.provider || !readProvider) {
          if (!cancelled) {
            setQuoteWei(null);
            setQuoteError("Wallet provider not available");
          }
          return;
        }

        const contract = new Contract(campaign.campaign, CAMPAIGN_ABI, readProvider) as any;
        if (tradeInputDenom === "BNB") {
          const targetWei = inputBnbWei;
          if (tradeTab === "buy") {
            // Prefer exact contract quote (tokensOut, totalCostWei, feeWei) over binary search.
            try {
              const quoted = await contract.quoteBuyExactBnb(targetWei);
              const tokensOut = BigInt(quoted?.[0] ?? quoted?.tokensOut ?? 0n);
              const totalCostWei = BigInt(quoted?.[1] ?? quoted?.totalCostWei ?? targetWei);
              if (!cancelled) {
                setEffectiveTokenWei(tokensOut);
                setEffectiveBnbWei(targetWei);
                setQuoteWei(totalCostWei > 0n ? totalCostWei : targetWei);
              }
              return;
            } catch {
              // Fall through to binary search on older ABIs.
            }
          }
          const priceWei = metrics?.currentPrice ?? 0n;
          let hi: bigint;
          if (tradeTab === "sell" && tokenBalanceWei != null && tokenBalanceWei > 0n) {
            hi = tokenBalanceWei;
          } else if (priceWei > 0n) {
            const estimate = (targetWei * 10n ** 18n) / priceWei;
            hi = estimate > 0n ? estimate * 2n : 10n ** 18n;
          } else {
            hi = 10n ** 24n;
          }
          let lo = 0n;
          for (let i = 0; i < 28; i += 1) {
            const mid = (lo + hi) / 2n;
            if (mid <= 0n) {
              lo = 0n;
              continue;
            }
            const quote: bigint =
              tradeTab === "buy" ? await contract.quoteBuyExactTokens(mid) : await contract.quoteSellExactTokens(mid);
            if (tradeTab === "buy") {
              if (quote <= targetWei) lo = mid;
              else hi = mid;
            } else if (quote >= targetWei) hi = mid;
            else lo = mid;
          }
          const solved = tradeTab === "buy" ? lo : hi;
          if (!cancelled) {
            setEffectiveTokenWei(solved);
            setQuoteWei(targetWei);
          }
        } else {
          const quote: bigint =
            tradeTab === "buy"
              ? await contract.quoteBuyExactTokens(amountWei)
              : await contract.quoteSellExactTokens(amountWei);
          if (!cancelled) {
            setQuoteWei(quote);
            setEffectiveBnbWei(quote);
          }
        }
      } catch (error: any) {
        console.warn("[WarRoomTradePanel] Quote failed", error);
        if (!cancelled) {
          setQuoteWei(null);
          setQuoteError(error?.message ?? "Failed to fetch quote");
        }
      } finally {
        if (!cancelled) setQuoteLoading(false);
      }
    };

    const timer = setTimeout(loadQuote, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [wallet.provider, campaign.campaign, campaign.token, chainId, readProvider, metrics?.currentPrice, tradeTab, tradeAmount, tradeInputDenom, tokenBalanceWei, isDexStage, isTopazTradingActive, topazSlippageBps, isSolanaCampaign, solanaCurve, tokenDecimals]);

  const handlePlaceTrade = async () => {
    if (!campaign.campaign) return;
    if (!walletMatchesCampaign) {
      toast({
        title: connectTradeWalletLabel,
        description: isSolanaCampaign
          ? "This campaign is on Solana. Connect Phantom / Solflare to buy or sell."
          : "This campaign is on BNB. Connect a BNB wallet to buy or sell.",
      });
      openWalletModal();
      return;
    }

    if (isSolanaCampaign) {
      try {
        setTradePending(true);
        const { getSolanaProvider } = await import("@/lib/solanaWallet");
        const {
          requestSolanaTradeAuthorization,
          submitSolanaTradeV1,
          ensureTraderAta,
          applySlippageMinOut,
        } = await import("@/lib/solanaTradeV1");
        const provider = getSolanaProvider();
        const trader = String(provider?.publicKey?.toString?.() || solanaWallet.solanaAccount || "");
        if (!trader) {
          toast({ title: "Connect Solana wallet", description: "Connect Phantom / Solflare to trade Solana campaigns." });
          window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal"));
          return;
        }
        const curve = solanaCurve;
        const mint = String(curve?.mint || campaign.token || campaign.campaign);
        const campaignPda = String(curve?.campaignAddress || campaign.campaign);
        const dec = tokenDecimals;
        let amountIn = 0n;
        let minOut = 0n;
        if (tradeTab === "buy") {
          amountIn = tradeInputDenom === "BNB" ? parseSolLamports(tradeAmount) : effectiveBnbWei;
          if (amountIn <= 0n) throw new Error("Enter a SOL amount to buy.");
          minOut = applySlippageMinOut(effectiveTokenWei > 0n ? effectiveTokenWei : 0n, SLIPPAGE_PCT);
        } else {
          amountIn = tradeInputDenom === "BNB" ? effectiveTokenWei : parseTokenAmountDecimals(tradeAmount, dec);
          if (amountIn <= 0n) throw new Error("Enter a token amount or target SOL payout to sell.");
          const estSol = quoteWei != null && quoteWei > 0n ? quoteWei : effectiveBnbWei;
          minOut = applySlippageMinOut(estSol > 0n ? estSol : 0n, SLIPPAGE_PCT);
        }

        if (curve?.graduated || curve?.curveClosed) {
          const { quoteSolanaMeteoraExactIn, executeSolanaMeteoraSwap } = await import("@/lib/solanaMeteoraTrade");
          const quote = await quoteSolanaMeteoraExactIn({
            side: tradeTab === "buy" ? "buy" : "sell",
            mint,
            tokenDecimals: dec,
            amountInRaw: amountIn,
            slippagePct: SLIPPAGE_PCT,
          });
          const result = await executeSolanaMeteoraSwap({
            quote,
            mint,
            tokenDecimals: dec,
            walletAddress: trader,
            poolAddress: quote.pool,
          });
          toast({
            title: tradeTab === "buy" ? "Buy confirmed" : "Sell confirmed",
            description: `Tx: ${result.signature.slice(0, 12)}…`,
          });
          await Promise.all([loadMetrics(), loadBalances()]);
          return;
        }

        await ensureTraderAta({ mint, owner: trader });
        const auth = await requestSolanaTradeAuthorization({
          side: tradeTab === "buy" ? "buy" : "sell",
          campaignAddress: campaignPda,
          mintAddress: mint,
          traderAddress: trader,
          amountIn,
          minOut,
          tokenVault: curve?.tokenVault || campaign.tokenVault || null,
          solVault: curve?.solVault || campaign.solVault || null,
          campaignId: curve?.campaignIdHex || campaign.campaignIdHex || null,
          chainId: SOLANA_CHAIN_ID,
        });
        const result = await submitSolanaTradeV1(auth, { traderAddress: trader });
        toast({
          title: tradeTab === "buy" ? "Buy confirmed" : "Sell confirmed",
          description: `Tx: ${result.signature.slice(0, 12)}…`,
        });
        await Promise.all([loadMetrics(), loadBalances()]);
      } catch (error: any) {
        const { mapSolanaTradeError } = await import("@/lib/solanaTradeV1").catch(() => ({ mapSolanaTradeError: (e: any) => String(e?.message || e) }));
        toast({
          title: "Trade failed",
          description: mapSolanaTradeError(error),
          variant: "destructive",
        });
      } finally {
        setTradePending(false);
      }
      return;
    }

    if (isDexStage) {
      if (!isTopazTradingActive || !campaign.token) {
        toast({
          title: "Topaz market is not ready",
          description: "The verified Topaz route is still being reconciled.",
          variant: "destructive",
        });
        return;
      }
      if (!wallet.signer || !wallet.account) {
        toast({ title: "Connect wallet", description: "Please connect your wallet to trade." });
        window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal"));
        return;
      }
      try {
        setTradePending(true);
        const resolved = await resolveVerifiedTopazRoute({
          provider: readProvider,
          campaignAddress: campaign.campaign,
          expectedTokenAddress: campaign.token,
          chainId,
        });
        if (tradeTab === "buy") {
          const nativeAmountInRaw = tradeInputDenom === "BNB" ? parseBnbAmountWei(tradeAmount) : effectiveBnbWei;
          if (nativeAmountInRaw <= 0n) throw new Error("Enter a valid BNB or token amount.");
          if (bnbBalanceWei != null && nativeAmountInRaw > bnbBalanceWei) throw new Error("Insufficient BNB balance.");
          const gasReserveWei = evmBuyGasReserveWei(false);
          if (bnbBalanceWei != null && nativeAmountInRaw + gasReserveWei > bnbBalanceWei) {
            throw new Error(`Not enough BNB. Keep about ${ethers.formatEther(gasReserveWei)} BNB in your wallet for gas.`);
          }
          const quote = await quoteTopazBuy({
            provider: readProvider,
            resolved,
            nativeAmountInRaw,
            slippageBps: topazSlippageBps,
          });
          toast({
            title: "Submitting Topaz buy",
            description: `Minimum received: ${formatTokenFromWei(quote.minimumOutRaw)} ${campaign.symbol}.`,
          });
          const tx = await executeTopazBuy({ signer: wallet.signer, recipient: wallet.account, quote });
          const receipt = await tx.wait();
          toast({
            title: "Buy confirmed",
            description: receipt?.hash ? `Tx: ${receipt.hash.slice(0, 10)}...` : "Transaction confirmed.",
          });
          const tokensOut = quote.amountOutRaw > 0n ? quote.amountOutRaw : quote.minimumOutRaw;
          void recordTopazFill({
            chainId,
            campaignAddress: campaign.campaign,
            side: "buy",
            txHash: String(receipt?.hash || tx?.hash || ""),
            tokenAmountRaw: tokensOut,
            nativeAmountRaw: nativeAmountInRaw,
            wallet: wallet.account,
            pairAddress: resolved.pairAddress,
            blockNumber: Number(receipt?.blockNumber || 0),
          });
        } else {
          const tokenAmountInRaw = tradeInputDenom === "BNB" ? effectiveTokenWei : parseTokenAmountWei(tradeAmount);
          if (tokenAmountInRaw <= 0n) throw new Error("Enter a valid token or BNB amount.");
          if (tokenBalanceWei != null && tokenAmountInRaw > tokenBalanceWei) {
            throw new Error(`Insufficient ${campaign.symbol} balance.`);
          }
          const quote = await quoteTopazSell({
            provider: readProvider,
            resolved,
            tokenAmountInRaw,
            slippageBps: topazSlippageBps,
          });
          const approval = await ensureTopazSellAllowance({
            signer: wallet.signer,
            owner: wallet.account,
            resolved,
            tokenAmountRaw: tokenAmountInRaw,
          });
          if (approval) {
            setApprovePending(true);
            toast({
              title: "Approval required",
              description: `Approving the verified Topaz router for ${campaign.symbol}...`,
            });
            await approval.wait();
            setApprovePending(false);
          }
          toast({
            title: "Submitting Topaz sell",
            description: `Minimum received: ${formatBnbFromWei(quote.minimumOutRaw)}.`,
          });
          const tx = await executeTopazSell({ signer: wallet.signer, recipient: wallet.account, quote });
          const receipt = await tx.wait();
          toast({
            title: "Sell confirmed",
            description: receipt?.hash ? `Tx: ${receipt.hash.slice(0, 10)}...` : "Transaction confirmed.",
          });
          const nativeOut = quote.amountOutRaw > 0n ? quote.amountOutRaw : quote.minimumOutRaw;
          void recordTopazFill({
            chainId,
            campaignAddress: campaign.campaign,
            side: "sell",
            txHash: String(receipt?.hash || tx?.hash || ""),
            tokenAmountRaw: tokenAmountInRaw,
            nativeAmountRaw: nativeOut,
            wallet: wallet.account,
            pairAddress: resolved.pairAddress,
            blockNumber: Number(receipt?.blockNumber || 0),
          });
        }
        await Promise.all([loadMetrics(), loadBalances()]);
        setTradeAmount("0");
      } catch (error: any) {
        console.error("[WarRoomTradePanel] Topaz trade failed", error);
        toast({
          title: "Trade failed",
          description: error?.shortMessage || error?.message || "Topaz trade failed.",
          variant: "destructive",
        });
      } finally {
        setApprovePending(false);
        setTradePending(false);
      }
      return;
    }

    const amountWei = tradeInputDenom === "BNB" ? effectiveTokenWei : parseTokenAmountWei(tradeAmount);
    const inputBnbWei = tradeInputDenom === "BNB" ? effectiveBnbWei : 0n;
    if (amountWei <= 0n) {
      toast({
        title: "Invalid amount",
        description:
          tradeInputDenom === "BNB"
            ? "Enter a BNB amount greater than 0."
            : `Enter a ${campaign.symbol} amount greater than 0.`,
        variant: "destructive",
      });
      return;
    }

    try {
      if (tradeTab === "sell" && tokenBalanceWei != null && amountWei > tokenBalanceWei) {
        toast({
          title: "Insufficient token balance",
          description: `You do not have enough ${campaign.symbol} to sell that amount.`,
          variant: "destructive",
        });
        return;
      }

      if (tradeTab === "buy" && bnbBalanceWei != null) {
        const baseCostWei = quoteWei && quoteWei > 0n ? quoteWei : tradeInputDenom === "BNB" ? inputBnbWei : 0n;
        if (baseCostWei > 0n) {
          const maxCostWei = (baseCostWei * BigInt(100 + SLIPPAGE_PCT)) / 100n;
          if (maxCostWei > bnbBalanceWei) {
            toast({
              title: "Insufficient BNB",
              description: `You need ~${formatBnbFromWei(maxCostWei)} to place this buy.`,
              variant: "destructive",
            });
            return;
          }
        }
      }

      if (!wallet.signer || !wallet.account) {
        toast({
          title: "Connect wallet",
          description: "Please connect your wallet to trade.",
        });
        window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal"));
        return;
      }

      setTradePending(true);

      if (tradeTab === "buy") {
        let costWei: bigint = quoteWei && quoteWei > 0n ? quoteWei : tradeInputDenom === "BNB" ? inputBnbWei : 0n;
        if (amountWei > 0n && costWei === 0n) {
          if (!readProvider) throw new Error("Read provider unavailable");
          const contract = new Contract(campaign.campaign, CAMPAIGN_ABI, readProvider) as any;
          costWei = await contract.quoteBuyExactTokens(amountWei);
        }
        if (costWei <= 0n) {
          toast({
            title: "Quote unavailable",
            description: "Could not price this buy. Try again in a moment.",
            variant: "destructive",
          });
          return;
        }
        const maxCostWei = (costWei * BigInt(100 + SLIPPAGE_PCT)) / 100n;

        toast({
          title: "Submitting buy",
          description: `Buying ~${formatTokenFromWei(amountWei)} ${campaign.symbol} for up to ${formatBnbFromWei(maxCostWei)}.`,
        });

        await assertWalletOnChain(wallet.signer, chainId, campaign.campaign);
        const campaignWrite = new Contract(campaign.campaign, CAMPAIGN_ABI, wallet.signer) as any;
        const overrides = { value: maxCostWei, gasLimit: LEGACY_TRADE_GAS_LIMIT };
        let tx;
        try {
          const authResponse = await requestCampaignTradeAuthorization({
            walletAddress: wallet.account,
            campaignAddress: campaign.campaign,
            chainId,
            action: TRADE_AUTH_BUY_EXACT_TOKENS,
            amount: amountWei,
            limit: maxCostWei,
          });
          const auth = authResponse.authorization;
          const buyArgs = [amountWei, maxCostWei, auth.routeProfileId, Math.floor(new Date(auth.validUntil).getTime() / 1000), auth.signature] as const;
          // The fixed limit stays the floor; gen-7 sell-out buys and Robinhood's L1 data cost can need more.
          const buyGas = await gasWithHeadroom(() => campaignWrite.buyExactTokensAuthorized.estimateGas(...buyArgs, { value: maxCostWei }), LEGACY_TRADE_GAS_LIMIT);
          tx = await campaignWrite.buyExactTokensAuthorized(...buyArgs, { ...overrides, gasLimit: buyGas });
        } catch (error) {
          if (authLooksRequired(error)) throw error;
          tx = await campaignWrite.buyExactTokens(amountWei, maxCostWei, overrides);
        }
        const receipt: any = await tx.wait();
        toast({
          title: "Buy confirmed",
          description: receipt?.hash || receipt?.transactionHash ? `Tx: ${String(receipt.hash || receipt.transactionHash).slice(0, 10)}...` : "Transaction confirmed.",
        });
      } else {
        let payoutWei: bigint = tradeInputDenom === "BNB" ? inputBnbWei : (quoteWei ?? 0n);
        if (amountWei > 0n && payoutWei === 0n) {
          const contract = new Contract(campaign.campaign, CAMPAIGN_ABI, wallet.provider ?? wallet.signer) as any;
          payoutWei = await contract.quoteSellExactTokens(amountWei);
        }
        const minPayoutWei = (payoutWei * BigInt(100 - SLIPPAGE_PCT)) / 100n;

        if (campaign.token) {
          const token = new Contract(campaign.token, TOKEN_ABI, wallet.signer) as any;
          const allowance: bigint = await token.allowance(wallet.account, campaign.campaign);
          if (allowance < amountWei) {
            setApprovePending(true);
            toast({
              title: "Approval required",
              description: `Approving ${campaign.symbol} for selling...`,
            });
            const tx = await token.approve(campaign.campaign, MAX_UINT256);
            await tx.wait();
            setApprovePending(false);
          }
        }

        toast({
          title: "Submitting sell",
          description: `Selling ${ethers.formatUnits(amountWei, TOKEN_DECIMALS)} ${campaign.symbol} (min ${formatBnbFromWei(minPayoutWei)}).`,
        });

        await assertWalletOnChain(wallet.signer, chainId, campaign.campaign);
        const campaignWrite = new Contract(campaign.campaign, CAMPAIGN_ABI, wallet.signer) as any;
        const overrides = { gasLimit: LEGACY_TRADE_GAS_LIMIT };
        let tx;
        try {
          const authResponse = await requestCampaignTradeAuthorization({
            walletAddress: wallet.account,
            campaignAddress: campaign.campaign,
            chainId,
            action: TRADE_AUTH_SELL_EXACT_TOKENS,
            amount: amountWei,
            limit: minPayoutWei,
          });
          const auth = authResponse.authorization;
          const sellArgs = [amountWei, minPayoutWei, auth.routeProfileId, Math.floor(new Date(auth.validUntil).getTime() / 1000), auth.signature] as const;
          const sellGas = await gasWithHeadroom(() => campaignWrite.sellExactTokensAuthorized.estimateGas(...sellArgs, {}), LEGACY_TRADE_GAS_LIMIT);
          tx = await campaignWrite.sellExactTokensAuthorized(...sellArgs, { ...overrides, gasLimit: sellGas });
        } catch (error) {
          if (authLooksRequired(error)) throw error;
          tx = await campaignWrite.sellExactTokens(amountWei, minPayoutWei, overrides);
        }
        const receipt: any = await tx.wait();
        toast({
          title: "Sell confirmed",
          description: receipt?.hash || receipt?.transactionHash ? `Tx: ${String(receipt.hash || receipt.transactionHash).slice(0, 10)}...` : "Transaction confirmed.",
        });
      }

      await Promise.all([loadMetrics(), loadBalances()]);
    } catch (error: any) {
      toast({
        title: "Trade failed",
        description: String(error?.message ?? error ?? "Unknown error"),
        variant: "destructive",
      });
    } finally {
      setTradePending(false);
      setApprovePending(false);
    }
  };

  const balanceLabel = tradeInputDenom === "BNB" ? formatAmount(bnbBalanceWei, isSolanaCampaign ? 9 : 18, nativeUnit) : `${formatAmount(tokenBalanceWei, tokenDecimals)} ${campaign.symbol}`;
  const denomChips = (label: string) => (
    <div className="flex items-center justify-between gap-2 text-[13px]">
      <span className="text-mw-muted">{label}</span>
      <span className="flex gap-1">
        <button type="button" aria-pressed={tradeInputDenom === "BNB"} onClick={tradeInputDenom === "BNB" ? undefined : toggleTradeInputDenom} className={`${chipClass} ${tradeInputDenom === "BNB" ? chipOnClass : ""}`}>{nativeUnit}</button>
        <button type="button" aria-pressed={tradeInputDenom !== "BNB"} onClick={tradeInputDenom === "BNB" ? toggleTradeInputDenom : undefined} className={`${chipClass} ${tradeInputDenom !== "BNB" ? chipOnClass : ""}`}>{campaign.symbol || "TOKEN"}</button>
      </span>
    </div>
  );
  const amountInput = (
    <div className="relative">
      <input
        type="text"
        inputMode="decimal"
        aria-label="Amount"
        value={tradeAmount}
        onChange={(event) => setTradeAmount(event.target.value)}
        className={amountClass}
        placeholder="0"
      />
      <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 font-mw-mono text-[13px] text-mw-muted">{tradeInputDenom === "BNB" ? nativeUnit : campaign.symbol}</span>
    </div>
  );
  const slipChip = <span className={`${chipClass} cursor-default hover:border-[#2E353D]`}>Slip {SLIPPAGE_PCT}%</span>;
  // Buy: 25% / 50% of the native balance, only while the amount is entered in native units (fills the field only).
  const setBuyPercent = (pct: bigint) => {
    if (bnbBalanceWei == null) return;
    // Solana: the buy spends every lamport entered, so keep rent for the token account and the network fee.
    const reserve = isSolanaCampaign ? SOLANA_BUY_FEE_RESERVE_LAMPORTS : evmBuyGasReserveWei(false);
    const spendable = bnbBalanceWei > reserve ? bnbBalanceWei - reserve : 0n;
    setTradeAmount(ethers.formatUnits((spendable * pct) / 100n, isSolanaCampaign ? 9 : 18));
  };

  return (
    <div className="flex flex-col gap-2.5 rounded-[14px] border border-mw-border bg-mw-input p-3.5 font-mw-body text-mw-text">
      <Tabs value={tradeTab} onValueChange={(value) => setTradeTab(value as "buy" | "sell")}>
        <TabsList className={segListClass}>
          <TabsTrigger value="buy" className={`${segTriggerClass} data-[state=active]:bg-mw-buy data-[state=active]:text-[#04140A]`}>Buy</TabsTrigger>
          <TabsTrigger value="sell" className={`${segTriggerClass} data-[state=active]:bg-mw-sell data-[state=active]:text-[#FFF1F3]`}>Sell</TabsTrigger>
        </TabsList>

        <TabsContent value="buy" className="mt-2.5 flex flex-col gap-2.5">
          {denomChips("Pay in")}
          {amountInput}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate font-mw-mono text-[13px] text-mw-muted">Bal {balanceLabel}</span>
            {tradeInputDenom === "BNB" ? (
              <>
                <button type="button" className={chipClass} onClick={() => setBuyPercent(25n)}>25%</button>
                <button type="button" className={chipClass} onClick={() => setBuyPercent(50n)}>50%</button>
              </>
            ) : null}
            {slipChip}
          </div>
          <div className="flex items-center justify-between gap-2 font-mw-mono text-[13px]">
            <span className="truncate text-mw-muted">Pay {quoteLoading ? "…" : quoteWei != null ? `~${formatAmount(quoteWei, isSolanaCampaign ? 9 : 18, nativeUnit)}` : "—"}</span>
            <span className="truncate">
              {effectiveTokenWei > 0n ? `get ~${formatAmount(effectiveTokenWei, tokenDecimals)} ${campaign.symbol}${tradeInputDenom === "TOKEN" ? " (exact)" : ""}` : ""}
            </span>
          </div>
          {quoteError ? <p className="m-0 text-center text-xs text-mw-down">{quoteError}</p> : null}

          <div className="text-center text-xs text-mw-muted">
            {isDexStage && !isSolanaCampaign ? (
              isTopazTradingActive && quoteWei != null ? (
                <p className="m-0">Topaz execution · slippage {(topazSlippageBps / 100).toFixed(2)}%.</p>
              ) : (
                <p className="m-0">Topaz market verification is in progress.</p>
              )
            ) : quoteWei != null && effectiveTokenWei > 0n ? (
              <p className="m-0">
                Max {formatAmount((quoteWei * BigInt(100 + SLIPPAGE_PCT)) / 100n, isSolanaCampaign ? 9 : 18, nativeUnit)} with {SLIPPAGE_PCT}% slippage
              </p>
            ) : (
              <p className="m-0">Enter a {nativeUnit} amount to buy (switch to {campaign.symbol || "TOKEN"} for exact size).</p>
            )}
          </div>

          <Button
            onClick={walletMatchesCampaign ? handlePlaceTrade : openWalletModal}
            disabled={
              walletMatchesCampaign &&
              (tradePending ||
                approvePending ||
                quoteLoading ||
                (isDexStage && !isSolanaCampaign && !isTopazTradingActive) ||
                (tradeInputDenom === "BNB" ? effectiveBnbWei <= 0n : parseTokenAmountDecimals(tradeAmount, tokenDecimals) <= 0n))
            }
            className="min-h-12 w-full rounded-[10px] border border-mw-buy bg-mw-buy font-mw-body text-base font-bold text-[#04140A] hover:bg-[#15913F] disabled:opacity-50"
          >
            {!walletMatchesCampaign
              ? connectTradeWalletLabel
              : tradePending
                ? "Processing..."
                : isSolanaCampaign && isDexStage
                  ? "Buy on Meteora"
                  : isDexStage
                    ? "Buy on Topaz"
                    : "Buy"}
          </Button>
        </TabsContent>

        <TabsContent value="sell" className="mt-2.5 flex flex-col gap-2.5">
          {denomChips("Amount in")}
          {amountInput}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate font-mw-mono text-[13px] text-mw-muted">Bal {balanceLabel}</span>
            <button
              type="button"
              className={chipClass}
              onClick={() => {
                if (tokenBalanceWei == null) return;
                const amount = (tokenBalanceWei * 25n) / 100n;
                setTradeAmount(ethers.formatUnits(amount, tokenDecimals));
              }}
            >
              25%
            </button>
            <button
              type="button"
              className={chipClass}
              onClick={() => {
                if (tokenBalanceWei == null) return;
                const amount = (tokenBalanceWei * 50n) / 100n;
                setTradeAmount(ethers.formatUnits(amount, tokenDecimals));
              }}
            >
              50%
            </button>
            <button
              type="button"
              className={chipClass}
              onClick={() => {
                if (tokenBalanceWei == null) return;
                setTradeAmount(ethers.formatUnits(tokenBalanceWei, tokenDecimals));
              }}
            >
              100%
            </button>
            {slipChip}
          </div>
          <div className="flex items-center justify-between gap-2 font-mw-mono text-[13px]">
            <span className="truncate text-mw-muted">{tradeInputDenom === "BNB" && effectiveTokenWei > 0n ? `Sell ~${formatAmount(effectiveTokenWei, tokenDecimals)} ${campaign.symbol}` : ""}</span>
            <span className="truncate">Get ~{tradeInputDenom === "BNB" ? formatAmount(effectiveBnbWei, isSolanaCampaign ? 9 : 18, nativeUnit) : (quoteLoading ? "…" : quoteWei != null ? formatAmount(quoteWei, isSolanaCampaign ? 9 : 18, nativeUnit) : "—")}</span>
          </div>
          {approvePending ? <p className="m-0 text-center text-xs text-mw-muted">Approval in progress...</p> : null}
          {quoteError ? <p className="m-0 text-center text-xs text-mw-down">{quoteError}</p> : null}

          <div className="text-center text-xs text-mw-muted">
            {isDexStage && !isSolanaCampaign ? (
              isTopazTradingActive && quoteWei != null ? (
                <p className="m-0">Topaz execution · slippage {(topazSlippageBps / 100).toFixed(2)}%.</p>
              ) : (
                <p className="m-0">Topaz market verification is in progress.</p>
              )
            ) : quoteWei != null ? (
              <p className="m-0">Min {formatAmount((quoteWei * BigInt(100 - SLIPPAGE_PCT)) / 100n, isSolanaCampaign ? 9 : 18, nativeUnit)} with {SLIPPAGE_PCT}% slippage</p>
            ) : (
              <p className="m-0">Enter an amount to see the sell quote.</p>
            )}
          </div>

          <Button
            onClick={walletMatchesCampaign ? handlePlaceTrade : openWalletModal}
            disabled={
              walletMatchesCampaign &&
              (tradePending ||
                approvePending ||
                quoteLoading ||
                (isDexStage && !isSolanaCampaign && !isTopazTradingActive) ||
                (tradeInputDenom === "BNB" ? effectiveBnbWei <= 0n : parseTokenAmountDecimals(tradeAmount, tokenDecimals) <= 0n))
            }
            className="min-h-12 w-full rounded-[10px] border border-mw-sell bg-mw-sell font-mw-body text-base font-bold text-[#FFF1F3] hover:bg-[#C81A40] disabled:opacity-50"
          >
            {!walletMatchesCampaign
              ? connectTradeWalletLabel
              : tradePending
                ? "Processing..."
                : isSolanaCampaign && isDexStage
                  ? "Sell on Meteora"
                  : isDexStage
                    ? "Sell on Topaz"
                    : "Sell"}
          </Button>
        </TabsContent>
      </Tabs>
    </div>
  );
}
