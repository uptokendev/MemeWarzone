import { DBC_PROGRAM_ID } from "../../shared/dbcEconomics.mjs";

export const DBC_SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const DBC_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const DBC_ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const DBC_COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
export const DBC_METAPLEX_METADATA_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

/** Programs a DBC createPool / createPoolWithFirstBuy transaction may call. */
export const DBC_CREATE_ALLOWED_PROGRAM_IDS = new Set([
  DBC_PROGRAM_ID,
  DBC_SYSTEM_PROGRAM_ID,
  DBC_TOKEN_PROGRAM_ID,
  DBC_ASSOCIATED_TOKEN_PROGRAM_ID,
  DBC_COMPUTE_BUDGET_PROGRAM_ID,
  DBC_METAPLEX_METADATA_PROGRAM_ID,
]);

function keyOf(value) {
  if (!value) return "";
  if (typeof value.toBase58 === "function") return value.toBase58();
  return String(value);
}

function referencedAddresses(tx) {
  const out = new Set();
  const feePayer = keyOf(tx.feePayer);
  if (feePayer) out.add(feePayer);
  for (const ix of tx.instructions || []) {
    out.add(keyOf(ix.programId));
    for (const account of ix.keys || []) out.add(keyOf(account.pubkey));
  }
  return out;
}

export function assertDbcCreateIntent(tx, { creator, pool, config, mint }) {
  const feePayer = keyOf(tx.feePayer);
  if (!feePayer || feePayer !== String(creator)) {
    throw new Error("DBC create fee payer is not the creator.");
  }
  const instructions = tx.instructions || [];
  if (!instructions.length) throw new Error("DBC create transaction has no instructions.");
  for (const ix of instructions) {
    const programId = keyOf(ix.programId);
    if (!DBC_CREATE_ALLOWED_PROGRAM_IDS.has(programId)) {
      throw new Error(`Unexpected program in DBC create: ${programId}`);
    }
  }
  const referenced = referencedAddresses(tx);
  for (const [label, address] of [
    ["pool", pool],
    ["config", config],
    ["mint", mint],
  ]) {
    if (!referenced.has(String(address))) {
      throw new Error(`DBC create is missing the ${label} account.`);
    }
  }
}

const PLACEHOLDER_BLOCKHASH = "11111111111111111111111111111111";

export async function prepareDbcCreateTransaction(connection, tx, expected) {
  const latest = await connection.getLatestBlockhash("confirmed");
  const blockhash = String(latest?.blockhash || "");
  const lastValidBlockHeight = Number(latest?.lastValidBlockHeight);
  if (!blockhash || blockhash === PLACEHOLDER_BLOCKHASH) {
    throw new Error("RPC did not return a fresh blockhash.");
  }
  if (!Number.isFinite(lastValidBlockHeight) || lastValidBlockHeight <= 0) {
    throw new Error("RPC did not return lastValidBlockHeight.");
  }
  tx.recentBlockhash = blockhash;
  assertDbcCreateIntent(tx, expected);

  // A legacy Transaction takes no config object in web3.js 1.x (it throws "Invalid arguments");
  // called this way it simulates unsigned, against the fresh blockhash set above.
  const simulation = await connection.simulateTransaction(tx);
  if (simulation?.value?.err) {
    throw new Error(`DBC create simulation failed: ${JSON.stringify(simulation.value.err)}`);
  }
  return { tx, blockhash, lastValidBlockHeight, unitsConsumed: simulation?.value?.unitsConsumed ?? null };
}

export async function submitPreparedDbcCreate({
  connection,
  transaction,
  mintSecretKey,
  mintAddress,
  creatorAddress,
  pool,
  config,
  signTransaction,
  Keypair,
}) {
  if (typeof signTransaction !== "function") {
    throw new Error("DBC create needs a signTransaction function.");
  }
  const mint = Keypair.fromSecretKey(mintSecretKey);
  if (mint.publicKey.toBase58() !== String(mintAddress)) {
    throw new Error("The mint key does not match the authorized token.");
  }
  const prepared = await prepareDbcCreateTransaction(connection, transaction, {
    creator: creatorAddress,
    pool,
    config,
    mint: mintAddress,
  });
  // The wallet signs first, the mint key after (2026-10-01). Phantom blocks a request that already
  // carries another signature ("Request blocked: this dApp could be malicious"), because it can no
  // longer add its own Lighthouse guard instructions. Signing the mint last also covers any
  // instruction the wallet adds: the mint signs the message as the wallet returned it.
  const signed = await signTransaction(prepared.tx);
  if (!signed || typeof signed.partialSign !== "function" || typeof signed.serialize !== "function") {
    throw new Error("The wallet returned a transaction the mint key cannot co-sign.");
  }
  signed.partialSign(mint);
  const raw = signed.serialize();
  const signature = await connection.sendRawTransaction(raw, {
    skipPreflight: false,
    maxRetries: 3,
  });
  const confirmation = await connection.confirmTransaction(
    {
      signature,
      blockhash: prepared.blockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
    },
    "confirmed",
  );
  if (confirmation.value?.err) {
    throw new Error(`DBC create transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }
  return {
    signature,
    pool,
    mintAddress,
    blockhash: prepared.blockhash,
    lastValidBlockHeight: prepared.lastValidBlockHeight,
    serializedBytes: raw.length,
    signerCount: signed.compileMessage().header.numRequiredSignatures,
  };
}
