#!/usr/bin/env bash
set -euo pipefail

export SOLANA_APPLICATION_CHAIN_ID="${SOLANA_APPLICATION_CHAIN_ID:-101}"
export SOLANA_LAUNCHPAD_PROGRAM_ID="${SOLANA_LAUNCHPAD_PROGRAM_ID:-3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt}"
export SOLANA_EXPECTED_DEVNET_GENESIS="${SOLANA_EXPECTED_DEVNET_GENESIS:-EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG}"
export SOLANA_LAUNCHPAD_PROGRAM_SHA256="${SOLANA_LAUNCHPAD_PROGRAM_SHA256:-27ad65b560dba8a33330bd95f08ae7ca6945f71ebf667a5a3756ae0cb9f7f080}"
export SOLANA_LAUNCHPAD_PROGRAM_BYTES="${SOLANA_LAUNCHPAD_PROGRAM_BYTES:-1165328}"
export SOLANA_DEVNET_PAYER="${SOLANA_DEVNET_PAYER:-${SOLANA_PRIVATE_KEY:-}}"
export RUNTIME_ENVIRONMENT="staging"
export SOLANA_ENVIRONMENT="staging"
export SOLANA_CLUSTER="devnet"
export SOLANA_GRADUATION_CHAIN_ID="101"
export SOLANA_GRADUATION_BASIC_RELEASE_ONLY="true"
export SOLANA_GRADUATION_NATIVE_QUOTE_CONFIG_ID="a2100000-0000-4000-8000-000000000201"
export SOLANA_GRADUATION_QUOTE_CONFIG_ID="$SOLANA_GRADUATION_NATIVE_QUOTE_CONFIG_ID"
export SOLANA_GRADUATION_SOL_USD_MICROS="${SOLANA_GRADUATION_SOL_USD_MICROS:-145948162}"
export SOLANA_GRADUATION_SEND="true"
export SOLANA_GRADUATION_AUTH_ENABLED="true"
export SOLANA_NETWORK_CANARY_REPORT="${SOLANA_NETWORK_CANARY_REPORT:-/tmp/mwz-solana-101-canary.json}"
export SOLANA_POSTGRAD_CANARY_REPORT="${SOLANA_POSTGRAD_CANARY_REPORT:-/tmp/mwz-solana-101-postgrad.json}"
export SOLANA_GRADUATION_FIXTURE_OUTPUT="$SOLANA_NETWORK_CANARY_REPORT"
export SOLANA_GRADUATION_PAUSE_SNAPSHOT="${SOLANA_GRADUATION_PAUSE_SNAPSHOT:-/tmp/mwz-solana-101-pause-snapshot.json}"

required() {
  local name="$1"
  test -n "${!name:-}" || { echo "BLOCKER: ${name} is required" >&2; exit 1; }
}

required SOLANA_RPC_URL
required SOLANA_DEVNET_PAYER
required SOLANA_DEVNET_ROUTE_SIGNER_SECRET_KEY
required SOLANA_UPGRADE_AUTHORITY_PUBLIC_KEY
required DATABASE_URL

test "$SOLANA_APPLICATION_CHAIN_ID" = "101" || { echo "BLOCKER: current Solana application identity is 101 only" >&2; exit 1; }
for name in SOLANA_SQUAD_CHAIN_ID SQUAD_SOLANA_CHAIN_ID AIRDROP_CHAIN_ID RECRUITER_SOLANA_CHAIN_ID LEAGUE_SOLANA_CHAIN_ID; do
  test "${!name:-}" != "102" || { echo "BLOCKER: legacy 102 leaked into active financial certification via $name" >&2; exit 1; }
done

