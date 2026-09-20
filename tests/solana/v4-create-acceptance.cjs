"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

const anchor = require("@coral-xyz/anchor");
const {
  ComputeBudgetProgram,
  Ed25519Program,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
} = require("@solana/web3.js");
const MPL_TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
);

const {
  TOKEN_PROGRAM_ID,
  getAccount,
  getMint,
} = require("@solana/spl-token");

const {
  CREATE_AUTH_SCHEMA_VERSION,
  buildCreateAuthorizationPayload,
  createAuthorizationDigest,
} = require("./authorization-v4.cjs");
const {
  decodeCampaign,
  decodeCampaignSolVault,
} = require("./decode-campaign.cjs");

const {
  AnchorProvider,
  BN,
  Program,
  setProvider,
} = anchor;

const MAX_TRANSACTION_BYTES = 1_232;
const GRADUATION_TARGET_6_USD_MICROS = 6_000_000n;
const TOKEN_TOTAL_SUPPLY = 1_000_000_000_000n;
const TOKEN_DECIMALS = 6;
const CURVE_SUPPLY_BPS = 8_000;
const LIQUIDITY_SUPPLY_BPS = 1_000;
const CREATOR_BUY_LOCK_SECONDS = 86_400;
const CREATOR_BUY_CAP_BPS = 1_000;

function hash32(label) {
  return crypto.createHash("sha256").update(label, "utf8").digest();
}

function fixed32(value) {
  const buffer = Buffer.from(value);
  assert.equal(buffer.length, 32, "fixed32 values must contain 32 bytes");
  return Array.from(buffer);
}

function buffer32(value) {
  const buffer = Buffer.from(value);
  assert.equal(buffer.length, 32, "account field must contain 32 bytes");
  return buffer;
}

function bigintValue(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  return BigInt(value.toString());
}

function assertBigIntEqual(actual, expected, label) {
  assert.equal(bigintValue(actual), BigInt(expected), label);
}

function assertPublicKeyEqual(actual, expected, label) {
  assert.ok(new PublicKey(actual).equals(new PublicKey(expected)), label);
}

function assertBytesEqual(actual, expected, label) {
  assert.deepEqual(buffer32(actual), buffer32(expected), label);
}

function derivePda(programId, ...seeds) {
  return PublicKey.findProgramAddressSync(
    seeds.map((seed) => Buffer.from(seed)),
    programId,
  )[0];
}

async function chainUnixTimestamp(connection) {
  const slot = await connection.getSlot("confirmed");
  const blockTime = await connection.getBlockTime(slot);
  return blockTime ?? Math.floor(Date.now() / 1_000);
}

async function expectFailure(action, label) {
  let failure = null;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, `${label} unexpectedly succeeded`);
  return failure;
}

