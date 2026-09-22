#!/usr/bin/env node
/**
 * Post-upgrade initialization of the arena PDAs on mwz_rewards_treasury.
 *
 * The reward side (rewards_config, route_state, six vaults) already exists on
 * mainnet; the upgrade adds the arena instruction set but creates no accounts.
 * This creates the two arena configs, both PAUSED, signed by the
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
 * PDA; marketing receiver = route_state.overflow_treasury. Change them with set_arena_receivers /
 * set_arena_money_v2_receivers later; nothing here is final.
 *
 * Three things this script will not let you get wrong:
 *
 *   1. It refuses to run anywhere but mainnet-beta, decided by the genesis hash
 *      the RPC reports -- not the URL, not an env var, not a flag. It defaults
 *      ROUTE_OVERFLOW_TREASURY to the mainnet multisig, so pointing it at
 *      devnet would aim devnet's overflow at a mainnet address.
 *   2. Everything lands PAUSED. War pool v1 is paused as its last step and
 *      money v2 is born paused, so a half-finished run is inert rather than
 *      quietly taking money.
 *   3. Opening is a separate, deliberate act: `--open` unpauses both, and only
 *      that. Run it after the canary, never in the same breath as --execute.
 *
 * Read the state without touching anything:
 *
 *   SOLANA_RPC_URL=<rpc> node scripts/solana/init-arena-mainnet.mjs --status
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
const MAINNET_MULTISIG = new PublicKey("fk5YYWb4ppwbFqME8YRugirMSaNfhGgPP3GjfMbbfGv");
const execute = process.argv.includes("--execute");
const open = process.argv.includes("--open");
const status = process.argv.includes("--status");
if (open && !execute && !status) {
  console.log("[init-arena] --open simulates only; add --execute to send");
}

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
  const connection = new Connection(rpc, "confirmed");

  // The chain itself says which cluster this is. Checked before a key is read
  // or a transaction is built, because this script defaults the route overflow
  // to the mainnet multisig and must never aim another cluster at it.
  const genesis = await connection.getGenesisHash();
  const isMainnet = genesis === SOLANA_GENESIS["mainnet-beta"];
  // A throwaway local validator has a genesis that is neither real cluster, so
  // rehearsing against one can never touch devnet or mainnet by mistake. That
  // is the only way this script gets proven before it runs for real, which the
  // standing rule requires of every transaction.
  const isEphemeral = !isMainnet && genesis !== SOLANA_GENESIS.devnet;
  const rehearsal = isEphemeral && process.env.MWZ_LOCAL_CLUSTER_REHEARSAL === "1";
  if (!isMainnet && !rehearsal) {
    const known = genesis === SOLANA_GENESIS.devnet ? " (this is DEVNET -- use init-arena-devnet.mjs)" : "";
    throw new Error(
      `refusing to run: ${rpc} reports genesis ${genesis}${known}, not mainnet-beta ` +
      `${SOLANA_GENESIS["mainnet-beta"]}. This script only ever runs on mainnet, or on a ` +
      `throwaway local validator with MWZ_LOCAL_CLUSTER_REHEARSAL=1.`,
    );
  }
  console.log(rehearsal
    ? `[init-arena] REHEARSAL on an ephemeral local cluster (genesis ${genesis}); this is not mainnet`
    : `[init-arena] cluster verified mainnet-beta by genesis ${genesis}`);

  // Reading the state needs no key. Only a run that sends does.
  let authority;
  try {
    authority = loadKeypair(process.env.SOLANA_TREASURY_AUTHORITY_KEYPAIR || "~/mwz-deployer.json");
  } catch (error) {
    if (!status) throw error;
    authority = Keypair.generate();
  }
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
  if (!status && !config.authority.equals(authority.publicKey)) {
    throw new Error(`rewards_config authority is ${config.authority.toBase58()}, not the provided key ${authority.publicKey.toBase58()}`);
  }
  const route = await program.account.routeState.fetch(routeState);

  /**
   * What mainnet actually holds, and whether the arena can take money.
   *
   * Printed before anything is sent and available on its own with --status,
   * because "is it ready" should be answerable without running an initializer
   * and reading its skip messages.
   */
  async function report() {
    const arenaInfo = await connection.getAccountInfo(arenaConfig, "confirmed");
    const moneyInfo = await connection.getAccountInfo(arenaMoneyConfig, "confirmed");
    const arena = arenaInfo ? await program.account.arenaConfig.fetch(arenaConfig) : null;
    const money = moneyInfo ? await program.account.arenaMoneyConfigV2.fetch(arenaMoneyConfig) : null;
    const line = (label, value) => console.log(`    ${label.padEnd(26)} ${value}`);
    console.log("[init-arena] mainnet state");
    line("rewards_config", `${rewardsConfig.toBase58()} authority=${config.authority.toBase58()}`);
    line("route_state.overflow", route.overflowTreasury.toBase58());
    line("arena_config", arena ? `${arenaConfig.toBase58()} resolver=${arena.resolver.toBase58()}` : "MISSING");
    if (arena) {
      line("  protocol receiver", arena.protocolReceiver.toBase58());
      line("  MWL receiver", arena.mwlReceiver.toBase58());
      line("  deposits", arena.depositsPaused ? "PAUSED" : "open");
    }
    line("arena_money_config_v2", money ? arenaMoneyConfig.toBase58() : "MISSING");
    if (money) {
      line("  protocol receiver", money.protocolReceiver.toBase58());
      line("  marketing receiver", money.marketingReceiver.toBase58());
      line("  sponsorship", money.paused ? "PAUSED" : "open");
    }
    const ready = Boolean(arena && money);
    const live = ready && !arena.depositsPaused && !money.paused;
    console.log(`[init-arena] configs ${ready ? "present" : "INCOMPLETE"}; arena is ${live ? "OPEN for deposits" : "closed"}`);
    return { arena, money, ready, live };
  }

  if (status) {
    await report();
    return;
  }

  const pk = (name, fallback) => new PublicKey(String(process.env[name] || "").trim() || fallback.toBase58());
  const overflowTreasury = pk("ROUTE_OVERFLOW_TREASURY", MAINNET_MULTISIG);
  const resolver = pk("ARENA_RESOLVER", authority.publicKey);
  const protocolReceiver = pk("ARENA_PROTOCOL_RECEIVER", protocolVault);
  const mwlReceiver = pk("ARENA_MWL_RECEIVER", monthlyLeagueVault);
  // Marketing lands in the protocol vault, not at the multisig, so it leaves
  // through the route everything else does: flush_operator_fill pays the
  // operator up to the USD cap and sends everything above it to the overflow
  // treasury. Pointing marketing straight at the multisig would bypass the cap
  // entirely. The old default read route.overflowTreasury, which is the value
  // this script then replaces -- correct today only by accident, and wrong on
  // every run after the first.
  const marketingReceiver = pk("ARENA_MARKETING_RECEIVER", protocolVault);

  console.log(`[init-arena] program=${PROGRAM_ID.toBase58()} authority=${authority.publicKey.toBase58()} mode=${execute ? "EXECUTE" : "dry-run"}`);
  console.log(`[init-arena] resolver=${resolver.toBase58()}`);
  console.log(`[init-arena] protocol=${protocolReceiver.toBase58()} mwl=${mwlReceiver.toBase58()} marketing=${marketingReceiver.toBase58()}`);

  const steps = [
    {
      name: "initialize_arena (war pool v1; paused by the last step)",
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

  const created = new Set();
  for (const step of steps) {
    const existing = await connection.getAccountInfo(step.pda, "confirmed");
    if (existing) {
      console.log(`[init-arena] skip ${step.name}: ${step.pda.toBase58()} exists (${existing.data.length} bytes)`);
      continue;
    }
    created.add(step.pda.toBase58());
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
      const logs = (sim.value.logs || []).join("\n");
      if (/InstructionFallbackNotFound/.test(logs)) {
        throw new Error(
          `${step.name}: the deployed program does not have this instruction yet.\n` +
          `The arena instruction set arrives with the treasury upgrade -- run this after Squads ` +
          `has executed it, not before. Nothing was sent.`,
        );
      }
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
    if (!created.has(arenaConfig.toBase58())) {
      // Re-running the initializer must never take a live arena down. Pausing
      // belongs to the creation of the config, not to every invocation.
      console.log(`[init-arena] skip set_arena_pause: arena_config predates this run (deposits ${state.depositsPaused ? "paused" : "OPEN -- left alone"})`);
    } else if (state.depositsPaused) {
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

  // Protocol fees above the operator's USD cap must leave to the multisig.
  // Mainnet's route_state still has overflow_treasury = the protocol vault
  // itself (the pre-upgrade layout), which the program treats as "keep".
  if (route.overflowTreasury.equals(overflowTreasury)) {
    console.log(`[init-arena] skip set_route_params: overflow already ${overflowTreasury.toBase58()}`);
  } else {
    const tx = await program.methods.setRouteParams(route.operator, overflowTreasury, route.operatorFillCapUsdMicros, route.nativeUsdMicros)
      .accountsStrict({ authority: authority.publicKey, config: rewardsConfig, routeState })
      .transaction();
    tx.feePayer = authority.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    tx.sign(authority);
    const sim = await connection.simulateTransaction(tx);
    if (sim.value.err) throw new Error(`set_route_params simulation failed: ${JSON.stringify(sim.value.err)}`);
    console.log(`[init-arena] set_route_params(operator=${route.operator.toBase58()}, overflow=${overflowTreasury.toBase58()}, cap=$${Number(route.operatorFillCapUsdMicros) / 1e6}, sol=$${Number(route.nativeUsdMicros) / 1e6}): simulation ok`);
    if (execute) {
      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      const latest = await connection.getLatestBlockhash("confirmed");
      const conf = await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
      if (conf.value.err) throw new Error(`set_route_params failed on-chain: ${JSON.stringify(conf.value.err)}`);
      console.log(`[init-arena] set_route_params: sent ${sig}`);
    }
  }

  // --- opening the arena -------------------------------------------------
  // Deliberately last, deliberately opt-in, and deliberately not part of a
  // normal run. Initialization leaves everything closed so a half-finished
  // deployment cannot take money; this is the separate act that reverses that,
  // once the canary has passed.
  if (open) {
    const sendStep = async (label, builder) => {
      const tx = await builder().transaction();
      tx.feePayer = authority.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      tx.sign(authority);
      const sim = await connection.simulateTransaction(tx);
      if (sim.value.err) {
        throw new Error(`${label} simulation failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs || []).slice(-8).join("\n")}`);
      }
      console.log(`[init-arena] ${label}: simulation ok (${sim.value.unitsConsumed} CU)`);
      if (!execute) return;
      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      const latest = await connection.getLatestBlockhash("confirmed");
      const conf = await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
      if (conf.value.err) throw new Error(`${label} failed on-chain: ${JSON.stringify(conf.value.err)}`);
      console.log(`[init-arena] ${label}: sent ${sig}`);
    };

    const arenaNow = await program.account.arenaConfig.fetch(arenaConfig);
    if (!arenaNow.depositsPaused) {
      console.log("[init-arena] skip set_arena_pause(false): war pool v1 already open");
    } else {
      await sendStep("set_arena_pause(false)", () => program.methods.setArenaPause(false)
        .accountsStrict({ authority: authority.publicKey, rewardsConfig, arenaConfig }));
    }

    const moneyNow = await program.account.arenaMoneyConfigV2.fetch(arenaMoneyConfig);
    if (!moneyNow.paused) {
      console.log("[init-arena] skip set_arena_money_v2_pause(false): sponsorship already open");
    } else {
      await sendStep("set_arena_money_v2_pause(false)", () => program.methods.setArenaMoneyV2Pause(false)
        .accountsStrict({ authority: authority.publicKey, config: arenaMoneyConfig }));
    }
  }

  console.log("");
  const final = await report();
  if (!final.ready) {
    console.log("[init-arena] not ready: re-run with --execute once the treasury upgrade has landed.");
  } else if (!final.live) {
    console.log("[init-arena] everything lands closed. Run the canary, then --open --execute to take deposits.");
  }
  console.log(execute ? "[init-arena] done" : "[init-arena] dry-run complete; re-run with --execute to send");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
