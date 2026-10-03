import { useRef } from "react";
import { ImagePlus } from "lucide-react";
import { cp } from "@/components/token/coinPageStyles";

/**
 * Profile banner: upload and move the image up or down (CO-19 / CO-6). Position is vertical focus in
 * percent (object-position), the same rule as the coin banner.
 */
export function ProfileBannerEditor({
  bannerUrl,
  positionY,
  uploading,
  onPick,
  onPosition,
  onRemove,
}: {
  bannerUrl: string;
  positionY: number;
  uploading: boolean;
  onPick: (file: File) => void;
  onPosition: (y: number) => void;
  onRemove: () => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  return (
    <div className="flex flex-col gap-2" data-profile-banner-editor="true">
      <span className={cp.label}>Banner</span>
      <div className="relative h-[120px] w-full overflow-hidden rounded-[14px] border border-mw-border bg-mw-input md:h-[160px]">
        {bannerUrl ? (
          <img src={bannerUrl} alt="Profile banner" className="h-full w-full object-cover" style={{ objectPosition: `50% ${positionY}%` }} />
        ) : (
          <div className="mw-banner h-full w-full" aria-hidden="true" />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={cp.btn} disabled={uploading} onClick={() => fileRef.current?.click()}>
          <ImagePlus className="h-4 w-4" aria-hidden="true" />
          {uploading ? "Uploading..." : bannerUrl ? "Replace banner" : "Upload banner"}
        </button>
        {bannerUrl ? (
          <button type="button" className="mw-focus inline-flex min-h-11 items-center px-3 text-[15px] font-semibold text-mw-muted hover:text-mw-text" onClick={onRemove}>
            Remove
          </button>
        ) : null}
        <span className="text-xs text-mw-muted">PNG, JPG or WebP, max 5 MB. Wide images work best (about 1500 × 400).</span>
      </div>
      {bannerUrl ? (
        <label className="flex items-center gap-3 text-sm text-mw-muted">
          <span className="shrink-0">Move image</span>
          <input
            type="range"
            min={0}
            max={100}
            value={positionY}
            onChange={(e) => onPosition(Number(e.target.value))}
            className="w-full accent-[#FF7A1A]"
            aria-label="Banner vertical position"
          />
        </label>
      ) : null}
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/jpg,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onPick(file);
          e.currentTarget.value = "";
        }}
      />
    </div>
  );
}
