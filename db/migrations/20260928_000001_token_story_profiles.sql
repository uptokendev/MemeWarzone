-- Story Mode: what a coin's owner may write (founder, 2026-09-28). Chronicle chapters are generated
-- and never stored here. One row per coin: a short story (the one editable chapter for imported coins)
-- and answers to the fixed full-story boxes (keys defined in frontend/shared/storyContract.mjs).
create table if not exists public.token_story_profiles (
  chain_id integer not null,
  token_address text not null,
  short_story text,
  sections jsonb not null default '{}'::jsonb,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (chain_id, token_address),
  constraint token_story_short_len check (short_story is null or char_length(short_story) <= 280),
  constraint token_story_sections_object check (jsonb_typeof(sections) = 'object'),
  constraint token_story_sections_size check (pg_column_size(sections) <= 16384)
);

comment on table public.token_story_profiles is 'Story Mode owner text: short story + fixed full-story boxes. Writes are wallet-signed by the verified owner via /api/story/profile.';
