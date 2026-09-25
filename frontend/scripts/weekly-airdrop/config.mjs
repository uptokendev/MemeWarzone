import crypto from "node:crypto";

export const DAY_MS = 86_400_000;

export function envText(name, fallback = "") {
  return String(process.env[name] ?? fallback).trim();
}

export function envInt(name, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number(envText(name, fallback));
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}

export function envBool(name, fallback = false) {
  const value = envText(name).toLowerCase();
  return value ? ["1", "true", "yes", "on"].includes(value) : fallback;
}

export function requireEnv(name) {
  const value = envText(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function asBigInt(value, fallback = 0n) {
  try { return BigInt(String(value ?? fallback)); } catch { return fallback; }
}

export function epochWindow(now = new Date()) {
  const end = new Date(now);
  const day = end.getUTCDay();
  end.setUTCDate(end.getUTCDate() + (day === 0 ? -6 : 1 - day));
  end.setUTCHours(0, 0, 0, 0);
  return {
    start: new Date(end.getTime() - 7 * DAY_MS),
    end,
    epochId: new Date(end.getTime() - 7 * DAY_MS).toISOString().slice(0, 10),
  };
}

export function bnb(raw) {
  return Number(raw) / 1e18;
}

export function seedCommitment(secret, chainId, epochId) {
  return crypto.createHash("sha256").update(`${secret}:${chainId}:${epochId}`).digest("hex");
}

export function weightedSample(candidates, count, secret, label) {
  return candidates
    .map((candidate) => {
      const digest = crypto.createHmac("sha256", secret).update(`${label}:${candidate.walletAddress}`).digest("hex");
      const raw = BigInt(`0x${digest.slice(0, 16)}`);
      const u = Math.max(Number.EPSILON, Math.min(1 - Number.EPSILON, (Number(raw) + 1) / 2 ** 64));
      return { candidate, key: -Math.log(u) / Math.max(0.000001, Number(candidate.finalWeight || 0)), digest };
    })
    .sort((a, b) => a.key - b.key || a.candidate.walletAddress.localeCompare(b.candidate.walletAddress))
    .slice(0, count)
    .map((entry, index) => ({ ...entry.candidate, winnerRank: index + 1, drawDigest: entry.digest }));
}

export function splitPool(poolWei, count) {
  if (!count) return [];
  const base = poolWei / BigInt(count);
  let remainder = poolWei % BigInt(count);
  return Array.from({ length: count }, () => {
    const extra = remainder > 0n ? 1n : 0n;
    if (remainder > 0n) remainder -= 1n;
    return base + extra;
  });
}

/** targetRaw: the target payout per winner in the chain's native raw units (USD-derived per run). */
export function winnerCount(poolWei, candidateCount, program, targetRaw = null) {
  if (!candidateCount || poolWei <= 0n) return 0;
  const explicitName = program === "airdrop_trader" ? "AIRDROP_TRADER_WINNERS" : "AIRDROP_CREATOR_WINNERS";
  const explicit = envInt(explicitName, 0, { min: 0, max: 1000 });
  if (explicit) return Math.min(candidateCount, explicit);
  const target = targetRaw ?? asBigInt(envText("AIRDROP_TARGET_PAYOUT_WEI", "50000000000000000"));
  const maximum = envInt("AIRDROP_MAX_WINNERS_PER_PROGRAM", 50, { min: 1, max: 1000 });
  return Math.min(candidateCount, maximum, Math.max(1, target > 0n ? Number(poolWei / target) : 1));
}

export function apiEndpoint(baseUrl, path) {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/api") ? `${base}${path}` : `${base}/api${path}`;
}
