BEGIN;

-- Report / block / hide (CO-30, founder 2026-10-03). Per wallet, only affects what that wallet sees.
-- Blocking an account hides that account's posts and comments for the blocker; it never touches coin
-- pages or trading. wallet keys: EVM lowercased, Solana base58 as-is. RLS on, no policies: only the API
-- (table owner) reads and writes.
CREATE TABLE IF NOT EXISTS public.user_blocks (
  blocker_key  text NOT NULL,
  blocked_key  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_key, blocked_key),
  CONSTRAINT user_blocks_not_self CHECK (blocker_key <> blocked_key),
  CONSTRAINT user_blocks_key_len CHECK (char_length(blocker_key) BETWEEN 32 AND 64 AND char_length(blocked_key) BETWEEN 32 AND 64)
);

-- item_type: post (social_posts), comment (token comments), coin_post (coin page updates),
-- battle_comment (arena battle comments). item_id is that row's id as text.
CREATE TABLE IF NOT EXISTS public.user_hidden_items (
  viewer_key  text NOT NULL,
  item_type   text NOT NULL CHECK (item_type IN ('post', 'comment', 'coin_post', 'battle_comment')),
  item_id     text NOT NULL CHECK (char_length(item_id) BETWEEN 1 AND 128),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (viewer_key, item_type, item_id)
);

-- In-app reports of a post or comment use reported_entity_type 'post' (already listed in the API's
-- ABUSE_ENTITY_TYPES, but the original check constraint did not allow it). Additive.
ALTER TABLE public.abuse_reports DROP CONSTRAINT IF EXISTS abuse_reports_entity_type_chk;
ALTER TABLE public.abuse_reports ADD CONSTRAINT abuse_reports_entity_type_chk CHECK (
  reported_entity_type IS NULL
  OR reported_entity_type = ANY (ARRAY['profile','campaign','token','wallet','post','external_account','external_website','other']::text[])
);

ALTER TABLE public.user_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_hidden_items ENABLE ROW LEVEL SECURITY;

COMMIT;
