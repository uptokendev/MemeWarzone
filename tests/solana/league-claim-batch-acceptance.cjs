"use strict";

/**
 * Local-validator acceptance for claiming several league prizes with one wallet approval
 * (Command Center > Claims, 2026-10-08). One wallet wins three prizes in one weekly epoch. The three
 * claim transactions are built the way the app builds them (one claim_league instruction each, a v0
 * message paid by the winner), signed together as signAllTransactions does, then sent one by one.
 *
 * Asserts: every prize is paid exactly once from the league vault, the receipts exist, a repeat
 * claim is refused, and the API's on-chain check (frontend/api/lib/solanaLeagueClaimVerification.js,
 * which `record` now runs instead of asking for a signature) accepts each payout and refuses a
 * payout recorded against the wrong prize.
 *
 * Run:
 *   solana-test-validator --reset \
 *     --bpf-program 2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX target/deploy/mwz_rewards_treasury.so
 *   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=~/.config/solana/id.json \
 *     node tests/solana/league-claim-batch-acceptance.cjs
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const anchor = require("@coral-xyz/anchor");
const { keccak_256 } = require("@noble/hashes/sha3");
const { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } = require("@solana/web3.js");

const { AnchorProvider, BN, Program, setProvider } = anchor;

const TREASURY_PROGRAM = new PublicKey("2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX");
const PERIOD_WEEKLY = 0;
const LEAF_PREFIX = Buffer.from("MWZ_LEAGUE_LEAF", "utf8");

const keccak = (bytes) => Buffer.from(keccak_256(bytes));
const u64le = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const i64le = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; };
const arr32 = (buf) => Array.from(buf);
const pda = (seed, ...extra) => PublicKey.findProgramAddressSync([Buffer.from(seed, "utf8"), ...extra], TREASURY_PROGRAM)[0];

function leagueLeaf({ epochStart, period, categoryHash, rank, winner, amount }) {
  return keccak(Buffer.concat([LEAF_PREFIX, i64le(epochStart), Buffer.from([period]), categoryHash, Buffer.from([rank]), winner.toBuffer(), u64le(amount)]));
}
function hashPair(a, b) {
  const [left, right] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return keccak(Buffer.concat([left, right]));
}
// Same shape as rewards-claims-acceptance.cjs and the API: an odd node pairs with itself.
function buildRoot(leaves) {
  let layer = leaves.slice();
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) next.push(hashPair(layer[i], layer[i + 1] ?? layer[i]));
    layer = next;
  }
  return layer[0];
}
function buildProof(leaves, index) {
  const proof = [];
  let layer = leaves.slice();
  let at = index;
  while (layer.length > 1) {
    proof.push(layer[at ^ 1] ?? layer[at]);
    const next = [];
    for (let i = 0; i < layer.length; i += 2) next.push(hashPair(layer[i], layer[i + 1] ?? layer[i]));
    layer = next;
    at = Math.floor(at / 2);
  }
  return proof;
}

async function main() {
  const provider = AnchorProvider.env();
  setProvider(provider);
  const connection = provider.connection;
  const authority = provider.wallet.publicKey;
  const idl = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../target/idl/mwz_rewards_treasury.json"), "utf8"));
  const program = new Program(idl, provider);
  const pdas = {
    config: pda("rewards_config"),
    routeState: pda("route_state"),
    leagueVault: pda("league_vault"),
    airdropVault: pda("airdrop_vault"),
    monthlyLeagueVault: pda("monthly_league_vault"),
    recruiterVault: pda("recruiter_vault"),
    squadVault: pda("squad_vault"),
    protocolVault: pda("protocol_vault"),
  };

  // Same setup as rewards-claims-acceptance.cjs.
  if (!(await connection.getAccountInfo(pdas.config, "confirmed"))) {
    await program.methods.initialize()
      .accountsStrict({ authority, config: pdas.config, leagueVault: pdas.leagueVault, airdropVault: pdas.airdropVault, systemProgram: SystemProgram.programId })
      .rpc({ commitment: "confirmed" });
  }
  if (!(await connection.getAccountInfo(pdas.routeState, "confirmed"))) {
    await program.methods.initializeLanesV2Primary(authority, new BN(200_000_000))
      .accountsStrict({ authority, config: pdas.config, routeState: pdas.routeState, monthlyLeagueVault: pdas.monthlyLeagueVault, protocolVault: pdas.protocolVault, systemProgram: SystemProgram.programId })
      .rpc({ commitment: "confirmed" });
    await program.methods.initializeLanesV2Secondary()
      .accountsStrict({ authority, config: pdas.config, routeState: pdas.routeState, recruiterVault: pdas.recruiterVault, squadVault: pdas.squadVault, systemProgram: SystemProgram.programId })
      .rpc({ commitment: "confirmed" });
  }
  const config = await program.account.rewardsConfig.fetch(pdas.config);
  if (!config.claimsEnabled) await program.methods.setClaimsEnabled(true).accountsStrict({ authority, config: pdas.config }).rpc({ commitment: "confirmed" });

  const winner = Keypair.generate();
  const air = await connection.requestAirdrop(winner.publicKey, LAMPORTS_PER_SOL);
  await connection.confirmTransaction({ signature: air, ...(await connection.getLatestBlockhash("confirmed")) }, "confirmed");

  // One epoch, one category, three ranks, all won by the same wallet.
  const epochStart = Math.floor(Date.now() / 1000) - 7 * 24 * 3600 - 3600;
  const category = "biggest_hit";
  const categoryHash = keccak(Buffer.from(category, "utf8"));
  const prizes = [400_000_000n, 250_000_000n, 150_000_000n];
  const total = prizes.reduce((a, b) => a + b, 0n);
  const leaves = prizes.map((amount, i) => leagueLeaf({ epochStart, period: PERIOD_WEEKLY, categoryHash, rank: i + 1, winner: winner.publicKey, amount }));
  const root = buildRoot(leaves);
  const leagueEpoch = pda("league_epoch", Buffer.from([PERIOD_WEEKLY]), i64le(epochStart));
  await program.methods.depositLeague(new BN(LAMPORTS_PER_SOL))
    .accountsStrict({ payer: authority, leagueVault: pdas.leagueVault, systemProgram: SystemProgram.programId })
    .rpc({ commitment: "confirmed" });
  await program.methods.setLeagueEpochRoot(PERIOD_WEEKLY, new BN(epochStart), arr32(root), new BN(total.toString()))
    .accountsStrict({ authority, config: pdas.config, leagueVault: pdas.leagueVault, leagueEpoch, systemProgram: SystemProgram.programId })
    .rpc({ commitment: "confirmed" });

  const receiptFor = (rank) => pda("league_claim", Buffer.from([PERIOD_WEEKLY]), i64le(epochStart), categoryHash, Buffer.from([rank]));
  const claimIx = (i) => program.methods
    .claimLeague(PERIOD_WEEKLY, new BN(epochStart), arr32(categoryHash), i + 1, new BN(prizes[i].toString()), buildProof(leaves, i).map((p) => arr32(p)))
    .accountsStrict({ winner: winner.publicKey, config: pdas.config, leagueVault: pdas.leagueVault, leagueEpoch, claimReceipt: receiptFor(i + 1), systemProgram: SystemProgram.programId })
    .instruction();

  // Build all three first (as the app does before asking the wallet), then sign them together.
  const latest = await connection.getLatestBlockhash("confirmed");
  const unsigned = [];
  for (let i = 0; i < prizes.length; i += 1) {
    const message = new TransactionMessage({ payerKey: winner.publicKey, recentBlockhash: latest.blockhash, instructions: [await claimIx(i)] }).compileToV0Message();
    unsigned.push(new VersionedTransaction(message));
  }
  // signAllTransactions: one approval, every transaction signed by the winner.
  const signedAll = unsigned.map((tx) => { tx.sign([winner]); return tx; });
  for (const tx of signedAll) assert.ok(tx.serialize().length <= 1232, "each claim transaction fits one Solana packet");

  const vaultBefore = BigInt(await connection.getBalance(pdas.leagueVault, "confirmed"));
  const signatures = [];
  for (const tx of signedAll) {
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    const conf = await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
    assert.equal(conf.value.err, null, "claim transaction must succeed");
    signatures.push(sig);
  }
  const vaultAfter = BigInt(await connection.getBalance(pdas.leagueVault, "confirmed"));
  assert.equal(vaultBefore - vaultAfter, total, "vault paid exactly the three prizes");
  for (let i = 0; i < prizes.length; i += 1) assert.ok(await connection.getAccountInfo(receiptFor(i + 1), "confirmed"), `receipt for rank ${i + 1} exists`);
  console.log("ok: 3 prizes signed together, sent, paid once each:", signatures.map((s) => s.slice(0, 12)).join(", "));

  // A second claim of a paid prize is refused by the program.
  const again = new VersionedTransaction(new TransactionMessage({ payerKey: winner.publicKey, recentBlockhash: (await connection.getLatestBlockhash("confirmed")).blockhash, instructions: [await claimIx(0)] }).compileToV0Message());
  again.sign([winner]);
  await assert.rejects(connection.sendRawTransaction(again.serialize(), { skipPreflight: false }), "repeat claim must be refused");
  console.log("ok: repeat claim refused");

  // The API's on-chain check, as `record` runs it with the sign-in.
  process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID = TREASURY_PROGRAM.toBase58();
  process.env.SOLANA_REWARDS_RPC_URL = provider.connection.rpcEndpoint;
  const { verifySolanaLeagueClaimTransaction } = await import("../../frontend/api/lib/solanaLeagueClaimVerification.js");
  const epochIso = new Date(epochStart * 1000).toISOString();
  for (let i = 0; i < prizes.length; i += 1) {
    const verified = await verifySolanaLeagueClaimTransaction({
      chainId: 101, environment: "staging", solanaCluster: "devnet",
      period: "weekly", epochStart: epochIso, category, rank: i + 1,
      recipient: winner.publicKey.toBase58(), amountRaw: prizes[i].toString(), txHash: signatures[i],
    });
    assert.equal(verified.vaultDeltaLamports, prizes[i].toString());
  }
  console.log("ok: API verifier accepts each payout");
  await assert.rejects(
    verifySolanaLeagueClaimTransaction({
      chainId: 101, environment: "staging", solanaCluster: "devnet",
      period: "weekly", epochStart: epochIso, category, rank: 2,
      recipient: winner.publicKey.toBase58(), amountRaw: prizes[1].toString(), txHash: signatures[0],
    }),
    /expected|mismatch|did not execute/i,
    "a payout recorded against another prize must be refused",
  );
  console.log("ok: API verifier refuses a payout recorded against the wrong prize");
}

main().then(() => { console.log("league-claim-batch-acceptance: PASS"); process.exit(0); }, (error) => { console.error("league-claim-batch-acceptance: FAIL", error); process.exit(1); });
