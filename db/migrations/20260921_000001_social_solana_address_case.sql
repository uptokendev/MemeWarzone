-- db/migrations/20260921_000001_social_solana_address_case.sql
--
-- Solana public keys are case-sensitive base58 strings. The BNB-era social
-- schema (002_social.sql, 20260413_000006_chat.sql) still enforced lowercase
-- on comments and chat, so every Solana comment and every Solana War Room
-- join/send failed its INSERT with a CHECK violation and surfaced as
-- "500 Server error". Reads were unaffected, which is why the lists rendered
-- while posting did not.
--
-- Same treatment the launchpad, recruiter and ledger tables received in
-- 20260704_000001, 20260708_000001 and 20260824_000001. Application code
-- still lowercases EVM addresses before writes (canonCampaign / canonWallet,
-- normalizeWalletFlexible); this only stops the database from rejecting the
-- Solana form.
--
-- The API also drops these at runtime (comments.js, chat/_lib.js) the way
-- auth/nonce.js drops auth_nonces_address_lowercase, so production heals on
-- deploy; this file keeps the schema history honest.

BEGIN;

ALTER TABLE IF EXISTS public.token_comments
  DROP CONSTRAINT IF EXISTS token_comments_campaign_lowercase,
  DROP CONSTRAINT IF EXISTS token_comments_author_lowercase,
  DROP CONSTRAINT IF EXISTS token_comments_token_lowercase;

ALTER TABLE IF EXISTS public.chat_sessions
  DROP CONSTRAINT IF EXISTS chat_sessions_wallet_lowercase;

ALTER TABLE IF EXISTS public.chat_messages
  DROP CONSTRAINT IF EXISTS chat_messages_campaign_lowercase,
  DROP CONSTRAINT IF EXISTS chat_messages_wallet_lowercase;

COMMENT ON COLUMN public.token_comments.campaign_address IS 'Chain-normalized campaign id: lowercase EVM address or case-sensitive Solana public key.';
COMMENT ON COLUMN public.token_comments.author_address IS 'Chain-normalized wallet id: lowercase EVM address or case-sensitive Solana public key.';
COMMENT ON COLUMN public.chat_sessions.wallet_address IS 'Chain-normalized wallet id: lowercase EVM address or case-sensitive Solana public key.';
COMMENT ON COLUMN public.chat_messages.campaign_address IS 'Chain-normalized campaign id: lowercase EVM address or case-sensitive Solana public key.';
COMMENT ON COLUMN public.chat_messages.wallet_address IS 'Chain-normalized wallet id: lowercase EVM address or case-sensitive Solana public key.';

COMMIT;
