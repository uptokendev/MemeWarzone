#!/usr/bin/env node
/**
 * Post-upgrade initialization of the arena PDAs on mwz_rewards_treasury.
 *
 * The reward side (rewards_config, route_state, six vaults) already exists on
 * mainnet; the upgrade adds the arena instruction set but creates no accounts.
 * This creates the three arena configs, all born PAUSED, signed by the
 * treasury authority (the deployer key). Idempotent: existing PDAs are left
 * alone. Dry-run by default; pass --execute to send. Every transaction is
 * simulated before it is sent.
 *
 *   SOLANA_RPC_URL=<rpc> \
 *   SOLANA_TREASURY_AUTHORITY_KEYPAIR=~/mwz-deployer.json \
 *   ARENA_RESOLVER=<pubkey> ARENA_PROTOCOL_RECEIVER=<pubkey> ARENA_MWL_RECEIVER=<pubkey> \
 *   ARENA_MARKETING_RECEIVER=<pubkey> POSTGRAD_MONTHLY_RECEIVER=<pubkey> POSTGRAD_QUARTERLY_RECEIVER=<pubkey> \
 *   node scripts/solana/init-arena-mainnet.mjs [--execute]
 *
 * Defaults (only when the env is unset): resolver = authority; protocol
 * receiver = protocol_vault PDA; MWL / monthly receiver = monthly_league_vault
 * PDA; marketing receiver = route_state.overflow_treasury; quarterly receiver
 * = monthly_league_vault PDA. Change them with set_arena_receivers /
 * set_arena_money_v2_receivers later; nothing here is final.
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

const PROGRAM_ID = new PublicKey(process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID || "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX");
const execute = process.argv.includes("--execute");

function expand(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function loadKeypair(file) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(expand(file), "utf8"))));
}

const pda = (seed) => PublicKey.findProgramAddressSync([Buffer.from(seed, "utf8")], PROGRAM_ID)[0];

async function main() {
  const rpc = String(process.env.SOLANA_RPC_URL || "").trim();
  if (!rpc) throw new Error("SOLANA_RPC_URL is required");
  const authority = loadKeypair(process.env.SOLANA_TREASURY_AUTHORITY_KEYPAIR || "~/mwz-deployer.json");
  const connection = new Connection(rpc, "confirmed");
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
  const postgradTreasury = pda("postgrad_league_v2");

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
  const monthlyReceiver = pk("POSTGRAD_MONTHLY_RECEIVER", monthlyLeagueVault);
  const quarterlyReceiver = pk("POSTGRAD_QUARTERLY_RECEIVER", monthlyLeagueVault);

  console.log(`[init-arena] program=${PROGRAM_ID.toBase58()} authority=${authority.publicKey.toBase58()} mode=${execute ? "EXECUTE" : "dry-run"}`);
  console.log(`[init-arena] resolver=${resolver.toBase58()}`);
  console.log(`[init-arena] protocol=${protocolReceiver.toBase58()} mwl=${mwlReceiver.toBase58()} marketing=${marketingReceiver.toBase58()}`);
  console.log(`[init-arena] postgrad monthly=${monthlyReceiver.toBase58()} quarterly=${quarterlyReceiver.toBase58()}`);

  const steps = [
    {
      name: "initialize_arena (war pool v1; paused by the last step)",
      pda: arenaConfig,
      build: () => program.methods.initializeArena(resolver, protocolReceiver, mwlReceiver)
        .accountsStrict({ authority: authority.publicKey, rewardsConfig, arenaConfig, systemProgram: SystemProgram.programId }),
    },
    {
      name: "initialize_arena_money_v2 (competition/boost/sponsorship, born paused)",
      pda: arenaMoneyConfig,
      build: () => program.methods.initializeArenaMoneyV2(resolver, protocolReceiver, marketingReceiver)
        .accountsStrict({ authority: authority.publicKey, config: arenaMoneyConfig, systemProgram: SystemProgram.programId }),
    },
    {
      // Its `config` is the ArenaMoneyConfigV2, not RewardsConfig -- caught on
      // a local validator as AccountDiscriminatorMismatch before it could
      // fail on mainnet.
      name: "initialize_postgrad_league_treasury_v2",
      pda: postgradTreasury,
      after: arenaMoneyConfig,
      build: () => program.methods.initializePostgradLeagueTreasuryV2(monthlyReceiver, quarterlyReceiver)
        .accountsStrict({ authority: authority.publicKey, config: arenaMoneyConfig, treasury: postgradTreasury, systemProgram: SystemProgram.programId }),
    },
  ];

  for (const step of steps) {
    const existing = await connection.getAccountInfo(step.pda, "confirmed");
    if (existing) {
      console.log(`[init-arena] skip ${step.name}: ${step.pda.toBase58()} exists (${existing.data.length} bytes)`);
      continue;
    }
    if (step.after && !execute && !(await connection.getAccountInfo(step.after, "confirmed"))) {
      console.log(`[init-arena] ${step.name}: simulated after its prerequisite exists (dry-run cannot chain); will run in --execute`);
      continue;
    }
    const tx = await step.build().transaction();
    tx.feePayer = authority.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    tx.sign(authority);
    const sim = await connection.simulateTransaction(tx);
    if (sim.value.err) {
      throw new Error(`${step.name} simulation failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs || []).slice(-8).join("\n")}`);
    }
    console.log(`[init-arena] ${step.name}: simulation ok (${sim.value.unitsConsumed} CU) -> ${step.pda.toBase58()}`);
    if (!execute) continue;
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    const latest = await connection.getLatestBlockhash("confirmed");
    const conf = await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
    if (conf.value.err) throw new Error(`${step.name} failed on-chain: ${JSON.stringify(conf.value.err)}`);
    console.log(`[init-arena] ${step.name}: sent ${sig}`);
  }
  // initialize_arena (war pool v1) starts with deposits_paused = false; the
  // money-v2 config starts paused. Both must stay off until the canary, so
  // pause v1 explicitly. Idempotent: skipped when already paused.
  const arenaInfo = await connection.getAccountInfo(arenaConfig, "confirmed");
  if (arenaInfo) {
    const state = await program.account.arenaConfig.fetch(arenaConfig);
    if (state.depositsPaused) {
      console.log("[init-arena] skip set_arena_pause: war pool v1 already paused");
    } else {
      const tx = await program.methods.setArenaPause(true)
        .accountsStrict({ authority: authority.publicKey, rewardsConfig, arenaConfig })
        .transaction();
      tx.feePayer = authority.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      tx.sign(authority);
      const sim = await connection.simulateTransaction(tx);
      if (sim.value.err) throw new Error(`set_arena_pause simulation failed: ${JSON.stringify(sim.value.err)}`);
      console.log(`[init-arena] set_arena_pause(true): simulation ok (${sim.value.unitsConsumed} CU)`);
      if (execute) {
        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
        const latest = await connection.getLatestBlockhash("confirmed");
        const conf = await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
        if (conf.value.err) throw new Error(`set_arena_pause failed on-chain: ${JSON.stringify(conf.value.err)}`);
        console.log(`[init-arena] set_arena_pause(true): sent ${sig}`);
      }
    }
  }

  console.log(execute ? "[init-arena] done" : "[init-arena] dry-run complete; re-run with --execute to send");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
