#!/usr/bin/env bash
# PROOF, local validator only: graduation payout of the certified launchpad .so
# under the live mainnet generation economics. Never builds (the certified
# binary is used as-is), never talks to devnet or mainnet for transactions.
#
#   ANCHOR_WALLET=<throwaway keypair> bash scripts/solana/run-proof-graduation-payout.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

PROGRAM_ID="3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt"
SO="$ROOT/target/deploy/memewarzone_solana.so"
CERTIFIED="e6ed7df37dfe3bf8ec7914f7bcae9ebd50b21b0844cff80c2a851c64bfafdcb2"
MPL_PROGRAM_ID="metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
MPL_SO="$ROOT/target/deploy/mpl_token_metadata.so"
METEORA_PROGRAM_ID="cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"
METEORA_SO="$ROOT/third_party/meteora/cp_amm.so"
METEORA_ACCOUNTS="$ROOT/third_party/meteora/accounts"
ORCA_PROGRAM_ID="whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"
ORCA_SO="$ROOT/third_party/orca/whirlpool.so"
ORCA_ACCOUNTS="$ROOT/third_party/orca/accounts"
WALLET="${ANCHOR_WALLET:?ANCHOR_WALLET must point at a throwaway keypair}"
LEDGER="${MWZ_LOCAL_LEDGER:-/tmp/mwz-proof-ledger}"
RPC="http://127.0.0.1:8899"

HASH="$(sha256sum "$SO" | awk '{print $1}')"
if [[ "$HASH" != "$CERTIFIED" ]]; then
  echo "refusing: $SO is $HASH, not the certified $CERTIFIED" >&2
  exit 1
fi
for f in "$MPL_SO" "$METEORA_SO" "$ORCA_SO"; do
  [[ -s "$f" ]] || { echo "missing $f (run-local-sbf-gate.sh fetches it)" >&2; exit 1; }
done
if solana cluster-version --url "$RPC" >/dev/null 2>&1; then
  echo "a validator is already listening on $RPC; stop it first" >&2
  exit 1
fi

VALIDATOR_PID=""
cleanup() { [[ -n "$VALIDATOR_PID" ]] && kill "$VALIDATOR_PID" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> starting solana-test-validator with the certified .so ($HASH)"
solana-test-validator --reset --ledger "$LEDGER" --limit-ledger-size 50000000 \
  --bind-address 127.0.0.1 --rpc-port 8899 \
  --bpf-program "$PROGRAM_ID" "$SO" \
  --bpf-program "$MPL_PROGRAM_ID" "$MPL_SO" \
  --bpf-program "$METEORA_PROGRAM_ID" "$METEORA_SO" \
  --bpf-program "$ORCA_PROGRAM_ID" "$ORCA_SO" \
  --account-dir "$METEORA_ACCOUNTS" --account-dir "$ORCA_ACCOUNTS" \
  --quiet >/tmp/mwz-proof-validator.log 2>&1 &
VALIDATOR_PID=$!
for _ in $(seq 1 60); do
  solana cluster-version --url "$RPC" >/dev/null 2>&1 && break
  sleep 0.5
done
solana cluster-version --url "$RPC" >/dev/null

export ANCHOR_PROVIDER_URL="$RPC"
export ANCHOR_WALLET="$WALLET"
solana airdrop 100 "$(solana-keygen pubkey "$WALLET")" --url "$RPC" >/dev/null

"$ROOT/tests/solana/node_modules/.bin/mocha" --timeout 1000000 tests/solana/proof-graduation-payout-mainnet-economics.cjs
