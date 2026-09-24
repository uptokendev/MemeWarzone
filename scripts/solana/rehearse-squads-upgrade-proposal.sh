#!/usr/bin/env bash
# Prove propose-squads-upgrade.mjs end to end on a local validator before it is
# used on mainnet: the real Squads v4 program (cloned from mainnet), a fresh
# 2-of-3 multisig, the launchpad's REAL program and ProgramData accounts dumped
# from mainnet (holding whatever mainnet holds -- on 2026-09-24 the treasury
# binary, the incident state) with only the upgrade authority rewritten to the
# multisig's vault and the slot zeroed, the candidate written to a buffer owned
# by the vault. Not --upgradeable-program: that genesis path flags ProgramData
# executable, which mainnet does not, and the loader's CPI upgrade then fails
# with ExecutableDataModified. Then:
# propose from the terminal, decode, approve twice, execute, and byte-verify
# that the program now holds the candidate followed by zeros.
#
#   bash scripts/solana/rehearse-squads-upgrade-proposal.sh
#
# Needs a mainnet RPC to clone from (SOLANA_MAINNET_RPC_URL, else SOLANA_RPC_URL
# in frontend/.env.local). Nothing is sent to mainnet: cloning is a read.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

SQUADS="SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf"
SQUADS_CONFIG="BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr"
PROGRAM_ID="3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt"
WRONG_SO="$ROOT/target/deploy/mwz_rewards_treasury.so"      # the incident's bytes, for the refusal test
PROGRAMDATA="9y6db1TSRHuMk1FK2GdLDYG4frdFH1z1wWtu2d1v5qM6"   # PDA of [PROGRAM_ID] under the loader, same on every cluster
CANDIDATE="$ROOT/target/deploy/memewarzone_solana.so"
LOCAL="http://127.0.0.1:8899"

MAINNET_RPC="${SOLANA_MAINNET_RPC_URL:-}"
if [[ -z "$MAINNET_RPC" && -f "$ROOT/frontend/.env.local" ]]; then
  MAINNET_RPC="$(grep -E '^\s*(export\s+)?SOLANA_RPC_URL\s*=' "$ROOT/frontend/.env.local" | head -1 | cut -d= -f2- | tr -d '"'"'"'' | tr -d '[:space:]')"
fi
[[ -n "$MAINNET_RPC" ]] || { echo "no mainnet RPC to clone the Squads program from" >&2; exit 1; }
[[ -s "$WRONG_SO" && -s "$CANDIDATE" ]] || { echo "missing .so under target/deploy" >&2; exit 1; }
if solana cluster-version --url "$LOCAL" >/dev/null 2>&1; then
  echo "something already answers on $LOCAL -- stop it first (this script starts its own validator)" >&2; exit 1
fi

WORK="$(mktemp -d -t mwz-squads-rehearsal-XXXXXX)"
VALIDATOR_PID=""
cleanup() { if [[ -n "$VALIDATOR_PID" ]]; then kill "$VALIDATOR_PID" 2>/dev/null || true; wait "$VALIDATOR_PID" 2>/dev/null || true; fi; rm -rf "$WORK"; }
trap cleanup EXIT

for k in creator m2 m3 createKey buffer wrongbuf; do solana-keygen new --no-bip39-passphrase --silent -o "$WORK/$k.json"; done
CREATOR="$(solana-keygen pubkey "$WORK/creator.json")"
BUFFER="$(solana-keygen pubkey "$WORK/buffer.json")"
WRONGBUF="$(solana-keygen pubkey "$WORK/wrongbuf.json")"
read -r MS VAULT < <(node scripts/solana/rehearse-squads-upgrade-proposal.mjs derive --create-key "$WORK/createKey.json")
echo "==> multisig $MS  vault $VAULT  creator $CREATOR"

