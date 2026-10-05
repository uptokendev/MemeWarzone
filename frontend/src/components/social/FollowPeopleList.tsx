import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Modal } from "@/components/ui-v2";
import { PersonAvatar } from "@/components/ui-v2/PersonAvatar";
import { useWalletLabel, shortWallet } from "@/components/ui-v2/WalletLabel";
import { useWalletHandle } from "@/lib/handlesApi";
import { useActiveFeedWallet } from "@/hooks/useActiveFeedWallet";
import { followUser, getFollowers, getFollowing, unfollowUser } from "@/lib/followApi";

type FollowMode = "followers" | "following";
type Person = { address: string; displayName: string | null; avatarUrl: string | null };

const sameWallet = (a?: string | null, b?: string | null) => {
  const x = String(a || "").trim();
  const y = String(b || "").trim();
  if (!x || !y) return false;
  return x.startsWith("0x") || y.startsWith("0x") ? x.toLowerCase() === y.toLowerCase() : x === y;
};

export const followListKey = (wallet: string, mode: FollowMode) => ["follow-list", mode, wallet];

/** One wallet's followers or following, as people (address, name, picture). */
export function useFollowPeople(wallet: string | null | undefined, mode: FollowMode, enabled = true) {
  return useQuery({
    queryKey: followListKey(String(wallet || ""), mode),
    enabled: Boolean(wallet) && enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<Person[]> => {
      const rows = mode === "followers" ? await getFollowers(String(wallet)) : await getFollowing(String(wallet));
      return rows
        .map((r: { id?: string; profile?: { displayName?: string | null; avatarUrl?: string | null } }) => ({
          address: String(r.id || ""),
          displayName: r.profile?.displayName ? String(r.profile.displayName) : null,
          avatarUrl: r.profile?.avatarUrl ? String(r.profile.avatarUrl) : null,
        }))
        .filter((p) => p.address);
    },
  });
}

function FollowButton({ viewer, target, following, onChanged }: { viewer: string; target: string; following: boolean; onChanged: (next: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState(false);
  const toggle = async (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    setBusy(true);
    const next = !following;
    try {
      if (next) await followUser(viewer, target);
      else await unfollowUser(viewer, target);
      onChanged(next);
    } catch (err: any) {
      toast.error(String(err?.message || "Could not update follow"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={(event) => void toggle(event)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      disabled={busy}
      className={`mw-focus inline-flex min-h-9 shrink-0 items-center rounded-full border px-4 text-sm font-bold disabled:opacity-60 ${
        following
          ? hover
            ? "border-[#5A1F2B] bg-[#2A0F16] text-[#FB7185]"
            : "border-mw-edge bg-transparent text-mw-text"
          : "border-mw-text bg-mw-text text-mw-ground hover:bg-[#D9DCDF]"
      }`}
    >
      {following ? (hover ? "Unfollow" : "Following") : "Follow"}
    </button>
  );
}

function PersonRow({ person, viewer, viewerFollows, onFollowChange, onOpen }: { person: Person; viewer: string; viewerFollows: boolean; onFollowChange: (next: boolean) => void; onOpen?: () => void }) {
  const name = useWalletLabel(person.address, person.displayName);
  const handle = useWalletHandle(person.address);
  return (
    <Link
      to={`/profile/${encodeURIComponent(person.address)}`}
      onClick={onOpen}
      className="flex min-h-[64px] items-center gap-3 border-b border-[#1E2329] px-1 py-2.5 text-mw-text last:border-b-0 hover:bg-[#13171C] hover:text-mw-text"
      data-follow-row="true"
    >
      <PersonAvatar wallet={person.address} url={person.avatarUrl} size={44} />
      <span className="min-w-0 flex-1">
        <b className="block truncate">{name}</b>
        <span className="block truncate text-sm text-mw-muted">
          {handle && name !== `@${handle}` ? `@${handle} · ` : ""}
          {shortWallet(person.address)}
        </span>
      </span>
      {viewer && !sameWallet(viewer, person.address) ? (
        <FollowButton viewer={viewer} target={person.address} following={viewerFollows} onChanged={onFollowChange} />
      ) : null}
    </Link>
  );
}

/**
 * Followers or following of a wallet, like on X (founder, 2026-10-05): picture, name, @username and a
 * Follow / Following button for the person looking. Used in Command Center and the public profile.
 */
export function FollowPeopleList({ wallet, mode, onOpen, emptyText }: { wallet: string; mode: FollowMode; onOpen?: () => void; emptyText?: string }) {
  const client = useQueryClient();
  const { address: viewer } = useActiveFeedWallet();
  const list = useFollowPeople(wallet, mode);
  // Who the viewer follows, for the buttons.
  const mine = useFollowPeople(viewer || null, "following");
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  useEffect(() => setOverrides({}), [viewer]);
  const viewerFollows = (address: string) => {
    if (address in overrides) return overrides[address];
    return (mine.data || []).some((p) => sameWallet(p.address, address));
  };
  if (list.isLoading) return <p className="m-0 px-1 py-4 text-sm text-mw-muted">Loading...</p>;
  const people = list.data || [];
  if (!people.length) {
    return <p className="m-0 px-1 py-4 text-sm text-mw-muted">{emptyText || (mode === "followers" ? "No followers yet." : "Not following anyone yet.")}</p>;
  }
  return (
    <div className="flex flex-col" data-follow-list={mode}>
      {people.map((person) => (
        <PersonRow
          key={person.address}
          person={person}
          viewer={viewer || ""}
          viewerFollows={viewerFollows(person.address)}
          onOpen={onOpen}
          onFollowChange={(next) => {
            setOverrides((o) => ({ ...o, [person.address]: next }));
            if (viewer) void client.invalidateQueries({ queryKey: followListKey(viewer, "following") });
          }}
        />
      ))}
    </div>
  );
}

/** Popup with Followers / Following tabs, opened from the counts on a public profile. */
export function FollowListDialog({
  wallet,
  title,
  open,
  initialMode,
  counts,
  onClose,
}: {
  wallet: string;
  title: string;
  open: boolean;
  initialMode: FollowMode;
  counts?: { followers: number; following: number } | null;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<FollowMode>(initialMode);
  useEffect(() => {
    if (open) setMode(initialMode);
  }, [open, initialMode]);
  const tab = (m: FollowMode, label: string, n?: number) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode === m}
      onClick={() => setMode(m)}
      className={`mw-focus flex-1 border-b-[3px] py-3 text-[15px] font-semibold ${mode === m ? "border-mw-accent text-mw-text" : "border-transparent text-mw-muted hover:text-mw-text"}`}
    >
      {label}
      {typeof n === "number" ? <span className="ml-1.5 font-mw-mono text-sm text-mw-muted">{n}</span> : null}
    </button>
  );
  return (
    <Modal open={open} onOpenChange={(next) => (next ? null : onClose())} title={title}>
      <div className="flex flex-col" data-follow-dialog="true">
        <div className="flex border-b border-mw-border" role="tablist" aria-label="Followers and following">
          {tab("followers", "Followers", counts?.followers)}
          {tab("following", "Following", counts?.following)}
        </div>
        <div className="max-h-[60vh] overflow-y-auto pt-1">
          <FollowPeopleList wallet={wallet} mode={mode} onOpen={onClose} />
        </div>
      </div>
    </Modal>
  );
}
