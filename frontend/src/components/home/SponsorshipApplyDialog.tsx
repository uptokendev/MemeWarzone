/**
 * Compact sponsorship intake popup with creative upload.
 */
import { useEffect, useRef, useState } from "react";
import { ImagePlus, Megaphone } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/apiBase";
import {
  FEATURED_SPONSOR_CREATIVE_H,
  FEATURED_SPONSOR_CREATIVE_W,
  FEATURED_SPONSOR_DIMENSIONS_COPY,
  fetchSponsorshipPackages,
  formatPackagePrice,
  uploadSponsorCreative,
  type SponsorshipPackage,
} from "@/lib/sponsorCreative";

const FEATURED_SLOT = "featured-top-left";

export function SponsorshipApplyDialog({
  open,
  onOpenChange,
  defaultSlot = FEATURED_SLOT,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultSlot?: string;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [packages, setPackages] = useState<SponsorshipPackage[]>([]);
  const [packageCode, setPackageCode] = useState("");
  const [form, setForm] = useState({
    projectName: "",
    contactName: "",
    contactChannel: "",
    websiteUrl: "",
    imageUrl: "",
    bio: "",
  });

  useEffect(() => {
    if (!open) return;
    void fetchSponsorshipPackages().then((items) => {
      setPackages(items);
      if (items.length && !packageCode) setPackageCode(items[0].code);
    });
  }, [open]);

  const update = (key: keyof typeof form, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const handleFile = async (file: File | null | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const url = await uploadSponsorCreative(file);
      update("imageUrl", url);
      toast.success("Creative uploaded.");
    } catch (error: any) {
      toast.error(error?.message || "Image upload failed.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const handleSubmit = async () => {
    if (!form.projectName.trim() || !form.contactName.trim() || !form.contactChannel.trim() || !form.websiteUrl.trim() || !form.bio.trim()) {
      toast.error("Add project name, contact, website, and bio.");
      return;
    }
    if (!form.imageUrl.trim()) {
      toast.error("Upload a Featured creative image.");
      return;
    }
    if (!packageCode) {
      toast.error("Select a sponsorship package.");
      return;
    }
    setSubmitting(true);
    try {
      const response = await apiFetch("/api/sponsorship-applications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectName: form.projectName.trim(),
          contactName: form.contactName.trim(),
          contactChannel: form.contactChannel.trim(),
          websiteUrl: form.websiteUrl.trim(),
          imageUrl: form.imageUrl.trim(),
          bio: form.bio.trim(),
          preferredSlot: defaultSlot,
          packageCode,
          status: "submitted",
        }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) throw new Error(String(json?.error || `HTTP ${response.status}`));
      toast.success("Application submitted — no payment yet. We review first, then send payment details.");
      setForm({
        projectName: "",
        contactName: "",
        contactChannel: "",
        websiteUrl: "",
        imageUrl: "",
        bio: "",
      });
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error?.message || "Sponsorship intake is unavailable right now.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-lg overflow-y-auto rounded-[18px] border border-mw-edge bg-mw-surface font-mw-body text-mw-text p-5 [&>button]:right-2 [&>button]:top-2 [&>button]:flex [&>button]:h-11 [&>button]:w-11 [&>button]:items-center [&>button]:justify-center [&>button]:text-mw-muted [&>button]:opacity-100 [&>button:hover]:text-mw-text">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-10 text-left font-mw-cond text-2xl font-bold text-mw-text">
            <Megaphone className="h-5 w-5 shrink-0 text-mw-accent-soft" />
            Advertise in Featured
          </DialogTitle>
          <DialogDescription className="text-left text-sm text-mw-muted">
            No payment upfront. Choose a package, submit for review — only after we approve do you pay to go live.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <label className="space-y-1.5">
            <span className="block font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">Package</span>
            <select
              className="mw-focus flex h-11 w-full rounded-[10px] border border-mw-edge bg-mw-input px-3 text-base text-mw-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mw-accent disabled:opacity-60"
              value={packageCode}
              onChange={(e) => setPackageCode(e.target.value)}
              disabled={!packages.length || submitting}
            >
              {!packages.length ? <option value="">Loading packages…</option> : null}
              {packages.map((pkg) => (
                <option key={pkg.code} value={pkg.code}>
                  {pkg.label} — {formatPackagePrice(pkg)}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="block font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">Project name</span>
            <Input value={form.projectName} onChange={(e) => update("projectName", e.target.value)} placeholder="Project or token name" className="h-11 rounded-[10px] border border-mw-edge bg-mw-input px-3 text-base text-mw-text placeholder:text-[#4B535C] focus-visible:ring-2 focus-visible:ring-mw-accent focus-visible:ring-offset-0" />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5">
              <span className="block font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">Contact name</span>
              <Input value={form.contactName} onChange={(e) => update("contactName", e.target.value)} placeholder="Your name" className="h-11 rounded-[10px] border border-mw-edge bg-mw-input px-3 text-base text-mw-text placeholder:text-[#4B535C] focus-visible:ring-2 focus-visible:ring-mw-accent focus-visible:ring-offset-0" />
            </label>
            <label className="space-y-1.5">
              <span className="block font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">Email or Telegram</span>
              <Input value={form.contactChannel} onChange={(e) => update("contactChannel", e.target.value)} placeholder="@handle or email" className="h-11 rounded-[10px] border border-mw-edge bg-mw-input px-3 text-base text-mw-text placeholder:text-[#4B535C] focus-visible:ring-2 focus-visible:ring-mw-accent focus-visible:ring-offset-0" />
            </label>
          </div>
          <label className="space-y-1.5">
            <span className="block font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">Website</span>
            <Input value={form.websiteUrl} onChange={(e) => update("websiteUrl", e.target.value)} placeholder="https://" className="h-11 rounded-[10px] border border-mw-edge bg-mw-input px-3 text-base text-mw-text placeholder:text-[#4B535C] focus-visible:ring-2 focus-visible:ring-mw-accent focus-visible:ring-offset-0" />
          </label>

          <div className="space-y-2 rounded-[14px] border border-mw-border bg-mw-input p-3.5">
            <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">Featured creative</div>
            <p className="text-sm leading-relaxed text-mw-muted">{FEATURED_SPONSOR_DIMENSIONS_COPY}</p>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/jpg,image/webp"
              className="hidden"
              onChange={(e) => void handleFile(e.target.files?.[0])}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={uploading || submitting}
                className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-[15px] font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text disabled:opacity-60"
                onClick={() => fileRef.current?.click()}
              >
                <ImagePlus className="h-4 w-4" />
                {uploading ? "Uploading…" : form.imageUrl ? "Replace image" : "Upload image"}
              </Button>
              <span className="text-xs text-mw-muted">
                {FEATURED_SPONSOR_CREATIVE_W}×{FEATURED_SPONSOR_CREATIVE_H}px recommended
              </span>
            </div>
            {form.imageUrl ? (
              <div className="overflow-hidden rounded-[10px] border border-mw-border bg-mw-surface">
                <img src={form.imageUrl} alt="Creative preview" className="h-[75px] w-full object-cover" />
              </div>
            ) : null}
          </div>

          <label className="space-y-1.5">
            <span className="block font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">Short bio</span>
            <Textarea value={form.bio} onChange={(e) => update("bio", e.target.value)} className="min-h-20 rounded-[10px] border border-mw-edge bg-mw-input px-3 py-2.5 text-base text-mw-text placeholder:text-[#4B535C] focus-visible:ring-2 focus-visible:ring-mw-accent focus-visible:ring-offset-0" placeholder="What should Featured visitors know?" />
          </label>
          <Button type="button" className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50" disabled={submitting || uploading} onClick={() => void handleSubmit()}>
            {submitting ? "Submitting…" : "Submit application"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default SponsorshipApplyDialog;
