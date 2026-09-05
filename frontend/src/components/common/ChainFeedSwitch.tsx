import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { isEvmAddress } from "@/lib/address";
import {
  BNB_CHAIN_ID,
  BNB_TESTNET_CHAIN_ID,
  isAllowedChainId,
  isEvmChainId,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_TESTNET_CHAIN_ID,
  SOLANA_CHAIN_ID,
  type SupportedChainId,
} from "@/lib/chainConfig";
import { isTestnetCampaignsEnabled } from "@/features/postgrad/apiClient";
import { getCampaignFeedChainId } from "@/lib/feedChainConfig";
import { FEED_CHAIN_EVENT, FEED_CHAIN_KEY, getActiveWalletKind, setActiveWalletKind } from "@/lib/activeWalletChain";

export function resolveBnbFeedChainId(): SupportedChainId {
  const configured = getCampaignFeedChainId();
  if (configured === BNB_TESTNET_CHAIN_ID && isTestnetCampaignsEnabled() && isAllowedChainId(BNB_TESTNET_CHAIN_ID)) {
    return BNB_TESTNET_CHAIN_ID;
  }
  if (configured === BNB_CHAIN_ID) return BNB_CHAIN_ID;
  return BNB_CHAIN_ID;
}

export function resolveRobinhoodFeedChainId(): SupportedChainId | null {
  if (isAllowedChainId(ROBINHOOD_CHAIN_ID)) return ROBINHOOD_CHAIN_ID;
  if (isAllowedChainId(ROBINHOOD_TESTNET_CHAIN_ID)) return ROBINHOOD_TESTNET_CHAIN_ID;
  return null;
}

function evmFeedForWallet(chainId?: number | null): SupportedChainId {
  if (chainId === BNB_TESTNET_CHAIN_ID && (!isTestnetCampaignsEnabled() || !isAllowedChainId(BNB_TESTNET_CHAIN_ID))) {
    return BNB_CHAIN_ID;
  }
  if (isEvmChainId(chainId) && isAllowedChainId(chainId)) return chainId as SupportedChainId;
  return resolveBnbFeedChainId();
}

/**
 * Last connected wallet owns the whole frontend.
 * A Solana wallet selects Solana; an EVM wallet selects its actual supported chain.
 */
export function useLatchFeedChainToWallet() {
  const wallet = useWallet();
  const { solanaAccount, isSolanaConnected } = useSolanaWallet();
  const prevSolana = useRef<string | null | undefined>(undefined);
  const prevEvm = useRef<string | null | undefined>(undefined);
  const prevEvmChainId = useRef<number | null | undefined>(undefined);

  useEffect(() => {
    const solanaNow = isSolanaConnected && solanaAccount ? String(solanaAccount) : null;
    const evmNow = wallet.isConnected && isEvmAddress(wallet.account) ? String(wallet.account) : null;
    const evmChainNow = evmNow && isEvmChainId(wallet.chainId) ? Number(wallet.chainId) : null;
    const firstRun = prevSolana.current === undefined && prevEvm.current === undefined;
    const solanaConnected = Boolean(solanaNow && solanaNow !== prevSolana.current);
    const evmConnected = Boolean(evmNow && evmNow !== prevEvm.current);
    const evmChainChanged = Boolean(
      evmNow &&
      evmChainNow &&
      prevEvmChainId.current !== undefined &&
      evmChainNow !== prevEvmChainId.current,
    );

    const activateSolana = () => {
      setActiveWalletKind("solana");
      setSelectedFeedChainId(SOLANA_CHAIN_ID);
    };
    const activateEvm = () => {
      setActiveWalletKind("bnb");
      setSelectedFeedChainId(evmFeedForWallet(wallet.chainId));
    };

    if (firstRun) {
      // Restored Solana wallet must beat leftover EVM auto-connect on refresh.
      if (solanaNow) activateSolana();
      else if (evmNow) activateEvm();
    } else if (solanaConnected) {
      activateSolana();
    } else if (evmChainChanged && !solanaNow) {
      // The same EVM account exists on BNB and Robinhood. Network changes must
      // still relatch the whole app even though the wallet address is unchanged.
      activateEvm();
    } else if (evmConnected && !solanaNow) {
      // EVM auto-reconnect must not steal the app from a live Solana session.
      // Explicit EVM connect goes through the wallet modal and selects its actual chain.
      activateEvm();
    } else if (!solanaNow && prevSolana.current && evmNow) {
      activateEvm();
    } else if (!evmNow && prevEvm.current && solanaNow) {
      activateSolana();
    }

    prevSolana.current = solanaNow;
    prevEvm.current = evmNow;
    prevEvmChainId.current = evmChainNow;
  }, [isSolanaConnected, solanaAccount, wallet.isConnected, wallet.account, wallet.chainId]);
}

