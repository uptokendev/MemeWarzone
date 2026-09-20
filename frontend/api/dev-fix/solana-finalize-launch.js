/**
 * Sends finalize_campaign_launch: the second half of a Solana launch.
 *
 * create_campaign mints the supply and opens the campaign, but deliberately
 * does not write the Metaplex metadata account, revoke the mint authority or
 * create the fee accounts. Those three moved here because carrying them in
 * create cost four accounts and 31 bytes of arguments, which left Phantom too
 * little of the 1232-byte packet limit to insert its Lighthouse assertions. It
 * responded by refusing to simulate and warning every creator that the site
 * might be malicious. See programs/memewarzone_solana/src/finalize_launch.rs.
 *
 * The creator signs and pays for finalize in the browser, immediately after
 * create. The server's only job is to issue the route authorization that binds
 * the name and symbol; it holds no funds and needs none. `issueFinalizeLaunchAuthorization`
 * is that path.
 *
 * `sendFinalizeCampaignLaunch` below is the recovery path, not the normal one:
 * an operator uses it to finish a launch whose creator closed the tab between
 * the two transactions. The payer does not have to be the creator — the
 * instruction needs a funded signer and a valid route signature, nothing more —
 * so a stranded launch stays recoverable without anyone keeping a hot wallet
 * topped up.
 *
 * Until this lands the campaign has no fee escrow and therefore cannot trade.
 * That is the intended state, not a race — it is what makes the gap between the
 * two transactions safe rather than merely short.
 */
import {
  Connection,
  Ed25519Program,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import {
  FINALIZE_LAUNCH_SCHEMA_VERSION,
  SYSVAR_INSTRUCTIONS_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  borshString,
  createEd25519Signer,
  finalizeLaunchDigest,
  i64,
} from "./solana-v4-primitives.js";

export const MPL_TOKEN_METADATA_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

/**
 * Anchor's discriminator for `finalize_campaign_launch`: the first eight bytes
 * of sha256("global:finalize_campaign_launch"). Computed at import rather than
 * pasted, so renaming the instruction cannot leave a stale constant behind.
 */
import crypto from "node:crypto";
export const FINALIZE_CAMPAIGN_LAUNCH_DISCRIMINATOR = crypto
  .createHash("sha256")
  .update("global:finalize_campaign_launch")
  .digest()
  .subarray(0, 8);

/**
 * The three accounts finalize creates, derived from the campaign and mint that
 * create already produced. Kept here rather than imported from the create path
 * so the keeper can finalize a stranded campaign knowing only its on-chain
 * addresses.
 */
export function deriveFinalizeAccounts({ programId, campaign, mint }) {
  const program = new PublicKey(programId);
  const campaignKey = new PublicKey(campaign);
  const mintKey = new PublicKey(mint);
  const mpl = new PublicKey(MPL_TOKEN_METADATA_PROGRAM_ID);
  const [tokenMetadata] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata", "utf8"), mpl.toBuffer(), mintKey.toBuffer()],
    mpl,
  );
  const [feeEscrow] = PublicKey.findProgramAddressSync(
    [Buffer.from("fee-escrow", "utf8"), campaignKey.toBuffer()],
    program,
  );
  const [creatorFeeVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("creator-fee-vault", "utf8"), campaignKey.toBuffer()],
    program,
  );
  const [globalConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("global", "utf8")],
    program,
  );
  return {
    tokenMetadata: tokenMetadata.toBase58(),
    feeEscrow: feeEscrow.toBase58(),
    creatorFeeVault: creatorFeeVault.toBase58(),
    globalConfig: globalConfig.toBase58(),
  };
}

/** Default validity window for a finalize signature. */
export const DEFAULT_FINALIZE_TTL_SECONDS = 900;

export function encodeFinalizeCampaignLaunchData({ name, symbol, deadline }) {
  return Buffer.concat([
    FINALIZE_CAMPAIGN_LAUNCH_DISCRIMINATOR,
    borshString(name, 32, "name"),
    borshString(symbol, 10, "symbol"),
    i64(deadline, "deadline"),
  ]);
}

/**
 * Account order must match FinalizeCampaignLaunch in the program. Anchor matches
 * positionally, so a reordering here is not a compile error anywhere — it is a
 * runtime failure with a confusing message.
 */
export function buildFinalizeCampaignLaunchInstruction({
  programId,
  payer,
  globalConfig,
  campaign,
  mint,
  tokenMetadata,
  feeEscrow,
  creatorFeeVault,
  args,
}) {
  const meta = (pubkey, isSigner, isWritable) => ({
    pubkey: new PublicKey(pubkey),
    isSigner,
    isWritable,
  });
  return new TransactionInstruction({
    programId: new PublicKey(programId),
    keys: [
      meta(payer, true, true),
      meta(globalConfig, false, false),
      meta(campaign, false, true),
      meta(mint, false, true),
      meta(tokenMetadata, false, true),
      meta(MPL_TOKEN_METADATA_PROGRAM_ID, false, false),
      meta(feeEscrow, false, true),
      meta(creatorFeeVault, false, true),
      meta(SYSVAR_INSTRUCTIONS_ID, false, false),
      meta(TOKEN_PROGRAM_ID, false, false),
      meta(SYSTEM_PROGRAM_ID, false, false),
    ],
    data: encodeFinalizeCampaignLaunchData(args),
  });
}

