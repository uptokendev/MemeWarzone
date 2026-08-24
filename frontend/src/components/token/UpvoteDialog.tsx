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
import { useBnbUsdPrice } from "@/hooks/useBnbUsdPrice";
import { getActiveChainId, getVoteTreasuryAddress, isSolanaChainId, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import { getBnbContractAddresses } from "@/lib/bnbContracts";
import { apiFetch } from "@/lib/apiBase";
import { getPublicRpcUrl } from "@/lib/chainConfig";
import { isSolanaAddress } from "@/lib/address";
import { getSolanaProvider } from "@/lib/solanaWallet";
import { loadSolanaWeb3 } from "@/lib/solanaWeb3";

/** Fixed UP Vote price in USD. Same product on BNB and Solana. */
const UPVOTE_USD_TARGET = 3;
const UPVOTE_DISPLAY_DECIMALS = 6;
const UPVOTE_DISPLAY_SCALE_WEI = 10n ** BigInt(18 - UPVOTE_DISPLAY_DECIMALS);

function floorToDisplayPrecision(wei: bigint) {
  return (wei / UPVOTE_DISPLAY_SCALE_WEI) * UPVOTE_DISPLAY_SCALE_WEI;
}

function formatDisplayBnb(wei: bigint) {
  const formatted = ethers.formatEther(floorToDisplayPrecision(wei));
  const [whole, fraction = ""] = formatted.split(".");
  const trimmed = fraction.slice(0, UPVOTE_DISPLAY_DECIMALS).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

const UPVOTE_ABI = [
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

async function fetchSolUsd(): Promise<number | null> {
  const sources = [
    async () => {
      const res = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
        { cache: "no-store" },
      );
      const json = await res.json();
      return Number(json?.solana?.usd);
    },
    async () => {
      const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT", {
        cache: "no-store",
      });
      const json = await res.json();
      return Number(json?.price);
    },
  ];
  for (const source of sources) {
    try {
      const p = await source();
      if (Number.isFinite(p) && p > 0) return p;
    } catch {
      // try next oracle
    }
  }
  return null;
}

type Props = {
  campaignAddress: string;
  chainId?: number | null;
  className?: string;
  buttonVariant?: "default" | "secondary" | "outline" | "ghost" | "destructive";
  buttonSize?: "default" | "sm" | "lg" | "icon";
};

/**
 * UP Vote dialog — same UX on BNB and Solana:
 * - Fixed $3 per vote
 * - One wallet transaction = one vote
 * - BNB: UPVoteTreasury.voteWithBNB
 * - Solana: native SOL transfer to vote treasury + /api/solana/vote-ingest
 */
