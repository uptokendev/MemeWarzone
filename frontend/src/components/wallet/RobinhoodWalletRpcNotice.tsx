import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { useWallet } from "@/contexts/WalletContext";
import { getChainParams, ROBINHOOD_CHAIN_ID } from "@/lib/chainConfig";
import {
  publicChainParams,
  readRpcUpdateState,
  requestRpcUpdate,
  rpcUpdateDue,
  writeRpcUpdateState,
} from "@/lib/robinhoodWalletRpcUpdate.mjs";

const SELECTED_WALLET_KEY = "mwz:selected_wallet";
const TOAST_ID = "rh-wallet-rpc-update";

function selectedWalletId(): string {
  try {
    return String(window.localStorage.getItem(SELECTED_WALLET_KEY) || "injected");
  } catch {
    return "injected";
  }
}

/**
 * Offers a wallet connected on Robinhood Chain to switch the network's RPC to the public Robinhood
 * endpoint (see lib/robinhoodWalletRpcUpdate.mjs). Shown once per session; the wallet prompt only
 * opens from the button, so it never lands in the middle of a connect or a trade.
 */
export function RobinhoodWalletRpcNotice() {
  const { provider, chainId, isConnected } = useWallet();
  const shownRef = useRef(false);

  useEffect(() => {
    if (shownRef.current || !isConnected || !provider || chainId !== ROBINHOOD_CHAIN_ID) return;
    const walletId = selectedWalletId();
    // WalletConnect sessions use the app's own RPC map, which is already the public endpoint.
    if (walletId.toLowerCase().includes("walletconnect")) return;
    const params = getChainParams(ROBINHOOD_CHAIN_ID);
    if (!publicChainParams(params) || !rpcUpdateDue(readRpcUpdateState(walletId))) return;
    shownRef.current = true;

    toast("Update Robinhood Chain in your wallet", {
      id: TOAST_ID,
      description:
        "If you added Robinhood Chain to your wallet through MemeWarzone before October 14, it uses an old RPC address that now fails often, so balances and transactions can error. Update it to the public Robinhood RPC. Your wallet asks you to confirm once.",
      duration: Infinity,
      action: {
        label: "Update",
        onClick: async () => {
          const result = await requestRpcUpdate(provider, walletId, { params });
          if (result === "updated") toast.success("Robinhood Chain now uses the public RPC in your wallet.");
          else if (result === "unsupported") toast.error("Your wallet did not accept the update. You can change the Robinhood Chain RPC in its network settings to https://rpc.mainnet.chain.robinhood.com");
        },
      },
      cancel: {
        label: "Not now",
        onClick: () => writeRpcUpdateState(walletId, "declined"),
      },
    });
  }, [chainId, isConnected, provider]);

  return null;
}
