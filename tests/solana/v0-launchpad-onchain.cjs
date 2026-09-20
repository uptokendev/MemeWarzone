"use strict";

const assert = require("assert");
const {
  AddressLookupTableProgram,
  Keypair,
  Transaction,
} = require("@solana/web3.js");
const web3 = require("@solana/web3.js");
const { AnchorProvider } = require("@coral-xyz/anchor");

async function loadV0() {
  const { loadSolanaLaunchpadInstructions, loadSolanaV0Module } = await import(
    "../../frontend/scripts/load-solana-v0-module.mjs"
  );
  return {
    v0: await loadSolanaV0Module(),
    instructions: await loadSolanaLaunchpadInstructions(),
  };
}

async function sendLegacy(connection, payer, ixs) {
  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: latest.blockhash }).add(...ixs);
  tx.sign(payer);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const confirmation = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (confirmation.value.err) throw new Error(JSON.stringify(confirmation.value.err));
}

describe("shared V0/ALT launchpad helper on local validator", function () {
  this.timeout(180_000);

  it("creates a static launchpad ALT and compiles production CREATE/BUY through the shared helper", async function () {
    const { v0, instructions } = await loadV0();
    const provider = AnchorProvider.env();
    const connection = provider.connection;
    const payer = provider.wallet.payer;
    assert.ok(payer?.secretKey, "local validator wallet must be a Keypair");

    const plan = v0.buildLaunchpadAltPlan(web3);
    const planAddress = (label) => {
      const entry = plan.find((item) => item.label === label);
      assert.ok(entry, `missing ALT plan address: ${label}`);
      return entry.address.toBase58();
    };
    // The active generation PDA is derived from GlobalConfig.activeGenerationId,
    // so it is not part of the static plan -- but the production table built by
    // scripts/solana/create-launchpad-alt.mjs contains it, and so does mainnet's
    // (BdSPkZWk..., index 16). Compiling without it makes this envelope 31 bytes
    // larger than the one creators actually sign, which is not a ceiling worth
    // measuring against.
    const generationConfig = Keypair.generate().publicKey;
    const altAddresses = [...plan.map((entry) => entry.address), generationConfig];

    const slot = await connection.getSlot("confirmed");
    const [createIx, lookupTable] = AddressLookupTableProgram.createLookupTable({
      authority: payer.publicKey,
      payer: payer.publicKey,
      recentSlot: Math.max(0, slot - 1),
    });
    await sendLegacy(connection, payer, [createIx]);
    for (let i = 0; i < altAddresses.length; i += 20) {
      await sendLegacy(connection, payer, [
        AddressLookupTableProgram.extendLookupTable({
          payer: payer.publicKey,
          authority: payer.publicKey,
          lookupTable,
          addresses: altAddresses.slice(i, i + 20),
        }),
      ]);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const table = await v0.fetchAndVerifyLaunchpadLookupTable(web3, connection, {
      // Built seconds ago on a throwaway validator; production tables must be
      // frozen and the helper enforces that by default.
      allowMutableTable: true,
      address: lookupTable.toBase58(),
      requiredAddresses: plan.map((entry) => entry.address),
      expectedAuthority: payer.publicKey,
    });

    const bytes32 = (fill) => Array.from({ length: 32 }, (_, index) => (fill + index) & 0xff);
    const ed25519Instruction = instructions.buildLaunchpadEd25519Instruction(web3, {
      publicKey: Keypair.generate().publicKey.toBase58(),
      message: Uint8Array.from(bytes32(1)),
      signature: Uint8Array.from({ length: 64 }, (_, index) => (index + 9) & 0xff),
    });
    const createInstruction = instructions.buildCreateCampaignInstruction(web3, {
      programId: v0.SOLANA_LAUNCHPAD_PROGRAM_ID,
      args: {
        campaignId: bytes32(2),
        metadataHash: bytes32(3),
        // Largest strings Metaplex accepts, so the envelope this compiles is the
        // worst case a creator can actually submit.
        name: "x".repeat(32),
        symbol: "y".repeat(10),
        launchAt: "0",
        graduationTargetUsdMicros: "6000000",
        deadline: "1770000000",
      },
      accounts: {
        creator: payer.publicKey.toBase58(),
        globalConfig: planAddress("globalConfig"),
        generationConfig: generationConfig.toBase58(),
        creatorProfile: Keypair.generate().publicKey.toBase58(),
        riskProfile: Keypair.generate().publicKey.toBase58(),
        // In the ALT on mainnet (index 17), like generationConfig above.
        clusterProfile: planAddress("clusterProfile"),
        campaign: Keypair.generate().publicKey.toBase58(),
        mint: Keypair.generate().publicKey.toBase58(),
        tokenVault: Keypair.generate().publicKey.toBase58(),
        solVault: Keypair.generate().publicKey.toBase58(),
        tokenMetadata: Keypair.generate().publicKey.toBase58(),
        tokenMetadataProgram: planAddress("tokenMetadataProgram"),
        feeEscrow: Keypair.generate().publicKey.toBase58(),
        creatorFeeVault: Keypair.generate().publicKey.toBase58(),
        instructions: planAddress("instructionsSysvar"),
        tokenProgram: planAddress("tokenProgram"),
        systemProgram: planAddress("systemProgram"),
      },
    });
    const tradeInstruction = instructions.buildTradeTokensInstruction(web3, {
      programId: v0.SOLANA_LAUNCHPAD_PROGRAM_ID,
      side: "buy",
      amountIn: "100000000",
      minOut: "1",
      deadline: "1770000000",
      nonce: bytes32(12),
      nativeTargetLamports: "100000000",
      routeProfile: 1,
      accounts: {
        trader: payer.publicKey.toBase58(),
        globalConfig: planAddress("globalConfig"),
        campaign: Keypair.generate().publicKey.toBase58(),
        mint: Keypair.generate().publicKey.toBase58(),
        tokenVault: Keypair.generate().publicKey.toBase58(),
        solVault: Keypair.generate().publicKey.toBase58(),
        traderTokenAccount: Keypair.generate().publicKey.toBase58(),
        riskProfile: Keypair.generate().publicKey.toBase58(),
        clusterProfile: Keypair.generate().publicKey.toBase58(),
        tradeAuthorization: Keypair.generate().publicKey.toBase58(),
        instructions: planAddress("instructionsSysvar"),
        tokenProgram: planAddress("tokenProgram"),
        systemProgram: planAddress("systemProgram"),
        feeEscrow: Keypair.generate().publicKey.toBase58(),
        creatorFeeVault: Keypair.generate().publicKey.toBase58(),
      },
    });

    const latest = await connection.getLatestBlockhash("confirmed");
    const createV0 = v0.compileAndAssertLaunchpadV0(
      web3,
      {
        payer: payer.publicKey,
        recentBlockhash: latest.blockhash,
        instructions: [ed25519Instruction, createInstruction],
        lookupTableAccounts: [table],
      },
      { payer: payer.publicKey, ed25519Instruction, programInstruction: createInstruction },
    );
    const tradeV0 = await v0.compileLaunchpadV0WithLatestBlockhash(
      web3,
      connection,
      {
        payer: payer.publicKey,
        instructions: [
          ed25519Instruction,
          tradeInstruction,
        ],
        lookupTableAccounts: [table],
      },
      { payer: payer.publicKey, ed25519Instruction, programInstruction: tradeInstruction },
    );

    console.info("[v0-onchain] CREATE", createV0.stats);
    console.info("[v0-onchain] BUY", tradeV0.stats);
    // v7: 17 accounts, 9 of them writable. Both numbers are load-bearing --
    // Phantom guards every written account with a Lighthouse assertion, so a
    // writable account costs 32 bytes of key AND 17-41 bytes of wallet rewrite.
    assert.equal(createInstruction.keys.length, 17);
    assert.equal(createInstruction.keys.filter((key) => key.isWritable).length, 9);
    assert.equal(createInstruction.keys[1].isWritable, false, "globalConfig must be read-only");
    // 14, not 15: the creator fee vault is the escrow's seventh bucket and rides
    // on no trade. This was the one structural difference from every buy a
    // wallet ever guarded.
    assert.equal(tradeInstruction.keys.length, 14);
    assert.equal(tradeInstruction.keys.filter((key) => key.isWritable).length, 7);
    assert.equal(createV0.stats.requiredSigners, 1);
    assert.equal(tradeV0.stats.requiredSigners, 1);
    assert.ok(createV0.stats.serializedBytes <= v0.SOLANA_RELEASE_MAX_BYTES);
    assert.ok(tradeV0.stats.serializedBytes <= v0.SOLANA_RELEASE_MAX_BYTES);

    const createSim = await v0.simulateLaunchpadV0Transaction(connection, createV0.transaction);
    const tradeSim = await v0.simulateLaunchpadV0Transaction(connection, tradeV0.transaction);
    const createLogs = (createSim.value.logs || []).join("\n");
    const tradeLogs = (tradeSim.value.logs || []).join("\n");
    assert.equal(/Access violation|stack frame|Program failed to complete/i.test(createLogs), false, createLogs);
    assert.equal(/Access violation|stack frame|Program failed to complete/i.test(tradeLogs), false, tradeLogs);
  });
});
