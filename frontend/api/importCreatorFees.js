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
// Testnets 97 / 46630 too, so the gen-7 testnet run shows the coin-page notice (CO-IMPORT-SWAP-FEE).
const ASSET = { 101: { symbol: "SOL", decimals: 9 }, 56: { symbol: "BNB", decimals: 18 }, 4663: { symbol: "ETH", decimals: 18 }, 97: { symbol: "tBNB", decimals: 18 }, 46630: { symbol: "ETH", decimals: 18 } };

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
  if (!input) return json(res, 400, { ok: false, error: "chainId (101, 56, 4663, 97, 46630) and a token address are required" });
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

/** Per-coin totals for every verified import a wallet owns (Command Center, Claims). Pure given the rows. */
export function summarizeOwnerCreatorFees(rows, now = new Date()) {
  return rows.map((row) => {
    const chainId = Number(row.chain_id);
    const verifiedAt = row.ownership_verified_at ? new Date(row.ownership_verified_at) : null;
    const payoutsFrom = verifiedAt ? new Date(verifiedAt.getTime() + CREATOR_PAYOUT_HOLD_DAYS * 86_400_000) : null;
    return {
      chainId,
      token: String(row.token_address),
      name: row.name || null,
      symbol: row.symbol || null,
      imageUrl: row.image_url || null,
      asset: ASSET[chainId]?.symbol || null,
      decimals: ASSET[chainId]?.decimals ?? 18,
      waitingRaw: String(row.waiting ?? "0"),
      payingRaw: String(row.paying ?? "0"),
      paidRaw: String(row.paid ?? "0"),
      expiredRaw: String(row.expired ?? "0"),
      payoutsFrom: payoutsFrom ? payoutsFrom.toISOString() : null,
      payoutsOpen: Boolean(payoutsFrom && payoutsFrom.getTime() <= now.getTime()),
    };
  });
}

/** GET /api/imports/creator-fees/owner?wallet=<address>: the creator earnings of the imports this wallet claimed. */
export async function importCreatorFeesOwner(req, res) {
  if (req.method !== "GET") return badMethod(res);
  const query = req.query || Object.fromEntries(new URL(String(req.url || ""), "http://x").searchParams);
  const wallet = String(query.wallet || "").trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet) && !/^0x[0-9a-fA-F]{40}$/.test(wallet)) return json(res, 400, { ok: false, error: "wallet is required" });
  if (!pool) return json(res, 503, { ok: false, error: "Database unavailable" });
  try {
    const { rows } = await pool.query(
      `select i.chain_id, i.token_address, i.name, i.symbol, i.image_url, i.ownership_verified_at,
              coalesce(sum(c.creator_raw) filter (where c.status = 'waiting' and c.expires_at > now()), 0)::text as waiting,
              coalesce(sum(c.creator_raw) filter (where c.status = 'paying'), 0)::text as paying,
              coalesce(sum(c.creator_raw) filter (where c.status = 'paid'), 0)::text as paid,
              coalesce(sum(c.creator_raw) filter (where c.status = 'expired'), 0)::text as expired
         from public.arena_token_imports i
         left join public.import_creator_fees c on c.chain_id = i.chain_id and c.token_address = i.token_address
        where i.ownership_status = 'ownership_verified'
          and (i.project_owner_wallet = $1 or (i.chain_id <> 101 and lower(i.project_owner_wallet) = lower($1)))
        group by i.chain_id, i.token_address, i.name, i.symbol, i.image_url, i.ownership_verified_at
        order by i.ownership_verified_at desc nulls last
        limit 100`,
      [wallet],
    );
    res.setHeader("cache-control", "private, max-age=30");
    return json(res, 200, { ok: true, available: true, wallet, items: summarizeOwnerCreatorFees(rows) });
  } catch (error) {
    if (error?.code === "42P01" || error?.code === "42703") return json(res, 200, { ok: true, available: false, wallet, items: [] });
    console.error("[api/importCreatorFees owner]", error);
    return json(res, 500, { ok: false, error: "Creator earnings lookup failed" });
  }
}
