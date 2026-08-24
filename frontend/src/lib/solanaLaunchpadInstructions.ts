/**
 * Exact CREATE / BUY / SELL instruction constructors used by the wallet submitters.
 * Kept free of wallet/RPC imports so CI can load this module and measure production envelopes.
 */
import type { TransactionInstruction } from "@solana/web3.js";
import type { SolanaWeb3Module } from "@/lib/solanaWeb3";

export const SOLANA_ED25519_PROGRAM_ID = "Ed25519SigVerify111111111111111111111111111";
export const SOLANA_INSTRUCTIONS_SYSVAR = "Sysvar1nstructions1111111111111111111111111";
export const SOLANA_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SOLANA_SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

/** Anchor sha256("global:create_campaign")[0..8] */
export const CREATE_CAMPAIGN_DISCRIMINATOR = new Uint8Array([
  0x6f, 0x83, 0xbb, 0x62, 0xa0, 0xc1, 0x72, 0xf4,
]);
/** Anchor sha256("global:buy_tokens")[0..8] */
export const BUY_TOKENS_DISCRIMINATOR = new Uint8Array([0xbd, 0x15, 0xe6, 0x85, 0xf7, 0x02, 0x6e, 0x2a]);
/** Anchor sha256("global:sell_tokens")[0..8] */
export const SELL_TOKENS_DISCRIMINATOR = new Uint8Array([0x72, 0xf2, 0x19, 0x0c, 0x3e, 0x7e, 0x5c, 0x02]);

export type CreateCampaignInstructionArgs = {
  campaignId: number[];
  metadataHash: number[];
  clusterHash: number[];
  tickerHash: number[];
  reservationIdHash: number[];
  reservationVersion: string;
  launchAt: string;
  graduationTargetUsdMicros: string;
  deadline: string;
  nonce: number[];
};

export type CreateCampaignInstructionAccounts = {
  creator: string;
  globalConfig: string;
  generationConfig: string;
  creatorProfile: string;
  riskProfile: string;
  clusterProfile: string;
  campaign: string;
  mint: string;
  tokenVault: string;
  solVault: string;
  createAuthorization: string;
  instructions?: string;
  tokenProgram?: string;
  systemProgram?: string;
};

export type TradeTokensInstructionAccounts = {
  trader: string;
  globalConfig: string;
  campaign: string;
  mint: string;
  tokenVault: string;
  solVault: string;
  traderTokenAccount: string;
  riskProfile: string;
  clusterProfile: string;
  tradeAuthorization: string;
  instructions?: string;
  tokenProgram?: string;
  systemProgram?: string;
  feeEscrow: string;
};

