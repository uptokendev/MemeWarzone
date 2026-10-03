import { useRef } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { ExternalLink, ImagePlus } from "lucide-react";
import { CommandCenterCard } from "@/components/command-center/CommandCenterCard";
import { useCommandCenterData } from "@/components/command-center/CommandCenterContext";
import { ProfileBannerEditor } from "@/components/profile/ProfileBannerEditor";
import { UsernameSettingsRow } from "@/components/profile/UsernameSettingsRow";
import { cp } from "@/components/token/coinPageStyles";
import { OperativeMark } from "@/components/ui-v2/OperativeMark";
import { useProfileEditor } from "@/hooks/profile/useProfileEditor";

const input = "mw-focus h-11 w-full rounded-[10px] border border-mw-edge bg-mw-input px-3 text-[15px] text-mw-text placeholder:text-[#5C6670]";
const primary = "mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-5 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50";

/**
 * Edit profile tab (CO-19, founder 2026-10-03): avatar, banner, display name, @username, bio
 * (@mentions link to profiles), website, X and Telegram. One profile per wallet on every chain.
 */
export default function CommandCenterEditProfile() {
  const { walletAddress, chainId } = useCommandCenterData();
  const editor = useProfileEditor(walletAddress, chainId);
  const { draft, setDraft } = editor;
  const avatarRef = useRef<HTMLInputElement | null>(null);

  async function pick(file: File, which: "avatar" | "banner") {
    try {
      await editor.upload(file, which);
      toast.success(which === "avatar" ? "Picture uploaded. Save to apply." : "Banner uploaded. Save to apply.");
    } catch (err: any) {
      toast.error(String(err?.message || "Upload failed"));
    }
  }

  async function save() {
    try {
      await editor.save();
      toast.success("Profile saved");
    } catch (err: any) {
      const msg = String(err?.message || "");
      toast.error(/reject|denied|cancel/i.test(msg) ? "Signature cancelled. Nothing was saved." : msg || "Could not save profile");
    }
  }

  const set = (patch: Partial<typeof draft>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <div className="flex flex-col gap-3.5 font-mw-body text-mw-text" data-command-center-edit-profile="true">
      <h2 className="sr-only">Edit profile</h2>
      <CommandCenterCard title="Edit profile">
        {editor.loading ? <p className="m-0 text-sm text-mw-muted">Loading profile...</p> : null}
        {!editor.loading && !editor.linksSupported ? (
          <p className="m-0 rounded-[10px] border border-[#5A3416] bg-mw-accent-fill px-3 py-2.5 text-sm text-mw-accent-soft">
            This server does not store banner, website, X and Telegram yet. Name, picture and bio save now; the rest after the API update.
          </p>
        ) : null}

        {editor.linksSupported ? (
        <ProfileBannerEditor
          bannerUrl={draft.bannerUrl}
          positionY={draft.bannerPositionY}
          uploading={editor.uploading === "banner"}
          onPick={(file) => void pick(file, "banner")}
          onPosition={(y) => set({ bannerPositionY: y })}
          onRemove={() => set({ bannerUrl: "", bannerPositionY: 50 })}
        />
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <div className="h-20 w-20 shrink-0 overflow-hidden rounded-full border border-mw-border bg-mw-input">
            {draft.avatarUrl ? <img src={draft.avatarUrl} alt="Profile picture" className="h-full w-full object-cover" /> : <OperativeMark fill />}
          </div>
          <button type="button" className={cp.btn} disabled={editor.uploading === "avatar"} onClick={() => avatarRef.current?.click()}>
            <ImagePlus className="h-4 w-4" aria-hidden="true" />
            {editor.uploading === "avatar" ? "Uploading..." : "Change picture"}
          </button>
          <input
            ref={avatarRef}
            type="file"
            accept="image/png,image/jpeg,image/jpg,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void pick(file, "avatar");
              e.currentTarget.value = "";
            }}
          />
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="flex items-baseline justify-between">
            <span className={cp.label}>Display name</span>
            <span className="font-mw-mono text-xs text-mw-muted">{draft.displayName.length}/32</span>
          </span>
          <input className={input} value={draft.displayName} maxLength={32} onChange={(e) => set({ displayName: e.target.value })} placeholder="Your name" />
        </label>

        <UsernameSettingsRow wallet={walletAddress} />

        <label className="flex flex-col gap-1.5">
          <span className="flex items-baseline justify-between">
            <span className={cp.label}>Bio</span>
            <span className="font-mw-mono text-xs text-mw-muted">{draft.bio.length}/280</span>
          </span>
          <textarea
            className={`${input} h-auto min-h-[96px] resize-none py-2.5`}
            value={draft.bio}
            maxLength={280}
            onChange={(e) => set({ bio: e.target.value })}
            placeholder="What you build or trade. Tag collabs with @username."
          />
          <span className="text-xs text-mw-muted">@username in your bio links to that profile.</span>
        </label>

        {editor.linksSupported ? (
        <div className="grid gap-3 md:grid-cols-3">
          <label className="flex flex-col gap-1.5">
            <span className={cp.label}>Website</span>
            <input className={input} value={draft.websiteUrl} onChange={(e) => set({ websiteUrl: e.target.value })} placeholder="yoursite.com" inputMode="url" />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={cp.label}>X</span>
            <input className={input} value={draft.xUrl} onChange={(e) => set({ xUrl: e.target.value })} placeholder="@handle or x.com link" />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={cp.label}>Telegram</span>
            <input className={input} value={draft.telegramUrl} onChange={(e) => set({ telegramUrl: e.target.value })} placeholder="@handle or t.me link" />
          </label>
        </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-mw-border pt-3">
          <Link to={`/profile/${encodeURIComponent(walletAddress)}`} className={cp.btn}>
            View public profile
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
          </Link>
          <div className="flex items-center gap-2">
            {editor.dirty ? (
              <button type="button" className="mw-focus inline-flex min-h-11 items-center px-3 text-[15px] font-semibold text-mw-muted hover:text-mw-text" onClick={() => setDraft(editor.loaded)}>
                Discard
              </button>
            ) : null}
            <button type="button" className={primary} disabled={!editor.dirty || editor.saving || Boolean(editor.uploading)} onClick={() => void save()}>
              {editor.saving ? "Waiting for signature..." : "Save profile"}
            </button>
          </div>
        </div>
        <p className="m-0 text-xs text-mw-muted">Saving asks your wallet to sign a message. No transaction, no fee. The same profile shows on every chain.</p>
      </CommandCenterCard>
    </div>
  );
}
