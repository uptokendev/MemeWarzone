/**
 * Shared creator filter for GET /api/campaigns?creator=
 * Solana pubkeys keep base58 case; EVM matching is case-insensitive.
 */

export function normalizeCreatorQuery(value) {
  const raw = String(value ?? "").trim();
  return raw || null;
}

export function creatorMatchSql(column, paramIndex) {
  const n = Number(paramIndex);
  return `(
    $${n}::text is null
    or ${column} = $${n}
    or lower(${column}) = lower($${n})
  )`;
}

export function walletsEqual(a, b) {
  const left = String(a || "").trim();
  const right = String(b || "").trim();
  if (!left || !right) return false;
  return left === right || left.toLowerCase() === right.toLowerCase();
}
