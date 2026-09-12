"use strict";

const assert = require("node:assert/strict");
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
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
} = web3;
const {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} = require("@solana/spl-token");
const { createAuthorizationDigest } = require("./authorization-v4.cjs");
const { decodeCampaign } = require("./decode-campaign.cjs");
const { AnchorProvider, BN, Program, Wallet } = anchor;

const PROGRAM_ID = new PublicKey("3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt");
const REWARDS_TREASURY = new PublicKey("2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX");
const EXPECTED_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const TRADE_AUTH_DOMAIN = Buffer.from("MEMEWARZONE_SOLANA_TRADE_V1", "utf8");
const TRADE_AUTH_SCHEMA_VERSION = 3;
const TRADE_SIDE_BUY = 1;
const TRADE_SIDE_SELL = 2;
const ROUTE_PROFILE_UNLINKED = 1;
const GRADUATION_TARGET_USD_MICROS = 6_000_000n;
const PROBE_BUY_LAMPORTS = 5_000_000n;
const CLOSE_BUY_LAMPORTS = 50_000_000n;
const CLOSE_TARGET_LAMPORTS = 40_000_000n;
const REPORT = process.env.SOLANA_NETWORK_CANARY_REPORT || "/tmp/mwz-solana-101-canary.json";
const IDL_PATH = path.resolve(__dirname, "../../target/idl/memewarzone_solana.json");
const MANIFEST_PATH = path.resolve(__dirname, "../../config/solana/devnet-generation-v3.json");

