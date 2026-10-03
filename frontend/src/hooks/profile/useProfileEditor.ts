import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@/contexts/WalletContext";
import { fetchUserProfile, normalizeProfileLinks, saveUserProfileV2, type UserProfile } from "@/lib/profileApi";
import { uploadProfileImage } from "@/lib/profileUpload";
import { signSolanaMessage } from "@/lib/solanaWallet";

export type ProfileDraft = {
  displayName: string;
  bio: string;
  avatarUrl: string;
  bannerUrl: string;
  bannerPositionY: number;
  websiteUrl: string;
  xUrl: string;
  telegramUrl: string;
};

const EMPTY: ProfileDraft = { displayName: "", bio: "", avatarUrl: "", bannerUrl: "", bannerPositionY: 50, websiteUrl: "", xUrl: "", telegramUrl: "" };

function isSolanaChain(chainId?: number | null) {
  const id = Number(chainId);
  return id === 101 || id === 102;
}

function toDraft(p: UserProfile | null): ProfileDraft {
  if (!p) return EMPTY;
  return {
    displayName: p.displayName || "",
    bio: p.bio || "",
    avatarUrl: p.avatarUrl || "",
    bannerUrl: p.bannerUrl || "",
    bannerPositionY: p.bannerPositionY == null ? 50 : p.bannerPositionY,
    websiteUrl: p.websiteUrl || "",
    xUrl: p.xUrl || "",
    telegramUrl: p.telegramUrl || "",
  };
}

/**
 * Edit profile (CO-19) and the Settings banner row (CO-6): load the wallet's one profile, edit a draft,
 * upload images and save with the signed version 2 message.
 */
export function useProfileEditor(walletAddress: string | null | undefined, chainId: number | null | undefined) {
  const wallet = useWallet() as any;
  const [loaded, setLoaded] = useState<ProfileDraft>(EMPTY);
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<null | "avatar" | "banner">(null);

  const reload = useCallback(async () => {
    if (!walletAddress || !chainId) return;
    setLoading(true);
    try {
      const p = await fetchUserProfile(Number(chainId), walletAddress);
      const d = toDraft(p);
      setLoaded(d);
      setDraft(d);
    } finally {
      setLoading(false);
    }
  }, [walletAddress, chainId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const sign = useCallback(
    async (message: string) => {
      if (isSolanaChain(chainId)) return (await signSolanaMessage(message, String(walletAddress))).signature;
      if (!wallet?.signer) throw new Error("Wallet signer is not available. Reconnect your wallet and try again.");
      return wallet.signer.signMessage(message);
    },
    [chainId, walletAddress, wallet?.signer],
  );

  const upload = useCallback(
    async (file: File, which: "avatar" | "banner") => {
      if (!walletAddress || !chainId) throw new Error("Connect your wallet first.");
      setUploading(which);
      try {
        const url = await uploadProfileImage(file, which === "avatar" ? "avatar" : "profile_banner", {
          chainId: Number(chainId),
          address: walletAddress,
          signer: wallet?.signer ?? null,
        });
        setDraft((d) => (which === "avatar" ? { ...d, avatarUrl: url } : { ...d, bannerUrl: url, bannerPositionY: 50 }));
        return url;
      } finally {
        setUploading(null);
      }
    },
    [walletAddress, chainId, wallet?.signer],
  );

  const save = useCallback(
    async (next: ProfileDraft = draft) => {
      if (!walletAddress || !chainId) throw new Error("Connect your wallet first.");
      setSaving(true);
      try {
        await saveUserProfileV2({
          chainId: Number(chainId),
          address: walletAddress,
          displayName: next.displayName.trim() || null,
          bio: next.bio.trim() || null,
          avatarUrl: next.avatarUrl.trim() || null,
          links: normalizeProfileLinks({
            bannerUrl: next.bannerUrl,
            bannerPositionY: next.bannerUrl ? next.bannerPositionY : null,
            websiteUrl: next.websiteUrl,
            xUrl: next.xUrl,
            telegramUrl: next.telegramUrl,
          }),
          sign,
        });
        await reload();
      } finally {
        setSaving(false);
      }
    },
    [draft, walletAddress, chainId, sign, reload],
  );

  const dirty = JSON.stringify(draft) !== JSON.stringify(loaded);
  return { draft, setDraft, loaded, loading, saving, uploading, dirty, upload, save, reload };
}
