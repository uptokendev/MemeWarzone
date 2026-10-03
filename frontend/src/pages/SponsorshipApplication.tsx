import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CalendarClock, CreditCard, Globe, Image as ImageIcon, ImagePlus, Mail, Megaphone, Wallet } from "lucide-react";
import { toast } from "sonner";

import { cp } from "@/components/token/coinPageStyles";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/apiBase";
import { analytics, analyticsErrorCode } from "@/lib/analytics/ProductAnalytics";
import {
  FEATURED_SPONSOR_CREATIVE_H,
  FEATURED_SPONSOR_CREATIVE_W,
  FEATURED_SPONSOR_DIMENSIONS_COPY,
  fetchSponsorshipPackages,
  formatPackagePrice,
  uploadSponsorCreative,
  type SponsorshipPackage,
} from "@/lib/sponsorCreative";

const STORAGE_KEY = "mwz:sponsorship-application-draft";

type SponsorshipApplicationForm = {
  projectName: string;
  contactName: string;
  contactChannel: string;
  applicantWallet: string;
  websiteUrl: string;
  imageUrl: string;
  bio: string;
  preferredSlot: string;
  packageCode: string;
  preferredStart: string;
  preferredEnd: string;
  paymentReference: string;
  notes: string;
};

const defaultForm: SponsorshipApplicationForm = {
  projectName: "",
  contactName: "",
  contactChannel: "",
  applicantWallet: "",
  websiteUrl: "",
  imageUrl: "",
  bio: "",
  preferredSlot: "featured-top-left",
  packageCode: "",
  preferredStart: "",
  preferredEnd: "",
  paymentReference: "",
  notes: "",
};

// Founder 2026-10-03: only the slots the site actually shows. Featured lives on the Coins page (it
// was labelled "Homepage" before Home became the feed); the Home top row is the new ad row (CO-21).
// The old rail / priority / category-boost codes are not rendered anywhere, so they are not offered.
const slotOptions = [
  {
    value: "featured-top-left",
    label: "Featured (Coins page)",
    detail: "Large card in the Featured row on Coins, with a Sponsored label. Rotates when several sponsors share the slot.",
  },
  {
    value: "home-top-row",
    label: "Home top row (6 spots)",
    detail: "Wide banner tile in the row at the top of Home. Up to 6 sponsors at once; it scrolls when they do not all fit.",
  },
];

function inputClass() {
  return "h-11 rounded-[10px] border border-mw-edge bg-mw-input px-3 text-[15px] text-mw-text placeholder:text-[#5C6670] focus-visible:ring-mw-accent md:text-[15px]";
}

const TEXTAREA_CLASS =
  "rounded-[10px] border border-mw-edge bg-mw-input px-3 py-2 text-[15px] text-mw-text placeholder:text-[#5C6670] focus-visible:ring-mw-accent md:text-[15px]";
const FIELD_LABEL = "font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted";
const PRIMARY_BTN =
  "mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50";

function loadDraft(): SponsorshipApplicationForm {
  if (typeof window === "undefined") return defaultForm;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultForm;
    const parsed = JSON.parse(raw);
    return { ...defaultForm, ...parsed };
  } catch {
    return defaultForm;
  }
}

