\set ON_ERROR_STOP on

-- This script runs only against the disposable CI database.
-- The advertising row is created before the Event Sponsorship migrations and
-- must survive byte-for-byte in the fields asserted below.

do $$
begin
  if to_regclass('public.sponsor_profiles') is null
     or to_regclass('public.sponsorship_events') is null
     or to_regclass('public.sponsorship_payment_quotes') is null
     or to_regclass('public.sponsorship_payments') is null
     or to_regclass('public.event_sponsorships') is null
     or to_regclass('public.event_sponsorship_applications') is null
     or to_regclass('public.event_sponsorship_audit_log') is null
     or to_regclass('public.event_sponsorship_founding_history') is null then
    raise exception 'required Event Sponsorship schema is incomplete';
  end if;

  if to_regclass('public.sponsorship_applications') is null then
    raise exception 'advertising sponsorship_applications was lost';
  end if;

  if not exists (
    select 1 from public.sponsorship_applications
    where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid
      and project_name = 'Advertising control row'
      and contact_name = 'Control Contact'
      and contact_channel = 'control@example.invalid'
      and website_url = 'https://example.invalid/ad-control'
      and bio = 'Must survive Event Sponsorship migrations unchanged.'
      and preferred_slot = 'homepage-sponsored-rail'
      and status = 'submitted'
  ) then
    raise exception 'representative advertising row changed during Event Sponsorship migration';
  end if;
end $$;

insert into public.sponsor_profiles(
  id, project_name, wallet, verified_wallet, status, approved_at
) values (
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'Schema Proof Sponsor',
  '0x1111111111111111111111111111111111111111',
  '0x1111111111111111111111111111111111111111',
  'approved',
  now()
);

insert into public.sponsorship_events(
  id, event_type, event_reference_id, chain_id, starts_at, ends_at,
  sponsorship_open, prize_native_raw, sponsorship_prize_native_raw
) values (
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'normal_tournament',
  'schema-proof-normal-tournament',
  56,
  now(),
  now() + interval '1 day',
  true,
  0,
  0
);

insert into public.event_sponsorship_applications(
  id, event_id, chain_id, sponsor_profile_id, sponsor_wallet, status,
  brand_name, approved_at
) values (
  'dddddddd-dddd-dddd-dddd-dddddddddddd',
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  56,
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  '0x1111111111111111111111111111111111111111',
  'approved',
  'Schema Proof Sponsor',
  now()
);

insert into public.sponsorship_payment_quotes(
  id, event_id, chain_id, sponsor_profile_id, sponsor_wallet, pricing_tier_id,
  pricing_version, minimum_usd_cents, requested_usd_cents,
  requested_native_raw, minimum_native_raw, native_usd_reference_micro_cents,
  oracle_timestamp, expires_at, nonce, event_sponsorship_application_id
) values (
  'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  56,
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  '0x1111111111111111111111111111111111111111',
  null,
  1,
  10000,
  10000,
  1001,
  1001,
  100000000,
  now(),
  now() + interval '1 hour',
  1,
  'dddddddd-dddd-dddd-dddd-dddddddddddd'
);

insert into public.event_sponsorships(
  id, event_id, sponsor_profile_id, pricing_tier_id, quote_id, status
) values (
  'ffffffff-ffff-ffff-ffff-ffffffffffff',
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  null,
  'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
  'pending_payment'
);

-- 1001 raw native units proves integer flooring: marketing=200, protocol=100,
-- and the deterministic remainder belongs to prize (=701).
insert into public.sponsorship_payments(
  id, event_sponsorship_id, quote_id, chain_id,
  gross_native_raw, prize_native_raw, marketing_native_raw, protocol_native_raw,
  tx_hash, signature_reference, block_number, status, confirmed_at
) values (
  '11111111-2222-3333-4444-555555555555',
  'ffffffff-ffff-ffff-ffff-ffffffffffff',
  'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
  56,
  1001,
  701,
  200,
  100,
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0',
  123456,
  'confirmed',
  now()
);

update public.event_sponsorships
set status = 'active',
    gross_native_raw = 1001,
    prize_native_raw = 701,
    marketing_native_raw = 200,
    protocol_native_raw = 100,
    activated_at = now(),
    updated_at = now()
where id = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

update public.sponsorship_events
set sponsorship_prize_native_raw = sponsorship_prize_native_raw + 701,
    prize_native_raw = prize_native_raw + 701,
    updated_at = now()
where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

insert into public.event_sponsorship_audit_log(
  event_id, application_id, quote_id, payment_id, event_type, chain_id,
  sponsor_wallet, action, state_from, state_to, payment_identity, evidence, actor
) values (
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'dddddddd-dddd-dddd-dddd-dddddddddddd',
  'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
  '11111111-2222-3333-4444-555555555555',
  'normal_tournament',
  56,
  '0x1111111111111111111111111111111111111111',
  'payment_confirmed',
  'pending_payment',
  'active',
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0',
  '{"schemaRehearsal":true}'::jsonb,
  'ci'
);

insert into public.event_sponsorship_founding_history(
  event_id, event_sponsorship_id, payment_id, sponsor_profile_id,
  sponsor_wallet, confirmed_at, payment_identity
) values (
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'ffffffff-ffff-ffff-ffff-ffffffffffff',
  '11111111-2222-3333-4444-555555555555',
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  '0x1111111111111111111111111111111111111111',
  now(),
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0'
);

-- Exact 70/20/10 accounting must reject a malformed raw-native split.
do $$
begin
  begin
    insert into public.sponsorship_payments(
      event_sponsorship_id, quote_id, chain_id,
      gross_native_raw, prize_native_raw, marketing_native_raw, protocol_native_raw,
      signature_reference, status
    ) values (
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
      'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      56,
      1001,
      700,
      201,
      100,
      'malformed-split-proof',
      'pending'
    );
    raise exception 'malformed 70/20/10 split was accepted';
  exception
    when check_violation then null;
  end;
end $$;

-- A second confirmed payment for the same immutable quote must fail, which is
-- the DB boundary preventing double authoritative prize credit.
do $$
begin
  begin
    insert into public.sponsorship_payments(
      event_sponsorship_id, quote_id, chain_id,
      gross_native_raw, prize_native_raw, marketing_native_raw, protocol_native_raw,
      tx_hash, signature_reference, status, confirmed_at
    ) values (
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
      'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      56,
      1001,
      701,
      200,
      100,
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:0',
      'confirmed',
      now()
    );
    raise exception 'duplicate authoritative confirmation was accepted';
  exception
    when unique_violation then null;
  end;
end $$;

do $$
declare
  confirmed_count integer;
  event_prize numeric(78,0);
begin
  select count(*) into confirmed_count
  from public.sponsorship_payments
  where quote_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
    and status = 'confirmed';
  if confirmed_count <> 1 then
    raise exception 'expected exactly one authoritative confirmed payment, got %', confirmed_count;
  end if;

  select sponsorship_prize_native_raw into event_prize
  from public.sponsorship_events
  where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  if event_prize <> 701 then
    raise exception 'event prize credit expected 701, got %', event_prize;
  end if;

  if not exists (
    select 1 from public.event_sponsorships
    where id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
      and status = 'active'
      and gross_native_raw = 1001
      and prize_native_raw = 701
      and marketing_native_raw = 200
      and protocol_native_raw = 100
  ) then
    raise exception 'representative Event Sponsorship accounting row is invalid';
  end if;
end $$;
