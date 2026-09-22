#!/usr/bin/env bash
# Full graduation with a bound (non-SOL) quote, on one local validator.
#
# The binding path is the one thing the gate could not prove. On devnet it is
# blocked by liquidity we cannot create: the only quote with an Orca pool is
# Circle's USDC, its pool holds about 9 USDC, and its mint authority is not
# ours. Here the cluster is ours, so the quote asset, its pool and its depth are
# all things we can simply create.
#
# Loads four programs, because a bound graduation touches all of them in one
# transaction: the launchpad, Metaplex (create writes token metadata), Meteora
# DAMM v2 (the pool the graduation binds into) and Orca (the swap that turns the
# raised SOL into the quote first).
#
#   bash scripts/solana/run-local-binding-e2e.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

LAUNCHPAD_ID="3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt"
LAUNCHPAD_SO="$ROOT/target/deploy/memewarzone_solana.so"
MPL_ID="metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
MPL_SO="$ROOT/target/deploy/mpl_token_metadata.so"
METEORA_ID="cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"
METEORA_SO="$ROOT/third_party/meteora/cp_amm.so"
METEORA_ACCOUNTS="$ROOT/third_party/meteora/accounts"
ORCA_ID="whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"
ORCA_SO="$ROOT/third_party/orca/whirlpool.so"
ORCA_ACCOUNTS="$ROOT/third_party/orca/accounts"

WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
LEDGER="${MWZ_BINDING_LEDGER:-/tmp/mwz-binding-ledger}"
RPC="http://127.0.0.1:8899"
VALIDATOR_PID=""

cleanup() { [[ -n "$VALIDATOR_PID" ]] && kill "$VALIDATOR_PID" >/dev/null 2>&1 || true; }
trap cleanup EXIT

ORCA_SOURCE_URL="${MWZ_ORCA_SOURCE_URL:-https://api.devnet.solana.com}"
ORCA_CONFIG="FcrweFY1G9HJAHG5inkGB6pKg1HZ6x9UC2WioAfWrGkR"
# Fee tiers the pool builders look up. 32768 (splash) does not exist on this
# deployment, which is why the pools here are concentrated ones.
ORCA_FEE_TIERS=(
  "CtfHwxDmdYtoWyeSyh3NUWk43FnehVhhtwuYdWwZcVyt"
  "nhg1SS1hNFnJKZrJ9FBf3L6SxTjwEnkehN7dmAbg25t"
  "G319n1BPjeXjAfheDxYe8KWZM7FQhQCJerWRK2nZYtiJ"
)

# Cloned rather than committed, same as the Meteora fixtures.
if [[ ! -s "$ORCA_SO" ]]; then
  echo "==> cloning Orca Whirlpool program from $ORCA_SOURCE_URL"
  mkdir -p "$(dirname "$ORCA_SO")"
  solana program dump whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc "$ORCA_SO" --url "$ORCA_SOURCE_URL" >/dev/null     || { echo "could not clone the Orca program" >&2; rm -f "$ORCA_SO"; exit 1; }
fi
mkdir -p "$ORCA_ACCOUNTS"
for acct in "$ORCA_CONFIG" "${ORCA_FEE_TIERS[@]}"; do
  [[ -s "$ORCA_ACCOUNTS/$acct.json" ]] && continue
  echo "==> cloning Orca account $acct"
  solana account "$acct" --url "$ORCA_SOURCE_URL" --output json --output-file "$ORCA_ACCOUNTS/$acct.json" >/dev/null     || { echo "could not clone Orca account $acct" >&2; rm -f "$ORCA_ACCOUNTS/$acct.json"; exit 1; }
done

for f in "$LAUNCHPAD_SO" "$MPL_SO" "$METEORA_SO" "$ORCA_SO"; do
  [[ -s "$f" ]] || { echo "missing $f" >&2; exit 1; }
done
[[ -f "$WALLET" ]] || { echo "ANCHOR_WALLET not found: $WALLET" >&2; exit 1; }

