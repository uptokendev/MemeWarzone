import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CrypticPumpBadge, CrypticPumpListButton, fetchCrypticPumpListing, type CrypticPumpListingData } from "@/components/token/CrypticPumpListing";
import { ArenaImportImageUpload } from "@/components/arena/ArenaImportImageUpload";
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
  const [currentItem, setCurrentItem] = useState(item);
  const warnings = Array.isArray((currentItem.scan as { warnings?: string[] } | undefined)?.warnings)
    ? (currentItem.scan as { warnings: string[] }).warnings
    : [];
  const isOwner = Boolean(wallet.account && currentItem.ownerWallet && wallet.account.toLowerCase() === currentItem.ownerWallet.toLowerCase());

  useEffect(() => {
    setCurrentItem(item);
  }, [item]);

  useEffect(() => {
    let cancelled = false;
    void fetchCrypticPumpListing(currentItem.chainId, currentItem.tokenAddress).then((next) => {
      if (!cancelled) setListing(next);
    });
    return () => {
      cancelled = true;
    };
  }, [currentItem.chainId, currentItem.tokenAddress]);

  return (
    <ContentContainer className="space-y-5 px-1 pb-10 pt-4">
      <section className="mwz-hud-frame p-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-md border border-white/10 bg-white/5 font-retro text-lg text-white/55">
            {currentItem.imageUrl ? (
              <img
                src={currentItem.imageUrl}
                alt={`${currentItem.symbol || currentItem.name || "Imported token"} token`}
                className="h-full w-full object-cover"
              />
            ) : (
              `$${currentItem.symbol || "TOKEN"}`
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <TacticalTag label="Imported" tone="hot" />
              <TacticalTag label={currentItem.status.replaceAll("_", " ")} tone={currentItem.status === "passed" ? "success" : "default"} />
              {currentItem.verifiedAt ? <TacticalTag label="Owner verified" tone="success" /> : null}
            </div>
            <h1 className="mt-3 font-retro text-2xl text-foreground">{currentItem.symbol || currentItem.name || "Imported token"}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{currentItem.name || "Not launched on MemeWarzone"}</p>
            <p className="mt-2 break-all text-xs text-muted-foreground">{currentItem.tokenAddress}</p>
            {currentItem.description ? <p className="mt-3 max-w-3xl text-sm text-white/68">{currentItem.description}</p> : null}
            {warnings.length ? <p className="mt-3 text-xs text-muted-foreground">Scan notes: {warnings.join(", ")}</p> : null}
            {(currentItem.website || currentItem.xUrl || currentItem.telegramUrl) ? (
              <div className="mt-3 flex flex-wrap gap-3 text-xs">
                {currentItem.website ? <a href={currentItem.website} target="_blank" rel="noreferrer" className="text-accent hover:underline">Website</a> : null}
                {currentItem.xUrl ? <a href={currentItem.xUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">X</a> : null}
                {currentItem.telegramUrl ? <a href={currentItem.telegramUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">Telegram</a> : null}
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <ArenaImportImageUpload item={currentItem} onUploaded={setCurrentItem} />

      {postGradFlags.arena ? (
        <section className="mwz-hud-frame p-4 space-y-3">
          <div className="font-retro text-sm text-foreground">Arena UpVote</div>
          <p className="text-sm text-muted-foreground">
            Ranks the Arena featured rail. Fees follow the protocol treasury on this chain, same as graduated MemeWarzone coins. Launchpad UP Votes stay on Showcase.
          </p>
          {currentItem.status === "passed" ? (
            <ArenaUpvoteDialog tokenAddress={currentItem.tokenAddress} chainId={currentItem.chainId} buttonSize="sm" />
          ) : (
            <p className="text-sm text-muted-foreground">Arena UpVotes unlock after this import is passed.</p>
          )}
        </section>
      ) : null}

      <section className="mwz-hud-frame p-4 space-y-3">
        <div className="font-retro text-sm text-foreground">Trading</div>
        {currentItem.status === "passed" ? (
          <ImportedTradePanel item={currentItem} />
        ) : (
          <p className="text-sm text-muted-foreground">
            In-app swaps unlock after this import is passed, and only if a Topaz or Meteora pool is resolved.
          </p>
        )}
        {listing?.listingUrl ? (
          <CrypticPumpBadge listingUrl={listing.listingUrl} />
        ) : isOwner ? (
          <CrypticPumpListButton
            chainId={currentItem.chainId}
            campaignAddress={currentItem.tokenAddress}
            tokenAddress={currentItem.tokenAddress}
            name={currentItem.name || undefined}
            ticker={currentItem.symbol || undefined}
            creatorWallet={String(wallet.account || currentItem.ownerWallet)}
            listing={listing}
            onListed={setListing}
          />
        ) : null}
      </section>

      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline" className="font-retro">
          <Link to="/warzone">Warzone</Link>
        </Button>
      </div>
    </ContentContainer>
  );
}
