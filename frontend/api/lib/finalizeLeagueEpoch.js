/**
 * Closed-epoch standings must freeze into league_epoch_winners so Claims
 * reads the same wallets/ranks as Previous Week League.
 * Weekly: 1 winner per category. Monthly: top 5.
 * Idempotent: ON CONFLICT DO NOTHING.
 */

const WEEKLY_RANKS = 1;
const MONTHLY_RANKS = 5;
const SPLIT_BPS = [4000, 2500, 1500, 1200, 800];

function isSolana(chainId) {
  return Number(chainId) === 101 || Number(chainId) === 102;
}

function preserveWallet(value, chainId) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return isSolana(chainId) ? raw : raw.toLowerCase();
}

function recipientFromRow(category, row, chainId) {
  if (category === "biggest_hit") return preserveWallet(row.buyer_address || row.wallet || row.recipient_address, chainId);
  if (category === "top_earner") return preserveWallet(row.wallet || row.recipient_address, chainId);
  return preserveWallet(row.creator_address || row.wallet || row.recipient_address, chainId);
}

function payloadFromRow(category, row, rank, amountRaw, chainId) {
  const recipient = recipientFromRow(category, row, chainId);
  return {
    ...row,
    rank,
    amount_raw: amountRaw,
    wallet: recipient,
    recipient_address: recipient,
    buyer_address: row.buyer_address || (category === "biggest_hit" ? recipient : row.buyer_address),
  };
}

function wantRanks(period) {
  return period === "monthly" ? MONTHLY_RANKS : WEEKLY_RANKS;
}

function splitPot(pot, period) {
  const total = BigInt(String(pot || "0"));
  if (period === "weekly") return [total.toString()];
  const parts = SPLIT_BPS.map((bps) => (total * BigInt(bps)) / 10000n);
  const sum = parts.reduce((a, b) => a + b, 0n);
  parts[0] = parts[0] + (total - sum);
  return parts.map((v) => v.toString());
}

export async function readFinalizedCategory(pool, { chainId, period, epochStartIso, category }) {
  if (!pool || !epochStartIso) return null;
  try {
    const { rows } = await pool.query(
      `SELECT rank, recipient_address AS "recipientAddress", amount_raw AS "amountRaw",
              payload, meta, epoch_end AS "epochEnd"
         FROM public.league_epoch_winners
        WHERE chain_id = $1 AND period = $2 AND epoch_start = $3::timestamptz AND category = $4
        ORDER BY rank ASC`,
      [chainId, period, epochStartIso, category],
    );
    if (!rows.length) return null;
    return {
      items: rows.map((row) => {
        const payload = row.payload && typeof row.payload === "object" ? row.payload : row.meta && typeof row.meta === "object" ? row.meta : {};
        return {
          ...payload,
          rank: Number(row.rank),
          recipient_address: row.recipientAddress,
          wallet: payload.wallet || row.recipientAddress,
          buyer_address: payload.buyer_address || (category === "biggest_hit" ? row.recipientAddress : payload.buyer_address),
          amount_raw: String(row.amountRaw ?? payload.amount_raw ?? "0"),
          finalized: true,
        };
      }),
      source: "league_epoch_winners",
    };
  } catch (error) {
    if (error?.code === "42P01" || error?.code === "42703") return null;
    throw error;
  }
}

export async function persistFinalizedCategory(pool, {
  chainId,
  period,
  epochStartIso,
  epochEndIso,
  category,
  rows,
  prize,
}) {
  if (!pool || !epochStartIso || !Array.isArray(rows) || !rows.length) return 0;
  const ranks = wantRanks(period);
  const pot = prize?.availablePotRaw || prize?.potRaw || "0";
  const payouts = Array.isArray(prize?.availablePayoutsRaw) && prize.availablePayoutsRaw.length
    ? prize.availablePayoutsRaw.map(String)
    : splitPot(pot, period);
  const expiresAt = epochEndIso ? new Date(new Date(epochEndIso).getTime() + 90 * 86400_000).toISOString() : null;
  let inserted = 0;
  for (let rank = 1; rank <= ranks; rank += 1) {
    const row = rows[rank - 1];
    if (!row) break;
    const recipient = recipientFromRow(category, row, chainId);
    if (!recipient) continue;
    const amountRaw = payouts[rank - 1] || "0";
    const payload = payloadFromRow(category, row, rank, amountRaw, chainId);
    try {
      const res = await pool.query(
        `INSERT INTO public.league_epoch_winners (
           chain_id, period, epoch_start, epoch_end, category, rank,
           recipient_address, amount_raw, expires_at, meta, payload
         ) VALUES (
           $1, $2, $3::timestamptz, $4::timestamptz, $5, $6,
           $7, $8::numeric, $9::timestamptz, $10::jsonb, $10::jsonb
         )
         ON CONFLICT (chain_id, period, epoch_start, category, rank) DO NOTHING`,
        [
          chainId,
          period,
          epochStartIso,
          epochEndIso,
          category,
          rank,
          recipient,
          amountRaw,
          expiresAt,
          JSON.stringify(payload),
        ],
      );
      inserted += res.rowCount || 0;
    } catch (error) {
      if (error?.code === "42P01" || error?.code === "42703") return inserted;
      throw error;
    }
  }
  try {
    await pool.query(
      `INSERT INTO public.league_epoch_meta (
         chain_id, period, epoch_start, epoch_end,
         protocol_fee_bps, league_fee_bps, total_league_fee_raw,
         league_count, winners, split_bps
       ) VALUES (
         $1, $2, $3::timestamptz, $4::timestamptz,
         $5, $6, $7::numeric, $8, $9, $10::int[]
       )
       ON CONFLICT (chain_id, period, epoch_start) DO UPDATE SET
         epoch_end = excluded.epoch_end,
         total_league_fee_raw = excluded.total_league_fee_raw,
         computed_at = now()`,
      [
        chainId,
        period,
        epochStartIso,
        epochEndIso,
        Number(prize?.protocolFeeBps || 200),
        Number(prize?.leagueFeeBps || 75),
        String(prize?.totalLeagueFeeRaw || "0"),
        Number(prize?.leagueCount || (period === "monthly" ? 5 : 4)),
        ranks,
        SPLIT_BPS,
      ],
    );
  } catch (error) {
    if (error?.code !== "42P01" && error?.code !== "42703") {
      console.warn("[finalizeLeagueEpoch] meta skipped", error?.message || error);
    }
  }
  return inserted;
}
