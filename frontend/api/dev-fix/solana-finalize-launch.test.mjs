import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DEFAULT_FINALIZE_TTL_SECONDS,
  FINALIZE_CAMPAIGN_LAUNCH_DISCRIMINATOR,
  MPL_TOKEN_METADATA_PROGRAM_ID,
  buildFinalizeCampaignLaunchInstruction,
  buildFinalizeLaunchInstructions,
  encodeFinalizeCampaignLaunchData,
  issueFinalizeLaunchAuthorization,
} from "./solana-finalize-launch.js";

const PROGRAM_ID = "3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt";
const ROUTE_SIGNER_SECRET = Buffer.alloc(32, 7).toString("hex");

// Distinct, valid base58 pubkeys so a swapped pair is visible in a diff.
const ACCOUNTS = {
  payer: "9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H",
  globalConfig: "B9NnmsXRQkZDr9LWwTnTU86mb26Uc5zp7G5gxdb6Jg5U",
  campaign: "4jgaCyF5tRqzmEzKG6uo3d8ojSJsnBwJpNxQGSZK8jHL",
  mint: "AWZQG19a3c9YTCdTWiPu1CacKG3KkyDRuTFHwP2ENvX1",
  tokenMetadata: "6NXdPN4DdgAdiBsVGoAtfvWNtEJ5feiMe77v4UaQdbxo",
  feeEscrow: "29HsdgN7yRT9NmHUX524p52gAGRXHzJeSo9DnMvQEnjS",
  creatorFeeVault: "5pR4WbhEbnP6WFkZbzJmvLgtUC2ZfkM4xGKzXQD7zkA2",
};

function instruction(overrides = {}) {
  return buildFinalizeCampaignLaunchInstruction({
    programId: PROGRAM_ID,
    ...ACCOUNTS,
    args: { name: "Kaiju88", symbol: "K88", deadline: 1_800_000_000 },
    ...overrides,
  });
}

test("the discriminator is Anchor's, derived rather than pasted", () => {
  const expected = crypto
    .createHash("sha256")
    .update("global:finalize_campaign_launch")
    .digest()
    .subarray(0, 8);
  assert.deepEqual(Buffer.from(FINALIZE_CAMPAIGN_LAUNCH_DISCRIMINATOR), expected);
  assert.equal(FINALIZE_CAMPAIGN_LAUNCH_DISCRIMINATOR.length, 8);
});

/**
 * Anchor matches accounts positionally. A reordering here compiles, deploys and
 * then fails on chain with an error naming the wrong account entirely, so the
 * order is pinned against the program source rather than restated by hand.
 */