operator_file="${RUNNER_TEMP:-/tmp}/mwz-solana-101-operator.json"
route_file="${RUNNER_TEMP:-/tmp}/mwz-solana-101-route.json"
SOLANA_GRADUATION_OPERATOR_KEYPAIR="$operator_file" node scripts/solana/materialize-devnet-payer.mjs >/dev/null
ROUTE_FILE="$route_file" node - <<'NODE'
const fs = require('fs');
const raw = JSON.parse(process.env.SOLANA_DEVNET_ROUTE_SIGNER_SECRET_KEY || 'null');
if (!Array.isArray(raw) || raw.length !== 64) throw new Error('SOLANA_DEVNET_ROUTE_SIGNER_SECRET_KEY must be a 64-byte JSON array');
fs.writeFileSync(process.env.ROUTE_FILE, JSON.stringify(raw));
fs.chmodSync(process.env.ROUTE_FILE, 0o600);
NODE
export SOLANA_OPERATOR_KEYPAIR="$operator_file"
export SOLANA_GRADUATION_OPERATOR_KEYPAIR="$operator_file"
export SOLANA_NEW_ROUTE_SIGNER_KEYPAIR="$route_file"
export SOLANA_ROUTE_SIGNER_SECRET_KEY="$SOLANA_DEVNET_ROUTE_SIGNER_SECRET_KEY"
export SOLANA_ROUTE_SIGNER_PUBLIC_KEY="$(ROUTE_FILE="$route_file" node - <<'NODE'
const fs=require('fs');
const {Keypair}=require('./tests/solana/node_modules/@solana/web3.js');
const kp=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.ROUTE_FILE,'utf8'))));
process.stdout.write(kp.publicKey.toBase58());
NODE
)"

node scripts/solana/network-canary.mjs

# Exact-source candidate must have been built by the workflow before this runner starts.
required SOLANA_LAUNCHPAD_PROGRAM_PATH
test -s "$SOLANA_LAUNCHPAD_PROGRAM_PATH" || { echo "BLOCKER: candidate SBF missing: $SOLANA_LAUNCHPAD_PROGRAM_PATH" >&2; exit 1; }
actual_sha="$(sha256sum "$SOLANA_LAUNCHPAD_PROGRAM_PATH" | awk '{print $1}')"
actual_bytes="$(wc -c < "$SOLANA_LAUNCHPAD_PROGRAM_PATH" | tr -d ' ')"
test "$actual_sha" = "$SOLANA_LAUNCHPAD_PROGRAM_SHA256" || { echo "BLOCKER: candidate SBF SHA mismatch $actual_sha" >&2; exit 1; }
test "$actual_bytes" = "$SOLANA_LAUNCHPAD_PROGRAM_BYTES" || { echo "BLOCKER: candidate SBF byte-size mismatch $actual_bytes" >&2; exit 1; }

# This re-reads Program, ProgramData, upgrade authority and deployed bytes from devnet.
npm --prefix tests/solana run devnet:deployment-identity

if [ "${SEND_SOLANA_GRADUATION:-false}" != "true" ]; then
  echo "SOLANA_101_CANARY=READ_ONLY_IDENTITY_PASS"
  echo "Set send_solana_graduation=true to execute CREATE->BUY->SELL->graduation->Meteora->post-grad BUY/SELL."
  exit 0
fi

# Canonical 101 only: use the current catalog row, never the historical native:102 certification migration.
for i in $(seq 1 30); do
  pg_isready -h 127.0.0.1 -p 5432 -U postgres -d postgres >/dev/null 2>&1 && break
  sleep 1
done
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f frontend/supabase/migrations/20260906231500_quote_asset_catalog.sql >/dev/null
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f frontend/supabase/migrations/20260907001000_solana_basic_quote_catalog.sql >/dev/null
psql "$DATABASE_URL" -Atc "select chain_id || ':' || identity_key from public.quote_asset_deployments where id='a2100000-0000-4000-8000-000000000201'::uuid" | grep -Fx '101:native:101'
if psql "$DATABASE_URL" -Atc "select count(*) from public.quote_asset_deployments where chain_id='102'" | grep -vq '^0$'; then
  echo "BLOCKER: ephemeral canonical certification catalog unexpectedly contains active chain-102 deployments" >&2
  exit 1