echo "==> artifacts"
echo "    launchpad $(sha256sum "$LAUNCHPAD_SO" | cut -c1-16) $(wc -c < "$LAUNCHPAD_SO") bytes"
echo "    orca      $(wc -c < "$ORCA_SO") bytes, $(ls -1 "$ORCA_ACCOUNTS" | wc -l | tr -d ' ') cloned accounts"
echo "    meteora   $(wc -c < "$METEORA_SO") bytes, $(ls -1 "$METEORA_ACCOUNTS" | wc -l | tr -d ' ') cloned accounts"

echo "==> starting validator with launchpad + Metaplex + Meteora + Orca"
rm -rf "$LEDGER"
solana-test-validator \
  --reset --quiet --ledger "$LEDGER" --limit-ledger-size 50000000 \
  --bind-address 127.0.0.1 --rpc-port 8899 \
  --bpf-program "$LAUNCHPAD_ID" "$LAUNCHPAD_SO" \
  --bpf-program "$MPL_ID" "$MPL_SO" \
  --bpf-program "$METEORA_ID" "$METEORA_SO" \
  --bpf-program "$ORCA_ID" "$ORCA_SO" \
  --account-dir "$METEORA_ACCOUNTS" \
  --account-dir "$ORCA_ACCOUNTS" \
  > /tmp/mwz-binding-validator.log 2>&1 &
VALIDATOR_PID=$!

for _ in $(seq 1 90); do
  solana cluster-version --url "$RPC" >/dev/null 2>&1 && break
  sleep 0.5
done
solana cluster-version --url "$RPC" >/dev/null 2>&1 || {
  echo "validator did not start" >&2; tail -30 /tmp/mwz-binding-validator.log >&2; exit 1; }
echo "    up: $(solana cluster-version --url "$RPC")"

# Every loaded program must be executable, or the failure shows up much later as
# an opaque instruction error.
for pair in "launchpad:$LAUNCHPAD_ID" "metaplex:$MPL_ID" "meteora:$METEORA_ID" "orca:$ORCA_ID"; do
  name="${pair%%:*}"; id="${pair##*:}"
  if solana account "$id" --url "$RPC" 2>/dev/null | grep -q "Executable: true"; then
    echo "    $name executable"
  else
    echo "$name ($id) is not executable on the validator" >&2; exit 1
  fi
done

PAYER="$(solana-keygen pubkey "$WALLET")"
solana airdrop 500 "$PAYER" --url "$RPC" >/dev/null
echo "==> payer $PAYER $(solana balance "$PAYER" --url "$RPC")"

echo "==> minting quote assets and seeding Orca pools"
SOLANA_RPC_URL="$RPC" \
SOLANA_GRADUATION_OPERATOR_KEYPAIR="$WALLET" \
SEED_POOL_SOL="${SEED_POOL_SOL:-20}" \
SEED_PRICE_USD="${SEED_PRICE_USD:-117}" \
SEED_TICK_SPACING="${SEED_TICK_SPACING:-64}" \
SEED_REPORT="${SEED_REPORT:-/tmp/mwz-local-quote-pools.json}" \
  node tools/solana-meteora-graduation/seed-quote-pools.mjs --execute

REPORT="${SEED_REPORT:-/tmp/mwz-local-quote-pools.json}"
echo "==> pools seeded"
cat "$REPORT"

# Seeding a pool only helps if the quote it produces is acceptable. This is the
# exact check that failed on devnet, where the pool existed but was too thin.
echo "==> graduation-sized swap quote through each pool"
SOLANA_RPC_URL="$RPC" SOLANA_GRADUATION_OPERATOR_KEYPAIR="$WALLET" POOLS_REPORT="$REPORT" PROBE_SWAP_LAMPORTS="${PROBE_SWAP_LAMPORTS:-94000000}" PROBE_MAX_IMPACT_BPS="${PROBE_MAX_IMPACT_BPS:-300}"   node tools/solana-meteora-graduation/check-quote-pool-depth.mjs

echo "==> LOCAL BINDING E2E: pools seeded and deep enough"
