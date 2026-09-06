import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import anchor from "@coral-xyz/anchor";
import * as solanaWeb3 from "@solana/web3.js";
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Ed25519Program,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  getAccount,
  getOrCreateAssociatedTokenAccount,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  CpAmm,
  getBaseFeeParams,
  getSqrtPriceFromPrice,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
} from "@meteora-ag/cp-amm-sdk";
import { loadSolanaV0Module } from "../../frontend/scripts/load-solana-v0-module.mjs";

const { AnchorProvider, BN, Program, Wallet } = anchor;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const DEFAULT_RPC = "https://api.devnet.solana.com";
const DEFAULT_OPERATOR = path.join(process.env.HOME || "", ".config/memewarzone/solana-devnet/deployer.json");
const EXPECTED_PROGRAM_ID = "3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt";
const REWARDS_TREASURY_PROGRAM_ID = new PublicKey("2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX");
const INSTRUCTIONS_SYSVAR = new PublicKey("Sysvar1nstructions1111111111111111111111111");
const MAX_TRANSACTION_BYTES = 1232;
const QUOTE_PROFILE_NATIVE = 0;

function fail(message) { throw new Error(`[solana-basic-quote-graduation] ${message}`); }
function asPk(value, label) { try { return new PublicKey(value); } catch { fail(`${label} is not a valid public key`); } }
function assertPk(actual, expected, label) { if (!asPk(actual, label).equals(expected)) fail(`${label} mismatch: ${actual} != ${expected}`); }
function loadKeypair(filePath) {
  if (!fs.existsSync(filePath)) fail(`operator keypair not found: ${filePath}`);
  const bytes = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(bytes)) fail("operator keypair must be a JSON byte array");
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}
function bigintAt(buf, offset) { return buf.readBigUInt64LE(offset); }
function publicKeyAt(buf, offset) { return new PublicKey(buf.subarray(offset, offset + 32)); }
function decodeCampaign(buf) {
  if (buf.length < 718) fail(`Campaign account is too short: ${buf.length}`);
  return {
    generationConfig: publicKeyAt(buf, 72), creator: publicKeyAt(buf, 136), mint: publicKeyAt(buf, 168),
    tokenVault: publicKeyAt(buf, 200), solVault: publicKeyAt(buf, 232), tokenDecimals: buf.readUInt8(452),
  };
}
function deriveRewardVault(seed) { return PublicKey.findProgramAddressSync([Buffer.from(seed)], REWARDS_TREASURY_PROGRAM_ID)[0]; }
function rewardVaultAccounts() {
  return {
    leagueVault: deriveRewardVault("league_vault"), airdropVault: deriveRewardVault("airdrop_vault"),
    monthlyLeagueVault: deriveRewardVault("monthly_league_vault"), recruiterVault: deriveRewardVault("recruiter_vault"),
    squadVault: deriveRewardVault("squad_vault"), protocolVault: deriveRewardVault("protocol_vault"),
  };
}
function fixed(value, decimals) {
  const scale = 10n ** BigInt(decimals); const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
function quotePerWholeToken(quoteRaw, quoteDecimals, tokenRaw, tokenDecimals) {
  if (quoteRaw <= 0n || tokenRaw <= 0n) fail("invalid quote/token ratio");
  const precision = 18n;
  const numerator = quoteRaw * (10n ** BigInt(tokenDecimals)) * (10n ** precision);
  const denominator = tokenRaw * (10n ** BigInt(quoteDecimals));
  return fixed(numerator / denominator, Number(precision));
}
async function fetchCampaign(connection, campaign) {
  const info = await connection.getAccountInfo(campaign, "confirmed");
  if (!info) fail(`campaign not found: ${campaign}`);
  if (!info.owner.equals(new PublicKey(EXPECTED_PROGRAM_ID))) fail(`campaign owner mismatch: ${info.owner}`);
  return decodeCampaign(Buffer.from(info.data));
}
async function fetchGraduationAuthorization({ campaign, authority, positionNftMint, quoteConfigId }) {
  const url = String(process.env.SOLANA_GRADUATION_AUTH_URL || "").trim();
  if (!url) fail("SOLANA_GRADUATION_AUTH_URL is required");
  const response = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ chainId: 101, campaignAddress: campaign.toBase58(), authorityAddress: authority.toBase58(), positionNftMint: positionNftMint.toBase58(), quoteConfigId }),
  });
  const text = await response.text(); let body = null; try { body = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) fail(`authorization failed ${response.status}: ${body?.code || ""} ${body?.error || text}`);
  return body;
}
function collectInstructionKeys(instructions) {
  const seen = new Set(); const keys = [];
  for (const ix of instructions) for (const key of [ix.programId, ...(ix.keys || []).map((m) => m.pubkey)]) {
    const s = key.toBase58(); if (!seen.has(s)) { seen.add(s); keys.push(key); }
  }
  return keys;
}
async function sendLegacy(connection, payer, ixs) {
  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: latest.blockhash }).add(...ixs); tx.sign(payer);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const confirmation = await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
  if (confirmation.value.err) fail(`ALT update failed: ${JSON.stringify(confirmation.value.err)}`);
}
function resolveGraduationAltAddress() {
  const configured = String(process.env.SOLANA_GRADUATION_ALT_ADDRESS || "").trim();
  if (configured) return configured.split(",")[0].trim();
  const fixturePath = String(process.env.SOLANA_GRADUATION_FIXTURE_OUTPUT || "").trim();
  if (!fixturePath || !fs.existsSync(fixturePath)) return "";
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  return String(fixture?.temporaryLaunchpadAlt || "").trim();
}
async function loadProjectLookupTable(connection, operator, instructions) {
  const raw = resolveGraduationAltAddress(); if (!raw) return [];
  const address = asPk(raw, "SOLANA_GRADUATION_ALT_ADDRESS"); let result = await connection.getAddressLookupTable(address);
  if (!result.value) fail(`ALT not found: ${address}`);
  if (!result.value.state.authority?.equals(operator.publicKey)) fail(`ALT authority mismatch for ${address}`);
  const present = new Set(result.value.state.addresses.map((x) => x.toBase58()));
  const missing = collectInstructionKeys(instructions).filter((key) => !present.has(key.toBase58()));
  for (let i = 0; i < missing.length; i += 20) await sendLegacy(connection, operator, [AddressLookupTableProgram.extendLookupTable({ payer: operator.publicKey, authority: operator.publicKey, lookupTable: address, addresses: missing.slice(i, i + 20) })]);
  if (missing.length) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500)); result = await connection.getAddressLookupTable(address);
      const currentSlot = await connection.getSlot("confirmed"); const lastExtendedSlot = Number(result.value?.state.lastExtendedSlot || 0);
      const updated = new Set((result.value?.state.addresses || []).map((x) => x.toBase58()));
      if (currentSlot > lastExtendedSlot && missing.every((key) => updated.has(key.toBase58()))) break;
      if (attempt === 19) fail(`graduation ALT ${address} did not become active`);
    }
  }
  return [result.value];
}
function jupiterInstruction(raw) {
  if (!raw) return null;
  return new TransactionInstruction({
    programId: asPk(raw.programId, "Jupiter instruction program"),
    keys: (raw.accounts || []).map((m) => ({ pubkey: asPk(m.pubkey, "Jupiter account"), isSigner: Boolean(m.isSigner), isWritable: Boolean(m.isWritable) })),
    data: Buffer.from(raw.data || "", "base64"),
  });
}
async function buildJupiterInstructions(auth, operator) {
  if (Number(auth.quote.profile) === QUOTE_PROFILE_NATIVE) return { instructions: [], lookupTables: [] };
  const base = String(process.env.SOLANA_GRADUATION_JUPITER_API_BASE || "https://lite-api.jup.ag/swap/v1").replace(/\/$/, "");
  const response = await fetch(`${base}/swap-instructions`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ quoteResponse: auth.quote.acquisitionQuote, userPublicKey: operator.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: false, useSharedAccounts: true }),
  });
  const text = await response.text(); let body = null; try { body = JSON.parse(text); } catch {}
  if (!response.ok) fail(`Jupiter swap-instructions failed ${response.status}: ${body?.error || text}`);
  const instructions = [
    ...(body.setupInstructions || []).map(jupiterInstruction),
    jupiterInstruction(body.tokenLedgerInstruction),
    jupiterInstruction(body.swapInstruction),
    jupiterInstruction(body.cleanupInstruction),
  ].filter(Boolean);
  if (!instructions.length || !instructions.some((ix) => ix.programId.equals(asPk(auth.quote.acquisitionProgram, "acquisitionProgram")))) fail("Jupiter route does not contain the approved acquisition program");
  const lookupTables = [];
  for (const address of body.addressLookupTableAddresses || []) {
    const result = await operator.connection.getAddressLookupTable(asPk(address, "Jupiter ALT"));
    if (!result.value) fail(`Jupiter ALT missing: ${address}`); lookupTables.push(result.value);
  }
  return { instructions, lookupTables };
}

