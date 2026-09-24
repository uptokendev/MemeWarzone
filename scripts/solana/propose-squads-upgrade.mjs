#!/usr/bin/env node
/**
 * Create the Squads v4 proposal for a BPFLoaderUpgradeable::Upgrade from the
 * terminal, without the Squads web app.
 *
 * Why: on 2026-09-24 the web app refused to register a buffer address it had
 * seen in an earlier, executed upgrade ("This buffer is already in this
 * squad"). The staging script re-uses a named buffer keypair on purpose, so
 * the address is the same every time; on chain a re-staged buffer is a fresh
 * account with the multisig as authority and nothing is wrong with it. The
 * refusal is the app's own bookkeeping. The deployer is a full-permission
 * member of the multisig, so it can create the VaultTransaction + Proposal
 * itself and the other members approve in the app as usual.
 *
 * Every fact the proposal depends on is read from the chain first, and any
 * mismatch is a refusal: cluster by genesis hash, creator is a member with
 * Initiate, vault 0 is the program's upgrade authority AND the buffer's
 * authority, the buffer's bytes are the binary CERTIFIED FOR THAT PROGRAM in
 * config/solana/*.certification.json (followed only by zeros) -- the check
 * nothing in the path had on 2026-09-24, when treasury bytes went into the
 * launchpad -- and also the --candidate file, and the program's allocation
 * can hold them. A program with no certification file is refused outright. Then it builds the exact
 * instruction the decoder expects, simulates, and only with --send sends.
 * After sending it runs decode-squads-proposal.mjs on the new account, so the
 * result is checked by a parser that shares no code with this builder.
 *
 * It creates and proposes. It never approves: approval happens only after the
 * decoder has said "PROPOSAL MATCHES" (the rule since the incident).
 *
 *   SOLANA_RPC_URL=<rpc> node scripts/solana/propose-squads-upgrade.mjs \
 *     --multisig <multisigPda> --program <id> --buffer <id> --spill <id> --authority <vault> \
 *     --candidate <path.so> --creator-keypair <member keypair>            # dry run: reads + simulates
 *     ... --send                                                           # sends
 *     ... --local                                                          # local validator only; refused on mainnet
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../../tests/solana/package.json", import.meta.url));
const web3 = require("@solana/web3.js");
const multisig = require("@sqds/multisig");
const { Connection, PublicKey, Keypair, TransactionInstruction, TransactionMessage, VersionedTransaction,
  SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY, ComputeBudgetProgram } = web3;

const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const UPGRADE_TAG = 3; // BPFLoaderUpgradeable::Upgrade
const CERTIFICATIONS = ["launchpad-binary.certification.json", "treasury-binary.certification.json"]
  .map((f) => JSON.parse(fs.readFileSync(fileURLToPath(new URL(`../../config/solana/${f}`, import.meta.url)), "utf8")));
const PERM_INITIATE = 1;

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? String(args[i + 1] || "").trim() : ""; };
const flag = (name) => args.includes(name);
const need = (name) => { const v = opt(name); if (!v) fail(`${name} is required`); return v; };
function fail(msg) { console.error(`refusing: ${msg}`); process.exit(1); }
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

const rpc = String(process.env.SOLANA_RPC_URL || "").trim();
if (!rpc) fail("SOLANA_RPC_URL must be set");
const conn = new Connection(rpc, "finalized");

const multisigPda = new PublicKey(need("--multisig"));
const programId = new PublicKey(need("--program"));
const bufferId = new PublicKey(need("--buffer"));
const spill = new PublicKey(need("--spill"));
const expectedAuthority = new PublicKey(need("--authority"));
const candidatePath = need("--candidate");
const creator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(need("--creator-keypair"), "utf8"))));
const send = flag("--send");
const local = flag("--local");
const priorityFee = Number(opt("--priority-fee") || 10000);

async function main() {
  // 1. Which cluster this really is. A URL cannot be trusted to say.
  const genesis = await conn.getGenesisHash();
  if (local && genesis === MAINNET_GENESIS) fail("--local given but the RPC reports mainnet-beta");
  if (!local && genesis !== MAINNET_GENESIS) fail(`RPC reports genesis ${genesis}, not mainnet-beta (pass --local for a rehearsal)`);
  console.log(`cluster      ${local ? "local rehearsal" : "mainnet-beta"} (genesis ${genesis})`);

  // 2. The multisig, and the creator's standing in it.
  const ms = await multisig.accounts.Multisig.fromAccountAddress(conn, multisigPda);
  const member = ms.members.find((m) => m.key.equals(creator.publicKey));
  if (!member) fail(`${creator.publicKey.toBase58()} is not a member of ${multisigPda.toBase58()}`);
  if (!(member.permissions.mask & PERM_INITIATE)) fail(`${creator.publicKey.toBase58()} has no Initiate permission (mask ${member.permissions.mask})`);
  const [vault] = multisig.getVaultPda({ multisigPda, index: 0 });
  if (!vault.equals(expectedAuthority)) fail(`vault 0 of this multisig is ${vault.toBase58()}, not --authority ${expectedAuthority.toBase58()}`);
  const currentIndex = BigInt(ms.transactionIndex.toString());
  const newIndex = currentIndex + 1n;
  console.log(`multisig     ${multisigPda.toBase58()}  threshold ${ms.threshold} of ${ms.members.length}  transaction_index ${currentIndex}`);
  console.log(`creator      ${creator.publicKey.toBase58()}  (member, mask ${member.permissions.mask})`);
  console.log(`vault 0      ${vault.toBase58()}`);

  // 3. The program: which certified binary belongs to it, its ProgramData, its upgrade authority, its allocation.
  const certified = CERTIFICATIONS.find((c) => c.program.id === programId.toBase58());
  if (!certified) fail(`${programId.toBase58()} has no certification file in config/solana -- not a program this script will propose an upgrade for`);
  console.log(`certified    ${certified.program.label}: ${certified.artifact.sha256} (${certified.artifact.bytes} bytes)`);
  const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], LOADER);
  const prog = await conn.getAccountInfo(programId);
  if (!prog) fail(`no account at program ${programId.toBase58()}`);
  if (!prog.owner.equals(LOADER)) fail(`program ${programId.toBase58()} is owned by ${prog.owner.toBase58()}, not the upgradeable loader`);
  if (prog.data.readUInt32LE(0) !== 2) fail(`program account tag is ${prog.data.readUInt32LE(0)}, not Program(2)`);
  const pdFromProgram = new PublicKey(prog.data.subarray(4, 36));
  if (!pdFromProgram.equals(programData)) fail(`program points at programdata ${pdFromProgram.toBase58()}, derived ${programData.toBase58()}`);
  const pd = await conn.getAccountInfo(programData);
  if (!pd) fail(`no programdata at ${programData.toBase58()}`);
  if (pd.data.readUInt32LE(0) !== 3) fail(`programdata tag is ${pd.data.readUInt32LE(0)}, not ProgramData(3)`);
  const deployedSlot = pd.data.readBigUInt64LE(4);
  if (pd.data[12] !== 1) fail("programdata has no upgrade authority (program is immutable)");
  const pdAuthority = new PublicKey(pd.data.subarray(13, 45));
  if (!pdAuthority.equals(vault)) fail(`program upgrade authority is ${pdAuthority.toBase58()}, not vault ${vault.toBase58()}`);
  const allocation = pd.data.length - 45;
  console.log(`program      ${programId.toBase58()}  programdata ${programData.toBase58()}`);
  console.log(`             authority ${pdAuthority.toBase58()}  last deployed slot ${deployedSlot}  allocation ${allocation}`);

  // 4. The buffer: owner, authority, bytes.
  const buf = await conn.getAccountInfo(bufferId);
  if (!buf) fail(`no account at buffer ${bufferId.toBase58()}`);
  if (!buf.owner.equals(LOADER)) fail(`buffer ${bufferId.toBase58()} is owned by ${buf.owner.toBase58()}, not the upgradeable loader`);
  if (buf.data.readUInt32LE(0) !== 1) fail(`buffer tag is ${buf.data.readUInt32LE(0)}, not Buffer(1)`);
  if (buf.data[4] !== 1) fail("buffer has no authority (already closed or immutable)");
  const bufAuthority = new PublicKey(buf.data.subarray(5, 37));
  if (!bufAuthority.equals(vault)) fail(`buffer authority is ${bufAuthority.toBase58()}, not vault ${vault.toBase58()}`);
  const payload = buf.data.subarray(37);
  // The buffer must hold the binary certified for THIS program, regardless of
  // what --candidate says: the two are checked independently.
  if (payload.length < certified.artifact.bytes) fail(`buffer holds ${payload.length} bytes; the certified ${certified.program.label} binary is ${certified.artifact.bytes}`);
  const bufferSha = sha(payload.subarray(0, certified.artifact.bytes));
  if (bufferSha !== certified.artifact.sha256) fail(`buffer ${bufferId.toBase58()} holds ${bufferSha}, which is NOT the certified ${certified.program.label} binary ${certified.artifact.sha256} -- this buffer does not belong to program ${programId.toBase58()}`);
  if (!payload.subarray(certified.artifact.bytes).every((b) => b === 0)) fail("buffer has non-zero bytes after the certified binary");
  const candidate = fs.readFileSync(candidatePath);
  if (payload.length < candidate.length) fail(`buffer holds ${payload.length} bytes, candidate is ${candidate.length}`);
  if (!payload.subarray(0, candidate.length).equals(candidate)) fail(`buffer bytes differ from ${candidatePath} (buffer sha ${sha(payload.subarray(0, candidate.length))}, candidate ${sha(candidate)})`);
  if (!payload.subarray(candidate.length).every((b) => b === 0)) fail("buffer has non-zero bytes after the candidate");
  if (allocation < payload.length) fail(`allocation ${allocation} cannot hold the buffer's ${payload.length} bytes -- extend first`);
  console.log(`buffer       ${bufferId.toBase58()}  ${buf.lamports / 1e9} SOL  ${payload.length} bytes  authority ${bufAuthority.toBase58()}`);
  console.log(`             sha256 ${bufferSha}  == certified ${certified.program.label}  == ${path.basename(candidatePath)}`);
  console.log(`spill        ${spill.toBase58()}`);

  // 5. The proposal must not exist yet.
  const [txPda] = multisig.getTransactionPda({ multisigPda, index: newIndex });
  const [proposalPda] = multisig.getProposalPda({ multisigPda, transactionIndex: newIndex });
  if (await conn.getAccountInfo(txPda)) fail(`transaction ${newIndex} already exists at ${txPda.toBase58()} -- someone created one since; re-run`);
  if (await conn.getAccountInfo(proposalPda)) fail(`proposal ${newIndex} already exists at ${proposalPda.toBase58()}`);

  // 6. The Upgrade, in the loader's account order (the decoder's UPGRADE_ROLES).
  const data = Buffer.alloc(4); data.writeUInt32LE(UPGRADE_TAG, 0);
  const upgradeIx = new TransactionInstruction({
    programId: LOADER,
    keys: [
      { pubkey: programData, isSigner: false, isWritable: true },
      { pubkey: programId, isSigner: false, isWritable: true },
      { pubkey: bufferId, isSigner: false, isWritable: true },
      { pubkey: spill, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: true, isWritable: false },
    ],
    data,
  });
  const inner = new TransactionMessage({ payerKey: vault, recentBlockhash: PublicKey.default.toBase58(), instructions: [upgradeIx] });
  const createIx = multisig.instructions.vaultTransactionCreate({
    multisigPda, transactionIndex: newIndex, creator: creator.publicKey, rentPayer: creator.publicKey,
    vaultIndex: 0, ephemeralSigners: 0, transactionMessage: inner,
    memo: `upgrade ${programId.toBase58()} from buffer ${bufferId.toBase58()}`,
  });
  const proposeIx = multisig.instructions.proposalCreate({ multisigPda, creator: creator.publicKey, rentPayer: creator.publicKey, transactionIndex: newIndex, isDraft: false });

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("finalized");
  const outer = new TransactionMessage({
    payerKey: creator.publicKey, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }), createIx, proposeIx],
  }).compileToV0Message();
  const tx = new VersionedTransaction(outer);
  tx.sign([creator]);

  const sim = await conn.simulateTransaction(tx, { sigVerify: true, commitment: "finalized" });
  if (sim.value.err) { console.error("simulation failed:", JSON.stringify(sim.value.err)); for (const l of sim.value.logs || []) console.error("  " + l); process.exit(1); }
  console.log(`\nwill create   transaction ${newIndex} at ${txPda.toBase58()}`);
  console.log(`              proposal ${proposalPda.toBase58()}  (Active, 0 approvals; threshold ${ms.threshold})`);
  console.log(`              simulated ok, ${sim.value.unitsConsumed} CU`);
  console.log(`\nBPFLoaderUpgradeable::Upgrade`);
  console.log(`  programData  ${programData.toBase58()}`);
  console.log(`  program      ${programId.toBase58()}`);
  console.log(`  buffer       ${bufferId.toBase58()}`);
  console.log(`  spill        ${spill.toBase58()}`);
  console.log(`  authority    ${vault.toBase58()}`);

  if (!send) { console.log("\nDRY RUN. Nothing sent. Re-run with --send to create the proposal."); return; }

  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
  console.log(`\nsent ${sig}`);
  const conf = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "finalized");
  if (conf.value.err) { console.error("transaction failed:", JSON.stringify(conf.value.err)); process.exit(1); }
  console.log("finalized");

  // 7. Independent read-back by the decoder (separate parser, no shared code).
  const decoder = fileURLToPath(new URL("./decode-squads-proposal.mjs", import.meta.url));
  const cwd = fileURLToPath(new URL("../../tests/solana/", import.meta.url));
  console.log(`\n==> decoding ${txPda.toBase58()} back from chain`);
  const r = spawnSync(process.execPath, [decoder, txPda.toBase58(),
    "--program", programId.toBase58(), "--buffer", bufferId.toBase58(), "--spill", spill.toBase58(), "--authority", vault.toBase58()],
    { cwd, env: { ...process.env, SOLANA_RPC_URL: rpc }, encoding: "utf8" });
  process.stdout.write(r.stdout || ""); process.stderr.write(r.stderr || "");
  if (r.status !== 0) { console.error("\nthe decoder did not confirm the proposal -- do not approve it"); process.exit(1); }
  console.log(`\nProposal ${newIndex} is on chain and decoded. Approvals (${ms.threshold} of ${ms.members.length}) happen in the Squads app; nothing here approved anything.`);
}
main().catch((e) => { console.error(String(e.stack || e.message || e)); process.exit(2); });
