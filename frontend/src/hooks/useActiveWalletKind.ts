import { useEffect, useState } from "react";
import {
  ACTIVE_WALLET_KIND_EVENT,
  ACTIVE_WALLET_KIND_KEY,
  FEED_CHAIN_EVENT,
  FEED_CHAIN_KEY,
  getActiveWalletKind,
  type ActiveWalletKind,
} from "@/lib/activeWalletChain";

/** Reactive last-connected wallet kind. Phantom can stay injected after a BNB switch. */
export function useActiveWalletKind(): ActiveWalletKind | null {
  const [kind, setKind] = useState<ActiveWalletKind | null>(() => getActiveWalletKind());

  useEffect(() => {
    const sync = () => setKind(getActiveWalletKind());
    const onStorage = (event: StorageEvent) => {
      if (event.key === ACTIVE_WALLET_KIND_KEY || event.key === FEED_CHAIN_KEY) sync();
    };
    window.addEventListener(ACTIVE_WALLET_KIND_EVENT, sync);
    window.addEventListener(FEED_CHAIN_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(ACTIVE_WALLET_KIND_EVENT, sync);
      window.removeEventListener(FEED_CHAIN_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return kind;
}