test("account order matches FinalizeCampaignLaunch in the program", () => {
  const source = readFileSync(
    new URL("../../../programs/memewarzone_solana/src/finalize_launch.rs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("pub struct FinalizeCampaignLaunch<'info> {");
  assert.ok(start > 0, "the accounts struct must exist");
  const block = source.slice(start, source.indexOf("\n}", start));
  const fields = [...block.matchAll(/^\s{4}pub ([a-z_][a-z0-9_]*):/gm)].map((m) => m[1]);

  const expected = [
    "payer",
    "global_config",
    "campaign",
    "mint",
    "token_metadata",
    "token_metadata_program",
    "fee_escrow",
    "creator_fee_vault",
    "instructions",
    "token_program",
    "system_program",
  ];
  assert.deepEqual(fields, expected, "program account order changed; update the builder with it");
  assert.equal(instruction().keys.length, expected.length);
});

test("only the payer signs, and only the accounts finalize writes are writable", () => {
  const keys = instruction().keys.map((k) => ({
    pubkey: k.pubkey.toBase58(),
    isSigner: k.isSigner,
    isWritable: k.isWritable,
  }));

  assert.deepEqual(
    keys.filter((k) => k.isSigner).map((k) => k.pubkey),
    [ACCOUNTS.payer],
    "the route signature authorizes this, so nothing else may need to sign",
  );

  // campaign flips mint_authority_revoked, mint loses its authority, and the
  // other three are created. Anything else writable would be a mistake.
  assert.deepEqual(
    keys.filter((k) => k.isWritable).map((k) => k.pubkey).sort(),
    [
      ACCOUNTS.payer,
      ACCOUNTS.campaign,
      ACCOUNTS.mint,
      ACCOUNTS.tokenMetadata,
      ACCOUNTS.feeEscrow,
      ACCOUNTS.creatorFeeVault,
    ].sort(),
  );
});

test("the Metaplex program is pinned, not taken from the caller", () => {
  const keys = instruction().keys.map((k) => k.pubkey.toBase58());
  assert.equal(keys[5], MPL_TOKEN_METADATA_PROGRAM_ID);
  // Passing a different one must not be possible through the builder's surface.
  const withExtra = instruction({ tokenMetadataProgram: "11111111111111111111111111111111" });
  assert.equal(withExtra.keys[5].pubkey.toBase58(), MPL_TOKEN_METADATA_PROGRAM_ID);
});

test("instruction data is the discriminator plus borsh name, symbol and deadline", () => {
  const data = encodeFinalizeCampaignLaunchData({
    name: "Kaiju88",
    symbol: "K88",
    deadline: 1_800_000_000,
  });
  // 8 discriminator + (4 + 7) name + (4 + 3) symbol + 8 deadline
  assert.equal(data.length, 8 + 4 + 7 + 4 + 3 + 8);
  assert.deepEqual(data.subarray(0, 8), Buffer.from(FINALIZE_CAMPAIGN_LAUNCH_DISCRIMINATOR));
  assert.equal(data.readUInt32LE(8), 7);
  assert.equal(data.subarray(12, 19).toString("utf8"), "Kaiju88");
});

test("Metaplex length limits are refused before they reach the chain", () => {
  assert.throws(
    () => encodeFinalizeCampaignLaunchData({ name: "A".repeat(33), symbol: "K", deadline: 1 }),
    /32-byte Metaplex limit/,
  );
  assert.throws(
    () => encodeFinalizeCampaignLaunchData({ name: "A", symbol: "B".repeat(11), deadline: 1 }),
    /10-byte Metaplex limit/,
  );
});

/**
 * The program loads the ed25519 instruction from the Instructions sysvar at
 * `current_index - 1`. If anything is inserted between the two, or the order is
 * swapped, the signature cannot be found and every launch is stranded unnamed.
 */
test("the ed25519 instruction is built to sit immediately before the program instruction", () => {
  const built = buildFinalizeLaunchInstructions({
    programId: PROGRAM_ID,
    routeSignerSecret: ROUTE_SIGNER_SECRET,
    ...ACCOUNTS,
    creator: "3SyuXsZfQB3JCjGFTpzioswp8ZkVuf7QGVEYwF6k8nG2",
    campaignId: Buffer.alloc(32, 5),
    args: { name: "Kaiju88", symbol: "K88", deadline: 1_800_000_000 },
  });

  assert.equal(
    built.ed25519Instruction.programId.toBase58(),
    "Ed25519SigVerify111111111111111111111111111",
  );
  assert.equal(built.ed25519Instruction.keys.length, 0);
  assert.equal(built.programInstruction.programId.toBase58(), PROGRAM_ID);
  assert.equal(built.digest.length, 32);

  // The signed message must be the digest itself, not the payload, or the
  // program's comparison against its own rebuilt digest cannot match.
  const data = built.ed25519Instruction.data;
  const messageOffset = data.readUInt16LE(10);
  const messageSize = data.readUInt16LE(12);
  assert.equal(messageSize, 32);
  assert.deepEqual(data.subarray(messageOffset, messageOffset + messageSize), Buffer.from(built.digest));
});

test("the signature window is bounded", () => {
  assert.ok(DEFAULT_FINALIZE_TTL_SECONDS > 0);
  // Long enough to survive a retry, short enough that a leaked signature for a
  // campaign that failed to finalize cannot be used days later.
  assert.ok(DEFAULT_FINALIZE_TTL_SECONDS <= 3600);
});

// Metaplex caps a name at 32 bytes and a symbol at 10. Our own draft fields are
// not bounded by those, so a 40-character name reached the encoder and threw,
// which surfaced as a 500 on finalize and a token left permanently unnamed. The
// create path had always clipped; the clipping was lost when the metadata call
// moved out of create_campaign.
test("an over-long name is clipped rather than refused", () => {
  const long = "All about graduation and getting it done"; // 40 bytes
  assert.ok(long.length > 32);

  const authorization = issueFinalizeLaunchAuthorization({
    programId: PROGRAM_ID,
    routeSignerSecret: ROUTE_SIGNER_SECRET,
    campaign: ACCOUNTS.campaign,
    mint: ACCOUNTS.mint,
    creator: "3SyuXsZfQB3JCjGFTpzioswp8ZkVuf7QGVEYwF6k8nG2",
    campaignId: Buffer.alloc(32, 5),
    name: long,
    symbol: "ABGAGID",
    chainNow: 1_789_900_000,
  });

  assert.equal(authorization.args.name, long.slice(0, 32));
  assert.equal(Buffer.byteLength(authorization.args.name, "utf8"), 32);
  assert.equal(authorization.args.symbol, "ABGAGID");

  // And the clipped value is what the signature covers, so the program writes
  // exactly what was authorized.
  assert.equal(authorization.signatureHex.length, 128);
  assert.doesNotThrow(() => encodeFinalizeCampaignLaunchData(authorization.args));
});

test("an empty name falls back rather than producing an unnamed token", () => {
  const authorization = issueFinalizeLaunchAuthorization({
    programId: PROGRAM_ID,
    routeSignerSecret: ROUTE_SIGNER_SECRET,
    campaign: ACCOUNTS.campaign,
    mint: ACCOUNTS.mint,
    creator: "3SyuXsZfQB3JCjGFTpzioswp8ZkVuf7QGVEYwF6k8nG2",
    campaignId: Buffer.alloc(32, 5),
    name: "   ",
    symbol: "",
    chainNow: 1_789_900_000,
  });
  assert.equal(authorization.args.name, "MemeWarzone Token");
  assert.equal(authorization.args.symbol, "MWZ");
});
