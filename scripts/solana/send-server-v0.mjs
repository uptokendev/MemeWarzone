import { TransactionMessage, VersionedTransaction } from "@solana/web3.js";

/**
 * Compile, sign, simulate, rebuild with a fresh blockhash, submit and confirm a
 * server/operator Solana V0 transaction. The caller supplies already-validated
 * instructions and the only required signer/payer.
 */
export async function sendServerV0(connection, signer, instructions, label = "Solana operator transaction") {
  if (!Array.isArray(instructions) || instructions.length === 0) {
    throw new Error(`${label}: no instructions supplied`);
  }

  const compile = async () => {
    const latest = await connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: latest.blockhash,
      instructions,
    }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    transaction.sign([signer]);
    return { transaction, latest };
  };

  const simulated = await compile();
  const simulation = await connection.simulateTransaction(simulated.transaction, {
    commitment: "confirmed",
    sigVerify: true,
    replaceRecentBlockhash: false,
  });
  if (simulation.value.err) {
    const logs = simulation.value.logs?.slice(-12).join("\n") || "";
    throw new Error(`${label} simulation failed: ${JSON.stringify(simulation.value.err)}${logs ? `\n${logs}` : ""}`);
  }

  const final = await compile();
  const signature = await connection.sendRawTransaction(final.transaction.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  const confirmation = await connection.confirmTransaction(
    { signature, ...final.latest },
    "confirmed",
  );
  if (confirmation.value.err) {
    throw new Error(`${label} failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
  }
  return signature;
}
