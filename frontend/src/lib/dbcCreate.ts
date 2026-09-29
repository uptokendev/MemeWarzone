import { apiFetch } from "@/lib/apiBase";
import type { WalletActionAuthPayload } from "@/lib/walletActionAuth";

export type DbcFeeChoice = "keep" | "holders" | "split" | "buyback";

async function postDbc(body: Record<string, unknown>) {
  const response = await apiFetch("/api/dbc/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    const message = String(payload?.error || payload?.message || `DBC create failed (${response.status}).`);
    const code = payload?.code ? String(payload.code) : "";
    const error = new Error(code ? `${message} [${code}]` : message) as Error & { code?: string; status?: number };
    error.code = code || undefined;
    error.status = response.status;
    throw error;
  }
  return payload;
}

export async function preflightDbcCreate(input: { creatorWallet: string; targetUsd: number | string }) {
  return postDbc({ operation: "preflight", creatorWallet: input.creatorWallet, targetUsd: input.targetUsd });
}

export async function beginDbcCreate(input: {
  creatorWallet: string;
  ticker: string;
  auth: WalletActionAuthPayload;
  draftId?: string | null;
}) {
  return postDbc({
    operation: "begin",
    creatorWallet: input.creatorWallet,
    ticker: input.ticker,
    auth: input.auth,
    draftId: input.draftId || undefined,
  });
}

export async function authorizeDbcCreate(input: {
  sessionToken: string;
  mint: string;
  name: string;
  symbol: string;
  description?: string | null;
  logoUrl?: string | null;
  website?: string | null;
  x?: string | null;
  telegram?: string | null;
  discord?: string | null;
  targetUsd: number | string;
  feeChoice: DbcFeeChoice;
  creatorSharePct?: number | null;
  firstBuyLamports?: string | number;
  draftId?: string | null;
  quoteMint?: string | null;
}) {
  return postDbc({
    operation: "authorize",
    ...input,
    firstBuyLamports: String(input.firstBuyLamports || "0"),
  });
}

export async function finalizeDbcCreate(input: { finalizeToken: string; signature: string }) {
  return postDbc({ operation: "finalize", finalizeToken: input.finalizeToken, signature: input.signature });
}

export async function quoteDbcFirstBuy(input: {
  targetUsd: number | string;
  feeChoice: DbcFeeChoice;
  creatorSharePct?: number | null;
  firstBuyLamports: string | number;
  quoteMint?: string | null;
}) {
  return postDbc({
    operation: "quote-first-buy",
    targetUsd: input.targetUsd,
    feeChoice: input.feeChoice,
    creatorSharePct: input.creatorSharePct,
    firstBuyLamports: String(input.firstBuyLamports || "0"),
  });
}

export async function scheduleDbcDraft(input: {
  draftId: string;
  creatorWallet: string;
  auth: WalletActionAuthPayload;
  scheduledLaunchAt: number;
  targetUsd?: number | string;
  feeChoice?: DbcFeeChoice;
  creatorSharePct?: number | null;
  firstBuyLamports?: string | number;
}) {
  return postDbc({
    operation: "schedule",
    draftId: input.draftId,
    creatorWallet: input.creatorWallet,
    auth: input.auth,
    scheduledLaunchAt: input.scheduledLaunchAt,
    targetUsd: input.targetUsd,
    feeChoice: input.feeChoice,
    creatorSharePct: input.creatorSharePct,
    firstBuyLamports: input.firstBuyLamports != null ? String(input.firstBuyLamports) : undefined,
  });
}

export async function fetchDbcDueDrafts(wallet: string) {
  const response = await apiFetch(`/api/dbc/create?due=1&wallet=${encodeURIComponent(wallet)}`, { cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) return { ok: false, items: [] as Array<Record<string, unknown>> };
  return payload;
}

export async function fetchDbcToken(token: string) {
  const response = await apiFetch(`/api/dbc/create?token=${encodeURIComponent(token)}&live=1`, { cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 404 || payload?.code === "DBC_NOT_FOUND") return null;
  if (!response.ok || payload?.ok === false) return null;
  return payload;
}