const SponsorshipApplication = () => {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [searchParams] = useSearchParams();
  // ?slot=home-top-row (from the Home ad row) preselects that slot.
  const [form, setForm] = useState<SponsorshipApplicationForm>(() => {
    const slot = searchParams.get("slot");
    return slotOptions.some((option) => option.value === slot) ? { ...defaultForm, preferredSlot: String(slot) } : defaultForm;
  });
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [packages, setPackages] = useState<SponsorshipPackage[]>([]);

  useEffect(() => {
    // A saved draft must not undo ?slot= from the Home ad row's "Your ad here" link.
    const slot = searchParams.get("slot");
    const draft = loadDraft();
    setForm(slotOptions.some((option) => option.value === slot) ? { ...draft, preferredSlot: String(slot) } : draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Each slot has its own price list (CO-21); keep the chosen package only if it belongs to the slot.
  useEffect(() => {
    let cancelled = false;
    void fetchSponsorshipPackages(form.preferredSlot).then((items) => {
      if (cancelled) return;
      setPackages(items);
      setForm((current) => ({
        ...current,
        packageCode: items.some((item) => item.code === current.packageCode) ? current.packageCode : items[0]?.code || "",
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [form.preferredSlot]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(form));
  }, [form]);

  const slotDetail = useMemo(
    () => slotOptions.find((option) => option.value === form.preferredSlot)?.detail ?? "",
    [form.preferredSlot],
  );

  const update = (key: keyof SponsorshipApplicationForm, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const resetDraft = () => {
    setForm(defaultForm);
    if (typeof window !== "undefined") window.localStorage.removeItem(STORAGE_KEY);
    toast.success("Sponsorship draft cleared.");
  };

  const handleImageUpload = async (file: File | null | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const url = await uploadSponsorCreative(file);
      update("imageUrl", url);
      toast.success("Creative uploaded.");
    } catch {
      toast.error("We couldn’t upload the image. Please try again.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const handleSubmit = async () => {
    if (!form.projectName.trim() || !form.contactName.trim() || !form.contactChannel.trim() || !form.websiteUrl.trim() || !form.bio.trim()) {
      toast.error("Add the project, contact, website, and bio before submitting.");
      return;
    }
    if (!form.imageUrl.trim()) {
      toast.error("Upload a Featured creative image before submitting.");
      return;
    }
    if (!form.packageCode.trim()) {
      toast.error("Select a sponsorship package. No payment is due until we approve.");
      return;
    }

    setSubmitting(true);
    analytics.track("sponsorship_apply_started");
    try {
      const response = await apiFetch("/api/sponsorship-applications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectName: form.projectName.trim(),
          contactName: form.contactName.trim(),
          contactChannel: form.contactChannel.trim(),
          applicantWallet: form.applicantWallet.trim(),
          websiteUrl: form.websiteUrl.trim(),
          imageUrl: form.imageUrl.trim(),
          bio: form.bio.trim(),
          preferredSlot: form.preferredSlot,
          packageCode: form.packageCode,
          preferredStart: form.preferredStart || null,
          preferredEnd: form.preferredEnd || null,
          paymentReference: form.paymentReference.trim(),
          notes: form.notes.trim(),
          status: "submitted",
        }),
      });

      const json = await response.json().catch(() => null);
      if (!response.ok) throw new Error(String(json?.error || `HTTP ${response.status}`));

      if (typeof window !== "undefined") window.localStorage.removeItem(STORAGE_KEY);
      setForm({ ...defaultForm, packageCode: packages[0]?.code || "" });
      analytics.track("sponsorship_apply_submitted");
      toast.success("Application submitted — no payment yet. We review first, then send payment details.");
    } catch (error) {
      analytics.track("sponsorship_apply_failed", { error_code: analyticsErrorCode(error) });
      toast.error("We couldn’t submit your sponsorship application right now. Please try again.");
      toast.message("Your application draft is still saved locally in this browser.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-[1480px] space-y-4 px-1 pb-10 font-mw-body text-mw-text md:px-2">
      <section className="pt-2">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">Sponsored placements</div>
            <h1 className="m-0 mt-1 font-mw-cond text-[32px] font-bold leading-none lg:text-[40px]">Apply for a MemeWarzone sponsorship slot.</h1>
            <p className="mt-2 max-w-2xl text-[15px] text-mw-muted">Tell us about your project, preferred placement and campaign dates. We’ll review your application and contact you with availability and payment details.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link to="/warzone" className={cp.btn}>Back to Warzone</Link>
          </div>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <div className={`${cp.card} p-4`}>
          <div className="mb-4 flex items-center gap-3">
            <Megaphone className="h-5 w-5 shrink-0 text-mw-accent-soft" aria-hidden="true" />
            <div>
              <h2 className={cp.title}>Sponsorship application</h2>
              <div className="text-[13px] text-mw-muted">Public sponsorship request</div>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-2 md:col-span-2">
              <span className={`block ${FIELD_LABEL}`}>Project name</span>
              <Input value={form.projectName} onChange={(event) => update("projectName", event.target.value)} className={inputClass()} placeholder="Project or campaign name" />
            </label>
            <label className="space-y-2">
              <span className={`block ${FIELD_LABEL}`}>Contact name</span>
              <Input value={form.contactName} onChange={(event) => update("contactName", event.target.value)} className={inputClass()} placeholder="Primary contact" />
            </label>
            <label className="space-y-2">
              <span className={`block ${FIELD_LABEL}`}>Contact email or Telegram</span>
              <Input value={form.contactChannel} onChange={(event) => update("contactChannel", event.target.value)} className={inputClass()} placeholder="name@project.com or @handle" />
            </label>
            <label className="space-y-2">
              <span className={`block ${FIELD_LABEL}`}>Website URL</span>
              <Input value={form.websiteUrl} onChange={(event) => update("websiteUrl", event.target.value)} className={inputClass()} placeholder="https://project.xyz" />
            </label>
            <div className="space-y-2 rounded-[10px] border border-[#7A3A0C] bg-[#2A1609] p-3 font-mw-body md:col-span-2">
              <span className="block font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-accent-soft">Featured creative upload</span>
              <p className="text-[13px] leading-relaxed text-[#E8D5C4]">{FEATURED_SPONSOR_DIMENSIONS_COPY}</p>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/jpg,image/webp"
                className="hidden"
                onChange={(e) => void handleImageUpload(e.target.files?.[0])}
              />
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className={cp.btn} disabled={uploading || submitting} onClick={() => fileRef.current?.click()}>
                  <ImagePlus className="h-4 w-4" />
                  {uploading ? "Uploading…" : form.imageUrl ? "Replace image" : "Upload image"}
                </button>
                <span className="font-mw-mono text-xs text-mw-muted">
                  {FEATURED_SPONSOR_CREATIVE_W}×{FEATURED_SPONSOR_CREATIVE_H}px (2× display {392}×{150})
                </span>
              </div>
              {form.imageUrl ? (
                <div className="mt-2 overflow-hidden rounded-[10px] border border-mw-border bg-black">
                  <img src={form.imageUrl} alt="Creative preview" className="h-[75px] w-full object-cover" />
                </div>
              ) : null}
            </div>
            <label className="space-y-2 md:col-span-2">
              <span className={`block ${FIELD_LABEL}`}>Short bio</span>
              <Textarea value={form.bio} onChange={(event) => update("bio", event.target.value)} className={`min-h-28 ${TEXTAREA_CLASS}`} placeholder="Short public-facing sponsor copy for the placement." />
            </label>
            <label className="space-y-2">
              <span className={`block ${FIELD_LABEL}`}>Preferred slot</span>
              <select value={form.preferredSlot} onChange={(event) => update("preferredSlot", event.target.value)} className="mw-focus h-11 w-full rounded-[10px] border border-mw-edge bg-mw-input px-3 text-[15px] text-mw-text">
                {slotOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <div className="space-y-2 md:col-span-2">
              <span className={`block ${FIELD_LABEL}`}>Package (no payment until approved)</span>
              <div className="grid gap-2 sm:grid-cols-2">
                {packages.map((pkg) => {
                  const selected = form.packageCode === pkg.code;
                  return (
                    <button
                      key={pkg.code}
                      type="button"
                      onClick={() => update("packageCode", pkg.code)}
                      aria-pressed={selected}
                      className={`mw-focus flex min-h-11 items-center justify-between gap-2 rounded-[10px] border px-3 py-2.5 text-left text-[15px] ${
                        selected ? "border-mw-accent bg-[#2A1609]" : "border-mw-edge bg-mw-input hover:border-[#3A424C]"
                      }`}
                    >
                      <span className="font-semibold text-mw-text">{pkg.label}</span>
                      <span className="font-mw-mono text-sm font-bold text-mw-accent-soft">{formatPackagePrice(pkg)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <label className="space-y-2">
              <span className={`block ${FIELD_LABEL}`}>Payment reference (if provided)</span>
              <Input value={form.paymentReference} onChange={(event) => update("paymentReference", event.target.value)} className={inputClass()} placeholder="Leave blank unless the MemeWarzone team has given you a payment reference." />
            </label>
            <label className="space-y-2">
              <span className={`block ${FIELD_LABEL}`}>Preferred start</span>
              <Input type="date" value={form.preferredStart} onChange={(event) => update("preferredStart", event.target.value)} className={inputClass()} />
            </label>
            <label className="space-y-2">
              <span className={`block ${FIELD_LABEL}`}>Preferred end</span>
              <Input type="date" value={form.preferredEnd} onChange={(event) => update("preferredEnd", event.target.value)} className={inputClass()} />
            </label>
            <label className="space-y-2 md:col-span-2">
              <span className={`block ${FIELD_LABEL}`}>Applicant wallet (optional)</span>
              <Input value={form.applicantWallet} onChange={(event) => update("applicantWallet", event.target.value)} className={inputClass()} placeholder="0x... or Solana wallet address" />
            </label>
            <label className="space-y-2 md:col-span-2">
              <span className={`block ${FIELD_LABEL}`}>Additional notes</span>
              <Textarea value={form.notes} onChange={(event) => update("notes", event.target.value)} className={`min-h-24 ${TEXTAREA_CLASS}`} placeholder="Share any timing preferences, placement requests or additional information for our review team." />
            </label>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            <button type="button" onClick={handleSubmit} disabled={submitting || uploading} className={PRIMARY_BTN}>
              {submitting ? "Submitting..." : "Submit application"}
            </button>
            <button type="button" onClick={resetDraft} className={cp.btn}>
              Clear draft
            </button>
          </div>
        </div>

        <div className="space-y-4">
          <section className={`${cp.card} p-4`}>
            <h2 className={`mb-3 ${cp.title}`}>Placement preview</h2>
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className={cp.chipAccent}>{slotOptions.find((option) => option.value === form.preferredSlot)?.label ?? "Slot"}</span>
                {form.preferredStart ? <span className={`${cp.chip} font-mw-mono`}>{form.preferredStart}{form.preferredEnd ? ` - ${form.preferredEnd}` : ""}</span> : null}
              </div>
              <div className="flex items-start gap-4">
                <div className="grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-[10px] border border-mw-border bg-mw-input text-mw-accent-soft">
                  {form.imageUrl ? <img src={form.imageUrl} alt={form.projectName || "Sponsor preview"} className="h-full w-full object-cover" /> : <ImageIcon className="h-6 w-6" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="break-words font-mw-cond text-lg font-bold text-mw-text">{form.projectName || "Project name"}</div>
                  <div className="mt-1 break-words text-[15px] leading-6 text-mw-muted">{form.bio || "Short sponsor bio will appear here."}</div>
                </div>
              </div>
            </div>
          </section>

          <section className={`${cp.card} p-4`}>
            <h2 className={`mb-3 ${cp.title}`}>Review checklist</h2>
            <div className="space-y-3 text-[15px] text-mw-muted">
              <div className="flex items-start gap-3"><Globe className="mt-0.5 h-4 w-4 shrink-0 text-mw-accent-soft" />Website, image, and short bio are required for your sponsored placement.</div>
              <div className="flex items-start gap-3"><CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-mw-accent-soft" />Preferred dates help scheduling, but final dates will be confirmed during review.</div>
              <div className="flex items-start gap-3"><Wallet className="mt-0.5 h-4 w-4 shrink-0 text-mw-accent-soft" />Add an applicant wallet if it helps us verify the project or payment later.</div>
              <div className="flex items-start gap-3"><CreditCard className="mt-0.5 h-4 w-4 shrink-0 text-mw-accent-soft" />No payment is due until your sponsorship application is approved.</div>
              <div className="flex items-start gap-3"><Mail className="mt-0.5 h-4 w-4 shrink-0 text-mw-accent-soft" />Use a contact channel where we can quickly reach you about approval, edits or scheduling.</div>
            </div>
            <div className="mt-4 border-t border-mw-border pt-3 text-[13px] text-mw-muted"><span className={FIELD_LABEL}>Selected slot:</span> {slotDetail}</div>
          </section>
        </div>
      </section>
    </div>
  );
};

export default SponsorshipApplication;
