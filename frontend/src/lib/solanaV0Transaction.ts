import type {
  AddressLookupTableAccount,
  Connection,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import type { SolanaWeb3Module } from "@/lib/solanaWeb3";

export const SOLANA_PACKET_LIMIT_BYTES = 1_232;
export const SOLANA_RELEASE_MAX_BYTES = 1_000;
export const SOLANA_LAUNCHPAD_PROGRAM_ID = "3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt";
export const SOLANA_REWARDS_TREASURY_PROGRAM_ID = "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX";
export const SOLANA_INSTRUCTIONS_SYSVAR = "Sysvar1nstructions1111111111111111111111111";
export const SOLANA_ED25519_PROGRAM_ID = "Ed25519SigVerify111111111111111111111111111";
export const SOLANA_COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
export const SOLANA_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SOLANA_SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

const REWARD_VAULT_SEEDS = [
  ["weeklyLeagueVault", "league_vault"],
  ["airdropVault", "airdrop_vault"],
  ["monthlyLeagueVault", "monthly_league_vault"],
  ["recruiterVault", "recruiter_vault"],
  ["squadVault", "squad_vault"],
  ["protocolVault", "protocol_vault"],
] as const;

export type LaunchpadV0BuildInput = {
  payer: string | PublicKey;
  recentBlockhash: string;
  instructions: TransactionInstruction[];
  lookupTableAccounts?: AddressLookupTableAccount[];
};

export type LaunchpadV0EnvelopeStats = {
  serializedBytes: number;
  requiredSigners: number;
  instructionCount: number;
  lookupTableCount: number;
  lookupWritableCount: number;
  lookupReadonlyCount: number;
};

export type LaunchpadAltPlanEntry = {
  label: string;
  address: PublicKey;
};

export type LaunchpadV0IntentExpectation = {
  payer: string | PublicKey;
  ed25519Instruction: TransactionInstruction;
  programInstruction: TransactionInstruction;
  lookupTableAccounts?: AddressLookupTableAccount[];
  hardMaxBytes?: number;
  releaseMaxBytes?: number | null;
  maxRequiredSigners?: number;
  allowAdditionalProgramInstructions?: boolean;
  allowInstructionPrivilegePromotion?: boolean;
};

export function configuredLaunchpadAltAddress(): string {
  const viteValue = typeof import.meta !== "undefined"
    ? String((import.meta as { env?: Record<string, string> }).env?.VITE_SOLANA_LAUNCHPAD_ALT_ADDRESS || "").trim()
    : "";
  const processValue = typeof process !== "undefined"
    ? String(process.env?.SOLANA_LAUNCHPAD_ALT_ADDRESS || process.env?.VITE_SOLANA_LAUNCHPAD_ALT_ADDRESS || "").trim()
    : "";
  return viteValue || processValue;
}

export function requireLaunchpadAltAddress(): string {
  const address = configuredLaunchpadAltAddress();
  if (!address) {
    throw new Error(
      "Solana launchpad ALT is not configured. Set VITE_SOLANA_LAUNCHPAD_ALT_ADDRESS in the frontend Coolify build env (Vite bakes it at build time). Operator/CI scripts can use SOLANA_LAUNCHPAD_ALT_ADDRESS. This table is distinct from SOLANA_GRADUATION_ALT_ADDRESS.",
    );
  }
  return address;
}

export function buildLaunchpadAltPlan(web3: SolanaWeb3Module): LaunchpadAltPlanEntry[] {
  const { PublicKey: Web3PublicKey } = web3;
  const programId = new Web3PublicKey(SOLANA_LAUNCHPAD_PROGRAM_ID);
  const rewardsProgramId = new Web3PublicKey(SOLANA_REWARDS_TREASURY_PROGRAM_ID);
  const [globalConfig] = Web3PublicKey.findProgramAddressSync([Buffer.from("global")], programId);
  const rewardVaults = REWARD_VAULT_SEEDS.map(([label, seed]) => {
    const [address] = Web3PublicKey.findProgramAddressSync([Buffer.from(seed)], rewardsProgramId);
    return { label, address };
  });
  const entries: LaunchpadAltPlanEntry[] = [
    { label: "memewarzoneProgram", address: programId },
    { label: "globalConfig", address: globalConfig },
    { label: "ed25519Program", address: new Web3PublicKey(SOLANA_ED25519_PROGRAM_ID) },
    { label: "computeBudgetProgram", address: new Web3PublicKey(SOLANA_COMPUTE_BUDGET_PROGRAM_ID) },
    { label: "instructionsSysvar", address: new Web3PublicKey(SOLANA_INSTRUCTIONS_SYSVAR) },
    { label: "tokenProgram", address: new Web3PublicKey(SOLANA_TOKEN_PROGRAM_ID) },
    { label: "associatedTokenProgram", address: new Web3PublicKey(SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID) },
    { label: "systemProgram", address: new Web3PublicKey(SOLANA_SYSTEM_PROGRAM_ID) },
    { label: "rewardsTreasuryProgram", address: rewardsProgramId },
    ...rewardVaults,
  ];
  const extraRaw = typeof process !== "undefined"
    ? String(process.env?.SOLANA_LAUNCHPAD_ALT_EXTRA_ADDRESSES || "").trim()
    : "";
  if (extraRaw) {
    for (const [index, raw] of extraRaw.split(",").map((value) => value.trim()).filter(Boolean).entries()) {
      entries.push({ label: `extra${index + 1}`, address: new Web3PublicKey(raw) });
    }
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = entry.address.toBase58();
    if (seen.has(key)) throw new Error(`duplicate ALT plan address: ${entry.label} ${key}`);
    seen.add(key);
  }
  return entries;
}

function keyString(value: string | { toBase58?: () => string; toString?: () => string }): string {
  if (typeof value === "string") return value;
  if (typeof value?.toBase58 === "function") return value.toBase58();
  return String(value?.toString?.() || "");
}

function dataEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function instructionEqual(
  actual: TransactionInstruction,
  expected: TransactionInstruction,
  allowPrivilegePromotion = false,
): boolean {
  if (keyString(actual.programId) !== keyString(expected.programId)) return false;
  if (!dataEqual(actual.data, expected.data)) return false;
  if (actual.keys.length !== expected.keys.length) return false;
  for (let i = 0; i < actual.keys.length; i += 1) {
    const left = actual.keys[i];
    const right = expected.keys[i];
    if (keyString(left.pubkey) !== keyString(right.pubkey)) return false;
    if (allowPrivilegePromotion) {
      // V0 compilation merges account privileges across the whole transaction.
      // A key that is read-only/non-signer in this instruction can therefore
      // decompile as writable/signer when another instruction legitimately
      // needs stronger access. Never allow a required privilege to disappear.
      if (right.isSigner && !left.isSigner) return false;
      if (right.isWritable && !left.isWritable) return false;
    } else if (left.isSigner !== right.isSigner || left.isWritable !== right.isWritable) {
      return false;
    }
  }
  return true;
}

export function buildLaunchpadV0Transaction(
  web3: SolanaWeb3Module,
  input: LaunchpadV0BuildInput,
): VersionedTransaction {
  const { PublicKey: Web3PublicKey, TransactionMessage, VersionedTransaction: Web3VersionedTransaction } = web3;
  const payerKey = typeof input.payer === "string" ? new Web3PublicKey(input.payer) : input.payer;
  const message = new TransactionMessage({
    payerKey,
    recentBlockhash: input.recentBlockhash,
    instructions: input.instructions,
  }).compileToV0Message(input.lookupTableAccounts || []);
  return new Web3VersionedTransaction(message);
}

export function inspectLaunchpadV0Envelope(
  web3: SolanaWeb3Module,
  transaction: VersionedTransaction,
  lookupTableAccounts: AddressLookupTableAccount[] = [],
): LaunchpadV0EnvelopeStats {
  const decompiled = web3.TransactionMessage.decompile(transaction.message, {
    addressLookupTableAccounts: lookupTableAccounts,
  });
  let lookupWritableCount = 0;
  let lookupReadonlyCount = 0;
  for (const lookup of transaction.message.addressTableLookups) {
    lookupWritableCount += lookup.writableIndexes.length;
    lookupReadonlyCount += lookup.readonlyIndexes.length;
  }
  return {
    serializedBytes: transaction.serialize().length,
    requiredSigners: transaction.message.header.numRequiredSignatures,
    instructionCount: decompiled.instructions.length,
    lookupTableCount: transaction.message.addressTableLookups.length,
    lookupWritableCount,
    lookupReadonlyCount,
  };
}

export function assertLookupTableContains(
  lookupTable: AddressLookupTableAccount,
  requiredAddresses: Array<string | PublicKey>,
): void {
  const present = new Set(lookupTable.state.addresses.map((address) => address.toBase58()));
  const missing = requiredAddresses
    .map((address) => keyString(address))
    .filter((address) => !present.has(address));
  if (missing.length) {
    throw new Error(`Solana launchpad ALT is missing required addresses: ${missing.join(", ")}`);
  }
}

export async function fetchAndVerifyLaunchpadLookupTable(
  web3: SolanaWeb3Module,
  connection: Connection,
  input: {
    address: string;
    requiredAddresses?: Array<string | PublicKey>;
    expectedAuthority?: string | PublicKey;
  },
): Promise<AddressLookupTableAccount> {
  const address = new web3.PublicKey(input.address);
  const result = await connection.getAddressLookupTable(address);
  const table = result.value;
  if (!table) throw new Error(`Solana launchpad ALT not found: ${input.address}`);
  if (typeof table.isActive === "function" && !table.isActive()) {
    throw new Error(`Solana launchpad ALT is deactivated: ${input.address}`);
  }
  if (input.expectedAuthority) {
    const actualAuthority = table.state.authority?.toBase58?.() || "";
    if (actualAuthority !== keyString(input.expectedAuthority)) {
      throw new Error(
        `Solana launchpad ALT authority mismatch: ${actualAuthority || "none"} != ${keyString(input.expectedAuthority)}`,
      );
    }
  }
  if (input.requiredAddresses?.length) {
    assertLookupTableContains(table, input.requiredAddresses);
  }
  return table;
}

export function assertLaunchpadV0Intent(
  web3: SolanaWeb3Module,
  transaction: VersionedTransaction,
  expectation: LaunchpadV0IntentExpectation,
): LaunchpadV0EnvelopeStats {
  const lookupTableAccounts = expectation.lookupTableAccounts || [];
  const stats = inspectLaunchpadV0Envelope(web3, transaction, lookupTableAccounts);
  const hardMaxBytes = expectation.hardMaxBytes ?? SOLANA_PACKET_LIMIT_BYTES;
  const releaseMaxBytes = expectation.releaseMaxBytes === undefined
    ? SOLANA_RELEASE_MAX_BYTES
    : expectation.releaseMaxBytes;

  const maxRequiredSigners = expectation.maxRequiredSigners ?? 1;
  if (stats.requiredSigners < 1 || stats.requiredSigners > maxRequiredSigners) {
    throw new Error(
      maxRequiredSigners === 1
        ? `Solana launchpad V0 requires exactly one signer; got ${stats.requiredSigners}`
        : `Solana V0 transaction has ${stats.requiredSigners} signers; maximum allowed is ${maxRequiredSigners}`,
    );
  }
  if (stats.serializedBytes > hardMaxBytes) {
    throw new Error(`Solana launchpad V0 transaction is ${stats.serializedBytes} bytes; hard max is ${hardMaxBytes}`);
  }
  if (releaseMaxBytes != null && stats.serializedBytes > releaseMaxBytes) {
    throw new Error(
      `Solana launchpad V0 transaction is ${stats.serializedBytes} bytes; release max is ${releaseMaxBytes}`,
    );
  }

  const payer = transaction.message.staticAccountKeys[0];
  if (!payer || payer.toBase58() !== keyString(expectation.payer)) {
    throw new Error("Solana launchpad V0 fee payer changed before signing/submission");
  }

  const decompiled = web3.TransactionMessage.decompile(transaction.message, {
    addressLookupTableAccounts: lookupTableAccounts,
  });
  const targetProgramId = keyString(expectation.programInstruction.programId);
  const programIndices = decompiled.instructions
    .map((instruction, index) => keyString(instruction.programId) === targetProgramId ? index : -1)
    .filter((index) => index >= 0);

  if (programIndices.length < 1) {
    throw new Error("Expected a MemeWarzone instruction; found none");
  }
  if (!expectation.allowAdditionalProgramInstructions && programIndices.length !== 1) {
    throw new Error(`Expected exactly one MemeWarzone instruction; found ${programIndices.length}`);
  }
  const programIndex = decompiled.instructions.findIndex((instruction) => (
    instructionEqual(
      instruction,
      expectation.programInstruction,
      expectation.allowInstructionPrivilegePromotion === true,
    )
  ));
  if (programIndex < 0) {
    throw new Error("MemeWarzone instruction intent changed before signing/submission");
  }
  if (programIndex === 0) {
    throw new Error("Detached Ed25519 authorization is missing before MemeWarzone instruction");
  }
  const previousInstruction = decompiled.instructions[programIndex - 1];
  if (!instructionEqual(previousInstruction, expectation.ed25519Instruction)) {
    throw new Error("Detached Ed25519 authorization must remain immediately before MemeWarzone instruction");
  }
  return stats;
}

export function compileAndAssertLaunchpadV0(
  web3: SolanaWeb3Module,
  input: LaunchpadV0BuildInput,
  expectation: Omit<LaunchpadV0IntentExpectation, "lookupTableAccounts"> & {
    lookupTableAccounts?: AddressLookupTableAccount[];
  },
) {
  const lookupTableAccounts = input.lookupTableAccounts || expectation.lookupTableAccounts || [];
  const transaction = buildLaunchpadV0Transaction(web3, { ...input, lookupTableAccounts });
  const stats = assertLaunchpadV0Intent(web3, transaction, {
    ...expectation,
    lookupTableAccounts,
  });
  return { transaction, stats };
}

export type LaunchpadBlockhashSource = {
  getLatestBlockhash: (
    commitment?: "processed" | "confirmed" | "finalized",
  ) => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
};

/**
 * Fetch a current blockhash and compile the same instructions + ALT into a V0
 * transaction. Call this immediately before wallet signing so Phantom never
 * signs a hash that aged during simulation or UI delay.
 */
export async function compileLaunchpadV0WithLatestBlockhash(
  web3: SolanaWeb3Module,
  connection: LaunchpadBlockhashSource,
  input: Omit<LaunchpadV0BuildInput, "recentBlockhash">,
  expectation: Omit<LaunchpadV0IntentExpectation, "lookupTableAccounts"> & {
    lookupTableAccounts?: AddressLookupTableAccount[];
  },
) {
  const latest = await connection.getLatestBlockhash("confirmed");
  const compiled = compileAndAssertLaunchpadV0(
    web3,
    { ...input, recentBlockhash: latest.blockhash },
    expectation,
  );
  return { ...compiled, latest };
}

export async function simulateLaunchpadV0Transaction(
  connection: Connection,
  transaction: VersionedTransaction,
  options: { sigVerify?: boolean; commitment?: "processed" | "confirmed" | "finalized" } = {},
) {
  return connection.simulateTransaction(transaction, {
    commitment: options.commitment || "confirmed",
    sigVerify: options.sigVerify ?? false,
    replaceRecentBlockhash: false,
  });
}

export async function simulateLaunchpadV0OrThrow(
  connection: Connection,
  transaction: VersionedTransaction,
  label: string,
) {
  const simulation = await simulateLaunchpadV0Transaction(connection, transaction);
  const logs = Array.isArray(simulation.value?.logs) ? simulation.value.logs.map(String) : [];
  const source = `${simulation.value?.err == null ? "" : JSON.stringify(simulation.value.err)}\n${logs.join("\n")}`;
  if (/Access violation|stack frame|Program failed to complete/i.test(source)) {
    throw Object.assign(
      new Error(`${label} hit a BPF execution/stack failure before wallet signing.`),
      { logs, simulationErr: simulation.value?.err },
    );
  }
  if (simulation.value?.err) {
    const errText = JSON.stringify(simulation.value.err);
    const usefulLogs = logs.filter((line) => /Error|failed|Program log|custom program/i.test(line)).slice(-8);
    throw Object.assign(
      new Error(
        `${label} RPC simulation failed. ${errText}${usefulLogs.length ? ` ${usefulLogs.join(" | ")}` : ""}`,
      ),
      { logs, simulationErr: simulation.value.err, source },
    );
  }
  return { simulation, logs, unitsConsumed: simulation.value?.unitsConsumed ?? null };
}
