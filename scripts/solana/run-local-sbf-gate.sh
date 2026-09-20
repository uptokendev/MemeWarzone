#!/usr/bin/env bash
# Load the compiled MemeWarzone .so into a local validator at the mainnet
# program ID and run create + bonding lifecycle. Nothing touches mainnet.
#
#   git checkout fix/solana-create-stack-overflow
#   bash scripts/solana/run-local-sbf-gate.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

PROGRAM_ID="3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt"
SO="$ROOT/target/deploy/memewarzone_solana.so"

# create_campaign CPIs into Metaplex to write the token metadata, so the
# validator needs the real program. Without it every successful-create test dies
# with "Account metaqbxx... is not executable" -- which looks like a program bug
# and is not one. Cached after the first fetch; delete the file to refresh.
MPL_PROGRAM_ID="metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
MPL_SO="$ROOT/target/deploy/mpl_token_metadata.so"
MPL_SOURCE_URL="${MWZ_MPL_SOURCE_URL:-https://api.mainnet-beta.solana.com}"
WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"

if ! command -v anchor >/dev/null 2>&1; then
  echo "anchor CLI is required (run inside WSL with the Solana toolchain)" >&2
  exit 1
fi
if ! command -v solana-test-validator >/dev/null 2>&1; then
  echo "solana-test-validator is required" >&2
  exit 1
fi

echo "==> building memewarzone_solana"
anchor build -p memewarzone_solana
if [[ ! -f "$SO" ]]; then
  echo "missing $SO" >&2
  exit 1
fi

if [[ ! -s "$MPL_SO" ]]; then
  echo "==> fetching Metaplex token metadata program from $MPL_SOURCE_URL"
  if ! solana program dump "$MPL_PROGRAM_ID" "$MPL_SO" --url "$MPL_SOURCE_URL"; then
    echo "could not fetch $MPL_PROGRAM_ID; the create tests cannot write metadata without it" >&2
    rm -f "$MPL_SO"
    exit 1
  fi
fi
echo "==> Metaplex artifact $(wc -c < "$MPL_SO" | tr -d ' ') bytes"

HASH="$(sha256sum "$SO" | awk '{print $1}')"
BYTES="$(wc -c < "$SO" | tr -d ' ')"
echo "==> SBF artifact"
echo "    program_id=$PROGRAM_ID"
echo "    bytes=$BYTES"
echo "    sha256=$HASH"
echo "$HASH" > "$ROOT/target/deploy/memewarzone_solana.sha256"

# Ledger must live on a Linux filesystem. /mnt/e (NTFS) stalls slot production.
LEDGER="${MWZ_LOCAL_LEDGER:-/tmp/mwz-sbf-ledger}"
VALIDATOR_PID=""

cleanup() {
  if [[ -n "${VALIDATOR_PID}" ]]; then
    kill "$VALIDATOR_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

start_validator() {
  if [[ -n "${VALIDATOR_PID}" ]]; then
    kill "$VALIDATOR_PID" >/dev/null 2>&1 || true
    wait "$VALIDATOR_PID" >/dev/null 2>&1 || true
    VALIDATOR_PID=""
  fi
  echo "==> starting solana-test-validator with this exact .so"
  solana-test-validator \
    --reset \
    --ledger "$LEDGER" \
    --limit-ledger-size 50000000 \
    --bind-address 127.0.0.1 \
    --rpc-port 8899 \
    --bpf-program "$PROGRAM_ID" "$SO" \
    --bpf-program "$MPL_PROGRAM_ID" "$MPL_SO" \
    --quiet \
    >/tmp/mwz-local-validator.log 2>&1 &
  VALIDATOR_PID=$!
  for _ in $(seq 1 60); do
    if solana cluster-version --url http://127.0.0.1:8899 >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  echo "validator did not become ready; last log:" >&2
  tail -n 40 /tmp/mwz-local-validator.log >&2 || true
  exit 1
}

export ANCHOR_PROVIDER_URL="http://127.0.0.1:8899"
export ANCHOR_WALLET="$WALLET"
if [[ ! -f "$WALLET" ]]; then
  echo "ANCHOR_WALLET not found: $WALLET" >&2
  echo "Create one with: solana-keygen new -o $WALLET" >&2
  exit 1
fi
PAYER="$(solana-keygen pubkey "$WALLET")"

fund_payer() {
  echo "==> funding test payer $PAYER"
  solana airdrop 100 "$PAYER" --url http://127.0.0.1:8899
  solana balance "$PAYER" --url http://127.0.0.1:8899
}

start_validator
fund_payer

echo "==> create acceptance"
npm --prefix tests/solana test -- --grep "authorization V4 local-validator acceptance"

# Create suite owns GlobalConfig. Lifecycle generates its own route signer, so
# it needs a fresh validator (same .so, empty accounts).
start_validator
fund_payer

echo "==> bonding lifecycle (simulate then send; includes cluster/routing/pause negatives)"
npm --prefix tests/solana run test:lifecycle

echo "==> GATE PASS"
echo "    sha256=$HASH"
echo "    Deploy this exact file: $SO"
echo "    Then set Coolify/Railway SOLANA_LAUNCHPAD_PROGRAM_SHA256=$HASH"
