#!/usr/bin/env bash
# Full rehearsal of the mainnet rewards-treasury upgrade on a local validator, before anyone signs:
# the treasury program, its ProgramData and ALL of its accounts cloned from mainnet (read-only), the
# upgrade authority re-homed to a fresh 2-of-3 Squads multisig's vault, rewards_config.authority
# re-homed to a local key (so the post-upgrade steps can be signed here), the real Squads v4 program.
# Then: stage the certified candidate, propose from the terminal (decoder must say MATCHES), refuse
# the incident shape, 2 approvals, execute, byte-verify, and run every post-upgrade step of the
# runbook against the upgraded program (rehearse-mainnet-treasury-upgrade.cjs).
#
#   bash scripts/solana/rehearse-mainnet-treasury-upgrade.sh
#
# Nothing is sent to mainnet: cloning is a read. Needs SOLANA_MAINNET_RPC_URL or SOLANA_RPC_URL in
# frontend/.env.local.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

SQUADS="SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf"
SQUADS_CONFIG="BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr"
PROGRAM_ID="2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX"
CANDIDATE="$ROOT/target/deploy/mwz_rewards_treasury.so"
WRONG_SO="$ROOT/target/deploy/memewarzone_solana.so"   # the launchpad binary: the incident's shape, mirrored
LOCAL="http://127.0.0.1:8899"
EXPECT_SHA="$(node -e 'console.log(require("./config/solana/treasury-binary.certification.json").artifact.sha256)')"

MAINNET_RPC="${SOLANA_MAINNET_RPC_URL:-}"
if [[ -z "$MAINNET_RPC" && -f "$ROOT/frontend/.env.local" ]]; then
  MAINNET_RPC="$(grep -E '^\s*(export\s+)?SOLANA_RPC_URL\s*=' "$ROOT/frontend/.env.local" | head -1 | cut -d= -f2- | tr -d '"'"'"'' | tr -d '[:space:]')"
fi
[[ -n "$MAINNET_RPC" ]] || { echo "no mainnet RPC to clone from" >&2; exit 1; }
[[ -s "$CANDIDATE" ]] || { echo "missing $CANDIDATE (run run-local-treasury-gate.sh)" >&2; exit 1; }
[[ "$(sha256sum "$CANDIDATE" | awk '{print $1}')" == "$EXPECT_SHA" ]] || { echo "candidate is not the certified $EXPECT_SHA" >&2; exit 1; }
if solana cluster-version --url "$LOCAL" >/dev/null 2>&1; then
  echo "something already answers on $LOCAL -- stop it first" >&2; exit 1
fi

WORK="$(mktemp -d -t mwz-treasury-rehearsal-XXXXXX)"
VALIDATOR_PID=""
cleanup() { if [[ -n "$VALIDATOR_PID" ]]; then kill "$VALIDATOR_PID" 2>/dev/null || true; wait "$VALIDATOR_PID" 2>/dev/null || true; fi; rm -rf "$WORK"; }
trap cleanup EXIT

for k in creator m2 m3 createKey buffer wrongbuf authority poster; do solana-keygen new --no-bip39-passphrase --silent -o "$WORK/$k.json"; done
# Own CLI config: never depend on (or touch) the machine's default wallet.
solana config set --config "$WORK/cli.yml" --keypair "$WORK/creator.json" >/dev/null
solana() { command solana --config "$WORK/cli.yml" "$@"; }
CREATOR="$(solana-keygen pubkey "$WORK/creator.json")"
BUFFER="$(solana-keygen pubkey "$WORK/buffer.json")"
WRONGBUF="$(solana-keygen pubkey "$WORK/wrongbuf.json")"
AUTHORITY="$(solana-keygen pubkey "$WORK/authority.json")"
read -r MS VAULT < <(node scripts/solana/rehearse-squads-upgrade-proposal.mjs derive --create-key "$WORK/createKey.json")
echo "==> multisig $MS  vault $VAULT  local rewards authority $AUTHORITY"

