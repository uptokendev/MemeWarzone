-- UI redesign phase 4b (docs/build_plans/ui-redesign): comments on a battle (N8). Additive: one new
-- table. Writes are wallet-signed through POST /api/arena/battles/:id/comments. Staging first; the
-- founder applies it on production.

create table if not exists public.arena_battle_comments (
  id bigserial primary key,
  battle_id text not null references public.arena_battles(id) on delete cascade,
  chain_id integer not null,
  author_wallet text not null,
  body text not null,
  status smallint not null default 0,
  created_at timestamptz not null default now(),
  constraint arena_battle_comments_body_len check (char_length(btrim(body)) between 1 and 280),
  constraint arena_battle_comments_status check (status in (0, 1, 2))
);

create index if not exists arena_battle_comments_battle_idx
  on public.arena_battle_comments (battle_id, status, created_at desc);
create index if not exists arena_battle_comments_author_idx
  on public.arena_battle_comments (author_wallet, created_at desc);

alter table public.arena_battle_comments enable row level security;

comment on table public.arena_battle_comments is 'Comments on a battle (UI redesign N8). Server-only; status 0 visible, 1 hidden by moderation, 2 deleted.';
