import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CrypticPumpBadge, CrypticPumpListButton, fetchCrypticPumpListing, type CrypticPumpListingData } from "@/components/token/CrypticPumpListing";
import { ImportedTradePanel } from "@/components/arena/ImportedTradePanel";
import { ArenaUpvoteDialog } from "@/components/token/UpvoteDialog";
import { postGradFlags } from "@/features/postgrad/config";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { Button } from "@/components/ui/button";
import { ContentContainer } from "@/components/layout/ContentContainer";
import { useWallet } from "@/contexts/WalletContext";
import type { ArenaImportItem } from "@/lib/arenaImports";

export default function ImportedTokenDetails({ item }: { item: ArenaImportItem }) {
  const wallet = useWallet();
  const [listing, setListing] = useState<CrypticPumpListingData | null>(null);
  const warnings = Array.isArray((item.scan as { warnings?: string[] } | undefined)?.warnings)
    ? (item.scan as { warnings: string[] }).warnings
    : [];
  const isOwner = Boolean(wallet.account && item.ownerWallet && wallet.account.toLowerCase() === item.ownerWallet.toLowerCase());

  useEffect(() => {
    let cancelled = false;
    void fetchCrypticPumpListing(item.chainId, item.tokenAddress).then((next) => {
      if (!cancelled) setListing(next);
    });
    return () => {
      cancelled = true;
    };
  }, [item.chainId, item.tokenAddress]);

  return (
    <ContentContainer className="space-y-5 px-1 pb-10 pt-4">
      <section className="mwz-hud-frame p-4">
        <div className="flex flex-wrap items-center gap-2">
          <TacticalTag label="Imported" tone="hot" />
          <TacticalTag label={item.status.replaceAll("_", " ")} tone={item.status === "passed" ? "success" : "default"} />
        </div>
        <h1 className="mt-3 font-retro text-2xl text-foreground">{item.symbol || item.name || "Imported token"}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{item.name || "Not launched on MemeWarzone"}</p>
        <p className="mt-2 break-all text-xs text-muted-foreground">{item.tokenAddress}</p>
        {warnings.length ? <p className="mt-3 text-xs text-muted-foreground">Scan notes: {warnings.join(", ")}</p> : null}
      </section>

      {postGradFlags.arena ? (
        <section className="mwz-hud-frame p-4 space-y-3">
          <div className="font-retro text-sm text-foreground">Arena UpVote</div>
          <p className="text-sm text-muted-foreground">
            Ranks the Arena featured rail. Fees follow the protocol treasury on this chain, same as graduated MemeWarzone coins. Launchpad UP Votes stay on Showcase.
          </p>
          {item.status === "passed" ? (
            <ArenaUpvoteDialog tokenAddress={item.tokenAddress} chainId={item.chainId} buttonSize="sm" />
          ) : (
            <p className="text-sm text-muted-foreground">Arena UpVotes unlock after this import is passed.</p>
          )}
        </section>
      ) : null}

      <section className="mwz-hud-frame p-4 space-y-3">
        <div className="font-retro text-sm text-foreground">Trading</div>
        {item.status === "passed" ? (
          <ImportedTradePanel item={item} />
        ) : (
          <p className="text-sm text-muted-foreground">
            In-app swaps unlock after this import is passed, and only if a Topaz or Meteora pool is resolved.
          </p>
        )}
        {listing?.listingUrl ? (
          <CrypticPumpBadge listingUrl={listing.listingUrl} />
        ) : isOwner ? (
          <CrypticPumpListButton
            chainId={item.chainId}
            campaignAddress={item.tokenAddress}
            tokenAddress={item.tokenAddress}
            name={item.name || undefined}
            ticker={item.symbol || undefined}
            creatorWallet={String(wallet.account || item.ownerWallet)}
            listing={listing}
            onListed={setListing}
          />
        ) : null}
      </section>

      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline" className="font-retro">
          <Link to="/arena">Arena</Link>
        </Button>
      </div>
    </ContentContainer>
  );
}