PROGRAMDATA="$(solana program show "$PROGRAM_ID" --url "$MAINNET_RPC" | awk '/ProgramData Address/ {print $3}')"
MAINNET_SLOT="$(solana program show "$PROGRAM_ID" --url "$MAINNET_RPC" | awk '/Last Deployed In Slot/ {print $5}')"
echo "==> mainnet treasury: ProgramData $PROGRAMDATA, last deployed slot $MAINNET_SLOT"
solana account "$PROGRAM_ID" --url "$MAINNET_RPC" --output json --output-file "$WORK/program.json" >/dev/null
solana account "$PROGRAMDATA" --url "$MAINNET_RPC" --output json --output-file "$WORK/programdata.json" >/dev/null
node -e '
const fs = require("fs");
const text = fs.readFileSync(process.argv[1], "utf8");
const m = text.match(/"data":\s*\[\s*"([A-Za-z0-9+\/=]+)"/);
const d = Buffer.from(m[1], "base64");
if (d.readUInt32LE(0) !== 3 || d[12] !== 1) throw new Error("not a ProgramData account with an authority");
d.writeBigUInt64LE(0n, 4);
Buffer.from(require("bs58").decode(process.argv[2])).copy(d, 13);
fs.writeFileSync(process.argv[1], text.replace(m[1], d.toString("base64")));
console.log(`    ProgramData ${d.length} bytes, authority now the local vault`);
' "$WORK/programdata.json" "$VAULT"

echo "==> cloning every account the treasury owns on mainnet (read-only)"
mkdir -p "$WORK/accounts"
node -e '
const { createRequire } = require("module");
const req = createRequire(require("path").resolve("tests/solana/package.json"));
const { Connection, PublicKey } = req("@solana/web3.js");
const fs = require("fs");
const crypto = require("crypto");
(async () => {
  const c = new Connection(process.argv[1], "confirmed");
  const accs = await c.getProgramAccounts(new PublicKey(process.argv[2]));
  const configDisc = crypto.createHash("sha256").update("account:RewardsConfig").digest().subarray(0, 8);
  const local = Buffer.from(req("bs58").decode(process.argv[3]));
  // Every account whose authority (first field) is the mainnet rewards authority -- rewards_config,
  // arena_config, route_state, arena_money_config_v2 -- is re-homed to the local key, so the
  // post-upgrade steps can be signed here exactly as the deployer signs them on mainnet.
  const configRow = accs.find(({ account }) => Buffer.from(account.data).subarray(0, 8).equals(configDisc));
  const mainnetAuthority = Buffer.from(configRow.account.data).subarray(8, 40);
  console.log(`    mainnet rewards authority ${req("bs58").encode(mainnetAuthority)}`);
  for (const { pubkey, account } of accs) {
    const data = Buffer.from(account.data);
    if (data.length >= 40 && data.subarray(8, 40).equals(mainnetAuthority)) { local.copy(data, 8); console.log(`    ${pubkey.toBase58()} authority -> local key`); }
    fs.writeFileSync(`${process.argv[4]}/${pubkey.toBase58()}.json`, JSON.stringify({
      pubkey: pubkey.toBase58(),
      account: { lamports: account.lamports, data: [data.toString("base64"), "base64"], owner: account.owner.toBase58(), executable: false, rentEpoch: 0, space: data.length },
    }));
  }
  console.log(`    ${accs.length} accounts`);
})().catch((e) => { console.error(e); process.exit(1); });
' "$MAINNET_RPC" "$PROGRAM_ID" "$AUTHORITY" "$WORK/accounts"
ACCOUNT_ARGS=()
for f in "$WORK"/accounts/*.json; do ACCOUNT_ARGS+=(--account "$(basename "$f" .json)" "$f"); done

echo "==> starting validator: Squads cloned from mainnet, the treasury exactly as on mainnet"
solana-test-validator --reset --quiet --ledger "$WORK/ledger" --url "$MAINNET_RPC" \
  --clone-upgradeable-program "$SQUADS" --clone "$SQUADS_CONFIG" \
  --account "$PROGRAM_ID" "$WORK/program.json" --account "$PROGRAMDATA" "$WORK/programdata.json" \
  "${ACCOUNT_ARGS[@]}" >"$WORK/validator.log" 2>&1 &
VALIDATOR_PID=$!
for i in $(seq 1 90); do solana cluster-version --url "$LOCAL" >/dev/null 2>&1 && break; sleep 2; done
solana cluster-version --url "$LOCAL" >/dev/null 2>&1 || { echo "validator did not come up"; tail -20 "$WORK/validator.log"; exit 1; }

for k in creator m2 m3 authority; do solana airdrop 100 "$(solana-keygen pubkey "$WORK/$k.json")" --url "$LOCAL" >/dev/null; done
echo "==> creating the 2-of-3 multisig"
SOLANA_RPC_URL="$LOCAL" node scripts/solana/rehearse-squads-upgrade-proposal.mjs create-multisig \
  --create-key "$WORK/createKey.json" --creator "$WORK/creator.json" --members "$WORK/m2.json,$WORK/m3.json" --threshold 2

echo "==> extending the allocation as on mainnet, then staging the candidate (and the launchpad binary as the wrong buffer)"
PD_LEN="$(solana account "$PROGRAMDATA" --url "$LOCAL" --output json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).account.space))')"
NEED=$(( $(wc -c < "$CANDIDATE") + 45 - PD_LEN ))
if (( NEED > 0 )); then
  solana program extend "$PROGRAM_ID" "$NEED" --keypair "$WORK/creator.json" --url "$LOCAL" >/dev/null
  echo "    extended by $NEED bytes (mainnet runbook: solana program extend $PROGRAM_ID $NEED)"
fi
solana program write-buffer "$CANDIDATE" --buffer "$WORK/buffer.json" --keypair "$WORK/creator.json" --url "$LOCAL" >/dev/null
solana program set-buffer-authority "$BUFFER" --new-buffer-authority "$VAULT" --keypair "$WORK/creator.json" --url "$LOCAL" >/dev/null
if [[ -s "$WRONG_SO" ]]; then
  solana program write-buffer "$WRONG_SO" --buffer "$WORK/wrongbuf.json" --keypair "$WORK/creator.json" --url "$LOCAL" >/dev/null
  solana program set-buffer-authority "$WRONGBUF" --new-buffer-authority "$VAULT" --keypair "$WORK/creator.json" --url "$LOCAL" >/dev/null
fi
for i in $(seq 1 30); do
  solana program show "$BUFFER" --url "$LOCAL" --commitment finalized 2>/dev/null | grep -q "Authority: $VAULT" && break; sleep 2
done
BEFORE_SLOT="$(solana program show "$PROGRAM_ID" --url "$LOCAL" | awk '/Last Deployed In Slot/ {print $5}')"

PROPOSE=(node scripts/solana/propose-squads-upgrade.mjs --local --multisig "$MS" --program "$PROGRAM_ID" --buffer "$BUFFER" \
  --spill "$CREATOR" --authority "$VAULT" --candidate "$CANDIDATE" --creator-keypair "$WORK/creator.json")
echo "==> propose: dry run"
SOLANA_RPC_URL="$LOCAL" "${PROPOSE[@]}"
echo "==> propose: --send (must end with the decoder's PROPOSAL MATCHES)"
SOLANA_RPC_URL="$LOCAL" "${PROPOSE[@]}" --send

if [[ -s "$WRONG_SO" ]]; then
  echo "==> the incident shape must be refused: treasury program, launchpad bytes"
  if SOLANA_RPC_URL="$LOCAL" node scripts/solana/propose-squads-upgrade.mjs --local --multisig "$MS" --authority "$VAULT" --creator-keypair "$WORK/creator.json" \
      --program "$PROGRAM_ID" --buffer "$WRONGBUF" --spill "$CREATOR" --candidate "$WRONG_SO" >/dev/null 2>"$WORK/refuse.err"; then
    echo "FAIL: launchpad bytes into the treasury were accepted"; exit 1
  fi
  echo "    ok: $(grep -o 'refusing: .*' "$WORK/refuse.err" | head -c 160)"
fi

INDEX=1
echo "==> approve (creator, m2) and execute (m2)"
for m in creator m2; do SOLANA_RPC_URL="$LOCAL" node scripts/solana/rehearse-squads-upgrade-proposal.mjs approve --multisig "$MS" --index "$INDEX" --member "$WORK/$m.json"; done
SOLANA_RPC_URL="$LOCAL" node scripts/solana/rehearse-squads-upgrade-proposal.mjs execute --multisig "$MS" --index "$INDEX" --member "$WORK/m2.json"

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
[[ "$AFTER_SLOT" != "$BEFORE_SLOT" ]] || { echo "FAIL: deployed slot did not advance"; exit 1; }
[[ "$AUTH_AFTER" == "$VAULT" ]] || { echo "FAIL: authority changed to $AUTH_AFTER"; exit 1; }
if solana account "$BUFFER" --url "$LOCAL" >/dev/null 2>&1; then echo "FAIL: buffer still exists after execution"; exit 1; fi
echo "    slot $BEFORE_SLOT -> $AFTER_SLOT, authority still the vault, buffer closed"

echo "==> post-upgrade runbook against the upgraded program"
SOLANA_RPC_URL="$LOCAL" node scripts/solana/rehearse-mainnet-treasury-upgrade.cjs "$WORK/authority.json" "$WORK/poster.json"
echo
echo "TREASURY UPGRADE REHEARSAL PASS: mainnet state cloned -> Squads proposal MATCHES -> executed -> candidate deployed -> every post-upgrade step works"
