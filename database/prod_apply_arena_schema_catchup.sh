#!/usr/bin/env bash
# Port the arena schema to the PRODUCTION Supabase project (2026-09-21).
#
# The live branch runs against the staging project (vrnsbguutnwgtekcexls);
# the production project (ellkfgoxnzykxqybajtn) never received the arena
# migrations from 20260827 onward: arena_battles lacks battle_mode /
# money_winner_token / settled_at / contest_scoring_version, and
# arena_contest_actions, arena_vote_tiebreaks, arena_battle_metrics,
# arena_battle_points_v3, arena_solana_boost_quotes,
# arena_battle_scoring_locks, the championship and MWL tables and
# token_holder_balances do not exist. This is the port bundle for the day
# the app is moved to production. Re-diff staging first: whatever staging
# carries beyond these files (SQL-editor changes) must be added here.
#
# Audited before writing this:
#   - no drop table / truncate / delete / drop column in any file
#   - every alter on an existing table is `add column if not exists`
#   - backfill updates touch arena tables with 0-2 rows, or RH candle rows
#     that do not exist in production
#   - every market_trades_v redefinition inside the old files is stripped; the
#     live view shape (20260917_000002) is kept and only extended by
#     20260921_000002 (columns appended at the end)
#   - the whole bundle was rehearsed against production inside one
#     transaction that ended in ROLLBACK: 25 files, exit 0, ~16 s
#
# Group A (market tables the indexer writes) runs first in its own short
# transaction; group B (arena-only tables, dark behind flags) follows.
# lock_timeout makes a blocked statement fail instead of stalling the indexer.
# Re-running is harmless: every create is `if not exists`, every constraint is
# dropped before being added.
#
#   bash database/prod_apply_arena_schema_catchup.sh dryrun   # rehearse (ROLLBACK)
#   bash database/prod_apply_arena_schema_catchup.sh apply    # apply (COMMIT)
set -euo pipefail
cd "$(dirname "$0")/.."

DB="${DATABASE_URL:-$(grep -m1 -E '^DATABASE_URL=' frontend/.env | cut -d= -f2- | tr -d '"'"'"'"')}"
[ -n "$DB" ] || { echo "DATABASE_URL is not set and frontend/.env has none" >&2; exit 1; }
MODE="${1:-dryrun}"   # dryrun | apply
case "$MODE" in dryrun|apply) ;; *) echo "usage: $0 [dryrun|apply]" >&2; exit 1;; esac
WORK="$(mktemp -d)"

GROUP_A=(
  db/migrations/20260704_000002_solana_reward_payout_rails.sql
  db/migrations/20260704_000003_solana_launchpad_ops.sql
  db/migrations/20260816_000001_token_holder_balances.sql
  db/migrations/20260902_000002_robinhood_quote_native_compatibility.sql
  db/migrations/20260903_000101_robinhood_shared_market_valuation.sql
  # 20260902_000004 revokes on arena_battle_volume_audit, which 20260902_000003 creates.
  db/migrations/20260902_000003_arena_battle_metrics.sql
  db/migrations/20260902_000004_arena_battle_v2_corrections.sql
  db/migrations/20260921_000002_market_trades_v_arena_valuation_columns.sql
)
GROUP_B=(
  db/migrations/20260827_000001_arena_vote_ingest.sql
  db/migrations/20260829_000001_arena_settle_idempotency.sql
  db/migrations/20260903_000002_arena_battle_points_v2_settlement.sql
  db/migrations/20260903_000103_arena_tournament_battle_modes.sql
  db/migrations/20260903_000104_arena_vote_boost_sponsorship_v1_foundation.sql
  frontend/db/migrations/20260904_000000_event_sponsorship_core_schema.sql
  frontend/db/migrations/20260904_000001_solana_arena_money_v2_runtime.sql
  frontend/db/migrations/20260904_000002_battle_points_v3_curve_lock.sql
  frontend/db/migrations/20260905_000001_solana_arena_payment_lifecycle.sql
  frontend/db/migrations/20260905_000002_event_sponsorship_authority.sql
  frontend/db/migrations/20260905_000003_event_sponsorship_db_security.sql
  db/migrations/20260906_000005_arena_scoring_generation_lock.sql
  db/migrations/20260906_000006_arena_battle_v3_runtime_activation.sql
  db/migrations/20260907_000001_quarterly_championship_runtime.sql
  db/migrations/20260907_000002_quarterly_championship_continuous_base_points.sql
  db/migrations/20260909_000001_arena_final_salvo_identity.sql
  db/migrations/20260909_000002_arena_mwl_three_chain_identity.sql
  db/migrations/20260910_000001_arena_tournament_exact_bracket_control.sql
  db/migrations/20260910_000002_arena_tournament_admin_contract.sql
  db/migrations/20260921_000003_arena_vote_battles.sql
  db/migrations/20260921_000004_championship_mirror_missing_entry_names.sql
  db/migrations/20260921_000005_arena_league_entries_token_address_identity.sql
  db/migrations/20260921_000006_league_epoch_roots.sql
)

# One transaction per group. Files carry their own begin/commit; those lines are
# dropped so the group is atomic.
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
        if (!/20260921_000002_market_trades_v/.test(process.argv[1])) {
          sql = sql.replace(/create or replace view public\.market_trades_v[\s\S]*?from public\.dex_trades t[^;]*;/gi,
            "-- [bundle] market_trades_v redefinition removed; live view shape kept (see 20260921_000002)\n");
          if (/create or replace view public\.market_trades_v/i.test(sql)) throw new Error("view redefinition still present in " + process.argv[1]);
        }
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
    from (values ('token_holder_balances'),('arena_battle_metrics'),('arena_battle_points_v3'),('arena_contest_actions'),
                 ('arena_vote_tiebreaks'),('arena_solana_boost_quotes'),('arena_battle_scoring_locks'),
                 ('arena_championship_epochs'),('arena_mwl_finalizations'),('sponsorship_payments')) t(name)
   union all
  select 'arena_battles.'||c.col, case when exists (select 1 from information_schema.columns where table_schema='public' and table_name='arena_battles' and column_name=c.col) then 'present' else '$1' end
    from (values ('battle_mode'),('money_winner_token'),('settled_at'),('contest_scoring_version'),('competition_generation')) c(col)
   union all
  select 'market_trades_v.volumeUsd', case when exists (select 1 from information_schema.columns where table_schema='public' and table_name='market_trades_v' and column_name='volumeUsd') then 'present' else '$1' end
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
if [ "$MODE" = "dryrun" ]; then
  # A rehearsal cannot commit group A, so group B would not see its tables;
  # rehearse both groups as one rolled-back transaction instead.
  bundle "$WORK/all.sql" "${GROUP_A[@]}" "${GROUP_B[@]}"
  echo; echo "--- groups A+B (dryrun, one transaction): $((${#GROUP_A[@]} + ${#GROUP_B[@]})) files ---"
  run_sql "$WORK/all.sql"
else
  bundle "$WORK/group-a.sql" "${GROUP_A[@]}"
  bundle "$WORK/group-b.sql" "${GROUP_B[@]}"
  echo; echo "--- group A (apply): ${#GROUP_A[@]} files ---"
  run_sql "$WORK/group-a.sql"
  echo "--- group B (apply): ${#GROUP_B[@]} files ---"
  run_sql "$WORK/group-b.sql"
fi
echo; echo "=== after (every row must read present when MODE=apply) ==="; check "STILL MISSING"
rm -rf "$WORK"
