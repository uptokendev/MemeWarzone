import { getPublicRpcUrl, type SupportedChainId } from "@/lib/chainConfig";
import {
  confirmLaunchpadSignature,
  LaunchpadSignatureExpiredError,
} from "@/lib/solanaConfirmSignature";
import { ARENA_MONEY_V2_PROGRAM_ID } from "@/lib/solanaArenaMoneyV2Layout.mjs";
import { rewardsTreasuryProgramId } from "@/lib/solanaRewardsTreasury";
import { getSolanaProvider } from "@/lib/solanaWallet";
import { loadSolanaWeb3 } from "@/lib/solanaWeb3";
import {
  assertSolanaUserV0Intent,
  compileSolanaUserV0WithLatestBlockhash,
  simulateSolanaUserV0OrThrow,
} from "@/lib/solanaUserV0Transaction";
import {
  registerArenaPaymentBeforeBroadcast,
  resolveArenaPaymentBeforeSigning,
} from "./solanaArenaPaymentRecoveryCoordinator.mjs";

export type SolanaArenaInstructionAccount = {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
};

export type SolanaArenaInstructionEnvelope = {
  programId: string;
  instruction?: string | null;
  dataBase64: string;
  accounts: SolanaArenaInstructionAccount[];
  configPda?: string | null;
  poolPda?: string | null;
  receiptPda?: string | null;
  eventPda?: string | null;
  vaultPda?: string | null;
};

export type SolanaArenaPendingPayment = {
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  chainId: number;
  wallet: string;
  programId: string;
  metadata: Record<string, string>;
  createdAt: string;
};

export type SolanaArenaPaymentResult<T> = {
  signature: string;
  settlement: T;
  recovered: boolean;
};

export type SolanaArenaServerRecoveryState = {
  pending: SolanaArenaPendingPayment | null;
  newPaymentAllowed: boolean;
};

export type SolanaArenaPaymentRecovery<T> = {
  key: string;
  metadata: Record<string, string>;
  lookup: () => Promise<SolanaArenaServerRecoveryState>;
  register: (pending: SolanaArenaPendingPayment) => Promise<void>;
  reconcile: (pending: SolanaArenaPendingPayment) => Promise<T | null>;
  expire: (pending: SolanaArenaPendingPayment) => Promise<void>;
};

const inFlight = new Map<string, Promise<unknown>>();
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function decodeBase64(value: string): Uint8Array {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Solana Arena transaction data is missing.");
  const binary = globalThis.atob(raw);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase58(bytes: Uint8Array): string {
  if (!bytes.length) return "";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      carry += digits[index] << 8;
      digits[index] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let output = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    output += BASE58_ALPHABET[0];
  }
  for (let index = digits.length - 1; index >= 0; index -= 1) output += BASE58_ALPHABET[digits[index]];
  return output;
}

function canonicalProgramId(): string {
  const arenaMoney = String(ARENA_MONEY_V2_PROGRAM_ID || "").trim();
  const configuredTreasury = String(rewardsTreasuryProgramId() || "").trim();
  if (!arenaMoney || !configuredTreasury || arenaMoney !== configuredTreasury) {
    throw new Error("Configured Solana rewards-treasury program does not match canonical Arena Money V2.");
  }
  return arenaMoney;
}

function assertEnvelope(value: SolanaArenaInstructionEnvelope) {
  if (!value?.programId || !value?.dataBase64 || !Array.isArray(value.accounts) || !value.accounts.length) {
    throw new Error("Solana Arena transaction envelope is incomplete.");
  }
  const expectedProgramId = canonicalProgramId();
  const receivedProgramId = String(value.programId || "").trim();
  if (receivedProgramId !== expectedProgramId) {
    throw new Error("Solana Arena transaction program does not match the configured Arena Money V2 program.");
  }
  return value;
}

function recoveryKey(key: string) {
  const normalized = String(key || "").trim();
  if (!normalized) throw new Error("Solana Arena payment recovery key is missing.");
  return normalized;
}

async function withRecoveryLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const normalized = recoveryKey(key);
  const previous = inFlight.get(normalized) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => gate);
  inFlight.set(normalized, queued);
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (inFlight.get(normalized) === queued) inFlight.delete(normalized);
  }
}

function assertPendingAuthority(pending: SolanaArenaPendingPayment, input: { chainId: number; wallet: string; programId: string }) {
  if (
    !pending?.signature ||
    !pending.blockhash ||
    !Number.isFinite(Number(pending.lastValidBlockHeight)) ||
    Number(pending.chainId) !== Number(input.chainId) ||
    String(pending.wallet) !== String(input.wallet) ||
    String(pending.programId) !== String(input.programId)
  ) {
    throw new Error("Durable Solana Arena recovery state does not match this payment authority.");
  }
}

