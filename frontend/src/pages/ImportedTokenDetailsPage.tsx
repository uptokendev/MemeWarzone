import { Copy, LockKeyhole, Share2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { ContentContainer } from "@/components/layout/ContentContainer";
import { Button } from "@/components/ui/button";
import { SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import type { ProjectImportItem } from "@/lib/projectImports";

function safeExternalUrl(value: string | null | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export default function ImportedTokenDetailsPage({ item }: { item: ProjectImportItem }) {
  const isSolana = item.chainId === SOLANA_CHAIN_ID;
  const chainLabel = isSolana ? "Solana" : "BNB";
  const identityLabel = isSolana ? "Mint" : "Contract";
  const ownerVerified = item.ownershipStatus === "ownership_verified";
  const websiteHref = safeExternalUrl(item.website);
  const xHref = safeExternalUrl(item.xUrl);
  const telegramHref = safeExternalUrl(item.telegramUrl);

  const share = async () => {
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: `${item.name || item.symbol || "Imported project"} on MemeWarzone`, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      toast.success("Project link copied.");
    } catch (error: any) {
      if (String(error?.name || "") !== "AbortError") toast.error("Could not share the project link.");
    }
  };

  const copyIdentity = async () => {
    try {
      await navigator.clipboard.writeText(item.tokenAddress);
      toast.success(`${identityLabel} copied.`);
    } catch {
      toast.error(`Could not copy ${identityLabel.toLowerCase()}.`);
    }
  };

  return (
    <ContentContainer className="space-y-5 px-1 pb-12 pt-2" data-imported-token-details-page="true">
      <section className="mwz-hud-frame p-5">
        <div className="flex flex-col gap-5 md:flex-row md:items-start">
          <div className="h-28 w-28 shrink-0 overflow-hidden rounded-xl border border-white/10 bg-white/5">
            {item.imageUrl ? (
              <img
                src={item.imageUrl}
                alt={`${item.name || item.symbol || "Imported project"} logo`}
                className="h-full w-full object-cover"
                data-project-image="true"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-3xl font-black text-white/30">
                {(item.symbol || item.name || "?").slice(0, 2).toUpperCase()}
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-accent/50 bg-accent/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-accent" data-imported-badge="true">
                IMPORTED
              </span>
              {ownerVerified ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-emerald-200" data-owner-verified-badge="true">
                  <ShieldCheck className="h-3.5 w-3.5" /> OWNER VERIFIED
                </span>
              ) : null}
            </div>

            <h1 className="mt-3 break-words font-retro text-2xl text-foreground" data-project-name="true">
              {item.name || item.symbol || "Imported project"}
            </h1>
            {item.symbol ? <p className="mt-1 text-sm font-bold text-accent" data-project-ticker="true">${item.symbol}</p> : null}

            <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <span className="text-muted-foreground">Chain</span>
                <div className="mt-1 font-semibold text-foreground" data-project-chain="true">{chainLabel}</div>
              </div>
              <div className="min-w-0">
                <span className="text-muted-foreground">{identityLabel}</span>
                <button
                  type="button"
                  onClick={() => void copyIdentity()}
                  className="mt-1 flex max-w-full items-center gap-1 break-all text-left font-mono text-xs text-foreground hover:text-accent"
                  data-project-address="true"
                >
                  {item.tokenAddress}
                  <Copy className="h-3.5 w-3.5 shrink-0" />
                </button>
              </div>
            </div>
          </div>

          <Button type="button" variant="outline" size="sm" onClick={() => void share()} data-project-share="true">
            <Share2 className="mr-2 h-4 w-4" /> SHARE
          </Button>
        </div>
      </section>

      <section className="mwz-hud-frame p-5" data-project-profile="true">
        <h2 className="font-retro text-sm text-foreground">PROJECT</h2>
        <div className="mt-4 space-y-4 text-sm">
          <div>
            <div className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Description</div>
            <p className="mt-1 whitespace-pre-wrap text-foreground" data-project-description="true">
              {item.description || "No description added yet."}
            </p>
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-2" data-project-socials="true">
            {websiteHref ? <a href={websiteHref} target="_blank" rel="noreferrer" className="text-accent hover:underline">Website</a> : null}
            {xHref ? <a href={xHref} target="_blank" rel="noreferrer" className="text-accent hover:underline">X</a> : null}
            {telegramHref ? <a href={telegramHref} target="_blank" rel="noreferrer" className="text-accent hover:underline">Telegram</a> : null}
          </div>
        </div>
      </section>

      <section className="mwz-hud-frame border-amber-400/30 bg-amber-500/[0.04] p-5" data-warzone-locked-panel="true">
        <div className="flex items-start gap-3">
          <LockKeyhole className="mt-0.5 h-5 w-5 shrink-0 text-amber-200" />
          <div>
            <h2 className="font-retro text-sm text-amber-100">WARZONE ACCESS LOCKED</h2>
            <p className="mt-3 text-sm text-foreground">This project is registered with MemeWarzone.</p>
            <p className="mt-2 text-sm text-muted-foreground">
              The full Warzone is opening soon. This page will expand into the full project and trading experience with live project information, market data, chart, trading, Battles, Tournaments and War Leagues.
            </p>
            <p className="mt-2 text-sm text-muted-foreground">Follow and share this project while the Warzone prepares for deployment.</p>
          </div>
        </div>
      </section>
    </ContentContainer>
  );
}
