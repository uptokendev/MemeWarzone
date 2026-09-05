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

test("1 transaction signature is preserved durably before broadcast", () => {
  assert.match(executor, /signed\?\.signatures\?\.\[0\]/);
  assert.match(executor, /encodeBase58\(signatureBytes\)/);
  const register = executor.indexOf("await input.recovery.register(pending)");
  const send = executor.indexOf("await connection.sendRawTransaction");
  assert.ok(register >= 0 && send > register, "wallet signature must be registered server-side before broadcast");
  assert.match(executor, /sentSignature !== signature/);
});

test("2 ambiguous RPC confirmation cannot generate a replacement transaction", () => {
  assert.doesNotMatch(executor, /localStorage|sessionStorage|STORAGE_PREFIX|writePending|readPending/);
  const lookup = executor.indexOf("await input.recovery.lookup()");
  const recover = executor.indexOf("return await confirmAndReconcile", lookup);
  const sign = executor.indexOf("await provider.signTransaction");
  assert.ok(lookup >= 0 && recover > lookup && recover < sign);
  assert.match(executor, /if \(!\(error instanceof LaunchpadSignatureExpiredError\)\) throw error/);
  assert.match(executor, /Authoritative Arena payment state does not permit a replacement transaction/);
});

test("3 exact operation recovers by preserved signature and authoritative receipt", () => {
  assert.match(boostApi, /reconcileRegisteredBoost/);
  assert.match(boostApi, /verifySolanaBoostPayment/);
  assert.match(boostApi, /quote\.signature_reference/);
  assert.match(sponsorshipApi, /reconcileRegisteredSponsorship/);
  assert.match(sponsorshipApi, /verifySolanaSponsorshipPayment/);
  assert.match(sponsorshipApi, /quote\.solana_signature_reference/);
});

test("4 duplicate backend payment verification remains signature-idempotent", () => {
  assert.match(boostApi, /on conflict \(chain_id,signature_reference\)/i);
  assert.match(boostApi, /arena_contest_actions where chain_id=\$1 and signature_reference=\$2/);
  assert.match(sponsorshipApi, /on conflict \(chain_id,signature_reference\)/i);
  assert.match(sponsorshipApi, /where chain_id=\$1 and signature_reference=\$2/);
});

test("5 unresolved payment is discoverable after simulated client remount", () => {
  assert.match(boostApi, /solana-state/);
  assert.match(boostApi, /latestOperationQuote/);
  assert.match(tournament, /fetchSolanaTournamentBoostPaymentState/);
  assert.match(sponsorshipApi, /solana-payment-state/);
  assert.match(sponsorshipApi, /q\.event_id=\$1 and q\.sponsor_wallet=\$2/);
  assert.match(sponsorship, /fetchEventSponsorshipDurablePaymentState/);
  assert.match(migration, /arena_solana_boost_quotes_operation_state_idx/);
  assert.match(migration, /sponsorship_payment_quotes_wallet_event_state_idx/);
});

test("6 unresolved quote/payment blocks a second quote/payment", () => {
  assert.match(boostApi, /priorState\.newPaymentAllowed !== true/);
  assert.match(boostApi, /SOLANA_BOOST_PAYMENT_UNRESOLVED/);
  assert.match(sponsorshipApi, /priorState\.newPaymentAllowed !== true/);
  assert.match(sponsorshipApi, /SPONSORSHIP_PAYMENT_UNRESOLVED/);
  assert.match(tournament, /state\.quoteId === quote\.quoteId && state\.status === "pending" && !state\.signature/);
  assert.match(sponsorship, /state\.quoteId===quote\.quoteId&&state\.status==="pending"&&!state\.signature/);
});

