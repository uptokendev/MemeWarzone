import type { Connection, TransactionInstruction } from "@solana/web3.js";

import { confirmLaunchpadSignature } from "@/lib/solanaConfirmSignature";
import { getSolanaProvider } from "@/lib/solanaWallet";
import type { SolanaWeb3Module } from "@/lib/solanaWeb3";
import { rewardsTreasuryProgramId, REWARDS_TREASURY_PROGRAM_ID } from "@/lib/solanaRewardsTreasury";
import {
  assertSolanaUserV0Intent,
  compileSolanaUserV0WithLatestBlockhash,
  simulateSolanaUserV0OrThrow,
} from "@/lib/solanaUserV0Transaction";

const utf8 = (value: string) => new TextEncoder().encode(value);

export const ARENA_CONFIG_SEED = "arena_config";
export const ARENA_POOL_SEED = "arena_pool";
export const ARENA_VAULT_SEED = "arena_vault";
export const ARENA_BUYIN_SEED = "arena_buyin";
export const ARENA_BOOST_SEED = "arena_boost";
export const ARENA_CLAIM_SEED = "arena_claim";
export const ARENA_REFUND_SEED = "arena_refund";
export const ARENA_CLAIM_WINNER = 0;
export const ARENA_KIND_BATTLE = 0;
export const ARENA_KIND_TOURNAMENT = 1;

export type ArenaPdas = {
  programId: string;
  config: string;
  pool: string;
  vault: string;
};

export type ArenaInstructionBuild = {
  instruction: TransactionInstruction;
  pdas: ArenaPdas;
  receipt?: string;
};

function assert32(value: Uint8Array, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new Error(`${label} must be exactly 32 bytes.`);
  }
  return value;
}

