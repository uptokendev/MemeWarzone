import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  connectSolanaWallet as connectSolanaFn,
  disconnectSolanaWallet as disconnectSolanaFn,
  detectSolanaWallets,
  ensureSolanaListeners,
  getSolanaProvider,
  getStoredSolanaWallet,
  getStoredSolanaWalletId,
  getStoredSolanaWalletName,
  isSolanaWalletDisconnected,
  refreshSolanaWalletFromProvider,
  SOLANA_WALLET_EVENT,
  SOLANA_WALLET_STORAGE_KEY,
  type DetectedSolanaWallet,
} from "@/lib/solanaWallet";

type SolanaConnectResult = {
  publicKey: string;
  walletId: string;
  walletName: string;
};

type SolanaWalletContextType = {
  solanaAccount: string;
  solanaWalletName: string;
  isSolanaConnected: boolean;
  connectingSolana: boolean;
  availableSolanaWallets: DetectedSolanaWallet[];
  connectSolana: (walletId?: string) => Promise<SolanaConnectResult>;
  disconnectSolana: () => Promise<void>;
};

const SolanaWalletContext = createContext<SolanaWalletContextType | null>(null);

function eventPublicKey(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  try {
    return String((value as { toString?: () => string })?.toString?.() || "").trim();
  } catch {
    return "";
  }
}

