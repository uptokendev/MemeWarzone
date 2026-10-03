import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { ChevronDown, Loader2 } from "lucide-react";
import {
  ensureSolanaListeners,
  getStoredSolanaWallet,
  SOLANA_WALLET_EVENT,
} from "@/lib/solanaWallet";
import { ConnectWalletModal } from "@/components/wallet/ConnectWalletModal";

export const ConnectWalletButton = () => {
  const {
    disconnect,
    isConnected,
    account,
    connecting,
    detectWallets,
  } = useWallet();
  const {
    solanaAccount,
    connectingSolana,
    disconnectSolana,
  } = useSolanaWallet();
  const [isOpen, setIsOpen] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);

  useEffect(() => {
    detectWallets();
    ensureSolanaListeners();

    const sync = () => {
      detectWallets();
      ensureSolanaListeners();
    };

    const timers = [0, 80, 250, 800, 1600].map((delay) => window.setTimeout(sync, delay));
    window.addEventListener(SOLANA_WALLET_EVENT, sync as EventListener);
    window.addEventListener("focus", sync as EventListener);

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener(SOLANA_WALLET_EVENT, sync as EventListener);
      window.removeEventListener("focus", sync as EventListener);
    };
  }, [detectWallets]);

  const liveSolana = getStoredSolanaWallet();
  const effectiveSolana = liveSolana || solanaAccount;
  const displayedAccount = effectiveSolana || account;
  const shortAddress =
    displayedAccount && displayedAccount.length > 10
      ? `${displayedAccount.slice(0, 6)}...${displayedAccount.slice(-4)}`
      : displayedAccount || "";

  const handleDisconnect = async () => {
    try {
      if (solanaAccount || getStoredSolanaWallet()) {
        await disconnectSolana();
      }
      if (isConnected) {
        await disconnect();
      }
    } finally {
      setShowDropdown(false);
    }
  };

  if (displayedAccount) {
    return (
      <div
        className="relative"
        onMouseEnter={() => setShowDropdown(true)}
        onMouseLeave={() => setShowDropdown(false)}
      >
        <Button
          variant="outline"
          className="mw-focus flex h-11 items-center gap-2 rounded-[10px] border border-mw-edge bg-mw-raised px-3 font-mw-mono text-[13px] text-mw-text hover:bg-[#222830] hover:text-mw-text"
          onClick={() => setShowDropdown((open) => !open)}
        >
          <span className="h-2 w-2 rounded-full bg-mw-up" />
          {shortAddress}
        </Button>

        {showDropdown && (
          <div className="absolute right-0 z-50 mt-1 w-36 rounded-[10px] border border-mw-edge bg-mw-surface p-1 font-mw-body shadow-lg">
            <button
              className="mw-focus min-h-10 w-full rounded-lg px-3 text-left text-sm text-mw-text hover:bg-mw-raised"
              onClick={() => void handleDisconnect()}
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <Button
        onClick={() => setIsOpen(true)}
        disabled={connecting || connectingSolana}
        className="mw-focus flex h-11 items-center gap-1.5 rounded-[10px] border border-mw-accent bg-mw-accent px-4 font-mw-body text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-60"
      >
        {connecting || connectingSolana ? (
          <>
            <Loader2 className="h-3 w-3 animate-spin" />
            Connecting...
          </>
        ) : (
          <>
            Connect Wallet
            <ChevronDown className="h-3 w-3" />
          </>
        )}
      </Button>

      <ConnectWalletModal open={isOpen} onOpenChange={setIsOpen} />
    </>
  );
};
