import assert from "node:assert/strict";
import test from "node:test";
import { keccak256 } from "ethers";
import { Keypair } from "@solana/web3.js";
import { airdropLeaf, merkleTree, verifyProof } from "./solanaAirdrop.mjs";
import { AIRDROP_USD_RULES, scoreUnits, thresholdsFor } from "./usdRules.mjs";

// The validator-proven construction from tests/solana/rewards-claims-acceptance.cjs, copied verbatim.
const keccak = (bytes) => Buffer.from(keccak256(bytes).slice(2), "hex");
function hashPair(a, b) { const [l, r] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a]; return keccak(Buffer.concat([l, r])); }
function buildRoot(leaves) { let layer = leaves.slice(); while (layer.length > 1) { const next = []; for (let i = 0; i < layer.length; i += 2) next.push(hashPair(layer[i], layer[i + 1] ?? layer[i])); layer = next; } return layer[0]; }
function buildProof(leaves, index) { const proof = []; let layer = leaves.slice(); let at = index; while (layer.length > 1) { proof.push(layer[at ^ 1] ?? layer[at]); const next = []; for (let i = 0; i < layer.length; i += 2) next.push(hashPair(layer[i], layer[i + 1] ?? layer[i])); layer = next; at = Math.floor(at / 2); } return proof; }

test("tree and proofs match the validator-proven construction for every size 1..9", () => {
  for (let n = 1; n <= 9; n += 1) {
    const leaves = Array.from({ length: n }, (_, i) => airdropLeaf({ epochId: 1_790_000_000, programCode: i % 2, winner: Keypair.generate().publicKey.toBase58(), amount: 1_000_000n + BigInt(i) }));
    const { root, proofs } = merkleTree(leaves);
    assert.ok(root.equals(buildRoot(leaves)), `root n=${n}`);
    leaves.forEach((leaf, i) => {
      assert.deepEqual(proofs[i].map((p) => p.toString("hex")), buildProof(leaves, i).map((p) => p.toString("hex")), `proof n=${n} i=${i}`);
      assert.ok(verifyProof(leaf, proofs[i], root));
    });
  }
});

test("a proof does not verify for another amount or program", () => {
  const winner = Keypair.generate().publicKey.toBase58();
  const leaves = [airdropLeaf({ epochId: 7, programCode: 0, winner, amount: 5n }), airdropLeaf({ epochId: 7, programCode: 1, winner, amount: 5n })];
  const { root, proofs } = merkleTree(leaves);
  assert.ok(!verifyProof(airdropLeaf({ epochId: 7, programCode: 0, winner, amount: 6n }), proofs[0], root));
  assert.ok(!verifyProof(leaves[1], proofs[0], root));
});

test("one USD rule set: $150 is 1.25 SOL at $120 and 0.25 BNB at $600; scores equal at equal dollars", () => {
  assert.equal(thresholdsFor(101, 120).traderMinRaw, 1_250_000_000n);
  assert.equal(thresholdsFor(56, 600).traderMinRaw, 250_000_000_000_000_000n);
  assert.equal(thresholdsFor(4663, 3000).creatorMinUniqueBuyers, AIRDROP_USD_RULES.creatorMinUniqueBuyers);
  const bnbScore = scoreUnits(1_000_000_000_000_000_000n, 56, 600); // 1 BNB @ $600
  const solScore = scoreUnits(5_000_000_000n, 101, 120); // 5 SOL @ $120
  assert.equal(bnbScore, 1);
  assert.equal(solScore, 1);
});
