export function mergeTimelineItems(buckets, limit = 50) {
  const items = [];
  for (const bucket of buckets || []) {
    if (!Array.isArray(bucket)) continue;
    for (const item of bucket) {
      if (!item || !item.createdAt) continue;
      items.push(item);
    }
  }
  items.sort((a, b) => {
    const dt = Date.parse(String(b.createdAt)) - Date.parse(String(a.createdAt));
    if (dt !== 0) return dt;
    return String(b.id || "").localeCompare(String(a.id || ""));
  });
  const cap = Math.max(1, Math.min(200, Number(limit) || 50));
  return items.slice(0, cap);
}