test("7 confirmed payment is discoverable and public read itself converges receipt state", () => {
  assert.match(boostApi, /resolveOperationState/);
  assert.match(boostApi, /reconcileRegisteredBoost\(route, row\)/);
  assert.match(boostApi, /payment_status='confirmed'/);
  assert.match(sponsorshipApi, /resolveSponsorshipState/);
  assert.match(sponsorshipApi, /reconcileRegisteredSponsorship\(row\)/);
  assert.match(sponsorshipApi, /solana_payment_status='confirmed'/);
});

test("8 only proven non-landed terminal failure or expiry permits retry", () => {
  for (const source of [boostApi, sponsorshipApi]) {
    assert.match(source, /getSignatureStatuses/);
    assert.match(source, /getBlockHeight/);
    assert.match(source, /getTransaction/);
    assert.match(source, /blockheight_expired_non_landed/);
    assert.match(source, /signature_failed/);
  }
  assert.match(boostApi, /receipt_after_quote_expiry_landed/);
  assert.match(boostApi, /outside_regulation_landed/);
  assert.match(sponsorshipApi, /receipt_after_quote_expiry_landed/);
});

test("9 persistence and idempotent payout guards survive backend restart/reload", () => {
  for (const marker of ["submitted", "pending", "confirming", "recovering", "verifying", "confirmed", "failed", "expired"]) assert.match(migration, new RegExp(`'${marker}'`));
  assert.match(migration, /signature_last_valid_block_height/);
  assert.match(migration, /solana_signature_last_valid_block_height/);
  assert.match(boostApi, /for update/);
  assert.match(sponsorshipApi, /for update/);
  assert.match(sponsorshipApi, /if \(inserted\)/);
});

test("10 Final Salvo still prohibits paid Boost and regulation receipts are timestamp-bound", () => {
  assert.match(boostApi, /FINAL_SALVO_BOOST_DISABLED/);
  assert.match(boostApi, /receiptMs\s*>=\s*new Date\(context\.battle\.ends_at\)\.getTime\(\)/);
  assert.match(boostApi, /outside_regulation_landed/);
  assert.match(tournament, /pointsPerBoost\) !== 2/);
  assert.match(tournament, /prizeBps\) !== 9000/);
  assert.match(tournament, /protocolBps\) !== 1000/);
  assert.match(tournament, /leagueBps\) !== 0/);
});

test("Arena Money browser lifecycle remains V0 simulate-first fresh-blockhash and wallet-return revalidated", () => {
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
  assert.ok(compileFirst >= 0 && compileFirst < simulate && simulate < compileFresh && compileFresh < sign && sign < revalidate);
});

test("direct confirmTransaction is not final authority and shared block-height recovery remains", () => {
  assert.doesNotMatch(executor, /\.confirmTransaction\s*\(/);
  assert.match(executor, /confirmLaunchpadSignature/);
  assert.match(executor, /LaunchpadSignatureExpiredError/);
  assert.match(executor, /lastValidBlockHeight/);
  assert.match(executor, /recover:\s*async/);
});

test("canonical Arena Money V2 program binding remains fail closed with no browser PDA authority", () => {
  assert.match(executor, /ARENA_MONEY_V2_PROGRAM_ID/);
  assert.match(executor, /rewardsTreasuryProgramId/);
  assert.match(executor, /arenaMoney !== configuredTreasury/);
  assert.match(executor, /receivedProgramId !== expectedProgramId/);
  assert.doesNotMatch(executor, /derive.*Pda/i);
});

test("Event Sponsorship preserves 70/20/10 and eligible-event-only scope", () => {
  assert.match(sponsorshipApi, /prizeBps: 7000/);
  assert.match(sponsorshipApi, /marketingOpsBps: 2000/);
  assert.match(sponsorshipApi, /protocolBps: 1000/);
  assert.match(sponsorshipApi, /individualBattleSponsorship: false/);
  assert.match(sponsorshipApi, /normal_tournament/);
  assert.match(sponsorshipApi, /vote_tournament/);
  assert.match(sponsorshipApi, /monthly_mwl/);
  assert.match(sponsorshipApi, /quarterly_championship/);
});
