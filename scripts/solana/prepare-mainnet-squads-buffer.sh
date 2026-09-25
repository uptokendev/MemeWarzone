#!/usr/bin/env bash
# Stage a mainnet program upgrade for the Squads multisig to execute.
#
# Everything here is permissionless and paid by the deployer: uploading the
# binary into a buffer account, then handing that buffer's authority to the
# multisig. The upgrade itself is a Squads proposal -- this script never sends
# one, and the deployer cannot.
#
# The upload is the dangerous part. A 1.2MB binary is several hundred write
# transactions, and when enough of them are dropped the deploy aborts with the
# rent already spent. On devnet that stranded 6.49 SOL in a buffer whose only
# handle was a seed phrase printed once. So: a named keypair, generated ahead of
# time, which makes the buffer addressable, resumable and closable; a priority
# fee; and a high sign-attempt count.
#
#   bash scripts/solana/prepare-mainnet-squads-buffer.sh launchpad                    # dry run
#   MWZ_STAGE_SEND=1 bash scripts/solana/prepare-mainnet-squads-buffer.sh launchpad   # sends
#
# It reads and verifies without MWZ_STAGE_SEND=1, because every other check here
# is free and the upload is not: once buffer authority moves to the multisig the
# rent is recoverable only by the multisig, so an accidental run costs a Squads
# transaction to undo. Re-running after a failed upload resumes into the same
# buffer rather than funding a second one.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

SQUADS="fk5YYWb4ppwbFqME8YRugirMSaNfhGgPP3GjfMbbfGv"
DEPLOYER="${SOLANA_MAINNET_DEPLOYER_KEYPAIR:-$HOME/.config/memewarzone/solana-mainnet-deployer.json}"

TARGET="${1:-}"
case "$TARGET" in
  launchpad)
    PROGRAM_ID="3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt"
    CANDIDATE="$ROOT/target/deploy/memewarzone_solana.so"
    EXPECT_SHA="e6ed7df37dfe3bf8ec7914f7bcae9ebd50b21b0844cff80c2a851c64bfafdcb2"
    BUFFER_KEYPAIR="${MWZ_BUFFER_KEYPAIR:-$HOME/.config/memewarzone/mwz-launchpad-mainnet-buffer-e6ed7df3.json}"
    ;;
  treasury)
    # The reward-poster candidate (2026-09-25) is 1360568 bytes; mainnet's
    # allocation is 1306640 (the 1028f6f8 upgrade left no padding), so it
    # needs `solana program extend 2NzthKEZ... 53928` first -- permanent rent the
    # upgrade never refunds. The allocation check below enforces it.
    PROGRAM_ID="2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX"
    CANDIDATE="$ROOT/target/deploy/mwz_rewards_treasury.so"
    EXPECT_SHA="cb2e4546e4aa26ffcdce667216a479e0c58644eb0788af42bf32dec083303b21"
    BUFFER_KEYPAIR="${MWZ_BUFFER_KEYPAIR:-$HOME/.config/memewarzone/mwz-treasury-mainnet-buffer-cb2e4546.json}"
    if [[ "${MWZ_TREASURY_RELEASE:-}" != "1" ]]; then
      echo "The treasury upgrade is held: \"No go, we need to fix everything first.\"" >&2
      echo "Release it with MWZ_TREASURY_RELEASE=1 once that is no longer true." >&2
      exit 1
    fi
    ;;
  *)
    echo "usage: $0 launchpad|treasury" >&2
    exit 2
    ;;
esac

# The build already carries a paid mainnet endpoint. Prefer an explicit
# SOLANA_MAINNET_RPC_URL, otherwise read SOLANA_RPC_URL out of
# frontend/.env.local rather than making the operator paste a keyed URL.
RPC="${SOLANA_MAINNET_RPC_URL:-}"
RPC_SOURCE="SOLANA_MAINNET_RPC_URL"
if [[ -z "$RPC" && -f "$ROOT/frontend/.env.local" ]]; then
  RPC="$(node -e '
    const fs = require("fs");
    const line = fs.readFileSync(process.argv[1], "utf8").split("\n")
      .find((l) => /^\s*(export\s+)?SOLANA_RPC_URL\s*=/.test(l));
    if (!line) process.exit(0);
    process.stdout.write(line.slice(line.indexOf("=") + 1).trim().replace(/^["\x27]|["\x27]$/g, ""));
  ' "$ROOT/frontend/.env.local")"
  RPC_SOURCE="frontend/.env.local SOLANA_RPC_URL"
