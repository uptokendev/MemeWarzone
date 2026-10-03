import type { ReactNode } from "react";
import { Navigate, useLocation, useParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { useWallet } from "@/contexts/WalletContext";
import { CommandCenterLayout } from "@/components/command-center/CommandCenterLayout";
import { useActiveFeedWallet } from "@/hooks/useActiveFeedWallet";
import { effectiveWalletAddress, normalizeRouteWallet, routeWalletsMatch } from "@/lib/address";

function openWalletModal(wallet: any) {
  try {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal"));
      return;
    }
  } catch {}

  if (typeof wallet?.connect === "function") return wallet.connect();
  if (typeof wallet?.openConnectModal === "function") return wallet.openConnectModal();
}

function getCommandSection(pathname: string): string {
  const marker = "/command";
  const index = pathname.indexOf(marker);
  if (index < 0) return "";

  const suffix = pathname.slice(index + marker.length).split("/").filter(Boolean)[0] || "";
  const allowed = new Set([
    "overview",
    "recruiter",
    "squad",
    "airdrops",
    "claims",
    "settings",
    "followers",
    "following",
    "coins",
    "feed",
    "battles",
    "support",
  ]);
  return allowed.has(suffix) ? `/${suffix}` : "";
}

function ConnectRequired({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="mx-auto flex min-h-[65vh] w-full max-w-3xl items-center justify-center px-4">
      <div className="w-full rounded-[14px] border border-mw-border bg-mw-surface p-6 text-center font-mw-body md:p-10">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-[14px] border border-[#7A3A0C] bg-[#2A1609] font-mw-cond text-2xl font-bold text-mw-accent-soft">
          CC
        </div>
        <h1 className="m-0 font-mw-cond text-[32px] font-bold leading-none text-mw-text lg:text-[40px]">Connect wallet</h1>
        <p className="mx-auto mt-4 max-w-xl text-[15px] text-mw-muted">
          The creator dashboard is private. Connect the owner wallet to open your tools.
        </p>
        <Button onClick={onConnect} className="mw-focus mt-6 inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50">
          Connect wallet
        </Button>
      </div>
    </div>
  );
}

type CommandCenterShellProps = {
  children: ReactNode;
};

export function CommandCenterShell({ children }: CommandCenterShellProps) {
  const { wallet: walletParam } = useParams<{ wallet?: string }>();
  const location = useLocation();
  const wallet = useWallet();
  const feedWallet = useActiveFeedWallet();
  const anyWallet: any = wallet as any;

  const connectedWallet = normalizeRouteWallet(feedWallet.address);
  const requestedWallet = normalizeRouteWallet(walletParam);
  const walletAddress = requestedWallet ? effectiveWalletAddress(requestedWallet, connectedWallet) : null;

  if (!walletAddress) return <Navigate to={`/profile${location.search}`} replace />;

  if (!connectedWallet) {
    return <ConnectRequired onConnect={() => openWalletModal(anyWallet)} />;
  }

  const section = getCommandSection(location.pathname);
  if (!routeWalletsMatch(requestedWallet, connectedWallet) || walletAddress !== requestedWallet) {
    return <Navigate to={`/profile/${connectedWallet}/command${section}${location.search}`} replace />;
  }

  return (
    <CommandCenterLayout walletAddress={walletAddress} basePath={`/profile/${walletAddress}/command`}>
      {children}
    </CommandCenterLayout>
  );
}