function fail(message) { throw new Error(`[solana-101-canary] ${message}`); }
function required(name) { const value = String(process.env[name] || "").trim(); if (!value) fail(`${name} is required`); return value; }
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function loadKeypair(file) { const value = readJson(file); if (!Array.isArray(value) || value.length !== 64) fail(`invalid keypair ${file}`); return Keypair.fromSecretKey(Uint8Array.from(value)); }
function hash32(value) { return crypto.createHash("sha256").update(value).digest(); }
function fixed32(value) { return Array.from(Buffer.from(value)); }
function derivePda(programId, ...seeds) { return PublicKey.findProgramAddressSync(seeds.map((seed) => Buffer.isBuffer(seed) ? seed : Buffer.from(seed)), programId)[0]; }
function u16le(value) { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; }
function u64le(value) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; }
function i64le(value) { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(value)); return b; }
function sameBytes(a, b) { return Buffer.from(a).equals(Buffer.from(b)); }
async function chainUnixTimestamp(connection) { const slot = await connection.getSlot("confirmed"); return (await connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000); }
function tradeDigest({ campaign, mint, trader, side, amountIn, minOut, deadline, nonce, nativeTargetLamports }) {
  return crypto.createHash("sha256").update(Buffer.concat([
    TRADE_AUTH_DOMAIN, u16le(TRADE_AUTH_SCHEMA_VERSION), PROGRAM_ID.toBuffer(), campaign.toBuffer(), mint.toBuffer(), trader.toBuffer(),
    Buffer.from([side]), u64le(amountIn), u64le(minOut), i64le(deadline), Buffer.from(nonce), u64le(nativeTargetLamports), Buffer.from([ROUTE_PROFILE_UNLINKED]),
  ])).digest();
}
function rewardVaultKeys() { return ["league_vault", "airdrop_vault", "monthly_league_vault", "recruiter_vault", "squad_vault", "protocol_vault"].map((seed) => derivePda(REWARDS_TREASURY, seed)); }
function altPlan(globalConfig) { return [PROGRAM_ID, globalConfig, Ed25519Program.programId, ComputeBudgetProgram.programId, SYSVAR_INSTRUCTIONS_PUBKEY, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId, REWARDS_TREASURY, ...rewardVaultKeys()]; }
async function sendControl(connection, payer, instructions) {
  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: latest.blockhash }).add(...instructions);
  tx.sign(payer);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  const confirmation = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (confirmation.value.err) fail(`control transaction failed ${JSON.stringify(confirmation.value.err)}`);
  return signature;
}
async function createTempAlt(connection, operator, globalConfig) {
  const slot = await connection.getSlot("confirmed");
  const [createIx, address] = AddressLookupTableProgram.createLookupTable({ authority: operator.publicKey, payer: operator.publicKey, recentSlot: Math.max(0, slot - 1) });
  await sendControl(connection, operator, [createIx]);
  const addresses = altPlan(globalConfig);
  for (let index = 0; index < addresses.length; index += 20) {
    await sendControl(connection, operator, [AddressLookupTableProgram.extendLookupTable({ payer: operator.publicKey, authority: operator.publicKey, lookupTable: address, addresses: addresses.slice(index, index + 20) })]);
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const table = (await connection.getAddressLookupTable(address, { commitment: "confirmed" })).value;
    const current = await connection.getSlot("confirmed");
    if (table && current > Number(table.state.lastExtendedSlot || 0) && addresses.every((key) => table.state.addresses.some((entry) => entry.equals(key)))) return table;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  fail(`ALT ${address.toBase58()} did not activate`);
}
async function loadV0() { const { loadSolanaV0Module } = await import("../../frontend/scripts/load-solana-v0-module.mjs"); return loadSolanaV0Module(); }
async function executeV0({ v0, connection, payer, ed25519, programIx, lookupTable, instructions, label }) {
  const ixes = instructions || [ed25519, programIx];
  const expectation = { payer: payer.publicKey, ed25519Instruction: ed25519, programInstruction: programIx, lookupTableAccounts: [lookupTable], allowInstructionPrivilegePromotion: true };
  const compiled = await v0.compileLaunchpadV0WithLatestBlockhash(web3, connection, { payer: payer.publicKey, instructions: ixes, lookupTableAccounts: [lookupTable] }, expectation);
  compiled.transaction.sign([payer]);
  const stats = v0.assertLaunchpadV0Intent(web3, compiled.transaction, expectation);
  const simulation = await v0.simulateLaunchpadV0OrThrow(connection, compiled.transaction, label);
  const raw = compiled.transaction.serialize();
  const signature = await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
  const confirmation = await connection.confirmTransaction({ signature, ...compiled.latest }, "confirmed");
  if (confirmation.value.err) fail(`${label} confirmation failed ${JSON.stringify(confirmation.value.err)}`);
  const retrySignature = await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
  if (retrySignature !== signature) fail(`${label} identical retry signature changed`);
  const landed = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
  if (landed.value[0]?.err) fail(`${label} reconciliation found transaction error`);
  const replay = await v0.compileLaunchpadV0WithLatestBlockhash(web3, connection, { payer: payer.publicKey, instructions: ixes, lookupTableAccounts: [lookupTable] }, expectation);
  replay.transaction.sign([payer]);
  const replaySimulation = await connection.simulateTransaction(replay.transaction, { commitment: "confirmed", sigVerify: false, replaceRecentBlockhash: false });
  if (!replaySimulation.value.err) fail(`${label} fresh-blockhash duplicate intent unexpectedly simulated successfully`);
  const bogus = Keypair.generate().publicKey.toBase58();
  const expired = v0.compileAndAssertLaunchpadV0(web3, { payer: payer.publicKey, recentBlockhash: bogus, instructions: ixes, lookupTableAccounts: [lookupTable] }, expectation);
  expired.transaction.sign([payer]);
  const expiredSimulation = await connection.simulateTransaction(expired.transaction, { commitment: "confirmed", sigVerify: false, replaceRecentBlockhash: false });
  if (!expiredSimulation.value.err) fail(`${label} expired/unknown blockhash unexpectedly simulated successfully`);
  return {
    status: "PASS", version: "V0", alt: lookupTable.key.toBase58(), blockhash: compiled.latest.blockhash,
    lastValidBlockHeight: compiled.latest.lastValidBlockHeight, signature, serializedBytes: stats.serializedBytes,
    simulationUnits: simulation.unitsConsumed ?? null, retry: "same-packet-deduped", duplicateReplay: "fresh-blockhash-intent-rejected",
    expiredBlockhash: "rejected", reconciliation: landed.value[0]?.confirmationStatus || "confirmed",
  };
}
async function setupWallet(program, connection, operator, globalConfig, clusterId, creator) {
  const keypair = Keypair.generate();
  await sendControl(connection, operator, [SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: keypair.publicKey, lamports: creator ? 120_000_000 : 120_000_000 })]);
  const creatorProfile = derivePda(PROGRAM_ID, "creator", keypair.publicKey.toBuffer());
  const riskProfile = derivePda(PROGRAM_ID, "risk", keypair.publicKey.toBuffer());
  if (creator) {
    await program.methods.syncCreatorProfile({ wallet: keypair.publicKey, tier: 1, trustScore: 7000, liveBondingCount: 0, lastLaunchTimestamp: new BN(0), totalLaunches: new BN(0), successfulGraduations: new BN(0), restricted: false, manualReviewRequired: false, creatorBuyCapBps: 1000 }).accountsStrict({ authority: operator.publicKey, globalConfig, creatorProfile, systemProgram: SystemProgram.programId }).rpc({ commitment: "confirmed" });
  }
  await program.methods.syncRiskProfile({ wallet: keypair.publicKey, riskLevel: 0, restricted: false, clusterId: fixed32(clusterId), manualReviewRequired: false }).accountsStrict({ authority: operator.publicKey, globalConfig, riskProfile, systemProgram: SystemProgram.programId }).rpc({ commitment: "confirmed" });
  return { keypair, creatorProfile, riskProfile };
}

