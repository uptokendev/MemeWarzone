#!/usr/bin/env bash
# Local Postgres for the release browser test: staging's public schema (read-only pg_dump) plus every
# migration of this release, on 127.0.0.1:55440, database mwz, in $MWZ_BROWSER_WORK/pgdata.
# Staging runs PG 17; without sudo get the client with:
#   mkdir -p ~/pg17 && cd ~/pg17 && apt-get download postgresql-client-17 libpq5 && for f in *.deb; do dpkg -x $f root; done
set -euo pipefail
WORK="${MWZ_BROWSER_WORK:-$HOME/mwz-browser}"; MAIN="${MWZ_MAIN_REPO:-/mnt/e/network/Zakelijk/MemeWarzone}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"; B=/usr/lib/postgresql/16/bin; P17="$HOME/pg17/root/usr/lib/postgresql/17/bin"
export LD_LIBRARY_PATH="$(dirname "$(find "$HOME/pg17/root" -name libpq.so.5 | head -1)")"
mkdir -p "$WORK"
if [ ! -s "$WORK/schema16.sql" ]; then
  U=$(grep -E "^STAGING_DATABASE_URL=" "$MAIN/frontend/.env.local" | head -1 | cut -d= -f2- | tr -d '"')
  PGSSLMODE=require "$P17/pg_dump" "$U" --schema-only --no-owner --no-privileges -n public | sed '/^SET transaction_timeout/d' > "$WORK/schema16.sql"
fi
rm -rf "$WORK/pgdata"
"$B/initdb" -D "$WORK/pgdata" --auth=trust -U postgres --no-instructions >/dev/null
"$B/pg_ctl" -D "$WORK/pgdata" -l "$WORK/pg.log" -o "-p 55440 -k $WORK" start >/dev/null; sleep 2
Q="psql -h 127.0.0.1 -p 55440 -U postgres -q"
$Q -c "create database mwz"
$Q -d mwz -c "create role authenticated; create role anon; create role service_role;"
$Q -d mwz -f "$WORK/schema16.sql" 2>&1 | grep -v 'schema "public" already exists' | grep -i error || true
for f in "$ROOT/docs/dbc/release/dbc-solana-migrations.sql" "$ROOT"/db/migrations/20260930_*.sql "$ROOT"/db/migrations/20261001_000001*.sql; do
  $Q -d mwz -v ON_ERROR_STOP=1 -f "$f"
done
echo "postgres://postgres@127.0.0.1:55440/mwz ready"
