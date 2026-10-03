/**
 * Featured sponsorship creative specs + upload helper.
 * Display card (lg): 392×150 — deliver 2× for sharp retina: 784×300.
 */
import { apiFetch } from "@/lib/apiBase";

// Redesign Featured card (SponsoredFeaturedSlotCard): 300×244, image full-bleed (object-cover).
export const FEATURED_SPONSOR_CARD_CSS_W = 300;
export const FEATURED_SPONSOR_CARD_CSS_H = 244;
export const FEATURED_SPONSOR_CREATIVE_W = 600;
export const FEATURED_SPONSOR_CREATIVE_H = 488;
export const FEATURED_SPONSOR_MAX_BYTES = 5 * 1024 * 1024;

export const FEATURED_SPONSOR_DIMENSIONS_COPY =
  `Featured card displays at ${FEATURED_SPONSOR_CARD_CSS_W}×${FEATURED_SPONSOR_CARD_CSS_H}px. ` +
  `Upload a PNG, JPG, or WebP at ${FEATURED_SPONSOR_CREATIVE_W}×${FEATURED_SPONSOR_CREATIVE_H}px (2×) for a sharp full-bleed image. ` +
  `Keep the subject in the middle: search shows a wider crop. Max ${FEATURED_SPONSOR_MAX_BYTES / (1024 * 1024)} MB.`;

/** Image size per sponsorship slot, shown wherever an applicant or admin picks a creative (CO-21). */
export type SponsorCreativeSpec = { label: string; displayW: number; displayH: number; uploadW: number; uploadH: number; copy: string };

const HOME_TOP_ROW_SPEC: SponsorCreativeSpec = {
  label: "Home top row banner",
  displayW: 240,
  displayH: 90,
  uploadW: 480,
  uploadH: 180,
  copy:
    "Home top row banner displays at 240×90px. Upload a PNG, JPG, or WebP at 480×180px (8:3, 2×) for a sharp image. " +
    `Max ${FEATURED_SPONSOR_MAX_BYTES / (1024 * 1024)} MB.`,
};

const FEATURED_SPEC: SponsorCreativeSpec = {
  label: "Featured creative",
  displayW: FEATURED_SPONSOR_CARD_CSS_W,
  displayH: FEATURED_SPONSOR_CARD_CSS_H,
  uploadW: FEATURED_SPONSOR_CREATIVE_W,
  uploadH: FEATURED_SPONSOR_CREATIVE_H,
  copy: FEATURED_SPONSOR_DIMENSIONS_COPY,
};

export function sponsorCreativeSpec(slot?: string | null): SponsorCreativeSpec {
  return String(slot || "").trim().toLowerCase() === "home-top-row" ? HOME_TOP_ROW_SPEC : FEATURED_SPEC;
}

export type SponsorshipPackage = {
  id?: string;
  code: string;
  label: string;
  durationDays: number;
  priceUsd: number;
  currency?: string;
};

/** Packages for one slot (CO-21: home-top-row has its own prices); no slot = the every-slot list. */
export async function fetchSponsorshipPackages(slot?: string | null): Promise<SponsorshipPackage[]> {
  try {
    const query = slot ? `?slot=${encodeURIComponent(slot)}` : "";
    const res = await apiFetch(`/api/sponsorship-packages${query}`, { cache: "no-store" });
    const json = await res.json().catch(() => ({}));
    const items = Array.isArray(json?.items) ? json.items : [];
    return items.map((item: any) => ({
      id: item.id,
      code: String(item.code || ""),
      label: String(item.label || item.code || "Package"),
      durationDays: Number(item.durationDays ?? item.duration_days ?? 0),
      priceUsd: Number(item.priceUsd ?? item.price_usd ?? 0),
      currency: String(item.currency || "USD"),
    })).filter((p: SponsorshipPackage) => p.code && p.durationDays > 0);
  } catch {
    return [];
  }
}

export function formatPackagePrice(pkg: SponsorshipPackage) {
  const n = Number(pkg.priceUsd);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: pkg.currency || "USD", maximumFractionDigits: 0 }).format(n);
}

export async function uploadSponsorCreative(file: File): Promise<string> {
  if (!file) throw new Error("Choose an image file.");
  if (file.size > FEATURED_SPONSOR_MAX_BYTES) {
    throw new Error("Image is too large. Max size is 5 MB.");
  }
  if (!/^(image\/png|image\/jpeg|image\/jpg|image\/webp)$/i.test(file.type)) {
    throw new Error("Use PNG, JPG, or WebP.");
  }

  const fd = new FormData();
  fd.append("file", file);
  const qs = new URLSearchParams({ kind: "sponsor", chainId: "97" });
  const res = await apiFetch(`/api/upload?${qs.toString()}`, { method: "POST", body: fd });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(json?.error || json?.message || `Upload failed (${res.status})`));
  const url = String(json?.url || "").trim();
  if (!url) throw new Error("Upload succeeded but no image URL was returned.");
  return url;
}
