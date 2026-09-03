import { useCallback, useEffect, useMemo, useState } from "react";
import { Contract, ethers } from "ethers";
import type { CampaignInfo } from "@/lib/launchpadClient";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { useWallet } from "@/contexts/WalletContext";
import {
  ensureRobinhoodV3SellAllowance,
  executeRobinhoodV3Buy,
  executeRobinhoodV3Sell,
  quoteRobinhoodV3Buy,
  quoteRobinhoodV3Sell,
  resolveRobinhoodV3Route,
  type RobinhoodV3ResolvedRoute,
} from "@/lib/robinhoodV3Trade";
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_TESTNET_CHAIN_ID } from "@/lib/chainConfig";
import LaunchTokenArtifact from "@/abi/LaunchToken.json";

const TOKEN_ABI = LaunchTokenArtifact.abi as ethers.InterfaceAbi;
const TOKEN_DECIMALS = 18;
const SLIPPAGE_BPS = 100;

function parseAmount(value: string, decimals = 18): bigint {
  const raw = String(value || "").trim().replace(/,/g, ".");
  if (!raw || raw === ".") return 0n;
  try {
    return ethers.parseUnits(raw, decimals);
  } catch {
    return 0n;
  }
}

function formatAmount(value: bigint | null, decimals = 18, symbol = "") {
  if (value == null) return "—";
  try {
    const n = Number(ethers.formatUnits(value, decimals));
    const text = Number.isFinite(n)
      ? n >= 1
        ? n.toFixed(4)
        : n >= 0.01
          ? n.toFixed(6)
          : n.toFixed(8)
      : ethers.formatUnits(value, decimals);
    return symbol ? `${text} ${symbol}` : text;
  } catch {
    return "—";
  }
}

function campaignChainId(campaign: CampaignInfo): number {
  const id = Number((campaign as { chainId?: number }).chainId);
  return id === ROBINHOOD_CHAIN_ID || id === ROBINHOOD_TESTNET_CHAIN_ID ? id : ROBINHOOD_TESTNET_CHAIN_ID;
}

