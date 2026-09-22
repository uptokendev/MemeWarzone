"use strict";

/**
 * Token-2022 quote acceptance against mints the real token program produced.
 *
 * The extension classification is implemented twice -- `quote_extension_allowed`
 * in the graduation program and `disallowedToken2022Extensions` in the catalog
 * verifier -- and both were tested against buffers the tests themselves built.
 * That proves the two agree with each other's idea of the layout, not with the
 * chain's. This creates the mints with spl-token-2022 on a local validator and
 * reads their bytes back, so the layout under test is the one Token-2022
 * actually writes.
 *
 * The classification no longer gates graduation: the creator chooses the
 * binding and is warned. It decides what that warning says.
 *
 * It also checks the associated-token address for a Token-2022 mint exists on
 * chain where the authorization API derives it. The token program is part of
 * the ATA seeds, so a wrong program derives a plausible address for an account
 * that is not there.
 *
 * Requires solana-test-validator (Token-2022 is a builtin, so no --bpf-program).
 */

const assert = require("node:assert/strict");
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
} = require("@solana/web3.js");
const {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
  getOrCreateAssociatedTokenAccount,
} = require("@solana/spl-token");

const RPC = process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";
const DECIMALS = 6;

async function fundedPayer(connection) {
  const payer = Keypair.generate();
  const signature = await connection.requestAirdrop(payer.publicKey, 2_000_000_000);
  const latest = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  return payer;
}

/** Creates a Token-2022 mint carrying exactly the named extensions. */
async function createToken2022Mint(connection, payer, extensions) {
  const mint = Keypair.generate();
  const space = getMintLen(extensions);
  const lamports = await connection.getMinimumBalanceForRentExemption(space);
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
  );
  // Extensions must be initialized before the mint itself.
  for (const extension of extensions) {
    if (extension === ExtensionType.MetadataPointer) {
      tx.add(createInitializeMetadataPointerInstruction(mint.publicKey, payer.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID));
    } else if (extension === ExtensionType.TransferFeeConfig) {
      tx.add(createInitializeTransferFeeConfigInstruction(mint.publicKey, payer.publicKey, payer.publicKey, 50, BigInt(1_000), TOKEN_2022_PROGRAM_ID));
    } else {
      throw new Error(`fixture does not build ${extension}`);
    }
  }
  tx.add(createInitializeMintInstruction(mint.publicKey, DECIMALS, payer.publicKey, null, TOKEN_2022_PROGRAM_ID));
  await sendAndConfirmTransaction(connection, tx, [payer, mint], { commitment: "confirmed" });
  return mint.publicKey;
}

describe("Token-2022 quote acceptance on real mints", function () {
  this.timeout(180_000);
  const connection = new Connection(RPC, "confirmed");
  let verifier;
  let payer;

  before(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://test:test@127.0.0.1:5432/test";
    verifier = await import("../../frontend/api/lib/quoteAssetVerification.js");
    payer = await fundedPayer(connection);
  });

  it("reads no extensions from a plain Token-2022 mint the token program wrote", async () => {
    const mint = await createToken2022Mint(connection, payer, []);
    const info = await connection.getAccountInfo(mint, "confirmed");
    assert.equal(info.owner.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());
    assert.equal(info.data.readUInt8(44), DECIMALS, "decimals sit at the classic offset in Token-2022 too");
    assert.deepEqual(verifier.token2022MintExtensions(info.data), []);
    assert.deepEqual(verifier.disallowedToken2022Extensions(info.data), []);
  });

  it("accepts a metadata pointer, which cannot change a balance", async () => {
    const mint = await createToken2022Mint(connection, payer, [ExtensionType.MetadataPointer]);
    const info = await connection.getAccountInfo(mint, "confirmed");
    assert.deepEqual(
      verifier.token2022MintExtensions(info.data),
      [ExtensionType.MetadataPointer],
      "the parser must find the extension the token program actually wrote",
    );
    assert.deepEqual(verifier.disallowedToken2022Extensions(info.data), []);
  });

  it("classifies a transfer fee as an issuer power, which the creator is warned about", async () => {
    const mint = await createToken2022Mint(connection, payer, [ExtensionType.TransferFeeConfig]);
    const info = await connection.getAccountInfo(mint, "confirmed");
    assert.deepEqual(verifier.token2022MintExtensions(info.data), [ExtensionType.TransferFeeConfig]);
    // Not a refusal any more: graduation accepts the binding and the creator is
    // told the sweep receives less than it sends. The classification is what
    // the confirmation dialog is built from.
    assert.deepEqual(verifier.disallowedToken2022Extensions(info.data), ["TransferFeeConfig"]);
    const risks = verifier.token2022BindingRisks(info.data);
    assert.ok(risks.some((risk) => risk.code === "TRANSFER_FEE" && risk.armed));
  });

  it("the authorization API derives the Token-2022 ATA that actually exists on chain", async () => {
    const mint = await createToken2022Mint(connection, payer, [ExtensionType.MetadataPointer]);
    const owner = Keypair.generate().publicKey;
    const created = await getOrCreateAssociatedTokenAccount(
      connection, payer, mint, owner, false, "confirmed", undefined, TOKEN_2022_PROGRAM_ID,
    );

    const api = await import("../../frontend/api/dev-fix/solana-graduation-authorization-v2.js");
    const derived = api.deriveAta(owner.toBase58(), mint.toBase58(), api.TOKEN_2022_PROGRAM_ID);
    assert.equal(derived, created.address.toBase58(), "derived quote ATA must be the account that exists");

    const live = await connection.getAccountInfo(new PublicKey(derived), "confirmed");
    assert.ok(live, "the derived address must hold a real account");
    assert.equal(live.owner.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());

    // The classic derivation points somewhere else entirely -- that address is
    // what the sweep would have used, and nothing lives there.
    const classic = api.deriveAta(owner.toBase58(), mint.toBase58());
    assert.notEqual(classic, derived);
    assert.equal(
      await connection.getAccountInfo(new PublicKey(classic), "confirmed"),
      null,
      "the classic derivation must not accidentally hit a real account",
    );
    assert.equal(
      getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID).toBase58(),
      classic,
      "and it is exactly what spl-token derives for the classic program",
    );
  });
});