fi

# Fresh same-campaign V0/ALT lifecycle: CREATE -> BUY -> SELL -> close BUY.
node tests/solana/network-canary-101.cjs
campaign="$(node -e 'const r=require(process.env.SOLANA_NETWORK_CANARY_REPORT); process.stdout.write(r.campaign)')"
mint="$(node -e 'const r=require(process.env.SOLANA_NETWORK_CANARY_REPORT); process.stdout.write(r.mint)')"
alt="$(node -e 'const r=require(process.env.SOLANA_NETWORK_CANARY_REPORT); process.stdout.write(r.temporaryLaunchpadAlt)')"
export SOLANA_CAMPAIGN="$campaign"
export SOLANA_POSTGRAD_MINT="$mint"
export SOLANA_GRADUATION_ALT_ADDRESS="$alt"

restore_window() {
  if [ -s "$SOLANA_GRADUATION_PAUSE_SNAPSHOT" ]; then
    npm --prefix tests/solana run devnet:graduation-window -- restore || true
  fi
  if [ -s /tmp/mwz-solana-101-auth.pid ]; then
    kill "$(cat /tmp/mwz-solana-101-auth.pid)" >/dev/null 2>&1 || true
  fi
}
trap restore_window EXIT

npm --prefix tests/solana run devnet:graduation-window -- open
export SOLANA_GRADUATION_AUTH_URL="http://127.0.0.1:43101/api/solana/graduation-authorize"
nohup node scripts/solana/devnet-graduation-auth-server.mjs >/tmp/mwz-solana-101-auth.log 2>&1 &
echo $! >/tmp/mwz-solana-101-auth.pid
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:43101/health >/tmp/mwz-solana-101-auth-health.json; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:43101/health >/dev/null

# Exercise the exact BASIC native graduation transport used by PR #289 without changing it here.
node tools/solana-meteora-graduation/graduate-basic-quote.mjs "$campaign" | tee /tmp/mwz-solana-101-graduation.log
SOLANA_BASIC_RESULT_REPORT=/tmp/mwz-solana-101-graduation-result.json node tools/solana-meteora-graduation/verify-basic-graduation-result.mjs "$campaign" /tmp/mwz-solana-101-graduation.log So11111111111111111111111111111111111111112

# Same graduated mint: real Meteora post-grad BUY -> SELL with V0, ALT, LVH, retry and reload reconciliation.
node tools/solana-meteora-graduation/certify-postgrad-101.mjs

node - <<'NODE'
const fs=require('fs');
const pre=JSON.parse(fs.readFileSync(process.env.SOLANA_NETWORK_CANARY_REPORT,'utf8'));
const post=JSON.parse(fs.readFileSync(process.env.SOLANA_POSTGRAD_CANARY_REPORT,'utf8'));
if(pre.applicationChainId!==101||post.applicationChainId!==101) throw new Error('non-101 evidence rejected');
for(const key of ['create','buy','sell','closeBuy']){
  const x=pre[key];
  if(!x||x.version!=='V0'||!x.alt||!x.lastValidBlockHeight||x.retry!=='same-packet-deduped'||x.duplicateReplay!=='fresh-blockhash-intent-rejected'||x.expiredBlockhash!=='rejected') throw new Error(`pre-grad ${key} invariant missing`);
}
for(const key of ['buy','sell']){
  const x=post[key];
  if(!x||x.version!=='V0'||!x.alt||!x.lastValidBlockHeight||x.retry!=='same-packet-deduped') throw new Error(`post-grad ${key} invariant missing`);
}
if(post.reload?.status!=='PASS') throw new Error('post-grad reload reconciliation missing');
console.log('SOLANA_101_DESTRUCTIVE_CERTIFICATION=PASS');
console.log('CAMPAIGN='+pre.campaign);
console.log('MINT='+pre.mint);
console.log('POOL='+post.pool);
NODE

restore_window
trap - EXIT