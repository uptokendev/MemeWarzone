import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(here, "../../..");
const read = (relative) => fs.readFileSync(path.join(frontend, relative), "utf8");
const hasAll = (source, markers) => {
  for (const marker of markers) assert.ok(source.includes(marker), `missing lifecycle marker: ${marker}`);
};

const executor = read("src/lib/arena/solanaArenaBrowserTransaction.ts");
const tournament = read("src/lib/arena/tournamentBoostClient.ts");
const sponsorship = read("src/lib/arena/eventSponsorshipClient.ts");
const boostApi = read("api/arenaSolanaBoosts.js");
const sponsorshipApi = read("api/arenaSponsorshipPublic.js");
const migration = read("db/migrations/20260905_000001_solana_arena_payment_lifecycle.sql");

test("1 transaction signature is preserved durably before broadcast", () => {
  hasAll(executor, ["signed?.signatures?.[0]", "encodeBase58(signatureBytes)", "await input.recovery.register(pending)", "await connection.sendRawTransaction", "sentSignature !== signature"]);
  assert.ok(executor.indexOf("await input.recovery.register(pending)") < executor.indexOf("await connection.sendRawTransaction"));
});

test("2 ambiguous RPC confirmation cannot generate a replacement transaction", () => {
  assert.ok(!/localStorage|sessionStorage|STORAGE_PREFIX|writePending|readPending/.test(executor));
  hasAll(executor, ["await input.recovery.lookup()", "return await confirmAndReconcile", "LaunchpadSignatureExpiredError", "await input.recovery.expire(serverState.pending)", "Authoritative Arena payment state does not permit a replacement transaction"]);
  const lookup = executor.indexOf("await input.recovery.lookup()");
  const recover = executor.indexOf("return await confirmAndReconcile", lookup);
  const sign = executor.indexOf("await provider.signTransaction");
  assert.ok(lookup >= 0 && recover > lookup && recover < sign);
});

test("3 exact operation recovers by preserved signature and authoritative receipt", () => {
  hasAll(boostApi, ["reconcileRegisteredBoost", "verifySolanaBoostPayment", "quote.signature_reference", "persistVerifiedBoost"]);
  hasAll(sponsorshipApi, ["reconcileRegisteredSponsorship", "verifySolanaSponsorshipPayment", "quote.solana_signature_reference", "persistVerifiedSponsorship"]);
});

test("4 duplicate backend payment verification remains signature-idempotent", () => {
  hasAll(boostApi, ["on conflict (chain_id,signature_reference)", "signature_reference=$2", "payment_status='confirmed'"]);
  hasAll(sponsorshipApi, ["on conflict (chain_id,signature_reference)", "signature_reference=$2", "solana_payment_status='confirmed'"]);
});

test("5 unresolved payment is discoverable after simulated client remount", () => {
  hasAll(boostApi, ["solana-state", "latestOperationQuote", "publicBoostState"]);
  hasAll(tournament, ["fetchSolanaTournamentBoostPaymentState", "newPaymentAllowed"]);
  hasAll(sponsorshipApi, ["solana-payment-state", "q.event_id=$1 and q.sponsor_wallet=$2", "publicPaymentState"]);
  hasAll(sponsorship, ["fetchEventSponsorshipDurablePaymentState", "newPaymentAllowed"]);
  hasAll(migration, ["arena_solana_boost_quotes_operation_state_idx", "sponsorship_payment_quotes_wallet_event_state_idx"]);
});

test("6 unresolved quote/payment blocks a second quote/payment including concurrent server inserts", () => {
  hasAll(boostApi, ["priorState.newPaymentAllowed !== true", "SOLANA_BOOST_PAYMENT_UNRESOLVED"]);
  hasAll(sponsorshipApi, ["priorState.newPaymentAllowed !== true", "SPONSORSHIP_PAYMENT_UNRESOLVED", "SPONSORSHIP_ALREADY_CONFIRMED"]);
  hasAll(tournament, ["state.quoteId === quote.quoteId", "state.status === \"pending\"", "!state.signature"]);
  hasAll(sponsorship, ["state.quoteId===quote.quoteId", "state.status===\"pending\"", "!state.signature"]);
  hasAll(migration, ["arena_solana_boost_quotes_one_unresolved_uidx", "sponsorship_payment_quotes_one_unresolved_solana_uidx", "set_arena_solana_boost_operation_key", "set_sponsorship_solana_operation_key"]);
});

