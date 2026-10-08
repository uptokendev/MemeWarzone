/**
 * What an imported coin's creator has earned from the 1% import swap fee (half of it), read from
 * GET /api/imports/creator-fees (api/importCreatorFees.js). Paid automatically to the verified
 * owner; kept 90 days per trade for a creator who has not claimed yet.
 */
import { formatUnits } from "ethers";

import { apiFetch } from "@/lib/apiBase";

export type ImportCreatorFees = {
  available: boolean;
  chainId: number;
  token: string;
  asset?: string;
  decimals?: number;
  windowDays?: number;
  holdDays?: number;
  claimed?: boolean;
  ownerWallet?: string | null;
  payoutsFrom?: string | null;
  payoutsOpen?: boolean;
  waitingRaw?: string;
  payingRaw?: string;
  paidRaw?: string;
  expiredRaw?: string;
  oldestExpiresAt?: string | null;
};

export async function fetchImportCreatorFees(chainId: number, token: string, signal?: AbortSignal): Promise<ImportCreatorFees | null> {
  const params = new URLSearchParams({ chainId: String(chainId), token });
  const response = await apiFetch(`/api/imports/creator-fees?${params}`, { signal });
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  return body?.ok ? (body as ImportCreatorFees) : null;
}

/** "0.84 SOL" with up to 4 decimals; "0" when nothing. */
export function formatCreatorAmount(raw: string | undefined, decimals = 9, asset = "") {
  const value = Number(formatUnits(BigInt(raw || "0"), decimals));
  const text = value === 0 ? "0" : value < 0.0001 ? "<0.0001" : value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return asset ? `${text} ${asset}` : text;
}

export function hasAmount(raw: string | undefined) {
  return BigInt(raw || "0") > 0n;
}
