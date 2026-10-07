#!/usr/bin/env bash
# DBC v2 economics (2026-10-08) on a local validator loaded with mainnet's DBC, DAMM v2, Token-2022,
# Metaplex and Meteora locker programs and the DAMM v2 config DBC migrates into. Reads mainnet only.
#
#   SOLANA_MAINNET_RPC_URL=<rpc> bash scripts/dbc/rehearse-v2-economics-local.sh
#   MWZ_DBC_V2_PROOF=prove-v2-flow-local.mjs ...   # through our create API, indexer and graduation keeper
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CACHE="${MWZ_DBC_V2_CACHE:-$HOME/.cache/mwz-dbc-v2}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mwz-dbc-v2-XXXXXX")"
PORT="${MWZ_DBC_V2_PORT:-18899}"
FAUCET_PORT=$((PORT + 2))
RPC_MAIN="${SOLANA_MAINNET_RPC_URL:-}"
[[ -n "$RPC_MAIN" ]] || { echo "SOLANA_MAINNET_RPC_URL is required for the mainnet dumps" >&2; exit 1; }

MAINNET_GENESIS="5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
GENESIS="$(curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash"}' "$RPC_MAIN" | sed -E 's/.*"result":"([^"]+)".*/\1/')"
[[ "$GENESIS" == "$MAINNET_GENESIS" ]] || { echo "dump RPC is not mainnet-beta ($GENESIS)" >&2; exit 1; }

DBC=dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN
DAMM=cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG
T22=TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
MPL=metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s
LOCKER=LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn
DAMM_CONFIG=A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck

mkdir -p "$CACHE/programs" "$CACHE/accounts"
for pair in "dbc:$DBC" "damm:$DAMM" "token2022:$T22" "metaplex:$MPL" "locker:$LOCKER"; do
  name="${pair%%:*}"; id="${pair#*:}"
  if [[ ! -s "$CACHE/programs/$name.so" ]]; then
    echo "==> dumping $name ($id) from mainnet"
    solana program dump -u "$RPC_MAIN" "$id" "$CACHE/programs/$name.so" >/dev/null
  fi
done
if [[ ! -s "$CACHE/accounts/$DAMM_CONFIG.json" ]]; then
  solana account -u "$RPC_MAIN" "$DAMM_CONFIG" --output json --output-file "$CACHE/accounts/$DAMM_CONFIG.json" >/dev/null
fi
for f in "$CACHE"/programs/*.so; do echo "    $(basename "$f") $(sha256sum "$f" | cut -c1-16) $(wc -c < "$f") bytes"; done

LEDGER="$WORK/ledger"
echo "==> starting solana-test-validator on :$PORT"
solana-test-validator --reset --quiet --ledger "$LEDGER" --rpc-port "$PORT" --faucet-port "$FAUCET_PORT" \
  --bpf-program "$T22" "$CACHE/programs/token2022.so" \
  --bpf-program "$DBC" "$CACHE/programs/dbc.so" \
  --bpf-program "$DAMM" "$CACHE/programs/damm.so" \
  --bpf-program "$MPL" "$CACHE/programs/metaplex.so" \
  --bpf-program "$LOCKER" "$CACHE/programs/locker.so" \
  --account "$DAMM_CONFIG" "$CACHE/accounts/$DAMM_CONFIG.json" \
  >"$WORK/validator.log" 2>&1 &
VALIDATOR_PID=$!
trap 'kill $VALIDATOR_PID 2>/dev/null || true; wait $VALIDATOR_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
  if solana -u "http://127.0.0.1:$PORT" cluster-version >/dev/null 2>&1; then break; fi
  sleep 1
done
solana -u "http://127.0.0.1:$PORT" cluster-version >/dev/null

DBC_LOCAL_RPC="http://127.0.0.1:$PORT" \
  "$ROOT/realtime-indexer/node_modules/.bin/tsx" "$ROOT/scripts/dbc/${MWZ_DBC_V2_PROOF:-prove-v2-economics-local.mjs}"