export function SolanaWalletProvider({ children }: { children: React.ReactNode }) {
  const [solanaAccount, setSolanaAccount] = useState(() => getStoredSolanaWallet());
  const [solanaWalletName, setSolanaWalletName] = useState(() => getStoredSolanaWalletName());
  const [connectingSolana, setConnectingSolana] = useState(false);
  const [availableSolanaWallets, setAvailableSolanaWallets] = useState<DetectedSolanaWallet[]>([]);
  const connectGenerationRef = useRef(0);

  const refreshAvailableWallets = useCallback(() => {
    ensureSolanaListeners({ readExistingAccount: true });
    setAvailableSolanaWallets(detectSolanaWallets());
  }, []);

  const connectSolana = useCallback(async (walletId?: string) => {
    const generation = ++connectGenerationRef.current;
    setConnectingSolana(true);
    const { analytics, analyticsErrorCode } = await import("@/lib/analytics/ProductAnalytics");
    analytics.track("wallet_connect_started", { wallet_type: walletId || "solana", chain: "solana" });

    try {
      const result = await connectSolanaFn(walletId);
      setSolanaAccount(result.publicKey);
      setSolanaWalletName(result.walletName);
      refreshAvailableWallets();
      analytics.track("wallet_connect_succeeded", { wallet_type: result.walletName || walletId || "solana", chain: "solana" });
      return result;
    } catch (error) {
      analytics.track("wallet_connect_failed", {
        wallet_type: walletId || "solana",
        chain: "solana",
        error_code: analyticsErrorCode(error),
      });
      throw error;
    } finally {
      if (connectGenerationRef.current === generation) setConnectingSolana(false);
    }
  }, [refreshAvailableWallets]);

  const disconnectSolana = useCallback(async () => {
    await disconnectSolanaFn();
    setSolanaAccount("");
    setSolanaWalletName("");
    refreshAvailableWallets();
  }, [refreshAvailableWallets]);

  useEffect(() => {
    refreshAvailableWallets();
    const existing = refreshSolanaWalletFromProvider() || getStoredSolanaWallet();
    if (existing) {
      setSolanaAccount(existing);
      setSolanaWalletName(getStoredSolanaWalletName());
    }

    const restoreTrusted = window.setTimeout(() => {
      const provider = getSolanaProvider();
      if (
        !provider?.connect ||
        isSolanaWalletDisconnected() ||
        getStoredSolanaWallet() ||
        connectGenerationRef.current > 0
      ) {
        return;
      }
      void provider.connect({ onlyIfTrusted: true } as { onlyIfTrusted?: boolean }).then((result) => {
        if (isSolanaWalletDisconnected() || connectGenerationRef.current > 0) return;
        const key = String(result?.publicKey?.toString?.() || provider.publicKey?.toString?.() || "").trim();
        if (key) {
          refreshSolanaWalletFromProvider();
          setSolanaAccount(key);
        }
      }).catch(() => {});
    }, 120);

    const timers = [80, 250, 800, 1600].map((delay) =>
      window.setTimeout(() => {
        setAvailableSolanaWallets(detectSolanaWallets());
        const restored = refreshSolanaWalletFromProvider() || getStoredSolanaWallet();
        if (restored) {
          setSolanaAccount(restored);
          setSolanaWalletName(getStoredSolanaWalletName());
        }
      }, delay)
    );

    const onEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ publicKey?: string; walletName?: string }>).detail;
      if (!detail?.publicKey) {
        setSolanaAccount("");
        setSolanaWalletName("");
        return;
      }
      if (isSolanaWalletDisconnected()) return;
      setSolanaAccount(String(detail.publicKey));
      setSolanaWalletName(String(detail.walletName || ""));
      refreshAvailableWallets();
    };

    window.addEventListener(SOLANA_WALLET_EVENT, onEvent as EventListener);

    return () => {
      window.clearTimeout(restoreTrusted);
      timers.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener(SOLANA_WALLET_EVENT, onEvent as EventListener);
    };
  }, [refreshAvailableWallets]);

  useEffect(() => {
    const provider = getSolanaProvider();
    if (!provider?.on) return;

    let pendingTimer = 0;
    const publishAccount = (publicKey: string) => {
      if (isSolanaWalletDisconnected()) return;
      try {
        if (publicKey) window.localStorage.setItem(SOLANA_WALLET_STORAGE_KEY, publicKey);
        else window.localStorage.removeItem(SOLANA_WALLET_STORAGE_KEY);
      } catch {
        // React state still updates even when storage is unavailable.
      }

      window.dispatchEvent(new CustomEvent(SOLANA_WALLET_EVENT, {
        detail: {
          publicKey,
          walletId: getStoredSolanaWalletId(),
          walletName: getStoredSolanaWalletName(),
        },
      }));
    };

    const onAccountChanged = (value: unknown) => {
      window.clearTimeout(pendingTimer);
      const emittedKey = eventPublicKey(value);

      if (emittedKey) {
        // Some providers emit the new key before provider.publicKey mutates. Publish
        // the event payload after synchronous provider listeners so stale rereads
        // cannot win and force a page reload to see the selected account.
        pendingTimer = window.setTimeout(() => publishAccount(emittedKey), 0);
        return;
      }

      // Wallets may transiently emit null while switching accounts. Give the
      // provider a moment to expose the replacement key before treating it as a
      // real disconnect.
      pendingTimer = window.setTimeout(() => {
        const providerKey = eventPublicKey(provider.publicKey);
        publishAccount(providerKey);
      }, 50);
    };

    try {
      provider.on("accountChanged", onAccountChanged);
    } catch {
      return;
    }

    return () => {
      window.clearTimeout(pendingTimer);
      try { provider.removeListener?.("accountChanged", onAccountChanged); } catch {}
    };
  }, [solanaWalletName]);

  // Some Solana providers briefly emit an empty accountChanged event while the
  // wallet is still connected. Keep the app on the persisted session during that
  // provider race so Prepare Mode does not incorrectly report "Not connected" and
  // block signed actions such as Arm Notification. Explicit disconnect clears the
  // persisted wallet, so this does not restore a session the user disconnected.
  const activeSolanaAccount = solanaAccount || getStoredSolanaWallet();

  return (
    <SolanaWalletContext.Provider
      value={{
        solanaAccount: activeSolanaAccount,
        solanaWalletName,
        isSolanaConnected: Boolean(activeSolanaAccount),
        connectingSolana,
        availableSolanaWallets,
        connectSolana,
        disconnectSolana,
      }}
    >
      {children}
    </SolanaWalletContext.Provider>
  );
}

export function useSolanaWallet() {
  const ctx = useContext(SolanaWalletContext);
  if (!ctx) {
    throw new Error("useSolanaWallet must be used within a SolanaWalletProvider");
  }
  return ctx;
}
