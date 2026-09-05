import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(here, "../../..");
const read = (relative) => fs.readFileSync(path.join(frontend, relative), "utf8");

const executor = read("src/lib/arena/solanaArenaBrowserTransaction.ts");
const tournament = read("src/lib/arena/tournamentBoostClient.ts");
const sponsorship = read("src/lib/arena/eventSponsorshipClient.ts");
const boostApi = read("api/arenaSolanaBoosts.js");
const sponsorshipApi = read("api/arenaSponsorshipPublic.js");

test("Arena Money browser executor remains V0, simulate-first, fresh-blockhash, and post-wallet revalidated", () => {
  assert.match(executor, /compileSolanaUserV0WithLatestBlockhash/);
  assert.match(executor, /simulateSolanaUserV0OrThrow/);
  assert.match(executor, /assertSolanaUserV0Intent/);
  assert.doesNotMatch(executor, /new\s+(?:web3\.)?Transaction\s*\(/);
  assert.doesNotMatch(executor, /signAndSendTransaction\s*\(/);

  const compileFirst = executor.indexOf("const simulated = await compileSolanaUserV0WithLatestBlockhash");
  const simulate = executor.indexOf("await simulateSolanaUserV0OrThrow");
  const compileFresh = executor.indexOf("const final = await compileSolanaUserV0WithLatestBlockhash");
  const sign = executor.indexOf("await provider.signTransaction(final.transaction)");
  const revalidate = executor.indexOf("assertSolanaUserV0Intent(web3, signed, intent)");
  const send = executor.indexOf("await connection.sendRawTransaction");
  assert.ok(compileFirst >= 0 && compileFirst < simulate, "first V0 compile must precede simulation");
  assert.ok(simulate < compileFresh, "simulation must precede fresh V0 compile/blockhash");
  assert.ok(compileFresh < sign, "fresh compile must precede wallet sign");
  assert.ok(sign < revalidate && revalidate < send, "wallet-returned V0 must be revalidated before raw send");
});

test("direct confirmTransaction is not Arena Money authority and shared block-height recovery is used", () => {
  assert.doesNotMatch(executor, /\.confirmTransaction\s*\(/);
  assert.match(executor, /confirmLaunchpadSignature/);
  assert.match(executor, /LaunchpadSignatureExpiredError/);
  assert.match(executor, /lastValidBlockHeight/);
  assert.match(executor, /recover:\s*async/);
});

test("unresolved exact signature is persisted and recovered before any replacement signing", () => {
  const readExisting = executor.indexOf("const existing = readPending");
  const recoverExisting = executor.indexOf("return await confirmAndReconcile", readExisting);
  const sign = executor.indexOf("await provider.signTransaction");
  assert.ok(readExisting >= 0 && recoverExisting > readExisting && recoverExisting < sign);
  assert.match(executor, /mwz:arena-solana-payment:v1:/);
  assert.match(executor, /writePending\(storage, input\.recovery\.key, pending\)/);
  assert.match(executor, /if \(!\(error instanceof LaunchpadSignatureExpiredError\)\) throw error/);
  assert.match(executor, /Do not retry the payment/);
  assert.match(executor, /withRecoveryLock/);
});

test("Arena Money browser envelope is fail-closed bound to canonical deployed program authority", () => {
  assert.match(executor, /ARENA_MONEY_V2_PROGRAM_ID/);
  assert.match(executor, /rewardsTreasuryProgramId/);
  assert.match(executor, /arenaMoney !== configuredTreasury/);
  assert.match(executor, /receivedProgramId !== expectedProgramId/);
});

test("Vote Tournament SOL Boost recovers the original signature through backend receipt authority", () => {
  assert.match(tournament, /SOLANA_BOOST_PAYMENT_UNVERIFIED/);
  assert.match(tournament, /input\.pending\.signature/);
  assert.match(tournament, /arena_tournament_boost_payment/);
  assert.match(tournament, /sendSolanaArenaInstruction<SolanaTournamentBoostPayment>/);
  assert.match(tournament, /prizeBps\) !== 9000/);
  assert.match(tournament, /protocolBps\) !== 1000/);
  assert.match(tournament, /leagueBps\) !== 0/);
  assert.match(tournament, /pointsPerBoost\) !== 2/);
});

test("Vote Tournament quote remains Final-Salvo-disabled while landed regulation signatures can recover by receipt timestamp", () => {
  assert.match(boostApi, /FINAL_SALVO_BOOST_DISABLED/);
  assert.match(boostApi, /Tournament Boost was not paid during regulation/);
  assert.match(boostApi, /receiptMs >= new Date\(context\.battle\.ends_at\)\.getTime\(\)/);
  assert.match(boostApi, /tournamentPaymentContext/);
  assert.match(boostApi, /verifySolanaBoostPayment/);
  assert.match(boostApi, /on conflict \(chain_id, signature_reference\)/i);
});

test("SOL event sponsorship recovers through public payment state and exact backend verification", () => {
  assert.match(sponsorship, /fetchEventSponsorshipPaymentState\(quoteId\)/);
  assert.match(sponsorship, /SPONSORSHIP_PAYMENT_UNVERIFIED/);
  assert.match(sponsorship, /inputRecovery\.pending\.signature/);
  assert.match(sponsorship, /event-sponsorship:/);
  assert.match(sponsorshipApi, /prizeBps: 7000/);
  assert.match(sponsorshipApi, /marketingOpsBps: 2000/);
  assert.match(sponsorshipApi, /protocolBps: 1000/);
  assert.match(sponsorshipApi, /individualBattleSponsorship: false/);
  assert.match(sponsorshipApi, /verifySolanaSponsorshipPayment/);
});
