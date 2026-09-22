#!/usr/bin/env node
/**
 * Devnet initialization of the arena PDAs on mwz_rewards_treasury.
 *
 * This is the devnet sibling of init-arena-mainnet.mjs. It exists as its own
 * script rather than a --cluster flag because the two runs differ in the three
 * places that matter, and every one of them is a way to lose money on mainnet:
 *
 *   1. It refuses to run anywhere but devnet. The cluster is decided by the
 *      genesis hash the RPC reports, not by the URL, not by an env var, and not
 *      by a flag. A mainnet RPC behind a devnet-looking hostname is rejected.
 *   2. It leaves war pool v1 UNPAUSED. The mainnet script pauses v1 as its last
 *      step and has no unpause; devnet needs the opposite so battles can run.
 *   3. It never touches route_state. The mainnet script defaults
 *      ROUTE_OVERFLOW_TREASURY to the mainnet multisig, so running it against
 *      devnet would point devnet's overflow at a mainnet address. Route params
 *      are out of scope here; change them deliberately with their own tooling.
 *
 * Idempotent: existing PDAs are left alone, an already-unpaused arena is left
 * alone. Dry-run by default; every transaction is simulated, and nothing is
 * sent without --execute.
 *
 *   SOLANA_RPC_URL=https://api.devnet.solana.com \
 *   SOLANA_TREASURY_AUTHORITY_KEYPAIR=~/.config/memewarzone/solana-devnet/deployer.json \
 *   ARENA_RESOLVER=<pubkey> \
 *   node scripts/solana/init-arena-devnet.mjs [--execute]
 *
 * Defaults (only when the env is unset): resolver = authority; protocol
 * receiver = protocol_vault PDA; MWL receiver = monthly_league_vault PDA;
 * marketing receiver = route_state.overflow_treasury as it already is on
 * devnet. Receivers are changed later with set_arena_receivers /
 * set_arena_money_v2_receivers; nothing here is final.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const anchor = require(path.join(root, "tests/solana/node_modules/@coral-xyz/anchor"));
const { Connection, Keypair, PublicKey, SystemProgram } = require(path.join(root, "tests/solana/node_modules/@solana/web3.js"));
const { SOLANA_GENESIS } = await import(path.join(root, "frontend/src/lib/solanaArenaLayout.mjs"));

const PROGRAM_ID = new PublicKey(process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID || "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX");
const execute = process.argv.includes("--execute");

function expand(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function loadKeypair(file) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(expand(file), "utf8"))));
}

const pda = (seed) => PublicKey.findProgramAddressSync([Buffer.from(seed, "utf8")], PROGRAM_ID)[0];

async function sendStep({ connection, name, tx, authority }) {
  tx.feePayer = authority.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(authority);
  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) {
    throw new Error(`${name} simulation failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs || []).slice(-8).join("\n")}`);
  }
  console.log(`[init-arena-devnet] ${name}: simulation ok (${sim.value.unitsConsumed} CU)`);
  if (!execute) return null;
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const latest = await connection.getLatestBlockhash("confirmed");
  const conf = await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
  if (conf.value.err) throw new Error(`${name} failed on-chain: ${JSON.stringify(conf.value.err)}`);
  console.log(`[init-arena-devnet] ${name}: sent ${sig}`);
  return sig;
}

async function main() {
  const rpc = String(process.env.SOLANA_RPC_URL || "").trim();
  if (!rpc) throw new Error("SOLANA_RPC_URL is required");
  const connection = new Connection(rpc, "confirmed");

  // Guard first, before a key is read or a transaction is built: the chain
  // itself says which cluster this is.
  const genesis = await connection.getGenesisHash();
  if (genesis !== SOLANA_GENESIS.devnet) {
    const known = genesis === SOLANA_GENESIS["mainnet-beta"] ? " (this is MAINNET-BETA)" : "";
    throw new Error(
      `refusing to run: ${rpc} reports genesis ${genesis}${known}, not devnet ${SOLANA_GENESIS.devnet}. ` +
      `This script only ever runs on devnet.`,
    );
  }
  console.log(`[init-arena-devnet] cluster verified devnet by genesis ${genesis}`);

  const keypairPath = process.env.SOLANA_TREASURY_AUTHORITY_KEYPAIR || "~/.config/memewarzone/solana-devnet/deployer.json";
  const authority = loadKeypair(keypairPath);
  const wallet = new anchor.Wallet(authority);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(path.join(root, "target/idl/mwz_rewards_treasury.json"), "utf8"));
  const program = new anchor.Program(idl, provider);

  const rewardsConfig = pda("rewards_config");
  const routeState = pda("route_state");
  const protocolVault = pda("protocol_vault");
  const monthlyLeagueVault = pda("monthly_league_vault");
  const arenaConfig = pda("arena_config");
  const arenaMoneyConfig = pda("arena_money_config_v2");

  const config = await program.account.rewardsConfig.fetch(rewardsConfig);
  if (!config.authority.equals(authority.publicKey)) {
    throw new Error(`rewards_config authority is ${config.authority.toBase58()}, not the provided key ${authority.publicKey.toBase58()}`);
  }
  const route = await program.account.routeState.fetch(routeState);

  const pk = (name, fallback) => new PublicKey(String(process.env[name] || "").trim() || fallback.toBase58());
  const resolver = pk("ARENA_RESOLVER", authority.publicKey);
  const protocolReceiver = pk("ARENA_PROTOCOL_RECEIVER", protocolVault);
  const mwlReceiver = pk("ARENA_MWL_RECEIVER", monthlyLeagueVault);
  const marketingReceiver = pk("ARENA_MARKETING_RECEIVER", route.overflowTreasury);

  console.log(`[init-arena-devnet] program=${PROGRAM_ID.toBase58()} mode=${execute ? "EXECUTE" : "dry-run"}`);
  console.log(`[init-arena-devnet] SIGNER ${authority.publicKey.toBase58()} from ${expand(keypairPath)}`);
  console.log(`[init-arena-devnet] resolver=${resolver.toBase58()}`);
  console.log(`[init-arena-devnet] protocol=${protocolReceiver.toBase58()} mwl=${mwlReceiver.toBase58()} marketing=${marketingReceiver.toBase58()}`);
  console.log(`[init-arena-devnet] arena_config=${arenaConfig.toBase58()} arena_money_config_v2=${arenaMoneyConfig.toBase58()}`);
  console.log(`[init-arena-devnet] route_state untouched (overflow stays ${route.overflowTreasury.toBase58()})`);

  const steps = [
    {
      name: "initialize_arena (war pool v1)",
      pda: arenaConfig,
      build: () => program.methods.initializeArena(resolver, protocolReceiver, mwlReceiver)
        .accountsStrict({ authority: authority.publicKey, rewardsConfig, arenaConfig, systemProgram: SystemProgram.programId }),
    },
    {
      name: "initialize_arena_money_v2 (sponsorship config, born paused)",
      pda: arenaMoneyConfig,
      build: () => program.methods.initializeArenaMoneyV2(resolver, protocolReceiver, marketingReceiver)
        .accountsStrict({ authority: authority.publicKey, config: arenaMoneyConfig, systemProgram: SystemProgram.programId }),
    },
  ];

  let arenaConfigPending = false;
  for (const step of steps) {
    const existing = await connection.getAccountInfo(step.pda, "confirmed");
    if (existing) {
      console.log(`[init-arena-devnet] skip ${step.name}: ${step.pda.toBase58()} exists (${existing.data.length} bytes)`);
      continue;
    }
    await sendStep({ connection, name: step.name, tx: await step.build().transaction(), authority });
    if (step.pda.equals(arenaConfig) && !execute) arenaConfigPending = true;
  }

  // initialize_arena creates the config with deposits_paused = false, so a
  // fresh devnet arena is already open and needs no unpause. This only matters
  // when the config already existed in a paused state.
  const arenaInfo = await connection.getAccountInfo(arenaConfig, "confirmed");
  if (!arenaInfo) {
    console.log(
      arenaConfigPending
        ? "[init-arena-devnet] unpause check deferred: initialize_arena is born unpaused, so --execute needs no further step"
        : "[init-arena-devnet] arena_config missing and not created",
    );
  } else {
    const state = await program.account.arenaConfig.fetch(arenaConfig);
    if (!state.depositsPaused) {
      console.log("[init-arena-devnet] skip set_arena_pause(false): war pool v1 already accepting deposits");
    } else {
      await sendStep({
        connection,
        name: "set_arena_pause(false) (unpause war pool v1)",
        tx: await program.methods.setArenaPause(false)
          .accountsStrict({ authority: authority.publicKey, rewardsConfig, arenaConfig })
          .transaction(),
        authority,
      });
    }
  }

  console.log(execute ? "[init-arena-devnet] done" : "[init-arena-devnet] dry-run complete; re-run with --execute to send");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
