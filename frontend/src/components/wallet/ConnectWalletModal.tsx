import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Loader2,
  RefreshCcw,
  Sparkles,
  Wallet,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";

import { useWallet } from "@/contexts/WalletContext";
import {
  resolveBnbFeedChainId,
  resolveRobinhoodFeedChainId,
  setSelectedFeedChainId,
} from "@/components/common/ChainFeedSwitch";
import {
  BNB_CHAIN_ID,
  BNB_TESTNET_CHAIN_ID,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_TESTNET_CHAIN_ID,
  SOLANA_CHAIN_ID,
  type SupportedChainId,
} from "@/lib/chainConfig";
import { WAKE_PROVIDER_DISCOVERY_DELAYS_MS } from "@/lib/injectedProviderDiscovery";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";

import type { DetectedWallet, WalletType } from "@/contexts/WalletContext";

type ConnectWalletModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filter?: "evm" | "solana" | null;
};

type WalletChainChoice = "bnb" | "solana" | "robinhood";

type UnifiedWalletOption =
  | {
    kind: "evm";
    key: string;
    id: WalletType;
    name: string;
    description: string;
    icon?: string;
    detected: boolean;
    sortScore: number;
    wallet: DetectedWallet;
  }
  | {
    kind: "solana";
    key: string;
    id: string;
    name: string;
    description: string;
    icon: string;
    detected: boolean;
    sortScore: number;
  };

const INITIAL_VISIBLE_WALLETS = 4;

function shortAddress(address: string) {
  if (!address) return "";
  return address.length > 10 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address;
}

function getWalletInitial(name: string) {
  return name.trim().slice(0, 1).toUpperCase() || "W";
}

function getWalletError(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    const message = String((error as { message?: unknown }).message ?? "");
    if (message) return message;
  }

  return "Wallet connection failed. Please try again from the wallet popup.";
}

function normalizedName(value: string) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function walletPriority(option: UnifiedWalletOption) {
  const id = normalizedName(String(option.id));
  const name = normalizedName(option.name);
  const key = `${id}:${name}`;

  if (option.kind === "evm" && (id.includes("metamask") || name.includes("metamask"))) return 1000;
  if (option.kind === "solana" && (id.includes("phantom") || name.includes("phantom"))) return 990;
  if (option.kind === "solana" && (id.includes("solflare") || name.includes("solflare"))) return 980;
  if (option.kind === "solana" && (id.includes("backpack") || name.includes("backpack"))) return 970;
  if (key.includes("cryptocom") || key.includes("crypto.com")) return 960;
  if (id.includes("rabby") || name.includes("rabby")) return 950;
  if (id.includes("coinbase") || name.includes("coinbase")) return 940;
  if (id.includes("trust") || name.includes("trust")) return 930;
  if (id.includes("okx") || name.includes("okx")) return 920;
  if (option.kind === "evm") return 800 + option.sortScore;
  return 700 + option.sortScore;
}

function evmChainParams(chainId: SupportedChainId) {
  if (chainId === ROBINHOOD_TESTNET_CHAIN_ID) {
    return {
      chainId: `0x${chainId.toString(16)}`,
      chainName: "Robinhood Chain Testnet",
      nativeCurrency: { name: "Ethereum", symbol: "ETH", decimals: 18 },
      rpcUrls: ["https://rpc.testnet.chain.robinhood.com"],
      blockExplorerUrls: ["https://explorer.testnet.chain.robinhood.com"],
    };
  }
  if (chainId === ROBINHOOD_CHAIN_ID) {
    return {
      chainId: `0x${chainId.toString(16)}`,
      chainName: "Robinhood Chain",
      nativeCurrency: { name: "Ethereum", symbol: "ETH", decimals: 18 },
      rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
      blockExplorerUrls: ["https://explorer.chain.robinhood.com"],
    };
  }
  if (chainId === BNB_TESTNET_CHAIN_ID) {
    return {
      chainId: `0x${chainId.toString(16)}`,
      chainName: "BNB Smart Chain Testnet",
      nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
      rpcUrls: ["https://data-seed-prebsc-1-s1.binance.org:8545/"],
      blockExplorerUrls: ["https://testnet.bscscan.com"],
    };
  }
  return {
    chainId: `0x${BNB_CHAIN_ID.toString(16)}`,
    chainName: "BNB Smart Chain",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: ["https://bsc-dataseed.binance.org/"],
    blockExplorerUrls: ["https://bscscan.com"],
  };
}