async function confirmAndReconcile<T>(input: {
  connection: any;
  recovery: SolanaArenaPaymentRecovery<T>;
  pending: SolanaArenaPendingPayment;
  recovered: boolean;
}): Promise<SolanaArenaPaymentResult<T>> {
  let recoverySettlement: T | null = null;
  const confirmation = await confirmLaunchpadSignature(input.connection, {
    signature: input.pending.signature,
    lastValidBlockHeight: input.pending.lastValidBlockHeight,
    recover: async () => {
      recoverySettlement = await input.recovery.reconcile(input.pending);
      return recoverySettlement !== null;
    },
  });
  if (confirmation.err) throw new Error(`Solana Arena payment failed: ${JSON.stringify(confirmation.err)}`);
  const settlement = recoverySettlement ?? await input.recovery.reconcile(input.pending);
  if (settlement === null) {
    throw new Error(`Solana Arena payment ${input.pending.signature} landed but its authoritative receipt is not available yet. Do not retry the payment.`);
  }
  return { signature: input.pending.signature, settlement, recovered: input.recovered || confirmation.recovered === true };
}

export async function recoverSolanaArenaPayment<T>(input: {
  chainId: number;
  wallet: string;
  label: string;
  recovery: SolanaArenaPaymentRecovery<T>;
}): Promise<SolanaArenaPaymentResult<T> | null> {
  const expectedProgramId = canonicalProgramId();
  return withRecoveryLock(input.recovery.key, async () => {
    const web3 = await loadSolanaWeb3();
    const connection = new web3.Connection(getPublicRpcUrl(input.chainId as SupportedChainId), "confirmed");
    const state = await input.recovery.lookup();
    if (!state.pending) return null;
    assertPendingAuthority(state.pending, { chainId: input.chainId, wallet: input.wallet, programId: expectedProgramId });
    try {
      return await confirmAndReconcile({ connection, recovery: input.recovery, pending: state.pending, recovered: true });
    } catch (error) {
      if (error instanceof LaunchpadSignatureExpiredError) {
        await input.recovery.expire(state.pending);
        return null;
      }
      throw error;
    }
  });
}

export async function sendSolanaArenaInstruction<T>(input: {
  chainId: number;
  wallet: string;
  transaction: SolanaArenaInstructionEnvelope;
  label: string;
  recovery: SolanaArenaPaymentRecovery<T>;
}): Promise<SolanaArenaPaymentResult<T>> {
  const envelope = assertEnvelope(input.transaction);
  const expectedProgramId = canonicalProgramId();

  return withRecoveryLock(input.recovery.key, async () => {
    const provider = getSolanaProvider();
    if (!provider?.publicKey || typeof provider.signTransaction !== "function") {
      throw new Error(`Connect a Solana wallet that can sign this ${input.label}.`);
    }
    const connected = String(provider.publicKey.toString?.() || provider.publicKey).trim();
    if (!connected || connected !== String(input.wallet || "").trim()) {
      throw new Error("Connected Solana wallet does not match the Arena quote wallet.");
    }

    const web3 = await loadSolanaWeb3();
    const connection = new web3.Connection(getPublicRpcUrl(input.chainId as SupportedChainId), "confirmed");
    const beforeSigning = await resolveArenaPaymentBeforeSigning({
      lookup: input.recovery.lookup,
      recoverPending: async (pending: SolanaArenaPendingPayment) => {
        assertPendingAuthority(pending, { chainId: input.chainId, wallet: connected, programId: expectedProgramId });
        return confirmAndReconcile({ connection, recovery: input.recovery, pending, recovered: true });
      },
      expirePending: input.recovery.expire,
      isExpiredError: (error: unknown) => error instanceof LaunchpadSignatureExpiredError,
    });
    if (beforeSigning.kind === "recovered") return beforeSigning.result;

    const instruction = new web3.TransactionInstruction({
      programId: new web3.PublicKey(envelope.programId),
      keys: envelope.accounts.map((account) => ({ pubkey: new web3.PublicKey(account.pubkey), isSigner: account.isSigner === true, isWritable: account.isWritable === true })),
      data: decodeBase64(envelope.dataBase64),
    });
    const intent = { payer: connected, instructions: [instruction] };
    const simulated = await compileSolanaUserV0WithLatestBlockhash(web3, connection, intent);
    assertSolanaUserV0Intent(web3, simulated.transaction, intent);
    await simulateSolanaUserV0OrThrow(connection, simulated.transaction, input.label);
    const final = await compileSolanaUserV0WithLatestBlockhash(web3, connection, intent);
    assertSolanaUserV0Intent(web3, final.transaction, intent);
    const signed = await provider.signTransaction(final.transaction);
    assertSolanaUserV0Intent(web3, signed, intent);
    const signatureBytes = signed?.signatures?.[0];
    if (!(signatureBytes instanceof Uint8Array) || signatureBytes.length !== 64) throw new Error("Wallet returned a Solana transaction without a valid payer signature.");
    const signature = encodeBase58(signatureBytes);
    const pending: SolanaArenaPendingPayment = {
      signature,
      blockhash: final.latest.blockhash,
      lastValidBlockHeight: final.latest.lastValidBlockHeight,
      chainId: Number(input.chainId),
      wallet: connected,
      programId: expectedProgramId,
      metadata: { ...input.recovery.metadata },
      createdAt: new Date().toISOString(),
    };
    await registerArenaPaymentBeforeBroadcast({
      pending,
      register: input.recovery.register,
      broadcast: () => connection.sendRawTransaction(signed.serialize(), { skipPreflight: false }),
    });
    return confirmAndReconcile({ connection, recovery: input.recovery, pending, recovered: false });
  });
}
