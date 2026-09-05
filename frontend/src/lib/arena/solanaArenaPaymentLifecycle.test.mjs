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
const migration = read("db/migrations/20260905_000001_solana_arena_payment_lifecycle.sql");

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
  const register = executor.indexOf("await input.recovery.register(pending)");
  const send = executor.indexOf("await connection.sendRawTransaction");
  assert.ok(compileFirst >= 0 && compileFirst < simulate);
  assert.ok(simulate < compileFresh && compileFresh < sign);
  assert.ok(sign < revalidate && revalidate < register && register < send, "exact signature must be durably registered before broadcast");
});

test("direct confirmTransaction is not Arena Money authority and shared block-height recovery is used", () => {
  assert.doesNotMatch(executor, /\.confirmTransaction\s*\(/);
  assert.match(executor, /confirmLaunchpadSignature/);
  assert.match(executor, /LaunchpadSignatureExpiredError/);
  assert.match(executor, /lastValidBlockHeight/);
  assert.match(executor, /recover:\s*async/);
});

test("durable server lookup replaces browser storage and unresolved signature is recovered before replacement signing", () => {
  assert.doesNotMatch(executor, /localStorage|sessionStorage|STORAGE_PREFIX|writePending|readPending/);
  const lookup = executor.indexOf("await input.recovery.lookup()");
  const recover = executor.indexOf("return await confirmAndReconcile", lookup);
  const sign = executor.indexOf("await provider.signTransaction");
  assert.ok(lookup >= 0 && recover > lookup && recover < sign);
  assert.match(executor, /if \(!\(error instanceof LaunchpadSignatureExpiredError\)\) throw error/);
  assert.match(executor, /await input\.recovery\.expire\(serverState\.pending\)/);
  assert.match(executor, /Do not retry the payment/);
  assert.match(executor, /withRecoveryLock/);
});

test("wallet signature identity is preserved exactly before and after sendRawTransaction", () => {
  assert.match(executor, /signed\?\.signatures\?\.\[0\]/);
  assert.match(executor, /encodeBase58\(signatureBytes\)/);
  assert.match(executor, /await input\.recovery\.register\(pending\)/);
  assert.match(executor, /sentSignature !== signature/);
});

test("Arena Money browser envelope is fail-closed bound to canonical deployed program authority", () => {
  assert.match(executor, /ARENA_MONEY_V2_PROGRAM_ID/);
  assert.match(executor, /rewardsTreasuryProgramId/);
  assert.match(executor, /arenaMoney !== configuredTreasury/);
  assert.match(executor, /receivedProgramId !== expectedProgramId/);
  assert.doesNotMatch(executor, /derive.*Pda/i);
});

test("durable schema survives remount/backend restart and distinguishes lifecycle states", () => {
  for (const marker of ["submitted", "pending", "confirming", "recovering", "verifying", "confirmed", "failed", "expired"]) assert.match(migration, new RegExp(`'${marker}'`));
  assert.match(migration, /signature_last_valid_block_height/);
  assert.match(migration, /solana_signature_last_valid_block_height/);
  assert.match(migration, /arena_solana_boost_quotes_operation_state_idx/);
  assert.match(migration, /sponsorship_payment_quotes_wallet_event_state_idx/);
});

test("Vote Tournament SOL Boost exposes durable public recovery and blocks unresolved second quotes", () => {
  assert.match(boostApi, /solana-state/);
  assert.match(boostApi, /solana-submission/);
  assert.match(boostApi, /solana-expire/);
  assert.match(boostApi, /SOLANA_BOOST_PAYMENT_UNRESOLVED/);
  assert.match(boostApi, /newPaymentAllowed/);
  assert.match(boostApi, /signature_reference/);
  assert.match(boostApi, /getSignatureStatuses/);
  assert.match(boostApi, /getBlockHeight/);
  assert.match(boostApi, /getTransaction/);
  assert.match(tournament, /fetchSolanaTournamentBoostPaymentState/);
  assert.match(tournament, /lookup:\s*async/);
  assert.match(tournament, /register:\s*async/);
  assert.match(tournament, /expire:\s*async/);
  assert.match(tournament, /arena_tournament_boost_submission/);
});

test("duplicate Vote Boost backend verification remains signature-idempotent", () => {
  assert.match(boostApi, /arena_contest_actions where chain_id=\$1 and signature_reference=\$2/);
  assert.match(boostApi, /on conflict \(chain_id,signature_reference\)/i);
  assert.match(boostApi, /payment_status='confirmed'/);
});

test("Vote Tournament economics and Final Salvo prohibition remain frozen", () => {
  assert.match(tournament, /prizeBps\) !== 9000/);
  assert.match(tournament, /protocolBps\) !== 1000/);
  assert.match(tournament, /leagueBps\) !== 0/);
  assert.match(tournament, /pointsPerBoost\) !== 2/);
  assert.match(boostApi, /FINAL_SALVO_BOOST_DISABLED/);
  assert.match(boostApi, /Tournament Boost was not paid during regulation/);
  assert.match(boostApi, /receiptMs>=new Date\(context\.battle\.ends_at\)\.getTime\(\)/);
});

test("SOL sponsorship is discoverable by wallet+event after remount and unresolved state blocks another quote", () => {
  assert.match(sponsorshipApi, /solana-payment-state/);
  assert.match(sponsorshipApi, /solana-submission/);
  assert.match(sponsorshipApi, /solana-expire/);
  assert.match(sponsorshipApi, /SPONSORSHIP_PAYMENT_UNRESOLVED/);
  assert.match(sponsorshipApi, /SPONSORSHIP_ALREADY_CONFIRMED/);
  assert.match(sponsorshipApi, /newPaymentAllowed/);
  assert.match(sponsorship, /fetchEventSponsorshipDurablePaymentState/);
  assert.match(sponsorship, /lookup:\s*async/);
  assert.match(sponsorship, /register:\s*async/);
  assert.match(sponsorship, /expire:\s*async/);
  assert.match(sponsorship, /arena_sponsorship_submission/);
});

test("SOL sponsorship receipt verification and idempotence preserve 70/20/10 and event-only scope", () => {
  assert.match(sponsorshipApi, /verifySolanaSponsorshipPayment/);
  assert.match(sponsorshipApi, /on conflict \(chain_id,signature_reference\)/i);
  assert.match(sponsorshipApi, /prizeBps:7000/);
  assert.match(sponsorshipApi, /marketingOpsBps:2000/);
  assert.match(sponsorshipApi, /protocolBps:1000/);
  assert.match(sponsorshipApi, /individualBattleSponsorship:false/);
});

test("terminal expiry is only server-marked after block-height, signature-status and transaction absence proof", () => {
  for (const source of [boostApi, sponsorshipApi]) {
    assert.match(source, /getSignatureStatuses/);
    assert.match(source, /getBlockHeight/);
    assert.match(source, /getTransaction/);
    assert.match(source, /blockheight_expired_non_landed/);
  }
});