function assertPoolId(poolId: Uint8Array): Uint8Array {
  return assert32(poolId, "Arena pool id");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u64le(value: number | string | bigint): Uint8Array {
  let n = BigInt(value);
  if (n < 0n || n > (1n << 64n) - 1n) throw new Error("u64 overflow");
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function i64le(value: number | string | bigint): Uint8Array {
  let n = BigInt(value);
  const min = -(1n << 63n);
  const max = (1n << 63n) - 1n;
  if (n < min || n > max) throw new Error("i64 overflow");
  if (n < 0n) n = (1n << 64n) + n;
  return u64le(n);
}

async function anchorDiscriminator(name: string): Promise<Uint8Array> {
  if (!globalThis.crypto?.subtle) throw new Error("WebCrypto is required for Arena instruction encoding.");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", utf8(`global:${name}`));
  return new Uint8Array(digest).slice(0, 8);
}

function canonicalProgramId(): string {
  const configured = String(rewardsTreasuryProgramId() || "").trim();
  if (configured !== REWARDS_TREASURY_PROGRAM_ID) {
    throw new Error(`Arena refuses non-canonical rewards treasury program: ${configured || "missing"}`);
  }
  return configured;
}

function derivePda(
  web3: SolanaWeb3Module,
  programId: InstanceType<SolanaWeb3Module["PublicKey"]>,
  seeds: Uint8Array[],
): InstanceType<SolanaWeb3Module["PublicKey"]> {
  return web3.PublicKey.findProgramAddressSync(seeds, programId)[0];
}

export function deriveArenaPdas(web3: SolanaWeb3Module, poolId: Uint8Array): ArenaPdas {
  const canonicalPoolId = assertPoolId(poolId);
  const programId = new web3.PublicKey(canonicalProgramId());
  return {
    programId: programId.toBase58(),
    config: derivePda(web3, programId, [utf8(ARENA_CONFIG_SEED)]).toBase58(),
    pool: derivePda(web3, programId, [utf8(ARENA_POOL_SEED), canonicalPoolId]).toBase58(),
    vault: derivePda(web3, programId, [utf8(ARENA_VAULT_SEED), canonicalPoolId]).toBase58(),
  };
}

export function deriveArenaBuyInReceipt(
  web3: SolanaWeb3Module,
  poolId: Uint8Array,
  entryAsset: string,
  entrant: string,
): string {
  const programId = new web3.PublicKey(canonicalProgramId());
  return derivePda(web3, programId, [
    utf8(ARENA_BUYIN_SEED),
    assertPoolId(poolId),
    new web3.PublicKey(entryAsset).toBytes(),
    new web3.PublicKey(entrant).toBytes(),
  ]).toBase58();
}

export function deriveArenaBoostReceipt(
  web3: SolanaWeb3Module,
  poolId: Uint8Array,
  fundingId: Uint8Array,
  funder: string,
): string {
  const programId = new web3.PublicKey(canonicalProgramId());
  return derivePda(web3, programId, [
    utf8(ARENA_BOOST_SEED),
    assertPoolId(poolId),
    assert32(fundingId, "Arena funding id"),
    new web3.PublicKey(funder).toBytes(),
  ]).toBase58();
}

export function deriveArenaClaimReceipt(web3: SolanaWeb3Module, poolId: Uint8Array, bucket: number): string {
  if (!Number.isInteger(bucket) || bucket < 0 || bucket > 255) throw new Error("Invalid Arena claim bucket.");
  const programId = new web3.PublicKey(canonicalProgramId());
  return derivePda(web3, programId, [utf8(ARENA_CLAIM_SEED), assertPoolId(poolId), Uint8Array.of(bucket)]).toBase58();
}

function deriveArenaRefundReceipt(
  web3: SolanaWeb3Module,
  poolId: Uint8Array,
  wallet: string,
  identity: Uint8Array,
): string {
  const programId = new web3.PublicKey(canonicalProgramId());
  return derivePda(web3, programId, [
    utf8(ARENA_REFUND_SEED),
    assertPoolId(poolId),
    new web3.PublicKey(wallet).toBytes(),
    identity,
  ]).toBase58();
}

export async function buildArenaOpenBattleV0Instruction(input: {
  web3: SolanaWeb3Module;
  poolId: Uint8Array;
  opener: string;
  assetA: string;
  assetB: string;
  ownerA: string;
  ownerB: string;
  requiredStakeA: number | string | bigint;
  requiredStakeB: number | string | bigint;
  supportDeadline: number | string | bigint;
  depositDeadline: number | string | bigint;
  resolveDeadline: number | string | bigint;
}): Promise<ArenaInstructionBuild> {
  const poolId = assertPoolId(input.poolId);
  const pdas = deriveArenaPdas(input.web3, poolId);
  const opener = new input.web3.PublicKey(input.opener);
  const ownerA = new input.web3.PublicKey(input.ownerA);
  const ownerB = new input.web3.PublicKey(input.ownerB);
  if (opener.toBase58() !== ownerA.toBase58() && opener.toBase58() !== ownerB.toBase58()) {
    throw new Error("Arena opener must be one of the two battle owners.");
  }
  return {
    pdas,
    instruction: new input.web3.TransactionInstruction({
      programId: new input.web3.PublicKey(pdas.programId),
      keys: [
        { pubkey: opener, isSigner: true, isWritable: true },
        { pubkey: new input.web3.PublicKey(pdas.config), isSigner: false, isWritable: false },
        { pubkey: new input.web3.PublicKey(pdas.pool), isSigner: false, isWritable: true },
        { pubkey: new input.web3.PublicKey(pdas.vault), isSigner: false, isWritable: true },
        { pubkey: input.web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: concat(
        await anchorDiscriminator("open_battle_pool_v2"), poolId,
        new input.web3.PublicKey(input.assetA).toBytes(), new input.web3.PublicKey(input.assetB).toBytes(),
        ownerA.toBytes(), ownerB.toBytes(), u64le(input.requiredStakeA), u64le(input.requiredStakeB),
        i64le(input.supportDeadline), i64le(input.depositDeadline), i64le(input.resolveDeadline),
      ),
    }),
  };
}

export async function buildArenaDepositStakeV0Instruction(input: {
  web3: SolanaWeb3Module;
  poolId: Uint8Array;
  staker: string;
}): Promise<ArenaInstructionBuild> {
  const poolId = assertPoolId(input.poolId);
  const pdas = deriveArenaPdas(input.web3, poolId);
  return {
    pdas,
    instruction: new input.web3.TransactionInstruction({
      programId: new input.web3.PublicKey(pdas.programId),
      keys: [
        { pubkey: new input.web3.PublicKey(input.staker), isSigner: true, isWritable: true },
        { pubkey: new input.web3.PublicKey(pdas.config), isSigner: false, isWritable: false },
        { pubkey: new input.web3.PublicKey(pdas.pool), isSigner: false, isWritable: true },
        { pubkey: new input.web3.PublicKey(pdas.vault), isSigner: false, isWritable: true },
        { pubkey: input.web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: concat(await anchorDiscriminator("deposit_stake_v2"), poolId),
    }),
  };
}

export async function buildArenaSupportV0Instruction(input: {
  web3: SolanaWeb3Module;
  poolId: Uint8Array;
  donor: string;
  amountLamports: number | string | bigint;
}): Promise<ArenaInstructionBuild> {
  const poolId = assertPoolId(input.poolId);
  const pdas = deriveArenaPdas(input.web3, poolId);
  return {
    pdas,
    instruction: new input.web3.TransactionInstruction({
      programId: new input.web3.PublicKey(pdas.programId),
      keys: [
        { pubkey: new input.web3.PublicKey(input.donor), isSigner: true, isWritable: true },
        { pubkey: new input.web3.PublicKey(pdas.config), isSigner: false, isWritable: false },
        { pubkey: new input.web3.PublicKey(pdas.pool), isSigner: false, isWritable: true },
        { pubkey: new input.web3.PublicKey(pdas.vault), isSigner: false, isWritable: true },
        { pubkey: input.web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: concat(await anchorDiscriminator("donate_support_v2"), poolId, u64le(input.amountLamports)),
    }),
  };
}

export async function buildArenaBuyInV0Instruction(input: {
  web3: SolanaWeb3Module;
  poolId: Uint8Array;
  entryAsset: string;
  entrant: string;
}): Promise<ArenaInstructionBuild> {
  const poolId = assertPoolId(input.poolId);
  const pdas = deriveArenaPdas(input.web3, poolId);
  const receipt = deriveArenaBuyInReceipt(input.web3, poolId, input.entryAsset, input.entrant);
  return {
    pdas,
    receipt,
    instruction: new input.web3.TransactionInstruction({
      programId: new input.web3.PublicKey(pdas.programId),
      keys: [
        { pubkey: new input.web3.PublicKey(input.entrant), isSigner: true, isWritable: true },
        { pubkey: new input.web3.PublicKey(pdas.config), isSigner: false, isWritable: false },
        { pubkey: new input.web3.PublicKey(pdas.pool), isSigner: false, isWritable: true },
        { pubkey: new input.web3.PublicKey(pdas.vault), isSigner: false, isWritable: true },
        { pubkey: new input.web3.PublicKey(receipt), isSigner: false, isWritable: true },
        { pubkey: input.web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: concat(
        await anchorDiscriminator("deposit_buy_in_v2"), poolId,
        new input.web3.PublicKey(input.entryAsset).toBytes(),
      ),
    }),
  };
}

export async function buildArenaPrizeBoostV0Instruction(input: {
  web3: SolanaWeb3Module;
  poolId: Uint8Array;
  fundingId: Uint8Array;
  funder: string;
  amountLamports: number | string | bigint;
}): Promise<ArenaInstructionBuild> {
  const poolId = assertPoolId(input.poolId);
  const fundingId = assert32(input.fundingId, "Arena funding id");
  const pdas = deriveArenaPdas(input.web3, poolId);
  const receipt = deriveArenaBoostReceipt(input.web3, poolId, fundingId, input.funder);
  return {
    pdas,
    receipt,
    instruction: new input.web3.TransactionInstruction({
      programId: new input.web3.PublicKey(pdas.programId),
      keys: [
        { pubkey: new input.web3.PublicKey(input.funder), isSigner: true, isWritable: true },
        { pubkey: new input.web3.PublicKey(pdas.config), isSigner: false, isWritable: false },
        { pubkey: new input.web3.PublicKey(pdas.pool), isSigner: false, isWritable: true },
        { pubkey: new input.web3.PublicKey(pdas.vault), isSigner: false, isWritable: true },
        { pubkey: new input.web3.PublicKey(receipt), isSigner: false, isWritable: true },
        { pubkey: input.web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: concat(await anchorDiscriminator("deposit_prize_boost_v2"), poolId, fundingId, u64le(input.amountLamports)),
    }),
  };
}

export async function buildArenaWinnerClaimV0Instruction(input: {
  web3: SolanaWeb3Module;
  poolId: Uint8Array;
  winner: string;
}): Promise<ArenaInstructionBuild> {
  const poolId = assertPoolId(input.poolId);
  const pdas = deriveArenaPdas(input.web3, poolId);
  const receipt = deriveArenaClaimReceipt(input.web3, poolId, ARENA_CLAIM_WINNER);
  return {
    pdas,
    receipt,
    instruction: new input.web3.TransactionInstruction({
      programId: new input.web3.PublicKey(pdas.programId),
      keys: [
        { pubkey: new input.web3.PublicKey(input.winner), isSigner: true, isWritable: true },
        { pubkey: new input.web3.PublicKey(pdas.pool), isSigner: false, isWritable: true },
        { pubkey: new input.web3.PublicKey(pdas.vault), isSigner: false, isWritable: true },
        { pubkey: new input.web3.PublicKey(receipt), isSigner: false, isWritable: true },
        { pubkey: input.web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: concat(await anchorDiscriminator("claim_winner"), poolId),
    }),
  };
}

export async function buildArenaStakeRefundV0Instruction(input: {
  web3: SolanaWeb3Module;
  poolId: Uint8Array;
  staker: string;
}): Promise<ArenaInstructionBuild> {
  const poolId = assertPoolId(input.poolId);
  const pdas = deriveArenaPdas(input.web3, poolId);
  const receipt = deriveArenaRefundReceipt(input.web3, poolId, input.staker, Uint8Array.of(ARENA_KIND_BATTLE));
  return {
    pdas,
    receipt,
    instruction: new input.web3.TransactionInstruction({
      programId: new input.web3.PublicKey(pdas.programId),
      keys: [
        { pubkey: new input.web3.PublicKey(input.staker), isSigner: true, isWritable: true },
        { pubkey: new input.web3.PublicKey(pdas.pool), isSigner: false, isWritable: true },
        { pubkey: new input.web3.PublicKey(pdas.vault), isSigner: false, isWritable: true },
        { pubkey: new input.web3.PublicKey(receipt), isSigner: false, isWritable: true },
        { pubkey: input.web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: concat(await anchorDiscriminator("refund_stake"), poolId),
    }),
  };
}

export async function buildArenaBuyInRefundV0Instruction(input: {
  web3: SolanaWeb3Module;
  poolId: Uint8Array;
  entryAsset: string;
  entrant: string;
}): Promise<ArenaInstructionBuild> {
  const poolId = assertPoolId(input.poolId);
  const pdas = deriveArenaPdas(input.web3, poolId);
  const assetKey = new input.web3.PublicKey(input.entryAsset);
  const buyInReceipt = deriveArenaBuyInReceipt(input.web3, poolId, input.entryAsset, input.entrant);
  const refundReceipt = deriveArenaRefundReceipt(input.web3, poolId, input.entrant, assetKey.toBytes());
  return {
    pdas,
    receipt: refundReceipt,
    instruction: new input.web3.TransactionInstruction({
      programId: new input.web3.PublicKey(pdas.programId),
      keys: [
        { pubkey: new input.web3.PublicKey(input.entrant), isSigner: true, isWritable: true },
        { pubkey: new input.web3.PublicKey(pdas.pool), isSigner: false, isWritable: true },
        { pubkey: new input.web3.PublicKey(pdas.vault), isSigner: false, isWritable: true },
        { pubkey: new input.web3.PublicKey(buyInReceipt), isSigner: false, isWritable: true },
        { pubkey: new input.web3.PublicKey(refundReceipt), isSigner: false, isWritable: true },
        { pubkey: input.web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: concat(await anchorDiscriminator("refund_buy_in_v2"), poolId, assetKey.toBytes()),
    }),
  };
}

export async function buildArenaPrizeBoostRefundV0Instruction(input: {
  web3: SolanaWeb3Module;
  poolId: Uint8Array;
  fundingId: Uint8Array;
  funder: string;
}): Promise<ArenaInstructionBuild> {
  const poolId = assertPoolId(input.poolId);
  const fundingId = assert32(input.fundingId, "Arena funding id");
  const pdas = deriveArenaPdas(input.web3, poolId);
  const boostReceipt = deriveArenaBoostReceipt(input.web3, poolId, fundingId, input.funder);
  const refundReceipt = deriveArenaRefundReceipt(input.web3, poolId, input.funder, fundingId);
  return {
    pdas,
    receipt: refundReceipt,
    instruction: new input.web3.TransactionInstruction({
      programId: new input.web3.PublicKey(pdas.programId),
      keys: [
        { pubkey: new input.web3.PublicKey(input.funder), isSigner: true, isWritable: true },
        { pubkey: new input.web3.PublicKey(pdas.pool), isSigner: false, isWritable: true },
        { pubkey: new input.web3.PublicKey(pdas.vault), isSigner: false, isWritable: true },
        { pubkey: new input.web3.PublicKey(boostReceipt), isSigner: false, isWritable: true },
        { pubkey: new input.web3.PublicKey(refundReceipt), isSigner: false, isWritable: true },
        { pubkey: input.web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: concat(await anchorDiscriminator("refund_prize_boost_v2"), poolId, fundingId),
    }),
  };
}

export async function buildArenaSettleExpiredV0Instruction(input: {
  web3: SolanaWeb3Module;
  poolId: Uint8Array;
}): Promise<ArenaInstructionBuild> {
  const poolId = assertPoolId(input.poolId);
  const pdas = deriveArenaPdas(input.web3, poolId);
  return {
    pdas,
    instruction: new input.web3.TransactionInstruction({
      programId: new input.web3.PublicKey(pdas.programId),
      keys: [{ pubkey: new input.web3.PublicKey(pdas.pool), isSigner: false, isWritable: true }],
      data: concat(await anchorDiscriminator("settle_expired_pool"), poolId),
    }),
  };
}

async function accountExists(web3: SolanaWeb3Module, connection: Connection, address: string): Promise<boolean> {
  return Boolean(await connection.getAccountInfo(new web3.PublicKey(address), "confirmed"));
}

export async function submitArenaUserV0(input: {
  web3: SolanaWeb3Module;
  connection: Connection;
  walletAddress: string;
  instruction: TransactionInstruction;
  label: string;
  recoveryReceipt?: string;
}): Promise<string> {
  const provider = getSolanaProvider();
  if (!provider?.publicKey || typeof provider.signTransaction !== "function") {
    throw new Error(`Connect a Solana wallet that can sign ${input.label}.`);
  }
  const connected = String(provider.publicKey.toString?.() || provider.publicKey || "").trim();
  if (!connected || connected !== String(input.walletAddress || "").trim()) {
    throw new Error(`Connected Solana wallet changed before ${input.label}.`);
  }
  const canonical = canonicalProgramId();
  if (input.instruction.programId.toBase58() !== canonical) {
    throw new Error(`${input.label} instruction targets a non-canonical Arena program.`);
  }
  if (input.recoveryReceipt && await accountExists(input.web3, input.connection, input.recoveryReceipt)) {
    throw new Error(`${input.label} is already recorded on-chain. Refresh before retrying.`);
  }

  const intent = { payer: connected, instructions: [input.instruction] };
  const simulated = await compileSolanaUserV0WithLatestBlockhash(input.web3, input.connection, intent);
  await simulateSolanaUserV0OrThrow(input.connection, simulated.transaction, input.label);
  const final = await compileSolanaUserV0WithLatestBlockhash(input.web3, input.connection, intent);
  const signed = await provider.signTransaction(final.transaction);
  assertSolanaUserV0Intent(input.web3, signed, intent);
  const signature = await input.connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 });
  const confirmation = await confirmLaunchpadSignature(input.connection, {
    signature,
    lastValidBlockHeight: final.latest.lastValidBlockHeight,
    recover: input.recoveryReceipt ? () => accountExists(input.web3, input.connection, input.recoveryReceipt!) : undefined,
  });
  if (confirmation.err) throw new Error(`${input.label} failed: ${JSON.stringify(confirmation.err)}`);
  return signature;
}