export function FeedChainWalletLatch() {
  useLatchFeedChainToWallet();
  return null;
}

function normalizeFeedChainId(value: unknown): SupportedChainId {
  const chainId = Number(value);
  if (chainId === SOLANA_CHAIN_ID) return SOLANA_CHAIN_ID;
  if (chainId === ROBINHOOD_CHAIN_ID && isAllowedChainId(ROBINHOOD_CHAIN_ID)) return ROBINHOOD_CHAIN_ID;
  if (chainId === ROBINHOOD_TESTNET_CHAIN_ID && isAllowedChainId(ROBINHOOD_TESTNET_CHAIN_ID)) return ROBINHOOD_TESTNET_CHAIN_ID;
  if (chainId === BNB_TESTNET_CHAIN_ID && isTestnetCampaignsEnabled() && isAllowedChainId(BNB_TESTNET_CHAIN_ID)) {
    return BNB_TESTNET_CHAIN_ID;
  }
  return BNB_CHAIN_ID;
}

export function getSelectedFeedChainId(): SupportedChainId {
  if (typeof window === "undefined") return resolveBnbFeedChainId();
  try {
    if (getActiveWalletKind() === "solana") return SOLANA_CHAIN_ID;
    return normalizeFeedChainId(window.localStorage.getItem(FEED_CHAIN_KEY));
  } catch {
    return resolveBnbFeedChainId();
  }
}

export function setSelectedFeedChainId(chainId: SupportedChainId): SupportedChainId {
  const next = normalizeFeedChainId(chainId);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(FEED_CHAIN_KEY, String(next));
      window.localStorage.setItem("mwz:last_featured_chain_id", String(next));
      // "bnb" remains the legacy storage key for the EVM wallet family.
      setActiveWalletKind(next === SOLANA_CHAIN_ID ? "solana" : "bnb");
      window.dispatchEvent(new CustomEvent(FEED_CHAIN_EVENT, { detail: { chainId: next } }));
    } catch {
      // ignore storage failures
    }
  }
  return next;
}

export function useSelectedFeedChainId() {
  const [chainId, setChainIdState] = useState<SupportedChainId>(() => getSelectedFeedChainId());

  useEffect(() => {
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<{ chainId?: number }>).detail;
      setChainIdState(normalizeFeedChainId(detail?.chainId));
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === FEED_CHAIN_KEY) setChainIdState(getSelectedFeedChainId());
    };
    window.addEventListener(FEED_CHAIN_EVENT, onChange as EventListener);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(FEED_CHAIN_EVENT, onChange as EventListener);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const setChainId = (next: SupportedChainId) => setChainIdState(setSelectedFeedChainId(next));
  return [chainId, setChainId] as const;
}

export function ChainFeedSwitch({ className, value, onChange }: { className?: string; value?: SupportedChainId; onChange?: (chainId: SupportedChainId) => void }) {
  const [selected, setSelected] = useSelectedFeedChainId();
  const active = value ?? selected;
  const bnbChainId = useMemo(() => resolveBnbFeedChainId(), []);
  const robinhoodChainId = useMemo(() => resolveRobinhoodFeedChainId(), []);

  const select = (next: SupportedChainId) => {
    const resolved = setSelectedFeedChainId(next);
    setSelected(resolved);
    onChange?.(resolved);
  };

  const options = [
    { chainId: bnbChainId, label: "BNB", family: "bnb" },
    { chainId: SOLANA_CHAIN_ID, label: "Solana", family: "solana" },
    ...(robinhoodChainId ? [{ chainId: robinhoodChainId, label: "Robinhood", family: "robinhood" } as const] : []),
  ] as const;

  return (
    <div className={cn("inline-flex items-center gap-1 border border-[var(--mwz-flat-card-border)] bg-black/25 p-1", className)}>
      {options.map((option) => {
        const isActive =
          active === option.chainId ||
          (option.family === "bnb" && (active === BNB_CHAIN_ID || active === BNB_TESTNET_CHAIN_ID)) ||
          (option.family === "robinhood" && (active === ROBINHOOD_CHAIN_ID || active === ROBINHOOD_TESTNET_CHAIN_ID));
        return (
          <button
            key={option.label}
            type="button"
            onClick={() => select(option.chainId)}
            className={cn(
              "px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] transition-colors",
              isActive
                ? "border border-orange-400/60 bg-orange-500/10 text-orange-300"
                : "border border-transparent text-white/58 hover:border-[var(--mwz-flat-card-border-strong)] hover:bg-white/[0.035] hover:text-white",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
