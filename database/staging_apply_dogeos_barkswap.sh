#!/usr/bin/env bash
# Apply the DogeOS (chain 6281971) Barkswap migrations to the STAGING Supabase project
# (vrnsbguutnwgtekcexls). Founder-gated: run only with an explicit go (plan t29).
# Supersedes staging_apply_dogeos_launch_path.sh: 20261010 is applied here, first, unchanged.
#
# Audited before writing this:
#   - 20261010_000020: only drops and re-adds two CHECK constraints (campaign_draft_evm_launch_options_chain_chk,
#     campaign_drafts_graduation_target_check), each widened by 6281971; no table, column or data change
#   - 20261015_000010: creates evm_gen8_bark_sell_fees / evm_gen8_bark_credits (if not exists) with their indexes,
#     RLS on and anon/authenticated revoked; adds one index on evm_gen8_fee_accruals (if not exists); re-creates
#     evm_gen8_side_pools_venue_chk with every existing venue plus 'algebra'. No insert / update / delete / drop
#     table / drop column, no view, no market_trades_v change
#   - 20261023_000010: drops and re-adds campaign_drafts_graduation_target_check as 20261019_000001 has it (the $150
#     gen-8 test target on 97 and 46630, on staging since 2026-10-19) plus 6281971; it runs after 20261010, which
#     re-creates the same check from an older definition, so the bundle never takes 97 / 46630 out again
#   - all three are idempotent; their own begin/commit lines are dropped so the bundle is one transaction
#
# Refuses any URL that is not the staging project, and the production project explicitly. lock_timeout makes a
# blocked statement fail instead of waiting.
#
#   bash database/staging_apply_dogeos_barkswap.sh dryrun   # run everything, then ROLLBACK
#   bash database/staging_apply_dogeos_barkswap.sh apply    # COMMIT
set -euo pipefail
cd "$(dirname "$0")/.."

STAGING_REF="vrnsbguutnwgtekcexls"
PROD_REF="ellkfgoxnzykxqybajtn"
DB="${STAGING_DATABASE_URL:-$(grep -m1 -E '^STAGING_DATABASE_URL=' frontend/.env.local 2>/dev/null | cut -d= -f2- | tr -d '"'"'"'"')}"
[ -n "$DB" ] || { echo "STAGING_DATABASE_URL is not set and frontend/.env.local has none" >&2; exit 1; }
case "$DB" in *"$STAGING_REF"*) ;; *) echo "refusing: not the staging project ($STAGING_REF)" >&2; exit 1;; esac
case "$DB" in *"$PROD_REF"*) echo "refusing: STAGING_DATABASE_URL points at the production project" >&2; exit 1;; esac
MODE="${1:-dryrun}"
case "$MODE" in dryrun|apply) ;; *) echo "usage: $0 [dryrun|apply]" >&2; exit 1;; esac

FILES=(
  db/migrations/20261010_000020_dogeos_chain_launch_path.sql
  db/migrations/20261015_000010_dogeos_barkswap.sql
  db/migrations/20261023_000010_dogeos_drafts_graduation_target.sql
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
    # drop the file's own begin; / commit; lines, any case (bracket classes: portable, no GNU-only /I flag)
    sed -E '/^[[:space:]]*([Bb][Ee][Gg][Ii][Nn]|[Cc][Oo][Mm][Mm][Ii][Tt])[[:space:]]*;[[:space:]]*$/d' "$f"
  done
  echo
  if [ "$MODE" = apply ]; then echo "commit;"; else echo "rollback;"; fi
} > "$WORK/bundle.sql"

echo "staging dogeos barkswap: ${#FILES[@]} files, mode $MODE"
psql "$DB" -X -q -f "$WORK/bundle.sql"
echo "done ($MODE)"
