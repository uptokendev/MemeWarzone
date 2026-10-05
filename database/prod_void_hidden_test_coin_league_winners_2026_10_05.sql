-- Void the unpublished league winner rows whose prize comes only from activity on hidden test coins
-- (campaigns.meta.publicHidden). PRODUCTION (ellkfgoxnzykxqybajtn). Founder, 2026-10-05: keep test
-- data out of the leagues. Goes with PR feat/test-coins-out-of-leagues (settlement and the live boards
-- stop counting hidden coins from now on).
--
-- One transaction, idempotent: a second run voids 0 rows. Nothing on chain. Never touches a row with
-- a posted root (league_epoch_roots), a claim (league_epoch_claims), a payout (league_epoch_payouts)
-- or a category with paid money (league_epoch_paid_totals.paid_raw > 0).
--
-- A row counts as "from a hidden test coin" when:
--   biggest_hit / crowd_favorite / fastest_finish / perfect_run with a coin in the payload: that coin
--     is hidden;
--   fastest_finish / perfect_run without a coin: every graduation of the winner in the epoch is hidden;
--   top_earner: the winner traded in the epoch and every one of those trades is on a hidden coin;
--   mwl / championship: the token is a hidden coin.
--
-- Read on production 2026-10-05 (read-only): 23 winner rows come from hidden coins. 20 have a posted
-- root (Solana 101: 18, BNB 56 weekly 2026-08-17: 2) and stay as they are. Exactly 3 are unposted,
-- unclaimed and unpaid -- all on BNB monthly 2026-08, all to 0x348ff0aeafe45eed5dfe6c8ff581c2b652e4dc15:
--   biggest_hit  #1  BNBisTHeWay  0xa2bab122...  2899159664458 wei
--   biggest_hit  #2  StandbyFolks 0x36b2e5b7...  1811974790284 wei
--   top_earner   #2  (only traded the two coins above)  1811974790284 wei
-- After this, BNB monthly 2026-08 has no winner rows left (the two 0x1A36 rows were voided earlier into
-- league_epoch_winners_voided_20261005). Their money stays in the BNB MonthlyLeagueTreasury, unassigned.
--
-- Expected: doomed = 3 on the first run (0 on a re-run), deleted = 3, then checks 0 / 0 / 3.
begin;

create table if not exists public.league_epoch_winners_voided_20261005_testcoins (like public.league_epoch_winners including all);
alter table public.league_epoch_winners_voided_20261005_testcoins enable row level security;
revoke all on public.league_epoch_winners_voided_20261005_testcoins from anon, authenticated;

