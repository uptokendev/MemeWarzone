#!/usr/bin/env bash
# Copy production public schema+data into the testnet Supabase project.
# Requires: SRC_DATABASE_URL (prod session pooler :5432) and DEST_DATABASE_URL
# (vrnsbguutnwgtekcexls session pooler :5432).
#
# Usage:
#   SRC_DATABASE_URL='postgresql://postgres.ellkfgoxnzykxqybajtn:...@aws-1-eu-west-1.pooler.supabase.com:5432/postgres' \
#   DEST_DATABASE_URL='postgresql://postgres.vrnsbguutnwgtekcexls:...@aws-1-<region>.pooler.supabase.com:5432/postgres' \
#   ./scripts/copy-prod-public-to-staging.sh
set -euo pipefail

DUMP="${DUMP_PATH:-/tmp/mwz-prod-public.dump}"
DEST_REF="vrnsbguutnwgtekcexls"
PROD_REF="ellkfgoxnzykxqybajtn"
PG17_BIN="${PG17_BIN:-/tmp/pg17-client/root/usr/lib/postgresql/17/bin}"
if [[ -x "$PG17_BIN/pg_dump" ]]; then
  export LD_LIBRARY_PATH="/tmp/pg17-client/root/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
  export PATH="$PG17_BIN:$PATH"
fi
echo "pg_dump: $(pg_dump --version)"
echo "psql:    $(psql --version)"

: "${SRC_DATABASE_URL:?set SRC_DATABASE_URL to production session-pooler URI on port 5432}"
: "${DEST_DATABASE_URL:?set DEST_DATABASE_URL to ${DEST_REF} session-pooler URI on port 5432}"

if [[ "$SRC_DATABASE_URL" != *"$PROD_REF"* ]]; then
  echo "refusing: SRC_DATABASE_URL does not contain production ref $PROD_REF" >&2
  exit 1
fi
if [[ "$DEST_DATABASE_URL" != *"$DEST_REF"* ]]; then
  echo "refusing: DEST_DATABASE_URL does not contain staging ref $DEST_REF" >&2
  exit 1
fi
if [[ "$DEST_DATABASE_URL" == *"$PROD_REF"* ]]; then
  echo "refusing: destination looks like production" >&2
  exit 1
fi
if [[ "$SRC_DATABASE_URL" == *":6543/"* || "$DEST_DATABASE_URL" == *":6543/"* ]]; then
  echo "refusing: use session pooler port 5432, not transaction pooler 6543" >&2
  exit 1
fi

export PGSSLMODE=require

echo "==> dumping production public schema to $DUMP"
pg_dump --dbname="$SRC_DATABASE_URL" \
  --format=custom --no-owner --no-privileges \
  --schema=public \
  --file="$DUMP"

echo "==> resetting destination public schema"
psql "$DEST_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO postgres, service_role;
SQL

echo "==> restoring into $DEST_REF"
pg_restore --dbname="$DEST_DATABASE_URL" \
  --no-owner --no-privileges --schema=public \
  --exit-on-error \
  "$DUMP"

echo "==> applying testnet RLS/grants fix"
psql "$DEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$(dirname "$0")/../database/staging_rls_grants_fix.sql"

echo "==> recreate storage buckets (objects are not in this dump)"
psql "$DEST_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
insert into storage.buckets (id, name, public)
values
  ('UPMEME', 'UPMEME', true),
  ('MEMEBATTLES', 'MEMEBATTLES', true),
  ('submissions-images', 'submissions-images', true),
  ('abuse-evidence-private', 'abuse-evidence-private', false)
on conflict (id) do nothing;
SQL

echo "done. Point Coolify TESTNET indexer/API/frontend at this project only."
echo "Do not change production DATABASE_URL."
