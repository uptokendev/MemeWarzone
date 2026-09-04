export const BPS_DENOM = 10_000n;
export const BOOST_POOL_BPS = 9_000n;
export const BOOST_PROTOCOL_BPS = 1_000n;

export function parseRawNative(value, label = "amount") {
  try {
    const raw = BigInt(String(value));
    if (raw < 0n) throw new Error(`${label} must be non-negative`);
    return raw;
  } catch (error) {
    if (error instanceof Error && /non-negative/.test(error.message)) throw error;
    throw new Error(`${label} must be an integer raw native amount`);
  }
}

export function expectedBoostSplit(grossNativeRaw) {
  const gross = parseRawNative(grossNativeRaw, "grossNativeRaw");
  if (gross <= 0n) throw new Error("grossNativeRaw must be positive");
  const protocol = (gross * BOOST_PROTOCOL_BPS) / BPS_DENOM;
  const pool = gross - protocol;
  return { gross, pool, protocol };
}

export function validateConfirmedBoost({ boostUnits, grossNativeRaw, poolNativeRaw, protocolNativeRaw }) {
  const units = parseRawNative(boostUnits, "boostUnits");
  if (units <= 0n) throw new Error("boostUnits must be positive");
  const expected = expectedBoostSplit(grossNativeRaw);
  const pool = parseRawNative(poolNativeRaw, "poolNativeRaw");
  const protocol = parseRawNative(protocolNativeRaw, "protocolNativeRaw");
  if (pool !== expected.pool || protocol !== expected.protocol) {
    throw new Error("Boost split must be exactly 90% prize / 10% protocol with integer dust retained by prize");
  }
  return { boostUnits: units, ...expected };
}

export function resolveBattleSide(participants, targetToken) {
  const needle = String(targetToken || "").trim().toLowerCase();
  if (!needle || !Array.isArray(participants) || participants.length < 2) return null;
  const identity = (participant) =>
    String(participant?.tokenId || participant?.tokenAddress || participant?.campaignAddress || "").trim().toLowerCase();
  if (identity(participants[0]) === needle) return "left";
  if (identity(participants[1]) === needle) return "right";
  return null;
}

export function boostSummary(rows = []) {
  const summary = {
    left: { boostUnits: 0n, grossNativeRaw: 0n, poolNativeRaw: 0n, protocolNativeRaw: 0n },
    right: { boostUnits: 0n, grossNativeRaw: 0n, poolNativeRaw: 0n, protocolNativeRaw: 0n },
    total: { boostUnits: 0n, grossNativeRaw: 0n, poolNativeRaw: 0n, protocolNativeRaw: 0n },
  };
  for (const row of rows) {
    const side = row?.side === "right" ? "right" : row?.side === "left" ? "left" : null;
    if (!side) continue;
    const units = parseRawNative(row.boost_units ?? 0, "boost_units");
    const gross = parseRawNative(row.gross_native_raw ?? 0, "gross_native_raw");
    const pool = parseRawNative(row.pool_native_raw ?? 0, "pool_native_raw");
    const protocol = parseRawNative(row.protocol_native_raw ?? 0, "protocol_native_raw");
    summary[side].boostUnits += units;
    summary[side].grossNativeRaw += gross;
    summary[side].poolNativeRaw += pool;
    summary[side].protocolNativeRaw += protocol;
    summary.total.boostUnits += units;
    summary.total.grossNativeRaw += gross;
    summary.total.poolNativeRaw += pool;
    summary.total.protocolNativeRaw += protocol;
  }
  return summary;
}

export function serializeBoostSummary(summary) {
  const encode = (bucket) => ({
    boostUnits: bucket.boostUnits.toString(),
    grossNativeRaw: bucket.grossNativeRaw.toString(),
    poolNativeRaw: bucket.poolNativeRaw.toString(),
    protocolNativeRaw: bucket.protocolNativeRaw.toString(),
  });
  return { left: encode(summary.left), right: encode(summary.right), total: encode(summary.total) };
}