async function switchDetectedWalletChain(wallet: DetectedWallet, chainId: SupportedChainId) {
  const hexChainId = `0x${chainId.toString(16)}`;
  try {
    await wallet.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexChainId }] });
  } catch (error: any) {
    const code = Number(error?.code ?? error?.data?.originalError?.code ?? 0);
    if (code !== 4902) throw error;
    await wallet.provider.request({ method: "wallet_addEthereumChain", params: [evmChainParams(chainId)] });
    await wallet.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexChainId }] });
  }
}

function WalletIcon({ option }: { option: UnifiedWalletOption }) {
  const [imageFailed, setImageFailed] = useState(false);

  if (option.kind === "evm" && option.icon && !imageFailed) {
    return (
      <img
        src={option.icon}
        alt=""
        className="h-10 w-10 rounded-2xl object-cover shadow-[0_0_26px_-12px_rgba(240,106,26,0.9)]"
        onError={() => setImageFailed(true)}
      />
    );
  }

  if (option.kind === "solana") {
    return (
      <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-purple-500/15 text-xl text-purple-300 shadow-[0_0_26px_-12px_rgba(168,85,247,0.9)]">
        {option.icon || getWalletInitial(option.name)}
      </div>
    );
  }

  return (
    <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-accent/25 bg-accent/10 font-retro text-sm text-accent shadow-[0_0_26px_-12px_rgba(240,106,26,0.9)]">
      {getWalletInitial(option.name)}
    </div>
  );
}

function WalletRow({
  option,
  disabled,
  connecting,
  onConnect,
}: {
  option: UnifiedWalletOption;
  disabled: boolean;
  connecting: boolean;
  onConnect: (option: UnifiedWalletOption) => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onConnect(option)}
      className="group relative w-full overflow-hidden rounded-2xl border border-border/70 bg-card/80 px-3 py-3 text-left transition-all duration-200 hover:border-accent/45 hover:bg-card disabled:cursor-not-allowed disabled:opacity-70"
    >
      <div className="absolute inset-0 bg-gradient-to-br from-accent/10 via-transparent to-primary/15 opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
      <div className="relative flex items-center gap-3">
        <WalletIcon option={option} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate font-retro text-sm text-foreground">{option.name}</p>
            {option.detected && (
              <span className={`${option.kind === "solana" ? "border-purple-400/30 bg-purple-400/10 text-purple-300" : "border-accent/30 bg-accent/10 text-accent"} rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.16em]`}>
                detected
              </span>
            )}
          </div>
          <p className="mt-1 line-clamp-1 text-xs leading-relaxed text-muted-foreground">{option.description}</p>
        </div>

        <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/70 bg-background/50 text-muted-foreground transition-colors group-hover:border-accent/40 group-hover:text-accent">
          {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />}
        </div>
      </div>
    </button>
  );
}

