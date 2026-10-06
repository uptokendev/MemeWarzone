/**
 * Vote time windows counted at read time.
 *
 * vote_aggregates (and arena_vote_aggregates) are rewritten only when a new vote lands for that
 * coin, so their 1h / 24h / 7d counts and trending score never decay: KAIJU88's one vote from
 * 2026-09-26 still read "1 / 24h" on 2026-10-06. Readers take the windows from these joins instead.
 * The stored all-time count and last_vote_at do not decay and stay as stored.
 *
 * The windows and the 1 / 0.5 / 0.25 trending weights are the ones patchVoteAggregates writes
 * (api/votes-ingest.js, api/dev-fix/solana-vote-ingest.js, realtime-indexer/src/indexer.ts), and the
 * address match covers both: EVM stores lowercase, Solana stores base58 as given.
 */
export function liveVoteWindowsJoin(chainIdExpr, campaignExpr, alias = "vw") {
  return `LEFT JOIN LATERAL (
       SELECT
         count(*) FILTER (WHERE lv.block_timestamp >= now() - interval '1 hour')::int AS votes_1h,
         count(*) FILTER (WHERE lv.block_timestamp >= now() - interval '24 hours')::int AS votes_24h,
         count(*)::int AS votes_7d,
         (
           count(*) FILTER (WHERE lv.block_timestamp >= now() - interval '24 hours') * 1.0
           + count(*) FILTER (
               WHERE lv.block_timestamp < now() - interval '24 hours'
                 AND lv.block_timestamp >= now() - interval '48 hours'
             ) * 0.5
           + count(*) FILTER (
               WHERE lv.block_timestamp < now() - interval '48 hours'
                 AND lv.block_timestamp >= now() - interval '72 hours'
             ) * 0.25
         ) AS trending_score
       FROM public.votes lv
       WHERE lv.chain_id = ${chainIdExpr}
         AND (lv.campaign_address = ${campaignExpr} OR lower(lv.campaign_address) = lower(${campaignExpr}))
         AND lv.status = 'confirmed'
         AND lv.block_timestamp >= now() - interval '7 days'
     ) ${alias} ON true`;
}

/** The arena board's 24h window, as patchArenaAggregates (api/arenaVotes.js) counts it. */
export function liveArenaVotes24hJoin(chainIdExpr, tokenExpr, alias = "avw") {
  return `LEFT JOIN LATERAL (
       SELECT count(*)::int AS votes_24h
       FROM public.arena_votes lav
       WHERE lav.chain_id = ${chainIdExpr}
         AND lower(lav.token_address) = lower(${tokenExpr})
         AND coalesce(lav.block_timestamp, lav.created_at) >= now() - interval '24 hours'
     ) ${alias} ON true`;
}
