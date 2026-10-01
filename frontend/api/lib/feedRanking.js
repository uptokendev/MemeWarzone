/** Recency-first For You score. Fires are a light nudge, not the ranking. */
export function scoreFeedPost({ createdAt, fireCount = 0, replyCount = 0, repostCount = 0, followed = false }) {
  const ts = Date.parse(String(createdAt || ""));
  const hours = Number.isFinite(ts) ? Math.max(0, (Date.now() - ts) / 3_600_000) : 48;
  const recency = 48 / (1 + hours / 6);
  const followBoost = followed ? 12 : 0;
  const fires = Math.log2(1 + Math.max(0, Number(fireCount) || 0)) * 0.35;
  const replies = Math.log2(1 + Math.max(0, Number(replyCount) || 0)) * 0.8;
  const reposts = Math.log2(1 + Math.max(0, Number(repostCount) || 0)) * 0.6;
  return recency + followBoost + fires + replies + reposts;
}

export function rankFeedPosts(items, { following = [], limit = 40 } = {}) {
  const followed = new Set(
    (following || []).map((w) => String(w || "").trim().toLowerCase()).filter(Boolean),
  );
  const scored = (items || []).map((item) => ({
    item,
    score: scoreFeedPost({
      createdAt: item.createdAt,
      fireCount: item.fireCount,
      replyCount: item.replyCount,
      repostCount: item.repostCount,
      followed: followed.has(String(item.wallet || "").toLowerCase()),
    }),
  }));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const dt = Date.parse(String(b.item.createdAt || "")) - Date.parse(String(a.item.createdAt || ""));
    if (dt !== 0) return dt;
    return Number(b.item.postId || 0) - Number(a.item.postId || 0);
  });
  const cap = Math.max(1, Math.min(200, Number(limit) || 40));
  return scored.slice(0, cap).map((row) => row.item);
}
