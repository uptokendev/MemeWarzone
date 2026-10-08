#!/usr/bin/env bash
# Bring the STAGING Supabase project (vrnsbguutnwgtekcexls) up to the live branch's schema (2026-10-08).
#
# The test stack (sslip API / indexer) was stopped on 2026-10-03, and staging never received the
# migrations added from 2026-10-04 to 2026-10-07. Read-only probe 2026-10-08: every migration up to
# 20261003_000007 is present; these 12 are missing (their tables / columns do not exist). The
# build/evm-gen7 branch (gen-7 test run) is based on the live branch and expects them.
#
# Audited before writing this:
#   - no drop table / truncate / delete / update / insert / drop column in any of the 12 files
#   - each file carries its own begin/commit; those lines are dropped so the bundle is one transaction
#   - 20261006_000003 is a no-op addition after 000002; order is the filename order, as on production
#
# Refuses any URL that is not the staging project. lock_timeout makes a blocked statement fail
# instead of waiting.
#
#   bash database/staging_apply_2026_10_04_catchup.sh dryrun   # run everything, then ROLLBACK
#   bash database/staging_apply_2026_10_04_catchup.sh apply    # COMMIT
set -euo pipefail
cd "$(dirname "$0")/.."

DB="${STAGING_DATABASE_URL:-$(grep -m1 -E '^STAGING_DATABASE_URL=' frontend/.env.local 2>/dev/null | cut -d= -f2- | tr -d '"'"'"'"')}"
[ -n "$DB" ] || { echo "STAGING_DATABASE_URL is not set and frontend/.env.local has none" >&2; exit 1; }
case "$DB" in *vrnsbguutnwgtekcexls*) ;; *) echo "refusing: not the staging project (vrnsbguutnwgtekcexls)" >&2; exit 1;; esac
MODE="${1:-dryrun}"
case "$MODE" in dryrun|apply) ;; *) echo "usage: $0 [dryrun|apply]" >&2; exit 1;; esac

FILES=(
  db/migrations/20261004_000001_league_category_budgets.sql
  db/migrations/20261004_000002_finance_accounting.sql
  db/migrations/20261005_000001_finance_distributions.sql
  db/migrations/20261005_000002_creator_fee_claims.sql
  db/migrations/20261005_000002_finance_treasury_tax.sql
  db/migrations/20261005_000003_finance_crypto_costs.sql
  db/migrations/20261006_000001_finance_snapshots.sql
  db/migrations/20261006_000002_finance_import_swap_fees.sql
  db/migrations/20261006_000003_finance_vat_evidence.sql
  db/migrations/20261006_000010_arena_war_pool_chain_index.sql
  db/migrations/20261006_000020_moderation_holds.sql
  db/migrations/20261007_000010_dbc_referral_ours.sql
)

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
{
  echo "\\set ON_ERROR_STOP on"
  echo "set lock_timeout = '5s';"
  echo "set statement_timeout = '120s';"
  echo "begin;"
  for f in "${FILES[@]}"; do
    [ -f "$f" ] || { echo "missing migration file: $f" >&2; exit 1; }
    echo
    echo "-- ===== $f ====="
    sed -E '/^[[:space:]]*(begin|commit)[[:space:]]*;[[:space:]]*$/Id' "$f"
  done
  echo
  if [ "$MODE" = apply ]; then echo "commit;"; else echo "rollback;"; fi
} > "$WORK/bundle.sql"

echo "staging catch-up: ${#FILES[@]} files, mode $MODE"
psql "$DB" -X -q -f "$WORK/bundle.sql"
echo "done ($MODE)"
