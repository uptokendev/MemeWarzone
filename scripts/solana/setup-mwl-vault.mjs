#!/usr/bin/env node
/**
 * After the treasury upgrade (candidate 1840a9e7+): create the Major War League vault and point the
 * arena's MWL share at it, so battle/tournament MWL money no longer lands in the pre-grad monthly
 * league vault. Rehearsed on cloned mainnet state by rehearse-mainnet-treasury-upgrade.sh.
 *
 *   SOLANA_RPC_URL=<mainnet rpc> node scripts/solana/setup-mwl-vault.mjs              # dry run (simulates)
 *   SOLANA_RPC_URL=<mainnet rpc> SOLANA_TREASURY_AUTHORITY_KEYPAIR=<deployer.json> \
 *     node scripts/solana/setup-mwl-vault.mjs --execute                               # sends
 *
 * initialize_mwl_vault is skipped when the vault exists; set_arena_receivers keeps the protocol
 * receiver exactly as it is on chain and changes only the MWL receiver. Mainnet-beta only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const anchor = require(path.join(root, "tests/solana/node_modules/@coral-xyz/anchor"));
const { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } = require(path.join(root, "tests/solana/node_modules/@solana/web3.js"));
const { SOLANA_GENESIS } = await import(path.join(root, "frontend/src/lib/solanaArenaLayout.mjs"));

const PROGRAM_ID = new PublicKey("2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX");
const execute = process.argv.includes("--execute");
const pda = (seed) => PublicKey.findProgramAddressSync([Buffer.from(seed)], PROGRAM_ID)[0];
const expand = (p) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

async function main() {
  const rpc = String(process.env.SOLANA_RPC_URL || "").trim();
  if (!rpc) throw new Error("SOLANA_RPC_URL is required");
  const connection = new Connection(rpc, "confirmed");
  const genesis = await connection.getGenesisHash();
  if (genesis !== SOLANA_GENESIS["mainnet-beta"] && process.env.MWZ_LOCAL_CLUSTER_REHEARSAL !== "1") throw new Error(`refusing: ${rpc} is genesis ${genesis}, not mainnet-beta`);

  let authority;
  try {
    authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(expand(process.env.SOLANA_TREASURY_AUTHORITY_KEYPAIR || "~/.config/memewarzone/solana-mainnet-deployer.json"), "utf8"))));
  } catch (error) {
    if (execute) throw error;
    authority = Keypair.generate();
  }
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(authority), { commitment: "confirmed" });
  const program = new anchor.Program(JSON.parse(fs.readFileSync(path.join(root, "target/idl/mwz_rewards_treasury.json"), "utf8")), provider);
  if (!program.methods.initializeMwlVault) throw new Error("target/idl lacks initialize_mwl_vault; build the 1840a9e7 candidate first");

  const config = pda("rewards_config");
  const arenaConfig = pda("arena_config");
  const mwlVault = pda("mwl_vault");
  const cfg = await program.account.rewardsConfig.fetch(config);
  if (execute && !cfg.authority.equals(authority.publicKey)) throw new Error(`signer ${authority.publicKey.toBase58()} is not rewards_config.authority ${cfg.authority.toBase58()}`);
  const signer = execute ? authority.publicKey : cfg.authority;
  const arena = await program.account.arenaConfig.fetch(arenaConfig);
  const vaultExists = Boolean(await connection.getAccountInfo(mwlVault, "confirmed"));

  console.log(`[mwl] mwl_vault ${mwlVault.toBase58()} ${vaultExists ? "exists" : "missing -> initialize_mwl_vault"}`);
  console.log(`[mwl] arena protocol receiver ${arena.protocolReceiver.toBase58()} (kept)`);
  console.log(`[mwl] arena MWL receiver ${arena.mwlReceiver.toBase58()} -> ${mwlVault.toBase58()}`);

  const ixs = [];
  if (!vaultExists) ixs.push(await program.methods.initializeMwlVault().accountsPartial({ authority: signer, config, mwlVault, systemProgram: SystemProgram.programId }).instruction());
  if (!arena.mwlReceiver.equals(mwlVault)) ixs.push(await program.methods.setArenaReceivers(arena.protocolReceiver, mwlVault).accountsPartial({ authority: signer, rewardsConfig: config, arenaConfig }).instruction());
  if (!ixs.length) return console.log("[mwl] nothing to do: vault exists and the arena already pays MWL into it");

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  if (!execute) {
    const sim = await connection.simulateTransaction(tx, { sigVerify: false });
    console.log(sim.value.err ? `[mwl] simulation FAILED: ${JSON.stringify(sim.value.err)} (has the treasury upgrade executed?)\n${(sim.value.logs || []).slice(-5).join("\n")}` : `[mwl] simulation ok as ${signer.toBase58()}. Re-run with --execute to send.`);
    return;
  }
  tx.sign([authority]);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  const after = await program.account.arenaConfig.fetch(arenaConfig);
  console.log(`[mwl] sent ${sig}`);
  console.log(`[mwl] read back: mwl_vault ${Boolean(await connection.getAccountInfo(mwlVault, "confirmed")) ? "exists" : "MISSING"}, arena MWL receiver ${after.mwlReceiver.toBase58()}, protocol ${after.protocolReceiver.toBase58()}`);
}

main().catch((error) => { console.error(`[mwl] ${error?.message || error}`); process.exit(1); });
