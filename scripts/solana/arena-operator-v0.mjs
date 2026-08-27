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
export const ARENA_RESOLUTION_DOMAIN = Buffer.from("MWZ_ARENA_RESOLVE_V1", "utf8");

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

function assertPoolId(poolId) {
  const bytes = Buffer.from(poolId);
  if (bytes.length !== 32) throw new Error("Arena pool id must be exactly 32 bytes");
  return bytes;
}

function u64le(value) {
  let n = BigInt(value);
  if (n < 0n || n > (1n << 64n) - 1n) throw new Error("u64 overflow");
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(n);
  return out;
}

function i64le(value) {
  const n = BigInt(value);
  if (n < -(1n << 63n) || n > (1n << 63n) - 1n) throw new Error("i64 overflow");
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(n);
  return out;
}

function discriminator(name) {
  return createHash("sha256").update(`global:${name}`, "utf8").digest().subarray(0, 8);
}

function derive(...seeds) {
  return PublicKey.findProgramAddressSync(seeds, ARENA_PROGRAM_ID)[0];
}

export function deriveArenaOperatorPdas(poolId) {
  const id = assertPoolId(poolId);
  return {
    config: derive(SEEDS.config),
    pool: derive(SEEDS.pool, id),
    vault: derive(SEEDS.vault, id),
  };
}

export function deriveArenaBuyInReceipt(poolId, entrant) {
  const id = assertPoolId(poolId);
  const entrantKey = new PublicKey(entrant);
  return derive(SEEDS.buyIn, id, entrantKey.toBuffer());
}

export function deriveArenaClaimReceipt(poolId, bucket) {
  const id = assertPoolId(poolId);
  if (!Number.isInteger(bucket) || bucket < 0 || bucket > 255) throw new Error("Invalid Arena claim bucket");
  return derive(SEEDS.claim, id, Buffer.from([bucket]));
}

export function buildArenaInitializeInstruction({
  authority,
  rewardsConfig,
  resolver,
  protocolReceiver,
  mwlReceiver,
  charityReceiver,
}) {
  const arenaConfig = derive(SEEDS.config);
  const data = Buffer.concat([
    discriminator("initialize_arena"),
    new PublicKey(resolver).toBuffer(),
    new PublicKey(protocolReceiver).toBuffer(),
    new PublicKey(mwlReceiver).toBuffer(),
    new PublicKey(charityReceiver).toBuffer(),
  ]);
  return new TransactionInstruction({
    programId: ARENA_PROGRAM_ID,
    keys: [
      { pubkey: new PublicKey(authority), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(rewardsConfig), isSigner: false, isWritable: false },
      { pubkey: arenaConfig, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildArenaSetResolverInstruction({ authority, rewardsConfig, resolver }) {
  const arenaConfig = derive(SEEDS.config);
  return new TransactionInstruction({
    programId: ARENA_PROGRAM_ID,
    keys: [
      { pubkey: new PublicKey(authority), isSigner: true, isWritable: false },
      { pubkey: new PublicKey(rewardsConfig), isSigner: false, isWritable: false },
      { pubkey: arenaConfig, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([discriminator("set_arena_resolver"), new PublicKey(resolver).toBuffer()]),
  });
}

export function buildArenaSetReceiversInstruction({
  authority,
  rewardsConfig,
  protocolReceiver,
  mwlReceiver,
  charityReceiver,
}) {
  const arenaConfig = derive(SEEDS.config);
  return new TransactionInstruction({
    programId: ARENA_PROGRAM_ID,
    keys: [
      { pubkey: new PublicKey(authority), isSigner: true, isWritable: false },
      { pubkey: new PublicKey(rewardsConfig), isSigner: false, isWritable: false },
      { pubkey: arenaConfig, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([
      discriminator("set_arena_receivers"),
      new PublicKey(protocolReceiver).toBuffer(),
      new PublicKey(mwlReceiver).toBuffer(),
      new PublicKey(charityReceiver).toBuffer(),
    ]),
  });
}

export function buildArenaPauseInstruction({ authority, rewardsConfig, paused }) {
  const arenaConfig = derive(SEEDS.config);
  return new TransactionInstruction({
    programId: ARENA_PROGRAM_ID,
    keys: [
      { pubkey: new PublicKey(authority), isSigner: true, isWritable: false },
      { pubkey: new PublicKey(rewardsConfig), isSigner: false, isWritable: false },
      { pubkey: arenaConfig, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([discriminator("set_arena_pause"), Buffer.from([paused ? 1 : 0])]),
  });
}

export function buildArenaOpenTournamentInstruction({
  authority,
  poolId,
  buyInLamports,
  depositDeadline,
  resolveDeadline,
}) {
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
    data: Buffer.concat([
      discriminator("open_tournament_pool"),
      id,
      u64le(buyInLamports),
      i64le(depositDeadline),
      i64le(resolveDeadline),
    ]),
  });
}

export function buildArenaResolutionMessage({
  version,
  poolId,
  pool,
  winner,
  resultType,
  stakeTotal,
  supportTotal,
  buyInTotal,
  deadline,
  nonce,
}) {
  const id = assertPoolId(poolId);
  if (!Number.isInteger(version) || version < 0 || version > 255) throw new Error("Invalid Arena config version");
  if (!Number.isInteger(resultType) || resultType < 0 || resultType > 255) throw new Error("Invalid Arena result type");
  return Buffer.concat([
    ARENA_RESOLUTION_DOMAIN,
    ARENA_PROGRAM_ID.toBuffer(),
    Buffer.from([version]),
    id,
    new PublicKey(pool).toBuffer(),
    new PublicKey(winner).toBuffer(),
    Buffer.from([resultType]),
    u64le(stakeTotal),
    u64le(supportTotal),
    u64le(buyInTotal),
    i64le(deadline),
    u64le(nonce),
  ]);
}

export function buildArenaResolveInstructions({
  resolver,
  poolId,
  version,
  winner,
  resultType,
  stakeTotal,
  supportTotal,
  buyInTotal,
  deadline,
  nonce,
  winnerBuyInReceipt,
}) {
  if (!resolver?.secretKey || !resolver?.publicKey) throw new Error("Arena resolver keypair is required");
  const id = assertPoolId(poolId);
  const { config, pool } = deriveArenaOperatorPdas(id);
  const winnerKey = new PublicKey(winner);
  const expectedTournamentReceipt = winnerKey.equals(PublicKey.default)
    ? pool
    : deriveArenaBuyInReceipt(id, winnerKey);
  const receipt = winnerBuyInReceipt ? new PublicKey(winnerBuyInReceipt) : expectedTournamentReceipt;

  const message = buildArenaResolutionMessage({
    version,
    poolId: id,
    pool,
    winner: winnerKey,
    resultType,
    stakeTotal,
    supportTotal,
    buyInTotal,
    deadline,
    nonce,
  });
  const verifyIx = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: resolver.secretKey,
    message,
  });
  const resolveIx = new TransactionInstruction({
    programId: ARENA_PROGRAM_ID,
    keys: [
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: receipt, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      discriminator("resolve_pool"),
      id,
      Buffer.from([resultType]),
      winnerKey.toBuffer(),
      i64le(deadline),
      u64le(nonce),
    ]),
  });
  return { verifyIx, resolveIx, message, pool, config };
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
