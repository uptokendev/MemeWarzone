#!/usr/bin/env bash
# Read-only comparison of the built launchpad candidate against Solana devnet.
#
# This wrapper exists so the dry-run can be granted as a standing permission
# without also granting the upgrade. It takes no arguments and never passes
# --execute, so it cannot send a transaction however it is invoked. Sending the
# upgrade stays a deliberate, separately-typed command.
#
#   bash scripts/solana/dryrun-devnet-launchpad-upgrade.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SO="$ROOT/target/deploy/memewarzone_solana.so"

if [[ $# -gt 0 ]]; then
  echo "This wrapper takes no arguments; it only ever dry-runs." >&2
  echo "To send the upgrade, run upgrade-devnet-launchpad.cjs --execute directly." >&2
  exit 2
fi

if [[ ! -s "$SO" ]]; then
  echo "missing $SO -- build the certified candidate first:" >&2
  echo "  bash scripts/solana/run-local-sbf-gate.sh" >&2
  exit 1
fi

# The candidate hash is read from the artifact rather than pinned here, so this
# always compares devnet against the binary actually on disk.
CANDIDATE_SHA="$(sha256sum "$SO" | cut -d' ' -f1)"
echo "[dry-run] candidate $SO"
echo "[dry-run] sha256 $CANDIDATE_SHA"

SOLANA_RPC_URL="${SOLANA_RPC_URL:-https://api.devnet.solana.com}" \
SOLANA_OPERATOR_KEYPAIR="${SOLANA_OPERATOR_KEYPAIR:-$HOME/.config/memewarzone/solana-devnet/deployer.json}" \
SOLANA_DEVNET_CANDIDATE_SHA256="$CANDIDATE_SHA" \
  node "$ROOT/scripts/solana/upgrade-devnet-launchpad.cjs"
