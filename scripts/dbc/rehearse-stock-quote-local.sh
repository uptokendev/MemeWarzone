#!/usr/bin/env bash
# DBC step 7b: a stock-quoted DBC coin, end to end, on a local validator loaded with mainnet state.
#
# Reads mainnet (never writes): the DBC, DAMM v2, Token-2022, Metaplex and Meteora locker programs,
# the NVDAx mint, Meteora's DBC and DAMM v2 badges for it, and the DAMM v2 config DBC migrates into.
# The NVDAx mint is loaded with three authorities re-homed to a local key (mint, freeze, pause) so
# test wallets can hold NVDAx and the proof can pause it; every other byte is mainnet's.
#
#   SOLANA_MAINNET_RPC_URL=<rpc> bash scripts/dbc/rehearse-stock-quote-local.sh
#
# Falls back to SOLANA_RPC_URL in frontend/.env.local (the paid mainnet endpoint) for the dumps.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CACHE="${MWZ_DBC_7B_CACHE:-$HOME/.cache/mwz-dbc-7b}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mwz-dbc-7b-XXXXXX")"
PORT="${MWZ_DBC_7B_PORT:-18899}"
FAUCET_PORT=$((PORT + 2))
RPC_MAIN="${SOLANA_MAINNET_RPC_URL:-}"
if [[ -z "$RPC_MAIN" && -f "$ROOT/frontend/.env.local" ]]; then
  RPC_MAIN="$(grep -E '^SOLANA_RPC_URL=' "$ROOT/frontend/.env.local" | head -1 | cut -d= -f2- | tr -d '"')"
fi
[[ -n "$RPC_MAIN" ]] || { echo "SOLANA_MAINNET_RPC_URL is required for the mainnet dumps" >&2; exit 1; }

MAINNET_GENESIS="5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
GENESIS="$(curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash"}' "$RPC_MAIN" | sed -E 's/.*"result":"([^"]+)".*/\1/')"
[[ "$GENESIS" == "$MAINNET_GENESIS" ]] || { echo "dump RPC is not mainnet-beta ($GENESIS)" >&2; exit 1; }

DBC=dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN
DAMM=cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG
T22=TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
MPL=metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s
LOCKER=LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn
NVDAX=Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh
DBC_BADGE=mfacWnGh1Kn5ttHMMaNZhRZbCjvGrDQyDyZgqaR9vBM
DAMM_BADGE=HoeLtVnW6oWdhJCQrWDTwLSitWmUaR3bszz79ExYQPEM
DAMM_CONFIG=A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck

mkdir -p "$CACHE/programs" "$CACHE/accounts"
for pair in "dbc:$DBC" "damm:$DAMM" "token2022:$T22" "metaplex:$MPL" "locker:$LOCKER"; do
  name="${pair%%:*}"; id="${pair#*:}"
  if [[ ! -s "$CACHE/programs/$name.so" ]]; then
    echo "==> dumping $name ($id) from mainnet"
    solana program dump -u "$RPC_MAIN" "$id" "$CACHE/programs/$name.so" >/dev/null
  fi
done
for acct in "$NVDAX" "$DBC_BADGE" "$DAMM_BADGE" "$DAMM_CONFIG"; do
  if [[ ! -s "$CACHE/accounts/$acct.json" ]]; then
    echo "==> dumping account $acct from mainnet"
    solana account -u "$RPC_MAIN" "$acct" --output json --output-file "$CACHE/accounts/$acct.json" >/dev/null
  fi
done
for f in "$CACHE"/programs/*.so; do echo "    $(basename "$f") $(sha256sum "$f" | cut -c1-16) $(wc -c < "$f") bytes"; done

# The local authority for the re-homed NVDAx mint.
solana-keygen new --no-bip39-passphrase --silent -o "$WORK/nvdax-authority.json" >/dev/null
AUTH="$(solana-keygen pubkey "$WORK/nvdax-authority.json")"
node "$ROOT/scripts/dbc/rehome-stock-mint.mjs" "$CACHE/accounts/$NVDAX.json" "$WORK/$NVDAX.json" "$AUTH"

LEDGER="$WORK/ledger"
echo "==> starting solana-test-validator on :$PORT"
solana-test-validator --reset --quiet --ledger "$LEDGER" --rpc-port "$PORT" --faucet-port "$FAUCET_PORT" \
  --bpf-program "$T22" "$CACHE/programs/token2022.so" \
  --bpf-program "$DBC" "$CACHE/programs/dbc.so" \
  --bpf-program "$DAMM" "$CACHE/programs/damm.so" \
  --bpf-program "$MPL" "$CACHE/programs/metaplex.so" \
  --bpf-program "$LOCKER" "$CACHE/programs/locker.so" \
  --account "$NVDAX" "$WORK/$NVDAX.json" \
  --account "$DBC_BADGE" "$CACHE/accounts/$DBC_BADGE.json" \
  --account "$DAMM_BADGE" "$CACHE/accounts/$DAMM_BADGE.json" \
  --account "$DAMM_CONFIG" "$CACHE/accounts/$DAMM_CONFIG.json" \
  >"$WORK/validator.log" 2>&1 &
VALIDATOR_PID=$!
trap 'kill $VALIDATOR_PID 2>/dev/null || true; wait $VALIDATOR_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
  if solana -u "http://127.0.0.1:$PORT" cluster-version >/dev/null 2>&1; then break; fi
  sleep 1
done
solana -u "http://127.0.0.1:$PORT" cluster-version >/dev/null

# The loaded Token-2022 must be mainnet's, not the validator's bundled one.
solana program dump -u "http://127.0.0.1:$PORT" "$T22" "$WORK/token2022.local.so" >/dev/null
if ! cmp -s "$CACHE/programs/token2022.so" "$WORK/token2022.local.so"; then
  echo "the validator is running its own Token-2022, not mainnet's" >&2
  exit 1
fi
echo "==> Token-2022 on the validator == mainnet ($(sha256sum "$WORK/token2022.local.so" | cut -c1-16))"

DBC_LOCAL_RPC="http://127.0.0.1:$PORT" \
NVDAX_AUTHORITY_KEYPAIR="$WORK/nvdax-authority.json" \
MWZ_DBC_7B_WORK="$WORK" \
  "$ROOT/realtime-indexer/node_modules/.bin/tsx" "$ROOT/scripts/dbc/prove-stock-quote-local.mjs"