echo "==> dumping the launchpad's program + ProgramData from mainnet (read-only) and re-homing the authority to the vault"
solana account "$PROGRAM_ID" --url "$MAINNET_RPC" --output json --output-file "$WORK/program.json" >/dev/null
solana account "$PROGRAMDATA" --url "$MAINNET_RPC" --output json --output-file "$WORK/programdata.json" >/dev/null
node -e '
const fs = require("fs");
// Splice into the raw text: JSON.parse would turn rentEpoch (u64::MAX) into a float.
const text = fs.readFileSync(process.argv[1], "utf8");
const m = text.match(/"data":\s*\[\s*"([A-Za-z0-9+\/=]+)"/);
if (!m) throw new Error("no base64 data field");
const d = Buffer.from(m[1], "base64");
if (d.readUInt32LE(0) !== 3 || d[12] !== 1) throw new Error("not a ProgramData account with an authority");
if (/"executable":\s*true/.test(text)) throw new Error("mainnet ProgramData is executable?!");
d.writeBigUInt64LE(0n, 4);                                              // slot: local validator starts at 0
Buffer.from(require("bs58").decode(process.argv[2])).copy(d, 13);       // upgrade authority -> local vault
fs.writeFileSync(process.argv[1], text.replace(m[1], d.toString("base64")));
console.log(`    ProgramData ${d.length} bytes, executable false, authority now ${process.argv[2]}`);
' "$WORK/programdata.json" "$VAULT"
echo "==> starting validator: Squads cloned from mainnet, the launchpad exactly as on mainnet, authority = vault"
solana-test-validator --reset --quiet --ledger "$WORK/ledger" --url "$MAINNET_RPC" \
  --clone-upgradeable-program "$SQUADS" --clone "$SQUADS_CONFIG" \
  --account "$PROGRAM_ID" "$WORK/program.json" --account "$PROGRAMDATA" "$WORK/programdata.json" \
  >"$WORK/validator.log" 2>&1 &
VALIDATOR_PID=$!
for i in $(seq 1 90); do solana cluster-version --url "$LOCAL" >/dev/null 2>&1 && break; sleep 2; done
solana cluster-version --url "$LOCAL" >/dev/null 2>&1 || { echo "validator did not come up"; tail -20 "$WORK/validator.log"; exit 1; }

for k in creator m2 m3; do solana airdrop 50 "$(solana-keygen pubkey "$WORK/$k.json")" --url "$LOCAL" >/dev/null; done
echo "==> creating the 2-of-3 multisig"
SOLANA_RPC_URL="$LOCAL" node scripts/solana/rehearse-squads-upgrade-proposal.mjs create-multisig \
  --create-key "$WORK/createKey.json" --creator "$WORK/creator.json" --members "$WORK/m2.json,$WORK/m3.json" --threshold 2

echo "==> staging the candidate into a buffer owned by the vault, and the WRONG binary into another (the incident's buffer)"
solana program write-buffer "$CANDIDATE" --buffer "$WORK/buffer.json" --keypair "$WORK/creator.json" --url "$LOCAL" >/dev/null
solana program set-buffer-authority "$BUFFER" --new-buffer-authority "$VAULT" --keypair "$WORK/creator.json" --url "$LOCAL" >/dev/null
solana program write-buffer "$WRONG_SO" --buffer "$WORK/wrongbuf.json" --keypair "$WORK/creator.json" --url "$LOCAL" >/dev/null
solana program set-buffer-authority "$WRONGBUF" --new-buffer-authority "$VAULT" --keypair "$WORK/creator.json" --url "$LOCAL" >/dev/null
# propose-squads-upgrade.mjs reads at finalized, as it must on mainnet; on a local
# validator that is ~13s behind confirmed, so wait for the authorities to finalize.
for i in $(seq 1 30); do
  solana program show "$WRONGBUF" --url "$LOCAL" --commitment finalized 2>/dev/null | grep -q "Authority: $VAULT" && break; sleep 2
done
BEFORE_SLOT="$(solana program show "$PROGRAM_ID" --url "$LOCAL" | awk '/Last Deployed In Slot/ {print $5}')"
SPILL_BEFORE="$(solana balance "$CREATOR" --url "$LOCAL" | awk '{print $1}')"

PROPOSE=(node scripts/solana/propose-squads-upgrade.mjs --local --multisig "$MS" --program "$PROGRAM_ID" --buffer "$BUFFER" \
  --spill "$CREATOR" --authority "$VAULT" --candidate "$CANDIDATE" --creator-keypair "$WORK/creator.json")
echo "==> propose: dry run"
SOLANA_RPC_URL="$LOCAL" "${PROPOSE[@]}"
echo "==> propose: --send (must end with the decoder's PROPOSAL MATCHES)"
SOLANA_RPC_URL="$LOCAL" "${PROPOSE[@]}" --send

echo "==> the refusals must fire"
refuse() { # <label> <expected message fragment> <args...>
  local label="$1" expect="$2"; shift 2
  if SOLANA_RPC_URL="$LOCAL" node scripts/solana/propose-squads-upgrade.mjs --local --multisig "$MS" --authority "$VAULT" --creator-keypair "$WORK/creator.json" "$@" >/dev/null 2>"$WORK/refuse.err"; then
    echo "FAIL: $label was accepted"; exit 1; fi
  if ! grep -q "$expect" "$WORK/refuse.err"; then echo "FAIL: $label refused for the wrong reason:"; grep refusing "$WORK/refuse.err"; exit 1; fi
  echo "    ok: $label -> $(grep -o 'refusing: .*' "$WORK/refuse.err" | head -c 140)"
}
refuse "candidate file that is not the buffer" "buffer holds\|buffer bytes differ" \
  --program "$PROGRAM_ID" --buffer "$BUFFER" --spill "$CREATOR" --candidate "$WRONG_SO"
refuse "program with no certification" "no certification file" \
  --program "$SQUADS" --buffer "$BUFFER" --spill "$CREATOR" --candidate "$CANDIDATE"
refuse "THE INCIDENT: launchpad program, treasury bytes, operator's candidate agrees with the buffer" "NOT the certified MemeWarzone launchpad binary" \
  --program "$PROGRAM_ID" --buffer "$WRONGBUF" --spill "$CREATOR" --candidate "$WRONG_SO"

INDEX=1
echo "==> approve (creator, m2) and execute (m2)"
for m in creator m2; do SOLANA_RPC_URL="$LOCAL" node scripts/solana/rehearse-squads-upgrade-proposal.mjs approve --multisig "$MS" --index "$INDEX" --member "$WORK/$m.json"; done
SOLANA_RPC_URL="$LOCAL" node scripts/solana/rehearse-squads-upgrade-proposal.mjs status --multisig "$MS" --index "$INDEX"
SOLANA_RPC_URL="$LOCAL" node scripts/solana/rehearse-squads-upgrade-proposal.mjs execute --multisig "$MS" --index "$INDEX" --member "$WORK/m2.json"
SOLANA_RPC_URL="$LOCAL" node scripts/solana/rehearse-squads-upgrade-proposal.mjs status --multisig "$MS" --index "$INDEX"

echo "==> verifying the program now holds the candidate"
AFTER_SLOT="$(solana program show "$PROGRAM_ID" --url "$LOCAL" | awk '/Last Deployed In Slot/ {print $5}')"
AUTH_AFTER="$(solana program show "$PROGRAM_ID" --url "$LOCAL" | awk '/^Authority/ {print $2}')"
solana program dump "$PROGRAM_ID" "$WORK/deployed.so" --url "$LOCAL" >/dev/null
node -e '
const fs = require("fs");
const { deployedMatchesCandidate } = require("./scripts/solana/program-upgrade-verify.cjs");
const r = deployedMatchesCandidate(fs.readFileSync(process.argv[1]), fs.readFileSync(process.argv[2]));
console.log(`    ${r.ok ? "deployed == candidate" : "DEPLOYED MISMATCH"}: ${r.reason}`);
process.exit(r.ok ? 0 : 1);
' "$WORK/deployed.so" "$CANDIDATE"
echo "    slot $BEFORE_SLOT -> $AFTER_SLOT, authority $AUTH_AFTER"
[[ "$AFTER_SLOT" != "$BEFORE_SLOT" ]] || { echo "FAIL: deployed slot did not advance"; exit 1; }
[[ "$AUTH_AFTER" == "$VAULT" ]] || { echo "FAIL: authority changed to $AUTH_AFTER"; exit 1; }
if solana account "$BUFFER" --url "$LOCAL" >/dev/null 2>&1; then echo "FAIL: buffer still exists after execution"; exit 1; fi
SPILL_AFTER="$(solana balance "$CREATOR" --url "$LOCAL" | awk '{print $1}')"
echo "    buffer closed; spill account $SPILL_BEFORE -> $SPILL_AFTER SOL"
echo
echo "REHEARSAL PASS: terminal-created proposal -> decoder MATCHES -> 2 approvals -> executed -> program holds the candidate"
