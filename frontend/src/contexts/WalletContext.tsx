import React, { createContext, useContext, useEffect } from "react";

import { useWallet as useWalletImpl } from "@/hooks/useWallet";
import { startIdleSession } from "@/lib/idleSession.mjs";
import { installWalletConnectEip6963Bridge } from "@/lib/walletConnect";

import type { DetectedWallet, WalletHook, WalletType } from "@/hooks/useWallet";

const WalletContext = createContext<WalletHook | null>(null);

// Install the WalletConnect v2 bridge once. It only announces a lightweight
// EIP-6963 placeholder here; the WalletConnect runtime stays lazy until the
// user actually requests accounts.
installWalletConnectEip6963Bridge();

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const wallet = useWalletImpl();
  useEffect(() => startIdleSession(), []);

  return <WalletContext.Provider value={wallet}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletHook {
  const ctx = useContext(WalletContext);

  if (!ctx) {
    throw new Error("useWallet must be used within a WalletProvider");
  }

  return ctx;
}

export type { DetectedWallet, WalletHook, WalletType };