/**
 * Build the two instructions finalize needs, in order.
 *
 * The program reads the ed25519 instruction back out of the Instructions sysvar
 * and requires it to sit immediately before its own, so these must stay adjacent
 * and in this order. Nothing may be inserted between them.
 */
export function buildFinalizeLaunchInstructions({
  programId,
  routeSignerSecret,
  payer,
  globalConfig,
  campaign,
  mint,
  creator,
  campaignId,
  tokenMetadata,
  feeEscrow,
  creatorFeeVault,
  args,
}) {
  const signer = createEd25519Signer(routeSignerSecret);
  const digest = finalizeLaunchDigest({
    programId,
    campaign,
    mint,
    creator,
    campaignId,
    args,
  });
  const signature = signer.sign(digest);

  const ed25519Instruction = Ed25519Program.createInstructionWithPublicKey({
    publicKey: Uint8Array.from(signer.publicKey),
    message: Uint8Array.from(digest),
    signature: Uint8Array.from(signature),
  });

  const programInstruction = buildFinalizeCampaignLaunchInstruction({
    programId,
    payer,
    globalConfig,
    campaign,
    mint,
    tokenMetadata,
    feeEscrow,
    creatorFeeVault,
    args,
  });

  return { ed25519Instruction, programInstruction, digest, routeSigner: signer.publicKeyBase58 };
}

/**
 * Issue the route authorization the browser needs to send finalize itself.
 *
 * Returns the signature over the digest rather than a built transaction: the
 * client already knows how to assemble an ed25519 instruction followed by a
 * program instruction, and the server should not be choosing blockhashes or fee
 * payers for a transaction it does not pay for.
 */
export function issueFinalizeLaunchAuthorization({
  programId,
  routeSignerSecret,
  campaign,
  mint,
  creator,
  campaignId,
  name,
  symbol,
  chainNow,
  ttlSeconds = DEFAULT_FINALIZE_TTL_SECONDS,
}) {
  const now = Number.isFinite(chainNow) ? Number(chainNow) : Math.floor(Date.now() / 1000);
  const args = { name, symbol, deadline: now + ttlSeconds };
  const signer = createEd25519Signer(routeSignerSecret);
  const digest = finalizeLaunchDigest({ programId, campaign, mint, creator, campaignId, args });
  const signature = signer.sign(digest);
  const accounts = deriveFinalizeAccounts({ programId, campaign, mint });

  return {
    schemaVersion: FINALIZE_LAUNCH_SCHEMA_VERSION,
    routeSigner: signer.publicKeyBase58,
    digestHex: Buffer.from(digest).toString("hex"),
    signatureHex: Buffer.from(signature).toString("hex"),
    // deadline is a string so a 64-bit value survives JSON intact.
    args: { name: args.name, symbol: args.symbol, deadline: String(args.deadline) },
    accounts: { campaign, mint, ...accounts },
  };
}

function loadPayerKeypair(secret) {
  const raw = String(secret || "").trim();
  if (!raw) throw new Error("SOLANA_FINALIZE_PAYER_SECRET_KEY is required");
  if (raw.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  const bytes = Buffer.from(raw, "hex");
  // A 32-byte value is a seed; a 64-byte value is a full expanded secret key.
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  throw new Error(`SOLANA_FINALIZE_PAYER_SECRET_KEY must be 32 or 64 bytes, got ${bytes.length}`);
}

/**
 * Recovery path: send finalize from an operator wallet and wait for confirmation.
 *
 * The normal path is the creator's own transaction in the browser. This exists
 * for launches stranded between the two, where nobody is left to sign.
 *
 * Idempotent against the chain rather than against this process: the program
 * refuses a second finalize for a campaign whose mint authority is already
 * revoked, so a retry after an ambiguous timeout is safe and fails loudly
 * instead of half-applying.
 */
export async function sendFinalizeCampaignLaunch({
  rpcUrl,
  programId,
  routeSignerSecret,
  payerSecret,
  globalConfig,
  campaign,
  mint,
  creator,
  campaignId,
  tokenMetadata,
  feeEscrow,
  creatorFeeVault,
  name,
  symbol,
  chainNow,
  ttlSeconds = DEFAULT_FINALIZE_TTL_SECONDS,
}) {
  const connection = new Connection(rpcUrl, "confirmed");
  const payerKeypair = loadPayerKeypair(payerSecret);

  const now = Number.isFinite(chainNow) ? Number(chainNow) : Math.floor(Date.now() / 1000);
  const args = { name, symbol, deadline: now + ttlSeconds };

  const { ed25519Instruction, programInstruction } = buildFinalizeLaunchInstructions({
    programId,
    routeSignerSecret,
    payer: payerKeypair.publicKey.toBase58(),
    globalConfig,
    campaign,
    mint,
    creator,
    campaignId,
    tokenMetadata,
    feeEscrow,
    creatorFeeVault,
    args,
  });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: payerKeypair.publicKey,
    recentBlockhash: blockhash,
    instructions: [ed25519Instruction, programInstruction],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([payerKeypair]);

  const signature = await connection.sendTransaction(transaction, { skipPreflight: false });
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  return { signature, deadline: args.deadline, payer: payerKeypair.publicKey.toBase58() };
}