fi
[[ -n "$RPC" ]] || { echo "no mainnet RPC: set SOLANA_MAINNET_RPC_URL, or put SOLANA_RPC_URL in frontend/.env.local" >&2; exit 1; }

if [[ "$RPC" == *"api.mainnet-beta.solana.com"* && "${MWZ_ALLOW_PUBLIC_RPC:-}" != "1" ]]; then
  echo "Refusing to upload $(wc -c < "$CANDIDATE") bytes over the public RPC; it rate-limits and the abort costs rent." >&2
  echo "Set MWZ_ALLOW_PUBLIC_RPC=1 to override." >&2
  exit 1
fi

# Ask the chain which cluster this is. A URL cannot be trusted to say -- the
# endpoint above is read from the staging env file, and pointing 6 SOL of buffer
# at devnet because someone flipped one line is not a failure worth having.
MAINNET_GENESIS="5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
ACTUAL_GENESIS="$(solana genesis-hash --url "$RPC" 2>/dev/null || true)"
if [[ "$ACTUAL_GENESIS" != "$MAINNET_GENESIS" ]]; then
  echo "refusing: $RPC_SOURCE reports genesis ${ACTUAL_GENESIS:-<unreachable>}, not mainnet-beta $MAINNET_GENESIS" >&2
  exit 1
fi
echo "==> RPC from $RPC_SOURCE, verified mainnet-beta by genesis"

[[ -s "$CANDIDATE" ]] || { echo "missing $CANDIDATE -- run the gate first" >&2; exit 1; }
[[ -f "$DEPLOYER" ]] || { echo "deployer keypair not found: $DEPLOYER" >&2; exit 1; }
if [[ ! -f "$BUFFER_KEYPAIR" ]]; then
  echo "buffer keypair not found: $BUFFER_KEYPAIR" >&2
  echo "generate it first, so the address is known before a lamport is spent:" >&2
  echo "  solana-keygen new --no-bip39-passphrase -o $BUFFER_KEYPAIR" >&2
  exit 1
fi

ACTUAL_SHA="$(sha256sum "$CANDIDATE" | cut -d' ' -f1)"
if [[ "$ACTUAL_SHA" != "$EXPECT_SHA" ]]; then
  echo "candidate sha256 $ACTUAL_SHA does not match the certified $EXPECT_SHA" >&2
  echo "the tree is not what the gate certified; stop here" >&2
  exit 1
fi

BUFFER="$(solana-keygen pubkey "$BUFFER_KEYPAIR")"
PAYER="$(solana-keygen pubkey "$DEPLOYER")"
BYTES="$(wc -c < "$CANDIDATE")"

echo "==> staging $TARGET for Squads"
echo "    program   $PROGRAM_ID"
echo "    candidate $ACTUAL_SHA ($BYTES bytes)"
echo "    buffer    $BUFFER"
echo "    deployer  $PAYER $(solana balance "$PAYER" --url "$RPC")"

# An allocation smaller than the binary makes the Squads upgrade fail on
# execution, which is the worst possible place to discover it.
ALLOCATED="$(solana program show "$PROGRAM_ID" --url "$RPC" | awk '/Data Length:/ {print $3}')"
echo "    allocated $ALLOCATED bytes"
if (( ALLOCATED < BYTES )); then
  echo "allocation $ALLOCATED is smaller than the binary $BYTES -- run 'solana program extend' first" >&2
  exit 1
fi

if [[ "${MWZ_STAGE_SEND:-}" != "1" ]]; then
  cat <<PLAN

==> DRY RUN. Nothing has been sent.

