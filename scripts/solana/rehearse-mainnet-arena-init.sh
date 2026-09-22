#!/usr/bin/env bash
# Rehearse the mainnet arena initializer, on a cluster that is not mainnet.
#
# init-arena-mainnet.mjs is the one script that runs against mainnet with the
# deployer key and creates the accounts the whole arena hangs off. The standing
# rule is that every Solana transaction is proven on a local validator first,
# and this is how that rule reaches an initializer whose own guard refuses to
# run anywhere but mainnet: a throwaway validator has a genesis that is neither
# real cluster, so MWZ_LOCAL_CLUSTER_REHEARSAL=1 can only ever unlock this.
#
# It stands up the accounts mainnet already has -- rewards_config, route_state,
# the lane vaults -- so the initializer meets the same shape of cluster, then
# drives the full sequence: dry run, execute, open, and a re-run that must
# change nothing.
#
# Two bugs this caught the first time it ran:
#   - a re-run silently re-paused an arena that had been opened
#   - the marketing receiver defaulted to whatever route.overflowTreasury held,
#     which this script then replaces, so it was right only on the first run
#
#   bash scripts/solana/rehearse-mainnet-arena-init.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
SO="$ROOT/target/deploy/mwz_rewards_treasury.so"
[[ -s "$SO" ]] || { echo "missing $SO -- run the treasury gate first" >&2; exit 1; }
LEDGER=/tmp/mwz-rehearse-ledger
RPC=http://127.0.0.1:8899
KEY="$HOME/.config/memewarzone/solana-devnet/deployer.json"
[[ -f "$KEY" ]] || KEY="$HOME/.config/solana/id.json"

cleanup() { [[ -n "${VPID:-}" ]] && kill "$VPID" >/dev/null 2>&1 || true; }
trap cleanup EXIT

rm -rf "$LEDGER"
solana-test-validator --reset --quiet --ledger "$LEDGER" --limit-ledger-size 50000000 \
  --bind-address 127.0.0.1 --rpc-port 8899 \
  --bpf-program 2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX "$SO" \
  > /tmp/mwz-rehearse-validator.log 2>&1 &
VPID=$!
for _ in $(seq 1 90); do solana cluster-version --url "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done
solana cluster-version --url "$RPC" >/dev/null 2>&1 || { echo "validator did not start"; exit 1; }

PAYER="$(solana-keygen pubkey "$KEY")"
solana airdrop 100 "$PAYER" --url "$RPC" >/dev/null

echo "== the treasury's own initialize must run first =="
MWZ_ROOT="$ROOT" ANCHOR_PROVIDER_URL="$RPC" ANCHOR_WALLET="$KEY" node -e '
const anchor=require(process.env.MWZ_ROOT+"/tests/solana/node_modules/@coral-xyz/anchor");
const fs=require("fs");
(async()=>{
  const provider=anchor.AnchorProvider.env(); anchor.setProvider(provider);
  const idl=JSON.parse(fs.readFileSync(process.env.MWZ_ROOT+"/target/idl/mwz_rewards_treasury.json","utf8"));
  const program=new anchor.Program(idl,provider);
  await program.methods.initialize().accounts({}).rpc({commitment:"confirmed"});
  console.log("   rewards_config created");
  // route_state and the lane vaults exist on mainnet already; the rehearsal has
  // to stand them up so the initializer meets the same shape of cluster.
  await program.methods.initializeLanesV2Primary(provider.wallet.publicKey, new anchor.BN(200_000_000)).accounts({}).rpc({commitment:"confirmed"});
  await program.methods.initializeLanesV2Secondary().accounts({}).rpc({commitment:"confirmed"});
  console.log("   route_state + lane vaults created");
})().catch(e=>{console.error(e.message);process.exit(1);});'

echo "== dry run =="
MWZ_LOCAL_CLUSTER_REHEARSAL=1 SOLANA_RPC_URL="$RPC" SOLANA_TREASURY_AUTHORITY_KEYPAIR="$KEY" \
  node scripts/solana/init-arena-mainnet.mjs 2>&1 | grep -v "^bigint"

echo "== execute =="
MWZ_LOCAL_CLUSTER_REHEARSAL=1 SOLANA_RPC_URL="$RPC" SOLANA_TREASURY_AUTHORITY_KEYPAIR="$KEY" \
  node scripts/solana/init-arena-mainnet.mjs --execute 2>&1 | grep -v "^bigint"

echo "== open =="
MWZ_LOCAL_CLUSTER_REHEARSAL=1 SOLANA_RPC_URL="$RPC" SOLANA_TREASURY_AUTHORITY_KEYPAIR="$KEY" \
  node scripts/solana/init-arena-mainnet.mjs --open --execute 2>&1 | grep -v "^bigint"

echo "== re-run must be idempotent: an OPEN arena must stay open =="
MWZ_LOCAL_CLUSTER_REHEARSAL=1 SOLANA_RPC_URL="$RPC" SOLANA_TREASURY_AUTHORITY_KEYPAIR="$KEY" \
  node scripts/solana/init-arena-mainnet.mjs --execute 2>&1 | grep -v "^bigint" | grep -E "skip|OPEN|closed"

echo
echo "==> REHEARSAL PASS: init, open and a no-op re-run all behaved on an ephemeral cluster"
