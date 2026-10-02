/** Coin page Posts tab ordering (UI redesign phase 1b). Pure. */

/** Pinned post first, then posts and auto updates by time, newest first. */
export function mergeCoinFeed(posts, autoUpdates, pinnedPostId) {
  const list = [
    ...(Array.isArray(posts) ? posts : []).map((p) => ({ ...p, kind: "post", pinned: pinnedPostId != null && String(p.id) === String(pinnedPostId) })),
    ...(Array.isArray(autoUpdates) ? autoUpdates : []).map((a) => ({ ...a, pinned: false })),
  ];
  const t = (x) => {
    const v = Date.parse(String(x.at || ""));
    return Number.isFinite(v) ? v : 0;
  };
  return list.sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : t(b) - t(a)));
}

/** "now", "5m", "3h", "2d", then a date. */
export function relativeTime(iso, now = Date.now()) {
  const at = Date.parse(String(iso || ""));
  if (!Number.isFinite(at)) return "";
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(at).toISOString().slice(0, 10);
}
