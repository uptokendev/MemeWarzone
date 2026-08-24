import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import anchor from "@coral-xyz/anchor";
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Ed25519Program,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import * as solanaWeb3 from "@solana/web3.js";
import { loadSolanaV0Module } from "../../frontend/scripts/load-solana-v0-module.mjs";
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

const { AnchorProvider, BN, Program, Wallet } = anchor;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const DEFAULT_RPC = "https://api.devnet.solana.com";
const DEFAULT_OPERATOR = path.join(
  process.env.HOME || "",
  ".config/memewarzone/solana-devnet/deployer.json",
);
const EXPECTED_PROGRAM_ID = "3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt";
const METEORA_CP_AMM_PROGRAM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const INSTRUCTIONS_SYSVAR = new PublicKey("Sysvar1nstructions1111111111111111111111111");
const MAX_TRANSACTION_BYTES = 1232;
const BPS = 10_000n;
const NANO_LAMPORT_SCALE = 1_000_000_000n;

function fail(message) {
  throw new Error(`[solana-meteora-graduation] ${message}`);
}

function loadKeypair(filePath) {
  if (!fs.existsSync(filePath)) fail(`operator keypair not found: ${filePath}`);
  const bytes = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(bytes)) fail("operator keypair must be a JSON byte array");
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

function bigintAt(buf, offset) {
  return buf.readBigUInt64LE(offset);
}

function publicKeyAt(buf, offset) {
  return new PublicKey(buf.subarray(offset, offset + 32));
}

function decodeCampaign(buf) {
  if (buf.length < 718) fail(`Campaign account is too short: ${buf.length}`);
  return {
    generationConfig: publicKeyAt(buf, 72),
    creator: publicKeyAt(buf, 136),
    mint: publicKeyAt(buf, 168),
    tokenVault: publicKeyAt(buf, 200),
    solVault: publicKeyAt(buf, 232),
    graduationTargetUsdMicros: bigintAt(buf, 408),
    economicsVersion: buf.readUInt16LE(417),
    tokenTotalSupply: bigintAt(buf, 420),
    curveTokenSupply: bigintAt(buf, 428),
    liquidityTokenSupply: bigintAt(buf, 436),
    reserveTokenSupply: bigintAt(buf, 444),
    tokenDecimals: buf.readUInt8(452),
    basePriceLamports: bigintAt(buf, 457),
    priceSlopeNanoLamports: bigintAt(buf, 465),
    finalizeFeeBps: BigInt(buf.readUInt16LE(477)),
    creatorPostFinalizeBps: BigInt(buf.readUInt16LE(479)),
    liquidityPostFinalizeBps: BigInt(buf.readUInt16LE(481)),
    dexAdapter: buf.readUInt8(483),
    soldTokens: bigintAt(buf, 662),
    netRaisedLamports: bigintAt(buf, 670),
    graduated: buf.readUInt8(713) === 1,
    curveClosed: buf.length >= 719 ? buf.readUInt8(714) === 1 : false,
  };
}

function quoteGraduation(campaign) {
  if (campaign.economicsVersion < 3) fail("campaign is not Economics V3");
  if (campaign.dexAdapter !== 1) fail("campaign is not Meteora-only");
  if (campaign.graduated) fail("campaign is already graduated");
  const tokenScale = 10n ** BigInt(campaign.tokenDecimals);
  const spotNano =
    campaign.basePriceLamports * NANO_LAMPORT_SCALE +
    (campaign.priceSlopeNanoLamports * campaign.soldTokens) / tokenScale;
  if (spotNano <= 0n) fail("final spot price resolved to zero");

  const fee = (campaign.netRaisedLamports * campaign.finalizeFeeBps) / BPS;
  const remaining = campaign.netRaisedLamports - fee;
  const targetLiquidity = (remaining * campaign.liquidityPostFinalizeBps) / BPS;
  const desiredTokens =
    (targetLiquidity * tokenScale * NANO_LAMPORT_SCALE) / spotNano;
  const maxTokens =
    desiredTokens < campaign.liquidityTokenSupply
      ? desiredTokens
      : campaign.liquidityTokenSupply;
  const maxLamports =
    desiredTokens <= campaign.liquidityTokenSupply
      ? targetLiquidity
      : (maxTokens * spotNano) / (tokenScale * NANO_LAMPORT_SCALE);
  const creatorPayout = remaining - maxLamports;
  if (maxTokens <= 0n || maxLamports <= 0n) fail("graduation liquidity resolved to zero");
  return { spotNano, fee, maxTokens, maxLamports, creatorPayout };
}

