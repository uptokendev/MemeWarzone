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
const hash32 = (label) => require("node:crypto").createHash("sha256").update(label, "utf8").digest();

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
    assert.match(text, pattern, `${label}: failed for the wrong reason -- got: ${text.slice(0, 400)}`);
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
      mwlVault: pda("mwl_vault"),
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

  it("no longer carries the retired V1 arena and lane instructions", function () {
    // Anchor's client camel-cases instruction names; compare on snake_case.
    const snake = (name) => String(name).replace(/([A-Z])/g, (m) => `_${m.toLowerCase()}`).replace(/^_/, "");
    const names = new Set(program.idl.instructions.map((ix) => snake(ix.name)));
    for (const retired of ["initialize_lanes", "open_battle_pool", "open_tournament_pool", "deposit_stake", "donate_support", "deposit_buy_in", "resolve_pool", "refund_buy_in"]) {
      assert.ok(!names.has(retired), `${retired} must be gone from the IDL`);
    }
    for (const live of ["open_battle_pool_v2", "deposit_stake_v2", "resolve_pool_v2", "resolve_pool_places_v2", "claim_place_v2", "flush_operator_fill"]) {
      assert.ok(names.has(live), `${live} must be in the IDL`);
    }
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

  it("airdrop via reward poster: a narrow key posts one capped weekly batch; claims unchanged", async function () {
    // The weekly airdrop runs unattended on our server with this key instead of the rewards
    // authority (programs/mwz_rewards_treasury/src/reward_poster.rs).
    const poster = Keypair.generate();
    const stranger = Keypair.generate();
    await fund(poster.publicKey, 2);
    await fund(stranger.publicKey, 2);
    const rewardPoster = pda("reward_poster");
    const cap = 300_000_000n;

    await expectFail(
      program.methods.initializeRewardPoster(poster.publicKey, new BN(cap.toString()), new BN(cap.toString()))
        .accountsStrict({ authority: stranger.publicKey, config: pdas.config, rewardPoster, systemProgram: SystemProgram.programId })
        .signers([stranger]).rpc({ commitment: "confirmed" }),
      /ConstraintHasOne|has_one|custom program error|0x7d1/i,
      "only the authority creates the poster role",
    );
    await program.methods.initializeRewardPoster(poster.publicKey, new BN(cap.toString()), new BN(cap.toString()))
      .accountsStrict({ authority, config: pdas.config, rewardPoster, systemProgram: SystemProgram.programId })
      .rpc({ commitment: "confirmed" });
    await program.methods.depositAirdrop(new BN(LAMPORTS_PER_SOL))
      .accountsStrict({ payer: authority, airdropVault: pdas.airdropVault, systemProgram: SystemProgram.programId })
      .rpc({ commitment: "confirmed" });

    const epochId = 70;
    const amounts = [120_000_000n, 80_000_000n];
    const total = amounts.reduce((a, b) => a + b, 0n);
    const leaves = amounts.map((amount, i) => airdropLeaf({ epochId, programCode: AIRDROP_PROGRAM_TRADER, winner: winners[i].publicKey, amount }));
    const root = buildRoot(leaves);
    const now = Math.floor(Date.now() / 1000);
    const post = (id, rootBytes, amount, deadline, signer = poster) => program.methods
      .postAirdropBatchRoot(new BN(id), arr32(rootBytes), new BN(amount.toString()), new BN(deadline))
      .accountsStrict({
        poster: signer.publicKey, config: pdas.config, rewardPoster, airdropVault: pdas.airdropVault,
        airdropBatch: pda("airdrop_batch", i64le(id)), systemProgram: SystemProgram.programId,
      })
      .signers([signer])
      .rpc({ commitment: "confirmed" });

    await expectFail(post(epochId, root, total, now + 3600, stranger), /PosterNotAuthorized|custom program error/i, "a non-poster cannot post");
    await expectFail(post(epochId, root, cap + 1n, now + 3600), /PosterBatchAboveCap|custom program error/i, "above the authority's cap");
    await expectFail(post(epochId, root, total, now + 91 * 86400), /PosterBadDeadline|custom program error/i, "claim window beyond 90 days");
    await post(epochId, root, total, now + 3600);

    const batch = await program.account.airdropBatch.fetch(pda("airdrop_batch", i64le(epochId)));
    assert.equal(BigInt(batch.totalLamports.toString()), total);
    assert.ok((await program.account.rewardPoster.fetch(rewardPoster)).lastAirdropPostAt.toNumber() > 0, "post time recorded");

    // Claims are exactly the authority path's: proof, once, from the airdrop vault.
    const claim = (i) => program.methods
      .claimAirdrop(new BN(epochId), AIRDROP_PROGRAM_TRADER, new BN(amounts[i].toString()), proofArg(buildProof(leaves, i)))
      .accountsStrict({
        winner: winners[i].publicKey, config: pdas.config, airdropVault: pdas.airdropVault,
        airdropBatch: pda("airdrop_batch", i64le(epochId)),
        airdropReceipt: pda("airdrop_claim", i64le(epochId), Buffer.from([AIRDROP_PROGRAM_TRADER]), winners[i].publicKey.toBuffer()),
        systemProgram: SystemProgram.programId,
      })
      .signers([winners[i]])
      .rpc({ commitment: "confirmed" });
    const vaultBefore = await lamports(pdas.airdropVault);
    await claim(0);
    await claim(1);
    assert.equal(vaultBefore - (await lamports(pdas.airdropVault)), total, "the vault pays exactly the posted leaves");

    const nextLeaves = [airdropLeaf({ epochId: 71, programCode: AIRDROP_PROGRAM_TRADER, winner: winners[2].publicKey, amount: 1_000_000n })];
    await expectFail(post(71, buildRoot(nextLeaves), 1_000_000n, now + 3600), /PosterTooSoon|custom program error/i, "a second post within six days");

    // Revoking the role stops the key at once.
    await program.methods.setRewardPoster(PublicKey.default, new BN(cap.toString()), new BN(cap.toString()))
      .accountsStrict({ authority, config: pdas.config, rewardPoster })
      .rpc({ commitment: "confirmed" });
    await expectFail(post(72, buildRoot(nextLeaves), 1_000_000n, now + 3600), /PosterNotAuthorized|custom program error/i, "a revoked poster");
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
    // overflow_treasury still points at the vault itself (mainnet's state until
    // set_route_params): the remainder above the cap stays put.
    const sig = await program.methods.flushOperatorFill()
      .accountsStrict({ operator: authority, routeState: pdas.routeState, protocolVault: pdas.protocolVault, overflowTreasury: pdas.protocolVault })
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

  it("operator fill: above the USD cap everything leaves to the overflow treasury (the multisig)", async function () {
    const overflow = Keypair.generate();
    await fund(overflow.publicKey, 1);
    const route = await program.account.routeState.fetch(pdas.routeState);
    // Cap at what is already filled: nothing more to the operator, all to overflow.
    await program.methods.setRouteParams(authority, overflow.publicKey, route.operatorFilledUsdMicros.isZero() ? new BN(1) : route.operatorFilledUsdMicros, route.nativeUsdMicros)
      .accountsStrict({ authority, config: pdas.config, routeState: pdas.routeState })
      .rpc({ commitment: "confirmed" });
    await transferTo(pdas.protocolVault, LAMPORTS_PER_SOL);
    const rentMin = BigInt(await connection.getMinimumBalanceForRentExemption(8 + 1));
    const vaultBefore = await lamports(pdas.protocolVault);
    const operatorBefore = await lamports(authority);
    const overflowBefore = await lamports(overflow.publicKey);
    await expectFail(
      program.methods.flushOperatorFill()
        .accountsStrict({ operator: authority, routeState: pdas.routeState, protocolVault: pdas.protocolVault, overflowTreasury: pdas.protocolVault })
        .rpc({ commitment: "confirmed" }),
      /InvalidOverflowTreasury|ConstraintAddress|custom program error|0x7d1/i, "flush with the wrong overflow account",
    );
    const sig = await program.methods.flushOperatorFill()
      .accountsStrict({ operator: authority, routeState: pdas.routeState, protocolVault: pdas.protocolVault, overflowTreasury: overflow.publicKey })
      .rpc({ commitment: "confirmed" });
    const tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const vaultAfter = await lamports(pdas.protocolVault);
    assert.equal(vaultAfter, rentMin, "the vault is drained to its rent");
    assert.equal((await lamports(overflow.publicKey)) - overflowBefore, vaultBefore - rentMin, "the overflow treasury received everything above rent");
    assert.equal((await lamports(authority)) - operatorBefore, -BigInt(tx.meta.fee), "the capped operator received nothing more");
  });

  it("league: pre-grad weekly/monthly and the Major War League pay from three separate vaults", async function () {
    // Two competitions (founder, 2026-09-26): pre-grad weekly (0) from league_vault, pre-grad monthly
    // (1) from monthly_league_vault; Major War League quarterly finals (2) and MWL monthly (3) from
    // mwl_vault, fed by the arena's 20% share. Until 2026-09-25 every round paid from league_vault.
    const PERIOD_QUARTERLY = 2;
    const PERIOD_MWL_MONTHLY = 3;
    if (!(await connection.getAccountInfo(pdas.mwlVault, "confirmed"))) {
      await program.methods.initializeMwlVault()
        .accountsStrict({ authority, config: pdas.config, mwlVault: pdas.mwlVault, systemProgram: SystemProgram.programId })
        .rpc({ commitment: "confirmed" });
    }
    const epochStart = Math.floor(Date.now() / 1000) - 90 * 24 * 3600;
    const categoryHash = keccak(Buffer.from("quarterly_finals", "utf8"));
    const prize = 100_000_000n;
    await transferTo(pdas.mwlVault, prize * 2n);

    for (const period of [PERIOD_QUARTERLY, PERIOD_MWL_MONTHLY]) {
      const winner = period === PERIOD_QUARTERLY ? winners[1] : winners[0];
      const leaves = [leagueLeaf({ epochStart, period, categoryHash, rank: 1, winner: winner.publicKey, amount: prize })];
      const root = buildRoot(leaves);
      const leagueEpoch = pda("league_epoch", Buffer.from([period]), i64le(epochStart));
      for (const wrong of [pdas.leagueVault, pdas.monthlyLeagueVault]) {
        await expectFail(
          program.methods.setLeagueEpochRoot(period, new BN(epochStart), arr32(root), new BN(prize.toString()))
            .accountsStrict({ authority, config: pdas.config, leagueVault: wrong, leagueEpoch, systemProgram: SystemProgram.programId })
            .rpc({ commitment: "confirmed" }),
          /WrongLeagueVault|custom program error/i, `MWL round ${period} against a pre-grad vault`,
        );
      }
      await program.methods.setLeagueEpochRoot(period, new BN(epochStart), arr32(root), new BN(prize.toString()))
        .accountsStrict({ authority, config: pdas.config, leagueVault: pdas.mwlVault, leagueEpoch, systemProgram: SystemProgram.programId })
        .rpc({ commitment: "confirmed" });
      const claim = (vault) => program.methods
        .claimLeague(period, new BN(epochStart), arr32(categoryHash), 1, new BN(prize.toString()), proofArg(buildProof(leaves, 0)))
        .accountsStrict({
          winner: winner.publicKey, config: pdas.config, leagueVault: vault, leagueEpoch,
          claimReceipt: pda("league_claim", Buffer.from([period]), i64le(epochStart), categoryHash, Buffer.from([1])),
          systemProgram: SystemProgram.programId,
        })
        .signers([winner])
        .rpc({ commitment: "confirmed" });
      await expectFail(claim(pdas.monthlyLeagueVault), /WrongLeagueVault|custom program error/i, `MWL round ${period} paid from the pre-grad monthly vault`);
      const weeklyBefore = await lamports(pdas.leagueVault);
      const monthlyBefore = await lamports(pdas.monthlyLeagueVault);
      const mwlBefore = await lamports(pdas.mwlVault);
      await claim(pdas.mwlVault);
      assert.equal(mwlBefore - (await lamports(pdas.mwlVault)), prize, `MWL round ${period} is paid from the MWL vault`);
      assert.equal(await lamports(pdas.leagueVault), weeklyBefore, "the pre-grad weekly vault is untouched");
      assert.equal(await lamports(pdas.monthlyLeagueVault), monthlyBefore, "the pre-grad monthly vault is untouched");
    }

    const root = buildRoot([leagueLeaf({ epochStart, period: 4, categoryHash, rank: 1, winners: winners[0].publicKey, winner: winners[0].publicKey, amount: prize })]);
    await expectFail(
      program.methods.setLeagueEpochRoot(4, new BN(epochStart), arr32(root), new BN(prize.toString()))
        .accountsStrict({ authority, config: pdas.config, leagueVault: pdas.mwlVault, leagueEpoch: pda("league_epoch", Buffer.from([4]), i64le(epochStart)), systemProgram: SystemProgram.programId })
        .rpc({ commitment: "confirmed" }),
      /InvalidPeriod|custom program error/i, "period 4",
    );
  });

  it("league via reward poster: capped roots per period, right vault, never overwriting", async function () {
    const poster = Keypair.generate();
    await fund(poster.publicKey, 2);
    const rewardPoster = pda("reward_poster");
    // The airdrop test created the role and then revoked it; re-arm it for this poster.
    await program.methods.setRewardPoster(poster.publicKey, new BN(300_000_000), new BN(200_000_000))
      .accountsStrict({ authority, config: pdas.config, rewardPoster })
      .rpc({ commitment: "confirmed" });
    const PERIOD_MONTHLY = 1;
    const now = Math.floor(Date.now() / 1000);
    const monthStart = now - 35 * 24 * 3600;
    const categoryHash = keccak(Buffer.from("monthly_top", "utf8"));
    const prize = 60_000_000n;
    const leaves = [leagueLeaf({ epochStart: monthStart, period: PERIOD_MONTHLY, categoryHash, rank: 1, winner: winners[2].publicKey, amount: prize })];
    const root = buildRoot(leaves);
    await transferTo(pdas.monthlyLeagueVault, prize);
    const epochFor = (period, start) => pda("league_epoch", Buffer.from([period]), i64le(start));
    const post = (period, start, rootBytes, amount, vault) => program.methods
      .postLeagueEpochRoot(period, new BN(start), arr32(rootBytes), new BN(amount.toString()))
      .accountsStrict({ poster: poster.publicKey, config: pdas.config, rewardPoster, leagueVault: vault, leagueEpoch: epochFor(period, start), systemProgram: SystemProgram.programId })
      .signers([poster])
      .rpc({ commitment: "confirmed" });

    await expectFail(post(PERIOD_MONTHLY, monthStart, root, prize, pdas.leagueVault), /WrongLeagueVault|custom program error/i, "monthly root on the weekly vault");
    await expectFail(post(PERIOD_MONTHLY, monthStart, root, 200_000_001n, pdas.monthlyLeagueVault), /PosterBatchAboveCap|custom program error/i, "above the league cap");
    await expectFail(post(PERIOD_MONTHLY, now + 3600, root, prize, pdas.monthlyLeagueVault), /PosterBadEpochStart|custom program error/i, "an epoch that has not started");
    await post(PERIOD_MONTHLY, monthStart, root, prize, pdas.monthlyLeagueVault);
    await expectFail(post(PERIOD_MONTHLY, monthStart - 86400, root, prize, pdas.monthlyLeagueVault), /PosterTooSoon|custom program error/i, "a second monthly root within 25 days");

    // A weekly root has its own rhythm and its own vault.
    const weekStart = now - 7 * 24 * 3600;
    const weekLeaves = [leagueLeaf({ epochStart: weekStart, period: PERIOD_WEEKLY, categoryHash, rank: 1, winner: winners[0].publicKey, amount: 1_000_000n })];
    await program.methods.depositLeague(new BN(1_000_000))
      .accountsStrict({ payer: authority, leagueVault: pdas.leagueVault, systemProgram: SystemProgram.programId })
      .rpc({ commitment: "confirmed" });
    await post(PERIOD_WEEKLY, weekStart, buildRoot(weekLeaves), 1_000_000n, pdas.leagueVault);

    const monthlyBefore = await lamports(pdas.monthlyLeagueVault);
    await program.methods
      .claimLeague(PERIOD_MONTHLY, new BN(monthStart), arr32(categoryHash), 1, new BN(prize.toString()), proofArg(buildProof(leaves, 0)))
      .accountsStrict({
        winner: winners[2].publicKey, config: pdas.config, leagueVault: pdas.monthlyLeagueVault, leagueEpoch: epochFor(PERIOD_MONTHLY, monthStart),
        claimReceipt: pda("league_claim", Buffer.from([PERIOD_MONTHLY]), i64le(monthStart), categoryHash, Buffer.from([1])),
        systemProgram: SystemProgram.programId,
      })
      .signers([winners[2]])
      .rpc({ commitment: "confirmed" });
    assert.equal(monthlyBefore - (await lamports(pdas.monthlyLeagueVault)), prize, "the poster-posted monthly prize pays from the monthly vault");
  });

  it("sponsorship: a paid event splits 70/20/10 and each of the three buckets is claimed by exactly the right wallet", async function () {
    // The whole sponsorship rail had never executed -- eight instructions with
    // nothing but unit tests of the arithmetic behind them. It is also the one
    // subsystem that is entirely self-contained: arena.rs never reads the money
    // v2 config, so battles cannot be affected by anything proven here.
    const marketingReceiver = Keypair.generate();
    const protocolReceiver = Keypair.generate();
    const eventReceiver = Keypair.generate();
    const sponsor = Keypair.generate();
    await fund(sponsor.publicKey, 5);
    await fund(eventReceiver.publicKey, 1);
    for (const k of [marketingReceiver, protocolReceiver]) await transferTo(k.publicKey, 2_000_000n);

    const config = pda("arena_money_config_v2");
    if (!(await connection.getAccountInfo(config, "confirmed"))) {
      await program.methods.initializeArenaMoneyV2(authority, protocolReceiver.publicKey, marketingReceiver.publicKey)
        .accountsStrict({ authority, config, systemProgram: SystemProgram.programId })
        .rpc({ commitment: "confirmed" });
    } else {
      await program.methods.setArenaMoneyV2Receivers(authority, protocolReceiver.publicKey, marketingReceiver.publicKey)
        .accountsStrict({ authority, config }).rpc({ commitment: "confirmed" });
    }

    const eventId = hash32(`sponsorship:${Date.now()}`);
    const event = pda("arena_sponsor_event_v1", eventId);
    const vault = pda("arena_event_prize_v1", eventId);
    const minimum = 100_000_000n;
    await program.methods.initializeSponsorshipEventV1(Array.from(eventId), eventReceiver.publicKey, new BN(minimum.toString()))
      .accountsStrict({ authority, config, event, vault, systemProgram: SystemProgram.programId })
      .rpc({ commitment: "confirmed" });

    // The rail is born paused -- initialize_arena_money_v2 sets paused = true --
    // so standing it up on a cluster takes money nowhere until someone
    // deliberately opens it. Pin that: it is the difference between a
    // half-finished deployment being inert and it quietly accepting funds.
    const tooSmall = hash32(`payment-small:${Date.now()}`);
    assert.equal((await program.account.arenaMoneyConfigV2.fetch(config)).paused, true, "money v2 is born paused");
    await expectFail(
      program.methods.paySponsorshipV1(Array.from(eventId), Array.from(tooSmall), new BN("1000000000"))
        .accountsStrict({ sponsor: sponsor.publicKey, config, event, vault, receipt: pda("arena_sponsor_receipt_v1", eventId, tooSmall, sponsor.publicKey.toBuffer()), systemProgram: SystemProgram.programId })
        .signers([sponsor]).rpc({ commitment: "confirmed" }),
      /Paused/i, "a payment before the rail is opened",
    );
    await program.methods.setArenaMoneyV2Pause(false).accountsStrict({ authority, config }).rpc({ commitment: "confirmed" });

    // A payment under the event's floor is refused, so an event cannot be
    // cluttered with dust that still costs a receipt account.
    await expectFail(
      program.methods.paySponsorshipV1(Array.from(eventId), Array.from(tooSmall), new BN((minimum - 1n).toString()))
        .accountsStrict({ sponsor: sponsor.publicKey, config, event, vault, receipt: pda("arena_sponsor_receipt_v1", eventId, tooSmall, sponsor.publicKey.toBuffer()), systemProgram: SystemProgram.programId })
        .signers([sponsor]).rpc({ commitment: "confirmed" }),
      /SponsorshipBelowMinimum/i, "a payment under the event minimum",
    );

    const gross = 1_000_000_000n;
    const paymentId = hash32(`payment:${Date.now()}`);
    const receipt = pda("arena_sponsor_receipt_v1", eventId, paymentId, sponsor.publicKey.toBuffer());
    await program.methods.paySponsorshipV1(Array.from(eventId), Array.from(paymentId), new BN(gross.toString()))
      .accountsStrict({ sponsor: sponsor.publicKey, config, event, vault, receipt, systemProgram: SystemProgram.programId })
      .signers([sponsor]).rpc({ commitment: "confirmed" });

    const prize = (gross * 7_000n) / 10_000n;
    const marketing = (gross * 2_000n) / 10_000n;
    const protocol = gross - prize - marketing;
    const vaultState = await program.account.eventPrizeVaultV1.fetch(vault);
    assert.equal(BigInt(vaultState.prizeLamports.toString()), prize, "70% is held for the event prize");
    assert.equal(BigInt(vaultState.marketingLamports.toString()), marketing, "20% is held for marketing");
    assert.equal(BigInt(vaultState.protocolLamports.toString()), protocol, "the remainder, 10%, is the protocol's");
    assert.equal(prize + marketing + protocol, gross, "the split conserves every lamport of the payment");

    // Each bucket is bound to one wallet. A stranger cannot redirect any of
    // them, and the two operator buckets are address-constrained to the config.
    const stranger = Keypair.generate();
    await fund(stranger.publicKey, 1);
    await expectFail(
      program.methods.claimEventPrizeV1(Array.from(eventId))
        .accountsStrict({ receiver: stranger.publicKey, event, vault }).signers([stranger]).rpc({ commitment: "confirmed" }),
      /Unauthorized/i, "a stranger claiming the event prize",
    );
    await expectFail(
      program.methods.claimSponsorshipMarketingV1(Array.from(eventId))
        .accountsStrict({ caller: authority, config, receiver: stranger.publicKey, vault }).rpc({ commitment: "confirmed" }),
      /ConstraintAddress|Unauthorized|custom program error/i, "marketing paid to the wrong wallet",
    );

    for (const [label, expected, wallet, build] of [
      ["event prize", prize, eventReceiver.publicKey, () => program.methods.claimEventPrizeV1(Array.from(eventId))
        .accountsStrict({ receiver: eventReceiver.publicKey, event, vault }).signers([eventReceiver])],
      ["marketing", marketing, marketingReceiver.publicKey, () => program.methods.claimSponsorshipMarketingV1(Array.from(eventId))
        .accountsStrict({ caller: authority, config, receiver: marketingReceiver.publicKey, vault })],
      ["protocol", protocol, protocolReceiver.publicKey, () => program.methods.claimSponsorshipProtocolV1(Array.from(eventId))
        .accountsStrict({ caller: authority, config, receiver: protocolReceiver.publicKey, vault })],
    ]) {
      const before = await lamports(wallet);
      await build().rpc({ commitment: "confirmed" });
      const delta = (await lamports(wallet)) - before;
      // The event receiver signs its own claim and therefore pays the fee.
      assert.ok(delta === expected || (expected - delta) < 20_000n, `${label}: pays its receiver ${expected}, saw ${delta}`);
      await expectFail(build().rpc({ commitment: "confirmed" }), /NothingToClaim/i, `${label}: second claim`);
    }

    const drained = await program.account.eventPrizeVaultV1.fetch(vault);
    assert.equal(BigInt(drained.prizeLamports.toString()), 0n);
    assert.equal(BigInt(drained.marketingLamports.toString()), 0n);
    assert.equal(BigInt(drained.protocolLamports.toString()), 0n);
    assert.equal(
      BigInt(drained.prizeClaimedLamports.toString()) + BigInt(drained.marketingClaimedLamports.toString()) + BigInt(drained.protocolClaimedLamports.toString()),
      gross,
      "everything the sponsor paid has been claimed by someone",
    );

    // Paused, the rail takes no more money.
    await program.methods.setArenaMoneyV2Pause(true).accountsStrict({ authority, config }).rpc({ commitment: "confirmed" });
    const afterPause = hash32(`payment-paused:${Date.now()}`);
    await expectFail(
      program.methods.paySponsorshipV1(Array.from(eventId), Array.from(afterPause), new BN(gross.toString()))
        .accountsStrict({ sponsor: sponsor.publicKey, config, event, vault, receipt: pda("arena_sponsor_receipt_v1", eventId, afterPause, sponsor.publicKey.toBuffer()), systemProgram: SystemProgram.programId })
        .signers([sponsor]).rpc({ commitment: "confirmed" }),
      /Paused/i, "a payment while the rail is paused",
    );
    await program.methods.setArenaMoneyV2Pause(false).accountsStrict({ authority, config }).rpc({ commitment: "confirmed" });
  });
});
