/**
 * What the creator of an imported coin has earned from the 1% import swap fee (founder, 2026-10-08):
 * half of every fee paid to the split receivers (financeImportSwapFees.js), waiting 90 days per
 * trade, paid automatically to the verified owner once the claim is 7 days old
 * (realtime-indexer/src/importCreatorFees.ts). Read-only; the coin page shows it next to the claim
 * button.
 *
 * GET /api/imports/creator-fees?chainId=101&token=<mint>
 */
import { pool } from "../server/db.js";
import { badMethod, json } from "../server/http.js";

export const CREATOR_FEE_WINDOW_DAYS = 90;
export const CREATOR_PAYOUT_HOLD_DAYS = Math.max(0, Number(process.env.IMPORT_CREATOR_HOLD_DAYS ?? 7));
const ASSET = { 101: { symbol: "SOL", decimals: 9 }, 56: { symbol: "BNB", decimals: 18 }, 4663: { symbol: "ETH", decimals: 18 } };

function readInput(query) {
  const chainId = Number(query?.chainId);
  const raw = String(query?.token || query?.tokenAddress || "").trim();
  if (!ASSET[chainId]) return null;
  if (chainId === 101 ? !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw) : !/^0x[0-9a-fA-F]{40}$/.test(raw)) return null;
  return { chainId, token: chainId === 101 ? raw : raw.toLowerCase() };
}

/** Totals per status, the owner state and when the first payout can go out. Pure given the rows. */
export function summarizeCreatorFees({ chainId, token, totals, owner, now = new Date() }) {
  const sum = (status) => String(totals.find((t) => t.status === status)?.total ?? "0");
  const verified = owner?.ownership_status === "ownership_verified" && Boolean(owner?.project_owner_wallet);
  const verifiedAt = owner?.ownership_verified_at ? new Date(owner.ownership_verified_at) : null;
  const payoutsFrom = verified && verifiedAt ? new Date(verifiedAt.getTime() + CREATOR_PAYOUT_HOLD_DAYS * 86_400_000) : null;
  const oldest = totals.find((t) => t.status === "waiting")?.oldest_expires_at || null;
  return {
    chainId,
    token,
    asset: ASSET[chainId].symbol,
    decimals: ASSET[chainId].decimals,
    windowDays: CREATOR_FEE_WINDOW_DAYS,
    holdDays: CREATOR_PAYOUT_HOLD_DAYS,
    claimed: verified,
    ownerWallet: verified ? String(owner.project_owner_wallet) : null,
    payoutsFrom: payoutsFrom ? payoutsFrom.toISOString() : null,
    payoutsOpen: Boolean(payoutsFrom && payoutsFrom.getTime() <= now.getTime()),
    waitingRaw: sum("waiting"),
    payingRaw: sum("paying"),
    paidRaw: sum("paid"),
    expiredRaw: sum("expired"),
    oldestExpiresAt: oldest ? new Date(oldest).toISOString() : null,
  };
}

export default async function importCreatorFees(req, res) {
  if (req.method !== "GET") return badMethod(res);
  const input = readInput(req.query || Object.fromEntries(new URL(String(req.url || ""), "http://x").searchParams));
  if (!input) return json(res, 400, { ok: false, error: "chainId (101, 56, 4663) and a token address are required" });
  if (!pool) return json(res, 503, { ok: false, error: "Database unavailable" });
  try {
    const [totals, owner] = await Promise.all([
      pool.query(
        `select status, sum(creator_raw)::text as total,
                min(expires_at) filter (where status = 'waiting') as oldest_expires_at
           from public.import_creator_fees
          where chain_id = $1 and token_address = $2 and (status <> 'waiting' or expires_at > now())
          group by status`,
        [input.chainId, input.token],
      ),
      pool.query(
        `select ownership_status, project_owner_wallet, ownership_verified_at
           from public.arena_token_imports
          where chain_id = $1 and token_address = $2
          order by (ownership_status = 'ownership_verified') desc, ownership_verified_at desc nulls last
          limit 1`,
        [input.chainId, input.token],
      ),
    ]);
    res.setHeader("cache-control", "public, max-age=30");
    return json(res, 200, { ok: true, available: true, ...summarizeCreatorFees({ ...input, totals: totals.rows, owner: owner.rows[0] || null }) });
  } catch (error) {
    // Tables not migrated yet: nothing earned, nothing to show.
    if (error?.code === "42P01" || error?.code === "42703") return json(res, 200, { ok: true, available: false, ...input });
    console.error("[api/importCreatorFees]", error);
    return json(res, 500, { ok: false, error: "Creator fee lookup failed" });
  }
}
