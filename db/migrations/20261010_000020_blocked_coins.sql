BEGIN;

-- Blocked coins (Command Center -> Abuse -> Blocked coins, founder 2026-10-10): test coins and abusive
-- coins are taken off MemeWarzone without touching campaigns (the indexer re-creates a deleted row
-- within a minute). One row per block; a release keeps the row and fills released_*.
--   kind  test | abuse
--   mode  hide   - out of every public list; the coin page shows a "not listed" banner, trading stays
--         remove - also the coin page: GET /api/coin-page answers 410, the app shows a removed page
-- Addresses: EVM lower-case, Solana (chain 101/102) as-is. At most one active block per coin.
-- side_effects records what the block changed (social_posts ids it soft-deleted, notification ids it
-- marked read) so a release can undo exactly that.
-- RLS on, no policies: API only. Idempotent: safe to run twice. The API works before this runs
-- (no table = no blocks).

CREATE TABLE IF NOT EXISTS public.blocked_coins (
  id                 bigserial PRIMARY KEY,
  chain_id           integer NOT NULL,
  campaign_address   text,
  token_address      text,
  name               text,
  symbol             text,
  kind               text NOT NULL CHECK (kind IN ('test', 'abuse')),
  mode               text NOT NULL CHECK (mode IN ('hide', 'remove')),
  reason             text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  abuse_report_id    uuid,
  created_by         uuid,
  created_by_email   text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  released_at        timestamptz,
  released_by        uuid,
  released_by_email  text,
  release_reason     text,
  side_effects       jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT blocked_coins_address_chk CHECK (campaign_address IS NOT NULL OR token_address IS NOT NULL),
  CONSTRAINT blocked_coins_release_chk CHECK (released_at IS NULL OR release_reason IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS blocked_coins_active_uidx
  ON public.blocked_coins (chain_id, (coalesce(campaign_address, token_address)))
  WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS blocked_coins_active_campaign_idx
  ON public.blocked_coins (chain_id, campaign_address)
  WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS blocked_coins_active_token_idx
  ON public.blocked_coins (chain_id, token_address)
  WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS blocked_coins_created_idx
  ON public.blocked_coins (created_at DESC);

-- Link to the abuse report the block came from (abuse_reports.id is uuid).
DO $$
BEGIN
  IF to_regclass('public.abuse_reports') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'blocked_coins_abuse_report_fk') THEN
    ALTER TABLE public.blocked_coins
      ADD CONSTRAINT blocked_coins_abuse_report_fk
      FOREIGN KEY (abuse_report_id) REFERENCES public.abuse_reports(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Block and release are written to the abuse audit log (frontend/api/lib/abuseAuth.js writeAudit).
DO $$
BEGIN
  IF to_regclass('public.abuse_audit_events') IS NOT NULL THEN
    ALTER TABLE public.abuse_audit_events DROP CONSTRAINT IF EXISTS abuse_audit_events_event_type_chk;
    ALTER TABLE public.abuse_audit_events
      ADD CONSTRAINT abuse_audit_events_event_type_chk CHECK (
        event_type IN ('PERMISSION_GRANTED', 'PERMISSION_REVOKED', 'UNAUTHORIZED_ACCESS', 'COIN_BLOCKED', 'COIN_BLOCK_RELEASED')
      );
  END IF;
END $$;

-- Backfill: every campaign already hidden with meta.publicHidden becomes a test/hide block, unless it
-- already has an active block. meta.publicHidden itself is left as it is.
INSERT INTO public.blocked_coins (chain_id, campaign_address, token_address, name, symbol, kind, mode, reason, created_by_email)
SELECT c.chain_id,
       CASE WHEN c.chain_id IN (101, 102) THEN c.campaign_address ELSE lower(c.campaign_address) END,
       CASE WHEN c.chain_id IN (101, 102) THEN c.token_address ELSE lower(c.token_address) END,
       c.name,
       c.symbol,
       'test',
       'hide',
       'publicHidden backfill',
       'system:publicHidden-backfill'
  FROM public.campaigns c
 WHERE c.campaign_address IS NOT NULL
   AND lower(coalesce(c.meta->>'publicHidden', 'false')) IN ('true', '1', 'yes', 'on')
   AND NOT EXISTS (
     SELECT 1 FROM public.blocked_coins b
      WHERE b.released_at IS NULL
        AND b.chain_id = c.chain_id
        AND coalesce(b.campaign_address, b.token_address) =
            CASE WHEN c.chain_id IN (101, 102) THEN c.campaign_address ELSE lower(c.campaign_address) END
   )
ON CONFLICT DO NOTHING;

ALTER TABLE public.blocked_coins ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.blocked_coins FROM anon;
    REVOKE ALL ON SEQUENCE public.blocked_coins_id_seq FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.blocked_coins FROM authenticated;
    REVOKE ALL ON SEQUENCE public.blocked_coins_id_seq FROM authenticated;
  END IF;
END $$;

COMMIT;
