"use strict";
/**
 * Local-validator acceptance for arena_money_v2 against the compiled SBF.
 *
 * These twenty-one instructions hold competition entry fees, boosts,
 * sponsorship payments and league routing, and before this suite none of them
 * had executed anywhere: no validator, no devnet, no CI. The unit tests cover
 * the arithmetic; this covers whether the money actually moves and whether the
 * state machine refuses what it should.
 *
 * Run after:
 *   solana-test-validator --reset \
 *     --bpf-program 2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX target/deploy/mwz_rewards_treasury.so
 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const anchor = require("@coral-xyz/anchor");
const { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } = require("@solana/web3.js");
const { AnchorProvider, BN, Program, setProvider } = anchor;

const TREASURY_PROGRAM = new PublicKey("2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX");
const CONFIG_SEED = "arena_money_config_v2";
const POOL_SEED = "arena_competition_v2";
const RECEIPT_SEED = "arena_money_entry_v2";
const KIND_BATTLE = 0;
const STATE_RESOLVED = 2;
const STATE_CANCELLED = 3;

const hash32 = (label) => crypto.createHash("sha256").update(label, "utf8").digest();

describe("arena_money_v2 local-validator acceptance", function () {
  this.timeout(600_000);

  let provider;
  let program;
  let connection;
  let authority;
  let config;

  function pda(seed, ...extra) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(seed, "utf8"), ...extra],
      TREASURY_PROGRAM,
    )[0];
  }

  async function fund(keypair, sol = 5) {
    const sig = await connection.requestAirdrop(keypair.publicKey, sol * LAMPORTS_PER_SOL);
    const latest = await connection.getLatestBlockhash("confirmed");
    await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
  }

  before(async function () {
    provider = AnchorProvider.env();
    setProvider(provider);
    connection = provider.connection;
    authority = provider.wallet.publicKey;

    const idlPath = path.resolve(__dirname, "../../target/idl/mwz_rewards_treasury.json");
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
    program = new Program(idl, provider);

    config = pda(CONFIG_SEED);
    const existing = await connection.getAccountInfo(config, "confirmed");
    if (!existing) {
      await program.methods
        .initializeArenaMoneyV2(authority, authority, authority)
        .accountsStrict({ authority, config, systemProgram: SystemProgram.programId })
        .rpc({ commitment: "confirmed" });
    }

    // initialize_arena_money_v2 sets paused = true deliberately: the arena is
    // born switched off and an authority has to turn it on. Tests have to do
    // the same thing an operator would.
    const state = await program.account.arenaMoneyConfigV2.fetch(config);
    if (state.paused) {
      await program.methods
        .setArenaMoneyV2Pause(false)
        .accountsStrict({ authority, config })
        .rpc({ commitment: "confirmed" });
    }
  });

  it("is born paused, so nothing can move money until an authority enables it", async function () {
    // Re-pausing proves the guard is live rather than merely a default, then
    // restores the state the rest of the suite needs.
    await program.methods
      .setArenaMoneyV2Pause(true)
      .accountsStrict({ authority, config })
      .rpc({ commitment: "confirmed" });

    const paused = await program.account.arenaMoneyConfigV2.fetch(config);
    assert.equal(paused.paused, true);

    const competitionId = hash32(`paused:${Date.now()}`);
    const now = Math.floor(Date.now() / 1000);
    await assert.rejects(
      program.methods
        .openCompetitionPoolV2(
          Array.from(competitionId), KIND_BATTLE,
          Keypair.generate().publicKey, Keypair.generate().publicKey,
          Keypair.generate().publicKey, Keypair.generate().publicKey,
          new BN(1_000), new BN(now - 60), new BN(now + 3_600),
        )
        .accountsStrict({
          authority, config, pool: pda(POOL_SEED, competitionId),
          systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" }),
      /Paused/i,
      "a paused arena must refuse to open a pool",
    );

    await program.methods
      .setArenaMoneyV2Pause(false)
      .accountsStrict({ authority, config })
      .rpc({ commitment: "confirmed" });
  });

  /**
   * The core money path. Two entrants pay in, one wins, and the three shares
   * must be claimable for exactly what was deposited.
   */
  it("takes entry fees, resolves a winner and pays out exactly what came in", async function () {
    const competitionId = hash32(`competition:${Date.now()}`);
    const pool = pda(POOL_SEED, competitionId);
    const entryLamports = new BN(0.1 * LAMPORTS_PER_SOL);

    const entrantA = Keypair.generate();
    const entrantB = Keypair.generate();
    await fund(entrantA);
    await fund(entrantB);
    const assetA = Keypair.generate().publicKey;
    const assetB = Keypair.generate().publicKey;

    const now = Math.floor(Date.now() / 1000);
    await program.methods
      .openCompetitionPoolV2(
        Array.from(competitionId), KIND_BATTLE,
        assetA, assetB, entrantA.publicKey, entrantB.publicKey,
        entryLamports, new BN(now - 60), new BN(now + 3_600),
      )
      .accountsStrict({ authority, config, pool, systemProgram: SystemProgram.programId })
      .rpc({ commitment: "confirmed" });

    for (const [entrant, asset] of [[entrantA, assetA], [entrantB, assetB]]) {
      const receipt = pda(RECEIPT_SEED, competitionId, asset.toBuffer(), entrant.publicKey.toBuffer());
      await program.methods
        .depositCompetitionEntryV2(Array.from(competitionId), asset)
        .accountsStrict({
          entrant: entrant.publicKey, config, pool, receipt,
          systemProgram: SystemProgram.programId,
        })
        .signers([entrant])
        .rpc({ commitment: "confirmed" });
    }

    const afterDeposits = await program.account.competitionPoolV2.fetch(pool);
    assert.equal(afterDeposits.entryCount, 2, "both entries must be recorded");
    assert.equal(
      afterDeposits.entryTotalLamports.toString(),
      entryLamports.muln(2).toString(),
      "the pool must hold exactly what was paid in",
    );

    await program.methods
      .resolveCompetitionPoolV2(Array.from(competitionId), assetA, entrantA.publicKey)
      .accountsStrict({
        resolver: authority, config, pool,
        winnerEntryReceipt: pda(RECEIPT_SEED, competitionId, assetA.toBuffer(), entrantA.publicKey.toBuffer()),
      })
      .rpc({ commitment: "confirmed" });

    const resolved = await program.account.competitionPoolV2.fetch(pool);
    assert.equal(resolved.state, STATE_RESOLVED);

    // Nothing may be created or lost between deposit and payout.
    const pending = resolved.pendingWinnerLamports
      .add(resolved.pendingLeagueLamports)
      .add(resolved.pendingProtocolLamports);
    assert.equal(
      pending.toString(),
      resolved.entryTotalLamports.add(resolved.boostGrossLamports).toString(),
      "pending payouts must equal everything the pool took in",
    );

    const before = await connection.getBalance(entrantA.publicKey, "confirmed");
    await program.methods
      .claimCompetitionWinnerV2(Array.from(competitionId))
      .accountsStrict({ winner: entrantA.publicKey, pool })
      .signers([entrantA])
      .rpc({ commitment: "confirmed" });
    const after = await connection.getBalance(entrantA.publicKey, "confirmed");
    assert.equal(
      after - before,
      resolved.pendingWinnerLamports.toNumber(),
      "the winner must receive exactly the recorded prize",
    );
  });

  /** A prize claimed twice would drain the pool past its other obligations. */
  it("refuses a second winner claim", async function () {
    const competitionId = hash32(`double-claim:${Date.now()}`);
    const pool = pda(POOL_SEED, competitionId);
    const entryLamports = new BN(0.05 * LAMPORTS_PER_SOL);
    const entrant = Keypair.generate();
    const opponent = Keypair.generate();
    await fund(entrant);
    await fund(opponent);
    const assetA = Keypair.generate().publicKey;
    const assetB = Keypair.generate().publicKey;
    const now = Math.floor(Date.now() / 1000);

    await program.methods
      .openCompetitionPoolV2(
        Array.from(competitionId), KIND_BATTLE, assetA, assetB,
        entrant.publicKey, opponent.publicKey, entryLamports, new BN(now - 60), new BN(now + 3_600),
      )
      .accountsStrict({ authority, config, pool, systemProgram: SystemProgram.programId })
      .rpc({ commitment: "confirmed" });

    // A battle only becomes LIVE once both sides have paid, so both must enter
    // before the pool can be resolved at all.
    const receipt = pda(RECEIPT_SEED, competitionId, assetA.toBuffer(), entrant.publicKey.toBuffer());
    for (const [who, asset] of [[entrant, assetA], [opponent, assetB]]) {
      await program.methods
        .depositCompetitionEntryV2(Array.from(competitionId), asset)
        .accountsStrict({
          entrant: who.publicKey, config, pool,
          receipt: pda(RECEIPT_SEED, competitionId, asset.toBuffer(), who.publicKey.toBuffer()),
          systemProgram: SystemProgram.programId,
        })
        .signers([who])
        .rpc({ commitment: "confirmed" });
    }

    await program.methods
      .resolveCompetitionPoolV2(Array.from(competitionId), assetA, entrant.publicKey)
      .accountsStrict({ resolver: authority, config, pool, winnerEntryReceipt: receipt })
      .rpc({ commitment: "confirmed" });

    await program.methods
      .claimCompetitionWinnerV2(Array.from(competitionId))
      .accountsStrict({ winner: entrant.publicKey, pool })
      .signers([entrant])
      .rpc({ commitment: "confirmed" });

    await assert.rejects(
      program.methods
        .claimCompetitionWinnerV2(Array.from(competitionId))
        .accountsStrict({ winner: entrant.publicKey, pool })
        .signers([entrant])
        .rpc({ commitment: "confirmed" }),
      /InvalidState|already/i,
      "a second claim must be refused",
    );
  });

  /** A cancelled competition must return entry fees, not keep them. */
  it("refunds entries after a cancellation", async function () {
    const competitionId = hash32(`cancel:${Date.now()}`);
    const pool = pda(POOL_SEED, competitionId);
    const entryLamports = new BN(0.05 * LAMPORTS_PER_SOL);
    const entrant = Keypair.generate();
    await fund(entrant);
    const assetA = Keypair.generate().publicKey;
    const assetB = Keypair.generate().publicKey;
    const now = Math.floor(Date.now() / 1000);

    await program.methods
      .openCompetitionPoolV2(
        Array.from(competitionId), KIND_BATTLE, assetA, assetB,
        entrant.publicKey, Keypair.generate().publicKey,
        entryLamports, new BN(now - 60), new BN(now + 3_600),
      )
      .accountsStrict({ authority, config, pool, systemProgram: SystemProgram.programId })
      .rpc({ commitment: "confirmed" });

    const receipt = pda(RECEIPT_SEED, competitionId, assetA.toBuffer(), entrant.publicKey.toBuffer());
    await program.methods
      .depositCompetitionEntryV2(Array.from(competitionId), assetA)
      .accountsStrict({ entrant: entrant.publicKey, config, pool, receipt, systemProgram: SystemProgram.programId })
      .signers([entrant])
      .rpc({ commitment: "confirmed" });

    await program.methods
      .cancelCompetitionPoolV2(Array.from(competitionId))
      .accountsStrict({ resolver: authority, config, pool })
      .rpc({ commitment: "confirmed" });

    const cancelled = await program.account.competitionPoolV2.fetch(pool);
    assert.equal(cancelled.state, STATE_CANCELLED);

    const before = await connection.getBalance(entrant.publicKey, "confirmed");
    await program.methods
      .refundCompetitionEntryV2(Array.from(competitionId), assetA)
      .accountsStrict({ entrant: entrant.publicKey, pool, receipt })
      .signers([entrant])
      .rpc({ commitment: "confirmed" });
    const after = await connection.getBalance(entrant.publicKey, "confirmed");
    assert.equal(
      after - before,
      entryLamports.toNumber(),
      "a refund must return the entry fee in full",
    );

    await assert.rejects(
      program.methods
        .refundCompetitionEntryV2(Array.from(competitionId), assetA)
        .accountsStrict({ entrant: entrant.publicKey, pool, receipt })
        .signers([entrant])
        .rpc({ commitment: "confirmed" }),
      // The guard is require!(!receipt.refunded, Replay) in the handler, so the
      // error is Replay rather than a receipt or state complaint.
      /Replay/i,
      "a second refund must be refused",
    );
  });

  /** Only a real participant may be declared the winner of a battle. */
  it("refuses a winner who never entered", async function () {
    const competitionId = hash32(`bad-winner:${Date.now()}`);
    const pool = pda(POOL_SEED, competitionId);
    const entrant = Keypair.generate();
    const opponent = Keypair.generate();
    await fund(entrant);
    await fund(opponent);
    const assetA = Keypair.generate().publicKey;
    const assetB = Keypair.generate().publicKey;
    const now = Math.floor(Date.now() / 1000);

    await program.methods
      .openCompetitionPoolV2(
        Array.from(competitionId), KIND_BATTLE, assetA, assetB,
        entrant.publicKey, opponent.publicKey,
        new BN(0.05 * LAMPORTS_PER_SOL), new BN(now - 60), new BN(now + 3_600),
      )
      .accountsStrict({ authority, config, pool, systemProgram: SystemProgram.programId })
      .rpc({ commitment: "confirmed" });

    const receipt = pda(RECEIPT_SEED, competitionId, assetA.toBuffer(), entrant.publicKey.toBuffer());
    for (const [who, asset] of [[entrant, assetA], [opponent, assetB]]) {
      await program.methods
        .depositCompetitionEntryV2(Array.from(competitionId), asset)
        .accountsStrict({
          entrant: who.publicKey, config, pool,
          receipt: pda(RECEIPT_SEED, competitionId, asset.toBuffer(), who.publicKey.toBuffer()),
          systemProgram: SystemProgram.programId,
        })
        .signers([who])
        .rpc({ commitment: "confirmed" });
    }

    const stranger = Keypair.generate().publicKey;
    await assert.rejects(
      program.methods
        .resolveCompetitionPoolV2(Array.from(competitionId), Keypair.generate().publicKey, stranger)
        .accountsStrict({ resolver: authority, config, pool, winnerEntryReceipt: receipt })
        .rpc({ commitment: "confirmed" }),
      /InvalidWinner/i,
      "a non-participant must not be payable",
    );
  });
});
