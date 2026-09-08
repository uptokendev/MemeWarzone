import "@/polyfills";
import { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useNativeUsdPrice } from "@/hooks/useNativeUsdPrice";
import {
  getActiveChainId,
  getArenaVoteTreasuryAddress,
  getPublicRpcUrl,
  getVoteTreasuryAddress,
  isSolanaChainId,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_TESTNET_CHAIN_ID,
  SOLANA_CHAIN_ID,
} from "@/lib/chainConfig";
import { getBnbContractAddresses } from "@/lib/bnbContracts";
import { getReadProvider } from "@/lib/readProvider";
import { apiFetch } from "@/lib/apiBase";
import { isSolanaAddress } from "@/lib/address";
import { loadSolanaWeb3 } from "@/lib/solanaWeb3";
import { submitSolanaUpvoteV0 } from "@/lib/solanaUpvoteV0";

/** Fixed UP Vote price in USD on every supported chain. */
const UPVOTE_USD_TARGET = 3;

const UPVOTE_ABI = [
  // Legacy ABI name. The payable call transfers the EVM chain's native asset:
  // BNB on BNB Chain and ETH on Robinhood Chain.
  "function voteWithBNB(address campaign, bytes32 meta) payable",
  "function assetConfig(address asset) view returns (bool enabled, uint256 minAmount)",
];
const GRADUATION_ORACLE_ABI = [
  "function nativeTargetForUsd(uint256 usdAmount) view returns (uint256)",
];

function safeLowerHex(s?: string | null): string {
  const v = String(s ?? "").trim();
  return v ? v.toLowerCase() : "";
}

function formatNativeAmount(weiOrLamports: bigint, decimals: number): string {
  try {
    const raw = ethers.formatUnits(weiOrLamports, decimals);
    if (!raw.includes(".")) return raw;
    const trimmed = raw.replace(/\.?0+$/, "");
    return trimmed || "0";
  } catch {
    return "—";
  }
}

function isRobinhood(chainId: number) {
  return chainId === ROBINHOOD_CHAIN_ID || chainId === ROBINHOOD_TESTNET_CHAIN_ID;
}

type Props = {
  campaignAddress?: string;
  tokenAddress?: string;
  lane?: "launchpad" | "arena";
  chainId?: number | null;
  className?: string;
  buttonVariant?: "default" | "secondary" | "outline" | "ghost" | "destructive";
  buttonSize?: "default" | "sm" | "lg" | "icon";
};

/**
 * UP Vote dialog — identical product rule across chains:
 * - Fixed $3 per vote
 * - One wallet transaction = one vote
 * - BNB/Robinhood: payable UPVoteTreasury call in the chain-native coin
 * - Solana: canonical V0 native SOL transfer + vote ingest
 */
