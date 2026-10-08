import type { Connection, TransactionInstruction } from "@solana/web3.js";
import { confirmLaunchpadSignature } from "@/lib/solanaConfirmSignature";
import { getSolanaRewardRpcUrl, isSolanaRewardChainId } from "@/lib/solanaRewardNetwork";
import {
  assertSolanaUserV0Intent,
  compileSolanaUserV0WithLatestBlockhash,
  simulateSolanaUserV0OrThrow,
  SOLANA_WALLET_REWRITE_BUDGET_BYTES,
} from "@/lib/solanaUserV0Transaction";
import { getSolanaProvider } from "@/lib/solanaWallet";
import type { SolanaWeb3Module } from "@/lib/solanaWeb3";

export const SOLANA_REWARDS_TREASURY_PROGRAM_ID = "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX";

const utf8 = (value: string) => new TextEncoder().encode(value);

export type RewardClaimAddresses = {
  programId: string;
  configAddress: string;
  vaultAddress: string;
  batchAddress: string;
  claimReceiptAddress: string;
  recipient: string;
};

export type RewardClaimCanonicalInput =
  | {
      kind: "league";
      periodCode: number;
      epochStartSec: number | string | bigint;
      categoryHash: Uint8Array;
      rank: number;
    }
  | {
      kind: "airdrop";
      epochId: number | string | bigint;
      programCode: number;
    }
  | {
      kind: "recruiter" | "squad";
      epochId: number | string | bigint;
    };

