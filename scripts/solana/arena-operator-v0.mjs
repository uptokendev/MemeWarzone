import { createHash } from "node:crypto";
import {
  Ed25519Program,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";

import { sendServerV0 } from "./send-server-v0.mjs";

export const ARENA_PROGRAM_ID = new PublicKey("2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX");
export const ARENA_RESOLUTION_DOMAIN = Buffer.from("MWZ_ARENA_RESOLVE_V2", "utf8");
export const ARENA_CANCEL_DOMAIN = Buffer.from("MWZ_ARENA_CANCEL_V1", "utf8");

const SEEDS = Object.freeze({
  config: Buffer.from("arena_config"),
  pool: Buffer.from("arena_pool"),
  vault: Buffer.from("arena_vault"),
  buyIn: Buffer.from("arena_buyin"),
  claim: Buffer.from("arena_claim"),
});

export const ARENA_CLAIM_PROTOCOL = 1;
export const ARENA_CLAIM_MWL = 2;
export const ARENA_CLAIM_CHARITY = 3;
export const ARENA_KIND_BATTLE = "battle";
export const ARENA_KIND_TOURNAMENT = "tournament";
export const ARENA_KIND_BATTLE_CODE = 0;
export const ARENA_KIND_TOURNAMENT_CODE = 1;

function assert32(value, label = "Arena id") {
  const bytes = Buffer.from(value);
  if (bytes.length !== 32) throw new Error(`${label} must be exactly 32 bytes`);
  return bytes;
}
function assertPoolId(poolId) { return assert32(poolId, "Arena pool id"); }
function u64le(value) { const out = Buffer.alloc(8); out.writeBigUInt64LE(BigInt(value)); return out; }
function i64le(value) { const out = Buffer.alloc(8); out.writeBigInt64LE(BigInt(value)); return out; }
function discriminator(name) { return createHash("sha256").update(`global:${name}`, "utf8").digest().subarray(0, 8); }
function derive(...seeds) { return PublicKey.findProgramAddressSync(seeds, ARENA_PROGRAM_ID)[0]; }
function kindCode(kind) {
  if (kind === ARENA_KIND_BATTLE) return ARENA_KIND_BATTLE_CODE;
  if (kind === ARENA_KIND_TOURNAMENT) return ARENA_KIND_TOURNAMENT_CODE;
  throw new Error("Arena pool kind must be battle or tournament");
}

export function deriveArenaOperatorPdas(poolId) {
  const id = assertPoolId(poolId);
  return { config: derive(SEEDS.config), pool: derive(SEEDS.pool, id), vault: derive(SEEDS.vault, id) };
}

export function deriveArenaBuyInReceipt(poolId, entryAsset, entrant) {
  const id = assertPoolId(poolId);
  return derive(SEEDS.buyIn, id, new PublicKey(entryAsset).toBuffer(), new PublicKey(entrant).toBuffer());
}

export function deriveArenaClaimReceipt(poolId, bucket) {
  const id = assertPoolId(poolId);
  if (!Number.isInteger(bucket) || bucket < 0 || bucket > 255) throw new Error("Invalid Arena claim bucket");
  return derive(SEEDS.claim, id, Buffer.from([bucket]));
}

export function buildArenaInitializeInstruction({ authority, rewardsConfig, resolver, protocolReceiver, mwlReceiver, charityReceiver }) {
  return new TransactionInstruction({
    programId: ARENA_PROGRAM_ID,
    keys: [
      { pubkey: new PublicKey(authority), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(rewardsConfig), isSigner: false, isWritable: false },
      { pubkey: derive(SEEDS.config), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      discriminator("initialize_arena"), new PublicKey(resolver).toBuffer(),
      new PublicKey(protocolReceiver).toBuffer(), new PublicKey(mwlReceiver).toBuffer(),
      new PublicKey(charityReceiver).toBuffer(),
    ]),
  });
}

export function buildArenaSetResolverInstruction({ authority, rewardsConfig, resolver }) {
  return new TransactionInstruction({
    programId: ARENA_PROGRAM_ID,
    keys: [
      { pubkey: new PublicKey(authority), isSigner: true, isWritable: false },
      { pubkey: new PublicKey(rewardsConfig), isSigner: false, isWritable: false },
      { pubkey: derive(SEEDS.config), isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([discriminator("set_arena_resolver"), new PublicKey(resolver).toBuffer()]),
  });
}

export function buildArenaSetReceiversInstruction({ authority, rewardsConfig, protocolReceiver, mwlReceiver, charityReceiver }) {
  return new TransactionInstruction({
    programId: ARENA_PROGRAM_ID,
    keys: [
      { pubkey: new PublicKey(authority), isSigner: true, isWritable: false },
      { pubkey: new PublicKey(rewardsConfig), isSigner: false, isWritable: false },
      { pubkey: derive(SEEDS.config), isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([discriminator("set_arena_receivers"), new PublicKey(protocolReceiver).toBuffer(), new PublicKey(mwlReceiver).toBuffer(), new PublicKey(charityReceiver).toBuffer()]),
  });
}

export function buildArenaPauseInstruction({ authority, rewardsConfig, paused }) {
  return new TransactionInstruction({
    programId: ARENA_PROGRAM_ID,
    keys: [
      { pubkey: new PublicKey(authority), isSigner: true, isWritable: false },
      { pubkey: new PublicKey(rewardsConfig), isSigner: false, isWritable: false },
      { pubkey: derive(SEEDS.config), isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([discriminator("set_arena_pause"), Buffer.from([paused ? 1 : 0])]),
  });
}

export function buildArenaOpenTournamentInstruction({ authority, poolId, buyInLamports, supportDeadline, depositDeadline, resolveDeadline }) {
  const id = assertPoolId(poolId);
  const { config, pool, vault } = deriveArenaOperatorPdas(id);
  return new TransactionInstruction({
    programId: ARENA_PROGRAM_ID,
    keys: [
      { pubkey: new PublicKey(authority), isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([discriminator("open_tournament_pool_v2"), id, u64le(buyInLamports), i64le(supportDeadline), i64le(depositDeadline), i64le(resolveDeadline)]),
  });
}

export function buildArenaCloseSupportInstruction({ caller, poolId }) {
  const id = assertPoolId(poolId);
  const { config, pool } = deriveArenaOperatorPdas(id);
  return new TransactionInstruction({
    programId: ARENA_PROGRAM_ID,
    keys: [
      { pubkey: new PublicKey(caller), isSigner: true, isWritable: false },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: pool, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([discriminator("close_support_v2"), id]),
  });
}

export function buildArenaResolutionMessage(input) {
  const id = assertPoolId(input.poolId);
  const outcomeHash = assert32(input.outcomeHash, "Arena outcome hash");
  return Buffer.concat([
    ARENA_RESOLUTION_DOMAIN, ARENA_PROGRAM_ID.toBuffer(), Buffer.from([input.version]), id,
    new PublicKey(input.pool).toBuffer(), Buffer.from([kindCode(input.kind)]),
    new PublicKey(input.assetA).toBuffer(), new PublicKey(input.assetB).toBuffer(),
    new PublicKey(input.ownerA).toBuffer(), new PublicKey(input.ownerB).toBuffer(),
    u64le(input.stakeA), u64le(input.stakeB), u64le(input.supportTotal), u64le(input.prizeBoostTotal), u64le(input.buyInTotal),
    Buffer.from([input.winnerSide]), new PublicKey(input.winnerAsset).toBuffer(), new PublicKey(input.winnerWallet).toBuffer(),
    Buffer.from([input.resultType]), outcomeHash, i64le(input.deadline), u64le(input.nonce),
  ]);
}

export function buildArenaResolveInstructions(input) {
  if (!input.resolver?.secretKey || !input.resolver?.publicKey) throw new Error("Arena resolver keypair is required");
  const id = assertPoolId(input.poolId);
  const { config, pool } = deriveArenaOperatorPdas(id);
  let receipt = pool;
  if (input.kind === ARENA_KIND_TOURNAMENT) {
    const expected = deriveArenaBuyInReceipt(id, input.winnerAsset, input.winnerWallet);
    if (input.winnerBuyInReceipt && !new PublicKey(input.winnerBuyInReceipt).equals(expected)) throw new Error("Arena tournament winner receipt does not match canonical asset+wallet PDA");
    receipt = expected;
  }
  const message = buildArenaResolutionMessage({ ...input, pool });
  return {
    verifyIx: Ed25519Program.createInstructionWithPrivateKey({ privateKey: input.resolver.secretKey, message }),
    resolveIx: new TransactionInstruction({
      programId: ARENA_PROGRAM_ID,
      keys: [
        { pubkey: config, isSigner: false, isWritable: false },
        { pubkey: pool, isSigner: false, isWritable: true },
        { pubkey: receipt, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([
        discriminator("resolve_pool_v2"), id, Buffer.from([input.resultType]), Buffer.from([input.winnerSide]),
        new PublicKey(input.winnerAsset).toBuffer(), new PublicKey(input.winnerWallet).toBuffer(),
        assert32(input.outcomeHash, "Arena outcome hash"), i64le(input.deadline), u64le(input.nonce),
      ]),
    }),
    message, pool, config, winnerReceipt: receipt,
  };
}

export function buildArenaCancelMessage(input) {
  const id = assertPoolId(input.poolId);
  return Buffer.concat([
    ARENA_CANCEL_DOMAIN, ARENA_PROGRAM_ID.toBuffer(), Buffer.from([input.version]), id,
    new PublicKey(input.pool).toBuffer(), Buffer.from([input.reasonCode]),
    u64le(input.stakeA), u64le(input.stakeB), u64le(input.supportTotal), u64le(input.buyInTotal),
    u64le(input.prizeBoostTotal), i64le(input.deadline), u64le(input.nonce),
  ]);
}

export function buildArenaCancelInstructions(input) {
  if (!input.resolver?.secretKey || !input.resolver?.publicKey) throw new Error("Arena resolver keypair is required");
  const id = assertPoolId(input.poolId);
  const { config, pool } = deriveArenaOperatorPdas(id);
  const message = buildArenaCancelMessage({ ...input, pool });
  return {
    verifyIx: Ed25519Program.createInstructionWithPrivateKey({ privateKey: input.resolver.secretKey, message }),
    cancelIx: new TransactionInstruction({
      programId: ARENA_PROGRAM_ID,
      keys: [
        { pubkey: config, isSigner: false, isWritable: false },
        { pubkey: pool, isSigner: false, isWritable: true },
        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([discriminator("cancel_pool_v2"), id, Buffer.from([input.reasonCode]), i64le(input.deadline), u64le(input.nonce)]),
    }),
    message, pool, config,
  };
}

function claimBucketInstructionName(bucket) {
  if (bucket === ARENA_CLAIM_PROTOCOL) return "claim_protocol";
  if (bucket === ARENA_CLAIM_MWL) return "claim_mwl";
  if (bucket === ARENA_CLAIM_CHARITY) return "claim_charity";
  throw new Error("Unsupported Arena operator claim bucket");
}

export function buildArenaOperatorClaimInstruction({ caller, poolId, bucket, receiver }) {
  const id = assertPoolId(poolId);
  const { config, pool, vault } = deriveArenaOperatorPdas(id);
  const claimReceipt = deriveArenaClaimReceipt(id, bucket);
  return {
    claimReceipt,
    instruction: new TransactionInstruction({
      programId: ARENA_PROGRAM_ID,
      keys: [
        { pubkey: new PublicKey(caller), isSigner: true, isWritable: true },
        { pubkey: config, isSigner: false, isWritable: false },
        { pubkey: pool, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: new PublicKey(receiver), isSigner: false, isWritable: true },
        { pubkey: claimReceipt, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([discriminator(claimBucketInstructionName(bucket)), id]),
    }),
  };
}

export async function sendArenaOperatorV0(connection, payer, instructions, label) {
  for (const instruction of instructions) {
    if (!instruction.programId.equals(ARENA_PROGRAM_ID) && !instruction.programId.equals(Ed25519Program.programId)) {
      throw new Error(`${label}: unexpected program ${instruction.programId.toBase58()}`);
    }
  }
  return sendServerV0(connection, payer, instructions, label);
}
