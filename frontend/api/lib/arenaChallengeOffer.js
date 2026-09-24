/**
 * Challenge offer helpers: decline copy, higher-stake counters, creator channel names.
 * Money amounts stay numbers the existing battle handlers already parse.
 */

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;
const MAX_DECLINE_MESSAGE = 280;

export function sanitizeDeclineMessage(value) {
  const text = String(value ?? "")
    .replace(CONTROL_CHARS, "")
    .trim();
  if (!text) return null;
  return text.slice(0, MAX_DECLINE_MESSAGE);
}

export function isStrictlyHigherStake(nextStake, currentStake) {
  const next = Number(nextStake);
  const current = Number(currentStake);
  return Number.isFinite(next) && Number.isFinite(current) && next > current;
}

export function normalizeCreatorWallet(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^0x[a-fA-F0-9]{40}$/.test(raw)) return raw.toLowerCase();
  return raw;
}

export function arenaCreatorChannelName(chainId, wallet) {
  const id = Number(chainId);
  const key = normalizeCreatorWallet(wallet);
  if (!Number.isFinite(id) || id <= 0 || !key) return "";
  return `arena:creator:${id}:${key}`;
}

export function creatorChallengePayload(battle, extra = {}) {
  const mapped = battle && typeof battle === "object" ? battle : {};
  return {
    battle: mapped,
    offeredStakeNative: Number(mapped.offeredStakeNative ?? mapped.stakeNative ?? 0) || 0,
    offeredDurationHours: Number(mapped.offeredDurationHours ?? mapped.durationHours ?? 24) || 24,
    nativeSymbol: String(mapped.nativeSymbol || extra.nativeSymbol || ""),
    message: extra.message == null ? null : sanitizeDeclineMessage(extra.message),
    escrowRequired: extra.escrowRequired === true,
  };
}
