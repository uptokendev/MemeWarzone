"use strict";

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
  TransactionMessage,
  VersionedTransaction,
} = web3;
const {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} = require("@solana/spl-token");
const {
  createAuthorizationDigest,
} = require("./authorization-v4.cjs");
const { decodeCampaign } = require("./decode-campaign.cjs");

const { AnchorProvider, BN, Program, Wallet } = anchor;
const ROOT = path.resolve(__dirname, "../..");
const IDL_PATH = path.join(ROOT, "target/idl/memewarzone_solana.json");
const MANIFEST_PATH = path.join(ROOT, "config/solana/devnet-generation-v3.json");
const PROGRAM_ID = new PublicKey("3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt");
const REWARDS_TREASURY = new PublicKey("2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX");
const EXPECTED_DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const TRADE_AUTH_DOMAIN = Buffer.from("MEMEWARZONE_SOLANA_TRADE_V1", "utf8");
const TRADE_AUTH_SCHEMA_VERSION = 3;
const TRADE_SIDE_BUY = 1;
const ROUTE_PROFILE_UNLINKED = 1;
const GRADUATION_TARGET_USD_MICROS = 6_000_000n;
const CLOSE_BUY_LAMPORTS = 50_000_000n;
const CLOSE_TARGET_LAMPORTS = 40_000_000n;
const OUTPUT = process.env.SOLANA_GRADUATION_FIXTURE_OUTPUT || "/tmp/mwz-solana-devnet-graduation-fixture.json";