function i64le(value: number | string | bigint): Uint8Array {
  let n = BigInt(value);
  const min = -(1n << 63n);
  const max = (1n << 63n) - 1n;
  if (n < min || n > max) throw new Error("i64 overflow");
  if (n < 0n) n = (1n << 64n) + n;
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function derive(web3: SolanaWeb3Module, seedParts: Uint8Array[]): string {
  const [address] = web3.PublicKey.findProgramAddressSync(
    seedParts,
    new web3.PublicKey(SOLANA_REWARDS_TREASURY_PROGRAM_ID),
  );
  return address.toBase58();
}

export function solanaLeagueVaultSeed(period: number): string {
  if (period === 0) return "league_vault";
  if (period === 1) return "monthly_league_vault";
  return "mwl_vault";
}

function assertAddress(label: string, actual: string, expected: string): void {
  if (String(actual || "").trim() !== expected) {
    throw new Error(`Solana reward ${label} mismatch: ${String(actual || "").trim()} != ${expected}`);
  }
}

export function assertCanonicalSolanaRewardClaim(
  web3: SolanaWeb3Module,
  addresses: RewardClaimAddresses,
  canonical: RewardClaimCanonicalInput,
): void {
  assertAddress("program", addresses.programId, SOLANA_REWARDS_TREASURY_PROGRAM_ID);
  const recipient = new web3.PublicKey(addresses.recipient);
  assertAddress("config PDA", addresses.configAddress, derive(web3, [utf8("rewards_config")]));

  if (canonical.kind === "league") {
    const period = Number(canonical.periodCode);
    const rank = Number(canonical.rank);
    if (![0, 1, 2, 3].includes(period)) throw new Error("Invalid Solana league period code");
    if (rank < 1 || rank > 255) throw new Error("Invalid Solana league rank"); // u8 claim rank, poker payout
    if (canonical.categoryHash.length !== 32) throw new Error("Invalid Solana league category hash");
    const epoch = i64le(canonical.epochStartSec);
    // The program's league_payout_vault: weekly -> league_vault, monthly -> monthly_league_vault,
    // Major War League (quarterly 2 / monthly 3) -> mwl_vault. Checking only league_vault refused
    // every monthly claim before the wallet was asked to sign (2026-09-28).
    assertAddress("league vault PDA", addresses.vaultAddress, derive(web3, [utf8(solanaLeagueVaultSeed(period))]));
    assertAddress("league epoch PDA", addresses.batchAddress, derive(web3, [utf8("league_epoch"), Uint8Array.from([period]), epoch]));
    assertAddress(
      "league claim receipt PDA",
      addresses.claimReceiptAddress,
      derive(web3, [utf8("league_claim"), Uint8Array.from([period]), epoch, canonical.categoryHash, Uint8Array.from([rank])]),
    );
    return;
  }

  const epoch = i64le(canonical.epochId);
  if (canonical.kind === "airdrop") {
    const programCode = Number(canonical.programCode);
    if (!Number.isInteger(programCode) || programCode < 0 || programCode > 255) {
      throw new Error("Invalid Solana airdrop program code");
    }
    assertAddress("airdrop vault PDA", addresses.vaultAddress, derive(web3, [utf8("airdrop_vault")]));
    assertAddress("airdrop batch PDA", addresses.batchAddress, derive(web3, [utf8("airdrop_batch"), epoch]));
    assertAddress(
      "airdrop claim receipt PDA",
      addresses.claimReceiptAddress,
      derive(web3, [utf8("airdrop_claim"), epoch, Uint8Array.from([programCode]), recipient.toBytes()]),
    );
    return;
  }

  const lane = canonical.kind;
  assertAddress(`${lane} vault PDA`, addresses.vaultAddress, derive(web3, [utf8(`${lane}_vault`)]));
  assertAddress(`${lane} batch PDA`, addresses.batchAddress, derive(web3, [utf8(`${lane}_batch`), epoch]));
  assertAddress(
    `${lane} claim receipt PDA`,
    addresses.claimReceiptAddress,
    derive(web3, [utf8(`${lane}_claim`), epoch, recipient.toBytes()]),
  );
}

async function claimReceiptExists(
  web3: SolanaWeb3Module,
  connection: Connection,
  address: string,
): Promise<boolean> {
  const account = await connection.getAccountInfo(new web3.PublicKey(address), "confirmed");
  return Boolean(account);
}

/**
 * The confirmed transaction that created a claim receipt, oldest first. A receipt is written only by
 * its claim, so this is the payout. Used when a claim paid out but was never recorded (for example
 * because recording failed after the wallet had sent it): the caller records this signature and the
 * server verifies it like any other.
 */
async function claimSignatureForReceipt(
  web3: SolanaWeb3Module,
  connection: Connection,
  address: string,
): Promise<string | null> {
  const signatures = await connection.getSignaturesForAddress(new web3.PublicKey(address), { limit: 20 }, "confirmed");
  const ok = signatures.filter((entry) => !entry.err);
  return ok.length ? ok[ok.length - 1].signature : null;
}

/** Account data size of each claim receipt (8-byte discriminator + fields in mwz_rewards_treasury). */
const CLAIM_RECEIPT_BYTES: Record<RewardClaimCanonicalInput["kind"], number> = {
  league: 8 + 32 + 1 + 8 + 32 + 1 + 8 + 1,
  airdrop: 8 + 32 + 8 + 1 + 8 + 1,
  recruiter: 8 + 32 + 8 + 8 + 1,
  squad: 8 + 32 + 8 + 8 + 1,
};

function solText(lamports: number): string {
  return (Math.ceil(lamports / 10_000) / 100_000).toFixed(4);
}

/**
 * A claim creates a receipt on Solana that the claimer pays rent for, and a wallet must keep
 * Solana's own minimum balance. When the wallet is short, the network refuses the transaction
 * (InsufficientFundsForRent). Say that in plain words, with the real amounts.
 */
async function explainClaimFailure(
  web3: SolanaWeb3Module,
  connection: Connection,
  payer: string,
  kind: RewardClaimCanonicalInput["kind"],
  error: unknown,
): Promise<Error> {
  const raw = String((error as Error)?.message || error || "");
  if (!/InsufficientFundsForRent|insufficient lamports|InsufficientFunds/i.test(raw)) {
    return error instanceof Error ? error : new Error(raw);
  }
  try {
    const [balance, receiptRent, walletMinimum] = await Promise.all([
      connection.getBalance(new web3.PublicKey(payer), "confirmed"),
      connection.getMinimumBalanceForRentExemption(CLAIM_RECEIPT_BYTES[kind]),
      connection.getMinimumBalanceForRentExemption(0),
    ]);
    const needed = receiptRent + walletMinimum + 10_000;
    const shortBy = Math.max(needed - balance, 10_000);
    return new Error(
      `Your wallet needs a little more SOL to claim this reward. Claiming saves a small record on Solana `
      + `that costs ${solText(receiptRent)} SOL, and Solana requires every wallet to keep at least `
      + `${solText(walletMinimum)} SOL. Your wallet has ${solText(balance)} SOL. `
      + `Add about ${solText(shortBy)} SOL and try again. Nothing was sent.`,
    );
  } catch {
    return new Error("Your wallet needs a little more SOL to claim this reward: claiming saves a small record on Solana that costs about 0.0013 SOL. Add some SOL and try again. Nothing was sent.");
  }
}

export async function submitSolanaRewardV0Claim(input: {
  web3: SolanaWeb3Module;
  chainId: number;
  addresses: RewardClaimAddresses;
  canonical: RewardClaimCanonicalInput;
  instruction: TransactionInstruction;
  label: string;
}): Promise<string> {
  if (!isSolanaRewardChainId(input.chainId)) throw new Error("Wrong Solana chain for reward claim.");

  const provider = getSolanaProvider();
  if (!provider?.publicKey || typeof provider.signTransaction !== "function") {
    throw new Error(`Connect a Solana wallet that can sign this ${input.label}.`);
  }
  const connected = String(provider.publicKey.toString?.() || provider.publicKey);
  if (connected !== String(input.addresses.recipient || "").trim()) {
    throw new Error("Connected Solana wallet does not own this reward.");
  }

  assertCanonicalSolanaRewardClaim(input.web3, input.addresses, input.canonical);

  const connection = new input.web3.Connection(getSolanaRewardRpcUrl(input.chainId), "confirmed");
  if (await claimReceiptExists(input.web3, connection, input.addresses.claimReceiptAddress)) {
    if (input.canonical.kind === "league") {
      const paid = await claimSignatureForReceipt(input.web3, connection, input.addresses.claimReceiptAddress);
      if (paid) return paid;
    }
    throw new Error("This Solana reward is already claimed on-chain. Refresh rewards before retrying.");
  }

  // League claims carry a Merkle proof, 32 bytes per level, and nothing in the
  // encoder bounds its depth. Measured, a six-account claim fits a proof of 17
  // levels (131,072 leaves); at 18 it runs out of room for the wallet's own
  // instructions. Without this the first oversized claim would surface as
  // Phantom calling the site malicious rather than as a size error.
  const intent = {
    payer: connected,
    instructions: [input.instruction],
    walletRewriteBudgetBytes: SOLANA_WALLET_REWRITE_BUDGET_BYTES,
  };
  const simulated = await compileSolanaUserV0WithLatestBlockhash(input.web3, connection, intent);
  try {
    await simulateSolanaUserV0OrThrow(connection, simulated.transaction, input.label);
  } catch (error) {
    throw await explainClaimFailure(input.web3, connection, connected, input.canonical.kind, error);
  }

  // Rebuild after simulation so the wallet always receives a fresh blockhash.
  const final = await compileSolanaUserV0WithLatestBlockhash(input.web3, connection, intent);
  const signed = await provider.signTransaction(final.transaction);
  // Wallets may prepend compute-budget / safety instructions; the claim itself must be unchanged.
  assertSolanaUserV0Intent(input.web3, signed, { ...intent, allowAdditionalInstructions: true });

  const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
  const confirmation = await confirmLaunchpadSignature(connection, {
    signature,
    lastValidBlockHeight: final.latest.lastValidBlockHeight,
    recover: () => claimReceiptExists(input.web3, connection, input.addresses.claimReceiptAddress),
  });
  if (confirmation.err) {
    throw new Error(`${input.label} failed: ${JSON.stringify(confirmation.err)}`);
  }
  return signature;
}

export type RewardClaimBatchResult = { signature: string; alreadyPaid?: boolean } | { error: Error };

/**
 * Several reward claims with one wallet approval (founder, 2026-10-08: three league prizes took nine
 * prompts). Each claim is built, checked and simulated exactly like submitSolanaRewardV0Claim, so
 * every transaction is the same as a single claim. The wallet approves them together through
 * signAllTransactions (Phantom, Solflare, Backpack); a wallet without it signs them one by one.
 * A claim that fails its checks or simulation gets its own error and is not sent; the others go on.
 * Results are in input order.
 */
export async function submitSolanaRewardV0Claims(
  inputs: Array<{
    web3: SolanaWeb3Module;
    chainId: number;
    addresses: RewardClaimAddresses;
    canonical: RewardClaimCanonicalInput;
    instruction: TransactionInstruction;
    label: string;
  }>,
): Promise<RewardClaimBatchResult[]> {
  const results: RewardClaimBatchResult[] = inputs.map(() => ({ error: new Error("Not sent.") }));
  if (!inputs.length) return results;
  const provider = getSolanaProvider();
  if (!provider?.publicKey || typeof provider.signTransaction !== "function") {
    throw new Error("Connect a Solana wallet that can sign these claims.");
  }
  const connected = String(provider.publicKey.toString?.() || provider.publicKey);

  type Ready = {
    index: number;
    input: (typeof inputs)[number];
    connection: Connection;
    intent: Parameters<typeof compileSolanaUserV0WithLatestBlockhash>[2];
    final: Awaited<ReturnType<typeof compileSolanaUserV0WithLatestBlockhash>>;
  };
  const ready: Ready[] = [];
  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];
    try {
      if (!isSolanaRewardChainId(input.chainId)) throw new Error("Wrong Solana chain for reward claim.");
      if (connected !== String(input.addresses.recipient || "").trim()) throw new Error("Connected Solana wallet does not own this reward.");
      assertCanonicalSolanaRewardClaim(input.web3, input.addresses, input.canonical);
      const connection = new input.web3.Connection(getSolanaRewardRpcUrl(input.chainId), "confirmed");
      if (await claimReceiptExists(input.web3, connection, input.addresses.claimReceiptAddress)) {
        const paid = input.canonical.kind === "league"
          ? await claimSignatureForReceipt(input.web3, connection, input.addresses.claimReceiptAddress)
          : null;
        results[index] = paid
          ? { signature: paid, alreadyPaid: true }
          : { error: new Error("This Solana reward is already claimed on-chain. Refresh rewards before retrying.") };
        continue;
      }
      const intent = {
        payer: connected,
        instructions: [input.instruction],
        walletRewriteBudgetBytes: SOLANA_WALLET_REWRITE_BUDGET_BYTES,
      };
      const simulated = await compileSolanaUserV0WithLatestBlockhash(input.web3, connection, intent);
      try {
        await simulateSolanaUserV0OrThrow(connection, simulated.transaction, input.label);
      } catch (error) {
        throw await explainClaimFailure(input.web3, connection, connected, input.canonical.kind, error);
      }
      const final = await compileSolanaUserV0WithLatestBlockhash(input.web3, connection, intent);
      ready.push({ index, input, connection, intent, final });
    } catch (error) {
      results[index] = { error: error instanceof Error ? error : new Error(String(error)) };
    }
  }
  if (!ready.length) return results;

  const unsigned = ready.map((entry) => entry.final.transaction);
  const signedAll =
    ready.length > 1 && typeof (provider as { signAllTransactions?: unknown }).signAllTransactions === "function"
      ? await (provider as { signAllTransactions: (txs: typeof unsigned) => Promise<typeof unsigned> }).signAllTransactions(unsigned)
      : null;

  for (let i = 0; i < ready.length; i += 1) {
    const entry = ready[i];
    try {
      const signed = signedAll ? signedAll[i] : await provider.signTransaction(entry.final.transaction);
      assertSolanaUserV0Intent(entry.input.web3, signed, { ...entry.intent, allowAdditionalInstructions: true });
      const signature = await entry.connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
      const confirmation = await confirmLaunchpadSignature(entry.connection, {
        signature,
        lastValidBlockHeight: entry.final.latest.lastValidBlockHeight,
        recover: () => claimReceiptExists(entry.input.web3, entry.connection, entry.input.addresses.claimReceiptAddress),
      });
      if (confirmation.err) throw new Error(`${entry.input.label} failed: ${JSON.stringify(confirmation.err)}`);
      results[entry.index] = { signature };
    } catch (error) {
      // A declined approval stops the rest: the wallet said no to the batch.
      if (/reject|denied|cancel/i.test(String((error as Error)?.message || ""))) throw error;
      results[entry.index] = { error: error instanceof Error ? error : new Error(String(error)) };
    }
  }
  return results;
}