export function UpvoteDialog({
  campaignAddress,
  chainId: chainIdOverride,
  className,
  buttonVariant = "secondary",
  buttonSize = "sm",
}: Props) {
  const { toast } = useToast();
  const wallet = useWallet();
  const solanaWallet = useSolanaWallet();
  const { price: bnbUsdPrice } = useBnbUsdPrice();

  const isSolanaCampaign =
    isSolanaChainId(Number(chainIdOverride)) ||
    Number(chainIdOverride) === 102 ||
    isSolanaAddress(campaignAddress);

  const chainId = isSolanaCampaign
    ? SOLANA_CHAIN_ID
    : getActiveChainId(chainIdOverride ?? wallet.chainId);

  const treasuryAddress = useMemo(() => {
    const raw = getVoteTreasuryAddress(chainId as any);
    if (isSolanaCampaign) return String(raw || "").trim();
    return safeLowerHex(raw);
  }, [chainId, isSolanaCampaign]);

  const nativeUnit = isSolanaCampaign ? "SOL" : "BNB";
  const nativeDecimals = isSolanaCampaign ? 9 : 18;

  const oracleAddress = useMemo(
    () => (isSolanaCampaign ? "" : safeLowerHex(getBnbContractAddresses(chainId as any).graduationOracle)),
    [chainId, isSolanaCampaign],
  );

  const [open, setOpen] = useState(false);
  const [loadingCfg, setLoadingCfg] = useState(false);
  const [minAmountWei, setMinAmountWei] = useState<bigint | null>(null);
  const [oracleTargetWei, setOracleTargetWei] = useState<bigint | null>(null);
  const [solUsd, setSolUsd] = useState<number | null>(null);
  const [enabled, setEnabled] = useState<boolean>(true);
  const [hasContractCode, setHasContractCode] = useState<boolean | null>(null);
  const [balanceWei, setBalanceWei] = useState<bigint | null>(null);
  const [estTotalWei, setEstTotalWei] = useState<bigint | null>(null);
  const [insufficient, setInsufficient] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const lockDialog = submitting;
  const priceUsd = isSolanaCampaign ? solUsd : bnbUsdPrice;

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

  /** Exact native amount we will send: max(on-chain min, $3 target). */
  const voteWei = useMemo(() => {
    let m = minAmountWei ?? 0n;
    const usdTarget = oracleTargetWei ?? fallbackUsdTargetWei;
    if (usdTarget > m) m = usdTarget;
    // Solana floor so dust transfers never count as a vote
    if (isSolanaCampaign && m < 1_000_000n) m = 1_000_000n;
    return m;
  }, [minAmountWei, oracleTargetWei, fallbackUsdTargetWei, isSolanaCampaign]);

  const priceReady = voteWei > 0n && !loadingCfg;
  const humanNative = useMemo(
    () => (voteWei > 0n ? formatNativeAmount(voteWei, nativeDecimals) : "—"),
    [voteWei, nativeDecimals],
  );

  const usdLabel = useMemo(() => {
    const p = Number(priceUsd ?? 0);
    if (!Number.isFinite(p) || p <= 0 || voteWei <= 0n) return `$${UPVOTE_USD_TARGET.toFixed(2)}`;
    try {
      const native = Number(ethers.formatUnits(voteWei, nativeDecimals));
      const usd = native * p;
      return `$${usd.toFixed(2)}`;
    } catch {
      return `$${UPVOTE_USD_TARGET.toFixed(2)}`;
    }
  }, [priceUsd, voteWei, nativeDecimals]);

  // Load SOL/USD when dialog opens on Solana
  useEffect(() => {
    if (!open || !isSolanaCampaign) return;
    let cancelled = false;
    (async () => {
      setLoadingCfg(true);
      const p = await fetchSolUsd();
      if (!cancelled) {
        setSolUsd(p);
        setLoadingCfg(false);
        setHasContractCode(true);
        setEnabled(true);
        setMinAmountWei(1_000_000n);
        setOracleTargetWei(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, isSolanaCampaign]);

  // BNB treasury config (EVM only)
  useEffect(() => {
    if (!open || isSolanaCampaign) return;
    if (!treasuryAddress || !wallet.provider) {
      setHasContractCode(null);
      setEnabled(true);
      setMinAmountWei(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoadingCfg(true);
      try {
        const code = await wallet.provider!.getCode(treasuryAddress);
        if (cancelled) return;
        if (!code || code === "0x") {
          setHasContractCode(false);
          setEnabled(false);
          setMinAmountWei(null);
          return;
        }
        setHasContractCode(true);
        const c = new ethers.Contract(treasuryAddress, UPVOTE_ABI, wallet.provider);
        const cfg = await c.assetConfig(ethers.ZeroAddress);
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
  }, [open, treasuryAddress, wallet.provider, isSolanaCampaign]);

  // Balances
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
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
        if (!wallet.provider || !wallet.account) {
          setBalanceWei(null);
          return;
        }
        const bal = await wallet.provider.getBalance(wallet.account);
        if (!cancelled) setBalanceWei(BigInt(bal));
      } catch {
        if (!cancelled) setBalanceWei(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, isSolanaCampaign, solanaWallet.solanaAccount, wallet.provider, wallet.account]);

  // Oracle $3 → native (BNB only)
  useEffect(() => {
    if (!open || isSolanaCampaign) return;
    if (!wallet.provider || !oracleAddress) {
      setOracleTargetWei(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const code = await wallet.provider!.getCode(oracleAddress);
        if (cancelled || !code || code === "0x") {
          if (!cancelled) setOracleTargetWei(null);
          return;
        }
        const oracle = new ethers.Contract(oracleAddress, GRADUATION_ORACLE_ABI, wallet.provider);
        const target = await oracle.nativeTargetForUsd(ethers.parseEther(String(UPVOTE_USD_TARGET)));
        if (!cancelled) setOracleTargetWei(BigInt(target));
      } catch {
        if (!cancelled) setOracleTargetWei(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, wallet.provider, oracleAddress, isSolanaCampaign]);

  // Estimate total + insufficient
  useEffect(() => {
    if (!open) return;
    if (voteWei <= 0n) {
      setEstTotalWei(null);
      setInsufficient(false);
      return;
    }
    if (isSolanaCampaign) {
      // ~5k lamports fee buffer
      const total = voteWei + 10_000n;
      setEstTotalWei(total);
      setInsufficient(balanceWei != null && balanceWei < total);
      return;
    }
    if (!wallet.provider || !wallet.account || !treasuryAddress) return;
    if (hasContractCode === false || !enabled) return;

    let cancelled = false;
    (async () => {
      try {
        const fee = await wallet.provider!.getFeeData();
        const gasPrice = BigInt(fee.gasPrice ?? 0n);
        if (gasPrice === 0n) {
          if (cancelled) return;
          setEstTotalWei(voteWei);
          if (balanceWei != null) setInsufficient(balanceWei < voteWei);
          return;
        }
        const c = new ethers.Contract(treasuryAddress, UPVOTE_ABI, wallet.provider);
        const meta = ethers.keccak256(ethers.toUtf8Bytes("user"));
        let gasLimit: bigint;
        try {
          gasLimit = BigInt(
            await c.voteWithBNB.estimateGas(campaignAddress, meta, { value: voteWei }),
          );
        } catch {
          gasLimit = 150000n;
        }
        const bufferedGas = (gasLimit * 120n) / 100n;
        const total = voteWei + bufferedGas * gasPrice;
        if (cancelled) return;
        setEstTotalWei(total);
        if (balanceWei != null) setInsufficient(balanceWei < total);
      } catch {
        if (!cancelled) {
          setEstTotalWei(null);
          setInsufficient(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    open,
    isSolanaCampaign,
    wallet.provider,
    wallet.account,
    treasuryAddress,
    hasContractCode,
    enabled,
    voteWei,
    campaignAddress,
    balanceWei,
  ]);

  const canUpvote = Boolean(
    treasuryAddress &&
      campaignAddress &&
      priceReady &&
      !insufficient &&
      (isSolanaCampaign
        ? Boolean(solanaWallet.solanaAccount)
        : hasContractCode !== false && enabled && wallet.provider),
  );

  const handleSolanaUpvote = async () => {
    const ABORT = "__UPVOTE_ABORT__";
    const fail = (title: string, description: string) => {
      toast({ title, description });
      throw new Error(ABORT);
    };

    if (!treasuryAddress) fail("UP Votes are temporarily unavailable", "UP Votes can’t be processed on Solana right now. Please try again later.");
    if (!solanaWallet.solanaAccount) {
      window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal"));
      return;
    }
    if (voteWei <= 0n) fail("Price unavailable", "We couldn’t calculate the current SOL amount for the $3 UP Vote. Please try again.");
    if (balanceWei != null && balanceWei < (estTotalWei ?? voteWei)) {
      fail("Insufficient SOL", "You don't have enough SOL to cover the vote fee (and fees).");
    }
    if (!isSolanaAddress(campaignAddress)) {
      fail("Invalid campaign", "This page is not a valid Solana campaign address.");
    }

    const provider = getSolanaProvider();
    if (!provider?.publicKey || typeof provider.signTransaction !== "function") {
      fail("Wallet unavailable", "Connect Phantom / Solflare to vote on Solana.");
    }

    try {
      await import("@/polyfills");
    } catch {
      // polyfills already loaded from main entry
    }

    const web3 = await loadSolanaWeb3();
    const rpc =
      String(import.meta.env.VITE_SOLANA_RPC || "").trim() ||
      getPublicRpcUrl(SOLANA_CHAIN_ID) ||
      "https://api.mainnet-beta.solana.com";
    const connection = new web3.Connection(rpc, "confirmed");
    const from = new web3.PublicKey(solanaWallet.solanaAccount);
    const to = new web3.PublicKey(treasuryAddress);
    const latest = await connection.getLatestBlockhash("confirmed");

    const lamports = voteWei > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(voteWei);
    if (!Number.isFinite(lamports) || lamports <= 0) {
      fail("Price unavailable", "Resolved vote amount was invalid.");
    }

    const tx = new web3.Transaction();
    tx.feePayer = from;
    tx.recentBlockhash = latest.blockhash;
    tx.add(
      new web3.TransactionInstruction({
        keys: [{ pubkey: from, isSigner: true, isWritable: false }],
        programId: new web3.PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
        data: Buffer.from(`mwz-upvote:${campaignAddress}`, "utf8"),
      }),
    );
    tx.add(
      web3.SystemProgram.transfer({
        fromPubkey: from,
        toPubkey: to,
        lamports,
      }),
    );

    toast({ title: "Confirm UP Vote", description: `Pay ~$${UPVOTE_USD_TARGET} in SOL…` });

    let signature = "";
    try {
      const signed = await provider.signTransaction!(tx);
      const raw =
        typeof signed?.serialize === "function"
          ? signed.serialize()
          : tx.serialize({ requireAllSignatures: false, verifySignatures: false });
      signature = await connection.sendRawTransaction(raw, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
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
    if (!signature) fail("Upvote failed", "Wallet did not return a transaction signature.");

    toast({ title: "Upvote sent", description: "Waiting for confirmation…" });
    await connection.confirmTransaction({ signature, ...latest }, "confirmed");

    let ingest: { votes24h?: number; votesAllTime?: number; campaignAddress?: string } | null = null;
    try {
      const res = await apiFetch("/api/solana/vote-ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chainId: SOLANA_CHAIN_ID,
          signature,
          campaignAddress,
          voterAddress: solanaWallet.solanaAccount,
        }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && Array.isArray(body?.items) && body.items[0]) {
        ingest = body.items[0];
      } else {
        console.warn("[UpvoteDialog] solana vote ingest failed", res.status, body);
        fail(
          "Vote paid but not recorded",
          `Your payment was confirmed, but the vote could not be recorded. Contact support with transaction ${signature.slice(0, 12)}…`,
        );
      }
    } catch (e: any) {
      if (String(e?.message || "").includes(ABORT)) throw e;
      console.warn("[UpvoteDialog] solana vote ingest error", e);
      fail(
        "Vote paid but not recorded",
        `Your payment was confirmed, but the vote could not be recorded. Contact support with transaction ${signature.slice(0, 12)}…`,
      );
    }

    toast({ title: "Upvoted", description: "Your vote has been recorded." });
    setOpen(false);
    try {
      window.dispatchEvent(
        new CustomEvent("memewarzone:upvoteConfirmed", {
          detail: {
            chainId: SOLANA_CHAIN_ID,
            campaignAddress: ingest?.campaignAddress || campaignAddress,
            txHash: signature,
            votes24h: ingest?.votes24h != null ? Number(ingest.votes24h) : undefined,
            votesAllTime: ingest?.votesAllTime != null ? Number(ingest.votesAllTime) : undefined,
          },
        }),
      );
    } catch {
      // ignore
    }
  };

  const handleBnbUpvote = async () => {
    const ABORT = "__UPVOTE_ABORT__";
    const fail = (title: string, description: string) => {
      toast({ title, description });
      throw new Error(ABORT);
    };

    if (!treasuryAddress) fail("UP Votes are temporarily unavailable", "UP Votes can’t be processed on this network right now. Please try again later.");
    if (hasContractCode === false) {
      fail(
        "UP Votes are temporarily unavailable",
        "UP Votes can’t be processed on this network right now. Please try again later.",
      );
    }
    if (!wallet.signer) {
      window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal"));
      return;
    }
    if (voteWei <= 0n) fail("Price unavailable", "We couldn’t calculate the current BNB amount for the $3 UP Vote. Please try again.");
    if (balanceWei != null && balanceWei < (estTotalWei ?? voteWei)) {
      fail("Insufficient BNB", "You don't have enough BNB to cover the vote fee (and gas).");
    }

    const c = new ethers.Contract(treasuryAddress, UPVOTE_ABI, wallet.signer);
    const meta = ethers.keccak256(ethers.toUtf8Bytes("user"));
    let gasPrice: bigint | undefined;
    try {
      const gpHex = await wallet.provider!.send("eth_gasPrice", []);
      gasPrice = gpHex ? BigInt(gpHex) : undefined;
    } catch {
      try {
        const fee = await wallet.provider!.getFeeData();
        gasPrice = fee.gasPrice != null ? BigInt(fee.gasPrice) : undefined;
      } catch {
        gasPrice = undefined;
      }
    }

    const overrides: { value: bigint; gasPrice?: bigint; type?: number } = { value: voteWei };
    if (gasPrice && gasPrice > 0n) {
      overrides.gasPrice = gasPrice;
      overrides.type = 0;
    }

    const tx = await c.voteWithBNB(campaignAddress, meta, overrides);
    const txHash = String(tx?.hash || "");
    toast({ title: "Upvote sent", description: "Waiting for confirmation…" });
    await tx.wait();

    let ingest: { votes24h?: number; votesAllTime?: number; campaignAddress?: string } | null = null;
    if (txHash) {
      try {
        const res = await apiFetch("/api/vote-ingest", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chainId, txHash }),
        });
        const body = await res.json().catch(() => null);
        if (res.ok && Array.isArray(body?.items) && body.items[0]) ingest = body.items[0];
      } catch (ingestErr) {
        console.warn("[UpvoteDialog] vote ingest error", ingestErr);
      }
    }

    toast({ title: "Upvoted", description: "Your vote has been recorded." });
    setOpen(false);
    try {
      const addr = safeLowerHex(ingest?.campaignAddress || campaignAddress);
      window.dispatchEvent(
        new CustomEvent("memewarzone:upvoteConfirmed", {
          detail: {
            chainId,
            campaignAddress: addr,
            txHash,
            votes24h: ingest?.votes24h != null ? Number(ingest.votes24h) : undefined,
            votesAllTime: ingest?.votesAllTime != null ? Number(ingest.votesAllTime) : undefined,
          },
        }),
      );
    } catch {
      // ignore
    }
  };

  const handleUpvote = async () => {
    try {
      setSubmitting(true);
      if (isSolanaCampaign) await handleSolanaUpvote();
      else await handleBnbUpvote();
    } catch (e: unknown) {
      const err = e as { shortMessage?: string; message?: string };
      const msg = String(err?.shortMessage || err?.message || "Transaction failed");
      if (!msg.includes("__UPVOTE_ABORT__")) {
        toast({ title: "Upvote failed", description: msg });
      }
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
          title={!treasuryAddress ? "UP Votes are temporarily unavailable" : "Upvote"}
        >
          UP Vote
        </Button>
      </DialogTrigger>
      <DialogContent
        onPointerDownOutside={(e) => {
          if (lockDialog) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (lockDialog) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (lockDialog) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>UP Vote</DialogTitle>
          <DialogDescription>
            Fixed price: ${UPVOTE_USD_TARGET} per vote. One transaction = one vote
            {isSolanaCampaign ? " (paid in SOL)." : " (paid in BNB)."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {loadingCfg ? (
            <div className="text-sm text-muted-foreground">Loading fee…</div>
          ) : !treasuryAddress ? (
            <div className="text-sm text-muted-foreground">
              UP Votes are temporarily unavailable on this network. Please try again later.
            </div>
          ) : !isSolanaCampaign && (hasContractCode === false || !enabled) ? (
            <div className="text-sm text-muted-foreground">
              UP Votes are temporarily unavailable on this network. Please try again later.
            </div>
          ) : (
            <div className="rounded-md border border-border/60 bg-muted/30 px-4 py-3">
              <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                Vote price
              </div>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-2xl font-semibold text-foreground">{usdLabel}</span>
                <span className="text-sm text-muted-foreground">
                  {priceReady ? `${humanNative} ${nativeUnit}` : `— ${nativeUnit}`}
                </span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {isSolanaCampaign
                  ? priceUsd
                    ? "Converted via live SOL/USD"
                    : "Waiting for SOL price…"
                  : oracleTargetWei != null
                    ? "Converted via on-chain oracle"
                    : priceUsd
                      ? "Converted via live BNB/USD"
                      : "Waiting for price…"}
              </div>
            </div>
          )}

          <div className="text-xs text-muted-foreground">
            Balance:{" "}
            <span className="text-foreground">
              {balanceWei != null ? `${formatNativeAmount(balanceWei, nativeDecimals)} ${nativeUnit}` : "—"}
            </span>
            {insufficient ? (
              <span className="ml-2 text-destructive">
                Insufficient for this vote{isSolanaCampaign ? " + fees." : " + gas."}
              </span>
            ) : null}
          </div>

          <div className="text-xs text-muted-foreground">
            Cooldown and daily limits apply to keep UP Votes fair.
          </div>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleUpvote} disabled={!canUpvote || submitting || loadingCfg}>
            {submitting ? "Voting…" : `UP Vote (${nativeUnit})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
