import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Copy, Eye, Flame, ImageIcon, LockKeyhole, Rocket, Save, ShieldCheck, Trash2, UploadCloud } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import {
  archiveCampaignDraft,
  fetchCampaignDraft,
  fetchCampaignDraftWithAuth,
  saveDraftPromotion,
  type DraftVisibility,
  type PrepareDraftBundle,
} from "@/lib/draftApi";
import { signDraftAction } from "@/lib/draftAuth";
import { apiFetch } from "@/lib/apiBase";
import { signSolanaDraftAction } from "@/lib/solanaWallet";
import { getActiveChainId, getChainLabel, isSolanaChainId, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import { normalizeSocialUrl } from "@/lib/socialLinks";

const DRAFT_PUSH_LIVE_ENABLED = ["1", "true", "yes", "on"].includes(
  String(import.meta.env.VITE_DRAFT_PUSH_LIVE_ENABLED || import.meta.env.VITE_ENABLE_DRAFT_PUSH_LIVE || "")
    .trim()
    .toLowerCase()
);

const MAX_LOGO_UPLOAD_BYTES = 5 * 1024 * 1024;

function splitLines(value: string) {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function joinLines(items?: string[]) {
  return (items || []).join("\n");
}

function shortDraftId(value: string) {
  return value ? `#${value.slice(0, 8)}` : "#DRAFT";
}

function shortWallet(value?: string | null) {
  const raw = String(value || "").trim();
  if (!raw) return "Not connected";
  return `${raw.slice(0, 5)}...${raw.slice(-4)}`;
}

function sameWallet(a?: string | null, b?: string | null, solana = false) {
  const left = String(a || "").trim();
  const right = String(b || "").trim();
  if (!left || !right) return false;
  return solana ? left === right : left.toLowerCase() === right.toLowerCase();
}

function canPushLiveStatus(status: string) {
  return status === "promotion_published" || status === "ready_to_launch" || status === "scheduled";
}

function getCachedLogo(draftId: string) {
  if (typeof window === "undefined" || !draftId) return "";
  try {
    return window.sessionStorage.getItem(`mwz:draft-logo:${draftId}`) || "";
  } catch {
    return "";
  }
}

function setCachedLogo(draftId: string, logoUrl: string) {
  if (typeof window === "undefined" || !draftId || !logoUrl) return;
  try {
    window.sessionStorage.setItem(`mwz:draft-logo:${draftId}`, logoUrl);
  } catch {
    // Ignore cache failures.
  }
}

function TokenImage({ src, ticker }: { src?: string | null; ticker: string }) {
  const [failedSrc, setFailedSrc] = useState("");
  const safeSrc = src && src !== failedSrc ? src : "";

  useEffect(() => {
    setFailedSrc("");
  }, [src]);

  return (
    <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-full border border-orange-400/50 bg-[radial-gradient(circle_at_30%_25%,rgba(57,255,122,0.95),rgba(0,65,28,0.95)_52%,rgba(0,0,0,0.78))] font-retro text-xl text-white shadow-[0_0_28px_rgba(57,255,122,0.22)] lg:h-24 lg:w-24">
      {safeSrc ? (
        <img
          src={safeSrc}
          alt={`${ticker} logo`}
          className="h-full w-full object-cover"
          onError={() => setFailedSrc(String(safeSrc))}
        />
      ) : (
        `$${ticker}`
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/40 bg-black/35 p-3">
      <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
      <div className="mt-1 font-retro text-2xl leading-none text-foreground">{value}</div>
    </div>
  );
}

function FieldLabel({ children }: { children: ReactNode }) {
  return <label className="mb-1 block font-retro text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{children}</label>;
}

export default function DraftPromotionSetup() {
  const { draftId = "" } = useParams();
  const navigate = useNavigate();
  const wallet = useWallet();
  const solanaWallet = useSolanaWallet();
  const logoInputRef = useRef<HTMLInputElement | null>(null);

  const [bundle, setBundle] = useState<PrepareDraftBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [cachedLogoUrl, setCachedLogoUrl] = useState("");

  const [missionStatement, setMissionStatement] = useState("");
  const [launchStrategy, setLaunchStrategy] = useState("");
  const [telegramUrl, setTelegramUrl] = useState("");
  const [discordUrl, setDiscordUrl] = useState("");
  const [xUrl, setXUrl] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [docsText, setDocsText] = useState("");
  const [creatorNote, setCreatorNote] = useState("");
  const [visibility, setVisibility] = useState<DraftVisibility>("private");

  const draft = bundle?.draft;
  const pop = bundle?.popularity;
  const isSolanaDraft = isSolanaChainId(Number(draft?.chainId));
  const ownerWallet = isSolanaDraft ? solanaWallet.solanaAccount : wallet.account;
  const ownerConnected = sameWallet(draft?.creatorWallet, ownerWallet, isSolanaDraft);
  const logoUrl = draft?.logoUrl || cachedLogoUrl;

  const signOwnerAction = async (action: "read_draft" | "save_promotion" | "publish_promotion" | "archive_draft") => {
    if (isSolanaDraft || (!draft && solanaWallet.solanaAccount && !wallet.account)) {
      const walletAddress = solanaWallet.solanaAccount;
      if (!walletAddress) throw new Error("Connect the draft owner Solana wallet first.");
      return signSolanaDraftAction({
        walletAddress,
        chainId: draft?.chainId || SOLANA_CHAIN_ID,
        action,
        draftId,
      });
    }

    if (!wallet.account || !wallet.signer) throw new Error("Connect the draft owner BNB wallet first.");
    return signDraftAction({
      signer: wallet.signer,
      walletAddress: wallet.account,
      chainId: draft?.chainId || getActiveChainId(wallet.chainId),
      action,
      draftId,
    });
  };

  useEffect(() => {
    setCachedLogoUrl(getCachedLogo(draftId));
  }, [draftId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const loadDraft = async () => {
      const viewer = solanaWallet.solanaAccount || wallet.account || null;
      const first = await fetchCampaignDraft(draftId, viewer).catch((err: any) => {
        if (String(err?.message || "").toLowerCase().includes("private draft")) return null;
        throw err;
      });

      if (first) return first;

      const readAuth = solanaWallet.solanaAccount
        ? await signSolanaDraftAction({ walletAddress: solanaWallet.solanaAccount, chainId: SOLANA_CHAIN_ID, action: "read_draft", draftId })
        : await signDraftAction({
            signer: wallet.signer,
            walletAddress: wallet.account || "",
            chainId: getActiveChainId(wallet.chainId),
            action: "read_draft",
            draftId,
          });

      return fetchCampaignDraftWithAuth(draftId, readAuth);
    };

    void loadDraft()
      .then((data) => {
        if (cancelled) return;
        setBundle(data);
        setMissionStatement(data.promotion.missionStatement || data.draft.description || "");
        setLaunchStrategy(data.promotion.launchStrategy || "");
        setTelegramUrl(data.promotion.telegramUrl || "");
        setDiscordUrl(data.promotion.discordUrl || "");
        setXUrl(data.promotion.xUrl || data.draft.xUrl || "");
        setWebsiteUrl(data.promotion.websiteUrl || data.draft.websiteUrl || "");
        setDocsText(joinLines(data.promotion.docs));
        setCreatorNote(data.promotion.creatorNote || "");
        setVisibility(data.draft.visibility || "private");
      })
      .catch((err) => toast.error(err?.message || "Draft not found"))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [draftId, wallet.account, wallet.signer, wallet.chainId, solanaWallet.solanaAccount]);

  const readiness = useMemo(() => {
    const checks = [
      Boolean(logoUrl),
      Boolean(missionStatement.trim()),
      Boolean(launchStrategy.trim()),
      Boolean(xUrl.trim() || telegramUrl.trim() || discordUrl.trim() || websiteUrl.trim()),
      visibility !== "private",
    ];
    return Math.round((checks.filter(Boolean).length / checks.length) * 100);
  }, [logoUrl, missionStatement, launchStrategy, xUrl, telegramUrl, discordUrl, websiteUrl, visibility]);

  const uploadLogoFile = async (file: File) => {
    if (!draft) throw new Error("Draft is not loaded yet.");
    if (!ownerConnected) throw new Error(`Connect the draft owner ${isSolanaDraft ? "Solana" : "BNB"} wallet before uploading.`);
    if (file.size > MAX_LOGO_UPLOAD_BYTES) throw new Error("Image is too large. Max upload size is 5 MB.");
    if (!/^(image\/png|image\/jpeg|image\/jpg|image\/webp)$/.test(file.type)) throw new Error("Unsupported image type. Use PNG, JPG, or WebP.");

    const fd = new FormData();
    fd.append("file", file);
    const qs = new URLSearchParams({
      kind: "logo",
      chainId: String(draft.chainId),
      address: draft.creatorWallet,
      draftId: draft.id,
    });
    try {
      const { signWalletAction, appendAuthToSearchParams } = await import("@/lib/walletActionAuth");
      if (isSolanaDraft) {
        const { signSolanaMessage } = await import("@/lib/solanaWallet");
        const auth = await signWalletAction({
          action: "upload_logo",
          walletAddress: draft.creatorWallet,
          chainId: Number(draft.chainId),
          walletType: "solana",
          extraLines: [`Draft ID: ${draft.id}`],
          signMessage: async (message) => (await signSolanaMessage(message, draft.creatorWallet)).signature,
        });
        appendAuthToSearchParams(qs, auth);
      } else if (wallet?.signer) {
        const auth = await signWalletAction({
          action: "upload_logo",
          walletAddress: draft.creatorWallet,
          chainId: Number(draft.chainId),
          extraLines: [`Draft ID: ${draft.id}`],
          signer: wallet.signer,
        });
        appendAuthToSearchParams(qs, auth);
      }
    } catch (signErr) {
      console.warn("[DraftPromotionSetup] upload auth sign skipped", signErr);
    }

    const res = await apiFetch(`/api/upload?${qs.toString()}`, { method: "POST", body: fd });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(String(json?.error || json?.message || `Upload failed (${res.status})`));
    if (!json?.url) throw new Error("Upload succeeded but no image URL was returned.");
    return { url: String(json.url), persisted: Boolean(json.persistedDraftLogo) };
  };

  const handleLogoSelected = async (file: File) => {
    setUploadingLogo(true);
    const toastId = toast.loading("Uploading image...");
    try {
      const { url, persisted } = await uploadLogoFile(file);
      setCachedLogo(draftId, url);
      setCachedLogoUrl(url);
      setBundle((current) => current ? { ...current, draft: { ...current.draft, logoUrl: url } } : current);
      toast.success(persisted ? "Image uploaded and saved." : "Image uploaded. Save the draft page to keep it.");
    } catch (err: any) {
      toast.error(err?.message || "Image upload failed.");
    } finally {
      setUploadingLogo(false);
      toast.dismiss(toastId);
    }
  };

  const save = async (options?: { publish?: boolean; preview?: boolean }) => {
    const publish = Boolean(options?.publish);
    const preview = Boolean(options?.preview);
    const nextVisibility: DraftVisibility = preview && visibility === "private" ? "unlisted" : visibility;

    if (!draft) return null;
    if (!ownerConnected) {
      toast.error(`Connect the draft owner ${isSolanaDraft ? "Solana" : "BNB"} wallet before saving.`);
      return null;
    }

    const normalizedX = normalizeSocialUrl(xUrl, "x");
    const normalizedTelegram = normalizeSocialUrl(telegramUrl, "telegram");
    const normalizedDiscord = normalizeSocialUrl(discordUrl, "discord");
    const normalizedWebsite = normalizeSocialUrl(websiteUrl, "website");
    const normalizedDocs = splitLines(docsText).map((item) => normalizeSocialUrl(item, "other"));

    setSaving(true);
    try {
      const auth = await signOwnerAction(publish ? "publish_promotion" : "save_promotion");
      const updated = await saveDraftPromotion(draftId, {
        auth,
        missionStatement,
        roadmap: [],
        launchStrategy,
        telegramUrl: normalizedTelegram,
        discordUrl: normalizedDiscord,
        xUrl: normalizedX,
        websiteUrl: normalizedWebsite,
        docs: normalizedDocs,
        creatorNote,
        bannerUrl: "",
        shareMessage:
          `Incoming transmission from the Warzone:\n\n` +
          `${draft?.name || "this draft"} is preparing for war on MemeWarzone.\n\n` +
          `Follow the signal → @memewarzone`,
        visibility: publish ? "public" : nextVisibility,
        publish,
      });
      setBundle(updated);
      setVisibility(updated.draft.visibility);
      setXUrl(updated.promotion.xUrl || "");
      setTelegramUrl(updated.promotion.telegramUrl || "");
      setDiscordUrl(updated.promotion.discordUrl || "");
      setWebsiteUrl(updated.promotion.websiteUrl || "");
      setDocsText(joinLines(updated.promotion.docs));
      toast.success(publish ? "Promotion page published." : preview ? "Saved. Preview opened." : "Draft page saved.");
      if (preview || publish) navigate(`/prepare/${updated.draft.slug}`);
      return updated;
    } catch (err: any) {
      toast.error(err?.message || "Failed to save promotion page");
      return null;
    } finally {
      setSaving(false);
    }
  };

  const copyLink = async () => {
    if (!draft) return;
    const url = `${window.location.origin}/prepare/${draft.slug}`;
    await navigator.clipboard?.writeText(url).catch(() => undefined);
    toast.success("Prepare page link copied.");
  };

  const archiveCurrentDraft = async () => {
    if (!draft) return;
    if (!ownerConnected) {
      toast.error(`Connect the draft owner ${isSolanaDraft ? "Solana" : "BNB"} wallet before removing.`);
      return;
    }
    if (draft.status === "deployed") {
      toast.error("Deployed drafts cannot be removed.");
      return;
    }
    const confirmed = window.confirm(`Remove ${draft.name} / $${draft.ticker}? This hides it from Prepare Mode and unlocks the ticker.`);
    if (!confirmed) return;

    setSaving(true);
    try {
      const auth = await signOwnerAction("archive_draft");
      await archiveCampaignDraft(draftId, auth);
      toast.success("Draft removed. The ticker is available again.");
      navigate("/profile?tab=drafts");
    } catch (err: any) {
      toast.error(err?.message || "Failed to archive draft.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="mx-auto max-w-6xl py-20 text-center font-retro text-muted-foreground">Loading draft command center...</div>;
  }

  if (!draft || !bundle) {
    return (
      <div className="mx-auto max-w-4xl py-20 text-center">
        <h1 className="font-retro text-4xl text-foreground">Draft not found</h1>
        <Button asChild className="mwz-button mt-6 font-retro">
          <Link to="/create">Create Draft</Link>
        </Button>
      </div>
    );
  }

  const canPushLive = canPushLiveStatus(draft.status);
  const textareaClass = "resize-none border-border/70 bg-background/50 font-retro text-sm leading-5";
  const inputClass = "h-9 border-border/70 bg-background/50 font-retro text-xs";

  return (
    <div className="relative -mx-2 -mt-1 min-h-screen overflow-hidden bg-[radial-gradient(ellipse_at_top_left,rgba(255,153,0,0.16),transparent_42%),linear-gradient(180deg,rgba(1,6,0,0.98),rgba(0,0,0,0.96))] md:-mx-3 lg:-mx-4">
      <div className="pointer-events-none absolute inset-0 opacity-30 [background-image:linear-gradient(rgba(57,255,79,0.07)_1px,transparent_1px),linear-gradient(90deg,rgba(255,153,0,0.06)_1px,transparent_1px)] [background-size:44px_44px]" />

      <div className="relative z-10 grid min-h-screen lg:h-[calc(100dvh-5.4rem)] lg:min-h-0 lg:grid-cols-[1fr_360px] xl:grid-cols-[1fr_380px]">
        <div className="min-h-0 border-r border-border/60 lg:overflow-hidden">
          <div className="flex min-h-14 flex-col gap-3 border-b border-border/70 bg-black/70 px-4 py-3 backdrop-blur md:flex-row md:items-center md:justify-between md:px-5">
            <div className="flex items-center gap-3">
              <Button asChild variant="ghost" className="mwz-button h-8 px-3 text-xs">
                <Link to="/create">Back</Link>
              </Button>
              <div>
                <div className="text-xs uppercase tracking-[0.22em] text-orange-300">// Prepare setup</div>
                <div className="font-retro text-sm uppercase tracking-[0.12em] text-muted-foreground">${draft.ticker} · {getChainLabel(Number(draft.chainId))} · Draft {shortDraftId(draft.id)}</div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{draft.status.replace(/_/g, " ")}</span>
              <Button onClick={() => save()} disabled={saving || uploadingLogo} variant="outline" className="mwz-button h-8 px-3 text-xs">
                <Save className="mr-1 h-3 w-3" /> Save
              </Button>
              <Button onClick={() => save({ preview: true })} disabled={saving || uploadingLogo} variant="outline" className="mwz-button h-8 px-3 text-xs">
                <Eye className="mr-1 h-3 w-3" /> Preview
              </Button>
            </div>
          </div>

          <div className="mx-auto grid h-auto max-w-6xl gap-3 px-3 py-3 md:px-4 lg:h-[calc(100%-4.25rem)] lg:grid-rows-[auto_1fr_1fr_auto] lg:overflow-hidden">
            <section className="mwz-card p-3">
              <div className="grid gap-3 md:grid-cols-[auto_1fr_1fr] md:items-center">
                <div className="flex flex-col items-start gap-2">
                  <TokenImage src={logoUrl} ticker={draft.ticker} />
                  <input
                    ref={logoInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/jpg,image/webp"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void handleLogoSelected(file);
                      event.currentTarget.value = "";
                    }}
                  />
                  <Button
                    type="button"
                    onClick={() => logoInputRef.current?.click()}
                    disabled={!ownerConnected || saving || uploadingLogo}
                    variant="outline"
                    className="mwz-button h-8 px-3 text-xs"
                  >
                    {uploadingLogo ? <><UploadCloud className="mr-1 h-3 w-3 animate-pulse" /> Uploading</> : <><ImageIcon className="mr-1 h-3 w-3" /> Upload image</>}
                  </Button>
                </div>
                <div className="min-w-0">
                  <FieldLabel>Name</FieldLabel>
                  <Input value={draft.name} readOnly className="h-11 border-dashed border-border/80 bg-background/30 font-retro text-xl uppercase tracking-[0.08em] lg:text-2xl" />
                </div>
                <div className="grid gap-2 sm:grid-cols-[0.45fr_1fr]">
                  <div>
                    <FieldLabel>Ticker</FieldLabel>
                    <Input value={`$${draft.ticker}`} readOnly className="h-11 border-dashed border-border/80 bg-background/30 font-mono text-sm uppercase tracking-[0.18em] text-orange-300" />
                  </div>
                  <div>
                    <FieldLabel>Owner</FieldLabel>
                    <Input value={shortWallet(draft.creatorWallet)} readOnly className="h-11 border-dashed border-border/80 bg-background/30 font-mono text-sm text-muted-foreground" />
                  </div>
                </div>
              </div>
              {!ownerConnected && <p className="mt-2 text-xs text-orange-300">Connect {shortWallet(draft.creatorWallet)} with a {isSolanaDraft ? "Solana" : "BNB"} wallet to upload, save, or publish this draft.</p>}
            </section>

            <section className="grid min-h-0 gap-3 md:grid-cols-2">
              <div className="mwz-card flex min-h-0 flex-col p-3">
                <div className="mb-2 flex items-center gap-2">
                  <LockKeyhole className="h-4 w-4 text-orange-300" />
                  <div>
                    <div className="font-retro text-sm uppercase tracking-[0.12em] text-foreground">Mission Statement</div>
                    <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">SEC 02 / creator text</div>
                  </div>
                </div>
                <Textarea value={missionStatement} onChange={(e) => setMissionStatement(e.target.value)} className={`${textareaClass} min-h-40 flex-1 lg:min-h-0`} placeholder="Explain the brief. What is this draft? Why should soldiers lock in before launch?" />
              </div>
              <div className="mwz-card flex min-h-0 flex-col p-3">
                <div className="mb-2 flex items-center gap-2">
                  <LockKeyhole className="h-4 w-4 text-orange-300" />
                  <div>
                    <div className="font-retro text-sm uppercase tracking-[0.12em] text-foreground">Launch Strategy</div>
                    <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">SEC 03 / battle plan</div>
                  </div>
                </div>
                <Textarea value={launchStrategy} onChange={(e) => setLaunchStrategy(e.target.value)} className={`${textareaClass} min-h-40 flex-1 lg:min-h-0`} placeholder="How will the creator build hype, activate the squad, and push into launch day?" />
              </div>
            </section>

            <section className="grid min-h-0 gap-3 md:grid-cols-[1.2fr_0.8fr]">
              <div className="mwz-card p-3">
                <div className="mb-2 flex items-center gap-2">
                  <LockKeyhole className="h-4 w-4 text-orange-300" />
                  <div>
                    <div className="font-retro text-sm uppercase tracking-[0.12em] text-foreground">Comms Channels</div>
                    <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">SEC 04 / public links</div>
                  </div>
                </div>
                <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                  <div><FieldLabel>Website</FieldLabel><Input value={websiteUrl} onChange={(e) => setWebsiteUrl(e.target.value)} onBlur={() => setWebsiteUrl(normalizeSocialUrl(websiteUrl, "website"))} className={inputClass} placeholder="memewar.zone or full URL" /></div>
                  <div><FieldLabel>X (formerly Twitter)</FieldLabel><Input value={xUrl} onChange={(e) => setXUrl(e.target.value)} onBlur={() => setXUrl(normalizeSocialUrl(xUrl, "x"))} className={inputClass} placeholder="memewarzone, @memewarzone, or URL" /></div>
                  <div><FieldLabel>Telegram</FieldLabel><Input value={telegramUrl} onChange={(e) => setTelegramUrl(e.target.value)} onBlur={() => setTelegramUrl(normalizeSocialUrl(telegramUrl, "telegram"))} className={inputClass} placeholder="memewarzone, @memewarzone, or URL" /></div>
                  <div><FieldLabel>Discord</FieldLabel><Input value={discordUrl} onChange={(e) => setDiscordUrl(e.target.value)} onBlur={() => setDiscordUrl(normalizeSocialUrl(discordUrl, "discord"))} className={inputClass} placeholder="Invite code or full URL" /></div>
                </div>
              </div>

              <div className="mwz-card grid gap-3 p-3 sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2">
                <div className="min-h-0"><FieldLabel>Other / Docs</FieldLabel><Textarea value={docsText} onChange={(e) => setDocsText(e.target.value)} className={`${textareaClass} min-h-24 lg:min-h-[6.25rem]`} placeholder={"https://docs.example.com\nhttps://whitepaper.example.com"} /></div>
                <div className="min-h-0"><FieldLabel>Creator Note</FieldLabel><Textarea value={creatorNote} onChange={(e) => setCreatorNote(e.target.value)} className={`${textareaClass} min-h-24 lg:min-h-[6.25rem]`} placeholder="Creator note shown in the dossier." /></div>
              </div>
            </section>

            <section className="mwz-card grid gap-3 p-3 md:grid-cols-[1fr_auto] md:items-center">
              <div>
                <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">// Visibility + share link</div>
                <div className="mt-2 flex items-center gap-2 border border-border/70 bg-black/45 px-3 py-2 font-mono text-xs text-muted-foreground">
                  <span className="min-w-0 flex-1 truncate">/prepare/{draft.slug}</span>
                  <button type="button" onClick={copyLink} className="text-orange-300"><Copy className="h-4 w-4" /></button>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 md:min-w-[21rem]">
                {(["public", "unlisted", "private"] as DraftVisibility[]).map((item) => {
                  const isSelected = visibility === item;
                  return (
                    <button
                      key={item}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => setVisibility(item)}
                      className={`mwz-button h-9 text-[10px] uppercase tracking-[0.14em] ${isSelected ? "mwz-button-orange !bg-orange-500/25 !text-orange-100 font-semibold" : ""}`}
                    >
                      {item}
                    </button>
                  );
                })}
              </div>
            </section>
          </div>
        </div>

        <aside className="bg-black/45 p-4 backdrop-blur lg:h-[calc(100dvh-5.4rem)] lg:overflow-hidden">
          <div className="mb-3">
            <div className="text-xs uppercase tracking-[0.22em] text-orange-300">// Command center</div>
            <h2 className="mt-1 font-retro text-2xl uppercase tracking-[0.08em] text-foreground">Draft control</h2>
          </div>

          <div className="mwz-card mb-3 border-orange-400/50 bg-[radial-gradient(circle_at_30%_0%,rgba(255,153,0,0.18),rgba(2,17,4,0.92))] p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Readiness</div>
              <div className="rounded-full border border-border/50 px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{getChainLabel(Number(draft.chainId))}</div>
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="font-retro text-5xl leading-none text-orange-300">{readiness}</span>
              <span className="font-mono text-sm text-muted-foreground">/ 100</span>
            </div>
            <div className="mt-3 h-2 border border-border/60 bg-black/45">
              <div className="h-full bg-gradient-to-r from-orange-500 to-green-400" style={{ width: `${readiness}%` }} />
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">Image, mission, launch plan, one comms channel, and visibility.</p>
            {isSolanaDraft ? <p className="mt-2 text-xs leading-5 text-sky-200">Solana promotion setup uses Solana wallet signatures. After publish, Push Live deploys the campaign on Solana (V4 authorized create).</p> : null}
            <Button onClick={() => save({ publish: true })} disabled={saving || uploadingLogo || !ownerConnected} className="mwz-button mwz-button-orange mt-3 h-10 w-full justify-center font-retro">
              <Rocket className="mr-2 h-4 w-4" /> Publish promotion
            </Button>
            {canPushLive && (
              DRAFT_PUSH_LIVE_ENABLED ? (
                <Button asChild className="mwz-button mwz-button-orange mt-2 h-10 w-full justify-center font-retro">
                  <Link to={`/drafts/${draft.id}/push-live`}>
                    <Rocket className="mr-2 h-4 w-4" /> Push Live
                  </Link>
                </Button>
              ) : (
                <Button disabled variant="outline" className="mwz-button mt-2 h-10 w-full justify-center font-retro opacity-70">
                  <Rocket className="mr-2 h-4 w-4" /> Push Live Locked
                </Button>
              )
            )}
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Button onClick={() => save()} disabled={saving || uploadingLogo || !ownerConnected} variant="outline" className="mwz-button h-9 justify-center font-retro text-xs"><Save className="mr-2 h-4 w-4" /> Save</Button>
              <Button onClick={() => save({ preview: true })} disabled={saving || uploadingLogo || !ownerConnected} variant="outline" className="mwz-button h-9 justify-center font-retro text-xs"><Eye className="mr-2 h-4 w-4" /> Preview</Button>
            </div>
          </div>

          <div className="mb-3 grid grid-cols-2 gap-2">
            <Metric label="Views" value={String(pop?.views || 0)} />
            <Metric label="Armed" value={String(pop?.signedActions || 0)} />
            <Metric label="Watchlists" value={String(pop?.follows || 0)} />
            <Metric label="Shares" value={String(pop?.shares || 0)} />
          </div>

          <div className="mwz-card mb-3 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-muted-foreground"><ShieldCheck className="h-4 w-4 text-orange-300" /> Setup sections</div>
            {["Identity + image", "Mission", "Strategy", "Comms", "Docs + Note"].map((name, index) => (
              <div key={name} className="flex items-center gap-3 border-b border-border/40 py-1.5 last:border-b-0">
                <LockKeyhole className="h-3.5 w-3.5 text-orange-300" />
                <div className="min-w-0 flex-1 font-retro text-xs text-foreground">{name}</div>
                <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">0{index + 1}</span>
              </div>
            ))}
          </div>

          <div className="mwz-card p-3">
            <div className="mb-2 text-xs uppercase tracking-[0.2em] text-muted-foreground">// Actions</div>
            <div className="grid gap-2">
              <Button onClick={copyLink} variant="outline" className="mwz-button h-9 w-full justify-center font-retro text-xs"><Flame className="mr-2 h-4 w-4" /> Copy link</Button>
              <Button onClick={archiveCurrentDraft} disabled={saving || uploadingLogo || !ownerConnected || draft.status === "deployed" || draft.status === "archived"} variant="outline" className="mwz-button h-9 w-full justify-center border-red-500/40 text-xs text-red-300 hover:border-red-400 hover:text-red-200">
                <Trash2 className="mr-2 h-4 w-4" /> {draft.status === "archived" ? "Draft Removed" : "Remove Draft"}
              </Button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
