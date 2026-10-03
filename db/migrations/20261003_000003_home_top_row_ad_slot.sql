-- CO-21: Home ad row (slot code home-top-row), 6 paid wide banner tiles with their own prices.
-- Staging first; production is run by the founder in the Supabase SQL editor. Idempotent.
--
-- 1) Packages can belong to one slot. Null = every slot (all existing rows: Featured and the rail
--    keep exactly the prices they have today). GET /api/sponsorship-packages?slot=home-top-row
--    returns the rows below; without ?slot it returns only the null rows, as before.
-- 2) Placements get an optional wide banner (8:3, e.g. 480 x 180, shown at 240 x 90). The Home row
--    falls back to image_url when it is null.
-- 3) Placeholder ad row prices, below Featured's (49 / 99 / 179 / 299 / 699). The founder sets the
--    real prices in the dashboard (Packages tab, slot Home top row). Codes are unique across slots,
--    so the ad row uses its own htr- codes. Re-running never overwrites a price.

begin;

alter table public.sponsorship_packages add column if not exists slot_code text;
create index if not exists sponsorship_packages_slot_code_idx on public.sponsorship_packages (lower(slot_code));

alter table public.sponsored_placements add column if not exists banner_url text;

insert into public.sponsorship_packages (code, label, duration_days, price_usd, sort_order, slot_code, notes)
values
  ('htr-d3', '3 days',   3,  25.00, 10, 'home-top-row', 'Home top row placeholder price'),
  ('htr-w1', '1 week',   7,  49.00, 20, 'home-top-row', 'Home top row placeholder price'),
  ('htr-w2', '2 weeks', 14,  89.00, 30, 'home-top-row', 'Home top row placeholder price'),
  ('htr-m1', '1 month', 30, 149.00, 40, 'home-top-row', 'Home top row placeholder price'),
  ('htr-m3', '3 months', 90, 349.00, 50, 'home-top-row', 'Home top row placeholder price')
on conflict (code) do update set
  slot_code = excluded.slot_code,
  label = excluded.label,
  duration_days = excluded.duration_days,
  sort_order = excluded.sort_order,
  updated_at = now();

commit;