function u64le(value: string | number | bigint): Uint8Array {
  let n = BigInt(value);
  if (n < 0n) throw new Error("u64 cannot be negative");
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function i64le(value: string | number | bigint): Uint8Array {
  let n = BigInt(value);
  const out = new Uint8Array(8);
  if (n < 0n) n = (1n << 64n) + n;
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function encodeCreateCampaignData(args: CreateCampaignInstructionArgs): Uint8Array {
  return concatBytes([
    CREATE_CAMPAIGN_DISCRIMINATOR,
    Uint8Array.from(args.campaignId),
    Uint8Array.from(args.metadataHash),
    Uint8Array.from(args.clusterHash),
    Uint8Array.from(args.tickerHash),
    Uint8Array.from(args.reservationIdHash),
    u64le(args.reservationVersion),
    i64le(args.launchAt),
    u64le(args.graduationTargetUsdMicros),
    i64le(args.deadline),
    Uint8Array.from(args.nonce),
  ]);
}

export function encodeTradeTokensData(input: {
  side: "buy" | "sell";
  amountIn: string;
  minOut: string;
  deadline: string;
  nonce: number[];
  nativeTargetLamports?: string;
  routeProfile: number;
}): Uint8Array {
  const parts = [
    input.side === "buy" ? BUY_TOKENS_DISCRIMINATOR : SELL_TOKENS_DISCRIMINATOR,
    u64le(input.amountIn),
    u64le(input.minOut),
    i64le(input.deadline),
    Uint8Array.from(input.nonce),
  ];
  if (input.side === "buy") {
    parts.push(u64le(input.nativeTargetLamports || "0"));
  }
  parts.push(Uint8Array.from([input.routeProfile & 0xff]));
  return concatBytes(parts);
}

export function buildLaunchpadEd25519Instruction(
  web3: SolanaWeb3Module,
  input: { publicKey: string; message: Uint8Array; signature: Uint8Array },
): TransactionInstruction {
  const { PublicKey, Ed25519Program, TransactionInstruction } = web3;
  const publicKeyBytes = new PublicKey(input.publicKey).toBytes();
  if (typeof Ed25519Program?.createInstructionWithPublicKey === "function") {
    return Ed25519Program.createInstructionWithPublicKey({
      publicKey: publicKeyBytes,
      message: input.message,
      signature: input.signature,
    });
  }

  const numSignatures = 1;
  const padding = 0;
  const signatureOffset = 16;
  const signatureInstructionIndex = 0xffff;
  const publicKeyOffset = signatureOffset + 64;
  const publicKeyInstructionIndex = 0xffff;
  const messageDataOffset = publicKeyOffset + 32;
  const messageDataSize = input.message.length;
  const messageInstructionIndex = 0xffff;

  const header = new Uint8Array(16);
  header[0] = numSignatures;
  header[1] = padding;
  const view = new DataView(header.buffer);
  view.setUint16(2, signatureOffset, true);
  view.setUint16(4, signatureInstructionIndex, true);
  view.setUint16(6, publicKeyOffset, true);
  view.setUint16(8, publicKeyInstructionIndex, true);
  view.setUint16(10, messageDataOffset, true);
  view.setUint16(12, messageDataSize, true);
  view.setUint16(14, messageInstructionIndex, true);

  const data = new Uint8Array(messageDataOffset + input.message.length);
  data.set(header, 0);
  data.set(input.signature, signatureOffset);
  data.set(publicKeyBytes, publicKeyOffset);
  data.set(input.message, messageDataOffset);

  return new TransactionInstruction({
    keys: [],
    programId: new PublicKey(SOLANA_ED25519_PROGRAM_ID),
    data,
  });
}

export function buildCreateCampaignInstruction(
  web3: SolanaWeb3Module,
  input: {
    programId: string;
    args: CreateCampaignInstructionArgs;
    accounts: CreateCampaignInstructionAccounts;
  },
): TransactionInstruction {
  const { PublicKey, TransactionInstruction, SystemProgram } = web3;
  const a = input.accounts;
  const meta = (pubkey: string, isSigner: boolean, isWritable: boolean) => ({
    pubkey: new PublicKey(pubkey),
    isSigner,
    isWritable,
  });
  return new TransactionInstruction({
    programId: new PublicKey(input.programId),
    keys: [
      meta(a.creator, true, true),
      meta(a.globalConfig, false, true),
      meta(a.generationConfig, false, false),
      meta(a.creatorProfile, false, true),
      meta(a.riskProfile, false, false),
      meta(a.clusterProfile, false, false),
      meta(a.campaign, false, true),
      meta(a.mint, false, true),
      meta(a.tokenVault, false, true),
      meta(a.solVault, false, true),
      meta(a.createAuthorization, false, true),
      meta(a.instructions || SOLANA_INSTRUCTIONS_SYSVAR, false, false),
      meta(a.tokenProgram || SOLANA_TOKEN_PROGRAM_ID, false, false),
      meta(a.systemProgram || SOLANA_SYSTEM_PROGRAM_ID || SystemProgram.programId.toBase58(), false, false),
    ],
    data: encodeCreateCampaignData(input.args),
  });
}

export function buildTradeTokensInstruction(
  web3: SolanaWeb3Module,
  input: {
    programId: string;
    side: "buy" | "sell";
    amountIn: string;
    minOut: string;
    deadline: string;
    nonce: number[];
    nativeTargetLamports?: string;
    routeProfile: number;
    accounts: TradeTokensInstructionAccounts;
  },
): TransactionInstruction {
  const { PublicKey, TransactionInstruction } = web3;
  const a = input.accounts;
  return new TransactionInstruction({
    programId: new PublicKey(input.programId),
    keys: [
      { pubkey: new PublicKey(a.trader), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(a.globalConfig), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(a.campaign), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(a.mint), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(a.tokenVault), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(a.solVault), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(a.traderTokenAccount), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(a.riskProfile), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(a.clusterProfile), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(a.tradeAuthorization), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(a.instructions || SOLANA_INSTRUCTIONS_SYSVAR), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(a.tokenProgram || SOLANA_TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(a.systemProgram || SOLANA_SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(a.feeEscrow), isSigner: false, isWritable: true },
    ],
    data: encodeTradeTokensData(input),
  });
}
