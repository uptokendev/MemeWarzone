import { useEffect, useMemo, useState } from "react";
import { Navigate, useParams, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/contexts/WalletContext";
import { useActiveFeedWallet } from "@/hooks/useActiveFeedWallet";
import PublicProfile from "./PublicProfile";
import { HANDLE_RE, resolveHandle } from "@/lib/handlesApi";
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

function ConnectCommandCenterPrompt({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="mx-auto flex min-h-[65vh] w-full max-w-3xl items-center justify-center px-4">
      <div className="w-full rounded-[14px] border border-mw-border bg-mw-surface p-6 text-center font-mw-body md:p-10">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-[14px] border border-[#7A3A0C] bg-[#2A1609] font-mw-cond text-2xl font-bold text-mw-accent-soft">
          CC
        </div>
        <h1 className="m-0 font-mw-cond text-[32px] font-bold leading-none text-mw-text lg:text-[40px]">Open your Command Center</h1>
        <p className="mx-auto mt-4 max-w-xl text-[15px] text-mw-muted">
          Connect wallet to open your Command Center. Public profiles stay visible to visitors, but owner tools require the connected wallet.
        </p>
        <Button onClick={onConnect} className="mw-focus mt-6 inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50">
          Connect wallet
        </Button>
      </div>
    </div>
  );
}

function InvalidPublicProfile({ identifier }: { identifier: string }) {
  return (
    <div className="mx-auto flex min-h-[65vh] w-full max-w-3xl items-center justify-center px-4">
      <div className="w-full rounded-[14px] border border-mw-border bg-mw-surface p-6 text-center font-mw-body md:p-10">
        <h1 className="m-0 font-mw-cond text-[32px] font-bold leading-none text-mw-text lg:text-[40px]">Profile not found</h1>
        <p className="mx-auto mt-4 max-w-xl text-[15px] text-mw-muted">
          No profile matches <span className="break-all font-mw-mono text-mw-text">{identifier}</span>. Open a profile by wallet address or @username.
        </p>
      </div>
    </div>
  );
}

export default function ProfilePage() {
  const { identifier } = useParams<{ identifier?: string }>();
  const [searchParams] = useSearchParams();
  const evmWallet = useWallet();
  const feedWallet = useActiveFeedWallet();
  const anyWallet: any = evmWallet as any;

  const account = feedWallet.address;
  const accountWallet = normalizeRouteWallet(account);

  const legacyAddress = searchParams.get("address");
  const explicitIdentifier = identifier ?? legacyAddress;
  const explicitWallet = normalizeRouteWallet(explicitIdentifier);

  const shouldRenderPublicProfile = Boolean(explicitIdentifier);
  const profileWallet = useMemo(() => {
    if (shouldRenderPublicProfile) {
      return explicitWallet ? effectiveWalletAddress(explicitWallet, accountWallet) : null;
    }
    return accountWallet;
  }, [accountWallet, explicitWallet, shouldRenderPublicProfile]);

  // /profile/<username> (founder, 2026-10-02): look the username up and go to that wallet's profile.
  const handleCandidate = explicitIdentifier && !explicitWallet && HANDLE_RE.test(String(explicitIdentifier).replace(/^@/, ""))
    ? String(explicitIdentifier).replace(/^@/, "")
    : "";
  const [handleLookup, setHandleLookup] = useState<{ handle: string; wallet: string | null } | null>(null);
  useEffect(() => {
    if (!handleCandidate) return;
    let cancelled = false;
    resolveHandle(handleCandidate)
      .then((wallet) => {
        if (!cancelled) setHandleLookup({ handle: handleCandidate, wallet });
      })
      .catch(() => {
        if (!cancelled) setHandleLookup({ handle: handleCandidate, wallet: null });
      });
    return () => {
      cancelled = true;
    };
  }, [handleCandidate]);

  if (handleCandidate) {
    if (handleLookup?.handle === handleCandidate && handleLookup.wallet) {
      return <Navigate to={`/profile/${handleLookup.wallet}`} replace />;
    }
    if (handleLookup?.handle !== handleCandidate) {
      return <div className="mx-auto w-full max-w-[1480px] px-3 py-16 text-center font-mw-body text-mw-muted">Looking up @{handleCandidate}…</div>;
    }
  }

  if (!shouldRenderPublicProfile) {
    if (!accountWallet) {
      return <ConnectCommandCenterPrompt onConnect={() => openWalletModal(anyWallet)} />;
    }

    if (searchParams.get("import") === "1") {
      return <Navigate to={`/profile/${accountWallet}/command/coins?import=1`} replace />;
    }

    return <Navigate to={`/profile/${accountWallet}/command`} replace />;
  }

  if (!profileWallet) {
    return <InvalidPublicProfile identifier={String(explicitIdentifier ?? "")} />;
  }

  if (accountWallet && explicitWallet && routeWalletsMatch(explicitWallet, accountWallet) && profileWallet !== explicitWallet) {
    return <Navigate to={`/profile/${profileWallet}`} replace />;
  }

  return (
    <PublicProfile
      profileWallet={profileWallet}
      isOwnProfile={routeWalletsMatch(accountWallet, profileWallet)}
    />
  );
}
