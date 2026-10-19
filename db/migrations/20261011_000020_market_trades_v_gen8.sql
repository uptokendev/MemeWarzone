-- EVM generation 8 (step 4, 2026-10-11): market_trades_v labels gen-8 dex_trades rows as their own market.
--
-- The gen-8 indexer (realtime-indexer/src/evm/evmGen8Store.ts insertGen8DexTrade) writes post-graduation swaps of a
-- gen-8 coin to dex_trades with execution_source 'gen8_v4'. The view's dex branch labels every execution source it
-- does not know as TOPAZ / topaz, so those rows read as Topaz trades. This adds one branch to each of the two CASE
-- expressions, before the robinhood_v3 branch:
--   marketStage  WHEN t.execution_source = 'gen8_v4' THEN 'GEN8_V4'
--   source       WHEN t.execution_source = 'gen8_v4' THEN 'gen8_v4'
-- Every other row keeps its label.
--
-- Production and staging carry the view with different column types (production: tokenAmountRaw / nativeAmountRaw /
-- quoteAmountRaw numeric; staging: text; see 20260921_000002), so the view is not re-typed here: the current
-- definition is read with pg_get_viewdef, the two branches are inserted, and the same definition is replaced in place
-- (CREATE OR REPLACE keeps columns, types, grants and dependants). Its reloptions (security_invoker=true) are carried
-- over, because CREATE OR REPLACE VIEW resets options it is not given.
--
-- Idempotent: a view that already has the gen8_v4 branch is left alone. Refuses (raises) if either CASE is not found
-- exactly once, so it never writes a half-patched view. Rows with execution_source 'gen8_v4' exist only once the
-- gen-8 indexer runs (EVM_GEN8_LAUNCHER_<id> / EVM_GEN8_HOOK_<id>); before that this change has no visible effect.
do $$
declare
  def text;
  next_def text;
  opts text;
  stage_pat constant text := $p$(WHEN\s+\(?t\.execution_source\s*=\s*'robinhood_v3'::text\)?\s+THEN\s+'ROBINHOOD_V3'::text)$p$;
  source_pat constant text := $p$(WHEN\s+\(?t\.execution_source\s*=\s*'robinhood_v3'::text\)?\s+THEN\s+'robinhood_v3'::text)$p$;
  n_stage int;
  n_source int;
begin
  if to_regclass('public.market_trades_v') is null then
    raise notice 'market_trades_v does not exist; nothing to change';
    return;
  end if;
  def := pg_get_viewdef('public.market_trades_v'::regclass, true);
  if def ~ 'gen8_v4' then
    raise notice 'market_trades_v already labels gen8_v4; nothing to change';
    return;
  end if;
  select count(*) into n_stage from regexp_matches(def, stage_pat, 'g');
  select count(*) into n_source from regexp_matches(def, source_pat, 'g');
  if n_stage <> 1 or n_source <> 1 then
    raise exception 'market_trades_v: expected one robinhood_v3 branch in each CASE, found % / %', n_stage, n_source;
  end if;
  next_def := regexp_replace(def, stage_pat, $r$WHEN t.execution_source = 'gen8_v4'::text THEN 'GEN8_V4'::text \1$r$);
  next_def := regexp_replace(next_def, source_pat, $r$WHEN t.execution_source = 'gen8_v4'::text THEN 'gen8_v4'::text \1$r$);
  next_def := regexp_replace(next_def, ';\s*$', '');
  select array_to_string(reloptions, ', ') into opts from pg_class where oid = 'public.market_trades_v'::regclass;
  execute 'create or replace view public.market_trades_v'
    || case when coalesce(opts, '') <> '' then ' with (' || opts || ')' else '' end
    || ' as ' || next_def;
end $$;
