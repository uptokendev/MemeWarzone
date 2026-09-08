import { useMemo, useRef, useState } from "react";
import { Copy, Edit3, ImagePlus, Loader2, LockKeyhole, Share2, ShieldCheck, ShieldQuestion } from "lucide-react";
import { toast } from "sonner";

import { ContentContainer } from "@/components/layout/ContentContainer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useWallet } from "@/contexts/WalletContext";
import { SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import {
  requestProjectClaim,
  updateProjectImportProfile,
  uploadProjectImportImage,
  type ProjectImportItem,
} from "@/lib/projectImports";
import { signSolanaMessage } from "@/lib/solanaWallet";
import { signWalletAction } from "@/lib/walletActionAuth";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

function sameWallet(left: string | null | undefined, right: string | null | undefined, solana: boolean) {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  if (!a || !b) return false;
  return solana ? a === b : a.toLowerCase() === b.toLowerCase();
}

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

export default function ImportedProjectDetails({ item: initialItem }: { item: ProjectImportItem }) {
  const wallet = useWallet();
  const solanaWallet = useSolanaWallet();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [item, setItem] = useState(initialItem);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [description, setDescription] = useState(item.description || "");
  const [website, setWebsite] = useState(item.website || "");
  const [xUrl, setXUrl] = useState(item.xUrl || "");
  const [telegramUrl, setTelegramUrl] = useState(item.telegramUrl || "");

  const solana = item.chainId === SOLANA_CHAIN_ID;
  const connectedWallet = solana ? solanaWallet.solanaAccount : wallet.account;
  const ownerConnected = sameWallet(connectedWallet, item.ownerWallet, solana);
  const ownerVerified = Boolean(item.verifiedAt);
  const canEdit = ownerVerified && ownerConnected;
  const chainLabel = solana ? "Solana" : "BNB";
  const identityLabel = solana ? "Mint" : "Contract";
  const websiteHref = useMemo(() => safeExternalUrl(item.website), [item.website]);
  const xHref = useMemo(() => safeExternalUrl(item.xUrl), [item.xUrl]);
  const telegramHref = useMemo(() => safeExternalUrl(item.telegramUrl), [item.telegramUrl]);

  const signAction = async (action: string, extraLines: string[]) => {
    if (!connectedWallet) throw new Error("Connect the registered project wallet first.");
    if (solana) {
      return signWalletAction({
        action,
        walletAddress: connectedWallet,
        chainId: item.chainId,
        walletType: "solana",
        extraLines,
        signMessage: async (message) => (await signSolanaMessage(message, connectedWallet)).signature,
      });
    }
    return signWalletAction({
      action,
      walletAddress: connectedWallet,
      chainId: item.chainId,
      extraLines,
      signer: wallet.signer,
    });
  };

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

  const saveProfile = async () => {
    if (!canEdit || saving) return;
    setSaving(true);
    const toastId = toast.loading("Saving project details...");
    try {
      const auth = await signAction("arena_import_profile_update", [`Import: ${item.id}`]);
      const next = await updateProjectImportProfile({ item, auth, description, website, xUrl, telegramUrl });
      setItem(next);
      setDescription(next.description || "");
      setWebsite(next.website || "");
      setXUrl(next.xUrl || "");
      setTelegramUrl(next.telegramUrl || "");
      setEditing(false);
      toast.success("Project details updated.");
    } catch (error: any) {
      toast.error(String(error?.message || "Could not update project details."));
    } finally {
      toast.dismiss(toastId);
      setSaving(false);
    }
  };

  const uploadImage = async (file: File) => {
    if (!canEdit || uploading) return;
    if (file.size > MAX_IMAGE_BYTES) {
      toast.error("Image is too large. Maximum size is 5 MB.");
      return;
    }
    if (!ALLOWED_IMAGE_TYPES.has(file.type.toLowerCase())) {
      toast.error("Use PNG, JPEG or WEBP.");
      return;
    }
    setUploading(true);
    const toastId = toast.loading("Updating project image...");
    try {
      const auth = await signAction("arena_import_image", [`Import: ${item.id}`]);
      const result = await uploadProjectImportImage({ item, file, auth });
      setItem((current) => ({
        ...current,
        imageUrl: result.url,
        metadataUpdatedAt: result.metadataUpdatedAt || current.metadataUpdatedAt || null,
        verifiedAt: result.verifiedAt || current.verifiedAt || null,
      }));
      toast.success("Project image updated.");
    } catch (error: any) {
      toast.error(String(error?.message || "Could not update project image."));
    } finally {
      toast.dismiss(toastId);
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const requestClaim = async () => {
    if (!ownerConnected || ownerVerified || claiming) return;
    setClaiming(true);
    const toastId = toast.loading("Requesting project claim...");
    try {
      const auth = await signAction("arena_import_request_review", [`Import: ${item.id}`]);
      const next = await requestProjectClaim(item.id, auth);
      setItem(next);
      toast.success("Project claim requested.");
    } catch (error: any) {
      toast.error(String(error?.message || "Could not request project claim."));
    } finally {
      toast.dismiss(toastId);
      setClaiming(false);
    }
  };

  return (
    <ContentContainer className="space-y-5 px-1 pb-12 pt-2" data-imported-project-page="true">
      <section className="mwz-hud-frame p-5">
        <div className="flex flex-col gap-5 md:flex-row md:items-start">
          <div className="relative h-28 w-28 shrink-0 overflow-hidden rounded-xl border border-white/10 bg-white/5">
            {item.imageUrl ? (
              <img src={item.imageUrl} alt={`${item.name || item.symbol || "Imported project"} logo`} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-3xl font-black text-white/30">
                {(item.symbol || item.name || "?").slice(0, 2).toUpperCase()}
              </div>
            )}
            {canEdit ? (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  className="hidden"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void uploadImage(file);
                  }}
                />
                <button
                  type="button"
                  aria-label="Edit project image"
                  className="absolute bottom-1 right-1 rounded-md border border-white/15 bg-black/75 p-2 text-white hover:bg-black"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                  data-owner-image-edit="true"
                >
                  {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
                </button>
              </>
            ) : null}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-accent/50 bg-accent/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-accent" data-imported-badge="true">IMPORTED</span>
              {ownerVerified ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-emerald-200" data-owner-verified-badge="true">
                  <ShieldCheck className="h-3.5 w-3.5" /> OWNER VERIFIED
                </span>
              ) : null}
            </div>
            <h1 className="mt-3 break-words font-retro text-2xl text-foreground">{item.name || item.symbol || "Imported project"}</h1>
            {item.symbol ? <p className="mt-1 text-sm font-bold text-accent">${item.symbol}</p> : null}
            <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
              <div><span className="text-muted-foreground">Chain</span><div className="mt-1 font-semibold text-foreground">{chainLabel}</div></div>
              <div className="min-w-0">
                <span className="text-muted-foreground">{identityLabel}</span>
                <button type="button" onClick={() => void copyIdentity()} className="mt-1 flex max-w-full items-center gap-1 break-all text-left font-mono text-xs text-foreground hover:text-accent">
                  {item.tokenAddress}<Copy className="h-3.5 w-3.5 shrink-0" />
                </button>
              </div>
            </div>
          </div>

          <div className="flex shrink-0 gap-2">
            {canEdit ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setEditing((value) => !value)} data-owner-edit-controls="true">
                <Edit3 className="mr-2 h-4 w-4" /> EDIT
              </Button>
            ) : null}
            <Button type="button" variant="outline" size="sm" onClick={() => void share()} data-project-share="true">
              <Share2 className="mr-2 h-4 w-4" /> SHARE
            </Button>
          </div>
        </div>
      </section>

      {!ownerVerified ? (
        <section className="mwz-hud-frame p-5" data-manual-claim-state="true">
          <div className="flex items-start gap-3">
            <ShieldQuestion className="mt-0.5 h-5 w-5 text-amber-200" />
            <div className="flex-1">
              <h2 className="font-retro text-sm text-foreground">AUTOMATIC OWNERSHIP VERIFICATION UNAVAILABLE</h2>
              <p className="mt-2 text-sm text-muted-foreground">The project is registered, but automatic chain evidence did not verify ownership.</p>
              {ownerConnected ? (
                <Button type="button" variant="outline" className="mt-4" onClick={() => void requestClaim()} disabled={claiming || Boolean(item.reviewRequestedAt)} data-project-claim-action="true">
                  {claiming ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {item.reviewRequestedAt ? "PROJECT CLAIM REQUESTED" : "REQUEST PROJECT CLAIM"}
                </Button>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      <section className="mwz-hud-frame p-5" data-project-profile="true">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-retro text-sm text-foreground">PROJECT</h2>
          {ownerVerified && !ownerConnected ? <span className="text-xs text-muted-foreground">Connect the verified owner wallet to edit.</span> : null}
        </div>

        {editing && canEdit ? (
          <div className="mt-4 space-y-4" data-owner-profile-editor="true">
            <div>
              <label htmlFor="import-description" className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Description</label>
              <Textarea id="import-description" className="mt-2" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1200} />
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              <div><label htmlFor="import-website" className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Website</label><Input id="import-website" className="mt-2" value={website} onChange={(event) => setWebsite(event.target.value)} /></div>
              <div><label htmlFor="import-x" className="text-xs uppercase tracking-[0.12em] text-muted-foreground">X</label><Input id="import-x" className="mt-2" value={xUrl} onChange={(event) => setXUrl(event.target.value)} /></div>
              <div><label htmlFor="import-telegram" className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Telegram</label><Input id="import-telegram" className="mt-2" value={telegramUrl} onChange={(event) => setTelegramUrl(event.target.value)} /></div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => void saveProfile()} disabled={saving}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}SAVE PROJECT</Button>
              <Button type="button" variant="outline" onClick={() => { setEditing(false); setDescription(item.description || ""); setWebsite(item.website || ""); setXUrl(item.xUrl || ""); setTelegramUrl(item.telegramUrl || ""); }} disabled={saving}>CANCEL</Button>
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-4 text-sm">
            <div>
              <div className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Description</div>
              <p className="mt-1 whitespace-pre-wrap text-foreground">{item.description || "No description added yet."}</p>
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {websiteHref ? <a href={websiteHref} target="_blank" rel="noreferrer" className="text-accent hover:underline">Website</a> : <span className="text-muted-foreground">Website —</span>}
              {xHref ? <a href={xHref} target="_blank" rel="noreferrer" className="text-accent hover:underline">X</a> : <span className="text-muted-foreground">X —</span>}
              {telegramHref ? <a href={telegramHref} target="_blank" rel="noreferrer" className="text-accent hover:underline">Telegram</a> : <span className="text-muted-foreground">Telegram —</span>}
            </div>
          </div>
        )}
      </section>

      <section className="mwz-hud-frame border-amber-400/30 bg-amber-500/[0.04] p-5" data-warzone-locked-panel="true">
        <div className="flex items-start gap-3">
          <LockKeyhole className="mt-0.5 h-5 w-5 shrink-0 text-amber-200" />
          <div>
            <h2 className="font-retro text-sm text-amber-100">WARZONE ACCESS LOCKED</h2>
            <p className="mt-3 text-sm text-foreground">This project is registered with MemeWarzone.</p>
            <p className="mt-2 text-sm text-muted-foreground">Battles, Tournaments and War Leagues are opening soon.</p>
            <p className="mt-2 text-sm text-muted-foreground">Follow this project to be notified when the Warzone opens.</p>
          </div>
        </div>
      </section>
    </ContentContainer>
  );
}
