import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { OperativeMark } from "@/components/ui-v2/OperativeMark";
import { isSolanaAddress } from "@/lib/address";
import { fetchUserProfile } from "@/lib/profileApi";

/** The wallet's profile picture (one profile per wallet across chains), cached per wallet. */
export function usePersonAvatar(wallet?: string | null, known?: string | null) {
  const w = String(wallet || "").trim();
  const q = useQuery({
    queryKey: ["person-avatar", w],
    enabled: Boolean(w) && !known,
    staleTime: 10 * 60_000,
    retry: 0,
    queryFn: async () => {
      const profile = await fetchUserProfile(isSolanaAddress(w) ? 101 : 56, w).catch(() => null);
      return String(profile?.avatarUrl || "").trim() || null;
    },
  });
  return known || q.data || null;
}

/**
 * A person's picture (founder, 2026-10-03): their profile picture when they set one, else the green
 * operative, the same default as the feed, profile and coin pages. Coins keep their own logos.
 */
export function PersonAvatar({
  wallet,
  url,
  size = 44,
  className = "",
}: {
  wallet?: string | null;
  url?: string | null;
  size?: number;
  className?: string;
}) {
  const src = usePersonAvatar(wallet, url);
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        style={{ width: size, height: size }}
        onError={() => setFailed(true)}
        className={`mw-avatar shrink-0 rounded-full border border-mw-border object-cover ${className}`}
      />
    );
  }
  return <OperativeMark size={size} className={className} />;
}
