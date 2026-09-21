#!/usr/bin/env node
/**
 * Graduate a closed Solana campaign into a Meteora DAMM v2 pool.
 *
 * This is the operator the graduation handoff has always expected but never
 * had. `/api/solana/graduation-handoff` spawns SOLANA_GRADUATION_HANDOFF_COMMAND
 * when a curve closes; without a command behind it, campaigns sat at
 * curve_closed with no way forward and no error anywhere.
 *
 * One transaction does the whole thing, because a half-graduated campaign is
 * worse than an ungraduated one:
 *
 *   ComputeBudget → ed25519(route signature) → begin_graduation
 *     → Meteora createCustomPool → confirm_graduation
 *
 * Idempotent: a campaign that already reports graduated is left alone, so a
 * keeper may retry freely.
 *
 *   SOLANA_RPC_URL=...            required
 *   SOLANA_LAUNCHPAD_PROGRAM_ID=...   required
 *   SOLANA_TREASURY_OPERATOR_KEYPAIR=path   required, must equal
 *                                 GlobalConfig.treasury_operator
 *   SOLANA_ROUTE_SIGNER_KEYPAIR=path        required, must equal
 *                                 GlobalConfig.route_signer
 *   SOLANA_GRADUATION_ORACLE_PRICE_USD_MICROS=...  SOL price, default 150000000
 *   SOLANA_GRADUATION_CAMPAIGN=<pda>  or pass the campaign as argv[2]
 *   SOLANA_GRADUATION_SEND=true       actually send; otherwise simulate only
 */
import fs from "node:fs";
import BN from "bn.js";
import { createRequire } from "node:module";
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Ed25519Program,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

const require_ = createRequire(import.meta.url);
const binding = require_("./graduation-binding.cjs");
const { decodeCampaign } = require_("../../tests/solana/decode-campaign.cjs");

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const REWARDS_TREASURY = new PublicKey("2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX");
const ROUTE_PROFILE_UNLINKED = 0;

/** The six canonical reward vaults confirm_graduation pays fee slices into. */
function rewardVaultAccounts() {
  return ["league_vault", "airdrop_vault", "monthly_league_vault", "recruiter_vault", "squad_vault", "protocol_vault"]
    .map((seed) => ({
      pubkey: PublicKey.findProgramAddressSync([Buffer.from(seed, "utf8")], REWARDS_TREASURY)[0],
      isWritable: true,
      isSigner: false,
    }));
}

function associatedTokenAddress(mint, owner) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function loadKeypair(path, label) {
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function pda(programId, seed, ...extra) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seed, "utf8"), ...extra],
    programId,
  )[0];
}

/** GlobalConfig stores eight role pubkeys after the 8-byte discriminator. */
function readGlobalRoles(data) {
  const at = (index) => new PublicKey(data.subarray(8 + 32 * index, 8 + 32 * (index + 1)));
  return { routeSigner: at(4), treasuryOperator: at(6) };
}

