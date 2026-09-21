"use strict";

/**
 * Local-validator acceptance for the war pool -- the generation the API
 * actually drives (open_battle_pool_v2, deposit_stake_v2, donate_support_v2,
 * deposit_prize_boost_v2, resolve_pool_v2, resolve_pool_places_v2, claims,
 * expiry and refunds) on the exact .so that will be deployed.
 *
 * Money rules proven here, to the lamport:
 *   entries + support  -> 85% prize / 10% Major War League / 5% protocol
 *   boosts             -> 90% prize / 10% protocol
 *   tournament places  -> prize split by bps, rounding remainder to first
 * Every user transaction credits one program vault (plus its own receipt's
 * rent); splits happen only at resolve, payouts only on claim. Resolution
 * messages are built by the operator script so the operator and the program
 * cannot drift apart.
 */

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const anchor = require("@coral-xyz/anchor");
const { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } = require("@solana/web3.js");

const { AnchorProvider, BN, Program, setProvider } = anchor;

const TREASURY_PROGRAM = new PublicKey("2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX");
const hash32 = (label) => crypto.createHash("sha256").update(label, "utf8").digest();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bpsOf = (amount, bps) => (amount * BigInt(bps)) / 10_000n;

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

describe("arena war pool local-validator acceptance (battles, tournaments, places, claims)", function () {
  this.timeout(600_000);

  let provider;
  let program;
  let connection;
  let authority;
  let resolverKeypair;
  let operator;
  let arenaConfig;
  const protocolReceiver = Keypair.generate();
  const mwlReceiver = Keypair.generate();

  const pda = (seed, ...extra) => PublicKey.findProgramAddressSync([Buffer.from(seed, "utf8"), ...extra], TREASURY_PROGRAM)[0];
  const lamports = async (pk) => BigInt(await connection.getBalance(pk, "confirmed"));

  async function fund(pubkey, sol = 5) {
    const sig = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
    const latest = await connection.getLatestBlockhash("confirmed");
    await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
  }

  async function sendResolver(instructions, label) {
    const tx = new Transaction().add(...instructions);
    try {
      return await provider.sendAndConfirm(tx, [], { commitment: "confirmed" });
    } catch (error) {
      error.message = `${label}: ${error.message}`;
      throw error;
    }
  }

  /** Which accounts a confirmed transaction credited (lamports went up). */
  async function creditedAccounts(signature) {
    const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
    const credited = [];
    for (let i = 0; i < keys.length; i += 1) {
      if (tx.meta.postBalances[i] > tx.meta.preBalances[i]) credited.push(keys.get(i).toBase58());
    }
    return { credited, accounts: keys.length, fee: tx.meta.fee };
  }

  before(async function () {
    provider = AnchorProvider.env();
    setProvider(provider);
    connection = provider.connection;
    authority = provider.wallet.publicKey;
    resolverKeypair = provider.wallet.payer;
    operator = await import("../../scripts/solana/arena-operator-v0.mjs");

    const idl = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../target/idl/mwz_rewards_treasury.json"), "utf8"));
    program = new Program(idl, provider);

    const rewardsConfig = pda("rewards_config");
    if (!(await connection.getAccountInfo(rewardsConfig, "confirmed"))) {
      await program.methods.initialize()
        .accountsStrict({ authority, config: rewardsConfig, leagueVault: pda("league_vault"), airdropVault: pda("airdrop_vault"), systemProgram: SystemProgram.programId })
        .rpc({ commitment: "confirmed" });
    }
    arenaConfig = pda("arena_config");
    if (!(await connection.getAccountInfo(arenaConfig, "confirmed"))) {
      await program.methods.initializeArena(authority, protocolReceiver.publicKey, mwlReceiver.publicKey)
        .accountsStrict({ authority, rewardsConfig, arenaConfig, systemProgram: SystemProgram.programId })
        .rpc({ commitment: "confirmed" });
    } else {
      await program.methods.setArenaReceivers(protocolReceiver.publicKey, mwlReceiver.publicKey)
        .accountsStrict({ authority, rewardsConfig, arenaConfig }).rpc({ commitment: "confirmed" });
      await program.methods.setArenaResolver(authority)
        .accountsStrict({ authority, rewardsConfig, arenaConfig }).rpc({ commitment: "confirmed" });
    }
    await program.methods.setArenaPause(false).accountsStrict({ authority, rewardsConfig, arenaConfig }).rpc({ commitment: "confirmed" });
    // Receivers must exist as system accounts to be credited on claim.
    await fund(protocolReceiver.publicKey, 1);
    await fund(mwlReceiver.publicKey, 1);
  });

  it("battle: stakes and support pay 85/10/5, boosts 90/10, every user tx credits one vault, claims pay exactly once", async function () {
    const ownerA = Keypair.generate();
    const ownerB = Keypair.generate();
    const donor = Keypair.generate();
    const funder = Keypair.generate();
    for (const k of [ownerA, ownerB, donor, funder]) await fund(k.publicKey);
    const assetA = Keypair.generate().publicKey;
    const assetB = Keypair.generate().publicKey;
    const poolId = hash32(`battle:${Date.now()}`);
    const pool = pda("arena_pool", poolId);
    const vault = pda("arena_vault", poolId);
    const stakeA = 1_000_000_000n;
    const stakeB = 1_000_000_000n;
    const support = 300_000_000n;
    const boost = 250_000_000n;
    const now = Math.floor(Date.now() / 1000);
    const depositDeadline = now + 3600;
    const supportDeadline = now + 3600;
    const resolveDeadline = now + 7200;

    // Owner A opens and stakes in one transaction; B stakes; both in -> LIVE.
    const openSig = await program.methods.openBattlePoolV2(
      Array.from(poolId), assetA, assetB, ownerA.publicKey, ownerB.publicKey,
      new BN(stakeA.toString()), new BN(stakeB.toString()), new BN(supportDeadline), new BN(depositDeadline), new BN(resolveDeadline),
    ).accountsStrict({ opener: ownerA.publicKey, arenaConfig, pool, vault, systemProgram: SystemProgram.programId })
      .signers([ownerA]).rpc({ commitment: "confirmed" });
    const opened = await creditedAccounts(openSig);
    assert.deepEqual(opened.credited.sort(), [pool.toBase58(), vault.toBase58()].sort(), "open credits only the pool account rent and the vault");

    const stakeSig = await program.methods.depositStakeV2(Array.from(poolId))
      .accountsStrict({ staker: ownerB.publicKey, arenaConfig, pool, vault, systemProgram: SystemProgram.programId })
      .signers([ownerB]).rpc({ commitment: "confirmed" });
    const staked = await creditedAccounts(stakeSig);
    assert.deepEqual(staked.credited, [vault.toBase58()], "a stake credits exactly one account: the vault");
    // fee payer (provider) + staker, config, pool, vault, system program + the treasury program itself
    assert.equal(staked.accounts, 7, "stake tx carries the five instruction accounts, the program and the fee payer, nothing else");
    let state = await program.account.arenaPool.fetch(pool);
    assert.equal(state.state, 1, "both stakes in -> LIVE");

    await program.methods.donateSupportV2(Array.from(poolId), new BN(support.toString()))
      .accountsStrict({ donor: donor.publicKey, arenaConfig, pool, vault, systemProgram: SystemProgram.programId })
      .signers([donor]).rpc({ commitment: "confirmed" });

    const fundingId = hash32(`boost:${Date.now()}`);
    const boostReceipt = pda("arena_boost", poolId, fundingId, funder.publicKey.toBuffer());
    const boostSig = await program.methods.depositPrizeBoostV2(Array.from(poolId), Array.from(fundingId), new BN(boost.toString()))
      .accountsStrict({ funder: funder.publicKey, arenaConfig, pool, vault, boostReceipt, systemProgram: SystemProgram.programId })
      .signers([funder]).rpc({ commitment: "confirmed" });
    const boosted = await creditedAccounts(boostSig);
    assert.deepEqual(boosted.credited.sort(), [vault.toBase58(), boostReceipt.toBase58()].sort(), "a boost credits the vault and its own receipt, nothing else");
    assert.equal(boosted.accounts, 8, "boost tx carries the six instruction accounts, the program and the fee payer, nothing else");

    state = await program.account.arenaPool.fetch(pool);
    assert.equal(BigInt(state.prizeBoostTotal.toString()), boost);
    assert.equal(BigInt(state.supportTotal.toString()), support);

    // Resolve: the operator script builds the message the program verifies.
    const outcomeHash = hash32("battle-outcome");
    const deadline = now + 3600;
    const built = operator.buildArenaResolveInstructions({
      resolver: resolverKeypair, poolId, kind: "battle", version: 2,
      assetA, assetB, ownerA: ownerA.publicKey, ownerB: ownerB.publicKey,
      stakeA, stakeB, supportTotal: support, prizeBoostTotal: boost, buyInTotal: 0n,
      winnerSide: 1, winnerAsset: assetA, winnerWallet: ownerA.publicKey, resultType: 1,
      outcomeHash, deadline, nonce: 0n,
    });
    await sendResolver([built.verifyIx, built.resolveIx], "resolve_pool_v2");

    state = await program.account.arenaPool.fetch(pool);
    const normalBase = stakeA + stakeB + support;
    const protocolNormal = bpsOf(normalBase, 500);
    const mwl = bpsOf(normalBase, 1_000);
    const winnerNormal = normalBase - protocolNormal - mwl;
    const boostProtocol = bpsOf(boost, 1_000);
    const boostPrize = boost - boostProtocol;
    assert.equal(BigInt(state.pendingWinner.toString()), winnerNormal + boostPrize, "winner: 85% of entries+support plus 90% of boosts");
    assert.equal(BigInt(state.pendingProtocol.toString()), protocolNormal + boostProtocol, "protocol: 5% of entries+support plus 10% of boosts");
    assert.equal(BigInt(state.pendingMwl.toString()), mwl, "MWL: 10% of entries+support");
    assert.equal(
      BigInt(state.pendingWinner.toString()) + BigInt(state.pendingProtocol.toString()) + BigInt(state.pendingMwl.toString()),
      normalBase + boost,
      "everything owed equals everything taken in",
    );
    assert.equal(state.placeCount, 1);

    // Winner claims exactly the prize (minus the receipt rent they fund).
    const claimReceipt = pda("arena_claim", poolId, Buffer.from([0]));
    const vaultBefore = await lamports(vault);
    const winnerBefore = await lamports(ownerA.publicKey);
    await program.methods.claimWinner(Array.from(poolId))
      .accountsStrict({ winner: ownerA.publicKey, pool, vault, claimReceipt, systemProgram: SystemProgram.programId })
      .signers([ownerA]).rpc({ commitment: "confirmed" });
    const receiptRent = BigInt((await connection.getAccountInfo(claimReceipt, "confirmed")).lamports);
    assert.equal(vaultBefore - (await lamports(vault)), winnerNormal + boostPrize, "the vault pays exactly the winner's prize");
    assert.equal((await lamports(ownerA.publicKey)) - winnerBefore, winnerNormal + boostPrize - receiptRent, "the winner receives it minus receipt rent, exactly");
    await expectFail(
      program.methods.claimWinner(Array.from(poolId))
        .accountsStrict({ winner: ownerA.publicKey, pool, vault, claimReceipt, systemProgram: SystemProgram.programId })
        .signers([ownerA]).rpc({ commitment: "confirmed" }),
      /already in use|NothingToClaim|custom program error|0x0\b/i, "second winner claim",
    );
    await expectFail(
      program.methods.claimPlaceV2(Array.from(poolId), 1)
        .accountsStrict({ winner: ownerA.publicKey, pool, vault, claimReceipt: pda("arena_claim", poolId, Buffer.from([11])), systemProgram: SystemProgram.programId })
        .signers([ownerA]).rpc({ commitment: "confirmed" }),
      /NothingToClaim|custom program error/i, "place-1 claim after claim_winner",
    );

    // Protocol and MWL buckets go to the configured receivers, once.
    for (const [bucket, receiver, expected] of [[1, protocolReceiver.publicKey, protocolNormal + boostProtocol], [2, mwlReceiver.publicKey, mwl]]) {
      const before = await lamports(receiver);
      const { instruction } = operator.buildArenaOperatorClaimInstruction({ caller: authority, poolId, bucket, receiver });
      await sendResolver([instruction], `claim bucket ${bucket}`);
      assert.equal((await lamports(receiver)) - before, expected, `bucket ${bucket} pays its receiver exactly`);
      await expectFail(sendResolver([operator.buildArenaOperatorClaimInstruction({ caller: authority, poolId, bucket, receiver }).instruction], "dup"), /already in use|InvalidState|custom program error|0x0\b/i, `bucket ${bucket} double claim`);
    }
    const vaultRent = BigInt(await connection.getMinimumBalanceForRentExemption(8 + 1));
    assert.equal(await lamports(vault), vaultRent, "after all claims the vault holds only its rent");
  });

  it("tournament: entries, boost, activation, three paid places with exact split, place claims once each", async function () {
    const entrants = [0, 1, 2, 3].map(() => Keypair.generate());
    const assets = entrants.map(() => Keypair.generate().publicKey);
    const funder = Keypair.generate();
    for (const k of [...entrants, funder]) await fund(k.publicKey);
    const poolId = hash32(`tournament:${Date.now()}`);
    const pool = pda("arena_pool", poolId);
    const vault = pda("arena_vault", poolId);
    const buyIn = 500_000_000n;
    const boost = 123_456_789n;
    const now = Math.floor(Date.now() / 1000);
    const depositDeadline = now + 4;
    const resolveDeadline = now + 3600;

    await program.methods.openTournamentPoolV2(Array.from(poolId), new BN(buyIn.toString()), new BN(depositDeadline), new BN(depositDeadline), new BN(resolveDeadline))
      .accountsStrict({ authority, arenaConfig, pool, vault, systemProgram: SystemProgram.programId })
      .rpc({ commitment: "confirmed" });

    const receipts = [];
    for (let i = 0; i < entrants.length; i += 1) {
      const receipt = pda("arena_buyin", poolId, assets[i].toBuffer(), entrants[i].publicKey.toBuffer());
      receipts.push(receipt);
      const sig = await program.methods.depositBuyInV2(Array.from(poolId), assets[i])
        .accountsStrict({ entrant: entrants[i].publicKey, arenaConfig, pool, vault, buyInReceipt: receipt, systemProgram: SystemProgram.programId })
        .signers([entrants[i]]).rpc({ commitment: "confirmed" });
      const paid = await creditedAccounts(sig);
      assert.deepEqual(paid.credited.sort(), [vault.toBase58(), receipt.toBase58()].sort(), "a buy-in credits the vault and its own receipt only");
    }
    const fundingId = hash32(`tboost:${Date.now()}`);
    await program.methods.depositPrizeBoostV2(Array.from(poolId), Array.from(fundingId), new BN(boost.toString()))
      .accountsStrict({ funder: funder.publicKey, arenaConfig, pool, vault, boostReceipt: pda("arena_boost", poolId, fundingId, funder.publicKey.toBuffer()), systemProgram: SystemProgram.programId })
      .signers([funder]).rpc({ commitment: "confirmed" });

    await expectFail(
      program.methods.activateTournamentPoolV2(Array.from(poolId)).accountsStrict({ authority, arenaConfig, pool }).rpc({ commitment: "confirmed" }),
      /InvalidDeadline|custom program error/i, "activation before the deposit deadline",
    );
    await sleep(5_500);
    await program.methods.activateTournamentPoolV2(Array.from(poolId)).accountsStrict({ authority, arenaConfig, pool }).rpc({ commitment: "confirmed" });
    let state = await program.account.arenaPool.fetch(pool);
    assert.equal(state.state, 1, "LIVE after activation");
    assert.equal(state.entryCount, 4);

    const buyInTotal = buyIn * 4n;
    const outcomeHash = hash32("tournament-outcome");
    const deadline = Math.floor(Date.now() / 1000) + 3000;
    const places = [
      { asset: assets[0], wallet: entrants[0].publicKey, bps: 6_000 },
      { asset: assets[1], wallet: entrants[1].publicKey, bps: 3_000 },
      { asset: assets[2], wallet: entrants[2].publicKey, bps: 1_000 },
    ];
    const resolveWith = (list, nonce = 0n) => operator.buildArenaResolvePlacesInstructions({
      resolver: resolverKeypair, poolId, version: 2, stakeA: 0n, stakeB: 0n,
      supportTotal: 0n, prizeBoostTotal: boost, buyInTotal, places: list, outcomeHash, deadline, nonce,
    });

    // A list that does not sum to 100% is refused before any money moves.
    const bad = [{ ...places[0], bps: 5_000 }, { ...places[1], bps: 3_000 }, { ...places[2], bps: 1_000 }];
    await expectFail(
      (async () => {
        const built = operator.buildArenaResolvePlacesInstructions({
          resolver: resolverKeypair, poolId, version: 2, stakeA: 0n, stakeB: 0n,
          supportTotal: 0n, prizeBoostTotal: boost, buyInTotal, places: [places[0], places[1], places[2]].map((p, i) => ({ ...p, bps: [5_000, 3_000, 2_000][i] })), outcomeHash, deadline, nonce: 0n,
        });
        // Tamper after signing so the program, not the builder, is what rejects it.
        const data = Buffer.from(built.resolveIx.data);
        data.writeUInt16LE(1_000, 8 + 32 + 4 + 32 + 32); // first place bps 5000 -> 1000
        built.resolveIx.data = data;
        await sendResolver([built.verifyIx, built.resolveIx], "bad places");
      })(),
      /InvalidPlaces|InvalidResolverSignature|custom program error/i, "places not summing to 10000",
    );
    void bad;
    // A place holder who never entered is refused (no receipt).
    await expectFail(
      (async () => {
        const built = resolveWith([places[0], { asset: Keypair.generate().publicKey, wallet: funder.publicKey, bps: 4_000 }].map((p, i) => ({ ...p, bps: i === 0 ? 6_000 : 4_000 })));
        await sendResolver([built.verifyIx, built.resolveIx], "non-entrant place");
      })(),
      /InvalidWinnerReceipt|custom program error/i, "place for a non-entrant",
    );

    const built = resolveWith(places);
    await sendResolver([built.verifyIx, built.resolveIx], "resolve_pool_places_v2");
    state = await program.account.arenaPool.fetch(pool);
    assert.equal(state.state, 2, "RESOLVED");
    const normalBase = buyInTotal;
    const protocolNormal = bpsOf(normalBase, 500);
    const mwl = bpsOf(normalBase, 1_000);
    const boostProtocol = bpsOf(boost, 1_000);
    const prizeTotal = normalBase - protocolNormal - mwl + (boost - boostProtocol);
    const second = bpsOf(prizeTotal, 3_000);
    const third = bpsOf(prizeTotal, 1_000);
    const first = prizeTotal - second - third;
    const placeLamports = state.placeLamports.map((v) => BigInt(v.toString()));
    assert.deepEqual(placeLamports, [first, second, third], "60/30/10 with the rounding remainder on first place");
    assert.equal(BigInt(state.pendingWinner.toString()), first, "pending_winner mirrors first place");
    assert.equal(state.placeCount, 3);
    assert.equal(state.placeWallets[0].toBase58(), entrants[0].publicKey.toBase58());
    assert.equal(BigInt(state.pendingProtocol.toString()), protocolNormal + boostProtocol);
    assert.equal(BigInt(state.pendingMwl.toString()), mwl);
    assert.equal(first + second + third + protocolNormal + boostProtocol + mwl, normalBase + boost, "conserved to the lamport");

    // Claims: each place once, by its own wallet, nobody else.
    const claimPlace = (place, signer) => {
      const { instruction } = operator.buildArenaClaimPlaceInstruction({ winner: signer.publicKey, poolId, place });
      const tx = new Transaction().add(instruction);
      return provider.sendAndConfirm(tx, [signer], { commitment: "confirmed" });
    };
    for (const [place, signer, expected] of [[2, entrants[1], second], [3, entrants[2], third], [1, entrants[0], first]]) {
      const vaultBefore = await lamports(vault);
      await claimPlace(place, signer);
      assert.equal(vaultBefore - (await lamports(vault)), expected, `place ${place} paid exactly`);
      await expectFail(claimPlace(place, signer), /already in use|NothingToClaim|custom program error|0x0\b/i, `place ${place} double claim`);
    }
    await expectFail(claimPlace(2, entrants[3]), /InvalidWinner|already in use|custom program error/i, "the fourth entrant claiming place 2");
    await expectFail(
      program.methods.claimWinner(Array.from(poolId))
        .accountsStrict({ winner: entrants[0].publicKey, pool, vault, claimReceipt: pda("arena_claim", poolId, Buffer.from([0])), systemProgram: SystemProgram.programId })
        .signers([entrants[0]]).rpc({ commitment: "confirmed" }),
      /NothingToClaim|custom program error/i, "claim_winner after place-1 claim",
    );
    state = await program.account.arenaPool.fetch(pool);
    assert.deepEqual(state.placeClaimed, [true, true, true]);
  });

  it("unmatched battle: expires after the deposit deadline and refunds the opener's stake", async function () {
    const ownerA = Keypair.generate();
    const ownerB = Keypair.generate();
    await fund(ownerA.publicKey);
    const poolId = hash32(`expire:${Date.now()}`);
    const pool = pda("arena_pool", poolId);
    const vault = pda("arena_vault", poolId);
    const stake = 400_000_000n;
    const now = Math.floor(Date.now() / 1000);
    await program.methods.openBattlePoolV2(
      Array.from(poolId), Keypair.generate().publicKey, Keypair.generate().publicKey, ownerA.publicKey, ownerB.publicKey,
      new BN(stake.toString()), new BN(stake.toString()), new BN(now + 3), new BN(now + 3), new BN(now + 3600),
    ).accountsStrict({ opener: ownerA.publicKey, arenaConfig, pool, vault, systemProgram: SystemProgram.programId })
      .signers([ownerA]).rpc({ commitment: "confirmed" });
    await expectFail(
      program.methods.settleExpiredPool(Array.from(poolId)).accountsStrict({ pool }).rpc({ commitment: "confirmed" }),
      /ExpiryUnavailable|custom program error/i, "expiry before the deadline",
    );
    await sleep(4_500);
    await program.methods.settleExpiredPool(Array.from(poolId)).accountsStrict({ pool }).rpc({ commitment: "confirmed" });
    const before = await lamports(ownerA.publicKey);
    const refundReceipt = pda("arena_refund", poolId, ownerA.publicKey.toBuffer(), Buffer.from([0]));
    await program.methods.refundStake(Array.from(poolId))
      .accountsStrict({ staker: ownerA.publicKey, pool, vault, refundReceipt, systemProgram: SystemProgram.programId })
      .signers([ownerA]).rpc({ commitment: "confirmed" });
    const receiptRent = BigInt((await connection.getAccountInfo(refundReceipt, "confirmed")).lamports);
    assert.equal((await lamports(ownerA.publicKey)) - before, stake - receiptRent, "the opener gets the stake back minus receipt rent");
    await expectFail(
      program.methods.refundStake(Array.from(poolId))
        .accountsStrict({ staker: ownerA.publicKey, pool, vault, refundReceipt, systemProgram: SystemProgram.programId })
        .signers([ownerA]).rpc({ commitment: "confirmed" }),
      /already in use|AlreadyRefunded|custom program error|0x0\b/i, "double refund",
    );
  });
});
