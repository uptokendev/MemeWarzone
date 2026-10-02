#!/usr/bin/env bash
set -euo pipefail

PROGRAM_ID="${SOLANA_REWARDS_TREASURY_PROGRAM_ID:-2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX}"
RPC_URL="${SOLANA_RPC_URL:-${SOLANA_RPC:-}}"
EXPECTED_AUTHORITY="${SOLANA_REWARDS_UPGRADE_AUTHORITY:-}"
CANDIDATE_SO="${1:-target/deploy/mwz_rewards_treasury.so}"
CANDIDATE_IDL="${2:-target/idl/mwz_rewards_treasury.json}"
HASH_MANIFEST="${3:-rewards-treasury-sha256.txt}"

fail() {
  echo "[FAIL] $*" >&2
  exit 1
}

note() {
  echo "[preflight] $*"
}

command -v solana >/dev/null 2>&1 || fail "solana CLI is required"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required"
command -v node >/dev/null 2>&1 || fail "node is required"

[[ -n "$RPC_URL" ]] || fail "set SOLANA_RPC_URL (or SOLANA_RPC) to the target cluster RPC"
[[ -f "$CANDIDATE_SO" ]] || fail "candidate program not found: $CANDIDATE_SO"
[[ -f "$CANDIDATE_IDL" ]] || fail "candidate IDL not found: $CANDIDATE_IDL"
[[ -f "$HASH_MANIFEST" ]] || fail "candidate hash manifest not found: $HASH_MANIFEST"

note "program=$PROGRAM_ID"
note "rpc=$RPC_URL"
note "candidate=$CANDIDATE_SO"

# Require the artifact we are about to test/upgrade to match the certified manifest.
(
  cd "$(dirname "$HASH_MANIFEST")"
  sha256sum --check "$(basename "$HASH_MANIFEST")"
) || fail "candidate files do not match certified SHA256 manifest"

# Require the generated IDL to contain the exact same program ID (when emitted)
# and all recruiter/squad publication + claim instructions.
PROGRAM_ID="$PROGRAM_ID" CANDIDATE_IDL="$CANDIDATE_IDL" node --input-type=module <<'NODE'
import fs from 'node:fs';
const idl = JSON.parse(fs.readFileSync(process.env.CANDIDATE_IDL, 'utf8'));
const address = String(idl.address || idl.metadata?.address || '');
if (address && address !== process.env.PROGRAM_ID) {
  throw new Error(`IDL program ID mismatch: ${address} != ${process.env.PROGRAM_ID}`);
}
const names = new Set((idl.instructions || []).map((ix) => String(ix.name)));
const aliases = [
  ['set_recruiter_batch_root', 'setRecruiterBatchRoot'],
  ['claim_recruiter', 'claimRecruiter'],
  ['set_squad_batch_root', 'setSquadBatchRoot'],
  ['claim_squad', 'claimSquad'],
];
for (const choices of aliases) {
  if (!choices.some((name) => names.has(name))) {
    throw new Error(`IDL missing ${choices[0]}`);
  }
}
console.log('[preflight] IDL program/instruction boundary: ok');
NODE

PROGRAM_SHOW="$(solana program show "$PROGRAM_ID" --url "$RPC_URL")" || fail "unable to read deployed program"
printf '%s\n' "$PROGRAM_SHOW"

ACTUAL_PROGRAM_ID="$(printf '%s\n' "$PROGRAM_SHOW" | awk -F': ' '/^Program Id:/ {print $2; exit}')"
ACTUAL_AUTHORITY="$(printf '%s\n' "$PROGRAM_SHOW" | awk -F': ' '/^Authority:/ {print $2; exit}')"
PROGRAMDATA="$(printf '%s\n' "$PROGRAM_SHOW" | awk -F': ' '/^ProgramData Address:/ {print $2; exit}')"

[[ "$ACTUAL_PROGRAM_ID" == "$PROGRAM_ID" ]] || fail "deployed program ID mismatch: $ACTUAL_PROGRAM_ID"
[[ -n "$PROGRAMDATA" ]] || fail "deployed program is not upgradeable or ProgramData address could not be read"
[[ -n "$ACTUAL_AUTHORITY" ]] || fail "upgrade authority could not be read"

if [[ -n "$EXPECTED_AUTHORITY" && "$ACTUAL_AUTHORITY" != "$EXPECTED_AUTHORITY" ]]; then
  fail "upgrade authority mismatch: live=$ACTUAL_AUTHORITY expected=$EXPECTED_AUTHORITY"
fi

LIVE_SO="$(mktemp -t mwz-rewards-live.XXXXXX.so)"
trap 'rm -f "$LIVE_SO"' EXIT
solana program dump "$PROGRAM_ID" "$LIVE_SO" --url "$RPC_URL" >/dev/null || fail "unable to dump deployed program"

CANDIDATE_SHA="$(sha256sum "$CANDIDATE_SO" | awk '{print $1}')"
LIVE_SHA="$(sha256sum "$LIVE_SO" | awk '{print $1}')"

note "upgrade_authority=$ACTUAL_AUTHORITY"
note "programdata=$PROGRAMDATA"
note "candidate_sha256=$CANDIDATE_SHA"
note "deployed_sha256=$LIVE_SHA"

if [[ "$CANDIDATE_SHA" == "$LIVE_SHA" ]]; then
  note "candidate is already deployed; no program upgrade is required"
else
  note "candidate differs from deployed binary; same-ID upgrade is required after test acceptance"
fi

cat <<EOF

PRE-FLIGHT PASS
- Program ID is exact: $PROGRAM_ID
- Program is upgradeable
- Upgrade authority is readable${EXPECTED_AUTHORITY:+ and matches SOLANA_REWARDS_UPGRADE_AUTHORITY}
- Candidate matches certified hash manifest
- Candidate IDL contains recruiter/squad root publication + claims
- Live and candidate binary hashes were captured

Do not upgrade yet unless the complete test matrix is green.
EOF
