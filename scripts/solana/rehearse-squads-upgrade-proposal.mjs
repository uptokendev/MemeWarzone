#!/usr/bin/env node
/**
 * Helper for rehearse-squads-upgrade-proposal.sh: the multisig-side steps that
 * on mainnet are done by the other members in the Squads app. Refuses to run
 * against mainnet-beta by genesis hash, so it cannot be pointed at the real
 * multisig by mistake.
 *
 *   derive          --create-key <kp>                         -> "<multisigPda> <vault0>"
 *   create-multisig --create-key <kp> --creator <kp> --members <kp,kp> [--threshold 2]
 *   approve         --multisig <pda> --index <n> --member <kp>
 *   execute         --multisig <pda> --index <n> --member <kp>
 *   status          --multisig <pda> --index <n>
 */
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../tests/solana/package.json", import.meta.url));
const { Connection, PublicKey, Keypair, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } = require("@solana/web3.js");
const multisig = require("@sqds/multisig");

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? String(args[i + 1] || "").trim() : ""; };
const kp = (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
const rpc = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
const conn = new Connection(rpc, "confirmed");

async function main() {
  if (cmd === "derive") {
    const [ms] = multisig.getMultisigPda({ createKey: kp(opt("--create-key")).publicKey });
    const [vault] = multisig.getVaultPda({ multisigPda: ms, index: 0 });
    console.log(`${ms.toBase58()} ${vault.toBase58()}`);
    return;
  }
  if ((await conn.getGenesisHash()) === MAINNET_GENESIS) { console.error("refusing: this is mainnet-beta"); process.exit(1); }
  const confirm = async (sig) => { const r = await conn.confirmTransaction(sig, "confirmed"); if (r.value.err) throw new Error(`${sig} failed: ${JSON.stringify(r.value.err)}`); return sig; };

  if (cmd === "create-multisig") {
    const createKey = kp(opt("--create-key")); const creator = kp(opt("--creator"));
    const others = opt("--members").split(",").filter(Boolean).map((p) => kp(p).publicKey);
    const [cfgPda] = multisig.getProgramConfigPda({});
    const cfg = await multisig.accounts.ProgramConfig.fromAccountAddress(conn, cfgPda);
    const [ms] = multisig.getMultisigPda({ createKey: createKey.publicKey });
    const members = [creator.publicKey, ...others].map((key) => ({ key, permissions: multisig.types.Permissions.all() }));
    const sig = await multisig.rpc.multisigCreateV2({ connection: conn, treasury: cfg.treasury, createKey, creator, multisigPda: ms,
      configAuthority: null, threshold: Number(opt("--threshold") || 2), members, timeLock: 0, rentCollector: null });
    await confirm(sig);
    console.log(`multisig ${ms.toBase58()} created (${sig})`);
    return;
  }
  const multisigPda = new PublicKey(opt("--multisig"));
  const transactionIndex = BigInt(opt("--index"));
  if (cmd === "approve") {
    const member = kp(opt("--member"));
    const sig = await confirm(await multisig.rpc.proposalApprove({ connection: conn, feePayer: member, member, multisigPda, transactionIndex }));
    console.log(`approved by ${member.publicKey.toBase58()} (${sig})`);
    return;
  }
  if (cmd === "execute") {
    // Built by hand rather than through rpc.vaultTransactionExecute: the SDK's
    // error translation throws a TypeError of its own on failure and the real
    // reason is lost. Simulate first so the logs are visible.
    const member = kp(opt("--member"));
    const { instruction, lookupTableAccounts } = await multisig.instructions.vaultTransactionExecute({ connection: conn, multisigPda, transactionIndex, member: member.publicKey });
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    const msg = new TransactionMessage({ payerKey: member.publicKey, recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), instruction] }).compileToV0Message(lookupTableAccounts);
    const tx = new VersionedTransaction(msg); tx.sign([member]);
    const sim = await conn.simulateTransaction(tx, { sigVerify: true });
    if (sim.value.err) { console.error("execute simulation failed:", JSON.stringify(sim.value.err)); for (const l of sim.value.logs || []) console.error("  " + l); process.exit(1); }
    const sig = await conn.sendRawTransaction(tx.serialize());
    const r = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (r.value.err) throw new Error(`${sig} failed: ${JSON.stringify(r.value.err)}`);
    console.log(`executed by ${member.publicKey.toBase58()} (${sig}), ${sim.value.unitsConsumed} CU`);
    return;
  }
  if (cmd === "status") {
    const [pPda] = multisig.getProposalPda({ multisigPda, transactionIndex });
    const p = await multisig.accounts.Proposal.fromAccountAddress(conn, pPda);
    console.log(`proposal ${transactionIndex}: ${p.status.__kind}, approved ${p.approved.map((k) => k.toBase58()).join(",") || "-"}`);
    return;
  }
  console.error("unknown command"); process.exit(2);
}
main().catch((e) => { console.error(String(e.stack || e.message || e)); process.exit(2); });
