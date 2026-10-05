-- Detach the founders' test recruiters and our own wallets from recruiters; void what they could
-- still be paid that is not yet published. PRODUCTION (ellkfgoxnzykxqybajtn). Founder, 2026-10-05:
-- "Exclude all owner wallets from leagues and recruiters ... unlink squad members (usually all our
-- wallets)." Goes with PR feat/exclude-owner-wallets (code stops new wins/credit/links).
--
-- One transaction, idempotent: a second run changes 0 rows. Nothing on chain. Never touches a
-- claimed/paid row, a published recruiter batch or a posted league root.
--
-- Test recruiters (recruiters.id): 1, 16, 107, 108, 114, 124 -- all share the founder's signup email
-- (a dashboard operations admin), and 1 / 107 / 108 / 114 / 124 sign up with one of our keys.
-- 29 and 115 are NOT in here: see the separate "check first" block at the end.
--
-- Counts read on production 2026-10-05 (read-only) are the expected row counts below.
begin;

create temporary table owner_wallets_20261005 (address text primary key) on commit drop;
insert into owner_wallets_20261005 (address) values
  ('9yn7wy8svwoengegs2oq7undyrdcfg9uduqr7twpef8h'),
  ('hukfofuuwxc5qfzxzr5dbax4s7w4vjuw8ahv9ld4c2j9'),
  ('3d2tamczwzk7sbb2l7nynirclxachx6owlnyn8vgwkfj'),
  ('fk5yywb4ppwbfqme8yrugirmsanfhggpp3gjfmbbfgv'),
  ('c43ddmgt3ic9ptehlyiqvtutfaxc7u2v3d7kyzdf5yzy'),
  ('e8bpqi8vdjdjjmf4hv8vkwgrqu6eludpbppvzsdxy9iq'),
  ('eghzwuxmhdreigbttzw2uuphegapsfj5bwevbutfzxtn'),
  ('2amfraxs9182aeswwrz2trvuxpqxauot4wv1oavjstrb'),
  ('7hkqd798z1ermruhm7shmstb1v13fqnndlqtyjzbujuz'),
  ('8reczxrzzmzpp3maubs8twftazcjxctydwnkhlsdwarv'),
  ('bzd4tfo8gdurvggjkxwfqrjbwyqps634m4yh5zskqcgf'),
  ('5pktjvsfej9jccfwbhczxzvshbipvfivxwvev273sfnc'),
  ('crmw8dwu1tyy7ykwvznqo7uy63cqhdxbzsupr8vz9e7t'),
  ('3nwtsxixur3ejjpsntsvj62evxtd4exhyvdop6turory'),
  ('akdt8o6ibzvjpui5xovmdvmhm6xkxch7dijqpu3srsd8'),
  ('c1ucuiheok1qjbde8dae6wvmehdumi6rx9vahnwljzha'),
  ('4t7q9fkgnue1nsb8xxgwwj4q1oxe6pv854upjznddz3n'),
  ('az9ykxdx9b3oh4mrhyfswvmppuhqlbyftik1kuiqw3c'),
  ('fpt1easa83zjf1s8fygj1uhzddqysfuawkar9jbnkxuj'),
  ('ewpx5nj1cj1vaxw1wx4yjzdmt8u8lud7r7sbsmgughem'),
  ('4ajt4lkvuf9mrgopn4kisznkkqwipw7jbmujckbehy8j'),
  ('bvqhb6qq22zhavupxaaeizbarhgpuu5t3i8y3ebz2que'),
  ('68fnnexdmau8xajsnyl4vfy2ynprne36lcnccm8uryjg'),
  ('0x77f96a7d3bea7a090aacbd00a50002d2b9ae0714'),
  ('0x1a367016f10b230e28cf1abda2594c47bf60fe34'),
  ('0x13ad79765e14927df2c554d9662bbe539e89c8e8'),
  ('0x1edcedf5e5d9c2fad5f9f6b964077dd74020a7a7'),
  ('0xab2789a8b226ba0655e2ce4824c572df1208fdaa'),
  ('0xdcf07eb07e6d6722c246161e7530dc905f9eaa50'),
  ('0x4cb68c7e131ef7855b2ceee1b99cc163dfd47810'),
  ('0xd66f443a02c553cd7a50b74fdc8ac130d9fbd5e6'),
  ('0x20652bdb1d986220fec30f4733587f279403e773'),
  ('0x632061ca786f7b585bbd46a792fda92b02f70671');

create temporary table test_recruiters_20261005 (id bigint primary key) on commit drop;
insert into test_recruiters_20261005 (id) values (1), (16), (107), (108), (114), (124);

-- 1) Recruiter links. Expected: 5 rows (recruiter 1: 3 incl. our BNB testnet deployer key 0x13ad...,
--    recruiter 107: 2). 114's six were detached on 2026-10-04; 16 / 108 / 124 have none.
update public.wallet_recruiter_links l
   set is_active = false,
       detached_at = coalesce(l.detached_at, now()),
       detach_reason = coalesce(l.detach_reason, 'owner wallet / founder test recruiter (2026-10-05)'),
       updated_at = now()
 where l.is_active
   and (l.recruiter_id in (select id from test_recruiters_20261005)
        or lower(l.wallet_address) in (select address from owner_wallets_20261005));

