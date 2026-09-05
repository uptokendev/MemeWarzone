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

export type SolanaArenaPaymentRecovery<T> = {
  /** Stable per wallet + logical Arena payment lane, not per quote. */
  key: string;
  metadata: Record<string, string>;
  /**
   * Reconcile the exact signature through the authoritative backend receipt path.
   * Return null only when authority proves no receipt/payment exists yet.
   * Throw on transport/authority ambiguity so the pending signature is retained.
   */
  reconcile: (pending: SolanaArenaPendingPayment) => Promise<T | null>;
};

const STORAGE_PREFIX = "mwz:arena-solana-payment:v1:";
const inFlight = new Map<string, Promise<unknown>>();

function decodeBase64(value: string): Uint8Array {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Solana Arena transaction data is missing.");
  const binary = globalThis.atob(raw);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
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

function storageKey(key: string) {
  const normalized = String(key || "").trim();
  if (!normalized) throw new Error("Solana Arena payment recovery key is missing.");
  return `${STORAGE_PREFIX}${normalized}`;
}

function storageOrThrow(): Storage {
  try {
    const storage = globalThis.localStorage;
    if (!storage) throw new Error("localStorage unavailable");
    const probe = `${STORAGE_PREFIX}probe`;
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    throw new Error("Persistent Solana Arena payment recovery is unavailable; payment was not sent.");
  }
}

function readPending(storage: Storage, key: string): SolanaArenaPendingPayment | null {
  const raw = storage.getItem(storageKey(key));
  if (!raw) return null;
  let value: SolanaArenaPendingPayment;
  try {
    value = JSON.parse(raw) as SolanaArenaPendingPayment;
  } catch {
    throw new Error("Stored Solana Arena payment recovery state is invalid; refusing to create a replacement payment.");
  }
  if (
    !value?.signature ||
    !value?.blockhash ||
    !Number.isFinite(Number(value.lastValidBlockHeight)) ||
    !value.chainId ||
    !value.wallet ||
    !value.programId ||
    !value.metadata
  ) {
    throw new Error("Stored Solana Arena payment recovery state is incomplete; refusing to create a replacement payment.");
  }
  return value;
}

function writePending(storage: Storage, key: string, pending: SolanaArenaPendingPayment) {
  storage.setItem(storageKey(key), JSON.stringify(pending));
}

function clearPending(storage: Storage, key: string, signature: string) {
  const pending = readPending(storage, key);
  if (pending?.signature === signature) storage.removeItem(storageKey(key));
}

async function withRecoveryLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const normalized = storageKey(key);
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

async function confirmAndReconcile<T>(input: {
  connection: any;
  storage: Storage;
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

  if (confirmation.err) {
    clearPending(input.storage, input.recovery.key, input.pending.signature);
    throw new Error(`Solana Arena payment failed: ${JSON.stringify(confirmation.err)}`);
  }

  const settlement = recoverySettlement ?? await input.recovery.reconcile(input.pending);
  if (settlement === null) {
    throw new Error(
      `Solana Arena payment ${input.pending.signature} landed but its authoritative receipt is not available yet. Do not retry the payment.`,
    );
  }
  clearPending(input.storage, input.recovery.key, input.pending.signature);
  return {
    signature: input.pending.signature,
    settlement,
    recovered: input.recovered || confirmation.recovered === true,
  };
}

/**
 * Browser executor for Agent 3's frozen Arena Money V2 instruction envelope.
 * The backend owns instruction/account/receipt authority. The browser binds the
 * envelope to the configured rewards-treasury program, constructs exactly the
 * returned data/metas, and preserves one exact signature until RPC + backend
 * receipt authority prove success or prove expiry/failure.
 */
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
    const storage = storageOrThrow();
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

    const existing = readPending(storage, input.recovery.key);
    if (existing) {
      if (
        Number(existing.chainId) !== Number(input.chainId) ||
        existing.wallet !== connected ||
        existing.programId !== expectedProgramId
      ) {
        throw new Error("An unresolved Solana Arena payment exists for this lane with different authority; refusing a replacement payment.");
      }
      try {
        return await confirmAndReconcile({
          connection,
          storage,
          recovery: input.recovery,
          pending: existing,
          recovered: true,
        });
      } catch (error) {
        if (!(error instanceof LaunchpadSignatureExpiredError)) throw error;
        // The shared helper emits this only after block-height expiry,
        // transaction lookup miss, and an authoritative recover() miss.
        clearPending(storage, input.recovery.key, existing.signature);
      }
    }

    const instruction = new web3.TransactionInstruction({
      programId: new web3.PublicKey(envelope.programId),
      keys: envelope.accounts.map((account) => ({
        pubkey: new web3.PublicKey(account.pubkey),
        isSigner: account.isSigner === true,
        isWritable: account.isWritable === true,
      })),
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
    const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
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

    // Persist immediately after sendRawTransaction and before confirmation.
    // Storage is probed before signing; any unexpected persistence failure now
    // fails closed rather than constructing a replacement in this invocation.
    writePending(storage, input.recovery.key, pending);
    return confirmAndReconcile({
      connection,
      storage,
      recovery: input.recovery,
      pending,
      recovered: false,
    });
  });
}
