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
