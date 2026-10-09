import { sessionSignature, storedSessionToken } from "@/lib/sessionActions";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/apiBase";
import { requestNonce } from "@/lib/profileApi";
import { signSolanaMessage } from "@/lib/solanaWallet";

/**
 * Usernames (founder, 2026-10-02): one unique @username per wallet across chains, for @tags in posts.
 * Backed by /api/profile/handle. `supported: false` means the API has no usernames yet (table not
 * migrated); callers then behave as before.
 */
export const HANDLE_RE = /^[A-Za-z0-9_]{3,20}$/;
export const HANDLE_COOLDOWN_DAYS = 30;
const PATH = "/api/profile/handle";

export type MyHandle = { supported: boolean; handle: string | null; changedAt: string | null; nextChangeAt: string | null };
export type HandleCheck = { supported: boolean; available: boolean; reason: null | "format" | "reserved" | "taken" | "cooldown" | "unsupported"; nextChangeAt?: string | null };
export type HandleSuggestion = { handle: string; wallet: string; displayName: string | null; avatarUrl: string | null };

/** The wallet as the API keys it: EVM lowercased, Solana as-is. */
export function handleWalletKey(raw?: string | null): string {
  const s = String(raw || "").trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return s.toLowerCase();
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return s;
  return "";
}

const isSolanaWallet = (w: string) => !w.startsWith("0x");

export async function fetchMyHandle(wallet: string): Promise<MyHandle> {
  const res = await apiFetch(`${PATH}?wallet=${encodeURIComponent(wallet)}`);
  if (!res.ok) return { supported: false, handle: null, changedAt: null, nextChangeAt: null };
  const j = await res.json().catch(() => null);
  return {
    supported: j?.supported === true,
    handle: j?.handle || null,
    changedAt: j?.changedAt || null,
    nextChangeAt: j?.nextChangeAt || null,
  };
}

export async function checkHandle(handle: string, wallet?: string | null): Promise<HandleCheck> {
  const qs = `check=${encodeURIComponent(handle)}${wallet ? `&wallet=${encodeURIComponent(wallet)}` : ""}`;
  const res = await apiFetch(`${PATH}?${qs}`);
  const j = await res.json().catch(() => null);
  if (!res.ok || !j) return { supported: false, available: false, reason: "unsupported" };
  return { supported: j.supported === true, available: Boolean(j.available), reason: j.reason ?? null, nextChangeAt: j.nextChangeAt ?? null };
}

export async function searchHandles(prefix: string): Promise<HandleSuggestion[]> {
  const q = prefix.replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,20}$/.test(q)) return [];
  const res = await apiFetch(`${PATH}?q=${encodeURIComponent(q)}`);
  if (!res.ok) return [];
  const j = await res.json().catch(() => null);
  return Array.isArray(j?.items) ? j.items : [];
}

/** Username -> wallet, for /profile/<username> links. */
export async function resolveHandle(handle: string): Promise<string | null> {
  const res = await apiFetch(`${PATH}?handle=${encodeURIComponent(handle.replace(/^@/, ""))}`);
  if (!res.ok) return null;
  const j = await res.json().catch(() => null);
  return j?.wallet || null;
}

export function buildHandleMessage(args: { chainId: number; address: string; nonce: string; handle: string }) {
  return [
    "MemeWarzone Username",
    "Action: USERNAME_SET",
    `ChainId: ${args.chainId}`,
    `Address: ${args.address}`,
    `Nonce: ${args.nonce}`,
    "",
    `Username: ${args.handle}`,
  ].join("\n");
}

/**
 * Signed save, same as the profile save: auth nonce, then the wallet signs the message.
 * Solana wallets sign on chain id 101, EVM wallets on 56 (an EVM signature is chain-independent).
 */
export async function saveHandle(args: { wallet: string; handle: string; evmSigner?: { signMessage: (m: string) => Promise<string> } | null }): Promise<{ handle: string }> {
  const sol = isSolanaWallet(args.wallet);
  const chainId = sol ? 101 : 56;
  const address = sol ? args.wallet : args.wallet.toLowerCase();
  // Signed in (30 days): no wallet prompt (founder, 2026-10-06). Otherwise the signed save below.
  const sessionToken = storedSessionToken(address, chainId);
  const nonce = sessionToken ? "session" : await requestNonce(chainId, address);
  const message = buildHandleMessage({ chainId, address, nonce, handle: args.handle });
  let signature: string;
  if (sessionToken) signature = sessionSignature(sessionToken);
  else if (sol) signature = (await signSolanaMessage(message, address)).signature;
  else {
    if (!args.evmSigner) throw new Error("Wallet signer is not available. Reconnect your wallet and try again.");
    signature = await args.evmSigner.signMessage(message);
  }
  const res = await apiFetch(PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chainId, address, handle: args.handle, nonce, signature }),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(j?.error || `Could not save username (${res.status})`);
  primeHandle(args.wallet, j?.handle || args.handle);
  return { handle: j?.handle || args.handle };
}

/* ---- Batched wallet -> username cache, so every place that shows a wallet can show the name. ---- */

const cache = new Map<string, string | null>();
const listeners = new Set<() => void>();
let queue = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let disabled = false;

function notify() {
  for (const fn of listeners) fn();
}

export function primeHandle(wallet: string, handle: string | null) {
  const key = handleWalletKey(wallet);
  if (!key) return;
  cache.set(key, handle);
  notify();
}

function flush() {
  timer = null;
  const keys = [...queue].slice(0, 100);
  queue = new Set([...queue].slice(100));
  if (queue.size) timer = setTimeout(flush, 0);
  if (!keys.length) return;
  for (const k of keys) cache.set(k, cache.get(k) ?? null);
  void apiFetch(`${PATH}?wallets=${keys.map(encodeURIComponent).join(",")}`)
    .then(async (res) => {
      if (res.status === 404) {
        disabled = true;
        return;
      }
      const j = await res.json().catch(() => null);
      if (j?.supported === false) disabled = true;
      const handles = j?.handles && typeof j.handles === "object" ? j.handles : {};
      for (const k of keys) cache.set(k, handles[k] || null);
      notify();
    })
    .catch(() => {});
}

function request(key: string) {
  if (disabled || cache.has(key) || queue.has(key)) return;
  queue.add(key);
  if (timer == null) timer = setTimeout(flush, 30);
}

/** The wallet's @username (without @), or null while unknown / not set. */
export function useWalletHandle(wallet?: string | null): string | null {
  const key = handleWalletKey(wallet);
  const [, bump] = useState(0);
  useEffect(() => {
    if (!key) return;
    const fn = () => bump((n) => n + 1);
    listeners.add(fn);
    request(key);
    return () => {
      listeners.delete(fn);
    };
  }, [key]);
  return key ? cache.get(key) ?? null : null;
}
