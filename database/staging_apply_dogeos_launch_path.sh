#!/usr/bin/env bash
# Apply the DogeOS (chain 6281971) launch-path migration to the STAGING Supabase project
# (vrnsbguutnwgtekcexls). Founder-gated: run only with an explicit go (plan t29).
#
# Audited before writing this:
#   - the file only drops and re-adds two CHECK constraints (campaign_draft_evm_launch_options_chain_chk,
#     campaign_drafts_graduation_target_check), each widened by 6281971; no table, column or data change
#   - its own begin/commit lines are dropped so the bundle is one transaction
#
# Refuses any URL that is not the staging project. lock_timeout makes a blocked statement fail
# instead of waiting.
#
#   bash database/staging_apply_dogeos_launch_path.sh dryrun   # run everything, then ROLLBACK
#   bash database/staging_apply_dogeos_launch_path.sh apply    # COMMIT
set -euo pipefail
cd "$(dirname "$0")/.."

DB="${STAGING_DATABASE_URL:-$(grep -m1 -E '^STAGING_DATABASE_URL=' frontend/.env.local 2>/dev/null | cut -d= -f2- | tr -d '"'"'"'"')}"
[ -n "$DB" ] || { echo "STAGING_DATABASE_URL is not set and frontend/.env.local has none" >&2; exit 1; }
case "$DB" in *vrnsbguutnwgtekcexls*) ;; *) echo "refusing: not the staging project (vrnsbguutnwgtekcexls)" >&2; exit 1;; esac
MODE="${1:-dryrun}"
case "$MODE" in dryrun|apply) ;; *) echo "usage: $0 [dryrun|apply]" >&2; exit 1;; esac

FILES=(
  db/migrations/20261010_000020_dogeos_chain_launch_path.sql
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

echo "staging dogeos launch path: ${#FILES[@]} files, mode $MODE"
psql "$DB" -X -q -f "$WORK/bundle.sql"
echo "done ($MODE)"
