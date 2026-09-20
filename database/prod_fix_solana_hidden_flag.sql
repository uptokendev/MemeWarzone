-- Stop every new Solana campaign being marked publicHidden, without unhiding
-- the ones that are meant to stay hidden.
--
-- What was happening, reproduced in a rolled-back transaction against
-- production:
--
--   1. The indexer inserts a new campaign under a placeholder name. Builds
--      before af64ef30 (2026-09-17) used 'Solana Launch' / 'SOL'.
--   2. The trigger mwz_hide_archived_solana_tests matches that exact pair and
--      sets is_active = false and meta.publicHidden = true.
--   3. The registry then renames the row to the creator's real name and sets
--      is_active back to true. The trigger does not match the new name, so it
--      does nothing — and it has no branch that ever clears publicHidden.
--
--   Final state: is_active = true, publicHidden = true. The campaign trades but
--   never appears on Explore, and nothing in the application code mentions the
--   flag, so there is no obvious place to look.
--
-- That is why all 28 Solana campaigns carry it, including Kaiju88, whose
-- absence from Explore was originally read as an indexing failure.
--
-- The trigger was written to hide a batch of test launches that shared those
-- placeholder names. It is the wrong shape for that job: it fires on UPDATE as
-- well as INSERT, and it writes a permanent flag no code path removes, so one
-- unlucky rename marks a campaign invisible forever. The rows it was meant to
-- hide are already flagged and stay flagged after this runs — dropping it
-- removes the mechanism, not the result.
--
-- Deploying the current indexer also stops it matching, because the placeholder
-- is now `Solana <first four of mint>`. Both are worth doing: the deploy stops
-- today's cause, this stops the next one.

begin;

\echo '--- before: Solana campaigns by hidden flag ---'
select coalesce(meta->>'publicHidden', '(unset)') as public_hidden,
       count(*)
  from public.campaigns
 where chain_id = 101
 group by 1
 order by 1;

drop trigger if exists mwz_hide_archived_solana_tests_row on public.campaigns;
drop function if exists public.mwz_hide_archived_solana_tests();

\echo '--- after: flags are unchanged, the trigger is gone ---'
select coalesce(meta->>'publicHidden', '(unset)') as public_hidden,
       count(*)
  from public.campaigns
 where chain_id = 101
 group by 1
 order by 1;

select count(*) as triggers_remaining
  from pg_trigger
 where tgrelid = 'public.campaigns'::regclass
   and not tgisinternal;

commit;
