-- Battle V2 correction pass after Phase 3-5 review.
-- Additive/backward compatible:
--   * expose explicit quote/USD evidence on market_trades_v without removing legacy columns
--   * reserve normalized USD market-stat fields for shared Arena/Markets/Stock valuation
--   * keep detailed anti-abuse audit evidence service-role only

BEGIN;

ALTER TABLE IF EXISTS public.market_stats
  ADD COLUMN IF NOT EXISTS market_cap_usd numeric,
  ADD COLUMN IF NOT EXISTS liquidity_usd numeric;

ALTER TABLE IF EXISTS public.arena_battle_volume_audit
  ADD COLUMN IF NOT EXISTS usd_counted numeric,
  ADD COLUMN IF NOT EXISTS quote_asset_type text,
  ADD COLUMN IF NOT EXISTS quote_token_address text,
  ADD COLUMN IF NOT EXISTS valuation_source text;

-- Detailed wallet-to-cluster and anti-abuse evidence is operational data. Public
-- clients receive aggregate/sanitized Battle metrics through the API instead.
REVOKE SELECT ON TABLE public.arena_battle_volume_audit FROM anon, authenticated;
DROP POLICY IF EXISTS arena_battle_volume_audit_public_read ON public.arena_battle_volume_audit;

-- Preserve every existing market_trades_v column in its original order and append
-- normalized quote/valuation evidence. Stock Token quote amounts are never copied
-- into nativeAmountRaw. Raw quote amounts use text because dex_trades.quote_amount_raw
-- is the canonical precision-preserving representation while curve_trades historically
-- stores bnb_amount_raw as numeric on clean replay.
CREATE OR REPLACE VIEW public.market_trades_v
WITH (security_invoker=true)
AS
SELECT
  t.chain_id AS "chainId",
  t.campaign_address AS "campaignAddress",
  c.token_address AS "tokenAddress",
  NULL::text AS "pairAddress",
  'BONDING'::text AS "marketStage",
  'bonding'::text AS source,
  t.side,
  t.wallet,
  t.wallet AS recipient,
  t.token_amount_raw AS "tokenAmountRaw",
  t.bnb_amount_raw AS "nativeAmountRaw",
  t.price_bnb AS "priceBnb",
  t.tx_hash AS "txHash",
  t.log_index AS "logIndex",
  t.block_number AS "blockNumber",
  t.block_time AS "blockTime",
  'confirmed'::text AS status,
  t.bnb_amount_raw::text AS "quoteAmountRaw",
  'WRAPPED_NATIVE'::text AS "quoteAssetType",
  NULL::text AS "quoteTokenAddress",
  NULL::numeric AS "volumeUsd",
  NULL::numeric AS "referencePriceUsd",
  NULL::timestamptz AS "referencePriceUpdatedAt"
FROM public.curve_trades t
LEFT JOIN public.campaigns c
  ON c.chain_id=t.chain_id AND c.campaign_address=t.campaign_address
UNION ALL
SELECT
  t.chain_id,
  t.campaign_address,
  t.token_address,
  t.pair_address,
  CASE
    WHEN t.quote_asset_type = 'STOCK_TOKEN' THEN 'ROBINHOOD_STOCK'
    WHEN t.execution_source = 'robinhood_v3' THEN 'ROBINHOOD_V3'
    ELSE 'TOPAZ'
  END::text,
  CASE
    WHEN t.execution_source = 'robinhood_v3' THEN 'robinhood_v3'
    ELSE 'topaz'
  END::text,
  t.side,
  COALESCE(t.transaction_from,t.sender_address,t.recipient_address,''),
  t.recipient_address,
  t.token_amount_raw,
  t.native_amount_raw,
  t.price_bnb,
  t.tx_hash,
  t.log_index,
  t.block_number,
  t.block_time,
  t.status,
  COALESCE(t.quote_amount_raw,t.native_amount_raw)::text,
  COALESCE(t.quote_asset_type,'WRAPPED_NATIVE')::text,
  t.quote_token_address,
  t.volume_usd,
  t.reference_price_usd,
  t.reference_price_updated_at
FROM public.dex_trades t;

REVOKE ALL ON public.market_trades_v FROM public, anon, authenticated;
GRANT SELECT ON public.market_trades_v TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_battle_volume_audit TO service_role;

COMMIT;
