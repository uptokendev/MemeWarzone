import { AnimatePresence, motion } from "framer-motion";
import { detectWalletStandardSolanaWallets } from "@/lib/solanaWalletStandard";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
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
import { setSelectedFeedChainId } from "@/components/common/ChainFeedSwitch";
import { getEvmReadChainIdForTokenPage, isAllowedChainId, isEvmChainId, isEvmTokenPath, isRobinhoodChainId, SOLANA_CHAIN_ID, type SupportedChainId } from "@/lib/chainConfig";
import { evmConnectTargetChainId } from "@/lib/walletConnectTarget.mjs";
import { buildOpenInWalletLinks, isMobileBrowser, LAST_OPEN_IN_WALLET_STORAGE_KEY } from "@/lib/mobileWalletLinks.mjs";
import { WALLETCONNECT_RDNS } from "@/lib/walletConnect";
import { WAKE_PROVIDER_DISCOVERY_DELAYS_MS } from "@/lib/injectedProviderDiscovery";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";

import type { DetectedWallet, WalletType } from "@/contexts/WalletContext";

type ConnectWalletModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filter?: "evm" | "solana" | null;
};

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

/**
 * Phantom / Solflare are detected with emoji placeholders; the same wallets register their real logo
 * (an image data URI) through wallet-standard. Use that logo when names match (display only).
 */
function standardIconFor(name: string, fallback?: string) {
  const current = String(fallback || "");
  if (/^(data:image\/|https?:\/\/|\/)/.test(current)) return current;
  try {
    const key = String(name || "").toLowerCase().replace(/\s+/g, "");
    const match = detectWalletStandardSolanaWallets().find((w) => String(w.name || "").toLowerCase().replace(/\s+/g, "") === key);
    if (match && /^(data:image\/|https?:\/\/)/.test(String(match.icon || ""))) return match.icon;
  } catch {
    // wallet-standard not available
  }
  return current;
}