export function ConnectWalletModal({ open, onOpenChange, filter }: ConnectWalletModalProps) {
  const {
    account,
    chainId,
    connect,
    connecting,
    connectingWalletId,
    detectedWallets,
    detectWallets,
    disconnect,
    isConnected,
  } = useWallet();
  const {
    solanaAccount,
    solanaWalletName,
    isSolanaConnected,
    availableSolanaWallets,
    connectingSolana,
    connectSolana,
    disconnectSolana,
  } = useSolanaWallet();
  const [selectedChain, setSelectedChain] = useState<WalletChainChoice | null>(null);
  const [selectedWalletId, setSelectedWalletId] = useState<WalletType | null>(null);
  const [selectedSolanaWalletId, setSelectedSolanaWalletId] = useState<string | null>(null);
  const [moreWalletsOpen, setMoreWalletsOpen] = useState(false);

  const robinhoodChainId = resolveRobinhoodFeedChainId();
  const bnbChainId = resolveBnbFeedChainId();
  const isBusy = connecting || Boolean(selectedWalletId) || Boolean(selectedSolanaWalletId) || connectingSolana;
  const rowsLocked = Boolean(selectedWalletId) || Boolean(selectedSolanaWalletId);
  const connectingSolanaName =
    availableSolanaWallets.find((wallet) => wallet.id === selectedSolanaWalletId)?.name || "Phantom";

  const chainChoices = useMemo(() => {
    const choices: Array<{ id: WalletChainChoice; label: string; detail: string }> = [];
    if (!filter || filter === "evm") {
      choices.push({ id: "bnb", label: "BNB", detail: "BNB Smart Chain" });
    }
    if (!filter || filter === "solana") {
      choices.push({ id: "solana", label: "Solana", detail: "Solana mainnet" });
    }
    if ((!filter || filter === "evm") && robinhoodChainId) {
      choices.push({ id: "robinhood", label: "Robinhood", detail: robinhoodChainId === ROBINHOOD_TESTNET_CHAIN_ID ? "Robinhood testnet" : "Robinhood Chain" });
    }
    return choices;
  }, [filter, robinhoodChainId]);

  const walletOptions = useMemo<UnifiedWalletOption[]>(() => {
    if (!selectedChain) return [];
    const evmOptions: UnifiedWalletOption[] = selectedChain !== "solana"
      ? detectedWallets.map((wallet) => ({
        kind: "evm" as const,
        key: `evm:${wallet.id}:${wallet.rdns || wallet.name}`,
        id: wallet.id,
        name: wallet.name,
        description: wallet.description || "Injected EVM browser wallet.",
        icon: wallet.icon,
        detected: wallet.source === "eip6963",
        sortScore: wallet.sortScore,
        wallet,
      }))
      : [];

    const solanaOptions: UnifiedWalletOption[] = selectedChain === "solana"
      ? availableSolanaWallets.map((wallet, index) => ({
        kind: "solana" as const,
        key: `solana:${wallet.id}:${wallet.name}`,
        id: wallet.id,
        name: wallet.name,
        description: "Solana mainnet wallet.",
        icon: wallet.icon,
        detected: true,
        sortScore: 90 - index,
      }))
      : [];

    const seen = new Set<string>();
    return [...evmOptions, ...solanaOptions]
      .filter((option) => {
        const key = `${option.kind}:${option.id}:${option.name}`.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => walletPriority(b) - walletPriority(a) || b.sortScore - a.sortScore || a.name.localeCompare(b.name));
  }, [availableSolanaWallets, detectedWallets, selectedChain]);

  const visibleWallets = moreWalletsOpen ? walletOptions : walletOptions.slice(0, INITIAL_VISIBLE_WALLETS);
  const hiddenWalletCount = Math.max(0, walletOptions.length - visibleWallets.length);

  const handleClose = useCallback(() => {
    if (isBusy) return;
    setSelectedWalletId(null);
    setSelectedSolanaWalletId(null);
    setSelectedChain(null);
    onOpenChange(false);
  }, [isBusy, onOpenChange]);

  const handleRefresh = useCallback(() => {
    detectWallets();
    toast.message("Wallet detection refreshed");
  }, [detectWallets]);

  const handleConnect = useCallback(
    async (detectedWallet: DetectedWallet) => {
      if (!selectedChain || selectedChain === "solana") return;
      const targetChainId = selectedChain === "robinhood" ? robinhoodChainId : bnbChainId;
      if (!targetChainId) {
        toast.error("The selected chain is not enabled in this MemeWarzone environment.");
        return;
      }
      setSelectedWalletId(detectedWallet.id);

      try {
        await switchDetectedWalletChain(detectedWallet, targetChainId);
        await connect(detectedWallet.id);
        setSelectedFeedChainId(targetChainId);
        toast.success(`Connected ${detectedWallet.name} on ${selectedChain === "robinhood" ? "Robinhood" : "BNB"}`);
        onOpenChange(false);
      } catch (error) {
        toast.error(getWalletError(error));
      } finally {
        setSelectedWalletId(null);
      }
    },
    [bnbChainId, connect, onOpenChange, robinhoodChainId, selectedChain],
  );

  const handleUnifiedConnect = useCallback(
    async (option: UnifiedWalletOption) => {
      if (option.kind === "evm") {
        await handleConnect(option.wallet);
        return;
      }
      setSelectedSolanaWalletId(option.id);

      try {
        await connectSolana(option.id);
        setSelectedFeedChainId(SOLANA_CHAIN_ID);
        toast.success(`Connected ${option.name} on Solana`);
        onOpenChange(false);
      } catch (error: any) {
        toast.error(error?.message || "Failed to connect Solana wallet");
      } finally {
        setSelectedSolanaWalletId(null);
      }
    },
    [connectSolana, handleConnect, onOpenChange],
  );

  const handleDisconnect = useCallback(async () => {
    try {
      await disconnect();
      toast.success("Wallet disconnected");
      onOpenChange(false);
    } catch (error) {
      toast.error(getWalletError(error));
    }
  }, [disconnect, onOpenChange]);

  const handleSolanaDisconnect = useCallback(async () => {
    try {
      await disconnectSolana();
      toast.success("Solana wallet disconnected");
      onOpenChange(false);
    } catch (error) {
      toast.error(getWalletError(error));
    }
  }, [disconnectSolana, onOpenChange]);

  const connectedSummary = useMemo(() => {
    if (isSolanaConnected && solanaAccount) return { label: "Solana wallet connected", detail: `${solanaWalletName ? `${solanaWalletName} · ` : ""}${shortAddress(solanaAccount)}`, accent: "solana" as const };
    if (isConnected && account) {
      const label = chainId === ROBINHOOD_CHAIN_ID || chainId === ROBINHOOD_TESTNET_CHAIN_ID
        ? "Robinhood wallet connected"
        : "BNB wallet connected";
      return { label, detail: `${chainId ? `Chain ${chainId} · ` : ""}${shortAddress(account)}`, accent: "accent" as const };
    }
    return null;
  }, [account, chainId, isConnected, isSolanaConnected, solanaAccount, solanaWalletName]);

  useEffect(() => {
    if (!open) return;

    setMoreWalletsOpen(false);
    setSelectedChain(filter === "solana" ? "solana" : null);
    detectWallets();

    const timers = WAKE_PROVIDER_DISCOVERY_DELAYS_MS.map((delay) =>
      window.setTimeout(() => detectWallets(), delay),
    );
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") handleClose();
    };

    window.addEventListener("keydown", onKeyDown);

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      document.body.style.overflow = originalOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [detectWallets, filter, handleClose, open]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[999] flex items-center justify-center overflow-y-auto bg-background/80 p-4 backdrop-blur-xl"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <button
            type="button"
            aria-label="Close wallet modal"
            className="absolute inset-0 cursor-default"
            onClick={handleClose}
          />

          <motion.section
            role="dialog"
            aria-modal="true"
            aria-labelledby="connect-wallet-title"
            className="relative my-8 w-full max-w-[420px] overflow-hidden rounded-[1.65rem] border border-accent/25 bg-card/95 shadow-[0_30px_120px_-40px_rgba(0,0,0,0.95),0_0_0_1px_rgba(240,106,26,0.08)]"
            initial={{ opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.98 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
          >
            <div className="pointer-events-none absolute -left-20 -top-24 h-48 w-48 rounded-full bg-accent/15 blur-3xl" />
            <div className="pointer-events-none absolute -bottom-20 -right-20 h-52 w-52 rounded-full bg-primary/25 blur-3xl" />
            <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/80 to-transparent" />

            <div className="relative border-b border-border/55 px-5 py-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="mb-3 inline-flex items-center gap-2 border border-accent/25 bg-accent/10 px-3 py-1 text-[10px] uppercase tracking-[0.22em] text-accent">
                    <Sparkles className="h-3 w-3" />
                    Connect Wallet
                  </div>
                  <h2 id="connect-wallet-title" className="font-retro text-xl text-foreground">
                    Welcome back Soldier
                  </h2>
                </div>

                <button
                  type="button"
                  onClick={handleClose}
                  className="border border-border/70 bg-background/50 p-2 text-muted-foreground transition hover:border-accent/40 hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="relative max-h-[68vh] overflow-y-auto p-5">
              {connectedSummary && (
                <div className={`${connectedSummary.accent === "solana" ? "border-purple-400/25 bg-purple-500/10" : "border-accent/25 bg-accent/10"} mb-4 flex items-center justify-between gap-3 rounded-2xl border p-3`}>
                  <div className="flex min-w-0 items-center gap-3">
                    <div className={`${connectedSummary.accent === "solana" ? "bg-purple-500/15 text-purple-300" : "bg-accent/15 text-accent"} flex h-9 w-9 shrink-0 items-center justify-center rounded-xl`}>
                      <CheckCircle2 className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-retro text-sm text-foreground">{connectedSummary.label}</p>
                      <p className="truncate text-xs text-muted-foreground">{connectedSummary.detail}</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={connectedSummary.accent === "solana" ? handleSolanaDisconnect : handleDisconnect}
                    disabled={isBusy}
                    className="shrink-0 rounded-xl border border-border/70 bg-background/60 px-3 py-2 text-xs text-muted-foreground transition hover:border-destructive/40 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Disconnect
                  </button>
                </div>
              )}

              <div className="mb-4">
                <p className="font-retro text-sm text-foreground">1. Choose chain</p>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {chainChoices.map((choice) => (
                    <button
                      key={choice.id}
                      type="button"
                      disabled={isBusy}
                      onClick={() => {
                        setSelectedChain(choice.id);
                        setMoreWalletsOpen(false);
                      }}
                      className={`${selectedChain === choice.id ? "border-accent/60 bg-accent/10 text-accent" : "border-border/70 bg-background/45 text-muted-foreground hover:border-accent/35 hover:text-foreground"} min-w-0 border px-2 py-3 text-center transition disabled:cursor-not-allowed disabled:opacity-60`}
                    >
                      <span className="block font-retro text-xs">{choice.label}</span>
                      <span className="mt-1 block truncate text-[9px] opacity-70">{choice.detail}</span>
                    </button>
                  ))}
                </div>
              </div>

              {connectingSolana && (
                <div className="mb-4 rounded-2xl border border-purple-400/25 bg-purple-500/10 px-3 py-2 text-xs leading-relaxed text-purple-200">
                  Approve the request in {connectingSolanaName}. If nothing pops up, click the extension icon, unlock the wallet, then try again.
                </div>
              )}

              <div className="flex items-center justify-between gap-3">
                <p className="font-retro text-sm text-foreground">2. Select wallet</p>
                <button
                  type="button"
                  onClick={handleRefresh}
                  disabled={isBusy || !selectedChain}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-border/70 bg-background/50 px-2.5 py-1.5 text-xs text-muted-foreground transition hover:border-accent/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <RefreshCcw className="h-3.5 w-3.5" />
                  Refresh
                </button>
              </div>

              <div className="mt-3 space-y-2">
                {!selectedChain ? (
                  <div className="rounded-2xl border border-dashed border-border/80 bg-background/35 p-5 text-center text-sm text-muted-foreground">
                    Choose BNB, Solana, or Robinhood first. MemeWarzone will connect the detected wallet to that exact network.
                  </div>
                ) : visibleWallets.length > 0 ? (
                  visibleWallets.map((option) => (
                    <WalletRow
                      key={option.key}
                      option={option}
                      disabled={rowsLocked}
                      connecting={
                        option.kind === "evm"
                          ? selectedWalletId === option.id || connectingWalletId === option.id
                          : connectingSolana && selectedSolanaWalletId === option.id
                      }
                      onConnect={handleUnifiedConnect}
                    />
                  ))
                ) : (
                  <div className="rounded-2xl border border-dashed border-border/80 bg-background/35 p-5 text-center">
                    <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-accent/25 bg-accent/10 text-accent">
                      <AlertTriangle className="h-5 w-5" />
                    </div>
                    <p className="mt-3 font-retro text-sm text-foreground">No wallet detected</p>
                    <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
                      Unlock your wallet extension, then refresh. On mobile, open MemeWarzone inside your wallet browser.
                    </p>
                  </div>
                )}

                {selectedChain && walletOptions.length > INITIAL_VISIBLE_WALLETS && (
                  <button
                    type="button"
                    onClick={() => setMoreWalletsOpen((value) => !value)}
                    disabled={isBusy}
                    className="group flex w-full items-center justify-between rounded-2xl border border-border/70 bg-background/45 px-3 py-3 text-left transition hover:border-accent/40 hover:bg-card disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-border/70 bg-card/60 text-muted-foreground">
                        <Wallet className="h-4 w-4" />
                      </div>
                      <div>
                        <p className="font-retro text-sm text-foreground">More wallets</p>
                        <p className="text-xs text-muted-foreground">
                          {moreWalletsOpen ? "Hide extra detected wallets" : `Show ${hiddenWalletCount} more detected wallet${hiddenWalletCount === 1 ? "" : "s"}`}
                        </p>
                      </div>
                    </div>
                    <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${moreWalletsOpen ? "rotate-180" : ""}`} />
                  </button>
                )}
              </div>
            </div>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
