"use strict";

/**
 * A real Meteora DAMM v2 pool with a Token-2022 mint as the quote side.
 *
 * The claim that DAMM v2 accepts Token-2022 came from reading its SDK surface
 * (createCustomPool takes tokenAProgram and tokenBProgram separately) and from
 * finding the Token-2022 program id inside the pinned binary. Neither shows
 * that a pool actually initializes, and graduation binds a quote by creating
 * exactly this pool -- so if DAMM v2 refused, the whole Token-2022 quote path
 * would be blocked downstream no matter what our program accepts.
 *
 * Requires solana-test-validator with the pinned Meteora binary and its account
 * fixtures loaded; scripts/solana/run-local-sbf-gate.sh starts one.
 */

const assert = require("node:assert/strict");
const {
  Connection, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction,
} = require("@solana/web3.js");
const {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction,
  createMint,
  getAssociatedTokenAddressSync,
  getMintLen,
  mintTo,
} = require("@solana/spl-token");
const BN = require("bn.js");

const RPC = process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";
const METEORA = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
const TOKEN_DECIMALS = 6;
const QUOTE_DECIMALS = 6;

describe("Meteora DAMM v2 with a Token-2022 quote", function () {
  this.timeout(300_000);
  const connection = new Connection(RPC, "confirmed");
  let payer;

  before(async function () {
    const meteora = await connection.getAccountInfo(new (require("@solana/web3.js").PublicKey)(METEORA), "confirmed");
    if (!meteora || !meteora.executable) this.skip();
    payer = Keypair.generate();
    const signature = await connection.requestAirdrop(payer.publicKey, 5_000_000_000);
    const latest = await connection.getLatestBlockhash("confirmed");
    await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  });

  it("initializes a pool whose quote side is a Token-2022 mint, and locks liquidity", async () => {
    const sdk = await import("@meteora-ag/cp-amm-sdk");
    const {
      ActivationType, BaseFeeMode, CollectFeeMode, CpAmm,
      getBaseFeeParams, getSqrtPriceFromPrice, MAX_SQRT_PRICE, MIN_SQRT_PRICE,
    } = sdk;

    // Side A is a classic SPL mint, exactly as a launch token is: the program
    // mints it and it never becomes Token-2022. Only the quote changes.
    const tokenAMint = await createMint(connection, payer, payer.publicKey, null, TOKEN_DECIMALS, undefined, { commitment: "confirmed" }, TOKEN_PROGRAM_ID);

    const quoteMint = Keypair.generate();
    const space = getMintLen([ExtensionType.MetadataPointer]);
    const lamports = await connection.getMinimumBalanceForRentExemption(space);
    await sendAndConfirmTransaction(connection, new Transaction().add(
      SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: quoteMint.publicKey, space, lamports, programId: TOKEN_2022_PROGRAM_ID }),
      createInitializeMetadataPointerInstruction(quoteMint.publicKey, payer.publicKey, quoteMint.publicKey, TOKEN_2022_PROGRAM_ID),
      createInitializeMintInstruction(quoteMint.publicKey, QUOTE_DECIMALS, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
    ), [payer, quoteMint], { commitment: "confirmed" });

    const tokenAAmountRaw = 1_000_000n * 10n ** BigInt(TOKEN_DECIMALS);
    const quoteAmountRaw = 500n * 10n ** BigInt(QUOTE_DECIMALS);

    const ataA = getAssociatedTokenAddressSync(tokenAMint, payer.publicKey, false, TOKEN_PROGRAM_ID);
    const ataQuote = getAssociatedTokenAddressSync(quoteMint.publicKey, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
    await sendAndConfirmTransaction(connection, new Transaction().add(
      createAssociatedTokenAccountInstruction(payer.publicKey, ataA, payer.publicKey, tokenAMint, TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountInstruction(payer.publicKey, ataQuote, payer.publicKey, quoteMint.publicKey, TOKEN_2022_PROGRAM_ID),
    ), [payer], { commitment: "confirmed" });
    await mintTo(connection, payer, tokenAMint, ataA, payer, tokenAAmountRaw, [], { commitment: "confirmed" }, TOKEN_PROGRAM_ID);
    await mintTo(connection, payer, quoteMint.publicKey, ataQuote, payer, quoteAmountRaw, [], { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);

    const cpAmm = new CpAmm(connection);
    const positionNft = Keypair.generate();
    const tokenAAmount = new BN(tokenAAmountRaw.toString());
    const tokenBAmount = new BN(quoteAmountRaw.toString());
    const initSqrtPrice = getSqrtPriceFromPrice("0.0005", TOKEN_DECIMALS, QUOTE_DECIMALS);
    const liquidityDelta = cpAmm.getLiquidityDelta({
      maxAmountTokenA: tokenAAmount, maxAmountTokenB: tokenBAmount,
      sqrtPrice: initSqrtPrice, sqrtMinPrice: MIN_SQRT_PRICE, sqrtMaxPrice: MAX_SQRT_PRICE,
      collectFeeMode: CollectFeeMode.BothToken,
    });

    const { tx, pool, position } = await cpAmm.createCustomPool({
      payer: payer.publicKey,
      creator: payer.publicKey,
      positionNft: positionNft.publicKey,
      tokenAMint,
      tokenBMint: quoteMint.publicKey,
      tokenAAmount,
      tokenBAmount,
      sqrtMinPrice: MIN_SQRT_PRICE,
      sqrtMaxPrice: MAX_SQRT_PRICE,
      liquidityDelta,
      initSqrtPrice,
      poolFees: {
        baseFee: getBaseFeeParams(
          { baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear, feeTimeSchedulerParam: { startingFeeBps: 25, endingFeeBps: 25, numberOfPeriod: 0, totalDuration: 0 } },
          QUOTE_DECIMALS, ActivationType.Timestamp,
        ),
        compoundingFeeBps: 0, padding: 0, dynamicFee: null,
      },
      hasAlphaVault: false,
      activationType: ActivationType.Timestamp,
      collectFeeMode: CollectFeeMode.BothToken,
      activationPoint: null,
      tokenAProgram: TOKEN_PROGRAM_ID,
      // The whole point: the quote side runs on Token-2022.
      tokenBProgram: TOKEN_2022_PROGRAM_ID,
      isLockLiquidity: true,
    });

    const signature = await sendAndConfirmTransaction(connection, tx, [payer, positionNft], { commitment: "confirmed" });
    assert.ok(signature, "pool creation must land");

    const poolAccount = await connection.getAccountInfo(pool, "confirmed");
    assert.ok(poolAccount, "the pool account must exist");
    assert.equal(poolAccount.owner.toBase58(), METEORA, "the pool must be owned by DAMM v2");
    const positionAccount = await connection.getAccountInfo(position, "confirmed");
    assert.ok(positionAccount, "the locked position must exist");

    // The quote vault is a Token-2022 account, which is what the graduation
    // program unpacks as meteora_native_vault -- the read that spl_token's
    // unpack could not do before the change.
    const quoteVault = await connection.getAccountInfo(
      require("@solana/web3.js").PublicKey.findProgramAddressSync(
        [Buffer.from("token_vault"), quoteMint.publicKey.toBuffer(), pool.toBuffer()],
        new (require("@solana/web3.js").PublicKey)(METEORA),
      )[0],
      "confirmed",
    );
    assert.ok(quoteVault, "the pool's quote vault must exist");
    assert.equal(
      quoteVault.owner.toBase58(),
      TOKEN_2022_PROGRAM_ID.toBase58(),
      "the quote vault is owned by Token-2022, so it must be read through it",
    );

    console.log(`[token-2022-pool] pool=${pool.toBase58()} quoteVault owner=Token-2022 signature=${signature}`);
  });
});