create temporary table doomed_testcoin_winners on commit drop as
with hidden_campaigns as (
  select chain_id, campaign_address, token_address, creator_address, graduated_at_chain
    from public.campaigns
   where lower(coalesce(meta->>'publicHidden', 'false')) in ('true', '1', 'yes', 'on')
), visible_campaigns as (
  select chain_id, campaign_address, token_address, creator_address, graduated_at_chain
    from public.campaigns
   where not lower(coalesce(meta->>'publicHidden', 'false')) in ('true', '1', 'yes', 'on')
)
select w.*
  from public.league_epoch_winners w
 where (
         case
           when w.category in ('biggest_hit', 'crowd_favorite', 'fastest_finish', 'perfect_run')
                and coalesce(w.payload->>'campaign_address', '') <> '' then
             exists (select 1 from hidden_campaigns h where h.chain_id = w.chain_id
                        and (case when w.chain_id in (101, 102) then h.campaign_address = w.payload->>'campaign_address'
                                  else lower(h.campaign_address) = lower(w.payload->>'campaign_address') end))
           when w.category in ('fastest_finish', 'perfect_run') then
             exists (select 1 from hidden_campaigns h where h.chain_id = w.chain_id and lower(h.creator_address) = lower(w.recipient_address)
                        and h.graduated_at_chain >= w.epoch_start and h.graduated_at_chain < w.epoch_end)
             and not exists (select 1 from visible_campaigns v where v.chain_id = w.chain_id and lower(v.creator_address) = lower(w.recipient_address)
                        and v.graduated_at_chain >= w.epoch_start and v.graduated_at_chain < w.epoch_end)
           when w.category = 'top_earner' then
             exists (select 1 from public.curve_trades t where t.chain_id = w.chain_id and lower(t.wallet) = lower(w.recipient_address)
                        and t.block_time >= w.epoch_start and t.block_time < w.epoch_end)
             and not exists (select 1 from public.curve_trades t
                               join visible_campaigns v on v.chain_id = t.chain_id and v.campaign_address = t.campaign_address
                              where t.chain_id = w.chain_id and lower(t.wallet) = lower(w.recipient_address)
                                and t.block_time >= w.epoch_start and t.block_time < w.epoch_end)
           when w.category in ('mwl', 'championship') then
             exists (select 1 from hidden_campaigns h where h.chain_id = w.chain_id
                        and lower(coalesce(h.token_address, '')) = lower(w.payload->>'tokenAddress'))
           else false
         end
       )
   and not exists (select 1 from public.league_epoch_roots r
                    where r.chain_id = w.chain_id and r.period = w.period and r.epoch_start = w.epoch_start)
   and not exists (select 1 from public.league_epoch_claims c
                    where c.chain_id = w.chain_id and c.period = w.period and c.epoch_start = w.epoch_start and c.category = w.category and c.rank = w.rank)
   and not exists (select 1 from public.league_epoch_payouts p
                    where p.chain_id = w.chain_id and p.period = w.period and p.epoch_start = w.epoch_start and p.category = w.category and p.rank = w.rank)
   and not exists (select 1 from public.league_epoch_paid_totals pt
                    where pt.chain_id = w.chain_id and pt.period = w.period and pt.epoch_start = w.epoch_start and pt.category = w.category and pt.paid_raw > 0);

-- Stop if the set is not the one read on 2026-10-05 (3 rows, or 0 on a re-run).
do $$
declare n int; unexpected int;
begin
  select count(*) into n from doomed_testcoin_winners;
  select count(*) into unexpected from doomed_testcoin_winners
   where not (chain_id = 56 and period = 'monthly' and epoch_start = '2026-08-01T00:00:00Z'
              and lower(recipient_address) = '0x348ff0aeafe45eed5dfe6c8ff581c2b652e4dc15'
              and ((category = 'biggest_hit' and rank in (1, 2)) or (category = 'top_earner' and rank = 2)));
  if unexpected > 0 or n not in (0, 3) then
    raise exception 'unexpected hidden-test-coin winner set: % rows, % outside the expected 3; nothing changed', n, unexpected;
  end if;
  raise notice 'voiding % row(s)', n;
end $$;

insert into public.league_epoch_winners_voided_20261005_testcoins select * from doomed_testcoin_winners
on conflict do nothing;

delete from public.league_epoch_winners w
 using doomed_testcoin_winners d
 where d.chain_id = w.chain_id and d.period = w.period and d.epoch_start = w.epoch_start
   and d.category = w.category and d.rank = w.rank and d.recipient_address = w.recipient_address
   and not exists (select 1 from public.league_epoch_roots r
                    where r.chain_id = w.chain_id and r.period = w.period and r.epoch_start = w.epoch_start);

-- Checks (expect: 0, 0, 3).
select count(*) as bnb_monthly_2026_08_winners_left from public.league_epoch_winners
 where chain_id = 56 and period = 'monthly' and epoch_start = '2026-08-01T00:00:00Z';
select count(*) as unposted_rows_to_0x348f_left from public.league_epoch_winners w
 where lower(w.recipient_address) = '0x348ff0aeafe45eed5dfe6c8ff581c2b652e4dc15'
   and not exists (select 1 from public.league_epoch_roots r where r.chain_id = w.chain_id and r.period = w.period and r.epoch_start = w.epoch_start);
select count(*) as voided_testcoin_backup from public.league_epoch_winners_voided_20261005_testcoins;

commit;
