"use strict";

/**
 * Local-validator bonding lifecycle against the compiled SBF binary.
 * Does not touch mainnet. Run after:
 *   solana-test-validator --reset --bpf-program 3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt target/deploy/memewarzone_solana.so
 *
 *   npm --prefix tests/solana run test:lifecycle
 *
 * Mainnet GlobalConfig is NOT cloned: create/trade Ed25519 needs a test route
 * signer we control. Generation economics here copy mainnet fees/supply/v3,
 * with cluster_kind=devnet + $6 mask so the threshold-crossing buy is affordable.
 */

const assert = require("node:assert/strict");

/** Run an initializer only when its account does not exist yet. */
async function initializeIfMissing(connection, address, run) {
  const existing = await connection.getAccountInfo(address, "confirmed");
  if (existing && existing.data.length > 0) return false;
  await run();
  return true;
}

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const anchor = require("@coral-xyz/anchor");
const web3 = require("@solana/web3.js");
const {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Ed25519Program,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} = web3;
const {
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} = require("@solana/spl-token");

const {
  CREATE_AUTH_SCHEMA_VERSION,
  buildCreateAuthorizationPayload,
  createAuthorizationDigest,
} = require("./authorization-v4.cjs");
const { decodeCampaign } = require("./decode-campaign.cjs");

const { AnchorProvider, BN, Program, setProvider } = anchor;

const PROGRAM_ID = "3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt";
const SO_PATH = path.resolve(__dirname, "../../target/deploy/memewarzone_solana.so");
const TRADE_AUTH_DOMAIN = Buffer.from("MEMEWARZONE_SOLANA_TRADE_V1", "utf8");
const TRADE_AUTH_SCHEMA_VERSION = 3;
const TRADE_SIDE_BUY = 1;
const TRADE_SIDE_SELL = 2;
const ROUTE_PROFILE_UNLINKED = 1;
const REWARDS_TREASURY = new PublicKey("2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX");
const TOKEN_TOTAL_SUPPLY = 1_000_000_000_000_000n;
const TOKEN_DECIMALS = 6;
const CURVE_SUPPLY_BPS = 8_000;
const LIQUIDITY_SUPPLY_BPS = 1_000;
const BUY_FEE_BPS = 200;
const SELL_FEE_BPS = 200;
const GRADUATION_TARGET_6_USD_MICROS = 6_000_000n;
const BUY_LAMPORTS = 10_000_000n; // 0.01 SOL
const CLOSE_TARGET_LAMPORTS = 40_000_000n; // 0.04 SOL net-raised close
const CLOSE_BUY_LAMPORTS = 50_000_000n;
const METEORA_CP_AMM = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const METAPLEX_METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const GRADUATION_AUTH_DOMAIN = Buffer.from("MEMEWARZONE_SOLANA_GRADUATION_V1", "utf8");
const GRADUATION_AUTH_SCHEMA_VERSION = 4;
// Native SOL graduation binding. The program requires exactly this shape when
// quote_mint is the native mint: see validate_quote_binding in graduation.rs.
const QUOTE_PROFILE_NATIVE = 0;
const QUOTE_PROVIDER_NATIVE = 0;

function hash32(label) {
  return crypto.createHash("sha256").update(label, "utf8").digest();
}

function fixed32(value) {
  const buffer = Buffer.from(value);
  assert.equal(buffer.length, 32);
  return Array.from(buffer);
}

function sha256File(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function derivePda(programId, ...seeds) {
  return PublicKey.findProgramAddressSync(
    seeds.map((seed) => Buffer.from(seed)),
    programId,
  )[0];
}

function u16le(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}

function u64le(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
}

function i64le(n) {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n), 0);
  return b;
}

function tradeDigest({
  programId,
  campaign,
  mint,
  trader,
  side,
  amountIn,
  minOut,
  deadline,
  nonce,
  nativeTargetLamports,
  routeProfile,
}) {
  return crypto
    .createHash("sha256")
    .update(
      Buffer.concat([
        TRADE_AUTH_DOMAIN,
        u16le(TRADE_AUTH_SCHEMA_VERSION),
        new PublicKey(programId).toBuffer(),
        new PublicKey(campaign).toBuffer(),
        new PublicKey(mint).toBuffer(),
        new PublicKey(trader).toBuffer(),
        Buffer.from([side]),
        u64le(amountIn),
        u64le(minOut),
        i64le(deadline),
        Buffer.from(nonce),
        u64le(nativeTargetLamports),
        Buffer.from([routeProfile]),
      ]),
    )
    .digest();
}

function rewardVaultKeys() {
  return {
    league: derivePda(REWARDS_TREASURY, "league_vault"),
    airdrop: derivePda(REWARDS_TREASURY, "airdrop_vault"),
    monthly: derivePda(REWARDS_TREASURY, "monthly_league_vault"),
    recruiter: derivePda(REWARDS_TREASURY, "recruiter_vault"),
    squad: derivePda(REWARDS_TREASURY, "squad_vault"),
    protocol: derivePda(REWARDS_TREASURY, "protocol_vault"),
  };
}

function remainingRewardAccounts() {
  const vaults = rewardVaultKeys();
  return [
    { pubkey: vaults.league, isWritable: true, isSigner: false },
    { pubkey: vaults.airdrop, isWritable: true, isSigner: false },
    { pubkey: vaults.monthly, isWritable: true, isSigner: false },
    { pubkey: vaults.recruiter, isWritable: true, isSigner: false },
    { pubkey: vaults.squad, isWritable: true, isSigner: false },
    { pubkey: vaults.protocol, isWritable: true, isSigner: false },
  ];
}

async function chainUnixTimestamp(connection) {
  const slot = await connection.getSlot("confirmed");
  const blockTime = await connection.getBlockTime(slot);
  return blockTime ?? Math.floor(Date.now() / 1_000);
}