function fixed(value, decimals) {
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function solPerWholeTokenFromSpotNano(spotNano) {
  // spotNano is nano-lamports / whole token. 1 SOL = 1e9 lamports,
  // therefore SOL/token = spotNano / 1e18.
  return fixed(spotNano, 18);
}

async function fetchCampaign(connection, campaign) {
  const info = await connection.getAccountInfo(campaign, "confirmed");
  if (!info) fail(`campaign not found: ${campaign.toBase58()}`);
  if (!info.owner.equals(new PublicKey(EXPECTED_PROGRAM_ID))) {
    fail(`campaign owner mismatch: ${info.owner.toBase58()}`);
  }
  return decodeCampaign(Buffer.from(info.data));
}

async function fetchGraduationAuthorization({ campaign, authority, positionNftMint }) {
  const url = String(process.env.SOLANA_GRADUATION_AUTH_URL || "").trim();
  if (!url) {
    fail(
      "SOLANA_GRADUATION_AUTH_URL is required, e.g. https://<railway>/api/solana/graduation-authorize",
    );
  }
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      chainId: 101,
      campaignAddress: campaign.toBase58(),
      authorityAddress: authority.toBase58(),
      positionNftMint: positionNftMint.toBase58(),
    }),
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  if (!response.ok) {
    fail(`graduation authorization failed ${response.status}: ${body?.code || ""} ${body?.error || text}`);
  }
  return body;
}

function asPk(value, label) {
  try {
    return new PublicKey(value);
  } catch {
    fail(`${label} is not a valid public key`);
  }
}

function assertPk(actual, expected, label) {
  if (!asPk(actual, label).equals(expected)) {
    fail(`${label} mismatch: ${actual} != ${expected.toBase58()}`);
  }
}

function collectInstructionKeys(instructions) {
  const seen = new Set();
  const keys = [];
  for (const ix of instructions) {
    for (const key of [ix.programId, ...(ix.keys || []).map((meta) => meta.pubkey)]) {
      const encoded = key.toBase58();
      if (seen.has(encoded)) continue;
      seen.add(encoded);
      keys.push(key);
    }
  }
  return keys;
}

async function sendLegacy(connection, payer, ixs) {
  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: latest.blockhash }).add(...ixs);
  tx.sign(payer);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const confirmation = await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
  if (confirmation.value.err) fail(`lookup table update failed: ${JSON.stringify(confirmation.value.err)}`);
}

async function loadLookupTables(connection, operator, instructions) {
  const raw = String(process.env.SOLANA_GRADUATION_ALT_ADDRESS || "").trim();
  if (!raw) return [];
  const address = asPk(raw.split(",")[0], "SOLANA_GRADUATION_ALT_ADDRESS");
  let result = await connection.getAddressLookupTable(address);
  if (!result.value) fail(`address lookup table not found: ${address.toBase58()}`);
  const present = new Set(result.value.state.addresses.map((item) => item.toBase58()));
  const missing = collectInstructionKeys(instructions).filter((key) => !present.has(key.toBase58()));
  for (let i = 0; i < missing.length; i += 20) {
    const chunk = missing.slice(i, i + 20);
    console.log("extending ALT with", chunk.length, "accounts");
    await sendLegacy(connection, operator, [
      AddressLookupTableProgram.extendLookupTable({
        payer: operator.publicKey,
        authority: operator.publicKey,
        lookupTable: address,
        addresses: chunk,
      }),
    ]);
  }
  if (missing.length) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    result = await connection.getAddressLookupTable(address);
    if (!result.value) fail(`address lookup table disappeared: ${address.toBase58()}`);
  }
  return [result.value];
}

