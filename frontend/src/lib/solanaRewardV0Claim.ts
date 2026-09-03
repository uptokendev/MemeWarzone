import type { Connection, TransactionInstruction } from "@solana/web3.js";
import { confirmLaunchpadSignature } from "@/lib/solanaConfirmSignature";
import { getSolanaRewardRpcUrl, isSolanaRewardChainId } from "@/lib/solanaRewardNetwork";
import {
  assertSolanaUserV0Intent,
  compileSolanaUserV0WithLatestBlockhash,
  simulateSolanaUserV0OrThrow,
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
    if (period !== 0 && period !== 1) throw new Error("Invalid Solana league period code");
    if (rank < 1 || rank > 5) throw new Error("Invalid Solana league rank");
    if (canonical.categoryHash.length !== 32) throw new Error("Invalid Solana league category hash");
    const epoch = i64le(canonical.epochStartSec);
    assertAddress("league vault PDA", addresses.vaultAddress, derive(web3, [utf8("league_vault")]));
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
    throw new Error("This Solana reward is already claimed on-chain. Refresh rewards before retrying.");
  }

  const intent = { payer: connected, instructions: [input.instruction] };
  const simulated = await compileSolanaUserV0WithLatestBlockhash(input.web3, connection, intent);
  await simulateSolanaUserV0OrThrow(connection, simulated.transaction, input.label);

  // Rebuild after simulation so the wallet always receives a fresh blockhash.
  const final = await compileSolanaUserV0WithLatestBlockhash(input.web3, connection, intent);
  const signed = await provider.signTransaction(final.transaction);
  assertSolanaUserV0Intent(input.web3, signed, intent);

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
