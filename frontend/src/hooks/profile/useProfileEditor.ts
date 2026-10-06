import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@/contexts/WalletContext";
import { buildProfileMessage, fetchUserProfile, normalizeProfileLinks, requestNonce, saveUserProfile, saveUserProfileV2, type UserProfile } from "@/lib/profileApi";
import { uploadProfileImage } from "@/lib/profileUpload";
import { signSolanaMessage } from "@/lib/solanaWallet";
import { useFeedSession } from "@/hooks/useFeedSession";
import { readStoredFeedSession } from "@/lib/feedSession";

function sameWallet(a?: string | null, b?: string | null) {
  const x = String(a || "").trim();
  const y = String(b || "").trim();
  if (!x || !y) return false;
  return x.startsWith("0x") || y.startsWith("0x") ? x.toLowerCase() === y.toLowerCase() : x === y;
}

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
  // Uploads and saves run on the 30-day sign-in when the connected wallet is this profile's wallet
  // (founder, 2026-10-06). Otherwise they keep the signed path below.
  const feed = useFeedSession();
  const sessionUsable = sameWallet(feed.account, walletAddress);
  const [loaded, setLoaded] = useState<ProfileDraft>(EMPTY);
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<null | "avatar" | "banner">(null);
  // An API from before CO-19 (or a database without the new columns) cannot store banner and links.
  const [linksSupported, setLinksSupported] = useState(true);

  const reload = useCallback(async () => {
    if (!walletAddress || !chainId) return;
    setLoading(true);
    try {
      const p = await fetchUserProfile(Number(chainId), walletAddress);
      setLinksSupported(p ? p.linksSupported !== false : true);
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
        const kind = which === "avatar" ? "avatar" : "profile_banner";
        const opts = { chainId: Number(chainId), address: walletAddress, signer: wallet?.signer ?? null };
        const url = sessionUsable
          ? await feed.withSession((sessionToken) => uploadProfileImage(file, kind, { ...opts, sessionToken }))
          : await uploadProfileImage(file, kind, opts);
        setDraft((d) => (which === "avatar" ? { ...d, avatarUrl: url } : { ...d, bannerUrl: url, bannerPositionY: 50 }));
        return url;
      } finally {
        setUploading(null);
      }
    },
    [walletAddress, chainId, wallet?.signer, sessionUsable, feed.withSession],
  );

  /**
   * Before the photo picker opens: true when no signature will be needed. Without a stored sign-in it
   * asks for it first, so the wallet never has to sign right after the picker (phone wallet browsers
   * stalled there). Resolves false when that signature is declined.
   */
  const readyForUpload = useCallback((): true | Promise<boolean> => {
    if (!sessionUsable || readStoredFeedSession(feed.account, feed.chainId)) return true;
    return feed.ensureSession().then(() => true, () => false);
  }, [sessionUsable, feed.account, feed.chainId, feed.ensureSession]);

  const save = useCallback(
    async (next: ProfileDraft = draft) => {
      if (!walletAddress || !chainId) throw new Error("Connect your wallet first.");
      setSaving(true);
      try {
        if (!linksSupported) {
          // Old API: the version 1 save (name, picture, bio), the same message the old dialog signs.
          const address = isSolanaChain(chainId) ? walletAddress : walletAddress.toLowerCase();
          const nonce = await requestNonce(Number(chainId), address);
          const avatarUrl = next.avatarUrl.trim() || null;
          const displayName = next.displayName.trim() || null;
          const signature = await sign(buildProfileMessage({ chainId: Number(chainId), address, nonce, displayName, avatarUrl }));
          await saveUserProfile({ chainId: Number(chainId), address, displayName, bio: next.bio.trim() || null, avatarUrl, nonce, signature });
          await reload();
          return;
        }
        const input = {
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
        };
        if (sessionUsable) await feed.withSession((sessionToken) => saveUserProfileV2({ ...input, sessionToken }));
        else await saveUserProfileV2(input);
        await reload();
      } finally {
        setSaving(false);
      }
    },
    [draft, walletAddress, chainId, sign, reload, linksSupported, sessionUsable, feed.withSession],
  );

  const dirty = JSON.stringify(draft) !== JSON.stringify(loaded);
  return { draft, setDraft, loaded, loading, saving, uploading, dirty, upload, readyForUpload, save, reload, linksSupported };
}
