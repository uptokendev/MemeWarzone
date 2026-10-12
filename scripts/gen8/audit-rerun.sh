#!/usr/bin/env bash
# Re-run the four AI-audit PoC sets (2026-10-12) against the current gen-8 contracts.
# Copies each PoC from its audit commit (git show, read-only) into ./audit-rerun with PATH-ONLY changes (import paths
# and, for the audit-D fork script, the RPC source: exported env vars or the public RPCs, never a .env file, and the
# B openAt field the launch request now has). Then:
#   A, B, C: npx hardhat --config hardhat.audit-rerun.config.ts test   (local hardhat, fresh keys)
#   D:       node audit-rerun/D/fork-econ.mjs --sims grad,grad2,splitter   (local anvil forks, fresh keys)
# A test that FAILS here is a PoC whose exploit no longer works; the log names the revert.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WT="${AUDIT_WORKTREES:-$HOME/mwz-wt}"
OUT="$ROOT/audit-rerun"
rm -rf "$OUT" && mkdir -p "$OUT/contracts/A" "$OUT/contracts/D" "$OUT/tests/A" "$OUT/tests/B" "$OUT/tests/C" "$OUT/D"
show() { git -C "$WT/$1" show "$2:$3"; }
show audit-A bedf8806 test/audit/A/contracts/AuditA.sol | sed 's#"../../../../contracts/gen8/#"../../../contracts/gen8/#' > "$OUT/contracts/A/AuditA.sol"
show audit-A bedf8806 test/audit/A/auditA.spec.ts | sed 's#"../../gen8/fixtures/#"../../../test/gen8/fixtures/#' > "$OUT/tests/A/auditA.spec.ts"
show audit-B bf5695ff test/audit/B/gen8-B.spec.ts | sed 's#"../../gen8/fixtures/#"../../../test/gen8/fixtures/#' > "$OUT/tests/B/gen8-B.spec.ts"
show audit-C d15839cf test/audit/C/gen8-C.audit.spec.ts | sed 's#"../../gen8/fixtures/#"../../../test/gen8/fixtures/#' > "$OUT/tests/C/gen8-C.audit.spec.ts"
# C variant: the PoCs' own SETUP claims (the operator's claim, "worker step 1", written as env.hook.claimRouter() from
# the default signer) are made by the splitter operator, as F4 now requires; every exploit step is left unchanged
# (the attacker's claims stay connect(env.attacker)). Shows which C findings still reproduce once setup is legal.
mkdir -p "$OUT/tests/C-operator-setup"
sed -e 's#await env.hook.claimRouter()#await env.hook.connect(env.operator).claimRouter()#g' -e 's#describe("Audit C: #describe("Audit C (operator-made setup claims): #' \
  "$OUT/tests/C/gen8-C.audit.spec.ts" > "$OUT/tests/C-operator-setup/gen8-C.operator-setup.spec.ts"
show audit-D c10ef8a9 test/audit/D/contracts/AuditDMultiSwap.sol > "$OUT/contracts/D/AuditDMultiSwap.sol"
show audit-D c10ef8a9 scripts/audit/D/fork-econ.mjs \
  | sed -e 's#"../../gen8/fork-suite/#"../../scripts/gen8/fork-suite/#' \
        -e 's#import { WAD, BPS, readEnvFile, #import { WAD, BPS, #' \
        -e 's#^const ENV = readEnvFile(.*#const ENV = { BSC_MAINNET_RPC: "https://bsc-dataseed.bnbchain.org", ROBINHOOD_MAINNET_RPC: "https://rpc.mainnet.chain.robinhood.com" }; // public read-only RPCs (no .env)#' \
        -e 's#const ROOT = path.resolve(here, "..", "..", "..");#const ROOT = path.resolve(here, "..", "..");#' \
        -e 's#path.join(ROOT, "artifacts-audit-D", "test", "audit", "D", "contracts", "AuditDMultiSwap.sol", "AuditDMultiSwap.json")#path.join(ROOT, "artifacts-audit-rerun", "audit-rerun", "contracts", "D", "AuditDMultiSwap.sol", "AuditDMultiSwap.json")#' \
        -e 's#target, 1, 0, firstBuy, 0n, REQ_SALT++\]#target, 1, 0, firstBuy, 0n, REQ_SALT++, 0n]#' \
        -e 's#fs.mkdirSync(path.join(here, "results"), { recursive: true });#fs.mkdirSync(path.join(here, "results"), { recursive: true }); // results stay in audit-rerun/D#' \
  > "$OUT/D/fork-econ.mjs"
grep -q "readEnvFile" "$OUT/D/fork-econ.mjs" && { echo "audit-D script still reads an env file; refusing"; exit 1; }
grep -q "REQ_SALT++, 0n\]" "$OUT/D/fork-econ.mjs" || { echo "audit-D launch request not patched"; exit 1; }
echo "copied to $OUT"
