#!/usr/bin/env bash
# Local SBF gate for mwz_rewards_treasury: build from HEAD, prove the arena
# money path and every reward claim rail on a validator running that exact
# .so, and emit the SHA manifest preflight-rewards-treasury-upgrade.sh checks.
#
# Same shape as run-local-sbf-gate.sh (the launchpad gate); nothing is deployed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

PROGRAM_ID="2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX"
SO="$ROOT/target/deploy/mwz_rewards_treasury.so"
IDL="$ROOT/target/idl/mwz_rewards_treasury.json"
MANIFEST="$ROOT/target/deploy/rewards-treasury-sha256.txt"
WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
LEDGER="${MWZ_TREASURY_LEDGER:-/tmp/mwz-treasury-ledger}"

command -v anchor >/dev/null 2>&1 || { echo "anchor CLI is required" >&2; exit 1; }
command -v solana-test-validator >/dev/null 2>&1 || { echo "solana-test-validator is required" >&2; exit 1; }

if [[ "${MWZ_SKIP_BUILD:-0}" != "1" ]]; then
  echo "==> building mwz_rewards_treasury"
  anchor build -p mwz_rewards_treasury
fi
[[ -f "$SO" ]] || { echo "missing $SO" >&2; exit 1; }
[[ -f "$IDL" ]] || { echo "missing $IDL" >&2; exit 1; }

HASH="$(sha256sum "$SO" | awk '{print $1}')"
BYTES="$(wc -c < "$SO" | tr -d ' ')"
IDL_HASH="$(sha256sum "$IDL" | awk '{print $1}')"
echo "==> SBF artifact"
echo "    program_id=$PROGRAM_ID"
echo "    bytes=$BYTES"
echo "    sha256=$HASH"
echo "    idl_sha256=$IDL_HASH"
# sha256sum --check format, paths relative to the manifest's directory.
printf '%s  %s\n%s  %s\n' "$HASH" "mwz_rewards_treasury.so" "$IDL_HASH" "../idl/mwz_rewards_treasury.json" > "$MANIFEST"
echo "$HASH" > "$ROOT/target/deploy/mwz_rewards_treasury.sha256"

VALIDATOR_PID=""
cleanup() {
  if [[ -n "${VALIDATOR_PID}" ]]; then
    kill "$VALIDATOR_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "==> starting solana-test-validator with this exact .so"
solana-test-validator \
  --reset \
  --ledger "$LEDGER" \
  --limit-ledger-size 50000000 \
  --bind-address 127.0.0.1 \
  --rpc-port 8899 \
  --bpf-program "$PROGRAM_ID" "$SO" \
  --quiet \
  >/tmp/mwz-treasury-validator.log 2>&1 &
VALIDATOR_PID=$!
for _ in $(seq 1 60); do
  if solana cluster-version --url http://127.0.0.1:8899 >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
solana cluster-version --url http://127.0.0.1:8899 >/dev/null 2>&1 || {
  echo "validator did not become ready; last log:" >&2
  tail -n 40 /tmp/mwz-treasury-validator.log >&2 || true
  exit 1
}

export ANCHOR_PROVIDER_URL="http://127.0.0.1:8899"
export ANCHOR_WALLET="$WALLET"
[[ -f "$WALLET" ]] || { echo "ANCHOR_WALLET not found: $WALLET" >&2; exit 1; }
PAYER="$(solana-keygen pubkey "$WALLET")"
echo "==> funding test payer $PAYER"
solana airdrop 100 "$PAYER" --url http://127.0.0.1:8899 >/dev/null

echo "==> arena money v2 + reward claims acceptance"
npm --prefix tests/solana run test:treasury

echo "==> TREASURY GATE PASS"
echo "    sha256=$HASH"
echo "    manifest=$MANIFEST"
echo "    Deploy this exact file: $SO"
echo "    Preflight: SOLANA_RPC_URL=<rpc> scripts/solana/preflight-rewards-treasury-upgrade.sh $SO $IDL $MANIFEST"