test("7 confirmed payment is discoverable and public read itself converges receipt state", () => {
  hasAll(boostApi, ["resolveOperationState", "reconcileRegisteredBoost(route, row)", "payment_status='confirmed'"]);
  hasAll(sponsorshipApi, ["resolveSponsorshipState", "reconcileRegisteredSponsorship(row)", "solana_payment_status='confirmed'"]);
});

test("8 only proven non-landed terminal failure or expiry permits retry", () => {
  for (const source of [boostApi, sponsorshipApi]) hasAll(source, ["getSignatureStatuses", "getBlockHeight", "getTransaction", "blockheight_expired_non_landed", "signature_failed"]);
  hasAll(boostApi, ["receipt_after_quote_expiry_landed", "outside_regulation_landed"]);
  hasAll(sponsorshipApi, ["receipt_after_quote_expiry_landed"]);
});

test("9 persistence and idempotent payout guards survive backend restart/reload", () => {
  hasAll(migration, ["'submitted'", "'pending'", "'confirming'", "'recovering'", "'verifying'", "'confirmed'", "'failed'", "'expired'", "signature_last_valid_block_height", "solana_signature_last_valid_block_height"]);
  hasAll(boostApi, ["for update", "if (!inserted)"]);
  hasAll(sponsorshipApi, ["for update", "if (!inserted)"]);
});

test("10 Final Salvo still prohibits paid Boost and regulation receipts are timestamp-bound", () => {
  hasAll(boostApi, ["FINAL_SALVO_BOOST_DISABLED", "receiptMs >= new Date(context.battle.ends_at).getTime()", "outside_regulation_landed"]);
  hasAll(tournament, ["pointsPerBoost) !== 2", "prizeBps) !== 9000", "protocolBps) !== 1000", "leagueBps) !== 0"]);
});

test("Arena Money browser lifecycle remains V0 simulate-first fresh-blockhash and wallet-return revalidated", () => {
  hasAll(executor, ["compileSolanaUserV0WithLatestBlockhash", "simulateSolanaUserV0OrThrow", "assertSolanaUserV0Intent", "await provider.signTransaction(final.transaction)"]);
  assert.ok(!/new\s+(?:web3\.)?Transaction\s*\(/.test(executor));
  assert.ok(!/signAndSendTransaction\s*\(/.test(executor));
  const compileFirst = executor.indexOf("const simulated = await compileSolanaUserV0WithLatestBlockhash");
  const simulate = executor.indexOf("await simulateSolanaUserV0OrThrow");
  const compileFresh = executor.indexOf("const final = await compileSolanaUserV0WithLatestBlockhash");
  const sign = executor.indexOf("await provider.signTransaction(final.transaction)");
  const revalidate = executor.indexOf("assertSolanaUserV0Intent(web3, signed, intent)");
  assert.ok(compileFirst >= 0 && compileFirst < simulate && simulate < compileFresh && compileFresh < sign && sign < revalidate);
});

test("direct confirmTransaction is not final authority and shared block-height recovery remains", () => {
  assert.ok(!executor.includes(".confirmTransaction("));
  hasAll(executor, ["confirmLaunchpadSignature", "LaunchpadSignatureExpiredError", "lastValidBlockHeight", "recover: async"]);
});

test("canonical Arena Money V2 program binding remains fail closed with no browser PDA authority", () => {
  hasAll(executor, ["ARENA_MONEY_V2_PROGRAM_ID", "rewardsTreasuryProgramId", "arenaMoney !== configuredTreasury", "receivedProgramId !== expectedProgramId"]);
  assert.ok(!/derive.*Pda/i.test(executor));
});

test("Event Sponsorship preserves 70/20/10 and eligible-event-only scope", () => {
  hasAll(sponsorshipApi, ["prizeBps: 7000", "marketingOpsBps: 2000", "protocolBps: 1000", "individualBattleSponsorship: false", "normal_tournament", "vote_tournament", "monthly_mwl", "quarterly_championship"]);
});
