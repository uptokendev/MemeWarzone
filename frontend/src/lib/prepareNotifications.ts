import { buildRealtimeApiUrl } from "@/lib/realtimeApi";
import type { DraftNotification } from "@/lib/draftPromotion";

async function parseJson(res: Response) {
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(String((json as any)?.error || (json as any)?.message || `Request failed (${res.status})`));
  }
  return json as any;
}

/** EVM lowercased, Solana base58 as-is (the bell's wallet key); "" for anything else. */
function normalizeWallet(value?: string | null) {
  const raw = String(value || "").trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(raw)) return raw.toLowerCase();
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw)) return raw;
  return "";
}

// Solana wallets have a bell too (CO-5); before this only EVM addresses were queried.
function isEvmAddress(value?: string | null) {
  return Boolean(normalizeWallet(value));
}

export async function fetchPrepareNotifications(walletAddress?: string | null, limit = 20): Promise<DraftNotification[]> {
  const wallet = normalizeWallet(walletAddress);
  if (!wallet || !isEvmAddress(wallet)) return [];

  const qs = new URLSearchParams({ wallet, limit: String(limit) });
  const res = await fetch(buildRealtimeApiUrl(`/api/prepare-notifications?${qs.toString()}`), {
    cache: "no-store",
  });
  const json = await parseJson(res);
  return Array.isArray(json.items) ? (json.items as DraftNotification[]) : [];
}

export async function markPrepareNotificationRead(walletAddress: string, id: string) {
  const wallet = normalizeWallet(walletAddress);
  if (!wallet || !id || !isEvmAddress(wallet)) return;

  const res = await fetch(buildRealtimeApiUrl("/api/prepare-notifications"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet, id }),
  });

  await parseJson(res);
}

export async function markAllPrepareNotificationsRead(walletAddress: string) {
  const wallet = normalizeWallet(walletAddress);
  if (!wallet || !isEvmAddress(wallet)) return;

  const res = await fetch(buildRealtimeApiUrl("/api/prepare-notifications"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet, markAllRead: true }),
  });

  await parseJson(res);
}
