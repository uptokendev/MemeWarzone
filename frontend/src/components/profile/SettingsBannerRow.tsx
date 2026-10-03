import { toast } from "sonner";
import { ProfileBannerEditor } from "@/components/profile/ProfileBannerEditor";
import { useProfileEditor } from "@/hooks/profile/useProfileEditor";

/** Settings > Profile: banner upload and position (CO-6, founder 2026-10-03). Saves the whole profile (v2). */
export function SettingsBannerRow({ walletAddress, chainId }: { walletAddress: string; chainId?: number }) {
  const editor = useProfileEditor(walletAddress, chainId);
  const changed = editor.draft.bannerUrl !== editor.loaded.bannerUrl || editor.draft.bannerPositionY !== editor.loaded.bannerPositionY;

  async function save() {
    try {
      // Only the banner changes here; every other field is saved as loaded.
      await editor.save({ ...editor.loaded, bannerUrl: editor.draft.bannerUrl, bannerPositionY: editor.draft.bannerPositionY });
      toast.success("Banner saved");
    } catch (err: any) {
      const msg = String(err?.message || "");
      toast.error(/reject|denied|cancel/i.test(msg) ? "Signature cancelled. Nothing was saved." : msg || "Could not save banner");
    }
  }

  if (editor.loading) return null;
  return (
    <div className="flex flex-col gap-2" data-settings-banner="true">
      <ProfileBannerEditor
        bannerUrl={editor.draft.bannerUrl}
        positionY={editor.draft.bannerPositionY}
        uploading={editor.uploading === "banner"}
        onPick={(file) => {
          editor.upload(file, "banner").catch((err) => toast.error(String(err?.message || "Upload failed")));
        }}
        onPosition={(y) => editor.setDraft((d) => ({ ...d, bannerPositionY: y }))}
        onRemove={() => editor.setDraft((d) => ({ ...d, bannerUrl: "", bannerPositionY: 50 }))}
      />
      {changed ? (
        <div className="flex justify-end">
          <button
            type="button"
            disabled={editor.saving || Boolean(editor.uploading)}
            onClick={() => void save()}
            className="mw-focus inline-flex min-h-11 items-center justify-center rounded-[10px] border border-mw-accent bg-mw-accent px-5 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50"
          >
            {editor.saving ? "Waiting for signature..." : "Save banner"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
