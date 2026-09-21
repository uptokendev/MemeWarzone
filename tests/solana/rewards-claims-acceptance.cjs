"use strict";

/**
 * Local-validator acceptance for the reward side of mwz_rewards_treasury:
 * roots published by the authority, claims proven by Merkle proof, paid from
 * the vault, exactly once.
 *
 * Before this suite the four claim rails (league, airdrop, recruiter, squad)
 * had never executed against a validator from this repository. The mainnet
 * program predates them entirely -- the recruiter cron fails with
 * InstructionFallbackNotFound -- so the upgrade that adds them is the first
 * time real users can claim. This is the gate for that upgrade.
 *
 * It also pins parity with the API: the league leaf and root the API would
 * publish (frontend/api/solanaLeagueMerkle.js) must be byte-identical to what
 * the program verifies, or every league claim fails with InvalidProof.
 *
 * Run after:
 *   solana-test-validator --reset \
 *     --bpf-program 2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX target/deploy/mwz_rewards_treasury.so
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const anchor = require("@coral-xyz/anchor");
const { keccak_256 } = require("@noble/hashes/sha3");
const { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } = require("@solana/web3.js");

const { AnchorProvider, BN, Program, setProvider } = anchor;

const TREASURY_PROGRAM = new PublicKey("2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX");
const PREFIX = {
  league: Buffer.from("MWZ_LEAGUE_LEAF", "utf8"),
  airdrop: Buffer.from("MWZ_AIRDROP_LEAF", "utf8"),
  recruiter: Buffer.from("MWZ_RECRUITER_LEAF", "utf8"),
  squad: Buffer.from("MWZ_SQUAD_LEAF", "utf8"),
};
const PERIOD_WEEKLY = 0;
const AIRDROP_PROGRAM_TRADER = 1;

// --- encoding, mirrored from programs/mwz_rewards_treasury/src/lib.rs ------

function u64le(value) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
}

function i64le(value) {
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(BigInt(value));
  return out;
}

const keccak = (bytes) => Buffer.from(keccak_256(bytes));

function leagueLeaf({ epochStart, period, categoryHash, rank, winner, amount }) {
  return keccak(Buffer.concat([
    PREFIX.league, i64le(epochStart), Buffer.from([period]), categoryHash, Buffer.from([rank]), winner.toBuffer(), u64le(amount),
  ]));
}

function airdropLeaf({ epochId, programCode, winner, amount }) {
  return keccak(Buffer.concat([PREFIX.airdrop, i64le(epochId), Buffer.from([programCode]), winner.toBuffer(), u64le(amount)]));
}

function laneLeaf(prefix, { epochId, winner, amount }) {
  return keccak(Buffer.concat([prefix, i64le(epochId), winner.toBuffer(), u64le(amount)]));
}

function hashPair(a, b) {
  const [left, right] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return keccak(Buffer.concat([left, right]));
}

// Same shape as the API's buildMerkleRoot/buildMerkleProof: an odd node pairs with itself.
function buildRoot(leaves) {
  let layer = leaves.slice();
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) next.push(hashPair(layer[i], layer[i + 1] ?? layer[i]));
    layer = next;
  }
  return layer[0];
}

function buildProof(leaves, index) {
  const proof = [];
  let layer = leaves.slice();
  let at = index;
  while (layer.length > 1) {
    proof.push(layer[at ^ 1] ?? layer[at]);
    const next = [];
    for (let i = 0; i < layer.length; i += 2) next.push(hashPair(layer[i], layer[i + 1] ?? layer[i]));
    layer = next;
    at = Math.floor(at / 2);
  }
  return proof;
}

const arr32 = (buf) => Array.from(buf);
const proofArg = (proof) => proof.map(arr32);

async function expectFail(promise, pattern, label) {
  let failed = false;
  try {
    await promise;
  } catch (error) {
    failed = true;
    const text = `${error?.message || ""} ${JSON.stringify(error?.logs || error?.transactionLogs || [])}`;
    assert.match(text, pattern, `${label}: failed for the wrong reason`);
  }
  assert.ok(failed, `${label}: must fail`);
}

describe("rewards treasury local-validator acceptance (roots + claims)", function () {
  this.timeout(600_000);

  let provider;
  let program;
  let connection;
  let authority;
  let pdas;
  const winners = [Keypair.generate(), Keypair.generate(), Keypair.generate()];

  const pda = (seed, ...extra) => PublicKey.findProgramAddressSync([Buffer.from(seed, "utf8"), ...extra], TREASURY_PROGRAM)[0];
  const lamports = async (pk) => BigInt(await connection.getBalance(pk, "confirmed"));

  async function fund(pubkey, sol) {
    const sig = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
    const latest = await connection.getLatestBlockhash("confirmed");
    await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
  }

  async function transferTo(pubkey, amount) {
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({ fromPubkey: authority, toPubkey: pubkey, lamports: Number(amount) }),
    );
    await provider.sendAndConfirm(tx, [], { commitment: "confirmed" });
  }

  before(async function () {
    provider = AnchorProvider.env();
    setProvider(provider);
    connection = provider.connection;
    authority = provider.wallet.publicKey;

    const idlPath = path.resolve(__dirname, "../../target/idl/mwz_rewards_treasury.json");
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
    program = new Program(idl, provider);

    pdas = {
      config: pda("rewards_config"),
      routeState: pda("route_state"),
      leagueVault: pda("league_vault"),
      airdropVault: pda("airdrop_vault"),
      monthlyLeagueVault: pda("monthly_league_vault"),
      recruiterVault: pda("recruiter_vault"),
      squadVault: pda("squad_vault"),
      protocolVault: pda("protocol_vault"),
    };

    // Same sequence the deployer ran on mainnet: initialize, then the two
    // lane inits (the old initialize_lanes is deprecated and must reject).
    if (!(await connection.getAccountInfo(pdas.config, "confirmed"))) {
      await program.methods
        .initialize()
        .accountsStrict({ authority, config: pdas.config, leagueVault: pdas.leagueVault, airdropVault: pdas.airdropVault, systemProgram: SystemProgram.programId })
        .rpc({ commitment: "confirmed" });
    }
    if (!(await connection.getAccountInfo(pdas.routeState, "confirmed"))) {
      await program.methods
        .initializeLanesV2Primary(authority, new BN(200_000_000))
        .accountsStrict({
          authority, config: pdas.config, routeState: pdas.routeState,
          monthlyLeagueVault: pdas.monthlyLeagueVault, protocolVault: pdas.protocolVault, systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" });
      await program.methods
        .initializeLanesV2Secondary()
        .accountsStrict({
          authority, config: pdas.config, routeState: pdas.routeState,
          recruiterVault: pdas.recruiterVault, squadVault: pdas.squadVault, systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" });
    }
    const config = await program.account.rewardsConfig.fetch(pdas.config);
    if (!config.claimsEnabled) {
      await program.methods.setClaimsEnabled(true).accountsStrict({ authority, config: pdas.config }).rpc({ commitment: "confirmed" });
    }
    for (const winner of winners) await fund(winner.publicKey, 1);
  });

  it("rejects the deprecated initialize_lanes so nobody re-runs the old bootstrap", async function () {
    await expectFail(
      program.methods.initializeLanes(authority, new BN(1)).accountsStrict({ authority }).rpc({ commitment: "confirmed" }),
      /DeprecatedInstruction|custom program error/i,
      "initialize_lanes",
    );
  });

  it("league: publishes a root, pays a proven winner exactly once, refuses forged and disabled claims", async function () {
    const epochStart = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
    const categoryHash = keccak(Buffer.from("biggest_hit", "utf8"));
    const prizes = [500_000_000n, 300_000_000n, 200_000_000n];
    const total = prizes.reduce((a, b) => a + b, 0n);
    const leaves = prizes.map((amount, i) =>
      leagueLeaf({ epochStart, period: PERIOD_WEEKLY, categoryHash, rank: i + 1, winner: winners[i].publicKey, amount }),
    );
    const root = buildRoot(leaves);

    // Parity with what the API publishes: same leaf, same root.
    const api = await import("../../frontend/api/solanaLeagueMerkle.js");
    const apiLeaves = prizes.map((amount, i) => api.leagueLeaf({
      epochStartSec: epochStart, period: "weekly", category: "biggest_hit", rank: i + 1,
      recipient: winners[i].publicKey.toBase58(), amountRaw: amount.toString(),
    }));
    assert.equal(apiLeaves[0], `0x${leaves[0].toString("hex")}`, "API league leaf must match the program's leaf encoding");
    assert.equal(api.buildMerkleRoot(apiLeaves), `0x${root.toString("hex")}`, "API Merkle root must match the program's tree");
    // The API derives from SOLANA_REWARDS_TREASURY_PROGRAM_ID; pass the id so
    // parity is about the seeds, not about this shell's environment.
    const programId = TREASURY_PROGRAM.toBase58();
    assert.equal(
      api.deriveLeagueEpochPda("weekly", epochStart, programId).toString(),
      pda("league_epoch", Buffer.from([PERIOD_WEEKLY]), i64le(epochStart)).toBase58(),
      "API league epoch PDA must match the program's seeds",
    );
    assert.equal(
      api.deriveLeagueClaimPda("weekly", epochStart, "biggest_hit", 1, programId).toString(),
      pda("league_claim", Buffer.from([PERIOD_WEEKLY]), i64le(epochStart), categoryHash, Buffer.from([1])).toBase58(),
      "API league claim receipt PDA must match the program's seeds",
    );

    await program.methods.depositLeague(new BN(2 * LAMPORTS_PER_SOL))
      .accountsStrict({ payer: authority, leagueVault: pdas.leagueVault, systemProgram: SystemProgram.programId })
      .rpc({ commitment: "confirmed" });

    const leagueEpoch = pda("league_epoch", Buffer.from([PERIOD_WEEKLY]), i64le(epochStart));
    await program.methods.setLeagueEpochRoot(PERIOD_WEEKLY, new BN(epochStart), arr32(root), new BN(total.toString()))
      .accountsStrict({ authority, config: pdas.config, leagueVault: pdas.leagueVault, leagueEpoch, systemProgram: SystemProgram.programId })
      .rpc({ commitment: "confirmed" });
    const epoch = await program.account.leagueEpoch.fetch(leagueEpoch);
    assert.equal(epoch.sealed, true);
    assert.equal(BigInt(epoch.totalLamports.toString()), total);

    const claimFor = (i, overrides = {}) => {
      const rank = overrides.rank ?? i + 1;
      const amount = overrides.amount ?? prizes[i];
      const proof = overrides.proof ?? buildProof(leaves, i);
      const signer = overrides.signer ?? winners[i];
      const claimReceipt = pda("league_claim", Buffer.from([PERIOD_WEEKLY]), i64le(epochStart), categoryHash, Buffer.from([rank]));
      return program.methods
        .claimLeague(PERIOD_WEEKLY, new BN(epochStart), arr32(categoryHash), rank, new BN(amount.toString()), proofArg(proof))
        .accountsStrict({ winner: signer.publicKey, config: pdas.config, leagueVault: pdas.leagueVault, leagueEpoch, claimReceipt, systemProgram: SystemProgram.programId })
        .signers([signer])
        .rpc({ commitment: "confirmed" });
    };

    const vaultBefore = await lamports(pdas.leagueVault);
    const winnerBefore = await lamports(winners[0].publicKey);
    const claimSig = await claimFor(0);
    const vaultAfter = await lamports(pdas.leagueVault);
    const winnerAfter = await lamports(winners[0].publicKey);
    assert.equal(vaultBefore - vaultAfter, prizes[0], "the vault pays exactly the leaf amount");
    // The winner funds the receipt's rent; the provider wallet is the fee
    // payer here (two signatures, 10,000 lamports). Everything else is the
    // prize, to the lamport.
    const receipt = await connection.getAccountInfo(
      pda("league_claim", Buffer.from([PERIOD_WEEKLY]), i64le(epochStart), categoryHash, Buffer.from([1])), "confirmed",
    );
    const claimTx = await connection.getTransaction(claimSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    assert.equal(claimTx.meta.fee, 10_000, "two signers: fee payer plus winner");
    assert.equal(winnerAfter - winnerBefore, prizes[0] - BigInt(receipt.lamports), "winner receives the prize minus receipt rent, exactly");
    assert.equal(BigInt((await program.account.leagueEpoch.fetch(leagueEpoch)).claimedLamports.toString()), prizes[0]);

    await expectFail(claimFor(0), /already in use|custom program error|0x0\b/i, "second claim of the same rank");
    await expectFail(claimFor(1, { signer: winners[2] }), /InvalidProof|custom program error/i, "another wallet with a real proof");
    await expectFail(claimFor(1, { amount: prizes[1] + 1n }), /InvalidProof|custom program error/i, "inflated amount");
    await expectFail(claimFor(1, { proof: buildProof(leaves, 2) }), /InvalidProof|custom program error/i, "wrong proof");

    await program.methods.setClaimsEnabled(false).accountsStrict({ authority, config: pdas.config }).rpc({ commitment: "confirmed" });
    await expectFail(claimFor(1), /ClaimsDisabled|custom program error/i, "claims disabled");
    await program.methods.setClaimsEnabled(true).accountsStrict({ authority, config: pdas.config }).rpc({ commitment: "confirmed" });
    await claimFor(1);
    await claimFor(2);
    assert.equal(BigInt((await program.account.leagueEpoch.fetch(leagueEpoch)).claimedLamports.toString()), total, "the epoch is fully claimed");
  });

  it("airdrop: pays proven winners once and refuses a batch past its deadline", async function () {
    const epochId = 64;
    const amounts = [150_000_000n, 250_000_000n];
    const total = amounts.reduce((a, b) => a + b, 0n);
    const leaves = amounts.map((amount, i) => airdropLeaf({ epochId, programCode: AIRDROP_PROGRAM_TRADER, winner: winners[i].publicKey, amount }));
    const root = buildRoot(leaves);

    await program.methods.depositAirdrop(new BN(LAMPORTS_PER_SOL))
      .accountsStrict({ payer: authority, airdropVault: pdas.airdropVault, systemProgram: SystemProgram.programId })
      .rpc({ commitment: "confirmed" });
    const airdropBatch = pda("airdrop_batch", i64le(epochId));
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    await program.methods.setAirdropBatchRoot(new BN(epochId), arr32(root), new BN(total.toString()), new BN(deadline))
      .accountsStrict({ authority, config: pdas.config, airdropVault: pdas.airdropVault, airdropBatch, systemProgram: SystemProgram.programId })
      .rpc({ commitment: "confirmed" });

    const claim = (i, signer = winners[i]) => program.methods
      .claimAirdrop(new BN(epochId), AIRDROP_PROGRAM_TRADER, new BN(amounts[i].toString()), proofArg(buildProof(leaves, i)))
      .accountsStrict({
        winner: signer.publicKey, config: pdas.config, airdropVault: pdas.airdropVault, airdropBatch,
        airdropReceipt: pda("airdrop_claim", i64le(epochId), Buffer.from([AIRDROP_PROGRAM_TRADER]), signer.publicKey.toBuffer()),
        systemProgram: SystemProgram.programId,
      })
      .signers([signer])
      .rpc({ commitment: "confirmed" });

    const vaultBefore = await lamports(pdas.airdropVault);
    await claim(0);
    await claim(1);
    assert.equal(vaultBefore - (await lamports(pdas.airdropVault)), total, "airdrop vault pays exactly the two leaves");
    await expectFail(claim(0), /already in use|custom program error|0x0\b/i, "double airdrop claim");
    await expectFail(claim(0, winners[2]), /InvalidProof|custom program error/i, "airdrop claim by a non-winner");

    // A batch whose deadline has passed pays nobody.
    const lateId = 65;
    const lateLeaves = [airdropLeaf({ epochId: lateId, programCode: AIRDROP_PROGRAM_TRADER, winner: winners[2].publicKey, amount: 1_000_000n })];
    const lateBatch = pda("airdrop_batch", i64le(lateId));
    await program.methods.setAirdropBatchRoot(new BN(lateId), arr32(buildRoot(lateLeaves)), new BN(1_000_000), new BN(Math.floor(Date.now() / 1000) + 3))
      .accountsStrict({ authority, config: pdas.config, airdropVault: pdas.airdropVault, airdropBatch: lateBatch, systemProgram: SystemProgram.programId })
      .rpc({ commitment: "confirmed" });
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    await expectFail(
      program.methods.claimAirdrop(new BN(lateId), AIRDROP_PROGRAM_TRADER, new BN(1_000_000), proofArg(buildProof(lateLeaves, 0)))
        .accountsStrict({
          winner: winners[2].publicKey, config: pdas.config, airdropVault: pdas.airdropVault, airdropBatch: lateBatch,
          airdropReceipt: pda("airdrop_claim", i64le(lateId), Buffer.from([AIRDROP_PROGRAM_TRADER]), winners[2].publicKey.toBuffer()),
          systemProgram: SystemProgram.programId,
        })
        .signers([winners[2]])
        .rpc({ commitment: "confirmed" }),
      /ClaimExpired|custom program error/i,
      "expired airdrop batch",
    );
  });

  for (const lane of [
    { name: "recruiter", prefix: PREFIX.recruiter, vault: "recruiterVault", batchSeed: "recruiter_batch", claimSeed: "recruiter_claim", setRoot: "setRecruiterBatchRoot", claim: "claimRecruiter", batchKey: "recruiterBatch" },
    { name: "squad", prefix: PREFIX.squad, vault: "squadVault", batchSeed: "squad_batch", claimSeed: "squad_claim", setRoot: "setSquadBatchRoot", claim: "claimSquad", batchKey: "squadBatch" },
  ]) {
    it(`${lane.name}: the lane the launchpad flushes into pays proven winners once`, async function () {
      const epochId = 64;
      const amounts = [120_000_000n, 80_000_000n, 50_000_000n];
      const total = amounts.reduce((a, b) => a + b, 0n);
      const leaves = amounts.map((amount, i) => laneLeaf(lane.prefix, { epochId, winner: winners[i].publicKey, amount }));
      const root = buildRoot(leaves);

      // No deposit instruction for these lanes: the launchpad's fee escrow
      // flush credits the vault PDA directly, which is a plain lamport transfer.
      await transferTo(pdas[lane.vault], LAMPORTS_PER_SOL);

      const batch = pda(lane.batchSeed, i64le(epochId));
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      await program.methods[lane.setRoot](new BN(epochId), arr32(root), new BN(total.toString()), new BN(deadline))
        .accountsStrict({ authority, config: pdas.config, [lane.vault]: pdas[lane.vault], [lane.batchKey]: batch, systemProgram: SystemProgram.programId })
        .rpc({ commitment: "confirmed" });

      const claim = (i, signer = winners[i], amount = amounts[i]) => program.methods[lane.claim](new BN(epochId), new BN(amount.toString()), proofArg(buildProof(leaves, i)))
        .accountsStrict({
          winner: signer.publicKey, config: pdas.config, [lane.vault]: pdas[lane.vault], [lane.batchKey]: batch,
          claimReceipt: pda(lane.claimSeed, i64le(epochId), signer.publicKey.toBuffer()),
          systemProgram: SystemProgram.programId,
        })
        .signers([signer])
        .rpc({ commitment: "confirmed" });

      const vaultBefore = await lamports(pdas[lane.vault]);
      for (let i = 0; i < amounts.length; i += 1) await claim(i);
      assert.equal(vaultBefore - (await lamports(pdas[lane.vault])), total, `${lane.name} vault pays exactly the batch total`);
      await expectFail(claim(0), /already in use|custom program error|0x0\b/i, `${lane.name} double claim`);
      await expectFail(claim(1, winners[1], amounts[1] + 1n), /InvalidProof|custom program error/i, `${lane.name} inflated claim`);
    });
  }

  it("operator fill: the protocol vault surplus moves to the route operator and nowhere else", async function () {
    await transferTo(pdas.protocolVault, LAMPORTS_PER_SOL);
    const vaultBefore = await lamports(pdas.protocolVault);
    const operatorBefore = await lamports(authority);
    const sig = await program.methods.flushOperatorFill()
      .accountsStrict({ operator: authority, routeState: pdas.routeState, protocolVault: pdas.protocolVault })
      .rpc({ commitment: "confirmed" });
    const tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const vaultAfter = await lamports(pdas.protocolVault);
    const operatorAfter = await lamports(authority);
    const moved = vaultBefore - vaultAfter;
    assert.ok(moved > 0n, "something was flushed");
    assert.equal(operatorAfter - operatorBefore + BigInt(tx.meta.fee), moved, "every lamport leaving the vault reached the operator");
    const rentMin = BigInt(await connection.getMinimumBalanceForRentExemption(8 + 1));
    assert.ok(vaultAfter >= rentMin, "the vault keeps its rent");
  });
});
