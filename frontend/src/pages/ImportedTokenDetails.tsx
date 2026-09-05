import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Loader2, SearchCheck } from "lucide-react";
import { toast } from "sonner";
import { CrypticPumpBadge, CrypticPumpListButton, fetchCrypticPumpListing, type CrypticPumpListingData } from "@/components/token/CrypticPumpListing";
import { ArenaImportImageUpload } from "@/components/arena/ArenaImportImageUpload";
import { ImportedTradePanel } from "@/components/arena/ImportedTradePanel";
import { ArenaUpvoteDialog } from "@/components/token/UpvoteDialog";
import { postGradFlags } from "@/features/postgrad/config";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ContentContainer } from "@/components/layout/ContentContainer";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useWallet } from "@/contexts/WalletContext";
import { isSolanaChainId } from "@/lib/chainConfig";
import {
  canRequestImportManualReview,
  importAuditPresentation,
  presentImportScanFindings,
} from "@/lib/arena/importAuditPresentation.mjs";
import { requestArenaImportReview, type ArenaImportItem } from "@/lib/arenaImports";
import { signSolanaMessage } from "@/lib/solanaWallet";
import { signWalletAction } from "@/lib/walletActionAuth";

function formatReviewTimestamp(value: string | null | undefined) {
  if (!value) return "";
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

export default function ImportedTokenDetails({ item }: { item: ArenaImportItem }) {
  const wallet = useWallet();
  const solanaWallet = useSolanaWallet();
  const [listing, setListing] = useState<CrypticPumpListingData | null>(null);
  const [currentItem, setCurrentItem] = useState(item);
  const [reviewReason, setReviewReason] = useState("");
  const [requestingReview, setRequestingReview] = useState(false);
  const solana = isSolanaChainId(currentItem.chainId);
  const connectedImportWallet = solana ? solanaWallet.solanaAccount : wallet.account;
  const canRequestReview = canRequestImportManualReview(currentItem, connectedImportWallet, solana);
  const reviewEligibleStatus = currentItem.status === "needs_review" || currentItem.status === "declined";
  const findings = presentImportScanFindings(currentItem.scan);
  const audit = importAuditPresentation(currentItem.status);
  const isOwner = Boolean(wallet.account && currentItem.ownerWallet && wallet.account.toLowerCase() === currentItem.ownerWallet.toLowerCase());

  useEffect(() => {
    setCurrentItem(item);
    setReviewReason("");
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

  const handleRequestReview = async () => {
    if (!canRequestReview || requestingReview) return;
    setRequestingReview(true);
    const toastId = toast.loading("Submitting manual review request...");
    try {
      const auth = solana
        ? await signWalletAction({
            action: "arena_import_request_review",
            walletAddress: currentItem.ownerWallet,
            chainId: currentItem.chainId,
            walletType: "solana",
            extraLines: [`Import: ${currentItem.id}`],
            signMessage: async (message) => (await signSolanaMessage(message, currentItem.ownerWallet)).signature,
          })
        : await signWalletAction({
            action: "arena_import_request_review",
            walletAddress: currentItem.ownerWallet,
            chainId: currentItem.chainId,
            extraLines: [`Import: ${currentItem.id}`],
            signer: wallet.signer,
          });
      const next = await requestArenaImportReview(currentItem.id, auth, reviewReason.trim() || undefined);
      setCurrentItem(next);
      setReviewReason("");
      toast.success("Manual review requested.");
    } catch (error: any) {
      toast.error(String(error?.message || "Could not request manual review."));
    } finally {
      toast.dismiss(toastId);
      setRequestingReview(false);
    }
  };

  const auditToneClass = audit.tone === "passed"
    ? "border-emerald-400/20 bg-emerald-500/[0.06]"
    : audit.tone === "failed"
      ? "border-red-400/20 bg-red-500/[0.06]"
      : audit.tone === "review"
        ? "border-amber-400/20 bg-amber-500/[0.06]"
        : "border-white/10 bg-black/20";

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

      <section className={`rounded-md border p-4 ${auditToneClass}`} data-import-audit-status={currentItem.status}>
        <div className="flex items-start gap-3">
          {audit.tone === "passed" ? (
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300" />
          ) : audit.tone === "failed" ? (
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-300" />
          ) : (
            <SearchCheck className="mt-0.5 h-5 w-5 shrink-0 text-amber-200" />
          )}
          <div className="min-w-0 flex-1">
            <h2 className="font-retro text-sm uppercase tracking-[0.12em] text-foreground">{audit.title}</h2>
            <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{audit.description}</p>

            {findings.length ? (
              <div className="mt-4">
                <div className="font-retro text-[11px] uppercase tracking-[0.12em] text-white/70">Automatic check notes</div>
                <ul className="mt-2 space-y-2 text-sm text-white/70">
                  {findings.map((finding) => (
                    <li key={finding.code} className="flex gap-2">
                      <span aria-hidden="true">•</span>
                      <span>{finding.message}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {reviewEligibleStatus && currentItem.reviewRequestedAt ? (
              <div className="mt-4 rounded-md border border-white/10 bg-black/20 p-3" data-import-review-requested="true">
                <div className="font-retro text-xs uppercase tracking-[0.12em] text-foreground">MANUAL REVIEW REQUESTED</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Requested {formatReviewTimestamp(currentItem.reviewRequestedAt)}. A manual review request does not approve this token.
                </p>
                {currentItem.reviewReason ? (
                  <div className="mt-3 rounded border border-white/10 bg-black/20 p-2">
                    <div className="text-[10px] uppercase tracking-[0.12em] text-white/45">Submitted note</div>
                    <p className="mt-1 whitespace-pre-wrap break-words text-xs text-white/70">{currentItem.reviewReason}</p>
                  </div>
                ) : null}
              </div>
            ) : canRequestReview ? (
              <div className="mt-4 max-w-xl rounded-md border border-white/10 bg-black/20 p-3" data-import-review-action="available">
                <div className="font-retro text-xs uppercase tracking-[0.12em] text-foreground">Manual investigation</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  You can ask the MemeWarzone team to investigate the automatic-check result. Requesting a manual check does not approve the token or change its current status.
                </p>
                <Textarea
                  value={reviewReason}
                  onChange={(event) => setReviewReason(event.target.value)}
                  maxLength={500}
                  rows={3}
                  className="mt-3 resize-none"
                  placeholder="Optional: add context or information for the reviewer."
                  aria-label="Optional manual review note"
                />
                <div className="mt-1 text-right text-[10px] text-white/35">{reviewReason.length}/500</div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-2 font-retro"
                  disabled={requestingReview}
                  onClick={() => void handleRequestReview()}
                >
                  {requestingReview ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <SearchCheck className="mr-2 h-4 w-4" />}
                  REQUEST MANUAL CHECK
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <ArenaImportImageUpload item={currentItem} onUploaded={setCurrentItem} />

      {postGradFlags.arena ? (
        <section className="mwz-hud-frame p-4 space-y-3">
          <div className="font-retro text-sm text-foreground">UpVotes</div>
          <p className="text-sm text-muted-foreground">
            Ranks the Warzone featured rail. Fees follow the protocol treasury on this chain, same as graduated MemeWarzone coins. Launchpad votes stay on Showcase.
          </p>
          {currentItem.status === "passed" ? (
            <ArenaUpvoteDialog tokenAddress={currentItem.tokenAddress} chainId={currentItem.chainId} buttonSize="sm" />
          ) : (
            <p className="text-sm text-muted-foreground">UpVotes unlock after this import is passed.</p>
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
