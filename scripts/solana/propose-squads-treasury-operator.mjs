#!/usr/bin/env node
/**
 * Squads v4 proposal: make a dedicated graduation keeper the launchpad's treasury_operator.
 *
 * Why: begin_graduation must be signed by GlobalConfig.treasury_operator. On mainnet that role was the
 * multisig vault itself, so no bot could graduate a closed curve -- every graduation would need its own
 * Squads proposal. Auto-graduation (what every launchpad does) needs the keeper key in that role. The
 * key can graduate curves and claim the fees of the locked LP positions it creates; it cannot move
 * locked liquidity and it is not the deployer.
 *
 * update_global_authorities replaces all eight roles at once, so this script reads the CURRENT roles
 * from chain and changes exactly one field. Every other role is copied byte for byte; the script prints
 * the before/after table and refuses if anything but treasury_operator would change.
 *
 *   SOLANA_RPC_URL=<rpc> node scripts/solana/propose-squads-treasury-operator.mjs \
 *     --multisig C43Ddmgt3iC9PTeHLyiQvtUtFAXC7U2v3d7KyzdF5YzY --keeper <keeper pubkey> \
 *     --creator-keypair <member keypair>                    # dry run: reads + simulates
 *     ... --send                                            # creates the proposal, then decodes it back
 *
 * It never approves. Members approve in the Squads app after the decode says MATCHES.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../tests/solana/package.json", import.meta.url));
const { Connection, PublicKey, Keypair, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } = require("@solana/web3.js");
const multisig = require("@sqds/multisig");

const PROGRAM_ID = new PublicKey("3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt");
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const ROLES = ["admin", "pauser", "tier_admin", "risk_admin", "route_signer", "reward_operator", "treasury_operator", "generation_operator"];
const DISCRIMINATOR = Buffer.from([62, 119, 189, 253, 39, 244, 35, 149]); // update_global_authorities (IDL)
const PERM_INITIATE = 1;

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? String(args[i + 1] || "").trim() : ""; };
const flag = (name) => args.includes(name);
function fail(msg) { console.error(`refusing: ${msg}`); process.exit(1); }
const need = (name) => opt(name) || fail(`${name} is required`);

const rpc = String(process.env.SOLANA_RPC_URL || "").trim() || fail("SOLANA_RPC_URL must be set");
const conn = new Connection(rpc, "finalized");
const multisigPda = new PublicKey(need("--multisig"));
const keeper = new PublicKey(need("--keeper"));
const send = flag("--send");
const local = flag("--local");
const priorityFee = Number(opt("--priority-fee") || 10000);

export function readRoles(data) {
  return Object.fromEntries(ROLES.map((role, i) => [role, new PublicKey(data.subarray(8 + 32 * i, 8 + 32 * (i + 1)))]));
}

export function encodeUpdate(roles) {
  return Buffer.concat([DISCRIMINATOR, ...ROLES.map((role) => roles[role].toBuffer())]);
}

/** Independent read-back: parse the VaultTransaction account and return the roles its instruction sets. */
export function decodeAuthoritiesProposal(data) {
  let o = 8 + 32 + 32 + 8; // disc, multisig, creator, index
  o += 3; // bump, vault_index, vault_bump
  const ephemeral = data.readUInt32LE(o); o += 4 + ephemeral;
  o += 3; // num_signers, num_writable_signers, num_writable_non_signers
  const nKeys = data.readUInt32LE(o); o += 4;
  const keys = [];
  for (let i = 0; i < nKeys; i += 1) { keys.push(new PublicKey(data.subarray(o, o + 32))); o += 32; }
  const nIx = data.readUInt32LE(o); o += 4;
  const ixs = [];
  for (let i = 0; i < nIx; i += 1) {
    const programIdIndex = data[o]; o += 1;
    const nAcc = data.readUInt32LE(o); o += 4;
    const accounts = Array.from(data.subarray(o, o + nAcc)).map((k) => keys[k]); o += nAcc;
    const nData = data.readUInt32LE(o); o += 4;
    const ixData = Buffer.from(data.subarray(o, o + nData)); o += nData;
    ixs.push({ programId: keys[programIdIndex], accounts, data: ixData });
  }
  if (ixs.length !== 1) throw new Error(`expected one instruction, found ${ixs.length}`);
  const [ix] = ixs;
  if (!ix.data.subarray(0, 8).equals(DISCRIMINATOR)) throw new Error("not update_global_authorities");
  const roles = Object.fromEntries(ROLES.map((role, i) => [role, new PublicKey(ix.data.subarray(8 + 32 * i, 8 + 32 * (i + 1)))]));
  return { programId: ix.programId, accounts: ix.accounts, roles };
}