export function UpvoteDialog({
  campaignAddress,
  tokenAddress,
  lane = "launchpad",
  chainId: chainIdOverride,
  className,
  buttonVariant = "secondary",
  buttonSize = "sm",
}: Props) {
  const isArena = lane === "arena";
  const voteIdentity = String((isArena ? tokenAddress || campaignAddress : campaignAddress || tokenAddress) || "").trim();
  const voteLabel = "UpVote";
  const { toast } = useToast();
  const wallet = useWallet();
  const solanaWallet = useSolanaWallet();

  const isSolanaCampaign =
    isSolanaChainId(Number(chainIdOverride)) ||
    Number(chainIdOverride) === 102 ||
    isSolanaAddress(voteIdentity);

  const chainId = isSolanaCampaign
    ? SOLANA_CHAIN_ID
    : getActiveChainId(chainIdOverride ?? wallet.chainId);
  const robinhood = isRobinhood(Number(chainId));
  const nativeUnit = isSolanaCampaign ? "SOL" : robinhood ? "ETH" : "BNB";
  const nativeDecimals = isSolanaCampaign ? 9 : 18;
  const { price: nativeUsdPrice, loading: nativePriceLoading } = useNativeUsdPrice(chainId);

  const treasuryAddress = useMemo(() => {
    const raw = isArena
      ? getArenaVoteTreasuryAddress(chainId as any)
      : getVoteTreasuryAddress(chainId as any);
    if (isSolanaCampaign) return String(raw || "").trim();
    return safeLowerHex(raw);
  }, [chainId, isArena, isSolanaCampaign]);

  const oracleAddress = useMemo(
    () => (isSolanaCampaign ? "" : safeLowerHex(getBnbContractAddresses(chainId as any).graduationOracle)),
    [chainId, isSolanaCampaign],
  );

  const evmReadProvider = useMemo(
    () => (isSolanaCampaign ? null : getReadProvider(chainId as any)),
    [chainId, isSolanaCampaign],
  );
  const walletOnCampaignChain = isSolanaCampaign
    ? Boolean(solanaWallet.solanaAccount)
    : Number(wallet.chainId) === Number(chainId);

  const [open, setOpen] = useState(false);
  const [loadingCfg, setLoadingCfg] = useState(false);
  const [minAmountWei, setMinAmountWei] = useState<bigint | null>(null);
  const [oracleTargetWei, setOracleTargetWei] = useState<bigint | null>(null);
  const [enabled, setEnabled] = useState<boolean>(true);
  const [hasContractCode, setHasContractCode] = useState<boolean | null>(null);
  const [balanceWei, setBalanceWei] = useState<bigint | null>(null);
  const [estTotalWei, setEstTotalWei] = useState<bigint | null>(null);
  const [insufficient, setInsufficient] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const lockDialog = submitting;
  const priceUsd = nativeUsdPrice;

  const fallbackUsdTargetWei = useMemo(() => {
    const p = Number(priceUsd ?? 0);
    if (!Number.isFinite(p) || p <= 0) return 0n;
    const native = UPVOTE_USD_TARGET / p;
    if (!Number.isFinite(native) || native <= 0) return 0n;
    try {
      return ethers.parseUnits(native.toFixed(nativeDecimals), nativeDecimals);
    } catch {
      return 0n;
    }
  }, [priceUsd, nativeDecimals]);

  const voteWei = useMemo(() => {
    let amount = minAmountWei ?? 0n;
    const usdTarget = oracleTargetWei ?? fallbackUsdTargetWei;
    if (usdTarget > amount) amount = usdTarget;
    if (isSolanaCampaign && amount < 1_000_000n) amount = 1_000_000n;
    return amount;
  }, [minAmountWei, oracleTargetWei, fallbackUsdTargetWei, isSolanaCampaign]);

  const priceReady = voteWei > 0n && !loadingCfg && !nativePriceLoading;
  const humanNative = useMemo(
    () => (voteWei > 0n ? formatNativeAmount(voteWei, nativeDecimals) : "—"),
    [voteWei, nativeDecimals],
  );

  const usdLabel = useMemo(() => {
    const p = Number(priceUsd ?? 0);
    if (!Number.isFinite(p) || p <= 0 || voteWei <= 0n) return `$${UPVOTE_USD_TARGET.toFixed(2)}`;
    try {
      const native = Number(ethers.formatUnits(voteWei, nativeDecimals));
      return `$${(native * p).toFixed(2)}`;
    } catch {
      return `$${UPVOTE_USD_TARGET.toFixed(2)}`;
    }
  }, [priceUsd, voteWei, nativeDecimals]);

  useEffect(() => {
    if (!open || !isSolanaCampaign) return;
    setHasContractCode(true);
    setEnabled(true);
    setMinAmountWei(1_000_000n);
    setOracleTargetWei(null);
  }, [open, isSolanaCampaign]);

  useEffect(() => {
    if (!open || isSolanaCampaign) return;
    if (!treasuryAddress || !evmReadProvider) {
      setHasContractCode(null);
      setEnabled(true);
      setMinAmountWei(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      setLoadingCfg(true);
      try {
        const code = await evmReadProvider.getCode(treasuryAddress);
        if (cancelled) return;
        if (!code || code === "0x") {
          setHasContractCode(false);
          setEnabled(false);
          setMinAmountWei(null);
          return;
        }
        setHasContractCode(true);
        const contract = new ethers.Contract(treasuryAddress, UPVOTE_ABI, evmReadProvider);
        const cfg = await contract.assetConfig(ethers.ZeroAddress);
        if (cancelled) return;
        setEnabled(Boolean(cfg?.enabled ?? cfg?.[0]));
        setMinAmountWei(BigInt(cfg?.minAmount ?? cfg?.[1] ?? 0n));
      } catch {
        if (!cancelled) {
          setHasContractCode(null);
          setEnabled(true);
          setMinAmountWei(null);
        }
      } finally {
        if (!cancelled) setLoadingCfg(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, treasuryAddress, evmReadProvider, isSolanaCampaign]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        if (isSolanaCampaign) {
          const owner = solanaWallet.solanaAccount;
          if (!owner) {
            setBalanceWei(null);
            return;
          }
          const web3 = await loadSolanaWeb3();
          const connection = new web3.Connection(getPublicRpcUrl(SOLANA_CHAIN_ID), "confirmed");
          const lamports = await connection.getBalance(new web3.PublicKey(owner));
          if (!cancelled) setBalanceWei(BigInt(lamports));
          return;
        }
        if (!evmReadProvider || !wallet.account) {
          setBalanceWei(null);
          return;
        }
        const bal = await evmReadProvider.getBalance(wallet.account);
        if (!cancelled) setBalanceWei(BigInt(bal));
      } catch {
        if (!cancelled) setBalanceWei(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, isSolanaCampaign, solanaWallet.solanaAccount, evmReadProvider, wallet.account]);

  useEffect(() => {
    if (!open || isSolanaCampaign) return;
    if (!evmReadProvider || !oracleAddress) {
      setOracleTargetWei(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const code = await evmReadProvider.getCode(oracleAddress);
        if (cancelled || !code || code === "0x") {
          if (!cancelled) setOracleTargetWei(null);
          return;
        }
        const oracle = new ethers.Contract(oracleAddress, GRADUATION_ORACLE_ABI, evmReadProvider);
        const target = await oracle.nativeTargetForUsd(ethers.parseEther(String(UPVOTE_USD_TARGET)));
        if (!cancelled) setOracleTargetWei(BigInt(target));
      } catch {
        if (!cancelled) setOracleTargetWei(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, evmReadProvider, oracleAddress, isSolanaCampaign]);

  useEffect(() => {
    if (!open) return;
    if (voteWei <= 0n) {
      setEstTotalWei(null);
      setInsufficient(false);
      return;
    }
    if (isSolanaCampaign) {
      const total = voteWei + 10_000n;
      setEstTotalWei(total);
      setInsufficient(balanceWei != null && balanceWei < total);
      return;
    }
    if (!walletOnCampaignChain || !wallet.provider || !wallet.account || !treasuryAddress) {
      setEstTotalWei(voteWei);
      setInsufficient(balanceWei != null && balanceWei < voteWei);
      return;
    }
    if (hasContractCode === false || !enabled) return;

    let cancelled = false;
    void (async () => {
      try {
        const fee = await wallet.provider!.getFeeData();
        const gasPrice = BigInt(fee.gasPrice ?? 0n);
        if (gasPrice === 0n) {
          if (!cancelled) {
            setEstTotalWei(voteWei);
            setInsufficient(balanceWei != null && balanceWei < voteWei);
          }
          return;
        }
        const contract = new ethers.Contract(treasuryAddress, UPVOTE_ABI, wallet.provider);
        const meta = ethers.keccak256(ethers.toUtf8Bytes(isArena ? "arena" : "user"));
        let gasLimit = 150000n;
        try {
          gasLimit = BigInt(await contract.voteWithBNB.estimateGas(voteIdentity, meta, { value: voteWei }));
        } catch {
          // Conservative fallback.
        }
        const total = voteWei + ((gasLimit * 120n) / 100n) * gasPrice;
        if (!cancelled) {
          setEstTotalWei(total);
          setInsufficient(balanceWei != null && balanceWei < total);
        }
      } catch {
        if (!cancelled) {
          setEstTotalWei(voteWei);
          setInsufficient(balanceWei != null && balanceWei < voteWei);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    open,
    isArena,
    isSolanaCampaign,
    walletOnCampaignChain,
    wallet.provider,
    wallet.account,
    treasuryAddress,
    hasContractCode,
    enabled,
    voteWei,
    voteIdentity,
    balanceWei,
  ]);

  const canUpvote = Boolean(
    treasuryAddress &&
      voteIdentity &&
      priceReady &&
      !insufficient &&
      (isSolanaCampaign
        ? Boolean(solanaWallet.solanaAccount)
        : walletOnCampaignChain && Boolean(wallet.signer) && hasContractCode !== false && enabled),
  );

  const handleSolanaUpvote = async () => {
    const ABORT = "__UPVOTE_ABORT__";
    const fail = (title: string, description: string) => {
      toast({ title, description });
      throw new Error(ABORT);
    };

    if (!treasuryAddress) {
      fail(`${voteLabel}s are temporarily unavailable`, `${voteLabel}s can’t be processed on Solana right now. Please try again later.`);
    }
    if (!solanaWallet.solanaAccount) {
      window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal"));
      return;
    }
    if (voteWei <= 0n) {
      fail("Price unavailable", "We couldn’t calculate the current SOL amount for the $3 UpVote. Please try again.");
    }
    if (balanceWei != null && balanceWei < (estTotalWei ?? voteWei)) {
      fail("Insufficient SOL", "You don't have enough SOL to cover the vote fee and network fees.");
    }
    if (!isSolanaAddress(voteIdentity)) {
      fail("Invalid token", isArena ? "This page is not a valid Solana token address." : "This page is not a valid Solana campaign address.");
    }

    const web3 = await loadSolanaWeb3();
    const rpc = String(import.meta.env.VITE_SOLANA_RPC || "").trim() || getPublicRpcUrl(SOLANA_CHAIN_ID);
    const connection = new web3.Connection(rpc, "confirmed");
    const lamports = voteWei > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(voteWei);
    if (!Number.isFinite(lamports) || lamports <= 0) {
      fail("Price unavailable", "Resolved vote amount was invalid.");
    }

    toast({ title: `Confirm ${voteLabel}`, description: `Pay ~$${UPVOTE_USD_TARGET} in SOL…` });

    let signature = "";
    try {
      signature = await submitSolanaUpvoteV0({
        web3,
        connection,
        voterAddress: solanaWallet.solanaAccount,
        treasuryAddress,
        campaignAddress: voteIdentity,
        lamports,
        lane,
      });
    } catch (signErr: unknown) {
      const msg = String((signErr as { message?: string })?.message || signErr || "");
      if (/buffer is not defined|Buffer is not defined/i.test(msg)) {
        fail(
          "Wallet unavailable",
          "Your wallet couldn’t prepare this transaction. Refresh the app and try again. If it continues, contact support.",
        );
      }
      throw signErr;
    }
    if (!signature) {
      fail("Upvote failed", "Wallet did not return a transaction signature.");
    }

    toast({ title: "Upvote sent", description: "Waiting for confirmation…" });
    const res = await apiFetch(isArena ? "/api/arena/votes/solana-ingest" : "/api/solana/vote-ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chainId: SOLANA_CHAIN_ID,
        signature,
        campaignAddress: voteIdentity,
        tokenAddress: voteIdentity,
        voterAddress: solanaWallet.solanaAccount,
      }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !Array.isArray(body?.items) || !body.items[0]) {
      fail("Vote paid but not recorded", `Your payment was confirmed, but the vote could not be recorded. Contact support with transaction ${signature.slice(0, 12)}…`);
    }
    const ingest = body.items[0];
    toast({ title: "Upvoted", description: "Your vote has been recorded." });
    setOpen(false);
    window.dispatchEvent(new CustomEvent(isArena ? "memewarzone:arenaUpvoteConfirmed" : "memewarzone:upvoteConfirmed", {
      detail: {
        chainId: SOLANA_CHAIN_ID,
        campaignAddress: ingest?.campaignAddress || voteIdentity,
        tokenAddress: voteIdentity,
        txHash: signature,
        votes24h: ingest?.votes24h != null ? Number(ingest.votes24h) : undefined,
        votesAllTime: ingest?.votesAllTime != null ? Number(ingest.votesAllTime) : undefined,
      },
    }));
  };

  const handleEvmUpvote = async () => {
    const ABORT = "__UPVOTE_ABORT__";
    const fail = (title: string, description: string) => {
      toast({ title, description });
      throw new Error(ABORT);
    };

    if (!treasuryAddress || hasContractCode === false) {
      fail(`${voteLabel}s are temporarily unavailable`, `${voteLabel}s can’t be processed on this network right now. Please try again later.`);
    }
    if (!wallet.signer || !wallet.account) {
      window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal"));
      return;
    }
    if (!walletOnCampaignChain) {
      window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal"));
      fail(`Switch to ${robinhood ? "Robinhood" : "BNB"}`, `This campaign uses ${nativeUnit}. Connect the wallet on the campaign network before voting.`);
    }
    if (voteWei <= 0n) {
      fail("Price unavailable", `We couldn’t calculate the current ${nativeUnit} amount for the $3 UpVote. Please try again.`);
    }
    if (balanceWei != null && balanceWei < (estTotalWei ?? voteWei)) {
      fail(`Insufficient ${nativeUnit}`, `You don't have enough ${nativeUnit} to cover the vote fee and gas.`);
    }

    const contract = new ethers.Contract(treasuryAddress, UPVOTE_ABI, wallet.signer);
    const meta = ethers.keccak256(ethers.toUtf8Bytes(isArena ? "arena" : "user"));
    let gasPrice: bigint | undefined;
    try {
      const gpHex = await wallet.provider!.send("eth_gasPrice", []);
      gasPrice = gpHex ? BigInt(gpHex) : undefined;
    } catch {
      const fee = await wallet.provider!.getFeeData().catch(() => null);
      gasPrice = fee?.gasPrice != null ? BigInt(fee.gasPrice) : undefined;
    }

    const overrides: { value: bigint; gasPrice?: bigint; type?: number } = { value: voteWei };
    if (gasPrice && gasPrice > 0n) {
      overrides.gasPrice = gasPrice;
      overrides.type = 0;
    }

    const tx = await contract.voteWithBNB(voteIdentity, meta, overrides);
    const txHash = String(tx?.hash || "");
    toast({ title: "Upvote sent", description: "Waiting for confirmation…" });
    await tx.wait();

    let ingest: { votes24h?: number; votesAllTime?: number; campaignAddress?: string } | null = null;
    if (txHash) {
      try {
        const res = await apiFetch(isArena ? "/api/arena/votes/ingest" : "/api/vote-ingest", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chainId, txHash }),
        });
        const body = await res.json().catch(() => null);
        if (res.ok && Array.isArray(body?.items) && body.items[0]) {
          ingest = body.items[0];
        } else if (isArena) {
          fail(
            "Vote paid but not recorded",
            `Your payment was confirmed, but the Arena vote could not be recorded. Contact support with transaction ${txHash.slice(0, 12)}…`,
          );
        }
      } catch (ingestErr) {
        console.warn("[UpvoteDialog] vote ingest error", ingestErr);
        if (isArena) {
          fail(
            "Vote paid but not recorded",
            `Your payment was confirmed, but the Arena vote could not be recorded. Contact support with transaction ${txHash.slice(0, 12)}…`,
          );
        }
      }
    }

    toast({ title: "Upvoted", description: "Your vote has been recorded." });
    setOpen(false);
    const addr = safeLowerHex(ingest?.campaignAddress || voteIdentity);
    window.dispatchEvent(new CustomEvent(isArena ? "memewarzone:arenaUpvoteConfirmed" : "memewarzone:upvoteConfirmed", {
      detail: {
        chainId,
        campaignAddress: addr,
        tokenAddress: voteIdentity,
        txHash,
        votes24h: ingest?.votes24h != null ? Number(ingest.votes24h) : undefined,
        votesAllTime: ingest?.votesAllTime != null ? Number(ingest.votesAllTime) : undefined,
      },
    }));
  };

  const handleUpvote = async () => {
    try {
      setSubmitting(true);
      if (isSolanaCampaign) await handleSolanaUpvote();
      else await handleEvmUpvote();
    } catch (e: unknown) {
      const err = e as { shortMessage?: string; message?: string };
      const msg = String(err?.shortMessage || err?.message || "Transaction failed");
      if (!msg.includes("__UPVOTE_ABORT__")) toast({ title: "Upvote failed", description: msg });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && lockDialog) return;
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant={buttonVariant}
          size={buttonSize}
          className={className}
          title={!treasuryAddress ? `${voteLabel}s are temporarily unavailable` : voteLabel}
        >
          {voteLabel}
        </Button>
      </DialogTrigger>
      <DialogContent
        onPointerDownOutside={(e) => { if (lockDialog) e.preventDefault(); }}
        onInteractOutside={(e) => { if (lockDialog) e.preventDefault(); }}
        onEscapeKeyDown={(e) => { if (lockDialog) e.preventDefault(); }}
      >
        <DialogHeader>
          <DialogTitle>{voteLabel}</DialogTitle>
          <DialogDescription>
            Fixed price: ${UPVOTE_USD_TARGET} per vote. One transaction = one vote (paid in {nativeUnit}).
            {isArena ? " Ranks the Warzone featured rail, not Showcase." : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {loadingCfg ? (
            <div className="text-sm text-muted-foreground">Loading fee…</div>
          ) : !treasuryAddress ? (
            <div className="text-sm text-muted-foreground">{voteLabel}s are temporarily unavailable on this network. Please try again later.</div>
          ) : !isSolanaCampaign && (hasContractCode === false || !enabled) ? (
            <div className="text-sm text-muted-foreground">{voteLabel}s are temporarily unavailable on this network. Please try again later.</div>
          ) : (
            <div className="rounded-md border border-border/60 bg-muted/30 px-4 py-3">
              <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Vote price</div>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-2xl font-semibold text-foreground">{usdLabel}</span>
                <span className="text-sm text-muted-foreground">{priceReady ? `${humanNative} ${nativeUnit}` : `— ${nativeUnit}`}</span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {oracleTargetWei != null && !isSolanaCampaign
                  ? "Converted via on-chain oracle"
                  : priceUsd
                    ? `Converted via live ${nativeUnit}/USD`
                    : `Waiting for ${nativeUnit} price…`}
              </div>
            </div>
          )}

          {!isSolanaCampaign && wallet.account && !walletOnCampaignChain ? (
            <div className="rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
              This campaign is on {robinhood ? "Robinhood" : "BNB"}. Switch the connected wallet network before voting.
            </div>
          ) : null}

          <div className="text-xs text-muted-foreground">
            Balance: <span className="text-foreground">{balanceWei != null ? `${formatNativeAmount(balanceWei, nativeDecimals)} ${nativeUnit}` : "—"}</span>
            {insufficient ? <span className="ml-2 text-destructive">Insufficient for this vote{isSolanaCampaign ? " + fees." : " + gas."}</span> : null}
          </div>
          <div className="text-xs text-muted-foreground">
            {isArena ? "UpVotes are separate from launchpad votes." : "Cooldown and daily limits apply to keep UpVotes fair."}
          </div>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)} disabled={submitting}>Cancel</Button>
          <Button onClick={handleUpvote} disabled={!canUpvote || submitting || loadingCfg}>
            {submitting ? "Voting…" : `${voteLabel} (${nativeUnit})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ArenaUpvoteDialog(
  props: Omit<Props, "lane" | "campaignAddress"> & { tokenAddress: string; campaignAddress?: string },
) {
  return <UpvoteDialog {...props} lane="arena" campaignAddress={props.campaignAddress || props.tokenAddress} />;
}
