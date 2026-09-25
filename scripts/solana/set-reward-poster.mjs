#!/usr/bin/env node
/**
 * Creates (or changes / revokes) the treasury's reward poster: the narrow key our Coolify weekly
 * airdrop job signs with. Needs the reward-poster treasury upgrade (e996ba88...) on chain first.
 *
 *   SOLANA_RPC_URL=<mainnet rpc> REWARD_POSTER_PUBKEY=<poster pubkey> \
 *     node scripts/solana/set-reward-poster.mjs --airdrop-cap-sol 400 --league-cap-sol 400   # dry run
 *   ... --airdrop-cap-sol 800 --execute     # raise one cap later; the other keeps its on-chain value
 *   ... SOLANA_TREASURY_AUTHORITY_KEYPAIR=<deployer.json> ... --execute      # sends
 *   ... --revoke --execute                                                   # sets the poster to the default pubkey
 *
 * Caps: the most one weekly airdrop batch / one league epoch root may pay. They never shrink a payout:
 * the jobs block and alert instead, and a raised cap lets them post the stored list unchanged. A
 * leaked poster key can misdirect at most one capped root per period rhythm until revoked.
 * The signer must be rewards_config.authority. Mainnet-beta only.
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
const { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } = require(path.join(root, "tests/solana/node_modules/@solana/web3.js"));
const { SOLANA_GENESIS } = await import(path.join(root, "frontend/src/lib/solanaArenaLayout.mjs"));

const PROGRAM_ID = new PublicKey(process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID || "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX");
const argv = process.argv.slice(2);
const execute = argv.includes("--execute");
const revoke = argv.includes("--revoke");
const flagNumber = (name) => { const i = argv.indexOf(name); return i >= 0 ? Number(argv[i + 1]) : null; };
const airdropCapSol = flagNumber("--airdrop-cap-sol");
const leagueCapSol = flagNumber("--league-cap-sol");
const pda = (seed) => PublicKey.findProgramAddressSync([Buffer.from(seed, "utf8")], PROGRAM_ID)[0];
const expand = (p) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

async function main() {
  const rpc = String(process.env.SOLANA_RPC_URL || "").trim();
  if (!rpc) throw new Error("SOLANA_RPC_URL is required");
  const connection = new Connection(rpc, "confirmed");
  const genesis = await connection.getGenesisHash();
  if (genesis !== SOLANA_GENESIS["mainnet-beta"] && process.env.MWZ_LOCAL_CLUSTER_REHEARSAL !== "1") {
    throw new Error(`refusing to run: ${rpc} reports genesis ${genesis}, not mainnet-beta`);
  }

  let authority;
  try {
    authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(expand(process.env.SOLANA_TREASURY_AUTHORITY_KEYPAIR || "~/mwz-deployer.json"), "utf8"))));
  } catch (error) {
    if (execute) throw error;
    authority = Keypair.generate();
  }
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(authority), { commitment: "confirmed" });
  const program = new anchor.Program(JSON.parse(fs.readFileSync(path.join(root, "target/idl/mwz_rewards_treasury.json"), "utf8")), provider);
  if (!program.methods.initializeRewardPoster) throw new Error("target/idl lacks the reward-poster instructions; build the e996ba88 candidate first");

  const config = pda("rewards_config");
  const rewardPoster = pda("reward_poster");
  const cfg = await program.account.rewardsConfig.fetch(config);
  if (execute && !cfg.authority.equals(authority.publicKey)) throw new Error(`signer ${authority.publicKey.toBase58()} is not rewards_config.authority ${cfg.authority.toBase58()}`);

  const existing = await connection.getAccountInfo(rewardPoster, "confirmed");
  const current = existing ? await program.account.rewardPoster.fetch(rewardPoster) : null;
  const poster = revoke ? PublicKey.default : new PublicKey(String(process.env.REWARD_POSTER_PUBKEY || "").trim() || current?.poster?.toBase58() || "");
  const lamportsOr = (sol, fallback) => (sol != null ? BigInt(Math.round(sol * 1e9)) : BigInt(fallback?.toString() || "0"));
  const airdropCap = lamportsOr(airdropCapSol, current?.maxAirdropBatchLamports);
  const leagueCap = lamportsOr(leagueCapSol, current?.maxLeagueRootLamports);
  if (!revoke && poster.equals(PublicKey.default)) throw new Error("REWARD_POSTER_PUBKEY is required");
  if (!revoke && (airdropCap <= 0n || leagueCap <= 0n)) throw new Error("--airdrop-cap-sol and --league-cap-sol are required on first setup");
  if (!revoke && poster.equals(cfg.authority)) throw new Error("the poster must not be the rewards authority -- that is the point of the role");

  console.log(`[reward-poster] cluster ${genesis === SOLANA_GENESIS["mainnet-beta"] ? "mainnet-beta" : "local rehearsal"}`);
  console.log(`[reward-poster] current: ${current ? `${current.poster.toBase58()} airdrop cap ${Number(current.maxAirdropBatchLamports) / 1e9} SOL, league cap ${Number(current.maxLeagueRootLamports) / 1e9} SOL` : "not initialized"}`);
  console.log(`[reward-poster] target:  ${revoke ? "REVOKED (default pubkey)" : poster.toBase58()} airdrop cap ${Number(airdropCap) / 1e9} SOL, league cap ${Number(leagueCap) / 1e9} SOL`);

  const signer = execute ? authority.publicKey : cfg.authority;
  const airdrop = new anchor.BN(airdropCap.toString());
  const league = new anchor.BN(leagueCap.toString());
  const method = existing
    ? program.methods.setRewardPoster(poster, airdrop, league).accountsStrict({ authority: signer, config, rewardPoster })
    : program.methods.initializeRewardPoster(poster, airdrop, league).accountsStrict({ authority: signer, config, rewardPoster, systemProgram: SystemProgram.programId });

  if (!execute) {
    const ix = await method.instruction();
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signer, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message());
    const sim = await connection.simulateTransaction(tx, { sigVerify: false });
    if (sim.value.err) console.log(`[reward-poster] simulation FAILED: ${JSON.stringify(sim.value.err)} (has the reward-poster upgrade executed?)\n${(sim.value.logs || []).slice(-5).join("\n")}`);
    else console.log(`[reward-poster] simulation ok as ${signer.toBase58()}. Re-run with --execute to send.`);
    return;
  }
  const signature = await method.rpc();
  const after = await program.account.rewardPoster.fetch(rewardPoster);
  console.log(`[reward-poster] sent ${signature}`);
  console.log(`[reward-poster] read back: poster ${after.poster.toBase58()}, airdrop cap ${Number(after.maxAirdropBatchLamports) / 1e9} SOL, league cap ${Number(after.maxLeagueRootLamports) / 1e9} SOL`);
}

main().catch((error) => {
  console.error(`[reward-poster] ${error?.message || error}`);
  process.exit(1);
});
