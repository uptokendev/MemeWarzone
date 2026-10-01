import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

export type EditProfileValues = {
  username: string;
  bio: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialUsername?: string | null;
  initialBio?: string | null;
  avatarUrl?: string | null;
  bannerUrl?: string | null;
  saving?: boolean;
  savingAvatar?: boolean;
  savingBanner?: boolean;
  onPickAvatar?: () => void;
  onPickBanner?: () => void;
  onSave: (values: EditProfileValues) => Promise<void> | void;
};

function normalizeUsername(raw: string): string {
  return raw.trim();
}

function validateUsername(username: string): string | null {
  // Optional: empty clears the username.
  if (!username) return null;
  if (username.length < 3) return "Username must be at least 3 characters.";
  if (username.length > 20) return "Username must be at most 20 characters.";
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return "Only letters, numbers, and underscores are allowed.";
  return null;
}

export function EditProfileDialog({
  open,
  onOpenChange,
  initialUsername,
  initialBio,
  avatarUrl,
  bannerUrl,
  saving,
  savingAvatar,
  savingBanner,
  onPickAvatar,
  onPickBanner,
  onSave,
}: Props) {
  const [username, setUsername] = useState(initialUsername ?? "");
  const [bio, setBio] = useState(initialBio ?? "");
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setUsername(initialUsername ?? "");
    setBio(initialBio ?? "");
    setTouched(false);
  }, [open, initialUsername, initialBio]);

  const usernameError = useMemo(() => {
    if (!touched) return null;
    return validateUsername(normalizeUsername(username));
  }, [username, touched]);

  const canSave = useMemo(() => {
    return !saving && !validateUsername(normalizeUsername(username));
  }, [saving, username]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-retro">Edit profile</DialogTitle>
          <DialogDescription className="font-retro text-muted-foreground">
            Set or update your public username and bio for your MemeWarzone profile.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {onPickBanner || onPickAvatar ? (
            <div className="space-y-2">
              <Label className="font-retro">Cover and photo</Label>
              <button
                type="button"
                onClick={onPickBanner}
                disabled={!!saving || !!savingBanner || !onPickBanner}
                className="relative h-24 w-full overflow-hidden bg-background/40"
                style={
                  bannerUrl
                    ? undefined
                    : {
                        background:
                          "radial-gradient(120% 80% at 70% 20%, hsl(var(--accent) / 0.35), transparent 55%), linear-gradient(180deg, #1a1208 0%, #050505 100%)",
                      }
                }
              >
                {bannerUrl ? <img src={bannerUrl} alt="" className="h-full w-full object-cover" /> : null}
                <span className="absolute bottom-2 right-2 rounded-full bg-black/70 px-2 py-0.5 font-retro text-[10px] uppercase tracking-[0.14em] text-accent">
                  {savingBanner ? "Uploading…" : "Change cover"}
                </span>
              </button>
              <div className="flex items-end gap-3">
                <button
                  type="button"
                  onClick={onPickAvatar}
                  disabled={!!saving || !!savingAvatar || !onPickAvatar}
                  className="h-16 w-16 shrink-0 overflow-hidden rounded-none bg-background/50"
                >
                  {avatarUrl ? (
                    <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center font-retro text-xs text-muted-foreground">
                      Photo
                    </span>
                  )}
                </button>
                <div className="text-xs text-muted-foreground">
                  {savingAvatar ? "Uploading photo…" : "Square photo."}
                </div>
              </div>
            </div>
          ) : null}

          <div className="space-y-2">
            <Label className="font-retro" htmlFor="username">
              Username (optional)
            </Label>
            <Input
              id="username"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                setTouched(true);
              }}
              placeholder="e.g. patrick_k"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="font-retro"
              disabled={!!saving}
            />
            <div className="text-xs font-retro text-muted-foreground">
              Leave blank to remove. If set: 3–20 chars, letters/numbers/underscore.
            </div>
            {usernameError && <div className="text-xs font-retro text-destructive">{usernameError}</div>}
          </div>

          <div className="space-y-2">
            <Label className="font-retro" htmlFor="bio">
              Bio
            </Label>
            <Textarea
              id="bio"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="Add a short bio…"
              className="font-retro min-h-[96px]"
              maxLength={160}
              disabled={!!saving}
            />
            <div className="text-xs font-retro text-muted-foreground">{bio.length}/160</div>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={!!saving}
            className="font-retro"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => onSave({ username: normalizeUsername(username), bio: bio.trim() })}
            disabled={!canSave}
            className="font-retro"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
