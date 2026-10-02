-- UI redesign phase 1b (docs/build_plans/ui-redesign): coin page fields (N5) and posts written as a
-- coin by its owner (N1). Additive only: new nullable columns on token_story_profiles, which the
-- Story save (POST /api/story/profile) never touches, and one new table. Staging first; the founder
-- applies it on production.

alter table public.token_story_profiles
  add column if not exists banner_url text,
  add column if not exists bio text,
  add column if not exists founder_note text,
  add column if not exists website_url text,
  add column if not exists x_url text,
  add column if not exists telegram_url text,
  add column if not exists discord_url text,
  add column if not exists tags text[],
  add column if not exists pinned_post_id bigint,
  add column if not exists share_updates_to_feed boolean,
  add column if not exists show_auto_updates boolean,
  add column if not exists section_images jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'token_story_bio_len') then
    alter table public.token_story_profiles add constraint token_story_bio_len check (bio is null or char_length(bio) <= 1200);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'token_story_founder_note_len') then
    alter table public.token_story_profiles add constraint token_story_founder_note_len check (founder_note is null or char_length(founder_note) <= 140);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'token_story_links_len') then
    alter table public.token_story_profiles add constraint token_story_links_len check (
      coalesce(char_length(banner_url), 0) <= 512 and coalesce(char_length(website_url), 0) <= 512 and
      coalesce(char_length(x_url), 0) <= 512 and coalesce(char_length(telegram_url), 0) <= 512 and
      coalesce(char_length(discord_url), 0) <= 512
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'token_story_tags_count') then
    alter table public.token_story_profiles add constraint token_story_tags_count check (tags is null or cardinality(tags) <= 5);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'token_story_section_images_object') then
    alter table public.token_story_profiles add constraint token_story_section_images_object check (
      section_images is null or (jsonb_typeof(section_images) = 'object' and pg_column_size(section_images) <= 8192)
    );
  end if;
end $$;

create table if not exists public.coin_posts (
  id bigserial primary key,
  chain_id integer not null,
  token_address text not null,
  author_wallet text not null,
  body text not null,
  media_url text,
  share_to_feed boolean not null default true,
  status smallint not null default 0,
  created_at timestamptz not null default now(),
  constraint coin_posts_body_len check (char_length(btrim(body)) between 1 and 280),
  constraint coin_posts_media_len check (media_url is null or char_length(media_url) <= 512),
  constraint coin_posts_status check (status in (0, 2))
);

create index if not exists coin_posts_coin_idx on public.coin_posts (chain_id, token_address, status, created_at desc);
create index if not exists coin_posts_feed_idx on public.coin_posts (share_to_feed, status, created_at desc);

alter table public.coin_posts enable row level security;

comment on table public.coin_posts is 'Posts written as a coin by its verified owner (UI redesign N1). Server-only; writes are wallet-signed via /api/coin-page/posts.';
comment on column public.token_story_profiles.bio is 'Launched coins only (D4). Story reads it before the draft description. Imported coins keep arena_token_imports.description.';
comment on column public.token_story_profiles.founder_note is 'Editable after launch (D3). Story shows it in place of campaign_draft_promotion.creator_note when set.';