Everything above was read from the chain. Sending would:
  - upload $BYTES bytes into $BUFFER
  - spend $(solana rent $((BYTES + 37)) --url "$RPC" | awk '{print $3}') SOL of rent, recoverable only by
    the multisig once buffer authority is transferred to it
  - hand that buffer to $SQUADS

Re-run with MWZ_STAGE_SEND=1 to do it.
PLAN
  exit 0
fi

echo "==> writing the buffer (resumes into $BUFFER if a previous run aborted)"
solana program write-buffer "$CANDIDATE" \
  --url "$RPC" --keypair "$DEPLOYER" \
  --buffer "$BUFFER_KEYPAIR" \
  --with-compute-unit-price 10000 \
  --max-sign-attempts 60

echo "==> verifying the uploaded bytes before handing over authority"
DUMP="$(mktemp -t mwz-buffer-XXXXXX.so)"
trap 'rm -f "$DUMP"' EXIT
solana program dump "$BUFFER" "$DUMP" --url "$RPC" >/dev/null
node -e '
const fs = require("fs");
const { deployedMatchesCandidate } = require("./scripts/solana/program-upgrade-verify.cjs");
const result = deployedMatchesCandidate(fs.readFileSync(process.argv[1]), fs.readFileSync(process.argv[2]));
console.log(`    ${result.ok ? "buffer matches the candidate" : "BUFFER MISMATCH"}: ${result.reason}`);
process.exit(result.ok ? 0 : 1);
' "$DUMP" "$CANDIDATE"

echo "==> handing the buffer to the multisig"
solana program set-buffer-authority "$BUFFER" \
  --new-buffer-authority "$SQUADS" \
  --url "$RPC" --keypair "$DEPLOYER"

solana program show --buffers --buffer-authority "$SQUADS" --url "$RPC" || true

cat <<REPORT

==> READY FOR SQUADS

Propose a BPFLoaderUpgradeable::Upgrade with exactly these values:

  Program            $PROGRAM_ID
  Buffer             $BUFFER
  Spill (refund to)  $PAYER
  Upgrade authority  $SQUADS

The buffer is the whole payload -- everything else in the proposal is fixed.
Its bytes were verified above against $ACTUAL_SHA.

BEFORE ANYONE SIGNS, decode the pending proposal back from chain and check
every field (on 2026-09-24 a proposal with the previous Program still in it
deployed this buffer over the wrong program; the Squads UI did not catch it):

  SOLANA_RPC_URL=<rpc> node scripts/solana/decode-squads-proposal.mjs \
    --latest <multisigPda> --program $PROGRAM_ID --buffer $BUFFER \
    --spill $PAYER --authority $SQUADS
  (run from tests/solana, where @solana/web3.js is installed)
  Sign only on "PROPOSAL MATCHES -- safe to sign".

REPORT

# The two programs have different consumers: the API pins the launchpad's
# hash as deployment evidence and reads no treasury hash at all. This block
# once printed the launchpad variable names for both targets, and a treasury
# ceremony was one paste away from overwriting the launchpad's pin.
if [[ "$TARGET" == "launchpad" ]]; then
  cat <<AFTER
After execution, verify and move the API env in the same change:
  solana program show $PROGRAM_ID --url <rpc>
  SOLANA_LAUNCHPAD_PROGRAM_SHA256=$ACTUAL_SHA
  SOLANA_LAUNCHPAD_PROGRAM_BYTES=$BYTES   (canary only; the API does not read it)
AFTER
else
  cat <<AFTER
After execution, verify:
  solana program show $PROGRAM_ID --url <rpc>
No env moves for the treasury: the API and indexer read no treasury program hash.
Do NOT put $ACTUAL_SHA into SOLANA_LAUNCHPAD_PROGRAM_SHA256 -- that is the launchpad's pin.
Next: init-arena-mainnet.mjs --status, then a dry run, then --execute (both arena configs land CLOSED).
AFTER
fi

cat <<REPORT

If the upload aborted instead, the buffer is still yours and still funded:
  solana program close $BUFFER --recipient $PAYER --url <rpc> --keypair $DEPLOYER
REPORT
