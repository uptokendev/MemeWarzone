/**
 * Edit coin page (UI redesign phase 1b, artboard CoinEdit). Owner only. Saves the coin page fields
 * through /api/coin-page/profile and the Story boxes through the existing /api/story/profile, each
 * with one wallet signature. No transaction, no fee.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ImagePlus, Loader2, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { STORY_FULL_SECTIONS, STORY_SHORT_MAX } from "../../shared/storyContract.mjs";
import { cp } from "@/components/token/coinPageStyles";
import { CoinAvatar } from "@/components/ui-v2";
import { cn } from "@/lib/utils";
import { useStory } from "@/lib/story/storyApi";
import { saveStoryText, useCoinOwnerSigner, useCoinPage, useCoinPageMutations, type CoinProfileInput } from "@/lib/coinPageApi";
import { diffCoinProfile, type CoinProfileForm } from "@/lib/coinEditForm.mjs";

const inputClass =
  "h-11 w-full rounded-[10px] border border-mw-edge bg-mw-input px-3.5 text-[15px] text-mw-text placeholder:text-[#7C858F] focus:outline-none focus:ring-2 focus:ring-mw-accent";
const areaClass =
  "w-full resize-y rounded-[10px] border border-mw-edge bg-mw-input px-3.5 py-3 text-[15px] text-mw-text placeholder:text-[#7C858F] focus:outline-none focus:ring-2 focus:ring-mw-accent";

function Field({ label, htmlFor, help, children, count }: { label: string; htmlFor: string; help?: ReactNode; children: ReactNode; count?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={htmlFor} className={cp.label}>{label}</label>
        {count ? <span className="font-mw-mono text-xs text-mw-muted">{count}</span> : null}
      </div>
      {children}
      {help ? <span className="text-[13px] text-mw-muted">{help}</span> : null}
    </div>
  );
}

function inferChain(token: string, query: string | null) {
  const q = Number(query || 0);
  if (q) return q;
  return /^0x[a-fA-F0-9]{40}$/.test(token) ? 56 : 101;
}

export default function CoinEdit() {
  const { campaignAddress = "" } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const token = decodeURIComponent(campaignAddress);
  const chainId = inferChain(token, search.get("chainId"));
  const coinPath = `/token/${encodeURIComponent(token)}${search.get("chainId") ? `?chainId=${chainId}` : ""}`;

  const { data, isLoading, error } = useCoinPage(chainId, token);
  const { story } = useStory(chainId, token) as any;
  const { viewer, isOwner, sign } = useCoinOwnerSigner(chainId, data?.owner?.wallet);
  const { saveProfile, uploadImage, refresh } = useCoinPageMutations(chainId, token, data?.owner?.token);
  const imported = data?.owner?.origin === "imported";

  const [form, setForm] = useState<CoinProfileForm | null>(null);
  const [shortStory, setShortStory] = useState("");
  const [sections, setSections] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const bannerRef = useRef<HTMLInputElement | null>(null);
  const sectionRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // Prefill once from what is stored.
  useEffect(() => {
    if (!data || form) return;
    const p = data.profile;
    setForm({
      bannerUrl: p.bannerUrl || "",
      bannerPositionY: p.bannerPositionY ?? 50,
      bio: p.bio || "",
      founderNote: p.founderNote || "",
      websiteUrl: p.websiteUrl || "",
      xUrl: p.xUrl || "",
      telegramUrl: p.telegramUrl || "",
      discordUrl: p.discordUrl || "",
      tags: (p.tags || []).join(", "),
      pinnedPostId: p.pinnedPostId || "",
      shareUpdatesToFeed: p.shareUpdatesToFeed,
      showAutoUpdates: p.showAutoUpdates,
      sectionImages: { ...(p.sectionImages || {}) },
    });
    setShortStory(data.storyText?.shortStory || "");
    setSections({ ...(data.storyText?.sections || {}) });
  }, [data, form]);

  const profileChanges = useMemo(() => (form && data ? diffCoinProfile(data.profile, form, { imported }) : {}), [form, data, imported]);
  const storyChanged = useMemo(() => {
    if (!data) return false;
    const stored = data.storyText || { shortStory: null, sections: {} };
    if (imported && (stored.shortStory || "") !== shortStory.trim()) return true;
    return STORY_FULL_SECTIONS.some((s) => (stored.sections?.[s.key] || "") !== (sections[s.key] || "").trim());
  }, [data, imported, shortStory, sections]);
  const dirty = Object.keys(profileChanges).length > 0 || storyChanged;

  const set = <K extends keyof CoinProfileForm>(key: K, value: CoinProfileForm[K]) => setForm((f) => (f ? { ...f, [key]: value } : f));

  const upload = async (slot: string, file: File | undefined) => {
    if (!file) return;
    setUploading(slot);
    try {
      const url = await uploadImage(sign, slot, file);
      if (slot === "banner") set("bannerUrl", url);
      else set("sectionImages", { ...(form?.sectionImages || {}), [slot.replace(/^section:/, "")]: url });
    } catch (e: any) {
      toast.error(String(e?.message || "Could not upload the image."));
    } finally {
      setUploading(null);
    }
  };

  const save = async () => {
    if (!form || !data?.owner || saving) return;
    setSaving(true);
    try {
      if (Object.keys(profileChanges).length) await saveProfile(sign, profileChanges as CoinProfileInput);
      if (storyChanged) {
        const clean: Record<string, string> = {};
        for (const s of STORY_FULL_SECTIONS) if ((sections[s.key] || "").trim()) clean[s.key] = sections[s.key].trim();
        await saveStoryText(sign, { chainId, token: data.owner.token, shortStory: imported ? shortStory.trim() : "", sections: clean });
        await refresh();
      }
      toast.success("Coin page saved.");
      navigate(coinPath);
    } catch (e: any) {
      toast.error(String(e?.message || "Could not save."));
    } finally {
      setSaving(false);
    }
  };

  const name = String(story?.coin?.name || "");
  const ticker = String(story?.coin?.ticker || "");
  const logo = story?.coin?.logoUrl || null;

  if (isLoading || (!form && !error && data)) {
    return <div className="px-3 py-10 text-center text-mw-muted md:px-6">Loading coin page…</div>;
  }
  if (error || !data) {
    return <div className="px-3 py-10 text-center text-mw-muted md:px-6">This coin page could not be loaded. <Link to={coinPath} className="text-mw-accent-soft">Back to the coin</Link></div>;
  }
  if (!data.owner || !isOwner) {
    return (
      <div className={`${cp.card} mx-3 my-6 max-w-xl p-5 md:mx-6`}>
        <h1 className={`${cp.title} m-0`}>Only the coin's owner can edit this page</h1>
        <p className="mt-2 text-sm text-mw-muted">
          {!data.owner
            ? "This coin has no verified owner yet."
            : viewer
              ? "The connected wallet is not the owner of this coin."
              : "Connect the owner's wallet to edit."}
        </p>
        <Link to={coinPath} className={`${cp.btn} mt-4`}>Back to the coin</Link>
      </div>
    );
  }
  if (!form) return null;

  const posts = data.posts || [];

  return (
    <div className="flex flex-col gap-5 px-3 pb-16 md:px-6 font-mw-body text-mw-text">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className={cp.label}>{ticker ? `$${ticker} · ` : ""}owner only</div>
          <h1 className="m-0 font-mw-cond text-[30px] font-bold leading-tight md:text-[34px]">Edit coin page</h1>
        </div>
        <Link to={coinPath} className={cp.btn}>Cancel</Link>
        <button type="button" onClick={() => void save()} disabled={!dirty || saving} className={`${cp.btn} border-mw-accent bg-mw-accent text-[#140A02] hover:bg-[#FF8F3D] hover:text-[#140A02]`}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          Save and sign
        </button>
      </div>

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-4">
          <section className={`${cp.card} flex flex-col gap-3.5 p-4 md:p-5`} aria-labelledby="edit-banner">
            <h2 id="edit-banner" className={`${cp.title} m-0`}>Banner</h2>
            <input ref={bannerRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => void upload("banner", e.target.files?.[0])} />
            {form.bannerUrl ? (
              <div className="relative">
                <img
                  src={form.bannerUrl}
                  alt="Banner preview. Drag up or down to choose what shows."
                  draggable={false}
                  style={{ objectPosition: `50% ${form.bannerPositionY ?? 50}%` }}
                  onPointerDown={(e) => {
                    const el = e.currentTarget;
                    el.setPointerCapture(e.pointerId);
                    const startY = e.clientY;
                    const start = Number(form.bannerPositionY ?? 50);
                    const height = el.getBoundingClientRect().height || 1;
                    const move = (ev: PointerEvent) => {
                      // Dragging down reveals the top of the image, so the focus moves up.
                      const next = Math.max(0, Math.min(100, Math.round(start - ((ev.clientY - startY) / height) * 100)));
                      set("bannerPositionY", next);
                    };
                    const up = () => {
                      el.removeEventListener("pointermove", move);
                      el.removeEventListener("pointerup", up);
                      el.removeEventListener("pointercancel", up);
                    };
                    el.addEventListener("pointermove", move);
                    el.addEventListener("pointerup", up);
                    el.addEventListener("pointercancel", up);
                  }}
                  className="h-[160px] w-full cursor-ns-resize touch-none select-none rounded-xl border border-mw-border object-cover md:h-[200px]"
                />
                <div className="absolute right-2 top-2 flex gap-2">
                  <button type="button" className={`${cp.btn} min-h-10 bg-[rgba(19,23,28,0.92)] text-sm`} onClick={() => bannerRef.current?.click()} disabled={uploading === "banner"}>Replace</button>
                  <button type="button" aria-label="Remove banner" className={`${cp.btn} min-h-10 w-10 bg-[rgba(19,23,28,0.92)] px-0`} onClick={() => set("bannerUrl", "")}><X className="h-4 w-4" aria-hidden="true" /></button>
                </div>
                <label className="mt-2.5 flex items-center gap-3 text-sm text-mw-muted">
                  <span className="shrink-0">Drag the banner, or set the position</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={form.bannerPositionY ?? 50}
                    onChange={(e) => set("bannerPositionY", Number(e.target.value))}
                    aria-label="Banner vertical position"
                    className="w-full accent-[#FF7A1A]"
                  />
                </label>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => bannerRef.current?.click()}
                disabled={uploading === "banner"}
                className="mw-banner mw-focus flex h-[160px] w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[#3A424C] text-mw-muted md:h-[200px]"
              >
                {uploading === "banner" ? <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" /> : <Upload className="h-6 w-6" aria-hidden="true" />}
                <span>Upload a banner</span>
                <span className="font-mw-mono text-xs">1500 × 500 · JPG, PNG or WEBP · max 5 MB</span>
              </button>
            )}
          </section>

          <section className={`${cp.card} flex flex-col gap-3.5 p-4 md:p-5`} aria-labelledby="edit-about">
            <h2 id="edit-about" className={`${cp.title} m-0`}>About</h2>
            {imported ? (
              <p className="m-0 text-sm text-mw-muted">Imported coins edit their description with EDIT on the coin page.</p>
            ) : (
              <Field label="Bio" htmlFor="edit-bio" count={`${form.bio.length}/1200`} help="Shown under the banner. Empty keeps your launch description. Its paragraphs also become your Story slides.">
                <textarea id="edit-bio" rows={6} maxLength={1200} className={areaClass} value={form.bio} onChange={(e) => set("bio", e.target.value)} />
              </Field>
            )}
            <Field label="Founder note" htmlFor="edit-note" count={`${form.founderNote.length}/140`} help="The quote on the cover of your Story.">
              <input id="edit-note" maxLength={140} className={inputClass} value={form.founderNote} onChange={(e) => set("founderNote", e.target.value)} />
            </Field>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field label="Website" htmlFor="edit-web"><input id="edit-web" type="url" inputMode="url" placeholder="https://" className={inputClass} value={form.websiteUrl} onChange={(e) => set("websiteUrl", e.target.value)} /></Field>
              <Field label="X" htmlFor="edit-x"><input id="edit-x" placeholder="@handle" className={inputClass} value={form.xUrl} onChange={(e) => set("xUrl", e.target.value)} /></Field>
              <Field label="Telegram" htmlFor="edit-tg"><input id="edit-tg" placeholder="t.me/…" className={inputClass} value={form.telegramUrl} onChange={(e) => set("telegramUrl", e.target.value)} /></Field>
              <Field label="Discord" htmlFor="edit-dc"><input id="edit-dc" placeholder="discord.gg/…" className={inputClass} value={form.discordUrl} onChange={(e) => set("discordUrl", e.target.value)} /></Field>
            </div>
            <p className="m-0 text-[13px] text-mw-muted">Links you set here replace the launch links on the coin page. Empty keeps the launch link.</p>
            <Field label="Tags" htmlFor="edit-tags" help="Up to 5, separated by commas.">
              <input id="edit-tags" className={inputClass} value={form.tags} onChange={(e) => set("tags", e.target.value)} />
            </Field>
          </section>

          <section className={`${cp.card} flex flex-col gap-3.5 p-4 md:p-5`} aria-labelledby="edit-story">
            <h2 id="edit-story" className={`${cp.title} m-0`}>Story</h2>
            <p className="m-0 text-[13px] text-mw-muted">Each box becomes a page of your full story. Empty boxes are left out. Story text is saved with its own signature.</p>
            {imported ? (
              <Field label="Short story" htmlFor="edit-short" count={`${shortStory.length}/${STORY_SHORT_MAX}`} help="Your one chapter in the quick Story.">
                <textarea id="edit-short" rows={3} maxLength={STORY_SHORT_MAX} className={areaClass} value={shortStory} onChange={(e) => setShortStory(e.target.value)} />
              </Field>
            ) : null}
            {STORY_FULL_SECTIONS.map((def) => {
              const img = form.sectionImages[def.key];
              const slot = `section:${def.key}`;
              const value = sections[def.key] || "";
              return (
                <div key={def.key} className={`${cp.inset} flex flex-col gap-2 p-3`}>
                  <Field label={def.heading} htmlFor={`edit-sec-${def.key}`} count={`${value.length}/${def.max}`} help={def.prompt}>
                    <textarea id={`edit-sec-${def.key}`} rows={3} maxLength={def.max} className={areaClass} value={value} onChange={(e) => setSections((s) => ({ ...s, [def.key]: e.target.value }))} />
                  </Field>
                  <input ref={(el) => { sectionRefs.current[def.key] = el; }} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => void upload(slot, e.target.files?.[0])} />
                  <div className="flex items-center gap-2">
                    {img ? <img src={img} alt="" className="h-14 w-24 rounded-lg border border-mw-border object-cover" /> : null}
                    <button type="button" className={cn(cp.btn, "min-h-10 text-sm")} onClick={() => sectionRefs.current[def.key]?.click()} disabled={uploading === slot}>
                      {uploading === slot ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ImagePlus className="h-4 w-4" aria-hidden="true" />}
                      {img ? "Replace image" : "Add image"}
                    </button>
                    {img ? (
                      <button type="button" className={cn(cp.btn, "min-h-10 text-sm")} onClick={() => { const next = { ...form.sectionImages }; delete next[def.key]; set("sectionImages", next); }}>
                        Remove
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </section>

          <section className={`${cp.card} flex flex-col gap-3 p-4 md:p-5`} aria-labelledby="edit-posts">
            <h2 id="edit-posts" className={`${cp.title} m-0`}>Posts</h2>
            <Field label="Pinned post" htmlFor="edit-pin">
              <select id="edit-pin" className={inputClass} value={form.pinnedPostId} onChange={(e) => set("pinnedPostId", e.target.value)}>
                <option value="">No pinned post</option>
                {posts.map((p) => (
                  <option key={p.id} value={p.id}>{p.body.length > 70 ? `${p.body.slice(0, 70)}…` : p.body}</option>
                ))}
              </select>
            </Field>
            <label className="flex min-h-11 items-center gap-2.5 text-[15px]">
              <input type="checkbox" className="h-5 w-5 accent-[#FF7A1A]" checked={form.shareUpdatesToFeed} onChange={(e) => set("shareUpdatesToFeed", e.target.checked)} />
              Share my updates to the home feed by default
            </label>
            <label className="flex min-h-11 items-center gap-2.5 text-[15px]">
              <input type="checkbox" className="h-5 w-5 accent-[#FF7A1A]" checked={form.showAutoUpdates} onChange={(e) => set("showAutoUpdates", e.target.checked)} />
              Show auto updates (battles, launch, graduation)
            </label>
          </section>
        </div>

        <aside className="flex flex-col gap-4 xl:sticky xl:top-[calc(var(--mwz-topbar-offset)+16px)]">
          <section className={`${cp.card} flex flex-col gap-2.5 p-4`}>
            <span className={cp.title}>Set at launch</span>
            <div className="flex items-center gap-3">
              <CoinAvatar src={logo} ticker={ticker || "?"} size={64} />
              <div className="text-sm">
                <div className="font-bold">{name || "This coin"}{ticker ? ` · $${ticker}` : ""}</div>
                <div className="text-mw-muted">Name, ticker and image are in the token itself and cannot change.</div>
              </div>
            </div>
          </section>
          <section className={`${cp.card} flex flex-col gap-2 p-4 text-sm`}>
            <span className={cp.title}>Saving</span>
            <p className="m-0 text-mw-muted">Your wallet signs a message to prove it is you. No transaction, no fee. Page fields and Story text are signed separately, only when they changed.</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
