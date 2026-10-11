/**
 * League SQL for generation 8 rows of curve_trades (venue 'gen8', written by the gen-8 indexer at the graduation
 * block split, D14). Used by league.js only where gen-8 is configured for the chain, so the SQL of every other chain
 * is unchanged; realtime-indexer/src/rewards/leagueLeaderboard.ts (settlement) applies the same expressions, so the
 * board shows what settlement pays.
 *
 *   amount   gen-8 rows store HookFee.curveAmount (the curve amount, fee excluded). Every older EVM row stores the
 *            trader-side amount (buy: cost + fee, sell: payout - fee). The leagues compare trader-side amounts, so a
 *            gen-8 buy is curve + fee and a gen-8 sell is curve - fee (the indexer's traderNative()).
 *   rows     a gen-8 row the indexer marked league_excluded (the creator's own trades, escrow buys, the creator's
 *            first buy through the launcher, creator-choice vault buybacks) counts for no trader league.
 *   pot      the league share of a gen-8 trade is fee_raw x leagueFeeBps / protocolFeeBps (37.5% of the fee the hook
 *            took, launch-window rates included), the rule finalizeEpochWinners applies to every row with fee_raw.
 *   netting  (audit D-L2) a gen-8 swap needs no capital to repeat inside one transaction, so the trader boards read
 *            gen8NettedCurveTradesSql() in place of curve_trades: all gen-8 swaps of one coin by one wallet (tx.from)
 *            in one transaction become one row of the net trader-side amount. The pot is not netted (every leg
 *            paid its fee).
 */
import { GEN8_CURVE_VENUE } from "../../shared/evmGen8.mjs";

const isGen8 = (a) => `coalesce(${a}.venue, '') = '${GEN8_CURVE_VENUE}'`;

/** Trader-side native amount (numeric) of a curve_trades row. */
export function gen8TraderNativeRawSql(alias = "t") {
  return `(case when ${isGen8(alias)} and ${alias}.fee_raw is not null
      then ${alias}.bnb_amount_raw::numeric + (case when ${alias}.side = 'buy' then ${alias}.fee_raw::numeric else -${alias}.fee_raw::numeric end)
      else ${alias}.bnb_amount_raw::numeric end)`;
}

/** Condition (no leading AND) that keeps every row except gen-8 rows marked league_excluded. */
export function gen8LeagueRowKeepSql(alias = "t") {
  return `NOT (${isGen8(alias)} AND coalesce(${alias}.league_excluded, false))`;
}

/** The recorded fee of a gen-8 row, NULL for every other row (pot branch). */
export function gen8PotFeeRawSql(alias = "t") {
  return `(case when ${isGen8(alias)} then ${alias}.fee_raw::numeric end)`;
}

/**
 * A FROM item (with `alias`) that replaces `curve_trades <alias>` on the trader boards (audit D-L2, wash netting).
 *
 * Every row that is not gen-8 passes through as it is. Gen-8 rows are grouped by (chain, coin, tx, wallet = tx.from,
 * league_excluded) and become one row: net = sum(buy trader-side) - sum(sell trader-side); side 'buy' when net > 0,
 * 'sell' when net < 0, amount |net|; a net of 0 leaves no row. Rows the indexer marked league_excluded are never
 * netted against counted rows (they form their own group and stay marked, so gen8LeagueRowKeepSql still drops them
 * where it applies). The netted row keeps the transaction's block_number / block_time and the last leg's log_index.
 * Its bnb_amount_raw is already trader-side and fee_raw is NULL, so gen8TraderNativeRawSql returns it unchanged.
 * A single gen-8 swap in a transaction comes out with the same side and trader-side amount as before.
 *
 * Columns: chain_id, campaign_address, tx_hash, log_index, block_number, block_time, side, wallet,
 * bnb_amount_raw (numeric), venue, fee_raw, league_excluded. Only for SQL that reads no other curve_trades column.
 */
export function gen8NettedCurveTradesSql(alias = "t") {
  return `(
        SELECT x.chain_id, x.campaign_address, x.tx_hash, x.log_index, x.block_number, x.block_time, x.side, x.wallet,
               x.bnb_amount_raw::numeric AS bnb_amount_raw, x.venue, x.fee_raw::numeric AS fee_raw, x.league_excluded
        FROM public.curve_trades x
        WHERE NOT ${isGen8("x")}
        UNION ALL
        SELECT n.chain_id, n.campaign_address, n.tx_hash, n.log_index, n.block_number, n.block_time,
               CASE WHEN n.net_raw > 0 THEN 'buy' ELSE 'sell' END AS side, n.wallet,
               abs(n.net_raw) AS bnb_amount_raw, '${GEN8_CURVE_VENUE}' AS venue, NULL::numeric AS fee_raw, n.league_excluded
        FROM (
          SELECT g.chain_id, g.campaign_address, g.tx_hash, g.wallet, g.block_number, g.block_time,
                 coalesce(g.league_excluded, false) AS league_excluded,
                 max(g.log_index) AS log_index,
                 sum(CASE WHEN g.side = 'buy' THEN ${gen8TraderNativeRawSql("g")} ELSE -${gen8TraderNativeRawSql("g")} END) AS net_raw
          FROM public.curve_trades g
          WHERE ${isGen8("g")}
          GROUP BY g.chain_id, g.campaign_address, g.tx_hash, g.wallet, g.block_number, g.block_time, coalesce(g.league_excluded, false)
        ) n
        WHERE n.net_raw <> 0
      ) ${alias}`;
}