async function main() {
  const campaignArg = process.argv[2] || process.env.SOLANA_GRADUATION_CAMPAIGN;
  if (!campaignArg) fail("usage: npm run graduate -- <CAMPAIGN_PDA>");
  const campaignPk = asPk(campaignArg, "campaign");
  const rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_RPC;
  const operatorPath = process.env.SOLANA_GRADUATION_OPERATOR_KEYPAIR || DEFAULT_OPERATOR;
  const operator = loadKeypair(operatorPath);
  const connection = new Connection(rpcUrl, "confirmed");
  const idlPath =
    String(process.env.SOLANA_IDL_PATH || "").trim() ||
    path.join(ROOT, "target/idl/memewarzone_solana.json");
  if (!fs.existsSync(idlPath)) fail(`generated graduation IDL missing: ${idlPath}`);
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const provider = new AnchorProvider(connection, new Wallet(operator), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const program = new Program(idl, provider);
  if (program.programId.toBase58() !== EXPECTED_PROGRAM_ID) {
    fail(`IDL program mismatch: ${program.programId.toBase58()}`);
  }

  const campaign = await fetchCampaign(connection, campaignPk);
  const quote = quoteGraduation(campaign);
  console.log("campaign", campaignPk.toBase58());
  console.log("creator", campaign.creator.toBase58());
  console.log("operator", operator.publicKey.toBase58());
  console.log("finalSpotNanoLamports", quote.spotNano.toString());
  console.log("maxLiquidityTokens", quote.maxTokens.toString());
  console.log("maxLiquidityLamports", quote.maxLamports.toString());

  // Create the two ordinary ATAs before the graduation transaction. The launch-token
  // staging ATA must be empty when begin_graduation executes.
  const stagingAta = await getOrCreateAssociatedTokenAccount(
    connection,
    operator,
    campaign.mint,
    operator.publicKey,
    false,
    "confirmed",
    undefined,
    TOKEN_PROGRAM_ID,
  );
  const stagingState = await getAccount(connection, stagingAta.address, "confirmed", TOKEN_PROGRAM_ID);
  if (stagingState.amount !== 0n) {
    fail(`operator staging ATA must be empty; balance=${stagingState.amount}`);
  }
  const creatorAta = await getOrCreateAssociatedTokenAccount(
    connection,
    operator,
    campaign.mint,
    campaign.creator,
    false,
    "confirmed",
    undefined,
    TOKEN_PROGRAM_ID,
  );

  const positionNft = Keypair.generate();
  const auth = await fetchGraduationAuthorization({
    campaign: campaignPk,
    authority: operator.publicKey,
    positionNftMint: positionNft.publicKey,
  });
  assertPk(auth.programId, program.programId, "authorization programId");
  assertPk(auth.accounts.authority, operator.publicKey, "authorization authority");
  assertPk(auth.accounts.campaign, campaignPk, "authorization campaign");
  assertPk(auth.accounts.mint, campaign.mint, "authorization mint");
  assertPk(auth.accounts.authorityTokenAccount, stagingAta.address, "staging ATA");
  assertPk(auth.accounts.creatorTokenAccount, creatorAta.address, "creator ATA");

  const expectedMaxNative = quote.maxLamports.toString();
  if (auth.oracle.nativeTargetLamports == null) fail("authorization missing native target");
  if (BigInt(auth.createArgs.nativeTargetLamports) !== BigInt(auth.oracle.nativeTargetLamports)) {
    fail("authorization target fields disagree");
  }

  const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
    publicKey: asPk(auth.authorization.routeSigner, "route signer").toBytes(),
    message: Buffer.from(auth.authorization.digestBase64, "base64"),
    signature: Buffer.from(auth.authorization.signatureBase64, "base64"),
  });

  const beginIx = await program.methods
    .beginGraduation({
      nativeTargetLamports: new BN(auth.createArgs.nativeTargetLamports),
      oraclePriceUsdMicros: new BN(auth.createArgs.oraclePriceUsdMicros),
      deadline: new BN(auth.createArgs.deadline),
      nonce: auth.createArgs.nonce,
      positionNftMint: positionNft.publicKey,
    })
    .accountsStrict({
      authority: operator.publicKey,
      globalConfig: asPk(auth.accounts.globalConfig, "globalConfig"),
      generationConfig: campaign.generationConfig,
      campaign: campaignPk,
      mint: campaign.mint,
      tokenVault: campaign.tokenVault,
      solVault: campaign.solVault,
      feeEscrow: PublicKey.findProgramAddressSync(
        [Buffer.from("fee-escrow"), campaignPk.toBuffer()],
        program.programId,
      )[0],
      authorityTokenAccount: stagingAta.address,
      meteoraPool: asPk(auth.accounts.meteoraPool, "meteoraPool"),
      meteoraPosition: asPk(auth.accounts.meteoraPosition, "meteoraPosition"),
      positionNftMint: positionNft.publicKey,
      graduationState: asPk(auth.accounts.graduationState, "graduationState"),
      instructions: INSTRUCTIONS_SYSVAR,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const cpAmm = new CpAmm(connection);
  const initialPrice = solPerWholeTokenFromSpotNano(quote.spotNano);
  const initSqrtPrice = getSqrtPriceFromPrice(
    initialPrice,
    campaign.tokenDecimals,
    9,
  );
  const tokenAAmount = new BN(quote.maxTokens.toString());
  const tokenBAmount = new BN(quote.maxLamports.toString());
  const liquidityDelta = cpAmm.getLiquidityDelta({
    maxAmountTokenA: tokenAAmount,
    maxAmountTokenB: tokenBAmount,
    sqrtPrice: initSqrtPrice,
    sqrtMinPrice: MIN_SQRT_PRICE,
    sqrtMaxPrice: MAX_SQRT_PRICE,
    collectFeeMode: CollectFeeMode.BothToken,
  });
  const poolFees = {
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
  };

  const { tx: meteoraTx, pool, position } = await cpAmm.createCustomPool({
    payer: operator.publicKey,
    creator: operator.publicKey,
    positionNft: positionNft.publicKey,
    tokenAMint: campaign.mint,
    tokenBMint: NATIVE_MINT,
    tokenAAmount,
    tokenBAmount,
    sqrtMinPrice: MIN_SQRT_PRICE,
    sqrtMaxPrice: MAX_SQRT_PRICE,
    liquidityDelta,
    initSqrtPrice,
    poolFees,
    hasAlphaVault: false,
    activationType: ActivationType.Timestamp,
    collectFeeMode: CollectFeeMode.BothToken,
    activationPoint: null,
    tokenAProgram: TOKEN_PROGRAM_ID,
    tokenBProgram: TOKEN_PROGRAM_ID,
    isLockLiquidity: true,
  });
  assertPk(auth.accounts.meteoraPool, pool, "Meteora pool");
  assertPk(auth.accounts.meteoraPosition, position, "Meteora position");

  const confirmIx = await program.methods
    .confirmGraduation()
    .accountsStrict({
      authority: operator.publicKey,
      globalConfig: asPk(auth.accounts.globalConfig, "globalConfig"),
      campaign: campaignPk,
      mint: campaign.mint,
      tokenVault: campaign.tokenVault,
      solVault: campaign.solVault,
      authorityTokenAccount: stagingAta.address,
      creator: campaign.creator,
      creatorTokenAccount: creatorAta.address,
      creatorProfile: asPk(auth.accounts.creatorProfile, "creatorProfile"),
      graduationState: asPk(auth.accounts.graduationState, "graduationState"),
      meteoraPool: pool,
      meteoraPosition: position,
      meteoraTokenVault: asPk(auth.accounts.meteoraTokenVault, "meteoraTokenVault"),
      meteoraNativeVault: asPk(auth.accounts.meteoraNativeVault, "meteoraNativeVault"),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(
      [
        "leagueVault",
        "airdropVault",
        "monthlyLeagueVault",
        "recruiterVault",
        "squadVault",
        "protocolVault",
      ].map((label) => ({
        pubkey: asPk(auth.accounts[label], label),
        isWritable: true,
        isSigner: false,
      })),
    )
    .instruction();

  const computeUnits = Number(process.env.SOLANA_GRADUATION_COMPUTE_UNITS || 1_400_000);
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
    ed25519Ix, // MUST immediately precede begin_graduation.
    beginIx,
    ...meteoraTx.instructions,
    confirmIx,
  ];
  const latest = await connection.getLatestBlockhash("confirmed");
  const lookupTables = await loadLookupTables(connection, operator, instructions);
  const v0 = await loadSolanaV0Module();
  const tx = v0.buildLaunchpadV0Transaction(solanaWeb3, {
    payer: operator.publicKey,
    recentBlockhash: latest.blockhash,
    instructions,
    lookupTableAccounts: lookupTables,
  });
  const stats = v0.assertLaunchpadV0Intent(solanaWeb3, tx, {
    payer: operator.publicKey,
    ed25519Instruction: ed25519Ix,
    programInstruction: beginIx,
    lookupTableAccounts: lookupTables,
    hardMaxBytes: MAX_TRANSACTION_BYTES,
    releaseMaxBytes: null,
    maxRequiredSigners: 2,
    allowAdditionalProgramInstructions: true,
  });
  tx.sign([operator, positionNft]);
  const serialized = tx.serialize();
  console.log("transactionBytes", serialized.length);
  console.log("lookupTables", lookupTables.map((t) => t.key.toBase58()).join(",") || "none");
  console.log("v0Stats", stats);

  const simulation = await v0.simulateLaunchpadV0Transaction(connection, tx);
  if (simulation.value.err) {
    console.error("simulation logs:\n" + (simulation.value.logs || []).join("\n"));
    fail(`simulation failed: ${JSON.stringify(simulation.value.err)}`);
  }
  console.log("simulationUnits", simulation.value.unitsConsumed ?? "unknown");
  if (String(process.env.SOLANA_GRADUATION_SEND || "").toLowerCase() !== "true") {
    console.log("SIMULATION PASS — not sent. Set SOLANA_GRADUATION_SEND=true to execute.");
    return;
  }

  const signature = await connection.sendRawTransaction(serialized, {
    skipPreflight: false,
    maxRetries: 5,
  });
  const confirmation = await connection.confirmTransaction(
    { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
    "confirmed",
  );
  if (confirmation.value.err) fail(`graduation confirmation failed: ${JSON.stringify(confirmation.value.err)}`);
  console.log("GRADUATED", signature);
  console.log("meteoraPool", pool.toBase58());
  console.log("meteoraPosition", position.toBase58());
  console.log("maxNativeQuoted", expectedMaxNative);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
