#!/usr/bin/env bash
# Apply the missing schema to the STAGING Supabase project (2026-09-21).
#
# The live branch (build/cross-chain-stabilization-rh-base) runs against the
# staging project vrnsbguutnwgtekcexls, so this is the database real users
# hit. Diffing every migration file against it showed the arena core is
# present (arena_battles with battle_mode, arena_contest_actions,
# arena_vote_tiebreaks, championship / MWL tables, market_trades_v with the
# valuation columns) but these never landed:
#
#   - arena_solana_boost_quotes + its payment lifecycle columns
#     (Solana boosts on battles and vote tournaments)
#   - arena_battle_scoring_locks (Battle Points V3 boost sale authority)
#   - token_holder_balances / token_holder_sync (indexer holder sync,
#     holder scoring)
#   - event_sponsorship_applications / audit log / founding history and the
#     sponsorship_payment_quotes Solana columns (the live sponsorship route
#     selects them)
#   - solana_reward_payout_intents / solana_wallet_verifications /
#     solana_launchpad_admin_actions (realtime-indexer ops + payout rails)
#   - 20260921_000003: Vote Battle clocks (1/6/12/24 h) and the boost quote
#     binding that lets the battle route carry 2 points per unit
#   - 20260921_000004: the championship mirror trigger no longer fails a
#     settlement when the token has no league entry yet (first battle ever)
#   - 20260921_000005: arena_league_entries gets the (season_id,
#     token_address) identity the league writer upserts on; the table was
#     still in the old import shape (unique on token_id only)
#
# Audited: no drop table / truncate / delete / drop column in any file; every
# alter on an existing table is `add column if not exists`; backfill updates
# touch tables that are empty here (0 boost quotes, 0 sponsorship quotes).
# One transaction; lock_timeout makes a blocked statement fail instead of
# stalling the indexer. Re-running is harmless (if not exists everywhere,
# constraints dropped before being added).
#
#   bash database/staging_apply_arena_schema_catchup.sh dryrun   # rehearse (ROLLBACK)
#   bash database/staging_apply_arena_schema_catchup.sh apply    # apply (COMMIT)
set -euo pipefail
cd "$(dirname "$0")/.."

STAGING_REF="vrnsbguutnwgtekcexls"
PROD_REF="ellkfgoxnzykxqybajtn"
DB="${STAGING_DATABASE_URL:-$(grep -m1 -E '^STAGING_DATABASE_URL=' frontend/.env.local 2>/dev/null | cut -d= -f2- | tr -d '"'"'"'"')}"
[ -n "$DB" ] || { echo "STAGING_DATABASE_URL is not set and frontend/.env.local has none" >&2; exit 1; }
case "$DB" in *"$STAGING_REF"*) ;; *) echo "refusing: STAGING_DATABASE_URL does not contain the staging ref $STAGING_REF" >&2; exit 1;; esac
case "$DB" in *"$PROD_REF"*) echo "refusing: STAGING_DATABASE_URL points at the production project" >&2; exit 1;; esac
MODE="${1:-dryrun}"   # dryrun | apply
case "$MODE" in dryrun|apply) ;; *) echo "usage: $0 [dryrun|apply]" >&2; exit 1;; esac
WORK="$(mktemp -d)"

FILES=(
  db/migrations/20260704_000002_solana_reward_payout_rails.sql
  db/migrations/20260704_000003_solana_launchpad_ops.sql
  db/migrations/20260816_000001_token_holder_balances.sql
  frontend/db/migrations/20260904_000001_solana_arena_money_v2_runtime.sql
  frontend/db/migrations/20260904_000002_battle_points_v3_curve_lock.sql
  frontend/db/migrations/20260905_000001_solana_arena_payment_lifecycle.sql
  frontend/db/migrations/20260905_000002_event_sponsorship_authority.sql
  frontend/db/migrations/20260905_000003_event_sponsorship_db_security.sql
  db/migrations/20260921_000003_arena_vote_battles.sql
  db/migrations/20260921_000004_championship_mirror_missing_entry_names.sql
  db/migrations/20260921_000005_arena_league_entries_token_address_identity.sql
  db/migrations/20260921_000006_league_epoch_roots.sql
)

bundle() {
  local out="$1"; shift
  {
    echo "\\set ON_ERROR_STOP on"
    echo "set lock_timeout = '5s';"
    echo "set statement_timeout = '120s';"
    echo "begin;"
    for f in "$@"; do
      [ -f "$f" ] || { echo "missing migration file: $f" >&2; exit 1; }
      echo
      echo "-- ===== $f ====="
      node -e '
        const fs = require("fs");
        let sql = fs.readFileSync(process.argv[1], "utf8");
        sql = sql.replace(/^\s*(begin|commit)\s*;\s*$/gim, "");
        if (/create or replace view public\.market_trades_v/i.test(sql)) throw new Error("market_trades_v redefinition is not part of the staging bundle: " + process.argv[1]);
        process.stdout.write(sql);
      ' "$f"
    done
    echo
    if [ "$MODE" = "apply" ]; then echo "commit;"; else echo "rollback;"; fi
  } > "$out"
}

check() {
  psql "$DB" -v ON_ERROR_STOP=1 -X -At -F'  ' -c "
  select t.name, case when to_regclass('public.'||t.name) is null then '$1' else 'present' end
    from (values ('token_holder_balances'),('token_holder_sync'),('arena_solana_boost_quotes'),('arena_battle_scoring_locks'),
                 ('event_sponsorship_applications'),('event_sponsorship_audit_log'),('solana_reward_payout_intents'),
                 ('solana_wallet_verifications'),('solana_launchpad_admin_actions'),('league_epoch_roots')) t(name)
   union all
  select 'sponsorship_payment_quotes.solana_payment_status', case when exists (select 1 from information_schema.columns where table_schema='public' and table_name='sponsorship_payment_quotes' and column_name='solana_payment_status') then 'present' else '$1' end
   union all
  select 'arena_battles duration check allows vote clocks', case when exists (select 1 from pg_constraint where conrelid='public.arena_battles'::regclass and conname='arena_battles_duration_check' and pg_get_constraintdef(oid) like '%vote%') then 'present' else '$1' end
   union all
  select 'championship mirror tolerates missing league entry', case when pg_get_functiondef('public.mirror_mwl_point_to_quarterly_championship'::regproc) like '%entry_name := COALESCE(entry_name%' then 'present' else '$1' end
   union all
  select 'league entries unique on (season_id, token_address)', case when exists (select 1 from pg_indexes where schemaname='public' and tablename='arena_league_entries' and indexname='arena_league_entries_season_token_address_uidx') then 'present' else '$1' end
   order by 1;"
}

run_sql() {
  # psql's exit status decides; NOTICE lines are hidden from the report.
  if ! psql "$DB" -X -q -v ON_ERROR_STOP=1 -f "$1" > "$WORK/out.txt" 2>&1; then
    grep -v NOTICE "$WORK/out.txt" || true
    echo "FAILED: $1 (transaction rolled back)" >&2
    rm -rf "$WORK"
    exit 1
  fi
  grep -v NOTICE "$WORK/out.txt" || true
}

echo "=== before ==="; check MISSING
bundle "$WORK/staging.sql" "${FILES[@]}"
echo; echo "--- staging ($MODE): ${#FILES[@]} files ---"
run_sql "$WORK/staging.sql"
echo; echo "=== after (every row must read present when MODE=apply) ==="; check "STILL MISSING"
rm -rf "$WORK"