function fail(message) {
  throw new Error(`[devnet-graduation-fixture] ${message}`);
}
function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) fail(`${name} is required`);
  return value;
}
function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) fail(`${label} not found: ${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
function loadKeypair(filePath, label) {
  const parsed = readJson(filePath, label);
  if (!Array.isArray(parsed) || parsed.length !== 64) fail(`${label} must be a 64-byte Solana JSON keypair`);
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}
function hash32(value) {
  return crypto.createHash("sha256").update(value).digest();
}
function fixed32(value) {
  return Array.from(Buffer.from(value));
}
function derivePda(programId, ...seeds) {
  return PublicKey.findProgramAddressSync(
    seeds.map((seed) => (Buffer.isBuffer(seed) ? seed : Buffer.from(seed))),
    programId,
  )[0];
}
function u16le(value) {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value, 0);
  return out;
}
function u64le(value) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value), 0);
  return out;
}
function i64le(value) {
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(BigInt(value), 0);
  return out;
}
function sameBytes(left, right) {
  return Buffer.from(left).equals(Buffer.from(right));
}
async function chainUnixTimestamp(connection) {
  const slot = await connection.getSlot("confirmed");
  return (await connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
}
function tradeDigest({ campaign, mint, trader, amountIn, minOut, deadline, nonce, nativeTargetLamports }) {
  return crypto
    .createHash("sha256")
    .update(
      Buffer.concat([
        TRADE_AUTH_DOMAIN,
        u16le(TRADE_AUTH_SCHEMA_VERSION),
        PROGRAM_ID.toBuffer(),
        campaign.toBuffer(),
        mint.toBuffer(),
        trader.toBuffer(),
        Buffer.from([TRADE_SIDE_BUY]),
        u64le(amountIn),
        u64le(minOut),
        i64le(deadline),
        Buffer.from(nonce),
        u64le(nativeTargetLamports),
        Buffer.from([ROUTE_PROFILE_UNLINKED]),
      ]),
    )
    .digest();
}
function rewardVaultKeys() {
  return ["league_vault", "airdrop_vault", "monthly_league_vault", "recruiter_vault", "squad_vault", "protocol_vault"].map(
    (seed) => derivePda(REWARDS_TREASURY, seed),
  );
}
function altPlan(globalConfig) {
  return [
    PROGRAM_ID,
    globalConfig,
    Ed25519Program.programId,
    ComputeBudgetProgram.programId,
    SYSVAR_INSTRUCTIONS_PUBKEY,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    SystemProgram.programId,
    REWARDS_TREASURY,
    ...rewardVaultKeys(),
  ];
}
async function sendLegacy(connection, payer, instructions, signers = [payer]) {
  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: latest.blockhash }).add(...instructions);
  tx.sign(...signers);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
  const confirmation = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (confirmation.value.err) fail(`transaction ${signature} failed: ${JSON.stringify(confirmation.value.err)}`);
  return signature;
}
async function fund(connection, operator, recipient, lamports) {
  return sendLegacy(
    connection,
    operator,
    [SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: recipient, lamports })],
  );
}
async function createTempAlt(connection, operator, globalConfig) {
  const slot = await connection.getSlot("confirmed");
  const [createIx, address] = AddressLookupTableProgram.createLookupTable({
    authority: operator.publicKey,
    payer: operator.publicKey,
    recentSlot: Math.max(0, slot - 1),
  });
  await sendLegacy(connection, operator, [createIx]);
  const addresses = altPlan(globalConfig);
  for (let i = 0; i < addresses.length; i += 20) {
    await sendLegacy(connection, operator, [
      AddressLookupTableProgram.extendLookupTable({
        payer: operator.publicKey,
        authority: operator.publicKey,
        lookupTable: address,
        addresses: addresses.slice(i, i + 20),
      }),
    ]);
  }
  for (let i = 0; i < 20; i += 1) {
    const table = (await connection.getAddressLookupTable(address)).value;
    const currentSlot = await connection.getSlot("confirmed");
    const lastExtendedSlot = table ? Number(table.state.lastExtendedSlot || 0) : Number.MAX_SAFE_INTEGER;
    if (
      table &&
      currentSlot > lastExtendedSlot &&
      addresses.every((key) => table.state.addresses.some((entry) => entry.equals(key)))
    ) {
      return table;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  fail(`temporary ALT ${address.toBase58()} did not become active/readable in time`);
}
function pauseSnapshot(global) {
  return {
    paused: Boolean(global.paused),
    createPaused: Boolean(global.createPaused),
    buyPaused: Boolean(global.buyPaused),
    sellPaused: Boolean(global.sellPaused),
    graduationPaused: Boolean(global.graduationPaused),
    claimsPaused: Boolean(global.claimsPaused),
  };
}

async function main() {
  const rpcUrl = String(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com").trim();
  const operator = loadKeypair(requiredEnv("SOLANA_OPERATOR_KEYPAIR"), "operator keypair");
  const routeSigner = loadKeypair(requiredEnv("SOLANA_NEW_ROUTE_SIGNER_KEYPAIR"), "route signer keypair");
  const idl = readJson(IDL_PATH, "launchpad IDL");
  const manifest = readJson(MANIFEST_PATH, "devnet V3 manifest");
  const connection = new web3.Connection(rpcUrl, "confirmed");
  if ((await connection.getGenesisHash()) !== EXPECTED_DEVNET_GENESIS) fail("refusing to create fixture outside Solana devnet");
  const provider = new AnchorProvider(connection, new Wallet(operator), { commitment: "confirmed", preflightCommitment: "confirmed" });
  anchor.setProvider(provider);
  const program = new Program(idl, provider);
  if (!program.programId.equals(PROGRAM_ID)) fail(`IDL program mismatch: ${program.programId.toBase58()}`);

  const globalConfig = derivePda(PROGRAM_ID, "global");
  const global = await program.account.globalConfig.fetch(globalConfig);
  if (!new PublicKey(global.admin).equals(operator.publicKey)) fail(`operator ${operator.publicKey.toBase58()} is not GlobalConfig.admin`);
  if (!new PublicKey(global.routeSigner).equals(routeSigner.publicKey)) fail(`GlobalConfig.routeSigner ${global.routeSigner.toBase58()} != supplied route signer ${routeSigner.publicKey.toBase58()}`);

  const generationId = hash32(manifest.generationIdSeed);
  if (!sameBytes(global.activeGenerationId, generationId)) fail("devnet V3 generation is not the active creation generation");
  const generationConfig = derivePda(PROGRAM_ID, "generation", generationId);
  const generation = await program.account.generationConfig.fetch(generationConfig);
  if (Number(generation.economicsVersion) !== 3 || Number(generation.dexAdapter) !== 1) fail("active generation is not Economics V3 + Meteora");
  if (!generation.activeCreation || !generation.supportEnabled) fail("devnet V3 generation is not active/supported");

  const clusterId = hash32(manifest.riskClusterIdSeed);
  const clusterProfile = derivePda(PROGRAM_ID, "cluster", clusterId);
  const cluster = await program.account.clusterProfile.fetch(clusterProfile);
  if (cluster.restricted) fail("devnet acceptance cluster is restricted");

  const balance = await connection.getBalance(operator.publicKey, "confirmed");
  if (balance < 500_000_000) fail(`operator needs at least 0.5 devnet SOL for disposable fixture; current balance=${balance / LAMPORTS_PER_SOL} SOL`);

  const originalPause = pauseSnapshot(global);
  const creator = Keypair.generate();
  const buyer = Keypair.generate();
  let restored = false;
  try {
    await program.methods
      .setPauseFlags({ ...originalPause, paused: false, createPaused: false, buyPaused: false })
      .accountsStrict({ globalConfig, authority: operator.publicKey })
      .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" });

    await fund(connection, operator, creator.publicKey, 200_000_000);
    await fund(connection, operator, buyer.publicKey, 120_000_000);

    const creatorProfile = derivePda(PROGRAM_ID, "creator", creator.publicKey.toBuffer());
    const creatorRisk = derivePda(PROGRAM_ID, "risk", creator.publicKey.toBuffer());
    const buyerRisk = derivePda(PROGRAM_ID, "risk", buyer.publicKey.toBuffer());
    await program.methods
      .syncCreatorProfile({
        wallet: creator.publicKey,
        tier: 1,
        trustScore: 7000,
        liveBondingCount: 0,
        lastLaunchTimestamp: new BN(0),
        totalLaunches: new BN(0),
        successfulGraduations: new BN(0),
        restricted: false,
        manualReviewRequired: false,
        creatorBuyCapBps: 1000,
      })
      .accountsStrict({ authority: operator.publicKey, globalConfig, creatorProfile, systemProgram: SystemProgram.programId })
      .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" });
    for (const [wallet, riskProfile] of [[creator.publicKey, creatorRisk], [buyer.publicKey, buyerRisk]]) {
      await program.methods
        .syncRiskProfile({ wallet, riskLevel: 0, restricted: false, clusterId: fixed32(clusterId), manualReviewRequired: false })
        .accountsStrict({ authority: operator.publicKey, globalConfig, riskProfile, systemProgram: SystemProgram.programId })
        .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" });
    }

    const unique = `${Date.now()}:${crypto.randomBytes(16).toString("hex")}`;
    const campaignId = hash32(`mwz-devnet-graduation-fixture:${unique}`);
    const nonce = hash32(`mwz-devnet-create-nonce:${unique}`);
    const now = await chainUnixTimestamp(connection);
    const args = {
      campaignId: fixed32(campaignId),
      metadataHash: fixed32(hash32(`metadata:${unique}`)),
      clusterHash: fixed32(clusterId),
      tickerHash: fixed32(hash32(`ticker:${unique}`)),
      reservationIdHash: fixed32(hash32(`reservation:${unique}`)),
      reservationVersion: new BN(1),
      launchAt: new BN(0),
      graduationTargetUsdMicros: new BN(GRADUATION_TARGET_USD_MICROS.toString()),
      deadline: new BN(now + 3600),
      nonce: fixed32(nonce),
    };
    const campaign = derivePda(PROGRAM_ID, "campaign", campaignId);
    const mint = derivePda(PROGRAM_ID, "campaign-mint", campaignId);
    const tokenVault = derivePda(PROGRAM_ID, "token-vault", campaignId);
    const solVault = derivePda(PROGRAM_ID, "sol-vault", campaignId);
    const createAuthorization = derivePda(PROGRAM_ID, "create-auth", creator.publicKey.toBuffer(), nonce);
    const feeEscrow = derivePda(PROGRAM_ID, "fee-escrow", campaign.toBuffer());
    const creatorFeeVault = derivePda(PROGRAM_ID, "creator-fee-vault", campaign.toBuffer());

    const profile = await program.account.creatorProfile.fetch(creatorProfile);
    const createDigest = createAuthorizationDigest({
      programId: PROGRAM_ID,
      generationConfigKey: generationConfig,
      generation,
      creator: creator.publicKey,
      riskClusterId: clusterId,
      creatorBuyLockSeconds: profile.creatorBuyLockSeconds,
      creatorBuyCapBps: profile.creatorBuyCapBps,
      campaign,
      mint,
      tokenVault,
      solVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      args,
    });
    const createEd25519 = Ed25519Program.createInstructionWithPrivateKey({ privateKey: routeSigner.secretKey, message: createDigest });
    const createIx = await program.methods
      .createCampaign(args)
      .accountsStrict({
        creator: creator.publicKey,
        globalConfig,
        generationConfig,
        creatorProfile,
        riskProfile: creatorRisk,
        clusterProfile,
        campaign,
        mint,
        tokenVault,
        solVault,
        createAuthorization,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const createSig = await sendLegacy(connection, creator, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      createEd25519,
      createIx,
    ]);

    await program.methods.initializeFeeEscrow().accountsStrict({ payer: operator.publicKey, campaign, feeEscrow, systemProgram: SystemProgram.programId }).rpc({ commitment: "confirmed" });
    await program.methods.initializeCreatorFeeVault().accountsStrict({ payer: operator.publicKey, campaign, creatorFeeVault, systemProgram: SystemProgram.programId }).rpc({ commitment: "confirmed" });

    const buyerAta = getAssociatedTokenAddressSync(mint, buyer.publicKey);
    await sendLegacy(connection, buyer, [createAssociatedTokenAccountInstruction(buyer.publicKey, buyerAta, buyer.publicKey, mint)]);

    const tradeNonce = hash32(`mwz-devnet-close-buy:${unique}`);
    const tradeDeadline = (await chainUnixTimestamp(connection)) + 3600;
    const tradeAuth = derivePda(PROGRAM_ID, "trade-auth", buyer.publicKey.toBuffer(), tradeNonce);
    const digest = tradeDigest({
      campaign,
      mint,
      trader: buyer.publicKey,
      amountIn: CLOSE_BUY_LAMPORTS,
      minOut: 1n,
      deadline: tradeDeadline,
      nonce: tradeNonce,
      nativeTargetLamports: CLOSE_TARGET_LAMPORTS,
    });
    const buyEd25519 = Ed25519Program.createInstructionWithPrivateKey({ privateKey: routeSigner.secretKey, message: digest });
    const buyIx = await program.methods
      .buyTokens({
        lamportsIn: new BN(CLOSE_BUY_LAMPORTS.toString()),
        minTokensOut: new BN(1),
        deadline: new BN(tradeDeadline),
        nonce: fixed32(tradeNonce),
        nativeTargetLamports: new BN(CLOSE_TARGET_LAMPORTS.toString()),
        routeProfile: ROUTE_PROFILE_UNLINKED,
      })
      .accountsStrict({
        trader: buyer.publicKey,
        globalConfig,
        campaign,
        mint,
        tokenVault,
        solVault,
        traderTokenAccount: buyerAta,
        riskProfile: buyerRisk,
        clusterProfile,
        tradeAuthorization: tradeAuth,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        feeEscrow,
        creatorFeeVault,
      })
      .instruction();

    const alt = await createTempAlt(connection, operator, globalConfig);
    const latest = await connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({ payerKey: buyer.publicKey, recentBlockhash: latest.blockhash, instructions: [buyEd25519, buyIx] }).compileToV0Message([alt]);
    const buyTx = new VersionedTransaction(message);
    buyTx.sign([buyer]);
    if (buyTx.serialize().length > 1232) fail(`fixture BUY V0 transaction exceeds packet limit: ${buyTx.serialize().length}`);
    const simulation = await connection.simulateTransaction(buyTx, { commitment: "confirmed", sigVerify: false });
    if (simulation.value.err) fail(`fixture BUY simulation failed: ${JSON.stringify(simulation.value.err)}\n${(simulation.value.logs || []).join("\n")}`);
    const buySig = await connection.sendTransaction(buyTx, { skipPreflight: false, maxRetries: 5, preflightCommitment: "confirmed" });
    const buyConfirmation = await connection.confirmTransaction({ signature: buySig, ...latest }, "confirmed");
    if (buyConfirmation.value.err) fail(`fixture BUY landed with error: ${JSON.stringify(buyConfirmation.value.err)}`);

    const campaignAccount = await connection.getAccountInfo(campaign, "confirmed");
    if (!campaignAccount) fail(`fixture campaign account ${campaign.toBase58()} is missing after BUY`);
    if (!campaignAccount.owner.equals(PROGRAM_ID)) {
      fail(`fixture campaign owner mismatch: expected=${PROGRAM_ID.toBase58()} actual=${campaignAccount.owner.toBase58()}`);
    }
    const campaignState = decodeCampaign(campaignAccount.data);
    if (!campaignState.curveClosed) fail("fixture campaign did not close its bonding curve");
    if (campaignState.graduated) fail("fixture campaign unexpectedly graduated during setup");

    const evidence = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      rpcUrl,
      programId: PROGRAM_ID.toBase58(),
      operator: operator.publicKey.toBase58(),
      routeSigner: routeSigner.publicKey.toBase58(),
      campaign: campaign.toBase58(),
      mint: mint.toBase58(),
      creator: creator.publicKey.toBase58(),
      buyer: buyer.publicKey.toBase58(),
      generationConfig: generationConfig.toBase58(),
      economicsVersion: Number(generation.economicsVersion),
      dexAdapter: Number(generation.dexAdapter),
      graduationTargetUsdMicros: GRADUATION_TARGET_USD_MICROS.toString(),
      closeBuyLamports: CLOSE_BUY_LAMPORTS.toString(),
      nativeTargetLamports: CLOSE_TARGET_LAMPORTS.toString(),
      curveClosed: true,
      graduated: false,
      createSignature: createSig,
      closeBuySignature: buySig,
      temporaryLaunchpadAlt: alt.key.toBase58(),
    };
    fs.writeFileSync(OUTPUT, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(evidence, null, 2));
    console.log(`SOLANA_GRADUATION_CAMPAIGN=${evidence.campaign}`);
  } finally {
    try {
      await program.methods
        .setPauseFlags(originalPause)
        .accountsStrict({ globalConfig, authority: operator.publicKey })
        .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" });
      restored = true;
      console.log("restored original devnet pause flags");
    } catch (error) {
      console.error("CRITICAL: failed to restore original devnet pause flags", error?.stack || error);
    }
    if (!restored) process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