async function main() {
  const campaignArg = process.argv[2] || process.env.SOLANA_GRADUATION_CAMPAIGN; if (!campaignArg) fail("usage: npm run graduate:basic-quote -- <CAMPAIGN_PDA>");
  const campaignPk = asPk(campaignArg, "campaign");
  const quoteConfigId = String(process.env.SOLANA_GRADUATION_QUOTE_CONFIG_ID || "").trim(); if (!quoteConfigId) fail("SOLANA_GRADUATION_QUOTE_CONFIG_ID is required and must be an authoritative Quote Asset Catalog deployment id");
  const rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_RPC;
  const operator = loadKeypair(process.env.SOLANA_GRADUATION_OPERATOR_KEYPAIR || DEFAULT_OPERATOR);
  const connection = new Connection(rpcUrl, "confirmed"); operator.connection = connection;
  const idlPath = String(process.env.SOLANA_IDL_PATH || "").trim() || path.join(ROOT, "target/idl/memewarzone_solana.json");
  if (!fs.existsSync(idlPath)) fail(`generated graduation IDL missing: ${idlPath}`);
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const provider = new AnchorProvider(connection, new Wallet(operator), { commitment: "confirmed", preflightCommitment: "confirmed" });
  const program = new Program(idl, provider); if (program.programId.toBase58() !== EXPECTED_PROGRAM_ID) fail(`IDL program mismatch: ${program.programId}`);
  const campaign = await fetchCampaign(connection, campaignPk); const rewardVaults = rewardVaultAccounts();
  const feeEscrow = PublicKey.findProgramAddressSync([Buffer.from("fee-escrow"), campaignPk.toBuffer()], program.programId)[0];
  const flushFeesIx = await program.methods.flushCampaignFees().accountsStrict({ caller: operator.publicKey, campaign: campaignPk, feeEscrow, weeklyLeagueVault: rewardVaults.leagueVault, airdropVault: rewardVaults.airdropVault, monthlyLeagueVault: rewardVaults.monthlyLeagueVault, recruiterVault: rewardVaults.recruiterVault, squadVault: rewardVaults.squadVault, protocolVault: rewardVaults.protocolVault }).instruction();
  const stagingAta = await getOrCreateAssociatedTokenAccount(connection, operator, campaign.mint, operator.publicKey, false, "confirmed", undefined, TOKEN_PROGRAM_ID);
  const stagingState = await getAccount(connection, stagingAta.address, "confirmed", TOKEN_PROGRAM_ID); if (stagingState.amount !== 0n) fail(`operator staging ATA must be empty; balance=${stagingState.amount}`);
  const creatorAta = await getOrCreateAssociatedTokenAccount(connection, operator, campaign.mint, campaign.creator, false, "confirmed", undefined, TOKEN_PROGRAM_ID);
  const positionNft = Keypair.generate();
  const auth = await fetchGraduationAuthorization({ campaign: campaignPk, authority: operator.publicKey, positionNftMint: positionNft.publicKey, quoteConfigId });
  assertPk(auth.programId, program.programId, "programId"); assertPk(auth.accounts.campaign, campaignPk, "campaign"); assertPk(auth.accounts.mint, campaign.mint, "mint"); assertPk(auth.accounts.authorityTokenAccount, stagingAta.address, "staging ATA");
  const quoteMint = asPk(auth.quote.mint, "quote mint"); const nativeQuote = Number(auth.quote.profile) === QUOTE_PROFILE_NATIVE;
  let quoteAta = null; let recoveryAccount = null;
  if (!nativeQuote) {
    quoteAta = await getOrCreateAssociatedTokenAccount(connection, operator, quoteMint, operator.publicKey, false, "confirmed", undefined, TOKEN_PROGRAM_ID);
    const q = await getAccount(connection, quoteAta.address, "confirmed", TOKEN_PROGRAM_ID); if (q.amount !== 0n) fail(`operator quote ATA must be empty; balance=${q.amount}`);
    recoveryAccount = asPk(auth.quote.recoveryAccount, "quote recovery account"); const recovery = await getAccount(connection, recoveryAccount, "confirmed", TOKEN_PROGRAM_ID); if (!recovery.mint.equals(quoteMint)) fail("quote recovery account mint mismatch");
    assertPk(auth.accounts.authorityQuoteAccount, quoteAta.address, "authority quote ATA");
  }
  const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({ publicKey: asPk(auth.authorization.routeSigner, "route signer").toBytes(), message: Buffer.from(auth.authorization.digestBase64, "base64"), signature: Buffer.from(auth.authorization.signatureBase64, "base64") });
  const c = auth.createArgs;
  const beginIx = await program.methods.beginGraduation({
    nativeTargetLamports: new BN(c.nativeTargetLamports), oraclePriceUsdMicros: new BN(c.oraclePriceUsdMicros), deadline: new BN(c.deadline), nonce: c.nonce,
    positionNftMint: positionNft.publicKey, finalizeRouteProfile: Number(c.finalizeRouteProfile), quoteMint, quoteConfigId: c.quoteConfigId,
    quotePolicyVersion: Number(c.quotePolicyVersion), quoteProfile: Number(c.quoteProfile), quoteProviderClass: Number(c.quoteProviderClass),
    acquisitionProgram: asPk(c.acquisitionProgram, "acquisitionProgram"), quoteReferenceUsdMicros: new BN(c.quoteReferenceUsdMicros), quoteDecimals: Number(c.quoteDecimals),
    expectedQuoteAmount: new BN(c.expectedQuoteAmount), minQuoteAmount: new BN(c.minQuoteAmount), maxSlippageBps: Number(c.maxSlippageBps), maxImpactBps: Number(c.maxImpactBps), maxDeviationBps: Number(c.maxDeviationBps), quoteRecoveryAccount: asPk(c.quoteRecoveryAccount, "quoteRecoveryAccount"),
  }).accountsStrict({ authority: operator.publicKey, globalConfig: asPk(auth.accounts.globalConfig, "globalConfig"), generationConfig: campaign.generationConfig, campaign: campaignPk, mint: campaign.mint, tokenVault: campaign.tokenVault, solVault: campaign.solVault, feeEscrow, authorityTokenAccount: stagingAta.address, meteoraPool: asPk(auth.accounts.meteoraPool, "meteoraPool"), meteoraPosition: asPk(auth.accounts.meteoraPosition, "meteoraPosition"), positionNftMint: positionNft.publicKey, graduationState: asPk(auth.accounts.graduationState, "graduationState"), instructions: INSTRUCTIONS_SYSVAR, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).instruction();

  const maxTokens = BigInt(auth.graduationLiquidity.maxLiquidityTokens); const quoteRaw = nativeQuote ? BigInt(auth.graduationLiquidity.maxLiquidityLamports) : BigInt(auth.quote.minQuoteAmount);
  const cpAmm = new CpAmm(connection); const quoteDecimals = Number(auth.quote.decimals);
  const initialPrice = nativeQuote ? fixed(BigInt(auth.graduationLiquidity.finalSpotNanoLamports), 18) : quotePerWholeToken(quoteRaw, quoteDecimals, maxTokens, campaign.tokenDecimals);
  const initSqrtPrice = getSqrtPriceFromPrice(initialPrice, campaign.tokenDecimals, quoteDecimals);
  const tokenAAmount = new BN(maxTokens.toString()); const tokenBAmount = new BN(quoteRaw.toString());
  const liquidityDelta = cpAmm.getLiquidityDelta({ maxAmountTokenA: tokenAAmount, maxAmountTokenB: tokenBAmount, sqrtPrice: initSqrtPrice, sqrtMinPrice: MIN_SQRT_PRICE, sqrtMaxPrice: MAX_SQRT_PRICE, collectFeeMode: CollectFeeMode.BothToken });
  const poolFees = { baseFee: getBaseFeeParams({ baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear, feeTimeSchedulerParam: { startingFeeBps: 25, endingFeeBps: 25, numberOfPeriod: 0, totalDuration: 0 } }, quoteDecimals, ActivationType.Timestamp), compoundingFeeBps: 0, padding: 0, dynamicFee: null };
  const { tx: meteoraTx, pool, position } = await cpAmm.createCustomPool({ payer: operator.publicKey, creator: operator.publicKey, positionNft: positionNft.publicKey, tokenAMint: campaign.mint, tokenBMint: quoteMint, tokenAAmount, tokenBAmount, sqrtMinPrice: MIN_SQRT_PRICE, sqrtMaxPrice: MAX_SQRT_PRICE, liquidityDelta, initSqrtPrice, poolFees, hasAlphaVault: false, activationType: ActivationType.Timestamp, collectFeeMode: CollectFeeMode.BothToken, activationPoint: null, tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, isLockLiquidity: true });
  assertPk(auth.accounts.meteoraPool, pool, "Meteora pool"); assertPk(auth.accounts.meteoraPosition, position, "Meteora position");
  const rewardRemaining = Object.values(rewardVaults).map((pubkey) => ({ pubkey, isWritable: true, isSigner: false }));
  const quoteRemaining = nativeQuote ? [] : [{ pubkey: quoteMint, isWritable: false, isSigner: false }, { pubkey: quoteAta.address, isWritable: true, isSigner: false }, { pubkey: recoveryAccount, isWritable: true, isSigner: false }];
  const confirmIx = await program.methods.confirmGraduation().accountsStrict({ authority: operator.publicKey, globalConfig: asPk(auth.accounts.globalConfig, "globalConfig"), campaign: campaignPk, mint: campaign.mint, tokenVault: campaign.tokenVault, solVault: campaign.solVault, authorityTokenAccount: stagingAta.address, creator: campaign.creator, creatorTokenAccount: creatorAta.address, creatorProfile: asPk(auth.accounts.creatorProfile, "creatorProfile"), graduationState: asPk(auth.accounts.graduationState, "graduationState"), meteoraPool: pool, meteoraPosition: position, meteoraTokenVault: asPk(auth.accounts.meteoraTokenVault, "meteoraTokenVault"), meteoraNativeVault: asPk(auth.accounts.meteoraNativeVault, "meteora quote vault"), tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).remainingAccounts([...quoteRemaining, ...rewardRemaining]).instruction();
  const jupiter = await buildJupiterInstructions(auth, { publicKey: operator.publicKey, connection });
  const computeUnits = Number(process.env.SOLANA_GRADUATION_COMPUTE_UNITS || 1_400_000);
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }), flushFeesIx, ed25519Ix, beginIx, ...jupiter.instructions, ...meteoraTx.instructions, confirmIx];
  const latest = await connection.getLatestBlockhash("confirmed"); const projectLookup = await loadProjectLookupTable(connection, operator, instructions);
  const lookupMap = new Map([...projectLookup, ...jupiter.lookupTables].map((table) => [table.key.toBase58(), table])); const lookupTables = [...lookupMap.values()];
  const v0 = await loadSolanaV0Module();
  const tx = v0.buildLaunchpadV0Transaction(solanaWeb3, { payer: operator.publicKey, recentBlockhash: latest.blockhash, instructions, lookupTableAccounts: lookupTables });
  const stats = v0.assertLaunchpadV0Intent(solanaWeb3, tx, { payer: operator.publicKey, ed25519Instruction: ed25519Ix, programInstruction: beginIx, lookupTableAccounts: lookupTables, hardMaxBytes: MAX_TRANSACTION_BYTES, releaseMaxBytes: null, maxRequiredSigners: 2, allowAdditionalProgramInstructions: true, allowInstructionPrivilegePromotion: true });
  tx.sign([operator, positionNft]); const serialized = tx.serialize(); console.log("quoteConfigId", quoteConfigId, "quoteMint", quoteMint.toBase58(), "transactionBytes", serialized.length, "v0Stats", stats);
  const simulation = await v0.simulateLaunchpadV0Transaction(connection, tx); if (simulation.value.err) { console.error((simulation.value.logs || []).join("\n")); fail(`simulation failed: ${JSON.stringify(simulation.value.err)}`); }
  console.log("SIMULATION PASS", simulation.value.unitsConsumed ?? "unknown");
  if (String(process.env.SOLANA_GRADUATION_SEND || "").toLowerCase() !== "true") return;
  const signature = await connection.sendRawTransaction(serialized, { skipPreflight: false, maxRetries: 5 });
  const confirmation = await connection.confirmTransaction({ signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, "confirmed");
  if (confirmation.value.err) fail(`graduation confirmation failed: ${JSON.stringify(confirmation.value.err)}`);
  console.log("GRADUATED", signature, "pool", pool.toBase58(), "position", position.toBase58());
}
main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
