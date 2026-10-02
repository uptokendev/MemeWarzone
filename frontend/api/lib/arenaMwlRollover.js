// Major War League month rollover. Nothing closed a month on its own: only the admin POST
// /arena/league/finalize did, so on 2026-10-02 every chain still served September as live and a
// settled battle wrote its October points into September. The realtime worker runs this every
// minute; ensureActiveSeason refuses an ended month until it has run (MWL_ROLLOVER_PENDING).
import { pool as defaultPool } from "../../server/db.js";
import { finalizeMwlForChampionship } from "./arenaQuarterlyChampionship.js";
import { ensureActiveSeason } from "./arenaLeagueScore.js";
import { mwlSeasonMonthEnded } from "./arenaLeagueScoreMath.js";
import {
  MwlIdentityError,
  canonicalMwlMonth,
  resolveMwlTreasuryAssociation,
} from "./arenaMwlChainIdentity.mjs";

// The treasury identity row for a finalized month. Moved here unchanged from arenaLeague.js so the
// admin route and the rollover write it the same way.
export async function recordMwlFinalization(db, season, treasury) {
  const period = canonicalMwlMonth({ chainId: season.chain_id, year: season.year, month: season.month });
  if (!treasury.configured || !treasury.treasuryId || !treasury.configKey) {
    throw new MwlIdentityError("MWL_TREASURY_NOT_CONFIGURED", "Chain-scoped Major War League Treasury is not configured", 503);
  }
  await db.query(
    `insert into public.arena_mwl_finalizations (
       season_id, chain_id, year, month, month_id, treasury_id, treasury_config_key,
       reserve_share_bps, result_version, entitlement_identity_version, finalized_at
     ) values ($1,$2,$3,$4,$5,$6,$7,6000,'mwl_result_v1','mwl_entitlement_v1',now())
     on conflict (season_id) do nothing`,
    [season.id, Number(season.chain_id), Number(season.year), Number(season.month), period.monthId, treasury.treasuryId, treasury.configKey],
  );
  const result = await db.query(`select * from public.arena_mwl_finalizations where season_id = $1 limit 1`, [season.id]);
  const authority = result.rows[0];
  if (!authority
      || Number(authority.chain_id) !== Number(season.chain_id)
      || String(authority.month_id) !== period.monthId
      || String(authority.treasury_id) !== treasury.treasuryId
      || Number(authority.reserve_share_bps) !== 6000) {
    throw new MwlIdentityError("MWL_FINALIZATION_IDENTITY_MISMATCH", "Persisted Major War League finalization identity does not match request", 409);
  }
  return authority;
}

/**
 * Finalize every active monthly MWL whose month has ended, then open the current month on that
 * chain. Closing the month does not wait for the treasury env: the result snapshot is what matters
 * and it is frozen either way. The treasury identity row is written when the env is set, and the
 * admin finalize route (explicit seasonId, idempotent) records it later otherwise.
 */
export async function rolloverEndedMwlSeasons({
  pool = defaultPool,
  now = new Date(),
  finalize = finalizeMwlForChampionship,
  openSeason = ensureActiveSeason,
  recordFinalization = recordMwlFinalization,
  treasuryFor = resolveMwlTreasuryAssociation,
} = {}) {
  const active = await pool.query(
    `select * from public.arena_league_seasons
      where active = true and month is not null
      order by chain_id asc, year asc, month asc`,
  );
  const outcomes = [];
  for (const season of active.rows || []) {
    if (!mwlSeasonMonthEnded(season, now)) continue;
    const outcome = { seasonId: String(season.id), chainId: Number(season.chain_id), finalized: false };
    outcomes.push(outcome);
    try {
      const result = await finalize(pool, season.id);
      if (!result?.ok) {
        outcome.reason = result?.reason || "finalize-refused";
        continue;
      }
      outcome.finalized = true;
      outcome.winner = result.mwlWinner?.token_address || null;
      const treasury = treasuryFor(season.chain_id);
      if (treasury.configured) {
        await recordFinalization(pool, season, treasury);
        outcome.treasuryRecorded = true;
      } else {
        outcome.treasuryRecorded = false;
        outcome.treasuryNote = "MWL_TREASURY_NOT_CONFIGURED";
      }
      const next = await openSeason(season.chain_id, pool);
      outcome.openedSeasonId = next?.id ? String(next.id) : null;
    } catch (error) {
      outcome.reason = error?.code || error?.message || String(error);
    }
  }
  return outcomes;
}