async function main() {
  if (required("SOLANA_APPLICATION_CHAIN_ID") !== "101") fail("canonical destructive certification requires application chain 101");
  const operator = loadKeypair(required("SOLANA_OPERATOR_KEYPAIR"));
  const routeSigner = loadKeypair(required("SOLANA_NEW_ROUTE_SIGNER_KEYPAIR"));
  const connection = new web3.Connection(required("SOLANA_RPC_URL"), "confirmed");
  if ((await connection.getGenesisHash()) !== EXPECTED_GENESIS) fail("refusing to certify outside Solana devnet");
  const idl = readJson(IDL_PATH);
  const manifest = readJson(MANIFEST_PATH);
  const provider = new AnchorProvider(connection, new Wallet(operator), { commitment: "confirmed", preflightCommitment: "confirmed" });
  anchor.setProvider(provider);
  const program = new Program(idl, provider);
  assert(program.programId.equals(PROGRAM_ID));
  const globalConfig = derivePda(PROGRAM_ID, "global");
  const global = await program.account.globalConfig.fetch(globalConfig);
  if (!new PublicKey(global.admin).equals(operator.publicKey)) fail("operator is not current GlobalConfig.admin");
  if (!new PublicKey(global.routeSigner).equals(routeSigner.publicKey)) fail("route signer secret does not match current GlobalConfig.routeSigner");
  const generationId = hash32(manifest.generationIdSeed);
  if (!sameBytes(global.activeGenerationId, generationId)) fail("manifest generation is not current active generation");
  const generationConfig = derivePda(PROGRAM_ID, "generation", generationId);
  const generation = await program.account.generationConfig.fetch(generationConfig);
  if (Number(generation.economicsVersion) !== 3 || Number(generation.dexAdapter) !== 1 || !generation.activeCreation || !generation.supportEnabled) fail("active generation is not supported Economics V3 + Meteora");
  const clusterId = hash32(manifest.riskClusterIdSeed);
  const clusterProfile = derivePda(PROGRAM_ID, "cluster", clusterId);
  const cluster = await program.account.clusterProfile.fetch(clusterProfile);
  if (cluster.restricted) fail("certification risk cluster is restricted");
  if ((await connection.getBalance(operator.publicKey, "confirmed")) < 500_000_000) fail("operator requires at least 0.5 devnet SOL");

  const originalPause = { paused: Boolean(global.paused), createPaused: Boolean(global.createPaused), buyPaused: Boolean(global.buyPaused), sellPaused: Boolean(global.sellPaused), graduationPaused: Boolean(global.graduationPaused), claimsPaused: Boolean(global.claimsPaused) };
  let restored = false;
  try {
    await program.methods.setPauseFlags({ ...originalPause, paused: false, createPaused: false, buyPaused: false, sellPaused: false }).accountsStrict({ globalConfig, authority: operator.publicKey }).rpc({ commitment: "confirmed" });
    const creator = await setupWallet(program, connection, operator, globalConfig, clusterId, true);
    const buyer = await setupWallet(program, connection, operator, globalConfig, clusterId, false);
    const unique = `chain101:${Date.now()}:${crypto.randomBytes(12).toString("hex")}`;
    const campaignId = hash32(`campaign:${unique}`);
    const createNonce = hash32(`create:${unique}`);
    const now = await chainUnixTimestamp(connection);
    const args = { campaignId: fixed32(campaignId), metadataHash: fixed32(hash32(`metadata:${unique}`)), clusterHash: fixed32(clusterId), tickerHash: fixed32(hash32(`ticker:${unique}`)), reservationIdHash: fixed32(hash32(`reservation:${unique}`)), reservationVersion: new BN(1), launchAt: new BN(0), graduationTargetUsdMicros: new BN(GRADUATION_TARGET_USD_MICROS.toString()), deadline: new BN(now + 3600), nonce: fixed32(createNonce) };
    const campaign = derivePda(PROGRAM_ID, "campaign", campaignId);
    const mint = derivePda(PROGRAM_ID, "campaign-mint", campaignId);
    const tokenVault = derivePda(PROGRAM_ID, "token-vault", campaignId);
    const solVault = derivePda(PROGRAM_ID, "sol-vault", campaignId);
    const createAuthorization = derivePda(PROGRAM_ID, "create-auth", creator.keypair.publicKey.toBuffer(), createNonce);
    const feeEscrow = derivePda(PROGRAM_ID, "fee-escrow", campaign.toBuffer());
    const creatorFeeVault = derivePda(PROGRAM_ID, "creator-fee-vault", campaign.toBuffer());
    const profile = await program.account.creatorProfile.fetch(creator.creatorProfile);
    const createDigest = createAuthorizationDigest({ programId: PROGRAM_ID, generationConfigKey: generationConfig, generation, creator: creator.keypair.publicKey, riskClusterId: clusterId, creatorBuyLockSeconds: profile.creatorBuyLockSeconds, creatorBuyCapBps: profile.creatorBuyCapBps, campaign, mint, tokenVault, solVault, tokenProgram: TOKEN_PROGRAM_ID, args });
    const edCreate = Ed25519Program.createInstructionWithPrivateKey({ privateKey: routeSigner.secretKey, message: createDigest });
    const createIx = await program.methods.createCampaign(args).accountsStrict({ creator: creator.keypair.publicKey, globalConfig, generationConfig, creatorProfile: creator.creatorProfile, riskProfile: creator.riskProfile, clusterProfile, campaign, mint, tokenVault, solVault, createAuthorization, instructions: SYSVAR_INSTRUCTIONS_PUBKEY, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).instruction();
    const alt = await createTempAlt(connection, operator, globalConfig);
    const v0 = await loadV0();
    const create = await executeV0({ v0, connection, payer: creator.keypair, ed25519: edCreate, programIx: createIx, lookupTable: alt, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), edCreate, createIx], label: "CREATE" });
    await program.methods.initializeFeeEscrow().accountsStrict({ payer: operator.publicKey, campaign, feeEscrow, systemProgram: SystemProgram.programId }).rpc({ commitment: "confirmed" });
    await program.methods.initializeCreatorFeeVault().accountsStrict({ payer: operator.publicKey, campaign, creatorFeeVault, systemProgram: SystemProgram.programId }).rpc({ commitment: "confirmed" });
    const buyerAta = getAssociatedTokenAddressSync(mint, buyer.keypair.publicKey);

    async function trade(side, amountIn, nativeTargetLamports, label, includeAta = false) {
      const nonce = hash32(`${label}:${unique}`);
      const deadline = (await chainUnixTimestamp(connection)) + 3600;
      const auth = derivePda(PROGRAM_ID, "trade-auth", buyer.keypair.publicKey.toBuffer(), nonce);
      const digest = tradeDigest({ campaign, mint, trader: buyer.keypair.publicKey, side, amountIn, minOut: 1n, deadline, nonce, nativeTargetLamports });
      const ed = Ed25519Program.createInstructionWithPrivateKey({ privateKey: routeSigner.secretKey, message: digest });
      const ix = side === TRADE_SIDE_BUY
        ? await program.methods.buyTokens({ lamportsIn: new BN(amountIn.toString()), minTokensOut: new BN(1), deadline: new BN(deadline), nonce: fixed32(nonce), nativeTargetLamports: new BN(nativeTargetLamports.toString()), routeProfile: ROUTE_PROFILE_UNLINKED }).accountsStrict({ trader: buyer.keypair.publicKey, globalConfig, campaign, mint, tokenVault, solVault, traderTokenAccount: buyerAta, riskProfile: buyer.riskProfile, clusterProfile, tradeAuthorization: auth, instructions: SYSVAR_INSTRUCTIONS_PUBKEY, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, feeEscrow, creatorFeeVault }).instruction()
        : await program.methods.sellTokens({ tokensIn: new BN(amountIn.toString()), minLamportsOut: new BN(1), deadline: new BN(deadline), nonce: fixed32(nonce), routeProfile: ROUTE_PROFILE_UNLINKED }).accountsStrict({ trader: buyer.keypair.publicKey, globalConfig, campaign, mint, tokenVault, solVault, traderTokenAccount: buyerAta, riskProfile: buyer.riskProfile, clusterProfile, tradeAuthorization: auth, instructions: SYSVAR_INSTRUCTIONS_PUBKEY, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, feeEscrow, creatorFeeVault }).instruction();
      const instructions = includeAta ? [createAssociatedTokenAccountInstruction(buyer.keypair.publicKey, buyerAta, buyer.keypair.publicKey, mint), ed, ix] : [ed, ix];
      return executeV0({ v0, connection, payer: buyer.keypair, ed25519: ed, programIx: ix, lookupTable: alt, instructions, label });
    }

    const buy = await trade(TRADE_SIDE_BUY, PROBE_BUY_LAMPORTS, CLOSE_TARGET_LAMPORTS, "BUY", true);
    const bought = await getAccount(connection, buyerAta, "confirmed");
    const sellAmount = BigInt(bought.amount.toString()) / 4n;
    if (sellAmount <= 0n) fail("BUY returned no sellable tokens");
    const sell = await trade(TRADE_SIDE_SELL, sellAmount, 0n, "SELL");
    const closeBuy = await trade(TRADE_SIDE_BUY, CLOSE_BUY_LAMPORTS, CLOSE_TARGET_LAMPORTS, "CLOSE_BUY");
    const account = await connection.getAccountInfo(campaign, "confirmed");
    if (!account || !account.owner.equals(PROGRAM_ID)) fail("campaign missing after close BUY");
    const state = decodeCampaign(account.data);
    if (!state.curveClosed || state.graduated) fail(`unexpected pre-graduation state curveClosed=${state.curveClosed} graduated=${state.graduated}`);
    const report = { schemaVersion: 1, applicationChainId: 101, cluster: "devnet", programId: PROGRAM_ID.toBase58(), operator: operator.publicKey.toBase58(), routeSigner: routeSigner.publicKey.toBase58(), campaign: campaign.toBase58(), mint: mint.toBase58(), temporaryLaunchpadAlt: alt.key.toBase58(), curveClosed: true, graduated: false, create, buy, sell, closeBuy };
    fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    try { await program.methods.setPauseFlags(originalPause).accountsStrict({ globalConfig, authority: operator.publicKey }).rpc({ commitment: "confirmed" }); restored = true; console.log("restored original devnet pause flags"); }
    catch (error) { console.error("CRITICAL: failed to restore original devnet pause flags", error?.stack || error); }
    if (!restored) process.exitCode = 2;
  }
}

main().catch((error) => { console.error(error?.stack || error); process.exit(1); });