async function main() {
  const genesis = await conn.getGenesisHash();
  if (local && genesis === MAINNET_GENESIS) fail("--local given but the RPC reports mainnet-beta");
  if (!local && genesis !== MAINNET_GENESIS) fail(`RPC reports genesis ${genesis}, not mainnet-beta (pass --local for a rehearsal)`);

  const creator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(need("--creator-keypair"), "utf8"))));
  const ms = await multisig.accounts.Multisig.fromAccountAddress(conn, multisigPda);
  const member = ms.members.find((m) => m.key.equals(creator.publicKey));
  if (!member) fail(`${creator.publicKey.toBase58()} is not a member of ${multisigPda.toBase58()}`);
  if (!(member.permissions.mask & PERM_INITIATE)) fail(`${creator.publicKey.toBase58()} has no Initiate permission`);
  const [vault] = multisig.getVaultPda({ multisigPda, index: 0 });

  const [globalConfig] = PublicKey.findProgramAddressSync([Buffer.from("global")], PROGRAM_ID);
  const info = await conn.getAccountInfo(globalConfig, "finalized");
  if (!info || !info.owner.equals(PROGRAM_ID)) fail("GlobalConfig not found under the launchpad program");
  const before = readRoles(info.data);
  if (!before.admin.equals(vault)) fail(`GlobalConfig.admin is ${before.admin.toBase58()}, not vault 0 ${vault.toBase58()} -- this multisig cannot change the roles`);
  if (before.treasury_operator.equals(keeper)) fail(`treasury_operator is already ${keeper.toBase58()}; nothing to do`);
  if (keeper.equals(vault) || keeper.equals(PublicKey.default)) fail("the keeper must be a dedicated key, not the vault and not empty");
  const deployer = new PublicKey("9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H");
  if (keeper.equals(deployer)) fail("the keeper must not be the deployer (the deployer never holds user money)");

  const after = { ...before, treasury_operator: keeper };
  console.log(`cluster      ${local ? "local rehearsal" : "mainnet-beta"}`);
  console.log(`multisig     ${multisigPda.toBase58()}  threshold ${ms.threshold} of ${ms.members.length}  vault 0 ${vault.toBase58()}`);
  console.log(`creator      ${creator.publicKey.toBase58()}`);
  console.log("\nrole                 current                                        proposed");
  for (const role of ROLES) {
    const changed = !before[role].equals(after[role]);
    console.log(`${role.padEnd(20)} ${before[role].toBase58().padEnd(46)} ${changed ? after[role].toBase58() + "   <== CHANGES" : "(unchanged)"}`);
  }
  const changedRoles = ROLES.filter((r) => !before[r].equals(after[r]));
  if (changedRoles.length !== 1 || changedRoles[0] !== "treasury_operator") fail(`would change ${changedRoles.join(",")}`);

  const updateIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: vault, isSigner: true, isWritable: false },
      { pubkey: globalConfig, isSigner: false, isWritable: true },
    ],
    data: encodeUpdate(after),
  });
  const newIndex = BigInt(ms.transactionIndex.toString()) + 1n;
  const [txPda] = multisig.getTransactionPda({ multisigPda, index: newIndex });
  const [proposalPda] = multisig.getProposalPda({ multisigPda, transactionIndex: newIndex });
  if (await conn.getAccountInfo(txPda)) fail(`transaction ${newIndex} already exists; re-run`);

  const inner = new TransactionMessage({ payerKey: vault, recentBlockhash: PublicKey.default.toBase58(), instructions: [updateIx] });
  const createIx = multisig.instructions.vaultTransactionCreate({
    multisigPda, transactionIndex: newIndex, creator: creator.publicKey, rentPayer: creator.publicKey,
    vaultIndex: 0, ephemeralSigners: 0, transactionMessage: inner,
    memo: `launchpad treasury_operator -> graduation keeper ${keeper.toBase58()}`,
  });
  const proposeIx = multisig.instructions.proposalCreate({ multisigPda, creator: creator.publicKey, rentPayer: creator.publicKey, transactionIndex: newIndex, isDraft: false });
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("finalized");
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: creator.publicKey, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }), createIx, proposeIx],
  }).compileToV0Message());
  tx.sign([creator]);
  const sim = await conn.simulateTransaction(tx, { sigVerify: true, commitment: "finalized" });
  if (sim.value.err) { console.error("simulation failed:", JSON.stringify(sim.value.err)); for (const l of sim.value.logs || []) console.error("  " + l); process.exit(1); }
  console.log(`\nwill create transaction ${newIndex} at ${txPda.toBase58()} + proposal ${proposalPda.toBase58()} -- simulated ok, ${sim.value.unitsConsumed} CU`);
  if (!send) { console.log("\nDRY RUN. Nothing sent. Re-run with --send to create the proposal."); return; }

  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
  const conf = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "finalized");
  if (conf.value.err) fail(`transaction failed: ${JSON.stringify(conf.value.err)}`);
  console.log(`\nsent ${sig} (finalized)`);

  // Read the proposal back from chain with a separate parser and compare every field.
  const vt = await conn.getAccountInfo(txPda, "finalized");
  const decoded = decodeAuthoritiesProposal(vt.data);
  const problems = [];
  if (!decoded.programId.equals(PROGRAM_ID)) problems.push(`program ${decoded.programId.toBase58()}`);
  if (!decoded.accounts[0]?.equals(vault) || !decoded.accounts[1]?.equals(globalConfig)) problems.push("accounts");
  for (const role of ROLES) if (!decoded.roles[role].equals(after[role])) problems.push(`${role} ${decoded.roles[role].toBase58()}`);
  if (problems.length) { console.error(`PROPOSAL DOES NOT MATCH -- DO NOT SIGN: ${problems.join("; ")}`); process.exit(1); }
  console.log(`PROPOSAL MATCHES -- decoded from chain: only treasury_operator changes, to ${keeper.toBase58()}. Approve ${ms.threshold} of ${ms.members.length} in the Squads app.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(String(e.stack || e.message || e)); process.exit(2); });