describe("MemeWarzone Solana authorization V4 local-validator acceptance", function () {
  this.timeout(1_000_000);

  const provider = AnchorProvider.env();
  setProvider(provider);

  const idlPath = path.resolve(
    __dirname,
    "../../target/idl/memewarzone_solana.json",
  );
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const idl = require(idlPath);
  const program = new Program(idl, provider);
  const connection = provider.connection;
  const admin = provider.wallet.publicKey;
  const routeSigner = Keypair.generate();

  const globalConfig = derivePda(program.programId, "global");
  const generationId = hash32("memewarzone-local-validator-generation-v4");
  const generationConfig = derivePda(
    program.programId,
    "generation",
    generationId,
  );
  const riskClusterId = hash32("memewarzone-local-validator-risk-cluster");
  const clusterProfile = derivePda(
    program.programId,
    "cluster",
    riskClusterId,
  );
  const declaredClusterHash = hash32("solana-local-validator-devnet-policy");

  let directScenario;

  function campaignAccounts(creator, args, overrides = {}) {
    const campaignId = Buffer.from(args.campaignId);
    const defaults = {
      campaign: derivePda(program.programId, "campaign", campaignId),
      mint: derivePda(program.programId, "campaign-mint", campaignId),
      tokenVault: derivePda(program.programId, "token-vault", campaignId),
      solVault: derivePda(program.programId, "sol-vault", campaignId),
      tokenProgram: TOKEN_PROGRAM_ID,
      tokenMetadataProgram: MPL_TOKEN_METADATA_PROGRAM_ID,
    };
    // Metaplex metadata PDA for the mint this create will produce.
    defaults.feeEscrow = PublicKey.findProgramAddressSync(
      [Buffer.from("fee-escrow", "utf8"), defaults.campaign.toBuffer()],
      program.programId,
    )[0];
    defaults.creatorFeeVault = PublicKey.findProgramAddressSync(
      [Buffer.from("creator-fee-vault", "utf8"), defaults.campaign.toBuffer()],
      program.programId,
    )[0];
    defaults.tokenMetadata = PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata", "utf8"),
        MPL_TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        defaults.mint.toBuffer(),
      ],
      MPL_TOKEN_METADATA_PROGRAM_ID,
    )[0];
    return { ...defaults, ...overrides };
  }

  function createArgs(label, now, options = {}) {
    const launchAt = options.launchAt ?? 0;
    const deadline = options.deadline ?? now + 3_600;
    return {
      campaignId: fixed32(hash32(`campaign:${label}`)),
      // Metaplex fields written on-chain. Trimmed to the program's caps so a long
      // label cannot fail the create for the wrong reason.
      name: options.name ?? `MWZ ${label}`.slice(0, 32),
      symbol: options.symbol ?? (label.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10).toUpperCase() || "MWZ"),
      metadataHash: fixed32(hash32(`metadata:${label}`)),
      // v7 dropped clusterHash, tickerHash, reservationIdHash,
      // reservationVersion and nonce. Each was 32 bytes of a transaction with
      // none to spare and none was ever read back on chain. The program now
      // derives clusterHash from its own schema domain and tickerHash from the
      // symbol it actually writes into the Metaplex metadata.
      launchAt: new BN(launchAt),
      graduationTargetUsdMicros: new BN(
        GRADUATION_TARGET_6_USD_MICROS.toString(),
      ),
      deadline: new BN(deadline),
    };
  }

  async function fundCreator(creator) {
    const sig = await connection.requestAirdrop(creator.publicKey, 3 * LAMPORTS_PER_SOL);
    const latest = await connection.getLatestBlockhash("confirmed");
    await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
  }

  async function setupCreator(label) {
    const creator = Keypair.generate();
    await fundCreator(creator);

    const creatorProfile = derivePda(
      program.programId,
      "creator",
      creator.publicKey.toBuffer(),
    );
    const riskProfile = derivePda(
      program.programId,
      "risk",
      creator.publicKey.toBuffer(),
    );

    await program.methods
      .syncCreatorProfile({
        wallet: creator.publicKey,
        tier: 1,
        trustScore: 7_000,
        liveBondingCount: 0,
        lastLaunchTimestamp: new BN(0),
        totalLaunches: new BN(0),
        successfulGraduations: new BN(0),
        restricted: false,
        manualReviewRequired: false,
        creatorBuyCapBps: CREATOR_BUY_CAP_BPS,
      })
      .accountsStrict({
        authority: admin,
        globalConfig,
        creatorProfile,
        systemProgram: SystemProgram.programId,
      })
      .rpc({
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });

    await program.methods
      .syncRiskProfile({
        wallet: creator.publicKey,
        riskLevel: 1,
        restricted: false,
        clusterId: fixed32(riskClusterId),
        manualReviewRequired: false,
      })
      .accountsStrict({
        authority: admin,
        globalConfig,
        riskProfile,
        systemProgram: SystemProgram.programId,
      })
      .rpc({
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });

    return {
      label,
      creator,
      creatorProfile,
      riskProfile,
    };
  }

  async function buildAuthorizationInput({
    creatorState,
    signedArgs,
    accounts,
  }) {
    const generation = await program.account.generationConfig.fetch(
      generationConfig,
    );
    const profile = await program.account.creatorProfile.fetch(
      creatorState.creatorProfile,
    );
    const risk = await program.account.riskProfile.fetch(
      creatorState.riskProfile,
    );

    return {
      programId: program.programId,
      generationConfigKey: generationConfig,
      generation,
      creator: creatorState.creator.publicKey,
      riskClusterId: risk.clusterId,
      creatorBuyLockSeconds: profile.creatorBuyLockSeconds,
      creatorBuyCapBps: profile.creatorBuyCapBps,
      campaign: accounts.campaign,
      mint: accounts.mint,
      tokenVault: accounts.tokenVault,
      solVault: accounts.solVault,
      tokenProgram: accounts.tokenProgram,
      args: signedArgs,
    };
  }

  async function sendAuthorizedCreate({
    creatorState,
    instructionArgs,
    signedArgs = instructionArgs,
    accountOverrides = {},
    signingKey = routeSigner,
    separateEd25519FromCreate = false,
  }) {
    const accounts = campaignAccounts(
      creatorState.creator,
      instructionArgs,
      accountOverrides,
    );
    const authorizationInput = await buildAuthorizationInput({
      creatorState,
      signedArgs,
      accounts,
    });
    const canonicalPayload = buildCreateAuthorizationPayload(
      authorizationInput,
    );
    const digest = createAuthorizationDigest(authorizationInput);
    assert.equal(digest.length, 32, "V4 route authorization must sign 32 bytes");

    const ed25519Instruction =
      Ed25519Program.createInstructionWithPrivateKey({
        privateKey: signingKey.secretKey,
        message: digest,
      });

    const createInstruction = await program.methods
      .createCampaign(instructionArgs)
      .accountsStrict({
        creator: creatorState.creator.publicKey,
        globalConfig,
        generationConfig,
        creatorProfile: creatorState.creatorProfile,
        riskProfile: creatorState.riskProfile,
        clusterProfile,
        campaign: accounts.campaign,
        mint: accounts.mint,
        tokenVault: accounts.tokenVault,
        solVault: accounts.solVault,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        feeEscrow: accounts.feeEscrow,
        creatorFeeVault: accounts.creatorFeeVault,
        tokenMetadata: accounts.tokenMetadata,
        tokenMetadataProgram: accounts.tokenMetadataProgram,
        tokenProgram: accounts.tokenProgram,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const transaction = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ed25519Instruction,
    );

    if (separateEd25519FromCreate) {
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: creatorState.creator.publicKey,
          toPubkey: admin,
          lamports: 1,
        }),
      );
    }

    transaction.add(createInstruction);

    const latestBlockhash = await connection.getLatestBlockhash("confirmed");
    transaction.feePayer = creatorState.creator.publicKey;
    transaction.recentBlockhash = latestBlockhash.blockhash;

    const unsignedBytes = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    assert.ok(
      unsignedBytes.length <= MAX_TRANSACTION_BYTES,
      `create transaction is ${unsignedBytes.length} bytes; maximum is ${MAX_TRANSACTION_BYTES}`,
    );

    // web3 1.95: legacy Transaction second arg must be Signer[] or omitted.
    // Simulate unsigned before sign — same order as production trade/create.
    const simulated = await connection.simulateTransaction(transaction);
    const simLogs = simulated.value.logs || [];
    const simSource = `${JSON.stringify(simulated.value.err)}\n${simLogs.join("\n")}`;
    if (/Access violation|stack frame|Program failed to complete/i.test(simSource)) {
      throw new Error(`create simulation hit BPF stack overflow:\n${simSource}`);
    }
    if (simulated.value.err) {
      throw new Error(`create simulation failed: ${simSource}`);
    }

    // v7 does the whole launch in one instruction -- a Metaplex CPI, a mint, a
    // token account, and three program accounts -- so compute is worth pinning.
    // Measured here at 181k-194k.
    //
    // 250k is a drift alarm, not the cliff. The implicit budget is
    // min(200k * instruction_count, 1.4M) and a create transaction carries the
    // ed25519 instruction too, so the floor is 400k; Phantom then replaces that
    // with an explicit SetComputeUnitLimit sized from its own simulation.
    //
    // The alarm sat at 200k and a measured run came in at 196,668 -- 1.7% clear,
    // which is a flaky test rather than a useful signal. 250k still catches any
    // real regression (this instruction has never exceeded 197k) without
    // tripping on ordinary variation between creators and name lengths.
    const unitsConsumed = simulated.value.unitsConsumed ?? 0;
    assert.ok(
      unitsConsumed > 0 && unitsConsumed < 250_000,
      `create consumed ${unitsConsumed} CU; investigate before it approaches the 400k floor`,
    );
    console.log(`      [create] ${unsignedBytes.length} bytes, ${unitsConsumed} CU`);

    transaction.sign(creatorState.creator);
    const rawTransaction = transaction.serialize();
    const signature = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: true,
      maxRetries: 3,
    });
    const confirmation = await connection.confirmTransaction(
      {
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      "confirmed",
    );
    if (confirmation.value.err) {
      throw new Error(
        `create transaction ${signature} failed: ${JSON.stringify(
          confirmation.value.err,
        )}`,
      );
    }

    return {
      accounts,
      canonicalPayloadLength: canonicalPayload.length,
      digest,
      rawTransactionLength: rawTransaction.length,
      signature,
    };
  }

  async function verifySuccessfulCreate({
    creatorState,
    args,
    result,
    expectedScheduledLaunch,
  }) {
    // Campaign / CampaignSolVault are UncheckedAccount in the program, so they
    // are not in the IDL `accounts` map. v7 creates no CreateAuthorization
    // account at all: replay is prevented by the campaign PDA, which cannot be
    // created twice for the same campaign_id.
    const [campaignInfo, solVaultAccount, metadataInfo, feeEscrowInfo, creatorVaultInfo, mintInfo] =
      await Promise.all([
        connection.getAccountInfo(result.accounts.campaign, "confirmed"),
        connection.getAccountInfo(result.accounts.solVault, "confirmed"),
        connection.getAccountInfo(result.accounts.tokenMetadata, "confirmed"),
        connection.getAccountInfo(result.accounts.feeEscrow, "confirmed"),
        connection.getAccountInfo(result.accounts.creatorFeeVault, "confirmed"),
        connection.getAccountInfo(result.accounts.mint, "confirmed"),
      ]);
    assert.ok(campaignInfo, "campaign account missing after create");
    assert.ok(solVaultAccount, "sol vault account missing after create");

    // The whole point of v7: one transaction leaves nothing to finish. A token
    // that is minted but unnamed, or has no fee escrow, is the exact state that
    // stranded launches on mainnet under v6.
    assert.ok(metadataInfo, "Metaplex metadata missing: create did not name the token");
    assert.ok(feeEscrowInfo, "fee escrow missing: the campaign cannot trade");
    assert.ok(creatorVaultInfo, "creator fee vault missing: the campaign cannot trade");
    assert.ok(mintInfo, "mint missing after create");
    assert.equal(
      mintInfo.data.readUInt32LE(0),
      0,
      "mint authority is still live: create did not revoke it",
    );

    const campaign = decodeCampaign(campaignInfo.data);
    const solVaultState = decodeCampaignSolVault(solVaultAccount.data);
    const mint = await getMint(
      connection,
      result.accounts.mint,
      "confirmed",
      TOKEN_PROGRAM_ID,
    );
    const tokenVault = await getAccount(
      connection,
      result.accounts.tokenVault,
      "confirmed",
      TOKEN_PROGRAM_ID,
    );
    const solVaultInfo = await connection.getAccountInfo(
      result.accounts.solVault,
      "confirmed",
    );

    assert.ok(result.canonicalPayloadLength > 500);
    assert.equal(result.digest.length, 32);
    assert.ok(result.rawTransactionLength <= MAX_TRANSACTION_BYTES);

    assertPublicKeyEqual(campaign.creator, creatorState.creator.publicKey);
    assertPublicKeyEqual(campaign.mint, result.accounts.mint);
    assertPublicKeyEqual(campaign.tokenVault, result.accounts.tokenVault);
    assertPublicKeyEqual(campaign.solVault, result.accounts.solVault);
    assertPublicKeyEqual(campaign.generationConfig, generationConfig);
    assertBytesEqual(campaign.campaignId, args.campaignId);
    // Derived in-program now, not carried. tickerHash binds the symbol that was
    // actually written into the Metaplex metadata, which the old 32-byte
    // argument could contradict.
    assertBytesEqual(campaign.tickerHash, hash32(args.symbol));
    assert.ok(
      Buffer.from(campaign.clusterHash).some((byte) => byte !== 0),
      "clusterHash must be a non-zero program constant",
    );
    assertBytesEqual(campaign.reservationIdHash, Buffer.alloc(32));
    assertBigIntEqual(campaign.reservationVersion, 0n);
    assertBigIntEqual(
      campaign.graduationTargetUsdMicros,
      GRADUATION_TARGET_6_USD_MICROS,
    );
    assertBigIntEqual(campaign.tokenTotalSupply, TOKEN_TOTAL_SUPPLY);
    assert.equal(campaign.tokenDecimals, TOKEN_DECIMALS);
    assert.equal(campaign.assetInitializationVersion, 1);
    assert.equal(campaign.mintAuthorityRevoked, true);
    assert.equal(campaign.graduated, false);
    assertBigIntEqual(campaign.soldTokens, 0n);
    assertBigIntEqual(campaign.netRaisedLamports, 0n);
    assertBigIntEqual(campaign.totalBuyVolumeLamports, 0n);
    assertBigIntEqual(campaign.totalSellVolumeLamports, 0n);
    assertBigIntEqual(campaign.creatorBoughtTokens, 0n);

    const expectedCurve =
      (TOKEN_TOTAL_SUPPLY * BigInt(CURVE_SUPPLY_BPS)) / 10_000n;
    const expectedLiquidity =
      (TOKEN_TOTAL_SUPPLY * BigInt(LIQUIDITY_SUPPLY_BPS)) / 10_000n;
    const expectedReserve =
      TOKEN_TOTAL_SUPPLY - expectedCurve - expectedLiquidity;
    assertBigIntEqual(campaign.curveTokenSupply, expectedCurve);
    assertBigIntEqual(campaign.liquidityTokenSupply, expectedLiquidity);
    assertBigIntEqual(campaign.reserveTokenSupply, expectedReserve);

    if (expectedScheduledLaunch === null) {
      assertBigIntEqual(campaign.launchAt, campaign.createdAt);
    } else {
      assertBigIntEqual(campaign.launchAt, BigInt(expectedScheduledLaunch));
    }
    assertBigIntEqual(
      campaign.creatorBuyLockUntil,
      bigintValue(campaign.launchAt) + BigInt(CREATOR_BUY_LOCK_SECONDS),
    );

    assert.equal(mint.supply, TOKEN_TOTAL_SUPPLY);
    assert.equal(mint.decimals, TOKEN_DECIMALS);
    assert.equal(mint.mintAuthority, null);
    assert.equal(mint.freezeAuthority, null);

    assert.equal(tokenVault.amount, TOKEN_TOTAL_SUPPLY);
    assertPublicKeyEqual(tokenVault.mint, result.accounts.mint);
    assertPublicKeyEqual(tokenVault.owner, result.accounts.campaign);

    assert.ok(solVaultInfo, "SOL vault account must exist");
    assertPublicKeyEqual(solVaultInfo.owner, program.programId);
    assertPublicKeyEqual(solVaultState.campaign, result.accounts.campaign);
    assertBytesEqual(solVaultState.generationId, generationId);

  }

  async function assertCampaignMissing(campaign) {
    const accountInfo = await connection.getAccountInfo(campaign, "confirmed");
    assert.equal(accountInfo, null, `failed campaign ${campaign} must not exist`);
  }

  async function ensureAdminSol() {
    const min = 50 * LAMPORTS_PER_SOL;
    const balance = await connection.getBalance(admin, "confirmed");
    if (balance >= min) return;
    const sig = await connection.requestAirdrop(admin, 100 * LAMPORTS_PER_SOL);
    const latest = await connection.getLatestBlockhash("confirmed");
    await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
    const after = await connection.getBalance(admin, "confirmed");
    assert.ok(after >= min, `admin ${admin.toBase58()} has ${after} lamports; local airdrop failed`);
  }

  before(async function () {
    // This gate was last run against v5; v6 shipped without it, and v6 shipped
    // three defects that a local validator would have caught in minutes.
    assert.equal(CREATE_AUTH_SCHEMA_VERSION, 7);
    await ensureAdminSol();

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
      .accountsStrict({
        admin,
        globalConfig,
        systemProgram: SystemProgram.programId,
      })
      .rpc({
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });

    await program.methods
      .lockSecurityDefaults()
      .accountsStrict({
        globalConfig,
        admin,
      })
      .rpc({
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });

    await program.methods
      .setPauseFlags({
        paused: false,
        createPaused: false,
        buyPaused: true,
        sellPaused: true,
        graduationPaused: true,
        claimsPaused: true,
      })
      .accountsStrict({
        globalConfig,
        authority: admin,
      })
      .rpc({
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });

    await program.methods
      .initializeGenerationConfig({
        generationId: fixed32(generationId),
        clusterKind: 1,
        allowedGraduationTierMask: 1,
        economicsVersion: 1,
        curveKind: 1,
        tokenTotalSupply: new BN(TOKEN_TOTAL_SUPPLY.toString()),
        tokenDecimals: TOKEN_DECIMALS,
        curveSupplyBps: CURVE_SUPPLY_BPS,
        liquidityTokenBps: LIQUIDITY_SUPPLY_BPS,
        basePriceLamports: new BN(1_000),
        priceSlopeLamports: new BN(10),
        buyFeeBps: 200,
        sellFeeBps: 200,
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
        manifestHash: fixed32(hash32("generation-manifest-v1")),
        routeAuthorizationRequired: true,
        authorizedTradingRequired: true,
      })
      .accountsStrict({
        authority: admin,
        globalConfig,
        generationConfig,
        systemProgram: SystemProgram.programId,
      })
      .rpc({
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });

    await program.methods
      .syncClusterProfile({
        clusterId: fixed32(riskClusterId),
        size: 2,
        riskLevel: 1,
        restricted: false,
      })
      .accountsStrict({
        authority: admin,
        globalConfig,
        clusterProfile,
        systemProgram: SystemProgram.programId,
      })
      .rpc({
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });
  });

  it("executes Direct Create and proves program-controlled asset state", async function () {
    const creatorState = await setupCreator("direct-create");
    const now = await chainUnixTimestamp(connection);
    const args = createArgs("direct-create", now);
    const result = await sendAuthorizedCreate({
      creatorState,
      instructionArgs: args,
    });

    await verifySuccessfulCreate({
      creatorState,
      args,
      result,
      expectedScheduledLaunch: null,
    });

    // Preserve the successful create fixture independently from the
    // unsolicited-transfer assertion so replay testing remains focused.
    directScenario = { creatorState, args, result };

    const balanceBefore = await connection.getBalance(
      result.accounts.solVault,
      "confirmed",
    );
    const transfer = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: creatorState.creator.publicKey,
        toPubkey: result.accounts.solVault,
        lamports: 50_000_000,
      }),
    );
    await provider.sendAndConfirm(
      transfer,
      [creatorState.creator],
      { commitment: "confirmed", preflightCommitment: "confirmed" },
    );
    const balanceAfter = await connection.getBalance(
      result.accounts.solVault,
      "confirmed",
    );
    assert.ok(balanceAfter > balanceBefore, "raw SOL-vault balance must increase");

    const campaignAfterInfo = await connection.getAccountInfo(
      result.accounts.campaign,
      "confirmed",
    );
    assert.ok(campaignAfterInfo, "campaign missing after unsolicited SOL transfer");
    const campaignAfterTransfer = decodeCampaign(campaignAfterInfo.data);
    assertBigIntEqual(
      campaignAfterTransfer.netRaisedLamports,
      0n,
      "unsolicited SOL must not alter net-raised accounting",
    );
  });

  it("executes the Draft Deploy Now path with the same one-signature create model", async function () {
    const creatorState = await setupCreator("draft-deploy-now");
    const now = await chainUnixTimestamp(connection);
    const args = createArgs("draft-deploy-now", now);
    const result = await sendAuthorizedCreate({
      creatorState,
      instructionArgs: args,
    });

    await verifySuccessfulCreate({
      creatorState,
      args,
      result,
      expectedScheduledLaunch: null,
    });
  });

  it("executes Countdown Create and stores the immutable future launch time", async function () {
    const creatorState = await setupCreator("countdown-create");
    const now = await chainUnixTimestamp(connection);
    const launchAt = now + 600;
    const args = createArgs("countdown-create", now, { launchAt });
    const result = await sendAuthorizedCreate({
      creatorState,
      instructionArgs: args,
    });

    await verifySuccessfulCreate({
      creatorState,
      args,
      result,
      expectedScheduledLaunch: launchAt,
    });
  });

  it("rejects an authorization signed by the wrong route signer", async function () {
    const creatorState = await setupCreator("wrong-route-signer");
    const now = await chainUnixTimestamp(connection);
    const args = createArgs("wrong-route-signer", now);
    const accounts = campaignAccounts(creatorState.creator, args);

    await expectFailure(
      () =>
        sendAuthorizedCreate({
          creatorState,
          instructionArgs: args,
          signingKey: Keypair.generate(),
        }),
      "wrong route signer",
    );
    await assertCampaignMissing(accounts.campaign);
  });

  it("rejects any campaign field modified after the digest was signed", async function () {
    const creatorState = await setupCreator("modified-payload");
    const now = await chainUnixTimestamp(connection);
    const signedArgs = createArgs("modified-payload", now);
    // The name is the field an attacker actually wants: revocation is
    // irreversible, so whatever create writes is what every wallet shows
    // forever. It is bound into the digest precisely so this fails.
    const instructionArgs = {
      ...signedArgs,
      name: "Renamed After Signing",
    };
    const accounts = campaignAccounts(creatorState.creator, instructionArgs);

    await expectFailure(
      () =>
        sendAuthorizedCreate({
          creatorState,
          instructionArgs,
          signedArgs,
        }),
      "modified signed campaign payload",
    );
    await assertCampaignMissing(accounts.campaign);
  });

  it("rejects expired create authorizations", async function () {
    const creatorState = await setupCreator("expired-authorization");
    const now = await chainUnixTimestamp(connection);
    const args = createArgs("expired-authorization", now, {
      deadline: now - 1,
    });
    const accounts = campaignAccounts(creatorState.creator, args);

    await expectFailure(
      () => sendAuthorizedCreate({ creatorState, instructionArgs: args }),
      "expired authorization",
    );
    await assertCampaignMissing(accounts.campaign);
  });

  it("requires the Ed25519 verification instruction immediately before create", async function () {
    const creatorState = await setupCreator("non-adjacent-ed25519");
    const now = await chainUnixTimestamp(connection);
    const args = createArgs("non-adjacent-ed25519", now);
    const accounts = campaignAccounts(creatorState.creator, args);

    await expectFailure(
      () =>
        sendAuthorizedCreate({
          creatorState,
          instructionArgs: args,
          separateEd25519FromCreate: true,
        }),
      "non-adjacent Ed25519 instruction",
    );
    await assertCampaignMissing(accounts.campaign);
  });

  it("rejects an alternate mint even when that address is digest-bound", async function () {
    const creatorState = await setupCreator("alternate-mint");
    const now = await chainUnixTimestamp(connection);
    const args = createArgs("alternate-mint", now);
    const alternateMint = Keypair.generate().publicKey;
    const accounts = campaignAccounts(creatorState.creator, args, {
      mint: alternateMint,
    });

    await expectFailure(
      () =>
        sendAuthorizedCreate({
          creatorState,
          instructionArgs: args,
          accountOverrides: { mint: alternateMint },
        }),
      "alternate mint PDA",
    );
    await assertCampaignMissing(accounts.campaign);
  });

  it("rejects a noncanonical token program even when it is digest-bound", async function () {
    const creatorState = await setupCreator("wrong-token-program");
    const now = await chainUnixTimestamp(connection);
    const args = createArgs("wrong-token-program", now);
    const accounts = campaignAccounts(creatorState.creator, args, {
      tokenProgram: SystemProgram.programId,
    });

    await expectFailure(
      () =>
        sendAuthorizedCreate({
          creatorState,
          instructionArgs: args,
          accountOverrides: { tokenProgram: SystemProgram.programId },
        }),
      "noncanonical token program",
    );
    await assertCampaignMissing(accounts.campaign);
  });

  it("rejects replay of an authorization whose campaign already exists", async function () {
    assert.ok(directScenario, "Direct Create scenario must run before replay test");
    const { creatorState, args: originalArgs } = directScenario;

    // v7 creates no create_authorization PDA, so replay protection is no longer
    // a dedicated account -- it is the campaign PDA itself, which is seeded by
    // campaign_id and cannot be created twice. Re-sending a create that already
    // landed must fail on the account, not on a nonce.
    const replayAccounts = campaignAccounts(creatorState.creator, originalArgs);
    const existing = await connection.getAccountInfo(replayAccounts.campaign, "confirmed");
    assert.ok(existing, "the original campaign must still exist for this to test replay");

    await expectFailure(
      () =>
        sendAuthorizedCreate({
          creatorState,
          instructionArgs: originalArgs,
        }),
      "replayed authorization",
    );

    // The original campaign must survive the rejected replay untouched.
    const after = await connection.getAccountInfo(replayAccounts.campaign, "confirmed");
    assert.ok(after, "replay must not destroy the campaign it collided with");
    assert.deepEqual(
      Buffer.from(after.data),
      Buffer.from(existing.data),
      "a rejected replay must leave the existing campaign byte-identical",
    );
  });
});