describe("MemeWarzone Solana V4 local-validator bonding lifecycle", function () {
  this.timeout(1_000_000);

  const provider = AnchorProvider.env();
  setProvider(provider);
  const idl = require(path.resolve(__dirname, "../../target/idl/memewarzone_solana.json"));
  const program = new Program(idl, provider);
  const connection = provider.connection;
  const admin = provider.wallet.publicKey;
  const routeSigner = Keypair.generate();

  const globalConfig = derivePda(program.programId, "global");
  const generationId = hash32("memewarzone-local-lifecycle-generation-v3");
  const generationConfig = derivePda(program.programId, "generation", generationId);
  const emptyClusterId = Buffer.alloc(32);
  const clusterProfile = derivePda(program.programId, "cluster", emptyClusterId);

  let creator;
  let buyer;
  let campaignAccounts;
  let createArgs;
  let buyerClusterId = emptyClusterId;
  let v0Helpers;
  let lookupTableAccount;
  const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";

  function assertNoSimCrash(label, err, logs) {
    const source = `${err == null ? "" : JSON.stringify(err)}\
${logs.join("\
")}`;
    assert.equal(
      /Access violation|stack frame|Program failed to complete/i.test(source),
      false,
      `${label} hit BPF stack overflow:\
${source}`,
    );
    return source;
  }

  async function simulateUnsigned(tx, label, feePayer) {
    const latest = await connection.getLatestBlockhash("confirmed");
    tx.feePayer = feePayer;
    tx.recentBlockhash = latest.blockhash;
    // web3 1.95: legacy Transaction second arg must be Signer[] or omitted.
    // A config object throws "Invalid arguments" and never RPCs.
    // No signers ⇒ library does not set sigVerify (production trade path).
    const simulated = await connection.simulateTransaction(tx);
    const logs = simulated.value.logs || [];
    const source = assertNoSimCrash(label, simulated.value.err, logs);
    return { err: simulated.value.err, logs, latest, source };
  }

  async function simulateThenSend(tx, label, signers) {
    const simulated = await simulateUnsigned(tx, label, signers[0].publicKey);
    if (simulated.err) {
      throw new Error(`${label} simulation failed: ${simulated.source}`);
    }

    tx.sign(...signers);
    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });
    const confirmation = await connection.confirmTransaction(
      {
        signature,
        blockhash: simulated.latest.blockhash,
        lastValidBlockHeight: simulated.latest.lastValidBlockHeight,
      },
      "confirmed",
    );
    if (confirmation.value.err) {
      throw new Error(`${label} landed with error: ${JSON.stringify(confirmation.value.err)}`);
    }
    return { signature, logs: simulated.logs };
  }


  /// A trade may credit exactly one fee destination: the fee escrow.
  ///
  /// accrue_fee_escrow briefly moved the creator's 5% slice out of the escrow
  /// and into creator_fee_vault inside the trader's own transaction, so a buy
  /// paid two separate fee accounts, the second usually dust -- 980 lamports on
  /// a 0.001 SOL buy. Wallets read that fan-out as a drain: Phantom stopped
  /// attaching Lighthouse assertions to trades entirely and returned "This dApp
  /// could be malicious" on every buy and sell, while signing create from the
  /// same wallet without complaint, because create distributes no fees.
  ///
  /// Nothing in the trade code changed to cause it and nothing in the trade
  /// code would have caught it. This reads the lamport deltas the chain
  /// actually recorded.
  async function assertTradePaysOneFeeDestination(signature, label) {
    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    assert.ok(tx, `${label}: transaction ${signature} not found`);
    const keys = tx.transaction.message
      .getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses })
      .keySegments()
      .flat()
      .map((k) => k.toBase58());
    const credited = [];
    keys.forEach((k, i) => {
      if (tx.meta.postBalances[i] - tx.meta.preBalances[i] > 0) credited.push(k);
    });
    const creatorVault = campaignAccounts.creatorFeeVault.toBase58();
    assert.ok(
      !credited.includes(creatorVault),
      `${label}: creator_fee_vault was credited by the trade. The creator's slice must accrue as a ` +
        "counter and move only on claim; paying a second fee destination inside the trade is what " +
        "made wallets flag every buy.",
    );
    const feeEscrow = campaignAccounts.feeEscrow.toBase58();
    assert.ok(
      credited.includes(feeEscrow),
      `${label}: the fee escrow received nothing; the fee must still be collected`,
    );
    const deltas = credited
      .map((k) => {
        const i = keys.indexOf(k);
        const lamports = tx.meta.postBalances[i] - tx.meta.preBalances[i];
        const name =
          k === feeEscrow
            ? "feeEscrow"
            : k === campaignAccounts.solVault.toBase58()
              ? "solVault"
              : k === creatorVault
                ? "creatorFeeVault"
                : "other";
        return `${name}+${lamports}`;
      })
      .join(" ");
    console.log(`      [fee-route] ${label}: ${credited.length} credited -> ${deltas}`);
  }

  /** Orca's kit-shaped instruction -> the web3 shape the V0 builder expects. */
  function toLegacyInstruction(ix) {
    if (ix instanceof TransactionInstruction) return ix;
    return new TransactionInstruction({
      programId: new PublicKey(String(ix.programAddress ?? ix.programId)),
      keys: (ix.accounts || ix.keys || []).map((meta) => ({
        pubkey: new PublicKey(String(meta.address ?? meta.pubkey)),
        isSigner: Boolean(meta.isSigner ?? ((meta.role ?? 0) & 2)),
        isWritable: Boolean(meta.isWritable ?? ((meta.role ?? 0) & 1)),
      })),
      data: Buffer.from(ix.data || []),
    });
  }

  async function sendLegacy(payer, ixs, label) {
    const latest = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: latest.blockhash }).add(...ixs);
    tx.sign(payer);
    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    const confirmation = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
    if (confirmation.value.err) {
      throw new Error(`${label} failed: ${JSON.stringify(confirmation.value.err)}`);
    }
    return signature;
  }

  async function sendProductionTrade({ label, signer, ed25519, programIx, recoverAccount, guardBetween }) {
    assert.ok(v0Helpers && lookupTableAccount, "production V0/ALT envelope is not initialized");
    const compiled = await v0Helpers.compileLaunchpadV0WithLatestBlockhash(
      web3,
      connection,
      {
        payer: signer.publicKey,
        // Same guard placement as above, recompiled on a fresh blockhash.
        instructions: guardBetween ? [ed25519, guardBetween, programIx] : [ed25519, programIx],
        lookupTableAccounts: [lookupTableAccount],
      },
      {
        payer: signer.publicKey,
        ed25519Instruction: ed25519,
        programInstruction: programIx,
        lookupTableAccounts: [lookupTableAccount],
      },
    );
    const decompiled = web3.TransactionMessage.decompile(compiled.transaction.message, {
      addressLookupTableAccounts: [lookupTableAccount],
    });
    for (const ix of decompiled.instructions) {
      assert.notEqual(
        ix.programId.toBase58(),
        COMPUTE_BUDGET_PROGRAM_ID,
        `${label} must not include ComputeBudget setComputeUnitLimit`,
      );
    }
    assert.equal(compiled.stats.requiredSigners, 1, `${label} must have one wallet signer`);
    assert.ok(compiled.stats.serializedBytes <= 1232, `${label} exceeds 1232 bytes`);
    let simulated;
    try {
      simulated = await v0Helpers.simulateLaunchpadV0OrThrow(
        connection,
        compiled.transaction,
        `${label} simulation failed`,
      );
    } catch (error) {
      const extra = error?.source || (Array.isArray(error?.logs) ? error.logs.join("\
") : "");
      throw new Error(`${error instanceof Error ? error.message : String(error)}\
${extra}`);
    }
    console.log(
      `[sbf-gate] ${label} unitsConsumed=${simulated.unitsConsumed ?? "n/a"} bytes=${compiled.stats.serializedBytes}`,
    );
    const unsigned = await v0Helpers.compileLaunchpadV0WithLatestBlockhash(
      web3,
      connection,
      {
        payer: signer.publicKey,
        // Same guard placement as above, recompiled on a fresh blockhash.
        instructions: guardBetween ? [ed25519, guardBetween, programIx] : [ed25519, programIx],
        lookupTableAccounts: [lookupTableAccount],
      },
      {
        payer: signer.publicKey,
        ed25519Instruction: ed25519,
        programInstruction: programIx,
        lookupTableAccounts: [lookupTableAccount],
      },
    );
    unsigned.transaction.sign([signer]);
    v0Helpers.assertLaunchpadV0Intent(web3, unsigned.transaction, {
      payer: signer.publicKey,
      ed25519Instruction: ed25519,
      programInstruction: programIx,
      lookupTableAccounts: [lookupTableAccount],
      releaseMaxBytes: null,
    });
    const signature = await connection.sendTransaction(unsigned.transaction, {
      // Local validators, especially Agave --clone-feature-set, can spend
      // a full blockhash window inside RPC preflight. The unsigned V0
      // simulation above already proved the program. Production still uses
      // skipPreflight: false against real RPCs.
      skipPreflight: true,
      maxRetries: 5,
      preflightCommitment: "confirmed",
    });
    const deadlineMs = Date.now() + 20_000;
    while (Date.now() < deadlineMs) {
      const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
      if (status?.value?.err) {
        throw new Error(`${label} landed with error: ${JSON.stringify(status.value.err)}`);
      }
      if (status?.value?.confirmationStatus === "confirmed" || status?.value?.confirmationStatus === "finalized") {
        return { signature, logs: simulated.logs || [] };
      }
      if (recoverAccount) {
        const info = await connection.getAccountInfo(recoverAccount, "confirmed");
        if (info) return { signature, logs: simulated.logs || [] };
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new Error(`${label} did not confirm within 20s (${signature})`);
  }

  async function fund(pubkey, sol) {
    const sig = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
    const latest = await connection.getLatestBlockhash("confirmed");
    await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
  }

  before(async function () {
    assert.equal(program.programId.toBase58(), PROGRAM_ID);
    const soHash = sha256File(SO_PATH);
    if (soHash) {
      console.log(`[sbf-gate] memewarzone_solana.so sha256=${soHash} bytes=${fs.statSync(SO_PATH).size}`);
    } else {
      console.warn(`[sbf-gate] ${SO_PATH} missing — hash the binary you actually deploy`);
    }

    const min = 50 * LAMPORTS_PER_SOL;
    if ((await connection.getBalance(admin, "confirmed")) < min) {
      const sig = await connection.requestAirdrop(admin, 100 * LAMPORTS_PER_SOL);
      const latest = await connection.getLatestBlockhash("confirmed");
      await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
    }
    assert.ok(
      (await connection.getBalance(admin, "confirmed")) >= min,
      `admin ${admin.toBase58()} has no SOL on the local validator`,
    );

    const existingGlobal = await connection.getAccountInfo(globalConfig, "confirmed");
    if (existingGlobal) {
      throw new Error(
        "GlobalConfig already exists. Restart solana-test-validator --reset so lifecycle can init its own route signer (the gate script does this between suites).",
      );
    }

    await program.methods
      .initializeGlobalConfig({
        admin,
        pauser: admin,
        tierAdmin: admin,
        riskAdmin: admin,
        routeSigner: routeSigner.publicKey,
        rewardOperator: admin,
        treasuryOperator: admin,
        generationOperator: admin,
      })
      .accountsStrict({ admin, globalConfig, systemProgram: SystemProgram.programId })
      .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" });

    await program.methods
      .lockSecurityDefaults()
      .accountsStrict({ globalConfig, admin })
      .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" });

    await program.methods
      .setPauseFlags({
        paused: false,
        createPaused: false,
        buyPaused: false,
        sellPaused: false,
        graduationPaused: true,
        claimsPaused: true,
      })
      .accountsStrict({ globalConfig, authority: admin })
      .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" });

    await program.methods
      .initializeGenerationConfig({
        generationId: fixed32(generationId),
        clusterKind: 1,
        allowedGraduationTierMask: 1,
        economicsVersion: 3,
        curveKind: 1,
        tokenTotalSupply: new BN(TOKEN_TOTAL_SUPPLY.toString()),
        tokenDecimals: TOKEN_DECIMALS,
        curveSupplyBps: CURVE_SUPPLY_BPS,
        liquidityTokenBps: LIQUIDITY_SUPPLY_BPS,
        basePriceLamports: new BN(1_000),
        priceSlopeLamports: new BN(10),
        buyFeeBps: BUY_FEE_BPS,
        sellFeeBps: SELL_FEE_BPS,
        finalizeFeeBps: 200,
        creatorPostFinalizeBps: 2_000,
        liquidityPostFinalizeBps: 8_000,
        dexAdapter: 1,
        tradeRouteProfile: fixed32(hash32("trade-route-profile-v1")),
        finalizeRouteProfile: fixed32(hash32("finalize-route-profile-v1")),
        treasuryProfile: fixed32(hash32("treasury-profile-v1")),
        dexProfile: fixed32(hash32("dex-profile-v1")),
        oracleProfile: fixed32(hash32("oracle-profile-v1")),
        activeCreation: true,
        supportEnabled: true,
        manifestHash: fixed32(hash32("generation-manifest-lifecycle-v3")),
        routeAuthorizationRequired: true,
        authorizedTradingRequired: true,
      })
      .accountsStrict({
        authority: admin,
        globalConfig,
        generationConfig,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" });

    for (const vault of Object.values(rewardVaultKeys())) {
      if ((await connection.getBalance(vault, "confirmed")) === 0) {
        await fund(vault, 1);
      }
    }

    const { loadSolanaV0Module } = await import("../../frontend/scripts/load-solana-v0-module.mjs");
    v0Helpers = await loadSolanaV0Module();
    const payer = provider.wallet.payer;
    assert.ok(payer?.secretKey, "local validator wallet must be a Keypair");
    const plan = v0Helpers.buildLaunchpadAltPlan(web3);
    const slot = await connection.getSlot("confirmed");
    const [createIx, lookupTable] = AddressLookupTableProgram.createLookupTable({
      authority: payer.publicKey,
      payer: payer.publicKey,
      recentSlot: Math.max(0, slot - 1),
    });
    await sendLegacy(payer, [createIx], "createLaunchpadAlt");
    for (let i = 0; i < plan.length; i += 20) {
      await sendLegacy(
        payer,
        [
          AddressLookupTableProgram.extendLookupTable({
            payer: payer.publicKey,
            authority: payer.publicKey,
            lookupTable,
            addresses: plan.slice(i, i + 20).map((entry) => entry.address),
          }),
        ],
        "extendLaunchpadAlt",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
    lookupTableAccount = await v0Helpers.fetchAndVerifyLaunchpadLookupTable(web3, connection, {
      // Built seconds ago on a throwaway validator; production tables must be
      // frozen and the helper enforces that by default.
      allowMutableTable: true,
      address: lookupTable.toBase58(),
      requiredAddresses: plan.map((entry) => entry.address),
      expectedAuthority: payer.publicKey,
    });
  });

  async function setupWallet(label) {
    const keypair = Keypair.generate();
    await fund(keypair.publicKey, 5);
    const creatorProfile = derivePda(program.programId, "creator", keypair.publicKey.toBuffer());
    const riskProfile = derivePda(program.programId, "risk", keypair.publicKey.toBuffer());
    await program.methods
      .syncCreatorProfile({
        wallet: keypair.publicKey,
        tier: 1,
        trustScore: 7_000,
        liveBondingCount: 0,
        lastLaunchTimestamp: new BN(0),
        totalLaunches: new BN(0),
        successfulGraduations: new BN(0),
        restricted: false,
        manualReviewRequired: false,
        creatorBuyCapBps: 1_000,
      })
      .accountsStrict({
        authority: admin,
        globalConfig,
        creatorProfile,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" });
    await program.methods
      .syncRiskProfile({
        wallet: keypair.publicKey,
        riskLevel: 0,
        restricted: false,
        clusterId: Array.from(emptyClusterId),
        manualReviewRequired: false,
      })
      .accountsStrict({
        authority: admin,
        globalConfig,
        riskProfile,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" });
    return { keypair, creatorProfile, riskProfile, label };
  }

  // The campaign id seeds every campaign PDA, so a second campaign in the same
  // validator needs a different label or it collides with the first and the
  // program rejects the create for an account that is not empty.
  async function sendCreate(label = "lifecycle") {
    const now = await chainUnixTimestamp(connection);
    createArgs = {
      campaignId: fixed32(hash32(`campaign:${label}`)),
      name: "MWZ Lifecycle",
      symbol: label === "lifecycle" ? "MWZLIFE" : "MWZBND",
      metadataHash: fixed32(hash32(`metadata:${label}`)),
      launchAt: new BN(0),
      graduationTargetUsdMicros: new BN(GRADUATION_TARGET_6_USD_MICROS.toString()),
      deadline: new BN(now + 3_600),
    };
    campaignAccounts = {
      campaign: derivePda(program.programId, "campaign", Buffer.from(createArgs.campaignId)),
      mint: derivePda(program.programId, "campaign-mint", Buffer.from(createArgs.campaignId)),
      tokenVault: derivePda(program.programId, "token-vault", Buffer.from(createArgs.campaignId)),
      solVault: derivePda(program.programId, "sol-vault", Buffer.from(createArgs.campaignId)),
    };
    campaignAccounts.tokenMetadata = PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata", "utf8"),
        METAPLEX_METADATA_PROGRAM.toBuffer(),
        campaignAccounts.mint.toBuffer(),
      ],
      METAPLEX_METADATA_PROGRAM,
    )[0];
    campaignAccounts.feeEscrow = derivePda(
      program.programId,
      "fee-escrow",
      campaignAccounts.campaign.toBuffer(),
    );
    campaignAccounts.creatorFeeVault = derivePda(
      program.programId,
      "creator-fee-vault",
      campaignAccounts.campaign.toBuffer(),
    );

    const generation = await program.account.generationConfig.fetch(generationConfig);
    const profile = await program.account.creatorProfile.fetch(creator.creatorProfile);
    const digest = createAuthorizationDigest({
      programId: program.programId,
      generationConfigKey: generationConfig,
      generation,
      creator: creator.keypair.publicKey,
      riskClusterId: emptyClusterId,
      creatorBuyLockSeconds: profile.creatorBuyLockSeconds,
      creatorBuyCapBps: profile.creatorBuyCapBps,
      campaign: campaignAccounts.campaign,
      mint: campaignAccounts.mint,
      tokenVault: campaignAccounts.tokenVault,
      solVault: campaignAccounts.solVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      args: createArgs,
    });
    const ed25519 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: routeSigner.secretKey,
      message: digest,
    });
    const createIx = await program.methods
      .createCampaign(createArgs)
      .accountsStrict({
        creator: creator.keypair.publicKey,
        globalConfig,
        generationConfig,
        creatorProfile: creator.creatorProfile,
        riskProfile: creator.riskProfile,
        clusterProfile,
        campaign: campaignAccounts.campaign,
        mint: campaignAccounts.mint,
        tokenVault: campaignAccounts.tokenVault,
        solVault: campaignAccounts.solVault,
        tokenMetadata: campaignAccounts.tokenMetadata,
        tokenMetadataProgram: METAPLEX_METADATA_PROGRAM,
        feeEscrow: campaignAccounts.feeEscrow,
        // create still creates the vault (17 accounts); only a TRADE drops it.
        creatorFeeVault: campaignAccounts.creatorFeeVault,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ed25519,
      createIx,
    );
    return simulateThenSend(tx, "createCampaign", [creator.keypair]);
  }

  async function ensureBuyerAta() {
    const ata = getAssociatedTokenAddressSync(campaignAccounts.mint, buyer.keypair.publicKey);
    const info = await connection.getAccountInfo(ata, "confirmed");
    if (info) return ata;
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        buyer.keypair.publicKey,
        ata,
        buyer.keypair.publicKey,
        campaignAccounts.mint,
      ),
    );
    await simulateThenSend(tx, "createBuyerAta", [buyer.keypair]);
    return ata;
  }

  async function sendBuy(lamportsIn, nativeTargetLamports = 0n, opts = {}) {
    const clusterId = opts.clusterId || buyerClusterId;
    const routeProfile = opts.routeProfile ?? ROUTE_PROFILE_UNLINKED;
    const includeVaults = opts.includeVaults !== false;
    const now = await chainUnixTimestamp(connection);
    const nonce = opts.nonce || hash32(`buy:${Date.now()}:${lamportsIn}:${Math.random()}`);
    const deadline = opts.deadline ?? now + 3_600;
    const minOut = 1n;
    const digest = tradeDigest({
      programId: program.programId,
      campaign: campaignAccounts.campaign,
      mint: campaignAccounts.mint,
      trader: buyer.keypair.publicKey,
      side: TRADE_SIDE_BUY,
      amountIn: lamportsIn,
      minOut,
      deadline,
      nonce,
      nativeTargetLamports,
      routeProfile,
    });
    const ed25519 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: routeSigner.secretKey,
      message: digest,
    });
    const ata = await ensureBuyerAta();
    const tradeAuth = derivePda(
      program.programId,
      "trade-auth",
      buyer.keypair.publicKey.toBuffer(),
      nonce,
    );
    const clusterProfile = derivePda(program.programId, "cluster", clusterId);
    let builder = program.methods
      .buyTokens({
        lamportsIn: new BN(lamportsIn.toString()),
        minTokensOut: new BN(minOut.toString()),
        deadline: new BN(deadline),
        nonce: Array.from(nonce),
        nativeTargetLamports: new BN(nativeTargetLamports.toString()),
        routeProfile,
      })
      .accountsStrict({
        trader: buyer.keypair.publicKey,
        globalConfig,
        campaign: campaignAccounts.campaign,
        mint: campaignAccounts.mint,
        tokenVault: campaignAccounts.tokenVault,
        solVault: campaignAccounts.solVault,
        traderTokenAccount: ata,
        riskProfile: buyer.riskProfile,
        clusterProfile,
        tradeAuthorization: tradeAuth,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        feeEscrow: campaignAccounts.feeEscrow,
      });
    const buyIx = await builder.instruction();
    const sent = await sendProductionTrade({
      guardBetween: opts.guardBetween,
      label: `buy_tokens ${lamportsIn}`,
      signer: buyer.keypair,
      ed25519,
      programIx: buyIx,
      recoverAccount: tradeAuth,
    });
    return { ...sent, tradeAuthorization: tradeAuth, nonce, deadline };
  }

  async function sendSell(tokensIn, opts = {}) {
    const clusterId = opts.clusterId || buyerClusterId;
    const routeProfile = opts.routeProfile ?? ROUTE_PROFILE_UNLINKED;
    const includeVaults = opts.includeVaults !== false;
    const now = await chainUnixTimestamp(connection);
    const nonce = hash32(`sell:${Date.now()}:${tokensIn}:${Math.random()}`);
    const deadline = opts.deadline ?? now + 3_600;
    const minOut = 1n;
    const digest = tradeDigest({
      programId: program.programId,
      campaign: campaignAccounts.campaign,
      mint: campaignAccounts.mint,
      trader: buyer.keypair.publicKey,
      side: TRADE_SIDE_SELL,
      amountIn: tokensIn,
      minOut,
      deadline,
      nonce,
      nativeTargetLamports: 0n,
      routeProfile,
    });
    const ed25519 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: routeSigner.secretKey,
      message: digest,
    });
    const ata = getAssociatedTokenAddressSync(campaignAccounts.mint, buyer.keypair.publicKey);
    const tradeAuth = derivePda(
      program.programId,
      "trade-auth",
      buyer.keypair.publicKey.toBuffer(),
      nonce,
    );
    const clusterProfile = derivePda(program.programId, "cluster", clusterId);
    let builder = program.methods
      .sellTokens({
        tokensIn: new BN(tokensIn.toString()),
        minLamportsOut: new BN(minOut.toString()),
        deadline: new BN(deadline),
        nonce: Array.from(nonce),
        routeProfile,
      })
      .accountsStrict({
        trader: buyer.keypair.publicKey,
        globalConfig,
        campaign: campaignAccounts.campaign,
        mint: campaignAccounts.mint,
        tokenVault: campaignAccounts.tokenVault,
        solVault: campaignAccounts.solVault,
        traderTokenAccount: ata,
        riskProfile: buyer.riskProfile,
        clusterProfile,
        tradeAuthorization: tradeAuth,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        feeEscrow: campaignAccounts.feeEscrow,
      });
    const sellIx = await builder.instruction();
    const sent = await sendProductionTrade({
      guardBetween: opts.guardBetween,
      label: `sell_tokens ${tokensIn}`,
      signer: buyer.keypair,
      ed25519,
      programIx: sellIx,
      recoverAccount: tradeAuth,
    });
    return { ...sent, tradeAuthorization: tradeAuth, nonce, deadline };
  }

  it("create → buy → buy → sell → buy → sell → close curve on the compiled SBF", async function () {
    creator = await setupWallet("creator");
    buyer = await setupWallet("buyer");
    assert.notEqual(creator.keypair.publicKey.toBase58(), buyer.keypair.publicKey.toBase58());

    const created = await sendCreate();
    const afterCreateInfo = await connection.getAccountInfo(campaignAccounts.campaign, "confirmed");
    assert.ok(afterCreateInfo, "campaign account missing after create");
    const afterCreate = decodeCampaign(afterCreateInfo.data);
    assert.equal(afterCreate.mintAuthorityRevoked, true);
    assert.equal(afterCreate.curveClosed, false);
    assert.equal(afterCreate.soldTokens.toString(), "0");
    assert.ok(created.logs.some((line) => /Instruction: CreateCampaign/i.test(line)));
    // Contract changed deliberately: create_campaign now initialises both fee
    // PDAs so a new campaign is tradeable the moment it exists. Leaving them to
    // the permissionless initializers meant every launch was rejected at the
    // trade preflight until an operator ran a backfill by hand.
    const escrowAfterCreate = await connection.getAccountInfo(campaignAccounts.feeEscrow, "confirmed");
    assert.ok(escrowAfterCreate, "CREATE must initialize FeeEscrow");
    assert.ok(escrowAfterCreate.data.length > 8, "FeeEscrow must be initialised, not just allocated");
    const creatorVaultAfterCreate = await connection.getAccountInfo(
      campaignAccounts.creatorFeeVault,
      "confirmed",
    );
    assert.ok(creatorVaultAfterCreate, "CREATE must initialize CreatorFeeVault");
    assert.ok(
      creatorVaultAfterCreate.data.length > 8,
      "CreatorFeeVault must be initialised, not just allocated",
    );

    async function snapshot() {
      const info = await connection.getAccountInfo(campaignAccounts.campaign, "confirmed");
      assert.ok(info, "campaign account missing");
      const campaign = decodeCampaign(info.data);
      const ata = getAssociatedTokenAddressSync(campaignAccounts.mint, buyer.keypair.publicKey);
      const token = await getAccount(connection, ata, "confirmed").catch(() => null);
      const vault = await connection.getBalance(campaignAccounts.solVault, "confirmed");
      const escrow = await connection.getBalance(campaignAccounts.feeEscrow, "confirmed");
      const creatorFeeVault = await connection.getBalance(campaignAccounts.creatorFeeVault, "confirmed");
      // The creator's entitlement is a counter on the vault, not its balance.
      // A trade must not move lamports into a second fee destination, so the
      // lamports stay in the escrow until claim_creator_fees pays them out.
      const creatorVaultInfo = await connection.getAccountInfo(
        campaignAccounts.creatorFeeVault,
        "confirmed",
      );
      const creatorPending = creatorVaultInfo
        ? creatorVaultInfo.data.readBigUInt64LE(8 + 32 + 32)
        : 0n;
      return {
        campaign,
        tokenAmount: token ? BigInt(token.amount.toString()) : 0n,
        vault,
        escrow,
        creatorFeeVault,
        creatorPending,
      };
    }

    function assertNoStackCrash(label, text) {
      assert.equal(
        /Access violation|stack frame|Program failed to complete/i.test(text),
        false,
        `${label} crashed the BPF stack:\
${text}`,
      );
    }

    async function expectProgramFail(label, fn, expected) {
      let text = "";
      try {
        await fn();
      } catch (error) {
        text = String(error);
      }
      assert.notEqual(text, "", `${label}: expected a program failure`);
      assertNoStackCrash(label, text);
      assert.ok(expected.test(text), `${label} failed for the wrong reason:\
${text}`);
    }

    async function rewardVaultSnapshot() {
      const out = {};
      for (const [name, pubkey] of Object.entries(rewardVaultKeys())) {
        out[name] = BigInt(await connection.getBalance(pubkey, "confirmed"));
      }
      return out;
    }

    async function txFeeLamports(signature) {
      const landed = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      assert.ok(landed?.meta, `${signature} missing transaction meta`);
      return BigInt(landed.meta.fee);
    }

    async function assertSellExactAccounting(tokensIn, label) {
      const beforeSnap = await snapshot();
      const sellerBefore = BigInt(
        await connection.getBalance(buyer.keypair.publicKey, "confirmed"),
      );
      const vaultsBefore = await rewardVaultSnapshot();
      const sold = await sendSell(tokensIn);
      // Sells route through the same accrue_fee_escrow, so they carry the same
      // risk of paying a second fee destination.
      await assertTradePaysOneFeeDestination(sold.signature, "sell");
      const afterSnap = await snapshot();
      const sellerAfter = BigInt(
        await connection.getBalance(buyer.keypair.publicKey, "confirmed"),
      );
      const vaultsAfter = await rewardVaultSnapshot();
      const feePaid = await txFeeLamports(sold.signature);
      const actualTradeAuthorizationPdaBalance = BigInt(
        await connection.getBalance(sold.tradeAuthorization, "confirmed"),
      );

      const gross =
        BigInt(beforeSnap.campaign.netRaisedLamports.toString()) -
        BigInt(afterSnap.campaign.netRaisedLamports.toString());
      const escrowFee = BigInt(afterSnap.escrow) - BigInt(beforeSnap.escrow);
      const creatorFee = BigInt(afterSnap.creatorFeeVault) - BigInt(beforeSnap.creatorFeeVault);
      // Same contract as the buy: one fee destination. The sum below would still
      // balance if the creator slice moved, so pin it explicitly.
      assert.equal(
        creatorFee,
        0n,
        `${label}: a sell must not move lamports into CreatorFeeVault; the creator is paid on claim`,
      );
      assert.equal(
        afterSnap.creatorPending,
        beforeSnap.creatorPending,
        `${label}: a sell must not touch CreatorFeeVault; the creator's slice is the escrow surplus`,
      );
      const fee = escrowFee + creatorFee;
      const net = gross - fee;
      assert.ok(gross > 0n, `${label}: gross must be > 0`);
      assert.equal(
        BigInt(beforeSnap.vault) - BigInt(afterSnap.vault),
        gross,
        `${label}: solVaultBefore - solVaultAfter must equal gross`,
      );
      assert.equal(
        fee,
        (gross * BigInt(SELL_FEE_BPS)) / 10000n,
        `${label}: FeeEscrow + CreatorFeeVault deltas must equal fee`,
      );
      assert.equal(net + fee, gross, `${label}: net + fee must equal gross`);
      assert.equal(
        sellerAfter + feePaid + actualTradeAuthorizationPdaBalance - sellerBefore,
        net,
        `${label}: sellerAfter + txFee + tradeAuthPdaBalance - sellerBefore must equal net`,
      );
      for (const name of Object.keys(vaultsBefore)) {
        assert.equal(
          vaultsAfter[name],
          vaultsBefore[name],
          `${label}: ${name} reward vault moved before flush`,
        );
      }
      after = afterSnap;
      return afterSnap;
    }

    // Previously a buy had to fail here, because create left the fee escrow
    // uninitialised and a keeper was expected to fill it in. That is exactly what
    // made every new campaign untradeable. The contract is now the opposite: a
    // campaign is tradeable the moment it is created, so assert that instead.
    const firstBuy = await sendBuy(BUY_LAMPORTS);
    assert.ok(firstBuy, "a freshly created campaign must accept a buy with no keeper step");
    await assertTradePaysOneFeeDestination(firstBuy.signature, "first buy");

    // A wallet must be able to guard this trade.
    //
    // Phantom brackets the instruction it protects with Lighthouse assertions.
    // While the program demanded the ed25519 instruction sit at
    // current_index - 1, an assertion landing between the two failed the trade
    // with InvalidTradeAuthorization -- so Phantom's guarded simulation failed,
    // it stripped every assertion, and it blocked the request as potentially
    // malicious with no balance preview. Measured on mainnet: guard before the
    // pair fine, guard after fine, guard between it Custom 6049 every time.
    // create escaped only because Phantom happened to place its nine
    // assertions outside the pair.
    const guardedBuy = await sendBuy(BUY_LAMPORTS, 0n, {
      guardBetween: SystemProgram.transfer({
        fromPubkey: buyer.keypair.publicKey,
        toPubkey: buyer.keypair.publicKey,
        lamports: 0,
      }),
    });
    assert.ok(guardedBuy, "a trade must survive a wallet inserting a guard before it");
    await assertTradePaysOneFeeDestination(guardedBuy.signature, "guarded buy");

    await initializeIfMissing(
      connection,
      campaignAccounts.feeEscrow,
      () =>
        program.methods
          .initializeFeeEscrow()
          .accountsStrict({
            payer: admin,
            campaign: campaignAccounts.campaign,
            feeEscrow: campaignAccounts.feeEscrow,
            systemProgram: SystemProgram.programId,
          })
          .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" }),
    );

    // create_campaign now creates both fee PDAs itself, so these permissionless
    // initializers are no-ops for new campaigns and only matter for ones created
    // before that change. Tolerate "already exists" rather than failing.
    await initializeIfMissing(
      connection,
      campaignAccounts.creatorFeeVault,
      () =>
        program.methods
          .initializeCreatorFeeVault()
          .accountsStrict({
            payer: admin,
            campaign: campaignAccounts.campaign,
            creatorFeeVault: campaignAccounts.creatorFeeVault,
            systemProgram: SystemProgram.programId,
          })
          .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" }),
    );

    const rewardsBefore = {};
    for (const [name, pubkey] of Object.entries(rewardVaultKeys())) {
      rewardsBefore[name] = BigInt(await connection.getBalance(pubkey, "confirmed"));
    }

    let before = await snapshot();
    await sendBuy(BUY_LAMPORTS);
    let after = await snapshot();
    assert.ok(BigInt(after.campaign.soldTokens.toString()) > BigInt(before.campaign.soldTokens.toString()));
    assert.ok(BigInt(after.campaign.netRaisedLamports.toString()) > BigInt(before.campaign.netRaisedLamports.toString()));
    assert.ok(after.tokenAmount > before.tokenAmount);
    const net1 = BigInt(after.campaign.netRaisedLamports.toString()) - BigInt(before.campaign.netRaisedLamports.toString());
    const spent1 = BigInt(after.vault) - BigInt(before.vault);
    assert.equal(spent1, net1, "buy net must stay in the campaign SOL vault");
    const expectedFee = (net1 * BigInt(BUY_FEE_BPS)) / 10000n;
    const escrowFee1 = BigInt(after.escrow) - BigInt(before.escrow);
    const creatorFeeLamports1 = BigInt(after.creatorFeeVault) - BigInt(before.creatorFeeVault);
    const creatorAccrued1 = after.creatorPending - before.creatorPending;
    // The WHOLE fee goes to one collector. It used to be split here, with the
    // creator's slice moved into a second account inside the trader's own
    // transaction -- usually dust, 980 lamports on a 0.001 SOL buy. Wallets read
    // that fan-out as a drain and stopped guarding trades entirely.
    assert.equal(
      escrowFee1,
      expectedFee,
      "the whole buy fee must land in the fee escrow, the single collector",
    );
    assert.equal(
      creatorFeeLamports1,
      0n,
      "a buy must not move lamports into CreatorFeeVault; the creator is paid on claim",
    );
    assert.equal(
      creatorAccrued1,
      0n,
      "a buy must not touch CreatorFeeVault at all; the creator's slice is the escrow surplus",
    );
    let routed = 0n;
    for (const [name, pubkey] of Object.entries(rewardVaultKeys())) {
      const nowBal = BigInt(await connection.getBalance(pubkey, "confirmed"));
      routed += nowBal - rewardsBefore[name];
    }
    assert.equal(routed, 0n, "reward vaults must not move until flush");
    assert.equal(after.campaign.paused, false);

    await program.methods
      .setCampaignPause(true)
      .accountsStrict({
        authority: admin,
        globalConfig,
        campaign: campaignAccounts.campaign,
      })
      .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" });
    await expectProgramFail("paused campaign buy", () => sendBuy(BUY_LAMPORTS), /CampaignPaused/);
    await program.methods
      .setCampaignPause(false)
      .accountsStrict({
        authority: admin,
        globalConfig,
        campaign: campaignAccounts.campaign,
      })
      .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" });

    // Risk/manual-review/cluster policy is enforced before the backend signs.
    // Keep an allowed non-empty cluster account in the transaction for account-list
    // compatibility, but do not re-run application policy inside the BPF hot path.
    const allowedClusterId = hash32("allowed-cluster");
    const allowedCluster = derivePda(program.programId, "cluster", allowedClusterId);
    await program.methods
      .syncClusterProfile({
        clusterId: Array.from(allowedClusterId),
        size: 2,
        riskLevel: 1,
        restricted: false,
      })
      .accountsStrict({
        authority: admin,
        globalConfig,
        clusterProfile: allowedCluster,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" });
    await program.methods
      .syncRiskProfile({
        wallet: buyer.keypair.publicKey,
        riskLevel: 0,
        restricted: false,
        clusterId: Array.from(allowedClusterId),
        manualReviewRequired: false,
      })
      .accountsStrict({
        authority: admin,
        globalConfig,
        riskProfile: buyer.riskProfile,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" });
    buyerClusterId = allowedClusterId;

    const recruiterBefore = BigInt(await connection.getBalance(rewardVaultKeys().recruiter, "confirmed"));
    const airdropBeforeLinked = BigInt(await connection.getBalance(rewardVaultKeys().airdrop, "confirmed"));
    const escrowBeforeLinked = BigInt(await connection.getBalance(campaignAccounts.feeEscrow, "confirmed"));
    await sendBuy(BUY_LAMPORTS, 0n, { routeProfile: 0 });
    const recruiterAfter = BigInt(await connection.getBalance(rewardVaultKeys().recruiter, "confirmed"));
    const airdropAfterLinked = BigInt(await connection.getBalance(rewardVaultKeys().airdrop, "confirmed"));
    const escrowAfterLinked = BigInt(await connection.getBalance(campaignAccounts.feeEscrow, "confirmed"));
    assert.ok(escrowAfterLinked > escrowBeforeLinked, "linked trade fee must accrue in FeeEscrow");
    assert.equal(recruiterAfter, recruiterBefore, "linked recruiter slice stays pending until flush");
    assert.equal(airdropAfterLinked, airdropBeforeLinked, "linked route must not fund airdrop");

    await sendBuy(BUY_LAMPORTS, 0n, { routeProfile: 2 });

    before = after;
    await sendBuy(BUY_LAMPORTS);
    after = await snapshot();
    assert.ok(after.tokenAmount > before.tokenAmount);

    const sellAmount = after.tokenAmount / 4n;
    assert.ok(sellAmount > 0n);
    before = after;
    await assertSellExactAccounting(sellAmount, "sell #1");

    before = await snapshot();
    await sendBuy(BUY_LAMPORTS);
    after = await snapshot();
    const sellAmount2 = after.tokenAmount / 5n;
    before = after;
    await assertSellExactAccounting(sellAmount2, "sell #2");
    after = await snapshot();
    assert.equal(after.campaign.curveClosed, false);

    const nowClose = await chainUnixTimestamp(connection);
    const shortAuth = await sendBuy(BUY_LAMPORTS, 0n, { deadline: nowClose + 3 });
    await expectProgramFail(
      "close trade-auth before deadline",
      () => program.methods
        .closeExpiredTradeAuthorization({ nonce: Array.from(shortAuth.nonce) })
        .accountsStrict({
          caller: admin,
          trader: buyer.keypair.publicKey,
          tradeAuthorization: shortAuth.tradeAuthorization,
        })
        .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" }),
      /TradeAuthorizationNotExpired|custom program error/i,
    );
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    const traderBeforeClose = BigInt(await connection.getBalance(buyer.keypair.publicKey, "confirmed"));
    const pdaBeforeClose = BigInt(await connection.getBalance(shortAuth.tradeAuthorization, "confirmed"));
    assert.ok(pdaBeforeClose > 0n, "expired trade-auth PDA must still hold rent");
    await program.methods
      .closeExpiredTradeAuthorization({ nonce: Array.from(shortAuth.nonce) })
      .accountsStrict({
        caller: admin,
        trader: buyer.keypair.publicKey,
        tradeAuthorization: shortAuth.tradeAuthorization,
      })
      .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" });
    const traderAfterClose = BigInt(await connection.getBalance(buyer.keypair.publicKey, "confirmed"));
    assert.equal(
      traderAfterClose - traderBeforeClose,
      pdaBeforeClose,
      "trader must receive exact TradeAuthorization rent",
    );
    assert.equal(
      await connection.getAccountInfo(shortAuth.tradeAuthorization, "confirmed"),
      null,
      "closed trade-auth account must be gone",
    );
    await expectProgramFail(
      "second trade-auth close",
      () => program.methods
        .closeExpiredTradeAuthorization({ nonce: Array.from(shortAuth.nonce) })
        .accountsStrict({
          caller: admin,
          trader: buyer.keypair.publicKey,
          tradeAuthorization: shortAuth.tradeAuthorization,
        })
        .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" }),
      /AccountNotInitialized|account is not initialized|InvalidTradeAuthorization|custom program error/i,
    );

    const nowSellClose = await chainUnixTimestamp(connection);
    const shortSell = await sendSell(after.tokenAmount / 10n, { deadline: nowSellClose + 3 });
    await expectProgramFail(
      "close SELL trade-auth with wrong trader",
      () => program.methods
        .closeExpiredTradeAuthorization({ nonce: Array.from(shortSell.nonce) })
        .accountsStrict({
          caller: admin,
          trader: creator.keypair.publicKey,
          tradeAuthorization: shortSell.tradeAuthorization,
        })
        .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" }),
      /ConstraintSeeds|InvalidTradeAuthorization|custom program error/i,
    );
    await expectProgramFail(
      "close SELL trade-auth with wrong PDA",
      () => program.methods
        .closeExpiredTradeAuthorization({ nonce: Array.from(shortSell.nonce) })
        .accountsStrict({
          caller: admin,
          trader: buyer.keypair.publicKey,
          tradeAuthorization: shortAuth.tradeAuthorization,
        })
        .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" }),
      /ConstraintSeeds|InvalidTradeAuthorization|AccountNotInitialized|custom program error/i,
    );
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    await program.methods
      .closeExpiredTradeAuthorization({ nonce: Array.from(shortSell.nonce) })
      .accountsStrict({
        caller: admin,
        trader: buyer.keypair.publicKey,
        tradeAuthorization: shortSell.tradeAuthorization,
      })
      .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" });
    await expectProgramFail(
      "replay expired BUY authorization",
      () => sendBuy(BUY_LAMPORTS, 0n, { deadline: shortAuth.deadline, nonce: shortAuth.nonce }),
      /TradeAuthorizationExpired|expired|simulation failed|custom program error/i,
    );

    await sendBuy(CLOSE_BUY_LAMPORTS, CLOSE_TARGET_LAMPORTS);
    after = await snapshot();
    assert.equal(after.campaign.curveClosed, true);

    const vaults = rewardVaultKeys();
    assert.ok(
      BigInt(after.escrow) > 0n,
      "FeeEscrow must still hold pending fees before flush / graduation",
    );
    const vaultBeforeFlush = {};
    for (const [name, pubkey] of Object.entries(vaults)) {
      vaultBeforeFlush[name] = BigInt(await connection.getBalance(pubkey, "confirmed"));
    }
    const escrowBeforeFlush = BigInt(await connection.getBalance(campaignAccounts.feeEscrow, "confirmed"));
    await program.methods
      .flushCampaignFees()
      .accountsStrict({
        caller: admin,
        campaign: campaignAccounts.campaign,
        feeEscrow: campaignAccounts.feeEscrow,
        weeklyLeagueVault: vaults.league,
        airdropVault: vaults.airdrop,
        monthlyLeagueVault: vaults.monthly,
        recruiterVault: vaults.recruiter,
        squadVault: vaults.squad,
        protocolVault: vaults.protocol,
      })
      .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" });
    let flushed = 0n;
    for (const [name, pubkey] of Object.entries(vaults)) {
      flushed += BigInt(await connection.getBalance(pubkey, "confirmed")) - vaultBeforeFlush[name];
    }
    const escrowAfterFlush = BigInt(await connection.getBalance(campaignAccounts.feeEscrow, "confirmed"));
    assert.ok(flushed > 0n, "flush must move pending fees into reward vaults");
    assert.equal(escrowBeforeFlush - escrowAfterFlush, flushed, "escrow drop must equal vault credits");
    await program.methods
      .flushCampaignFees()
      .accountsStrict({
        caller: admin,
        campaign: campaignAccounts.campaign,
        feeEscrow: campaignAccounts.feeEscrow,
        weeklyLeagueVault: vaults.league,
        airdropVault: vaults.airdrop,
        monthlyLeagueVault: vaults.monthly,
        recruiterVault: vaults.recruiter,
        squadVault: vaults.squad,
        protocolVault: vaults.protocol,
      })
      .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" });

    const vaultTokens = await getAccount(connection, campaignAccounts.tokenVault, "confirmed");
    const remainingCurve =
      after.campaign.curveTokenSupply - after.campaign.soldTokens;
    const expectedVault =
      remainingCurve + after.campaign.liquidityTokenSupply + after.campaign.reserveTokenSupply;
    assert.equal(
      BigInt(vaultTokens.amount.toString()),
      expectedVault,
      "token vault must still hold unsold curve + LP allocation + reserve",
    );
    assert.equal(
      BigInt(vaultTokens.amount.toString()) + after.tokenAmount,
      after.campaign.tokenTotalSupply,
      "vault + trader holdings must equal total supply",
    );

    const quote = graduationQuote(after.campaign);
    console.log("[sbf-gate] graduation quote", {
      netRaised: after.campaign.netRaisedLamports.toString(),
      finalizeFee: quote.finalizeFeeLamports.toString(),
      lpSol: quote.maxLiquidityLamports.toString(),
      lpTokens: quote.maxLiquidityTokens.toString(),
      creatorPayout: quote.creatorPayoutLamports.toString(),
      pool: deriveMeteoraPool(campaignAccounts.mint).toBase58(),
    });
    assert.ok(quote.maxLiquidityLamports > 0n, "LP SOL must be > 0");
    assert.ok(quote.maxLiquidityTokens > 0n, "LP tokens must be > 0");
    assert.ok(quote.maxLiquidityTokens <= after.campaign.liquidityTokenSupply);
    assert.ok(quote.finalizeFeeLamports + quote.maxLiquidityLamports + quote.creatorPayoutLamports
      === after.campaign.netRaisedLamports);

    const [poolA, poolB] = orderedPubkeys(campaignAccounts.mint, NATIVE_MINT);
    assert.ok(poolA.equals(campaignAccounts.mint) || poolA.equals(NATIVE_MINT));
    assert.ok(poolB.equals(campaignAccounts.mint) || poolB.equals(NATIVE_MINT));
    assert.notEqual(poolA.equals(poolB), true, "LP pair must be launch mint + SOL");

    let closedBuyFailed = false;
    try {
      await sendBuy(BUY_LAMPORTS, CLOSE_TARGET_LAMPORTS);
    } catch (error) {
      closedBuyFailed = /CurveClosed|simulation failed|custom program error/i.test(String(error));
    }
    assert.equal(closedBuyFailed, true, "buy after curve close must fail");
  });

  function bpsAmount(amount, bps) {
    return (BigInt(amount) * BigInt(bps)) / 10000n;
  }

  function graduationQuote(campaign) {
    const scale = 10n ** BigInt(campaign.tokenDecimals);
    const nano = 1_000_000_000n;
    const spot =
      BigInt(campaign.basePriceLamports) * nano
      + (BigInt(campaign.priceSlopeLamports) * BigInt(campaign.soldTokens)) / scale;
    const finalizeFee = bpsAmount(campaign.netRaisedLamports, campaign.finalizeFeeBps);
    const remaining = campaign.netRaisedLamports - finalizeFee;
    const targetLiquidity = bpsAmount(remaining, campaign.liquidityPostFinalizeBps);
    const desiredTokens = (targetLiquidity * scale * nano) / spot;
    const maxTokens = desiredTokens < campaign.liquidityTokenSupply
      ? desiredTokens
      : campaign.liquidityTokenSupply;
    const lpSol = desiredTokens <= campaign.liquidityTokenSupply
      ? targetLiquidity
      : (maxTokens * spot) / (scale * nano);
    return {
      spotNano: spot,
      finalizeFeeLamports: finalizeFee,
      maxLiquidityLamports: lpSol,
      maxLiquidityTokens: maxTokens,
      creatorPayoutLamports: remaining - lpSol,
    };
  }

  function orderedPubkeys(a, b) {
    return Buffer.compare(a.toBuffer(), b.toBuffer()) > 0 ? [a, b] : [b, a];
  }

  // The binding lives in scripts/solana/graduation-binding.cjs so the operator
  // and this suite compute the same digest from the same source. One copy living
  // only in a test is how the program reached schema 4 while its callers stayed
  // on schema 2 and every graduation was rejected.
  //
  // Declared before it is used: the two derive* aliases below used to sit above
  // this line, which put them in the temporal dead zone and threw
  // "Cannot access 'binding' before initialization" at load time. The whole file
  // failed to parse, so the bonding-lifecycle half of the local gate silently
  // stopped running.
  const binding = require("../../scripts/solana/graduation-binding.cjs");
  const deriveMeteoraPool = binding.deriveMeteoraPool;
  const deriveMeteoraPosition = binding.deriveMeteoraPosition;
  const nativeQuoteBinding = binding.nativeQuoteBinding;
  const graduationDigest = (input) =>
    binding.graduationDigest({ ...input, programId: program.programId });
  const beginGraduationArgs = (input) => binding.beginGraduationArgs(input, BN);



  it("begin_graduation our-side simulates without stack overflow (no Meteora LP)", async function () {
    assert.ok(campaignAccounts, "bonding lifecycle must create+close a campaign first");
    const adminKeypair = provider.wallet.payer;
    assert.ok(adminKeypair?.secretKey, "Anchor wallet must expose a local Keypair payer");

    await sendLegacy(
      adminKeypair,
      [
        SystemProgram.transfer({
          fromPubkey: adminKeypair.publicKey,
          toPubkey: campaignAccounts.feeEscrow,
          lamports: 1_000_000,
        }),
      ],
      "donateExtraEscrowLamports",
    );

    await program.methods
      .setPauseFlags({
        paused: false,
        createPaused: false,
        buyPaused: false,
        sellPaused: false,
        graduationPaused: false,
        claimsPaused: true,
      })
      .accountsStrict({ globalConfig, authority: admin })
      .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" });

    const nftMint = Keypair.generate();
    const pool = deriveMeteoraPool(campaignAccounts.mint);
    const position = deriveMeteoraPosition(nftMint.publicKey);
    const graduationState = derivePda(program.programId, "graduation", campaignAccounts.campaign.toBuffer());
    const authorityAta = getAssociatedTokenAddressSync(campaignAccounts.mint, admin);
    if (!(await connection.getAccountInfo(authorityAta, "confirmed"))) {
      const ataTx = new Transaction().add(
        createAssociatedTokenAccountInstruction(admin, authorityAta, admin, campaignAccounts.mint),
      );
      await simulateThenSend(ataTx, "createAuthorityAta", [adminKeypair]);
    }

    const campaign = decodeCampaign(
      (await connection.getAccountInfo(campaignAccounts.campaign, "confirmed")).data,
    );
    const now = await chainUnixTimestamp(connection);
    const deadline = now + 3_600;
    const nonce = hash32("graduation:lifecycle");
    const oraclePrice = 150_000_000n; // $150 / SOL
    const nativeTarget =
      (campaign.graduationTargetUsdMicros * 1_000_000_000n + oraclePrice - 1n) / oraclePrice;
    assert.equal(nativeTarget, CLOSE_TARGET_LAMPORTS);
    const quoteBinding = nativeQuoteBinding(oraclePrice);
    const digest = graduationDigest({
      quote: quoteBinding,
      generationConfig,
      campaign: campaignAccounts.campaign,
      mint: campaignAccounts.mint,
      authority: admin,
      graduationTargetUsdMicros: campaign.graduationTargetUsdMicros,
      nativeTargetLamports: nativeTarget,
      oraclePriceUsdMicros: oraclePrice,
      pool,
      position,
      nftMint: nftMint.publicKey,
      deadline,
      nonce,
      finalizeRouteProfile: ROUTE_PROFILE_UNLINKED,
    });

    const ed25519 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: routeSigner.secretKey,
      message: digest,
    });
    const beginIx = await program.methods
      .beginGraduation(
        beginGraduationArgs({
          quote: quoteBinding,
          nativeTargetLamports: nativeTarget,
          oraclePriceUsdMicros: oraclePrice,
          deadline,
          nonce,
          nftMint: nftMint.publicKey,
          finalizeRouteProfile: ROUTE_PROFILE_UNLINKED,
        }),
      )
      .accountsStrict({
        authority: admin,
        globalConfig,
        generationConfig,
        campaign: campaignAccounts.campaign,
        mint: campaignAccounts.mint,
        tokenVault: campaignAccounts.tokenVault,
        solVault: campaignAccounts.solVault,
        feeEscrow: campaignAccounts.feeEscrow,
        authorityTokenAccount: authorityAta,
        meteoraPool: pool,
        meteoraPosition: position,
        positionNftMint: nftMint.publicKey,
        graduationState,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const badNonce = hash32("graduation:bad-oracle");
    const badNative = 1n;
    const badDigest = graduationDigest({
      quote: nativeQuoteBinding(oraclePrice),
      generationConfig,
      campaign: campaignAccounts.campaign,
      mint: campaignAccounts.mint,
      authority: admin,
      graduationTargetUsdMicros: campaign.graduationTargetUsdMicros,
      nativeTargetLamports: badNative,
      oraclePriceUsdMicros: oraclePrice,
      pool,
      position,
      nftMint: nftMint.publicKey,
      deadline,
      nonce: badNonce,
      finalizeRouteProfile: ROUTE_PROFILE_UNLINKED,
    });
    const badEd25519 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: routeSigner.secretKey,
      message: badDigest,
    });
    const badBeginIx = await program.methods
      .beginGraduation({
        nativeTargetLamports: new BN(badNative.toString()),
        oraclePriceUsdMicros: new BN(oraclePrice.toString()),
        deadline: new BN(deadline),
        nonce: Array.from(badNonce),
        positionNftMint: nftMint.publicKey,
        finalizeRouteProfile: ROUTE_PROFILE_UNLINKED,
      })
      .accountsStrict({
        authority: admin,
        globalConfig,
        generationConfig,
        campaign: campaignAccounts.campaign,
        mint: campaignAccounts.mint,
        tokenVault: campaignAccounts.tokenVault,
        solVault: campaignAccounts.solVault,
        feeEscrow: campaignAccounts.feeEscrow,
        authorityTokenAccount: authorityAta,
        meteoraPool: pool,
        meteoraPosition: position,
        positionNftMint: nftMint.publicKey,
        graduationState,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const badTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
      badEd25519,
      badBeginIx,
    );
    const badSim = await simulateUnsigned(
      badTx,
      "begin_graduation mismatched USD native target",
      adminKeypair.publicKey,
    );
    assert.ok(badSim.err, "mismatched native_target × SOL/USD must fail");
    assert.ok(
      badSim.logs.some((line) => /InvalidGraduationTarget|custom program error/i.test(line)),
      `expected USD threshold rejection, got:\
${badSim.logs.join("\
")}`,
    );

    const beginOnly = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
      ed25519,
      beginIx,
    );
    const atomic = await simulateUnsigned(
      beginOnly,
      "begin_graduation without Meteora follow-up",
      adminKeypair.publicKey,
    );
    assert.ok(atomic.err, "begin_graduation must refuse to run without atomic Meteora+confirm");
    assert.ok(
      atomic.logs.some((line) => /BeginGraduation|GraduationAtomicity|custom program error/i.test(line)),
      `expected our graduation handler, got:\
${atomic.logs.join("\
")}`,
    );
    // A packed begin+Meteora+confirm tx is >1232 bytes locally without ALT.
    // Gate K uses the production V0+ALT envelope against the pinned DAMM v2 .so.
  });

  it("Gate K: graduate closed campaign into pinned DAMM v2 and swap", async function () {
    assert.ok(campaignAccounts, "bonding lifecycle must create+close a campaign first");
    const meteoraAccount = await connection.getAccountInfo(METEORA_CP_AMM, "confirmed");
    if (!meteoraAccount || !meteoraAccount.executable) {
      this.skip();
    }

    const adminKeypair = provider.wallet.payer;
    assert.ok(adminKeypair?.secretKey, "Anchor wallet must expose a local Keypair payer");
    assert.ok(v0Helpers && lookupTableAccount, "production V0/ALT envelope is not initialized");

    const sdk = await import("@meteora-ag/cp-amm-sdk");
    const {
      ActivationType,
      BaseFeeMode,
      CollectFeeMode,
      CpAmm,
      getBaseFeeParams,
      getSqrtPriceFromPrice,
      MAX_SQRT_PRICE,
      MIN_SQRT_PRICE,
    } = sdk;

    const campaign = decodeCampaign(
      (await connection.getAccountInfo(campaignAccounts.campaign, "confirmed")).data,
    );
    assert.equal(campaign.curveClosed, true);
    assert.equal(campaign.graduated, false);

    const authorityAta = getAssociatedTokenAddressSync(campaignAccounts.mint, admin);
    if (!(await connection.getAccountInfo(authorityAta, "confirmed"))) {
      const ataTx = new Transaction().add(
        createAssociatedTokenAccountInstruction(admin, authorityAta, admin, campaignAccounts.mint),
      );
      await simulateThenSend(ataTx, "gateKCreateAuthorityAta", [adminKeypair]);
    }
    const creatorAta = getAssociatedTokenAddressSync(campaignAccounts.mint, campaign.creator);
    if (!(await connection.getAccountInfo(creatorAta, "confirmed"))) {
      const ataTx = new Transaction().add(
        createAssociatedTokenAccountInstruction(admin, creatorAta, campaign.creator, campaignAccounts.mint),
      );
      await simulateThenSend(ataTx, "gateKCreateCreatorAta", [adminKeypair]);
    }

    const nftMint = Keypair.generate();
    const pool = deriveMeteoraPool(campaignAccounts.mint);
    const position = deriveMeteoraPosition(nftMint.publicKey);
    const graduationState = derivePda(program.programId, "graduation", campaignAccounts.campaign.toBuffer());
    const now = await chainUnixTimestamp(connection);
    const deadline = now + 3_600;
    const nonce = hash32("graduation:gate-k");
    const oraclePrice = 150_000_000n;
    const nativeTarget =
      (campaign.graduationTargetUsdMicros * 1_000_000_000n + oraclePrice - 1n) / oraclePrice;
    assert.equal(nativeTarget, CLOSE_TARGET_LAMPORTS);

    const quoteBinding = nativeQuoteBinding(oraclePrice);
    const digest = graduationDigest({
      quote: quoteBinding,
      generationConfig,
      campaign: campaignAccounts.campaign,
      mint: campaignAccounts.mint,
      authority: admin,
      graduationTargetUsdMicros: campaign.graduationTargetUsdMicros,
      nativeTargetLamports: nativeTarget,
      oraclePriceUsdMicros: oraclePrice,
      pool,
      position,
      nftMint: nftMint.publicKey,
      deadline,
      nonce,
      finalizeRouteProfile: ROUTE_PROFILE_UNLINKED,
    });
    const ed25519 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: routeSigner.secretKey,
      message: digest,
    });
    const beginIx = await program.methods
      .beginGraduation(
        beginGraduationArgs({
          quote: quoteBinding,
          nativeTargetLamports: nativeTarget,
          oraclePriceUsdMicros: oraclePrice,
          deadline,
          nonce,
          nftMint: nftMint.publicKey,
          finalizeRouteProfile: ROUTE_PROFILE_UNLINKED,
        }),
      )
      .accountsStrict({
        authority: admin,
        globalConfig,
        generationConfig,
        campaign: campaignAccounts.campaign,
        mint: campaignAccounts.mint,
        tokenVault: campaignAccounts.tokenVault,
        solVault: campaignAccounts.solVault,
        feeEscrow: campaignAccounts.feeEscrow,
        authorityTokenAccount: authorityAta,
        meteoraPool: pool,
        meteoraPosition: position,
        positionNftMint: nftMint.publicKey,
        graduationState,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const quote = graduationQuote(campaign);
    const cpAmm = new CpAmm(connection);
    const scale = 10n ** 18n;
    const whole = quote.spotNano / scale;
    const fraction = (quote.spotNano % scale).toString().padStart(18, "0").replace(/0+$/, "");
    const initialPrice = fraction ? `${whole}.${fraction}` : whole.toString();
    const initSqrtPrice = getSqrtPriceFromPrice(initialPrice, campaign.tokenDecimals, 9);
    const tokenAAmount = new BN(quote.maxLiquidityTokens.toString());
    const tokenBAmount = new BN(quote.maxLiquidityLamports.toString());
    const liquidityDelta = cpAmm.getLiquidityDelta({
      maxAmountTokenA: tokenAAmount,
      maxAmountTokenB: tokenBAmount,
      sqrtPrice: initSqrtPrice,
      sqrtMinPrice: MIN_SQRT_PRICE,
      sqrtMaxPrice: MAX_SQRT_PRICE,
      collectFeeMode: CollectFeeMode.BothToken,
    });
    const { tx: meteoraTx, pool: sdkPool, position: sdkPosition } = await cpAmm.createCustomPool({
      payer: admin,
      creator: admin,
      positionNft: nftMint.publicKey,
      tokenAMint: campaignAccounts.mint,
      tokenBMint: NATIVE_MINT,
      tokenAAmount,
      tokenBAmount,
      sqrtMinPrice: MIN_SQRT_PRICE,
      sqrtMaxPrice: MAX_SQRT_PRICE,
      liquidityDelta,
      initSqrtPrice,
      poolFees: {
        baseFee: getBaseFeeParams(
          {
            baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear,
            feeTimeSchedulerParam: {
              startingFeeBps: 25,
              endingFeeBps: 25,
              numberOfPeriod: 0,
              totalDuration: 0,
            },
          },
          9,
          ActivationType.Timestamp,
        ),
        compoundingFeeBps: 0,
        padding: 0,
        dynamicFee: null,
      },
      hasAlphaVault: false,
      activationType: ActivationType.Timestamp,
      collectFeeMode: CollectFeeMode.BothToken,
      activationPoint: null,
      tokenAProgram: TOKEN_PROGRAM_ID,
      tokenBProgram: TOKEN_PROGRAM_ID,
      isLockLiquidity: true,
    });
    assert.equal(sdkPool.toBase58(), pool.toBase58(), "SDK pool PDA must match program derivation");
    assert.equal(sdkPosition.toBase58(), position.toBase58(), "SDK position PDA must match program derivation");

    const confirmIx = await program.methods
      .confirmGraduation()
      .accountsStrict({
        authority: admin,
        globalConfig,
        campaign: campaignAccounts.campaign,
        mint: campaignAccounts.mint,
        tokenVault: campaignAccounts.tokenVault,
        solVault: campaignAccounts.solVault,
        authorityTokenAccount: authorityAta,
        creator: campaign.creator,
        creatorTokenAccount: creatorAta,
        creatorProfile: derivePda(program.programId, "creator", campaign.creator.toBuffer()),
        graduationState,
        meteoraPool: pool,
        meteoraPosition: position,
        meteoraTokenVault: PublicKey.findProgramAddressSync(
          [Buffer.from("token_vault"), campaignAccounts.mint.toBuffer(), pool.toBuffer()],
          METEORA_CP_AMM,
        )[0],
        meteoraNativeVault: PublicKey.findProgramAddressSync(
          [Buffer.from("token_vault"), NATIVE_MINT.toBuffer(), pool.toBuffer()],
          METEORA_CP_AMM,
        )[0],
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(remainingRewardAccounts())
      .instruction();

    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ed25519,
      beginIx,
      ...meteoraTx.instructions,
      confirmIx,
    ];

    const present = new Set(lookupTableAccount.state.addresses.map((item) => item.toBase58()));
    const missing = [];
    for (const ix of instructions) {
      for (const key of [ix.programId, ...(ix.keys || []).map((meta) => meta.pubkey)]) {
        const encoded = key.toBase58();
        if (present.has(encoded) || missing.some((item) => item.equals(key))) continue;
        missing.push(key);
      }
    }
    const payer = adminKeypair;
    for (let i = 0; i < missing.length; i += 20) {
      await sendLegacy(
        payer,
        [
          AddressLookupTableProgram.extendLookupTable({
            payer: payer.publicKey,
            authority: payer.publicKey,
            lookupTable: lookupTableAccount.key,
            addresses: missing.slice(i, i + 20),
          }),
        ],
        "gateKExtendAlt",
      );
    }
    if (missing.length) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      lookupTableAccount = (
        await connection.getAddressLookupTable(lookupTableAccount.key)
      ).value;
      assert.ok(lookupTableAccount, "ALT disappeared after Gate K extend");
    }

    const latest = await connection.getLatestBlockhash("confirmed");
    const versioned = v0Helpers.buildLaunchpadV0Transaction(web3, {
      payer: admin,
      recentBlockhash: latest.blockhash,
      instructions,
      lookupTableAccounts: [lookupTableAccount],
    });
    const stats = v0Helpers.inspectLaunchpadV0Envelope(web3, versioned, [lookupTableAccount]);
    assert.ok(stats.serializedBytes <= 1232, `Gate K graduation is ${stats.serializedBytes} bytes; hard max is 1232`);
    assert.ok(stats.requiredSigners >= 1 && stats.requiredSigners <= 2, `Gate K signers=${stats.requiredSigners}`);
    const decompiled = web3.TransactionMessage.decompile(versioned.message, {
      addressLookupTableAccounts: [lookupTableAccount],
    });
    const beginData = Buffer.from(beginIx.data);
    const beginIndex = decompiled.instructions.findIndex(
      (ix) => ix.programId.toBase58() === PROGRAM_ID && Buffer.from(ix.data).equals(beginData),
    );
    assert.ok(beginIndex > 0, "begin_graduation missing from V0 envelope");
    assert.equal(
      decompiled.instructions[beginIndex - 1].programId.toBase58(),
      Ed25519Program.programId.toBase58(),
      "Ed25519 must immediately precede begin_graduation",
    );
    const confirmIndex = decompiled.instructions.findIndex(
      (ix, index) => index > beginIndex && ix.programId.toBase58() === PROGRAM_ID,
    );
    assert.ok(confirmIndex > beginIndex, "confirm_graduation missing after begin_graduation");
    const meteoraBetween = decompiled.instructions
      .slice(beginIndex + 1, confirmIndex)
      .some((ix) => ix.programId.equals(METEORA_CP_AMM));
    assert.ok(meteoraBetween, "Meteora createCustomPool must sit between begin_graduation and confirm_graduation");
    versioned.sign([adminKeypair, nftMint]);
    const serialized = versioned.serialize();
    console.log(`[gate-k] graduation bytes=${serialized.length} v0Stats=${JSON.stringify(stats)}`);
    const simulation = await v0Helpers.simulateLaunchpadV0Transaction(connection, versioned);
    if (simulation.value.err) {
      throw new Error(
        `Gate K graduation simulation failed: ${JSON.stringify(simulation.value.err)}\
${(simulation.value.logs || []).join("\
")}`,
      );
    }
    const signature = await connection.sendRawTransaction(serialized, {
      skipPreflight: true,
      maxRetries: 5,
    });
    const confirmation = await connection.confirmTransaction(
      { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
      "confirmed",
    );
    if (confirmation.value.err) {
      throw new Error(`Gate K graduation landed with error: ${JSON.stringify(confirmation.value.err)}`);
    }

    const poolInfo = await connection.getAccountInfo(pool, "confirmed");
    assert.ok(poolInfo, "DAMM v2 pool must exist after graduation");
    assert.equal(poolInfo.owner.toBase58(), METEORA_CP_AMM.toBase58());
    const graduated = decodeCampaign(
      (await connection.getAccountInfo(campaignAccounts.campaign, "confirmed")).data,
    );
    assert.equal(graduated.graduated, true, "campaign must be graduated");

    const poolState = await cpAmm.fetchPoolState(pool);
    const buyerAta = getAssociatedTokenAddressSync(campaignAccounts.mint, buyer.keypair.publicKey);
    const sellAmount = (await getAccount(connection, buyerAta, "confirmed")).amount / 20n;
    assert.ok(sellAmount > 0n, "buyer must hold launch tokens to swap");
    const swapTx = await cpAmm.swap({
      payer: buyer.keypair.publicKey,
      pool,
      inputTokenMint: campaignAccounts.mint,
      outputTokenMint: NATIVE_MINT,
      amountIn: new BN(sellAmount.toString()),
      minimumAmountOut: new BN(1),
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAProgram: TOKEN_PROGRAM_ID,
      tokenBProgram: TOKEN_PROGRAM_ID,
      referralTokenAccount: null,
    });
    swapTx.feePayer = buyer.keypair.publicKey;
    const swapLatest = await connection.getLatestBlockhash("confirmed");
    swapTx.recentBlockhash = swapLatest.blockhash;
    swapTx.sign(buyer.keypair);
    const swapSig = await connection.sendRawTransaction(swapTx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });
    const swapConfirm = await connection.confirmTransaction(
      { signature: swapSig, ...swapLatest },
      "confirmed",
    );
    if (swapConfirm.value.err) {
      throw new Error(`Gate K DAMM v2 swap failed: ${JSON.stringify(swapConfirm.value.err)}`);
    }
    const stillGraduated = decodeCampaign(
      (await connection.getAccountInfo(campaignAccounts.campaign, "confirmed")).data,
    );
    assert.equal(stillGraduated.graduated, true);
    console.log(`[gate-k] GRADUATED ${signature} pool=${pool.toBase58()} swap=${swapSig}`);
  });

  it("Gate B: graduates a second campaign bound to a Token-2022 quote", async function () {
    const ORCA_WHIRLPOOL = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
    const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    const RPC_URL = connection.rpcEndpoint;
    const orca = await connection.getAccountInfo(ORCA_WHIRLPOOL, "confirmed");
    const meteora = await connection.getAccountInfo(METEORA_CP_AMM, "confirmed");
    if (!orca?.executable || !meteora?.executable) this.skip();

    const spl = require("@solana/spl-token");
    const orcaSdk = await import("@orca-so/whirlpools");
    const kit = await import("@solana/kit");
    const sdk = await import("@meteora-ag/cp-amm-sdk");
    const {
      ActivationType, BaseFeeMode, CollectFeeMode, CpAmm,
      getBaseFeeParams, getSqrtPriceFromPrice, MAX_SQRT_PRICE, MIN_SQRT_PRICE,
    } = sdk;

    const adminKeypair = provider.wallet.payer;
    assert.ok(adminKeypair?.secretKey, "Anchor wallet must expose a local Keypair payer");

    // A Token-2022 quote carrying only a metadata pointer: nothing that can
    // move a balance, so the binding is about the token program, not policy.
    const quoteMint = Keypair.generate();
    const quoteDecimals = 6;
    const mintSpace = spl.getMintLen([spl.ExtensionType.MetadataPointer]);
    const mintRent = await connection.getMinimumBalanceForRentExemption(mintSpace);
    // sendLegacy signs with the payer only, and the new mint account must sign
    // its own creation, so this one goes out directly.
    await (async () => {
      const latest = await connection.getLatestBlockhash("confirmed");
      const tx = new Transaction({ feePayer: adminKeypair.publicKey, recentBlockhash: latest.blockhash }).add(
      SystemProgram.createAccount({
        fromPubkey: adminKeypair.publicKey, newAccountPubkey: quoteMint.publicKey,
        space: mintSpace, lamports: mintRent, programId: spl.TOKEN_2022_PROGRAM_ID,
      }),
      spl.createInitializeMetadataPointerInstruction(quoteMint.publicKey, adminKeypair.publicKey, quoteMint.publicKey, spl.TOKEN_2022_PROGRAM_ID),
      spl.createInitializeMintInstruction(quoteMint.publicKey, quoteDecimals, adminKeypair.publicKey, null, spl.TOKEN_2022_PROGRAM_ID),
      );
      tx.sign(adminKeypair, quoteMint);
      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      const conf = await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
      if (conf.value.err) throw new Error(`gateBQuoteMint failed: ${JSON.stringify(conf.value.err)}`);
    })();

    const quoteUnits = 4_000_000n * 10n ** BigInt(quoteDecimals);
    const adminQuoteAta = spl.getAssociatedTokenAddressSync(quoteMint.publicKey, adminKeypair.publicKey, false, spl.TOKEN_2022_PROGRAM_ID);
    await sendLegacy(adminKeypair, [
      spl.createAssociatedTokenAccountInstruction(adminKeypair.publicKey, adminQuoteAta, adminKeypair.publicKey, quoteMint.publicKey, spl.TOKEN_2022_PROGRAM_ID),
      spl.createMintToInstruction(quoteMint.publicKey, adminQuoteAta, adminKeypair.publicKey, quoteUnits, [], spl.TOKEN_2022_PROGRAM_ID),
    ], "gateBQuoteSupply");

    // Wrap SOL for the pool's other side.
    const poolSol = 40n * 1_000_000_000n;
    const wsolAta = spl.getAssociatedTokenAddressSync(NATIVE_MINT, adminKeypair.publicKey, false, TOKEN_PROGRAM_ID);
    const wsolIxs = [];
    if (!(await connection.getAccountInfo(wsolAta, "confirmed"))) {
      wsolIxs.push(spl.createAssociatedTokenAccountInstruction(adminKeypair.publicKey, wsolAta, adminKeypair.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID));
    }
    wsolIxs.push(
      SystemProgram.transfer({ fromPubkey: adminKeypair.publicKey, toPubkey: wsolAta, lamports: Number(poolSol) }),
      spl.createSyncNativeInstruction(wsolAta, TOKEN_PROGRAM_ID),
    );
    await sendLegacy(adminKeypair, wsolIxs, "gateBWrapSol");

    await orcaSdk.setRpc(RPC_URL);
    const orcaFunder = await orcaSdk.setPayerFromBytes(adminKeypair.secretKey);
    orcaSdk.setNativeMintWrappingStrategy("ata");
    const [oMintA, oMintB] = orcaSdk.orderMints(kit.address(NATIVE_MINT.toBase58()), kit.address(quoteMint.publicKey.toBase58()));
    const wsolIsA = String(oMintA) === NATIVE_MINT.toBase58();
    // The binding declares $150/SOL and a $1 quote, so the pool must trade at
    // 150 quote units per SOL. Seeding it anywhere else makes the program's
    // deviation check reject the pool the graduation just created.
    const seedPrice = 150;
    const orcaPool = await orcaSdk.createConcentratedLiquidityPool(oMintA, oMintB, 64, {
      initialPrice: wsolIsA ? seedPrice : 1 / seedPrice,
      funder: orcaFunder,
      whirlpoolDeployment: orcaSdk.WhirlpoolDeployment.devnet,
    });
    await orcaPool.callback();
    const orcaPosition = await orcaSdk.openFullRangePosition(
      orcaPool.poolAddress,
      wsolIsA ? { tokenMaxA: poolSol, tokenMaxB: quoteUnits / 2n } : { tokenMaxA: quoteUnits / 2n, tokenMaxB: poolSol },
      { funder: orcaFunder, whirlpoolDeployment: orcaSdk.WhirlpoolDeployment.devnet },
    );
    await orcaPosition.callback();
    console.log(`[gate-b] orca pool ${String(orcaPool.poolAddress)} seeded`);

    // A fresh campaign: the first was consumed by the native graduation.
    creator = await setupWallet("creatorBound");
    buyer = await setupWallet("buyerBound");
    await sendCreate("bound-token2022");
    await sendBuy(CLOSE_BUY_LAMPORTS, CLOSE_TARGET_LAMPORTS);
    const closed = decodeCampaign((await connection.getAccountInfo(campaignAccounts.campaign, "confirmed")).data);
    assert.equal(closed.curveClosed, true, "second campaign must close its curve");
    assert.equal(closed.graduated, false);

    // begin_graduation refuses a campaign whose fee escrow still holds unflushed
    // fees, so the escrow is drained to the reward vaults first, exactly as the
    // operator does before a real graduation.
    const gateBVaults = rewardVaultKeys();
    await program.methods
      .flushCampaignFees()
      .accountsStrict({
        caller: admin,
        campaign: campaignAccounts.campaign,
        feeEscrow: campaignAccounts.feeEscrow,
        weeklyLeagueVault: gateBVaults.league,
        airdropVault: gateBVaults.airdrop,
        monthlyLeagueVault: gateBVaults.monthly,
        recruiterVault: gateBVaults.recruiter,
        squadVault: gateBVaults.squad,
        protocolVault: gateBVaults.protocol,
      })
      .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" });

    // Same $150/SOL the rest of the suite uses: the close buy is sized for the
    // native target that price implies, so a different price misses the threshold.
    const oraclePrice = 150_000_000n;
    const quote = graduationQuote(closed);
    const swapLamports = BigInt(quote.maxLiquidityLamports);

    // Quote the acquisition leg, then bind to exactly what it promised.
    const swapBuilt = await orcaSdk.swapInstructions(
      kit.createSolanaRpc(RPC_URL),
      { inputAmount: swapLamports, mint: kit.address(NATIVE_MINT.toBase58()) },
      orcaPool.poolAddress,
      { signer: orcaFunder, slippageToleranceBps: 300, whirlpoolDeployment: orcaSdk.WhirlpoolDeployment.devnet },
    );
    const expectedQuoteAmount = BigInt(swapBuilt.quote?.tokenEstOut ?? 0);
    const minQuoteAmount = BigInt(swapBuilt.quote?.tokenMinOut ?? 0);
    assert.ok(expectedQuoteAmount > 0n, "the Orca pool must quote the acquisition leg");
    console.log(`[gate-b] acquisition ${swapLamports} lamports -> ${expectedQuoteAmount} quote units`);

    const recoveryAta = spl.getAssociatedTokenAddressSync(quoteMint.publicKey, adminKeypair.publicKey, false, spl.TOKEN_2022_PROGRAM_ID);
    // Staging and creator accounts for the launch token, and the operator's
    // quote account the acquisition pays into.
    const adminStagingAta = spl.getAssociatedTokenAddressSync(campaignAccounts.mint, adminKeypair.publicKey, false, TOKEN_PROGRAM_ID);
    const creatorAta = spl.getAssociatedTokenAddressSync(campaignAccounts.mint, creator.keypair.publicKey, false, TOKEN_PROGRAM_ID);
    for (const [ata, owner] of [[adminStagingAta, adminKeypair.publicKey], [creatorAta, creator.keypair.publicKey]]) {
      if (!(await connection.getAccountInfo(ata, "confirmed"))) {
        await sendLegacy(adminKeypair, [
          spl.createAssociatedTokenAccountInstruction(adminKeypair.publicKey, ata, owner, campaignAccounts.mint, TOKEN_PROGRAM_ID),
        ], "gateBLaunchAtas");
      }
    }
    const quoteBinding = binding.boundQuoteBinding({
      quoteMint: quoteMint.publicKey,
      quoteDecimals,
      acquisitionProgram: ORCA_WHIRLPOOL,
      quoteRecoveryAccount: recoveryAta,
      expectedQuoteAmount,
      minQuoteAmount,
      quoteReferenceUsdMicros: 1_000_000n,
    });

    const nftMint = Keypair.generate();
    const pool = binding.deriveMeteoraPoolForQuote(campaignAccounts.mint, quoteMint.publicKey);
    const position = deriveMeteoraPosition(nftMint.publicKey);
    const nonce = crypto.randomBytes(32);
    const deadline = (await chainUnixTimestamp(connection)) + 600;
    const digestInput = {
      campaign: campaignAccounts.campaign, mint: campaignAccounts.mint, authority: admin,
      generationConfig,
      graduationTargetUsdMicros: closed.graduationTargetUsdMicros,
      nativeTargetLamports: binding.nativeTargetLamports(closed.graduationTargetUsdMicros, oraclePrice),
      oraclePriceUsdMicros: oraclePrice, pool, position, nftMint: nftMint.publicKey,
      deadline, nonce, finalizeRouteProfile: ROUTE_PROFILE_UNLINKED, quote: quoteBinding,
    };
    const digest = graduationDigest(digestInput);
    const ed25519 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: routeSigner.secretKey, message: digest,
    });

    const beginIx = await program.methods
      .beginGraduation(beginGraduationArgs(digestInput))
      .accountsStrict({
        authority: admin,
        globalConfig,
        generationConfig,
        campaign: campaignAccounts.campaign,
        mint: campaignAccounts.mint,
        tokenVault: campaignAccounts.tokenVault,
        solVault: campaignAccounts.solVault,
        feeEscrow: campaignAccounts.feeEscrow,
        authorityTokenAccount: adminStagingAta,
        meteoraPool: pool,
        meteoraPosition: position,
        positionNftMint: nftMint.publicKey,
        graduationState: derivePda(program.programId, "graduation", campaignAccounts.campaign.toBuffer()),
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    // Meteora's quote side runs on Token-2022 here; tokenAProgram stays classic
    // because the launch token is minted by the launchpad.
    const cpAmm = new CpAmm(connection);
    const maxTokens = BigInt(quote.maxLiquidityTokens);
    // Whole quote units per whole launch token: a raw ratio ignores decimals and
    // lands the pool at a price the drift check refuses.
    const tokenDecimals = Number(closed.tokenDecimals ?? 6);
    const wholeQuote = Number(expectedQuoteAmount) / 10 ** quoteDecimals;
    const wholeTokens = Number(maxTokens) / 10 ** tokenDecimals;
    const initialPrice = wholeQuote / wholeTokens;
    const initSqrtPrice = getSqrtPriceFromPrice(initialPrice.toFixed(18), tokenDecimals, quoteDecimals);
    const tokenAAmount = new BN(maxTokens.toString());
    const tokenBAmount = new BN(expectedQuoteAmount.toString());
    const liquidityDelta = cpAmm.getLiquidityDelta({
      maxAmountTokenA: tokenAAmount, maxAmountTokenB: tokenBAmount,
      sqrtPrice: initSqrtPrice, sqrtMinPrice: MIN_SQRT_PRICE, sqrtMaxPrice: MAX_SQRT_PRICE,
      collectFeeMode: CollectFeeMode.BothToken,
    });
    const { tx: meteoraTx, pool: sdkPool } = await cpAmm.createCustomPool({
      payer: admin, creator: admin, positionNft: nftMint.publicKey,
      tokenAMint: campaignAccounts.mint, tokenBMint: quoteMint.publicKey,
      tokenAAmount, tokenBAmount, sqrtMinPrice: MIN_SQRT_PRICE, sqrtMaxPrice: MAX_SQRT_PRICE,
      liquidityDelta, initSqrtPrice,
      poolFees: {
        baseFee: getBaseFeeParams(
          { baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear, feeTimeSchedulerParam: { startingFeeBps: 25, endingFeeBps: 25, numberOfPeriod: 0, totalDuration: 0 } },
          quoteDecimals, ActivationType.Timestamp,
        ),
        compoundingFeeBps: 0, padding: 0, dynamicFee: null,
      },
      hasAlphaVault: false, activationType: ActivationType.Timestamp,
      collectFeeMode: CollectFeeMode.BothToken, activationPoint: null,
      tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: spl.TOKEN_2022_PROGRAM_ID,
      isLockLiquidity: true,
    });
    assert.equal(sdkPool.toBase58(), pool.toBase58(), "SDK pool must match the derived bound pool");

    const vaultFor = (mint) => PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), mint.toBuffer(), pool.toBuffer()], METEORA_CP_AMM,
    )[0];

    // The quote prefix the program reads, then its token program because this
    // quote is Token-2022, then the reward vaults.
    const confirmIx = await program.methods
      .confirmGraduation()
      .accountsStrict({
        authority: admin,
        globalConfig,
        campaign: campaignAccounts.campaign,
        mint: campaignAccounts.mint,
        tokenVault: campaignAccounts.tokenVault,
        solVault: campaignAccounts.solVault,
        authorityTokenAccount: adminStagingAta,
        creator: creator.keypair.publicKey,
        creatorTokenAccount: creatorAta,
        creatorProfile: derivePda(program.programId, "creator", creator.keypair.publicKey.toBuffer()),
        graduationState: derivePda(program.programId, "graduation", campaignAccounts.campaign.toBuffer()),
        meteoraPool: pool,
        meteoraPosition: position,
        meteoraTokenVault: vaultFor(campaignAccounts.mint),
        meteoraNativeVault: vaultFor(quoteMint.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: quoteMint.publicKey, isWritable: false, isSigner: false },
        { pubkey: adminQuoteAta, isWritable: true, isSigner: false },
        { pubkey: recoveryAta, isWritable: true, isSigner: false },
        { pubkey: spl.TOKEN_2022_PROGRAM_ID, isWritable: false, isSigner: false },
        ...remainingRewardAccounts(),
      ])
      .instruction();

    console.log(
      `[gate-b] assembled: begin + ${swapBuilt.instructions.length} acquisition (setup split out) + ` +
      `${meteoraTx.instructions.length} meteora + confirm, quote=${quoteMint.publicKey.toBase58()}`,
    );
    assert.ok(swapBuilt.instructions.length > 0, "the acquisition leg must contribute instructions");
    assert.equal(
      confirmIx.keys.filter((k) => k.pubkey.equals(spl.TOKEN_2022_PROGRAM_ID)).length,
      1,
      "confirm_graduation must carry the Token-2022 program in the quote prefix",
    );
    assert.ok(
      confirmIx.keys.some((k) => k.pubkey.equals(vaultFor(quoteMint.publicKey))),
      "the Meteora quote vault must be the Token-2022 one",
    );
    // swapInstructions bundles account setup with the swap itself. Only the
    // Orca instruction has to share the transaction with Meteora -- the program
    // requires the signed acquisition program to appear before Meteora in the
    // same transaction -- so the setup goes out first and buys back the bytes
    // that otherwise push this envelope past the 1232-byte ceiling.
    const acquisitionAll = swapBuilt.instructions.map(toLegacyInstruction);
    const acquisitionSwap = acquisitionAll.filter((ix) => ix.programId.equals(ORCA_WHIRLPOOL));
    const acquisitionSetup = acquisitionAll.filter((ix) => !ix.programId.equals(ORCA_WHIRLPOOL));
    assert.ok(acquisitionSwap.length > 0, "the acquisition must contribute an Orca instruction");
    if (acquisitionSetup.length) {
      await sendLegacy(adminKeypair, acquisitionSetup, "gateBAcquisitionSetup");
      console.log(`[gate-b] acquisition setup sent separately (${acquisitionSetup.length} ix)`);
    }

    // createCustomPool bundles ATA creation with the pool instructions. Those
    // ATAs do not have to share the transaction with anything, and each one
    // costs an instruction header plus six account references inside an
    // envelope with almost no room. The operator already pre-creates them; this
    // does the same so the measured size is the one production sends.
    const meteoraSetup = meteoraTx.instructions.filter((ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
    const meteoraPacked = meteoraTx.instructions.filter((ix) => !ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
    if (meteoraSetup.length) {
      await sendLegacy(adminKeypair, meteoraSetup, "gateBMeteoraAtas");
      console.log(`[gate-b] meteora ATA setup sent separately (${meteoraSetup.length} ix)`);
    }

    // The acquisition must land before Meteora sees the quote, and the Ed25519
    // verification immediately before begin_graduation.
    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ed25519,
      beginIx,
      ...acquisitionSwap,
      ...meteoraPacked,
      confirmIx,
    ];

    const present = new Set(lookupTableAccount.state.addresses.map((item) => item.toBase58()));
    const missing = [];
    for (const ix of instructions) {
      for (const key of [ix.programId, ...(ix.keys || []).map((meta) => meta.pubkey)]) {
        if (present.has(key.toBase58()) || missing.some((item) => item.equals(key))) continue;
        missing.push(key);
      }
    }
    for (let i = 0; i < missing.length; i += 20) {
      await sendLegacy(adminKeypair, [
        AddressLookupTableProgram.extendLookupTable({
          payer: adminKeypair.publicKey, authority: adminKeypair.publicKey,
          lookupTable: lookupTableAccount.key, addresses: missing.slice(i, i + 20),
        }),
      ], "gateBExtendAlt");
    }
    if (missing.length) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      lookupTableAccount = (await connection.getAddressLookupTable(lookupTableAccount.key)).value;
      assert.ok(lookupTableAccount, "ALT disappeared after Gate B extend");
    }

    const latest = await connection.getLatestBlockhash("confirmed");
    const versioned = v0Helpers.buildLaunchpadV0Transaction(web3, {
      payer: admin, recentBlockhash: latest.blockhash, instructions,
      lookupTableAccounts: [lookupTableAccount],
    });
    const stats = v0Helpers.inspectLaunchpadV0Envelope(web3, versioned, [lookupTableAccount]);
    // This envelope sits two bytes under the hard limit, so anything that grows
    // it breaks graduation with a size error rather than a program error. Print
    // where the bytes actually go, so the next person tuning it is not guessing.
    const breakdown = instructions.map((ix) => ({
      program: ix.programId.toBase58().slice(0, 8),
      dataBytes: ix.data.length,
      accounts: (ix.keys || []).length,
    }));
    const dataTotal = breakdown.reduce((sum, item) => sum + item.dataBytes, 0);
    const accountRefs = breakdown.reduce((sum, item) => sum + item.accounts, 0);
    console.log(`[gate-b] bound graduation bytes=${stats.serializedBytes} signers=${stats.requiredSigners}`);
    console.log(`[gate-b] budget: ${stats.serializedBytes} total = ${stats.requiredSigners} sigs (${stats.requiredSigners * 64}B)` +
      ` + ${dataTotal}B instruction data + ${accountRefs} account refs + envelope`);
    for (const item of breakdown) {
      console.log(`[gate-b]   ${item.program}… data=${String(item.dataBytes).padStart(4)}B accounts=${String(item.accounts).padStart(3)}`);
    }
    // The payout accounts: 6 reward vaults on confirm plus the creator. Measured
    // so a decision to move them to a claim model is made on a real number.
    const rewardVaultSet = new Set(Object.values(rewardVaultKeys()).map((k) => k.toBase58()));
    const payoutRefs = confirmIx.keys.filter(
      (k) => rewardVaultSet.has(k.pubkey.toBase58()) || k.pubkey.equals(creator.keypair.publicKey),
    ).length;
    console.log(`[gate-b]   payout accounts on confirm: ${payoutRefs} (6 reward vaults + creator)`);

    // Measure, do not guess, what moving the payouts to a claim model would buy.
    // Built and sized only -- this variant is never sent, since the program
    // needs those accounts today.
    const confirmWithoutPayouts = new TransactionInstruction({
      programId: confirmIx.programId,
      data: confirmIx.data,
      keys: confirmIx.keys.filter(
        (k) => !rewardVaultSet.has(k.pubkey.toBase58()) && !k.pubkey.equals(creator.keypair.publicKey),
      ),
    });
    const leanEnvelope = v0Helpers.buildLaunchpadV0Transaction(web3, {
      payer: admin, recentBlockhash: latest.blockhash,
      instructions: [...instructions.slice(0, -1), confirmWithoutPayouts],
      lookupTableAccounts: [lookupTableAccount],
    });
    const leanStats = v0Helpers.inspectLaunchpadV0Envelope(web3, leanEnvelope, [lookupTableAccount]);
    console.log(
      `[gate-b]   if payouts moved to a claim model: ${leanStats.serializedBytes}B ` +
      `(saves ${stats.serializedBytes - leanStats.serializedBytes}B, headroom ${1232 - leanStats.serializedBytes}B)`,
    );

    // And what the signed args cost: four of begin_graduation's pubkeys name
    // accounts the transaction already carries, so a schema that read them from
    // accounts would trade 32 bytes of data for one account reference each.
    console.log(
      `[gate-b]   begin_graduation args=${beginIx.data.length}B of which 4 pubkeys (positionNftMint, ` +
      `quoteMint, acquisitionProgram, quoteRecoveryAccount) = 128B duplicate accounts already present`,
    );
    assert.ok(stats.serializedBytes <= 1232, `bound graduation is ${stats.serializedBytes} bytes; hard max is 1232`);

    versioned.sign([adminKeypair, nftMint]);
    const simulation = await v0Helpers.simulateLaunchpadV0Transaction(connection, versioned);
    if (simulation.value.err) {
      throw new Error(
        `Gate B bound graduation simulation failed: ${JSON.stringify(simulation.value.err)}\n` +
        (simulation.value.logs || []).slice(-25).join("\n"),
      );
    }
    const signature = await connection.sendRawTransaction(versioned.serialize(), { skipPreflight: false });
    const confirmation = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
    if (confirmation.value.err) {
      throw new Error(`Gate B bound graduation failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    const graduated = decodeCampaign((await connection.getAccountInfo(campaignAccounts.campaign, "confirmed")).data);
    assert.equal(graduated.graduated, true, "the campaign must be graduated");

    // The pool it graduated into must actually hold the Token-2022 quote.
    const quoteVault = await connection.getAccountInfo(vaultFor(quoteMint.publicKey), "confirmed");
    assert.ok(quoteVault, "the bound pool must have a quote vault");
    assert.equal(
      quoteVault.owner.toBase58(), spl.TOKEN_2022_PROGRAM_ID.toBase58(),
      "the bound pool's quote vault must be owned by Token-2022",
    );
    console.log(`[gate-b] BOUND GRADUATED ${signature} pool=${pool.toBase58()} quote=${quoteMint.publicKey.toBase58()}`);
  });
});