-- 2) Squad memberships (the recruiter league counts these). Expected: 11 rows
--    (recruiter 1: 3, recruiter 107: 2, recruiter 114: 6 -- 9YN7, 4AjT, 8rEcz, 2AMf, 3Syu, Bop7).
update public.wallet_squad_memberships s
   set is_active = false,
       left_at = coalesce(s.left_at, now()),
       leave_reason = coalesce(s.leave_reason, 'owner wallet / founder test recruiter (2026-10-05)'),
       updated_at = now()
 where s.is_active
   and (s.recruiter_id in (select id from test_recruiters_20261005)
        or lower(s.wallet_address) in (select address from owner_wallets_20261005));

-- 3) Recruiter ledger rows still open and not in a published batch -> failed. Expected: 0 rows.
--    (114's last open row, 10000 lamports, is in a claim_open recruiter batch: published, left alone.
--    No other test or owner account has an open row.)
update public.recruiter_reward_ledger l
   set status = 'failed',
       metadata = coalesce(l.metadata, '{}'::jsonb) || jsonb_build_object('voidedReason', 'owner wallet / founder test recruiter (2026-10-05)', 'voidedAt', now()),
       updated_at = now()
 where l.status in ('claimable', 'retriable', 'pending', 'pending_finality', 'created', 'submitted')
   and l.recruiter_id in (
         select a.recruiter_id from public.recruiter_accounts a
          where a.code in (select r.code from public.recruiters r where r.id in (select id from test_recruiters_20261005))
             or lower(a.signup_wallet) in (select address from owner_wallets_20261005)
             or exists (select 1 from public.recruiter_payout_wallets w
                         where w.recruiter_id = a.recruiter_id and lower(w.wallet_address) in (select address from owner_wallets_20261005)))
   and (l.claim_id is null or not exists (
         select 1 from public.recruiter_reward_claims c where c.id = l.claim_id and (c.status in ('claimed', 'paid', 'confirmed') or c.tx_hash is not null)))
   and (l.claim_id is null or not exists (
         select 1 from public.solana_reward_lane_claims lc
           join public.solana_reward_lane_batches b on b.id = lc.batch_id
          where lc.source_ref = l.claim_id::text and b.status <> 'failed'));

-- 4) League prizes to our wallets whose epoch root is NOT posted -> removed (kept in a backup table).
--    Expected: 2 rows, both BNB (56) monthly 2026-08 to the BNB factory deployer 0x1a36...:
--    top_earner #1 and crowd_favorite #1, 2899159664458 wei each (5798319328916 wei total).
--    Their money stays in the monthly vault, unassigned; the other 3 leaves of that month are
--    unchanged (ranks are not renumbered, so no amount moves to anyone). Every other prize on one of
--    our wallets has a posted root and cannot change: it simply stays unclaimed.
create table if not exists public.league_epoch_winners_voided_20261005 (like public.league_epoch_winners including all);

with doomed as (
  select w.* from public.league_epoch_winners w
   where lower(w.recipient_address) in (select address from owner_wallets_20261005)
     and not exists (select 1 from public.league_epoch_roots r
                      where r.chain_id = w.chain_id and r.period = w.period and r.epoch_start = w.epoch_start)
     and not exists (select 1 from public.league_epoch_claims c
                      where c.chain_id = w.chain_id and c.period = w.period and c.epoch_start = w.epoch_start and c.category = w.category and c.rank = w.rank)
     and not exists (select 1 from public.league_epoch_payouts p
                      where p.chain_id = w.chain_id and p.period = w.period and p.epoch_start = w.epoch_start and p.category = w.category and p.rank = w.rank)
)
insert into public.league_epoch_winners_voided_20261005 select * from doomed
on conflict do nothing;

delete from public.league_epoch_winners w
 using public.league_epoch_winners_voided_20261005 v
 where v.chain_id = w.chain_id and v.period = w.period and v.epoch_start = w.epoch_start
   and v.category = w.category and v.rank = w.rank and v.recipient_address = w.recipient_address
   and not exists (select 1 from public.league_epoch_roots r
                    where r.chain_id = w.chain_id and r.period = w.period and r.epoch_start = w.epoch_start);

-- Checks (expect: 0, 0, 0, 2).
select count(*) as active_links_left from public.wallet_recruiter_links l
 where l.is_active and (l.recruiter_id in (select id from test_recruiters_20261005) or lower(l.wallet_address) in (select address from owner_wallets_20261005));
select count(*) as active_squad_left from public.wallet_squad_memberships s
 where s.is_active and (s.recruiter_id in (select id from test_recruiters_20261005) or lower(s.wallet_address) in (select address from owner_wallets_20261005));
select count(*) as unposted_owner_prizes_left from public.league_epoch_winners w
 where lower(w.recipient_address) in (select address from owner_wallets_20261005)
   and not exists (select 1 from public.league_epoch_roots r where r.chain_id = w.chain_id and r.period = w.period and r.epoch_start = w.epoch_start);
select count(*) as voided_prizes_backup from public.league_epoch_winners_voided_20261005;

commit;

-- ---------------------------------------------------------------------------------------------
-- CHECK FIRST (not run by the block above). Read-only today: neither has anything to detach.
--   29  "svenvth": prelaunch OG; signup wallet 0x587f...; its two links (its own wallet and
--       0x3e23..., the signup wallet of founder recruiter 16) were detached on 2026-05-16;
--       0 active links, 0 active squad, no recruiter account, no ledger rows. Different signup email.
--   115 "therealmwzt": same signup email as the founder's recruiters; same signup wallet 0x105b...
--       as recruiter account "therealmwzte". 0 active links, 0 active squad, no ledger rows.
-- If you confirm them as test: run the two updates above with test_recruiters_20261005 = (29), (115)
-- (expected 0 rows each today), and add their signup wallets to OWNER_WALLETS so the code treats
-- them as internal from now on.
