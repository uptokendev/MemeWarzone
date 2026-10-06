import { badMethod, getQuery, isAddress, isSolanaChain, normalizeAddress as centralNormalize, normalizeWalletFlexible, json, readJson } from "../../server/http.js";

function methodAllowed(req, res, allowed) {
  if (allowed.includes(req.method)) return true;
  badMethod(res);
  return false;
}

function normalizeAddress(value, chainId) {
  // Delegate to central for Solana raw base58 support (with chainId or heuristic). Without a chain
  // id the central helper only takes EVM, so a Solana wallet's bell came back empty: notifications
  // are written with the flexible key (EVM lowercased, Solana as-is), so read them the same way.
  return centralNormalize(value, chainId) || normalizeWalletFlexible(value);
}

// Social titles start with the actor's name as it was when the row was written ("7ZkE…zohv followed
// you"). Swap that leading name for the actor's current @username / display name on read, so someone
// who names themselves later shows by name in old notifications too. Rows without metadata.actor
// (coin, battle, reward events) are untouched.
const LEADING_ACTOR_RE = /^(?:@[A-Za-z0-9_]{3,20}|[1-9A-HJ-NP-Za-km-z]{4}(?:…|\.\.\.)[1-9A-HJ-NP-Za-km-z]{4}|0x[0-9a-fA-F]{2}(?:…|\.\.\.)[0-9a-fA-F]{4}|[1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40})(?= )/;

export function relabelActorTitle(title, label) {
  const text = String(title || "");
  if (!label || !LEADING_ACTOR_RE.test(text)) return text;
  return text.replace(LEADING_ACTOR_RE, label);
}

async function withCurrentActorNames(rows) {
  if (!rows.some((row) => row?.metadata_json?.actor)) return rows;
  // Lazy like getPool: userHandles.js pulls in server/db.js, which throws without DATABASE_URL.
  const { loadActorLabels, walletKey } = await import("../lib/userHandles.js");
  const actors = rows.map((row) => walletKey(row?.metadata_json?.actor)).filter(Boolean);
  if (!actors.length) return rows;
  const labels = await loadActorLabels(actors).catch(() => new Map());
  if (!labels.size) return rows;
  return rows.map((row) => {
    const label = labels.get(walletKey(row?.metadata_json?.actor));
    return label ? { ...row, title: relabelActorTitle(row.title, label) } : row;
  });
}

async function getPool() {
  if (!String(process.env.DATABASE_URL || "").trim()) return null;
  try {
    const mod = await import("../../server/db.js");
    return mod.pool || null;
  } catch (err) {
    console.warn("[prepare-notifications] DB unavailable", err?.message || err);
    return null;
  }
}

function mapNotification(row) {
  const metadata = row.metadata_json || {};
  return {
    id: String(row.id),
    title: String(row.title || ""),
    body: String(row.body || ""),
    target: String(metadata.target || metadata.url || "/profile?tab=notifications"),
    createdAt: row.created_at,
    read: Boolean(row.is_read),
    kind: String(row.event_type || "publish"),
    eventType: String(row.event_type || ""),
    targetType: String(row.target_type || "draft"),
    targetId: String(row.target_id || ""),
    // CO-5: battles | social | rewards | coin (rows from before the column are coin events).
    category: String(row.category || "coin"),
  };
}

export async function prepareNotifications(req, res) {
  if (!methodAllowed(req, res, ["GET", "POST", "PUT"])) return;

  const pool = await getPool();
  if (!pool) return json(res, 503, { error: "Prepare notifications require DATABASE_URL." });

  if (req.method === "GET") {
    const q = getQuery(req);
    const chainId = q.chainId ? Number(q.chainId) : null;
    const wallet = normalizeAddress(q.wallet || q.walletAddress || q.address, chainId);
    const limit = Math.max(1, Math.min(50, Number(q.limit || 20)));

    if (!wallet) return json(res, 400, { error: "Wallet address required." });

    const result = await pool.query(
      `select *
         from public.prepare_mode_notifications
        where wallet_address = $1
        order by created_at desc
        limit $2`,
      [wallet, limit],
    );

    const rows = await withCurrentActorNames(result.rows).catch(() => result.rows);
    return json(res, 200, { items: rows.map(mapNotification) });
  }

  const body = await readJson(req);
  const chainId = body.chainId ? Number(body.chainId) : null;
  const wallet = normalizeAddress(body.wallet || body.walletAddress || body.address, chainId);

  if (!wallet) return json(res, 400, { error: "Wallet address required." });

  if (body.markAllRead) {
    await pool.query(
      `update public.prepare_mode_notifications
          set is_read = true,
              read_at = coalesce(read_at, now())
        where wallet_address = $1
          and is_read = false`,
      [wallet],
    );

    return json(res, 200, { ok: true });
  }

  const id = String(body.id || body.notificationId || "").trim();
  if (!id) return json(res, 400, { error: "Notification id required." });

  await pool.query(
    `update public.prepare_mode_notifications
        set is_read = true,
            read_at = coalesce(read_at, now())
      where id::text = $1
        and wallet_address = $2`,
    [id, wallet],
  );

  return json(res, 200, { ok: true });
}
