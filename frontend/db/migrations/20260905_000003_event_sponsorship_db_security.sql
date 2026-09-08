begin;

-- Event Sponsorship is server-authoritative. Browser clients use the Node API;
-- they do not require direct PostgREST/table access to these records.

alter table public.sponsor_profiles enable row level security;
alter table public.sponsorship_events enable row level security;
alter table public.sponsorship_payment_quotes enable row level security;
alter table public.sponsorship_payments enable row level security;
alter table public.event_sponsorships enable row level security;
alter table public.event_sponsorship_applications enable row level security;
alter table public.event_sponsorship_audit_log enable row level security;
alter table public.event_sponsorship_founding_history enable row level security;

revoke all privileges on table public.sponsor_profiles from anon, authenticated;
revoke all privileges on table public.sponsorship_events from anon, authenticated;
revoke all privileges on table public.sponsorship_payment_quotes from anon, authenticated;
revoke all privileges on table public.sponsorship_payments from anon, authenticated;
revoke all privileges on table public.event_sponsorships from anon, authenticated;
revoke all privileges on table public.event_sponsorship_applications from anon, authenticated;
revoke all privileges on table public.event_sponsorship_audit_log from anon, authenticated;
revoke all privileges on table public.event_sponsorship_founding_history from anon, authenticated;

-- These sequences back server-only audit/history inserts. Keep them out of browser roles too.
revoke all privileges on sequence public.event_sponsorship_audit_log_id_seq from anon, authenticated;
revoke all privileges on sequence public.event_sponsorship_founding_history_id_seq from anon, authenticated;

-- Trigger functions created by the certified sponsorship/payment migration chain
-- only operate on NEW row values. Pin them to pg_catalog; no SECURITY DEFINER.
alter function public.set_sponsorship_solana_operation_key() set search_path = pg_catalog;
alter function public.set_arena_solana_boost_operation_key() set search_path = pg_catalog;

comment on table public.sponsor_profiles is
  'Server-authoritative Event Sponsorship sponsor identity. Direct anon/authenticated table access intentionally disabled.';
comment on table public.sponsorship_events is
  'Server-authoritative Event Sponsorship event registry. Public event data is exposed only through the application API.';
comment on table public.sponsorship_payment_quotes is
  'Server-authoritative immutable sponsorship quote/payment recovery state. No direct browser access.';
comment on table public.sponsorship_payments is
  'Server-authoritative sponsorship payment evidence and 70/20/10 accounting. No direct browser access.';
comment on table public.event_sponsorships is
  'Server-authoritative Event Sponsorship lifecycle/accounting state. Public rendering uses sanitized API responses.';
comment on table public.event_sponsorship_applications is
  'Server-authoritative Event Sponsorship application/review state. Sponsor writes require signed API actions; admin review uses server auth.';
comment on table public.event_sponsorship_audit_log is
  'Internal Event Sponsorship audit history. Never directly exposed to browser roles.';
comment on table public.event_sponsorship_founding_history is
  'Internal deterministic Founding Sponsor history. Public badge state is derived through the application API.';

commit;
