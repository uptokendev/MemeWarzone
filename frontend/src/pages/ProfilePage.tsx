import { useMemo } from "react";
import { Navigate, useParams, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/contexts/WalletContext";
import { useActiveFeedWallet } from "@/hooks/useActiveFeedWallet";
import PublicProfile from "./PublicProfile";
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
      <div className="w-full rounded-3xl border border-border/50 bg-card/40 p-6 text-center shadow-2xl backdrop-blur-md md:p-10">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-accent/40 bg-accent/10 font-retro text-2xl text-accent">
          CC
        </div>
        <h1 className="font-retro text-2xl text-foreground md:text-4xl">Open your Command Center</h1>
        <p className="mx-auto mt-4 max-w-xl text-sm text-muted-foreground md:text-base">
          Connect wallet to open your Command Center. Public profiles stay visible to visitors, but owner tools require the connected wallet.
        </p>
        <Button onClick={onConnect} className="mt-6 font-retro">
          Connect wallet
        </Button>
      </div>
    </div>
  );
}

function InvalidPublicProfile({ identifier }: { identifier: string }) {
  return (
    <div className="mx-auto flex min-h-[65vh] w-full max-w-3xl items-center justify-center px-4">
      <div className="w-full rounded-3xl border border-border/50 bg-card/40 p-6 text-center shadow-2xl backdrop-blur-md md:p-10">
        <h1 className="font-retro text-2xl text-foreground md:text-4xl">Profile not found</h1>
        <p className="mx-auto mt-4 max-w-xl text-sm text-muted-foreground md:text-base">
          We could not resolve <span className="font-mono text-foreground">{identifier}</span> as a public profile yet. Wallet addresses are supported now; handles, usernames, and recruiter codes can be added next.
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