async function main() {
  const rpcUrl = requiredEnv("SOLANA_RPC_URL");
  // The keeper passes the quote the campaign is bound to. This operator signs
  // a native-SOL binding only; a campaign whose creator chose USDC (or any
  // other Graduation Market) must go through the quote-aware operator.
  const boundProfile = String(process.env.SOLANA_GRADUATION_QUOTE_PROFILE || "native").trim().toLowerCase();
  if (boundProfile !== "native") {
    throw new Error(
      `campaign is bound to a ${process.env.SOLANA_GRADUATION_QUOTE_SYMBOL || boundProfile} quote `
      + `(${process.env.SOLANA_GRADUATION_QUOTE_CONFIG_ID || "?"}); use the quote-aware operator (SOLANA_GRADUATION_QUOTE_HANDOFF_COMMAND)`,
    );
  }
  const programId = new PublicKey(requiredEnv("SOLANA_LAUNCHPAD_PROGRAM_ID"));
  const campaignAddress = new PublicKey(
    process.argv[2] || requiredEnv("SOLANA_GRADUATION_CAMPAIGN"),
  );
  const send = ["1", "true", "yes", "on"].includes(
    String(process.env.SOLANA_GRADUATION_SEND || "").trim().toLowerCase(),
  );
  const oraclePrice = BigInt(
    String(process.env.SOLANA_GRADUATION_ORACLE_PRICE_USD_MICROS || "150000000").trim(),
  );

  const operator = loadKeypair(requiredEnv("SOLANA_TREASURY_OPERATOR_KEYPAIR"));
  const routeSigner = loadKeypair(requiredEnv("SOLANA_ROUTE_SIGNER_KEYPAIR"));
  const connection = new Connection(rpcUrl, "confirmed");

  const campaignInfo = await connection.getAccountInfo(campaignAddress, "confirmed");
  if (!campaignInfo) throw new Error(`campaign ${campaignAddress.toBase58()} not found`);
  const campaign = decodeCampaign(campaignInfo.data);

  if (campaign.graduated) {
    console.log(JSON.stringify({ campaign: campaignAddress.toBase58(), status: "already-graduated" }));
    return;
  }
  if (!campaign.curveClosed) {
    console.log(JSON.stringify({
      campaign: campaignAddress.toBase58(),
      status: "not-eligible",
      reason: "curve is still open",
      soldTokens: campaign.soldTokens.toString(),
    }));
    return;
  }

  // The roles are read from the chain rather than assumed: begin_graduation
  // rejects any authority that is not the stored treasury operator, and the
  // route signature is checked against the stored route signer.
  const globalConfig = pda(programId, "global");
  const globalInfo = await connection.getAccountInfo(globalConfig, "confirmed");
  if (!globalInfo) throw new Error("GlobalConfig not found");
  const roles = readGlobalRoles(globalInfo.data);
  if (!roles.treasuryOperator.equals(operator.publicKey)) {
    throw new Error(
      `operator ${operator.publicKey.toBase58()} is not the treasury operator ${roles.treasuryOperator.toBase58()}`,
    );
  }
  if (!roles.routeSigner.equals(routeSigner.publicKey)) {
    throw new Error(
      `route signer ${routeSigner.publicKey.toBase58()} does not match GlobalConfig ${roles.routeSigner.toBase58()}`,
    );
  }

  // begin_graduation stages liquidity through the operator's associated token
  // account and requires it to be empty. A keeper wallet that happens to hold
  // the campaign's token cannot graduate it, and the on-chain error names only
  // the condition, not the account, so check it here where we can say which.
  const stagingAta = associatedTokenAddress(campaign.mint, operator.publicKey);
  const stagingInfo = await connection.getAccountInfo(stagingAta, "confirmed");
  if (stagingInfo) {
    const stagedAmount = stagingInfo.data.readBigUInt64LE(64);
    if (stagedAmount > 0n) {
      throw new Error(
        `staging token account ${stagingAta.toBase58()} holds ${stagedAmount} of ${campaign.mint.toBase58()} `
        + "and must be empty before graduation. The treasury operator wallet must not hold a campaign's own token.",
      );
    }
  }

  const quote = binding.graduationQuote(campaign);
  const nativeTarget = binding.nativeTargetLamports(campaign.graduationTargetUsdMicros, oraclePrice);
  const positionNft = Keypair.generate();
  const pool = binding.deriveMeteoraPool(campaign.mint);
  const position = binding.deriveMeteoraPosition(positionNft.publicKey);
  const quoteBinding = binding.nativeQuoteBinding(oraclePrice);

  const plan = {
    campaign: campaignAddress.toBase58(),
    mint: campaign.mint.toBase58(),
    pool: pool.toBase58(),
    position: position.toBase58(),
    netRaisedLamports: campaign.netRaisedLamports.toString(),
    finalizeFeeLamports: quote.finalizeFeeLamports.toString(),
    lpSolLamports: quote.maxLiquidityLamports.toString(),
    lpTokens: quote.maxLiquidityTokens.toString(),
    creatorPayoutLamports: quote.creatorPayoutLamports.toString(),
    nativeTargetLamports: nativeTarget.toString(),
    oraclePriceUsdMicros: oraclePrice.toString(),
    willSend: send,
  };
  console.log(JSON.stringify(plan, null, 2));

  if (!send) {
    console.log("SOLANA_GRADUATION_SEND is not set; stopping before building the transaction.");
    return;
  }

  const { AnchorProvider, Program, Wallet, setProvider } = await import("@coral-xyz/anchor");
  const { CpAmm, getSqrtPriceFromPrice, getBaseFeeParams, BaseFeeMode, CollectFeeMode, ActivationType, MIN_SQRT_PRICE, MAX_SQRT_PRICE } =
    await import("@meteora-ag/cp-amm-sdk");

  const provider = new AnchorProvider(connection, new Wallet(operator), { commitment: "confirmed" });
  setProvider(provider);
  const idl = JSON.parse(fs.readFileSync(requiredEnv("SOLANA_LAUNCHPAD_IDL"), "utf8"));
  const program = new Program(idl, provider);

  const generationConfig = pda(programId, "generation", Buffer.from(campaign.generationId));
  const graduationState = pda(programId, "graduation", campaignAddress.toBuffer());
  const deadline = Math.floor(Date.now() / 1000) + 900;
  const nonce = binding.hash32(`graduation:${campaignAddress.toBase58()}:${deadline}`);

  const digest = binding.graduationDigest({
    programId,
    campaign: campaignAddress,
    mint: campaign.mint,
    authority: operator.publicKey,
    generationConfig,
    graduationTargetUsdMicros: campaign.graduationTargetUsdMicros,
    nativeTargetLamports: nativeTarget,
    oraclePriceUsdMicros: oraclePrice,
    pool,
    position,
    nftMint: positionNft.publicKey,
    deadline,
    nonce,
    finalizeRouteProfile: ROUTE_PROFILE_UNLINKED,
    quote: quoteBinding,
  });

  const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: routeSigner.secretKey,
    message: digest,
  });

  // confirm_graduation pays the creator in tokens and unpacks both token
  // accounts, so each must exist and be Token-program owned. A missing one
  // surfaces as InvalidCampaign comparing the System Program against the Token
  // program, which names neither the account nor the creator.
  const creatorAtaAddress = associatedTokenAddress(campaign.mint, campaign.creator);
  const ataCreations = [];
  for (const [owner, address, label] of [
    [operator.publicKey, stagingAta, "operator staging"],
    [campaign.creator, creatorAtaAddress, "creator payout"],
  ]) {
    const info = await connection.getAccountInfo(address, "confirmed");
    if (info) continue;
    console.log(`creating ${label} token account ${address.toBase58()}`);
    ataCreations.push({
      keys: [
        { pubkey: operator.publicKey, isSigner: true, isWritable: true },
        { pubkey: address, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: false, isWritable: false },
        { pubkey: campaign.mint, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      programId: ASSOCIATED_TOKEN_PROGRAM_ID,
      data: Buffer.alloc(0),
    });
  }
  if (ataCreations.length) {
    const ataBlockhash = await connection.getLatestBlockhash("confirmed");
    const ataMsg = new TransactionMessage({
      payerKey: operator.publicKey,
      recentBlockhash: ataBlockhash.blockhash,
      instructions: ataCreations,
    }).compileToV0Message();
    const ataTx = new VersionedTransaction(ataMsg);
    ataTx.sign([operator]);
    const ataSig = await connection.sendTransaction(ataTx, { maxRetries: 3 });
    await connection.confirmTransaction({ signature: ataSig, ...ataBlockhash }, "confirmed");
  }

  // Graduation refuses to run while the escrow holds unflushed fees, so sweep
  // them to the reward vaults first. flush_campaign_fees is permissionless and
  // idempotent, and is a separate transaction on purpose: the graduation
  // envelope is already at 1197 of its 1232 bytes.
  const feeEscrow = pda(programId, "fee-escrow", campaignAddress.toBuffer());
  const escrowInfo = await connection.getAccountInfo(feeEscrow, "confirmed");
  if (escrowInfo) {
    const pendingTotal = [0, 1, 2, 3, 4, 5]
      .map((i) => escrowInfo.data.readBigUInt64LE(8 + 32 + i * 8))
      .reduce((total, value) => total + value, 0n);
    if (pendingTotal > 0n) {
      console.log(`flushing ${pendingTotal} lamports of pending fees before graduation`);
      const vaults = rewardVaultAccounts().map((meta) => meta.pubkey);
      const flushIx = await program.methods
        .flushCampaignFees()
        .accountsStrict({
          caller: operator.publicKey,
          campaign: campaignAddress,
          feeEscrow,
          weeklyLeagueVault: vaults[0],
          airdropVault: vaults[1],
          monthlyLeagueVault: vaults[2],
          recruiterVault: vaults[3],
          squadVault: vaults[4],
          protocolVault: vaults[5],
        })
        .instruction();
      const flushBlockhash = await connection.getLatestBlockhash("confirmed");
      const flushMsg = new TransactionMessage({
        payerKey: operator.publicKey,
        recentBlockhash: flushBlockhash.blockhash,
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), flushIx],
      }).compileToV0Message();
      const flushTx = new VersionedTransaction(flushMsg);
      flushTx.sign([operator]);
      const flushSig = await connection.sendTransaction(flushTx, { maxRetries: 3 });
      await connection.confirmTransaction({ signature: flushSig, ...flushBlockhash }, "confirmed");
      console.log(`fees flushed: ${flushSig}`);
    }
  }

  const beginIx = await program.methods
    .beginGraduation(binding.beginGraduationArgs({
      quote: quoteBinding,
      nativeTargetLamports: nativeTarget,
      oraclePriceUsdMicros: oraclePrice,
      deadline,
      nonce,
      nftMint: positionNft.publicKey,
      finalizeRouteProfile: ROUTE_PROFILE_UNLINKED,
    }, BN))
    .accountsStrict({
      authority: operator.publicKey,
      globalConfig,
      generationConfig,
      campaign: campaignAddress,
      mint: campaign.mint,
      tokenVault: campaign.tokenVault,
      solVault: campaign.solVault,
      feeEscrow: pda(programId, "fee-escrow", campaignAddress.toBuffer()),
      authorityTokenAccount: stagingAta,
      meteoraPool: pool,
      meteoraPosition: position,
      positionNftMint: positionNft.publicKey,
      graduationState,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  // Price the pool at the curve's final spot price so graduation does not move
  // the market: the first DEX trade should see what the last curve buy paid.
  const scale = 10n ** 18n;
  const whole = quote.spotNano / scale;
  const fraction = (quote.spotNano % scale).toString().padStart(18, "0").replace(/0+$/, "");
  const initialPrice = fraction ? `${whole}.${fraction}` : whole.toString();
  const initSqrtPrice = getSqrtPriceFromPrice(initialPrice, campaign.tokenDecimals, 9);
  const tokenAAmount = new BN(quote.maxLiquidityTokens.toString());
  const tokenBAmount = new BN(quote.maxLiquidityLamports.toString());

  const cpAmm = new CpAmm(connection);
  const liquidityDelta = cpAmm.getLiquidityDelta({
    maxAmountTokenA: tokenAAmount,
    maxAmountTokenB: tokenBAmount,
    sqrtPrice: initSqrtPrice,
    sqrtMinPrice: MIN_SQRT_PRICE,
    sqrtMaxPrice: MAX_SQRT_PRICE,
    collectFeeMode: CollectFeeMode.BothToken,
  });
  const { tx: meteoraTx, pool: sdkPool, position: sdkPosition } = await cpAmm.createCustomPool({
    payer: operator.publicKey,
    creator: operator.publicKey,
    positionNft: positionNft.publicKey,
    tokenAMint: campaign.mint,
    tokenBMint: binding.NATIVE_MINT,
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
          feeTimeSchedulerParam: { startingFeeBps: 25, endingFeeBps: 25, numberOfPeriod: 0, totalDuration: 0 },
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

  // The program derives these itself; if the SDK disagrees the transaction would
  // fail deep inside Meteora, so check here where the message is useful.
  if (!sdkPool.equals(pool)) throw new Error(`SDK pool ${sdkPool.toBase58()} != program pool ${pool.toBase58()}`);
  if (!sdkPosition.equals(position)) throw new Error(`SDK position ${sdkPosition.toBase58()} != program position ${position.toBase58()}`);

  const confirmIx = await program.methods
    .confirmGraduation()
    .accountsStrict({
      authority: operator.publicKey,
      globalConfig,
      campaign: campaignAddress,
      mint: campaign.mint,
      tokenVault: campaign.tokenVault,
      solVault: campaign.solVault,
      authorityTokenAccount: stagingAta,
      creator: campaign.creator,
      creatorTokenAccount: creatorAtaAddress,
      creatorProfile: pda(programId, "creator", campaign.creator.toBuffer()),
      graduationState,
      meteoraPool: pool,
      meteoraPosition: position,
      meteoraTokenVault: PublicKey.findProgramAddressSync(
        [Buffer.from("token_vault"), campaign.mint.toBuffer(), pool.toBuffer()],
        binding.METEORA_CP_AMM,
      )[0],
      meteoraNativeVault: PublicKey.findProgramAddressSync(
        [Buffer.from("token_vault"), binding.NATIVE_MINT.toBuffer(), pool.toBuffer()],
        binding.METEORA_CP_AMM,
      )[0],
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(rewardVaultAccounts())
    .instruction();

  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ed25519Ix,
    beginIx,
    ...meteoraTx.instructions,
    confirmIx,
  ];

  const altAddress = String(process.env.SOLANA_LAUNCHPAD_ALT_ADDRESS || "").trim();
  const lookupTables = [];
  if (altAddress) {
    const altKey = new PublicKey(altAddress);
    let table = (await connection.getAddressLookupTable(altKey)).value;
    if (!table) throw new Error(`lookup table ${altAddress} not found`);

    // A graduation touches many Meteora accounts that are not in the launchpad
    // table. Without them the message cannot compress and serialisation fails
    // with "encoding overruns Uint8Array", which says nothing about the cause.
    const present = new Set(table.state.addresses.map((a) => a.toBase58()));
    const missing = [];
    for (const ix of instructions) {
      for (const key of [ix.programId, ...(ix.keys || []).map((m) => m.pubkey)]) {
        const encoded = key.toBase58();
        if (present.has(encoded) || missing.some((m) => m.equals(key))) continue;
        missing.push(key);
      }
    }
    if (missing.length) {
      const authorityPath = String(process.env.SOLANA_GRADUATION_ALT_AUTHORITY_KEYPAIR || "").trim();
      if (!authorityPath) {
        throw new Error(
          `lookup table ${altAddress} is missing ${missing.length} addresses this graduation needs `
          + "and no SOLANA_GRADUATION_ALT_AUTHORITY_KEYPAIR was provided. "
          + `Missing: ${missing.slice(0, 5).map((m) => m.toBase58()).join(", ")}`
          + (missing.length > 5 ? ` and ${missing.length - 5} more` : ""),
        );
      }
      const altAuthority = loadKeypair(authorityPath);
      console.log(`extending lookup table with ${missing.length} addresses`);
      for (let i = 0; i < missing.length; i += 20) {
        const chunk = missing.slice(i, i + 20);
        const extendIx = AddressLookupTableProgram.extendLookupTable({
          payer: operator.publicKey,
          authority: altAuthority.publicKey,
          lookupTable: altKey,
          addresses: chunk,
        });
        const blockhash = await connection.getLatestBlockhash("confirmed");
        const msg = new TransactionMessage({
          payerKey: operator.publicKey,
          recentBlockhash: blockhash.blockhash,
          instructions: [extendIx],
        }).compileToV0Message();
        const tx = new VersionedTransaction(msg);
        tx.sign(altAuthority.publicKey.equals(operator.publicKey) ? [operator] : [operator, altAuthority]);
        const sig = await connection.sendTransaction(tx, { maxRetries: 3 });
        await connection.confirmTransaction({ signature: sig, ...blockhash }, "confirmed");
      }
      // A freshly extended table is only usable once it is warm.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      table = (await connection.getAddressLookupTable(altKey)).value;
    }
    lookupTables.push(table);
  }

  const latest = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: operator.publicKey,
    recentBlockhash: latest.blockhash,
    instructions,
  }).compileToV0Message(lookupTables);
  const transaction = new VersionedTransaction(message);
  transaction.sign([operator, positionNft]);

  const serialized = transaction.serialize().length;
  console.log(`graduation transaction: ${serialized} bytes, ${instructions.length} instructions`);

  // Simulate first. A failure here costs nothing; a failure after send leaves a
  // campaign mid-graduation.
  const simulation = await connection.simulateTransaction(transaction, { sigVerify: false, replaceRecentBlockhash: false });
  if (simulation.value.err) {
    console.error((simulation.value.logs || []).slice(-12).join("\n"));
    throw new Error(`graduation simulation failed: ${JSON.stringify(simulation.value.err)}`);
  }

  const signature = await connection.sendTransaction(transaction, { skipPreflight: false, maxRetries: 3 });
  await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  console.log(JSON.stringify({ status: "graduated", campaign: campaignAddress.toBase58(), pool: pool.toBase58(), signature }, null, 2));
}

main().catch((error) => {
  console.error(String(error?.message || error));
  process.exit(1);
});
