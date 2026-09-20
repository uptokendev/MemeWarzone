#!/usr/bin/env bash
# Apply the migrations whose tables never reached production.
#
# Eight tables declared in the repo's migrations are absent from the production
# database. Two of them, campaign_draft_graduation_market_policy and
# campaign_draft_graduation_quote_selection, are queried by the draft path in
# frontend/api/drafts.js, which is the same class of failure as the missing
# quote_asset_* tables: the query throws, the handler catches it, and the
# feature silently does nothing.
#
# Audited before writing this:
#   - no drop table, truncate, delete or drop column in any of the six files
#   - every alter on a live table is `add column if not exists`, nullable
#   - every added check constraint is written `x is null or ...`, so it passes
#     against existing rows whose new columns are still null
#   - the one backfill UPDATE touches dex_trades, which has 0 rows in production
#     (dex_pools has 1), so it is effectively a no-op
#   - every referenced table already exists: dex_pools, dex_trades,
#     arena_token_imports, campaign_drafts
#
# Three of the files carry their own begin/commit; the other three are wrapped
# here with psql -1 so each file is still all-or-nothing. Applying a file twice
# is harmless: every create is `if not exists` and every constraint is dropped
# before being added.
set -euo pipefail
cd "$(dirname "$0")/.."

DB="${DATABASE_URL:-$(grep -m1 -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"'"'"'"')}"
if [ -z "$DB" ]; then
  echo "DATABASE_URL is not set and .env has none" >&2
  exit 1
fi

# Files that already begin/commit internally. Wrapping these with -1 would nest
# a transaction and psql would warn on every run.
SELF_WRAPPED=(
  "db/migrations/20260903_000100_robinhood_draft_graduation_market.sql"
  "db/migrations/20260905_000001_arena_import_authority.sql"
  "frontend/supabase/migrations/20260906240000_draft_graduation_quote_selection.sql"
)
# Files with no transaction of their own. psql -1 makes each atomic.
NEEDS_WRAP=(
  "db/migrations/20260902_000001_robinhood_generic_market_pairs.sql"
  "db/migrations/20260903_000102_robinhood_beat_the_market.sql"
  "database/robinhood_stock_graduation_registry.sql"
)

is_self_wrapped() {
  local needle="$1"
  for f in "${SELF_WRAPPED[@]}"; do [ "$f" = "$needle" ] && return 0; done
  return 1
}

# Dependency order: market_pairs first because it adds the dex_pools columns the
# Robinhood registry work reads, and the registry file creates its own parent
# table before the audit and candidate tables that reference it.
ORDER=(
  "db/migrations/20260902_000001_robinhood_generic_market_pairs.sql"
  "db/migrations/20260903_000100_robinhood_draft_graduation_market.sql"
  "db/migrations/20260903_000102_robinhood_beat_the_market.sql"
  "db/migrations/20260905_000001_arena_import_authority.sql"
  "frontend/supabase/migrations/20260906240000_draft_graduation_quote_selection.sql"
  "database/robinhood_stock_graduation_registry.sql"
)

echo "=== before ==="
psql "$DB" -v ON_ERROR_STOP=1 -At -F'  ' -c "
select t.name, case when c.oid is null then 'MISSING' else 'present' end
  from (values
    ('market_pairs'),
    ('campaign_draft_graduation_market_policy'),
    ('robinhood_beat_market_metrics'),
    ('arena_token_import_history'),
    ('campaign_draft_graduation_quote_selection'),
    ('robinhood_stock_token_registry'),
    ('robinhood_stock_token_registry_audit'),
    ('robinhood_stock_token_release_candidates')
  ) t(name)
  left join pg_class c
    on c.relname = t.name
   and c.relnamespace = 'public'::regnamespace
   and c.relkind = 'r'
 order by t.name;"

for file in "${ORDER[@]}"; do
  [ -f "$file" ] || { echo "missing migration file: $file" >&2; exit 1; }
  echo
  echo "--- applying $file ---"
  if is_self_wrapped "$file"; then
    psql "$DB" -v ON_ERROR_STOP=1 -q -f "$file"
  else
    psql "$DB" -v ON_ERROR_STOP=1 -q -1 -f "$file"
  fi
done

echo
echo "=== after (every row must read present) ==="
psql "$DB" -v ON_ERROR_STOP=1 -At -F'  ' -c "
select t.name, case when c.oid is null then 'STILL MISSING' else 'present' end
  from (values
    ('market_pairs'),
    ('campaign_draft_graduation_market_policy'),
    ('robinhood_beat_market_metrics'),
    ('arena_token_import_history'),
    ('campaign_draft_graduation_quote_selection'),
    ('robinhood_stock_token_registry'),
    ('robinhood_stock_token_registry_audit'),
    ('robinhood_stock_token_release_candidates')
  ) t(name)
  left join pg_class c
    on c.relname = t.name
   and c.relnamespace = 'public'::regnamespace
   and c.relkind = 'r'
 order by t.name;"