export function RobinhoodWarRoomTradePanel({ campaign }: { campaign: CampaignInfo }) {
  const { toast } = useToast();
  const wallet = useWallet();
  const chainId = useMemo(() => campaignChainId(campaign), [campaign]);
  const [tab, setTab] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("0");
  const [route, setRoute] = useState<RobinhoodV3ResolvedRoute | null>(null);
  const [quoteOut, setQuoteOut] = useState<bigint | null>(null);
  const [minimumOut, setMinimumOut] = useState<bigint | null>(null);
  const [nativeBalance, setNativeBalance] = useState<bigint | null>(null);
  const [tokenBalance, setTokenBalance] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connectedOnCampaignChain = Boolean(
    wallet.isConnected &&
    wallet.account &&
    wallet.provider &&
    wallet.signer &&
    Number(wallet.chainId) === chainId,
  );

  const openWalletModal = () => {
    try { window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal")); } catch { /* ignore */ }
  };

  const loadRoute = useCallback(async () => {
    try {
      setError(null);
      const provider = wallet.provider && Number(wallet.chainId) === chainId
        ? wallet.provider
        : null;
      if (!provider) {
        setRoute(null);
        return;
      }
      const next = await resolveRobinhoodV3Route({
        provider,
        campaignAddress: campaign.campaign,
        chainId,
        expectedTokenAddress: campaign.token,
      });
      setRoute(next);
    } catch (err) {
      setRoute(null);
      setError(String((err as Error)?.message || err || "Robinhood V3 route unavailable."));
    }
  }, [campaign.campaign, campaign.token, chainId, wallet.chainId, wallet.provider]);

  const loadBalances = useCallback(async () => {
    if (!connectedOnCampaignChain || !wallet.provider || !wallet.account) {
      setNativeBalance(null);
      setTokenBalance(null);
      return;
    }
    try {
      const [native, token] = await Promise.all([
        wallet.provider.getBalance(wallet.account),
        campaign.token
          ? new Contract(campaign.token, TOKEN_ABI, wallet.provider).balanceOf(wallet.account).catch(() => 0n)
          : Promise.resolve(0n),
      ]);
      setNativeBalance(BigInt(native));
      setTokenBalance(BigInt(token));
    } catch {
      setNativeBalance(null);
      setTokenBalance(null);
    }
  }, [campaign.token, connectedOnCampaignChain, wallet.account, wallet.provider]);

  useEffect(() => { void loadRoute(); }, [loadRoute]);
  useEffect(() => { void loadBalances(); }, [loadBalances]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setQuoteOut(null);
      setMinimumOut(null);
      if (!route || !wallet.provider) return;
      const amountIn = parseAmount(amount, TOKEN_DECIMALS);
      if (amountIn <= 0n) return;
      try {
        setLoading(true);
        setError(null);
        const quote = tab === "buy"
          ? await quoteRobinhoodV3Buy(wallet.provider, route, amountIn, SLIPPAGE_BPS)
          : await quoteRobinhoodV3Sell(wallet.provider, route, amountIn, SLIPPAGE_BPS);
        if (cancelled) return;
        setQuoteOut(quote.amountOutRaw);
        setMinimumOut(quote.minimumOutRaw);
      } catch (err) {
        if (!cancelled) setError(String((err as Error)?.message || err || "Quote unavailable."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [amount, route, tab, wallet.provider]);

  const executeTrade = async () => {
    if (!connectedOnCampaignChain || !wallet.signer || !wallet.provider || !route) {
      openWalletModal();
      return;
    }
    const amountIn = parseAmount(amount, TOKEN_DECIMALS);
    if (amountIn <= 0n) return;

    try {
      setLoading(true);
      setError(null);
      if (tab === "buy") {
        const quote = await quoteRobinhoodV3Buy(wallet.provider, route, amountIn, SLIPPAGE_BPS);
        const tx = await executeRobinhoodV3Buy({ signer: wallet.signer, quote });
        await tx.wait();
        toast({ title: "Robinhood buy confirmed", description: `${formatAmount(amountIn, 18, "ETH")} traded on the Robinhood V3 pool.` });
      } else {
        const quote = await quoteRobinhoodV3Sell(wallet.provider, route, amountIn, SLIPPAGE_BPS);
        await ensureRobinhoodV3SellAllowance({ signer: wallet.signer, route, amountInRaw: amountIn });
        const tx = await executeRobinhoodV3Sell({ signer: wallet.signer, quote });
        await tx.wait();
        toast({ title: "Robinhood sell confirmed", description: `${formatAmount(amountIn, TOKEN_DECIMALS, campaign.symbol || "tokens")} sold for ETH.` });
      }
      setAmount("0");
      setQuoteOut(null);
      setMinimumOut(null);
      await Promise.all([loadBalances(), loadRoute()]);
    } catch (err) {
      const message = String((err as Error)?.message || err || "Robinhood V3 trade failed.");
      setError(message);
      toast({ title: "Robinhood trade failed", description: message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const amountIn = parseAmount(amount, TOKEN_DECIMALS);
  const insufficient = tab === "buy"
    ? nativeBalance != null && amountIn > nativeBalance
    : tokenBalance != null && amountIn > tokenBalance;

  return (
    <div className="rounded-[18px] border border-orange-400/20 bg-black/30 p-3 md:rounded-[20px] md:p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.22em] text-orange-300">Robinhood V3</div>
          <div className="mt-1 text-xs text-white/55">Native ETH in/out. Liquidity remains WETH/token underneath.</div>
        </div>
        <div className="text-right text-[10px] text-white/45">
          <div>{formatAmount(nativeBalance, 18, "ETH")}</div>
          <div>{formatAmount(tokenBalance, TOKEN_DECIMALS, campaign.symbol || "TOKEN")}</div>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(value) => { setTab(value as "buy" | "sell"); setAmount("0"); setError(null); }}>
        <TabsList className="grid h-auto w-full grid-cols-2 gap-2 bg-transparent p-0">
          <TabsTrigger value="buy" className="border border-orange-400/35 data-[state=active]:bg-orange-500 data-[state=active]:text-white">Buy</TabsTrigger>
          <TabsTrigger value="sell" className="border border-orange-400/35 data-[state=active]:bg-orange-500 data-[state=active]:text-white">Sell</TabsTrigger>
        </TabsList>
        <TabsContent value="buy" className="mt-3 space-y-3">
          <label className="block text-[10px] uppercase tracking-[0.18em] text-white/45">ETH amount</label>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className="w-full rounded-lg border border-white/10 bg-black/35 px-3 py-3 text-sm text-white outline-none focus:border-orange-400/60" />
          <div className="text-xs text-white/55">Estimated receive: {formatAmount(quoteOut, TOKEN_DECIMALS, campaign.symbol || "TOKEN")}</div>
          <div className="text-[10px] text-white/35">Minimum after 1.00% slippage: {formatAmount(minimumOut, TOKEN_DECIMALS, campaign.symbol || "TOKEN")}</div>
        </TabsContent>
        <TabsContent value="sell" className="mt-3 space-y-3">
          <label className="block text-[10px] uppercase tracking-[0.18em] text-white/45">{campaign.symbol || "Token"} amount</label>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className="w-full rounded-lg border border-white/10 bg-black/35 px-3 py-3 text-sm text-white outline-none focus:border-orange-400/60" />
          <div className="text-xs text-white/55">Estimated receive: {formatAmount(quoteOut, 18, "ETH")}</div>
          <div className="text-[10px] text-white/35">Minimum after 1.00% slippage: {formatAmount(minimumOut, 18, "ETH")}</div>
        </TabsContent>
      </Tabs>

      {error ? <div className="mt-3 rounded-lg border border-red-400/25 bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</div> : null}
      {insufficient ? <div className="mt-3 text-xs text-red-300">Insufficient {tab === "buy" ? "ETH" : campaign.symbol || "token"} balance.</div> : null}

      <Button
        type="button"
        className="mt-3 w-full font-retro"
        disabled={loading || insufficient || amountIn <= 0n || (connectedOnCampaignChain && !route)}
        onClick={() => void executeTrade()}
      >
        {!connectedOnCampaignChain
          ? `Connect Robinhood wallet`
          : loading
            ? "Processing..."
            : tab === "buy"
              ? `Buy ${campaign.symbol || "token"}`
              : `Sell ${campaign.symbol || "token"}`}
      </Button>
    </div>
  );
}
