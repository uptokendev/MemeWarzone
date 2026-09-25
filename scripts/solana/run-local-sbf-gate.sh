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

# The lifecycle suite's "Gate K: graduate closed campaign into pinned DAMM v2"
# test asks the validator whether the Meteora program is executable and calls
# this.skip() when it is not. Without the pinned binary that test reported as
# pending, so the gate passed while the graduation path -- the whole point of
# the campaign closing -- was never executed. Load it and the test runs.
METEORA_PROGRAM_ID="cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"
METEORA_SO="$ROOT/third_party/meteora/cp_amm.so"
METEORA_ACCOUNTS="$ROOT/third_party/meteora/accounts"

# Orca is the acquisition leg: a bound graduation swaps the raised SOL into the
# quote before Meteora sees it. Without it the bound test has no route and skips,
# which is how the native graduation went unproven for so long.
ORCA_PROGRAM_ID="whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"
ORCA_SO="$ROOT/third_party/orca/whirlpool.so"
ORCA_ACCOUNTS="$ROOT/third_party/orca/accounts"
ORCA_SOURCE_URL="${MWZ_ORCA_SOURCE_URL:-https://api.devnet.solana.com}"
ORCA_CLONE_ACCOUNTS=(
  "FcrweFY1G9HJAHG5inkGB6pKg1HZ6x9UC2WioAfWrGkR"
  "CtfHwxDmdYtoWyeSyh3NUWk43FnehVhhtwuYdWwZcVyt"
  "nhg1SS1hNFnJKZrJ9FBf3L6SxTjwEnkehN7dmAbg25t"
  "G319n1BPjeXjAfheDxYe8KWZM7FQhQCJerWRK2nZYtiJ"
)

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

# Pinned by config/solana/meteora-cp-amm.certification.json (sha256, byte count
# and git blob); the fetcher verifies all three, so a moved upstream artifact
# fails here rather than silently changing what the gate proves.
if [[ ! -s "$METEORA_SO" || ! -d "$METEORA_ACCOUNTS" ]]; then
  echo "==> fetching pinned Meteora DAMM v2 artifacts"
  node "$ROOT/scripts/solana/fetch-pinned-meteora-cp-amm.mjs" --with-accounts
fi
if [[ ! -s "$METEORA_SO" ]]; then
  echo "missing $METEORA_SO; graduation into DAMM v2 cannot be proven" >&2
  exit 1
fi
echo "==> Meteora artifact $(wc -c < "$METEORA_SO" | tr -d ' ') bytes, $(ls -1 "$METEORA_ACCOUNTS" | wc -l | tr -d ' ') pinned accounts"

if [[ ! -s "$ORCA_SO" ]]; then
  echo "==> cloning Orca Whirlpool program"
  mkdir -p "$(dirname "$ORCA_SO")"
  solana program dump "$ORCA_PROGRAM_ID" "$ORCA_SO" --url "$ORCA_SOURCE_URL" >/dev/null \
    || { echo "could not clone the Orca program" >&2; rm -f "$ORCA_SO"; exit 1; }
fi
mkdir -p "$ORCA_ACCOUNTS"
for acct in "${ORCA_CLONE_ACCOUNTS[@]}"; do
  [[ -s "$ORCA_ACCOUNTS/$acct.json" ]] && continue
  solana account "$acct" --url "$ORCA_SOURCE_URL" --output json --output-file "$ORCA_ACCOUNTS/$acct.json" >/dev/null \
    || { echo "could not clone Orca account $acct" >&2; rm -f "$ORCA_ACCOUNTS/$acct.json"; exit 1; }
done
echo "==> Orca artifact $(wc -c < "$ORCA_SO" | tr -d ' ') bytes, $(ls -1 "$ORCA_ACCOUNTS" | wc -l | tr -d ' ') cloned accounts"

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
    --bpf-program "$METEORA_PROGRAM_ID" "$METEORA_SO" \
    --bpf-program "$ORCA_PROGRAM_ID" "$ORCA_SO" \
    --account-dir "$METEORA_ACCOUNTS" \
    --account-dir "$ORCA_ACCOUNTS" \
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
npm --prefix tests/solana run test:lifecycle 2>&1 | tee /tmp/mwz-lifecycle.log
if grep -qE "^\s+- Gate K[23]?:" /tmp/mwz-lifecycle.log; then
  echo "Gate K graduation test reported pending: Meteora was not executable on the validator." >&2
  echo "The gate must not pass while the graduation path is skipped." >&2
  exit 1
fi

# Token-2022 quote acceptance: the extension allowlist read off mints the token
# program actually wrote, the ATA the authorization derives proven to be the
# account that exists, and a real DAMM v2 pool whose quote side is Token-2022.
# The launchpad accepts these assets; without this nothing showed they work.
echo "==> Token-2022 quote acceptance (real mints + DAMM v2 pool)"
npm --prefix tests/solana run test:token-2022 2>&1 | tee /tmp/mwz-token-2022.log
if grep -qE "^\s+- (initializes a pool whose quote side|reads no extensions)" /tmp/mwz-token-2022.log; then
  echo "Token-2022 acceptance reported pending instead of running." >&2
  exit 1
fi

echo "==> GATE PASS"
echo "    sha256=$HASH"
echo "    Deploy this exact file: $SO"
echo "    Then set Coolify/Railway SOLANA_LAUNCHPAD_PROGRAM_SHA256=$HASH"
