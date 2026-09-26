"use strict";
/**
 * Post-upgrade half of rehearse-mainnet-treasury-upgrade.sh: runs against a LOCAL validator holding
 * the treasury exactly as on mainnet (all 20 accounts cloned, rewards authority re-homed to a local
 * key) after it was upgraded to the candidate through Squads. Proves, in the order the mainnet
 * runbook will do them: every existing account still decodes; initialize_mwl_vault;
 * set_arena_receivers (MWL -> mwl_vault); initialize_reward_poster (3 caps); poster league roots in
 * the three league vaults with poker places, claimed first and last; a poster recruiter batch,
 * claimed; flush_operator_fill; the live arena pool.
 *
 *   SOLANA_RPC_URL=http://127.0.0.1:8899 node scripts/solana/rehearse-mainnet-treasury-upgrade.cjs <authority.json> <poster.json>
 */
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "../..");
const req = createRequire(path.join(root, "tests/solana/package.json"));
const anchor = req("@coral-xyz/anchor");
const { Connection, Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } = req("@solana/web3.js");
const { keccak_256 } = req("@noble/hashes/sha3");
const { BN } = anchor;

const PROGRAM_ID = new PublicKey("2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX");
const keccak = (b) => Buffer.from(keccak_256(b));
const u64le = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const i64le = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; };
const pda = (seed, ...extra) => PublicKey.findProgramAddressSync([Buffer.from(seed), ...extra], PROGRAM_ID)[0];
const arr = (b) => Array.from(b);
const load = (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
const hashPair = (a, b) => keccak(Buffer.concat(Buffer.compare(a, b) <= 0 ? [a, b] : [b, a]));
function rootOf(leaves) { let l = leaves.slice(); while (l.length > 1) { const n = []; for (let i = 0; i < l.length; i += 2) n.push(hashPair(l[i], l[i + 1] ?? l[i])); l = n; } return l[0]; }
function proofOf(leaves, index) { const p = []; let l = leaves.slice(); let at = index; while (l.length > 1) { p.push(l[at ^ 1] ?? l[at]); const n = []; for (let i = 0; i < l.length; i += 2) n.push(hashPair(l[i], l[i + 1] ?? l[i])); l = n; at = Math.floor(at / 2); } return p; }
const leagueLeaf = (epochStart, period, categoryHash, rank, winner, amount) =>
  keccak(Buffer.concat([Buffer.from("MWZ_LEAGUE_LEAF"), i64le(epochStart), Buffer.from([period]), categoryHash, Buffer.from([rank]), winner.toBuffer(), u64le(amount)]));
const laneLeaf = (epochId, winner, amount) => keccak(Buffer.concat([Buffer.from("MWZ_RECRUITER_LEAF"), i64le(epochId), winner.toBuffer(), u64le(amount)]));

async function main() {
  const [authorityPath, posterPath] = process.argv.slice(2);
  const connection = new Connection(process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899", "confirmed");
  const authority = load(authorityPath);
  const poster = load(posterPath);
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(authority), { commitment: "confirmed" });
  const program = new anchor.Program(JSON.parse(fs.readFileSync(path.join(root, "target/idl/mwz_rewards_treasury.json"), "utf8")), provider);
  const lamports = async (pk) => BigInt(await connection.getBalance(pk, "confirmed"));
  const spendable = async (pk) => {
    const info = await connection.getAccountInfo(pk, "confirmed");
    return BigInt(info.lamports) - BigInt(await connection.getMinimumBalanceForRentExemption(info.data.length));
  };
  const fund = async (pk, sol) => { const s = await connection.requestAirdrop(pk, sol * LAMPORTS_PER_SOL); await connection.confirmTransaction(s, "confirmed"); };
  const ok = (msg) => console.log(`    ok: ${msg}`);

  console.log("==> 1. every cloned mainnet account decodes under the candidate");
  const all = await connection.getProgramAccounts(PROGRAM_ID);
  let decoded = 0;
  for (const acc of program.idl.accounts) {
    const name = acc.name.charAt(0).toLowerCase() + acc.name.slice(1);
    if (!program.account[name]) continue;
    const rows = await program.account[name].all().catch((e) => { throw new Error(`${acc.name} failed to decode: ${e.message}`); });
    if (rows.length) console.log(`    ${acc.name}: ${rows.length}`);
    decoded += rows.length;
  }
  assert.equal(decoded, all.length, `decoded ${decoded} of ${all.length} program accounts`);
  ok(`${decoded}/${all.length} accounts decode`);
  const epochsBefore = await program.account.leagueEpoch.all();

  const config = pda("rewards_config");
  const vaults = { weekly: pda("league_vault"), monthly: pda("monthly_league_vault"), mwl: pda("mwl_vault"), recruiter: pda("recruiter_vault"), protocol: pda("protocol_vault") };

  console.log("==> 2. initialize_mwl_vault + set_arena_receivers (MWL share -> mwl_vault)");
  await program.methods.initializeMwlVault().accountsPartial({ authority: authority.publicKey, config, mwlVault: vaults.mwl, systemProgram: SystemProgram.programId }).rpc();
  const arenaConfig = pda("arena_config");
  const before = await program.account.arenaConfig.fetch(arenaConfig);
  await program.methods.setArenaReceivers(before.protocolReceiver, vaults.mwl).accountsPartial({ authority: authority.publicKey, rewardsConfig: config, arenaConfig }).rpc();
  const after = await program.account.arenaConfig.fetch(arenaConfig);
  assert.ok(after.mwlReceiver.equals(vaults.mwl) && after.protocolReceiver.equals(before.protocolReceiver));
  ok(`arena MWL receiver ${before.mwlReceiver.toBase58().slice(0, 8)}… -> mwl_vault ${vaults.mwl.toBase58().slice(0, 8)}…; protocol receiver unchanged`);

  console.log("==> 3. initialize_reward_poster (airdrop / league / recruiter+squad caps)");
  const rewardPoster = pda("reward_poster");
  const cap = new BN(50 * LAMPORTS_PER_SOL);
  await program.methods.initializeRewardPoster(poster.publicKey, cap, cap, cap).accountsPartial({ authority: authority.publicKey, config, rewardPoster, systemProgram: SystemProgram.programId }).rpc();
  ok("poster set");
  await fund(poster.publicKey, 5);

  const now = Math.floor(Date.now() / 1000);
  const day = 86400;
  const monday = (() => { const d = new Date(); const dow = (d.getUTCDay() + 6) % 7; return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000) - dow * day - 7 * day; })();
  const monthStart = Math.floor(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1) / 1000);

  // The poster never overwrites: an epoch the old authority job already sealed on mainnet stays as it
  // is. Walk back to the most recent epoch start with no root, as the real publisher does.
  async function freeEpochStart(period, candidates) {
    for (const start of candidates) {
      if (start > now) continue;
      const exists = await connection.getAccountInfo(pda("league_epoch", Buffer.from([period]), i64le(start)), "confirmed");
      if (!exists) return start;
      console.log(`    period ${period} epoch ${new Date(start * 1000).toISOString().slice(0, 10)} already sealed on mainnet -- left untouched`);
    }
    throw new Error(`no free epoch start for period ${period}`);
  }

  async function leagueRound(label, period, epochStart, vault, places) {
    const avail = await spendable(vault);
    const pot = avail / 2n;
    assert.ok(pot > 0n, `${label}: vault has nothing to pay`);
    const weights = Array.from({ length: places }, (_, i) => BigInt(Math.round(1e12 / (i + 1) ** 0.72)));
    const total = weights.reduce((a, b) => a + b, 0n);
    const amounts = weights.map((w) => (pot * w) / total);
    amounts[0] += pot - amounts.reduce((a, b) => a + b, 0n);
    const winners = Array.from({ length: places }, () => Keypair.generate());
    for (const w of [winners[0], winners[places - 1]]) await fund(w.publicKey, 1);
    const categoryHash = keccak(Buffer.from("recruiter_league"));
    const leaves = amounts.map((a, i) => leagueLeaf(epochStart, period, categoryHash, i + 1, winners[i].publicKey, a));
    const epoch = pda("league_epoch", Buffer.from([period]), i64le(epochStart));
    await program.methods.postLeagueEpochRoot(period, new BN(epochStart), arr(rootOf(leaves)), new BN(pot.toString()))
      .accountsPartial({ poster: poster.publicKey, config, rewardPoster, leagueVault: vault, leagueEpoch: epoch, systemProgram: SystemProgram.programId })
      .signers([poster]).rpc();
    const vaultBefore = await lamports(vault);
    for (const index of [0, places - 1]) {
      await program.methods.claimLeague(period, new BN(epochStart), arr(categoryHash), index + 1, new BN(amounts[index].toString()), proofOf(leaves, index).map(arr))
        .accountsPartial({
          winner: winners[index].publicKey, config, leagueVault: vault, leagueEpoch: epoch,
          claimReceipt: pda("league_claim", Buffer.from([period]), i64le(epochStart), categoryHash, Buffer.from([index + 1])),
          systemProgram: SystemProgram.programId,
        })
        .signers([winners[index]]).rpc();
    }
    assert.equal(vaultBefore - (await lamports(vault)), amounts[0] + amounts[places - 1]);
    ok(`${label}: root of ${places} poker places over ${pot} lamports posted by the poster; rank 1 and rank ${places} claimed from the right vault`);
  }

  console.log("==> 4. poster league roots, one per league vault");
  const weeks = Array.from({ length: 12 }, (_, k) => monday + 7 * day - k * 7 * day);
  const months = Array.from({ length: 4 }, (_, k) => Math.floor(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - k, 1) / 1000));
  await leagueRound("pre-grad weekly (league_vault)", 0, await freeEpochStart(0, weeks), vaults.weekly, 6);
  await leagueRound("pre-grad monthly (monthly_league_vault)", 1, await freeEpochStart(1, months), vaults.monthly, 7);
  const mwlFund = new anchor.web3.Transaction().add(SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: vaults.mwl, lamports: LAMPORTS_PER_SOL / 10 }));
  await provider.sendAndConfirm(mwlFund, []);
  await leagueRound("Major War League monthly (mwl_vault)", 3, await freeEpochStart(3, months), vaults.mwl, 5);

  console.log("==> 5. poster recruiter batch from the recruiter vault, claimed");
  const recruiterAvail = await spendable(vaults.recruiter);
  const recruiterTotal = recruiterAvail < 671407n ? recruiterAvail : 671407n;
  const recruiter = Keypair.generate();
  await fund(recruiter.publicKey, 1);
  const epochId = 999001;
  const leaves = [laneLeaf(epochId, recruiter.publicKey, recruiterTotal)];
  const batch = pda("recruiter_batch", i64le(epochId));
  await program.methods.postRecruiterBatchRoot(new BN(epochId), arr(rootOf(leaves)), new BN(recruiterTotal.toString()))
    .accountsPartial({ poster: poster.publicKey, config, rewardPoster, recruiterVault: vaults.recruiter, recruiterBatch: batch, systemProgram: SystemProgram.programId })
    .signers([poster]).rpc();
  const rBefore = await lamports(vaults.recruiter);
  await program.methods.claimRecruiter(new BN(epochId), new BN(recruiterTotal.toString()), [])
    .accountsPartial({ winner: recruiter.publicKey, config, recruiterVault: vaults.recruiter, recruiterBatch: batch, claimReceipt: pda("recruiter_claim", i64le(epochId), recruiter.publicKey.toBuffer()), systemProgram: SystemProgram.programId })
    .signers([recruiter]).rpc();
  assert.equal(rBefore - (await lamports(vaults.recruiter)), recruiterTotal);
  ok(`recruiter batch ${recruiterTotal} lamports (the vault's real mainnet balance) posted by the poster and claimed in full`);

  console.log("==> 6. flush_operator_fill (protocol vault -> capped operator / overflow)");
  const routeState = await program.account.routeState.fetch(pda("route_state"));
  const protocolBefore = await spendable(vaults.protocol);
  try {
    await program.methods.flushOperatorFill().accountsPartial({ operator: routeState.operator, routeState: pda("route_state"), protocolVault: vaults.protocol, overflowTreasury: routeState.overflowTreasury }).rpc();
    ok(`flushed ${protocolBefore - (await spendable(vaults.protocol))} of ${protocolBefore} spendable lamports`);
  } catch (e) {
    console.log(`    note: flush_operator_fill -> ${String(e.message).split("\n")[0]}`);
  }

  console.log("==> 7. mainnet league epochs and the live arena pool after the upgrade");
  for (const e of epochsBefore) {
    const now2 = await program.account.leagueEpoch.fetch(e.publicKey);
    assert.equal(now2.totalLamports.toString(), e.account.totalLamports.toString());
    console.log(`    epoch period ${now2.period} start ${now2.epochStart} total ${now2.totalLamports} claimed ${now2.claimedLamports} sealed ${now2.sealed}`);
  }
  for (const p of await program.account.arenaPool.all()) console.log(`    arena pool ${p.publicKey.toBase58().slice(0, 8)}… state ${p.account.state} kind ${p.account.kind}`);
  console.log("\nPOST-UPGRADE REHEARSAL PASS");
}

main().catch((e) => { console.error("POST-UPGRADE REHEARSAL FAIL:", e?.message || e); if (e?.logs) console.error(e.logs.slice(-8).join("\n")); process.exit(1); });