function WalletIcon({ option }: { option: UnifiedWalletOption }) {
  const [imageFailed, setImageFailed] = useState(false);

  if (option.kind === "evm" && option.icon && !imageFailed) {
    return (
      <img
        src={option.icon}
        alt=""
        className="h-10 w-10 rounded-xl border border-mw-border object-cover"
        onError={() => setImageFailed(true)}
      />
    );
  }

  if (option.kind === "solana") {
    const icon = String(option.icon || "");
    if (/^(data:image\/|https?:\/\/|\/)/.test(icon) && !imageFailed) {
      return (
        <img
          src={icon}
          alt=""
          className="h-10 w-10 rounded-xl border border-mw-border object-cover"
          onError={() => setImageFailed(true)}
        />
      );
    }
    return (
      <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-mw-border bg-mw-input font-mw-cond text-lg font-bold text-[#C4A1FF]">
        {getWalletInitial(option.name)}
      </div>
    );
  }

  return (
    <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-mw-border bg-mw-input font-mw-cond text-lg font-bold text-mw-accent-soft">
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
      className="mw-focus group relative w-full overflow-hidden rounded-[14px] border border-mw-border bg-mw-input px-3 py-3 text-left font-mw-body text-mw-text transition-colors hover:border-[#3A424C] hover:bg-[#171B20] disabled:cursor-not-allowed disabled:opacity-70"
    >
      <div className="relative flex items-center gap-3">
        <WalletIcon option={option} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="m-0 truncate text-[15px] font-semibold text-mw-text">{option.name}</p>
            {option.detected && (
              <span className="inline-flex h-5 items-center rounded-full border border-[#1F5133] bg-[#0F2418] px-2 text-[11px] font-semibold text-[#6EE7A0]">
                detected
              </span>
            )}
          </div>
          <p className="m-0 mt-0.5 line-clamp-1 text-[13px] text-mw-muted">{option.description}</p>
        </div>

        <div className="flex h-9 w-9 items-center justify-center rounded-[10px] border border-mw-edge bg-mw-raised text-mw-muted transition-colors group-hover:text-mw-accent-soft">
          {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />}
        </div>
      </div>
    </button>
  );
}

function readLastOpenInWallet() {
  try {
    return window.localStorage.getItem(LAST_OPEN_IN_WALLET_STORAGE_KEY);
  } catch {
    return null;
  }
}

function rememberOpenInWallet(id: string) {
  try {
    window.localStorage.setItem(LAST_OPEN_IN_WALLET_STORAGE_KEY, id);
  } catch {
    // storage blocked; the list just keeps its default order
  }
}

/** Phone browser with no wallet in the page: reopen this page inside a wallet app. */
function OpenInWalletList({ filter }: { filter?: "evm" | "solana" | null }) {
  const links = useMemo(
    () => buildOpenInWalletLinks({ currentUrl: window.location.href, filter: filter ?? null, lastUsedId: readLastOpenInWallet() }),
    [filter],
  );

  return (
    <div className="rounded-[14px] border border-mw-border bg-mw-input p-4">
      <p className="m-0 font-mw-cond text-lg font-bold text-mw-text">Open this page in your wallet app</p>
      <p className="m-0 mt-1 text-sm leading-relaxed text-mw-muted">
        Phone browsers can't connect to wallet apps. Tap your wallet and this page opens inside it, ready to connect.
      </p>
      <div className="mt-3 space-y-2">
        {links.map((link) => (
          <a
            key={link.id}
            href={link.href}
            rel="noopener noreferrer"
            onClick={() => rememberOpenInWallet(link.id)}
            className="mw-focus group flex w-full items-center gap-3 rounded-[14px] border border-mw-border bg-mw-surface px-3 py-3 text-left text-mw-text no-underline transition-colors hover:border-[#3A424C] hover:bg-[#171B20]"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-mw-border bg-mw-input font-mw-cond text-lg font-bold text-mw-accent-soft">
              {getWalletInitial(link.name)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="m-0 truncate text-[15px] font-semibold text-mw-text">Open in {link.name}</p>
              <p className="m-0 mt-0.5 line-clamp-1 text-[13px] text-mw-muted">{link.description}</p>
            </div>
            <ExternalLink className="h-4 w-4 text-mw-muted group-hover:text-mw-accent-soft" />
          </a>
        ))}
      </div>
      <p className="m-0 mt-3 text-xs leading-relaxed text-mw-muted">
        App not installed? Phantom, Solflare, MetaMask and Trust Wallet send you to their download page. Binance Wallet has no link like this: open {window.location.host} from the Discover tab in Binance Wallet.
      </p>
    </div>
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
    cancelSolanaConnect,
  } = useSolanaWallet();
  const [selectedWalletId, setSelectedWalletId] = useState<WalletType | null>(null);
  const [selectedSolanaWalletId, setSelectedSolanaWalletId] = useState<string | null>(null);
  const [moreWalletsOpen, setMoreWalletsOpen] = useState(false);

  const isBusy = connecting || Boolean(selectedWalletId) || Boolean(selectedSolanaWalletId) || connectingSolana;
  const rowsLocked = Boolean(selectedWalletId) || Boolean(selectedSolanaWalletId);
  const connectingSolanaName =
    availableSolanaWallets.find((wallet) => wallet.id === selectedSolanaWalletId)?.name || "Phantom";

  const walletOptions = useMemo<UnifiedWalletOption[]>(() => {
    const evmOptions: UnifiedWalletOption[] = (!filter || filter === "evm")
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

    const solanaOptions: UnifiedWalletOption[] = (!filter || filter === "solana")
      ? availableSolanaWallets.map((wallet, index) => ({
        kind: "solana" as const,
        key: `solana:${wallet.id}:${wallet.name}`,
        id: wallet.id,
        name: wallet.name,
        description: "Solana mainnet wallet.",
        icon: standardIconFor(wallet.name, wallet.icon),
        detected: true,
        sortScore: 90 - index,
      }))
      : [];

    const seen = new Set<string>();
    return [...evmOptions, ...solanaOptions]
      .filter((option) => {
        const nameKey = `${option.kind}:${String(option.name || "").toLowerCase().replace(/\s+/g, "")}`;
        const idKey = `${option.kind}:${option.id}:${option.name}`.toLowerCase();
        if (seen.has(nameKey) || seen.has(idKey)) return false;
        seen.add(nameKey);
        seen.add(idKey);
        return true;
      })
      .sort((a, b) => walletPriority(b) - walletPriority(a) || b.sortScore - a.sortScore || a.name.localeCompare(b.name));
  }, [availableSolanaWallets, detectedWallets, filter]);

  // A phone browser has no wallet in the page. The WalletConnect placeholder is
  // always announced when configured, so it does not count as one.
  const showOpenInWallet = useMemo(
    () =>
      typeof navigator !== "undefined" &&
      isMobileBrowser(navigator) &&
      !walletOptions.some((option) => !(option.kind === "evm" && option.wallet.rdns === WALLETCONNECT_RDNS)),
    [walletOptions],
  );

  const visibleWallets = moreWalletsOpen ? walletOptions : walletOptions.slice(0, INITIAL_VISIBLE_WALLETS);
  const hiddenWalletCount = Math.max(0, walletOptions.length - visibleWallets.length);

  const handleClose = useCallback(() => {
    cancelSolanaConnect();
    setSelectedWalletId(null);
    setSelectedSolanaWalletId(null);
    onOpenChange(false);
  }, [cancelSolanaConnect, onOpenChange]);

  const handleRefresh = useCallback(() => {
    detectWallets();
    toast.message("Wallet detection refreshed");
  }, [detectWallets]);

  const handleConnect = useCallback(
    async (detectedWallet: DetectedWallet) => {
      setSelectedWalletId(detectedWallet.id);

      try {
        // Only a token page pins the chain; otherwise the wallet's own network
        // wins and useLatchFeedChainToWallet follows it after the connect.
        const targetChainId = evmConnectTargetChainId({
          onEvmTokenPage: typeof window !== "undefined" && isEvmTokenPath(window.location.pathname),
          pageChainId: getEvmReadChainIdForTokenPage(),
          isAllowedEvmChain: (chainId: number) => isEvmChainId(chainId) && isAllowedChainId(chainId),
        });
        await connect(detectedWallet.id, targetChainId ? { chainId: targetChainId } : undefined);
        if (targetChainId) setSelectedFeedChainId(targetChainId as SupportedChainId);
        toast.success(`Connected ${detectedWallet.name}`);
        onOpenChange(false);
      } catch (error) {
        toast.error(getWalletError(error));
      } finally {
        setSelectedWalletId(null);
      }
    },
    [connect, onOpenChange],
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
        toast.success(`Connected ${option.name}`);
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
      const evmLabel = isRobinhoodChainId(chainId) ? "Robinhood wallet connected" : "BNB wallet connected";
      return { label: evmLabel, detail: `${chainId ? `Chain ${chainId} · ` : ""}${shortAddress(account)}`, accent: "accent" as const };
    }
    return null;
  }, [account, chainId, isConnected, isSolanaConnected, solanaAccount, solanaWalletName]);

  useEffect(() => {
    if (!open) return;

    setMoreWalletsOpen(false);
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
  }, [detectWallets, handleClose, open]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[999] flex items-center justify-center overflow-y-auto bg-[rgba(5,6,8,0.75)] p-4"
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
            className="relative my-8 w-full max-w-[440px] overflow-hidden rounded-[18px] border border-mw-edge bg-mw-surface font-mw-body text-mw-text shadow-[0_24px_64px_rgba(0,0,0,0.55)]"
            initial={{ opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.98 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
          >

            <div className="relative border-b border-mw-border px-5 py-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">
                    Connect wallet
                  </div>
                  <h2 id="connect-wallet-title" className="m-0 mt-0.5 font-mw-cond text-2xl font-bold text-mw-text">
                    Welcome back Soldier
                  </h2>
                </div>

                <button
                  type="button"
                  onClick={handleClose}
                  aria-label="Close"
                  className="mw-focus inline-flex h-11 w-11 items-center justify-center rounded-[10px] text-mw-muted hover:bg-mw-raised hover:text-mw-text"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            <div className="relative max-h-[68vh] overflow-y-auto p-5">
              {connectedSummary && (
                <div className={`border-[#1F5133] bg-[#0F2418] mb-4 flex items-center justify-between gap-3 rounded-[14px] border p-3`}>
                  <div className="flex min-w-0 items-center gap-3">
                    <div className={`bg-[#123020] text-[#6EE7A0] flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]`}>
                      <CheckCircle2 className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <p className="m-0 text-[15px] font-semibold text-mw-text">{connectedSummary.label}</p>
                      <p className="m-0 truncate font-mw-mono text-xs text-mw-muted">{connectedSummary.detail}</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={connectedSummary.accent === "solana" ? handleSolanaDisconnect : handleDisconnect}
                    disabled={isBusy}
                    className="mw-focus min-h-10 shrink-0 rounded-[10px] border border-mw-edge bg-mw-raised px-3 text-sm font-semibold text-mw-text hover:border-[#6B1F2A] hover:text-mw-sell disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Disconnect
                  </button>
                </div>
              )}

              {connectingSolana && (
                <div className="mb-4 rounded-[10px] border border-[#5A3416] bg-mw-accent-fill px-3 py-2.5 text-sm leading-relaxed text-mw-accent-soft">
                  Approve the request in {connectingSolanaName}. If nothing pops up, click the extension icon, unlock the wallet, then try again.
                </div>
              )}

              {showOpenInWallet && <OpenInWalletList filter={filter} />}

              {(!showOpenInWallet || visibleWallets.length > 0) && (
              <div className={`flex items-center justify-between gap-3 ${showOpenInWallet ? "mt-4" : ""}`}>
                <p className="m-0 font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">Detected wallets</p>
                <button
                  type="button"
                  onClick={handleRefresh}
                  disabled={isBusy}
                  className="mw-focus inline-flex h-9 items-center gap-1.5 rounded-full border border-mw-edge bg-[#171B20] px-3 text-[13px] font-semibold text-[#C9CED4] hover:bg-[#1F252C] hover:text-mw-text disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <RefreshCcw className="h-3.5 w-3.5" />
                  Refresh
                </button>
              </div>
              )}

              <div className="mt-3 space-y-2">
                {visibleWallets.length > 0 ? (
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
                ) : showOpenInWallet ? null : (
                  <div className="rounded-[14px] border border-dashed border-mw-edge bg-mw-input p-5 text-center">
                    <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-[#5A3416] bg-mw-accent-fill text-mw-accent-soft">
                      <AlertTriangle className="h-5 w-5" />
                    </div>
                    <p className="m-0 mt-3 font-mw-cond text-lg font-bold text-mw-text">No wallet detected</p>
                    <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-mw-muted">
                      Unlock your wallet extension, then refresh. On mobile, open MemeWarzone inside your wallet browser.
                    </p>
                  </div>
                )}

                {walletOptions.length > INITIAL_VISIBLE_WALLETS && (
                  <button
                    type="button"
                    onClick={() => setMoreWalletsOpen((value) => !value)}
                    disabled={isBusy}
                    className="mw-focus group flex w-full items-center justify-between rounded-[14px] border border-mw-border bg-mw-input px-3 py-3 text-left text-mw-text hover:border-[#3A424C] hover:bg-[#171B20] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-mw-border bg-mw-raised text-mw-muted">
                        <Wallet className="h-4 w-4" />
                      </div>
                      <div>
                        <p className="m-0 text-[15px] font-semibold text-mw-text">More wallets</p>
                        <p className="m-0 text-[13px] text-mw-muted">
                          {moreWalletsOpen ? "Hide extra detected wallets" : `Show ${hiddenWalletCount} more detected wallet${hiddenWalletCount === 1 ? "" : "s"}`}
                        </p>
                      </div>
                    </div>
                    <ChevronDown className={`h-4 w-4 text-mw-muted transition-transform ${moreWalletsOpen ? "rotate-180" : ""}`} />
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
