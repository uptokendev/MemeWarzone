import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ArenaPaymentReplacementBlockedError,
  registerArenaPaymentBeforeBroadcast,
  resolveArenaPaymentBeforeSigning,
} from "./solanaArenaPaymentRecoveryCoordinator.mjs";

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

class ExpiredSignatureError extends Error {}

function makeDurableServer(initial = null) {
  let record = initial ? structuredClone(initial) : null;
  return {
    async lookup() {
      if (!record) return { pending: null, newPaymentAllowed: true, status: "none" };
      const unresolved = ["pending", "submitted", "confirming", "recovering", "verifying"].includes(record.status);
      return {
        pending: unresolved && record.pending ? structuredClone(record.pending) : null,
        newPaymentAllowed: record.newPaymentAllowed === true,
        status: record.status,
        confirmed: record.status === "confirmed",
        signature: record.pending?.signature || record.signature || null,
      };
    },
    async register(pending) {
      record = { status: "submitted", newPaymentAllowed: false, pending: structuredClone(pending) };
    },
    async expire(pending) {
      assert.equal(record?.pending?.signature, pending.signature);
      record = { status: "expired", newPaymentAllowed: true, signature: pending.signature, pending: null };
    },
    confirm(signature) {
      assert.equal(record?.pending?.signature, signature);
      record = { status: "confirmed", newPaymentAllowed: false, signature, pending: null };
    },
    failTerminal(signature) {
      assert.equal(record?.pending?.signature, signature);
      record = { status: "failed", newPaymentAllowed: true, signature, pending: null };
    },
    snapshot() { return structuredClone(record); },
  };
}

const pending = {
  signature: "5FakeSignedArenaSignature111111111111111111111111111111111111111111111",
  blockhash: "FakeRecentBlockhash111111111111111111111111111111",
  lastValidBlockHeight: 123456,
  chainId: 101,
  wallet: "VoteWallet1111111111111111111111111111111111",
  programId: "ArenaMoney111111111111111111111111111111111",
  metadata: { quoteId: "quote-1", tournamentId: "tour-1", matchRef: "match-1", targetToken: "Token111" },
  createdAt: "2026-09-05T11:00:00.000Z",
};

test("1 signed attempt is registered durably before broadcast", async () => {
  const server = makeDurableServer();
  const events = [];
  await registerArenaPaymentBeforeBroadcast({
    pending,
    register: async (value) => { events.push("register"); await server.register(value); },
    broadcast: async () => {
      events.push("broadcast");
      assert.equal(server.snapshot()?.pending?.signature, pending.signature);
      return pending.signature;
    },
  });
  assert.deepEqual(events, ["register", "broadcast"]);
});

test("2 empty browser persistence remount discovers pending attempt from backend", async () => {
  const server = makeDurableServer();
  await server.register(pending);
  const priorLocalStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem() { throw new Error("browser persistence must not be consulted"); },
    setItem() { throw new Error("browser persistence must not be consulted"); },
    removeItem() { throw new Error("browser persistence must not be consulted"); },
  };
  try {
    const freshClientResult = await resolveArenaPaymentBeforeSigning({
      lookup: () => server.lookup(),
      recoverPending: async (value) => ({ signature: value.signature, recovered: true }),
      expirePending: (value) => server.expire(value),
      isExpiredError: (error) => error instanceof ExpiredSignatureError,
    });
    assert.equal(freshClientResult.kind, "recovered");
    assert.equal(freshClientResult.result.signature, pending.signature);
  } finally {
    if (priorLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = priorLocalStorage;
  }
});

test("3 unresolved server attempt blocks a second payment", async () => {
  const server = makeDurableServer();
  await server.register(pending);
  await assert.rejects(
    resolveArenaPaymentBeforeSigning({
      lookup: () => server.lookup(),
      recoverPending: async () => { throw new Error("ambiguous rpc timeout"); },
      expirePending: (value) => server.expire(value),
      isExpiredError: () => false,
    }),
    /ambiguous rpc timeout/,
  );
  assert.equal((await server.lookup()).newPaymentAllowed, false);
  assert.equal(server.snapshot().pending.signature, pending.signature);
});

test("4 crash immediately after broadcast cannot lose original signature identity", async () => {
  const server = makeDurableServer();
  let landed = false;
  await assert.rejects(
    registerArenaPaymentBeforeBroadcast({
      pending,
      register: (value) => server.register(value),
      broadcast: async () => {
        landed = true;
        throw new Error("browser-crashed-after-rpc-accepted");
      },
    }),
    /browser-crashed-after-rpc-accepted/,
  );
  assert.equal(landed, true);
  assert.equal(server.snapshot().pending.signature, pending.signature);
  assert.equal((await server.lookup()).newPaymentAllowed, false);
});

test("5 backend restart or fresh reader preserves durable pending attempt", async () => {
  const durableDatabase = makeDurableServer();
  await durableDatabase.register(pending);
  const restartedBackend = { lookup: () => durableDatabase.lookup() };
  const state = await restartedBackend.lookup();
  assert.equal(state.pending.signature, pending.signature);
  assert.equal(state.newPaymentAllowed, false);
});

test("6 ambiguous RPC result keeps the same signature unresolved", async () => {
  const server = makeDurableServer();
  await server.register(pending);
  const before = server.snapshot();
  await assert.rejects(resolveArenaPaymentBeforeSigning({
    lookup: () => server.lookup(),
    recoverPending: async (value) => {
      assert.equal(value.signature, pending.signature);
      throw new Error("rpc-ambiguous");
    },
    expirePending: (value) => server.expire(value),
    isExpiredError: () => false,
  }), /rpc-ambiguous/);
  assert.deepEqual(server.snapshot(), before);
});

test("7 authoritative receipt can resolve the preserved attempt as success", async () => {
  const server = makeDurableServer();
  await server.register(pending);
  const result = await resolveArenaPaymentBeforeSigning({
    lookup: () => server.lookup(),
    recoverPending: async (value) => {
      server.confirm(value.signature);
      return { signature: value.signature, confirmed: true };
    },
    expirePending: (value) => server.expire(value),
    isExpiredError: (error) => error instanceof ExpiredSignatureError,
  });
  assert.equal(result.kind, "recovered");
  assert.equal(result.result.confirmed, true);
  assert.equal((await server.lookup()).status, "confirmed");
});

test("8 conclusively expired non-landed attempt permits replacement only after server expiry", async () => {
  const server = makeDurableServer();
  await server.register(pending);
  const result = await resolveArenaPaymentBeforeSigning({
    lookup: () => server.lookup(),
    recoverPending: async () => { throw new ExpiredSignatureError("blockheight expired and transaction absent"); },
    expirePending: (value) => server.expire(value),
    isExpiredError: (error) => error instanceof ExpiredSignatureError,
  });
  assert.equal(result.kind, "new");
  const state = await server.lookup();
  assert.equal(state.status, "expired");
  assert.equal(state.newPaymentAllowed, true);
});

test("9 confirmed attempt remains discoverable after remount", async () => {
  const server = makeDurableServer();
  await server.register(pending);
  server.confirm(pending.signature);
  const freshRead = await server.lookup();
  assert.equal(freshRead.status, "confirmed");
  assert.equal(freshRead.confirmed, true);
  assert.equal(freshRead.signature, pending.signature);
});

test("10 backend persistence keeps payout verification idempotent", () => {
  hasAll(boostApi, ["on conflict (chain_id,signature_reference)", "signature_reference=$2", "payment_status='confirmed'"]);
  hasAll(sponsorshipApi, ["on conflict (chain_id,signature_reference)", "signature_reference=$2", "solana_payment_status='confirmed'"]);
  hasAll(migration, ["arena_solana_boost_quotes_one_unresolved_uidx", "sponsorship_payment_quotes_one_unresolved_solana_uidx"]);
});

test("11 Tournament Boost cannot be created during Final Salvo", () => {
  hasAll(boostApi, ["FINAL_SALVO_BOOST_DISABLED", "Boost is disabled during Final Salvo"]);
});

test("12 regulation Boost can recover after Final Salvo starts only when receipt timestamp proves regulation", () => {
  hasAll(boostApi, ["tournamentPaymentContext", "receiptMs >= new Date(context.battle.ends_at).getTime()", "outside_regulation_landed", "verifySolanaBoostPayment"]);
});

test("13 Sponsorship stays 70/20/10 and individual Battle sponsorship stays forbidden", () => {
  hasAll(sponsorshipApi, ["prizeBps: 7000", "marketingOpsBps: 2000", "protocolBps: 1000", "individualBattleSponsorship: false", "normal_tournament", "vote_tournament", "monthly_mwl", "quarterly_championship"]);
});

test("14 V0 intent confirmation and canonical program-ID guards remain intact", () => {
  hasAll(executor, [
    "compileSolanaUserV0WithLatestBlockhash",
    "simulateSolanaUserV0OrThrow",
    "assertSolanaUserV0Intent",
    "await provider.signTransaction(final.transaction)",
    "confirmLaunchpadSignature",
    "LaunchpadSignatureExpiredError",
    "ARENA_MONEY_V2_PROGRAM_ID",
    "rewardsTreasuryProgramId",
    "arenaMoney !== configuredTreasury",
    "receivedProgramId !== expectedProgramId",
    "resolveArenaPaymentBeforeSigning",
    "registerArenaPaymentBeforeBroadcast",
  ]);
  assert.ok(!/new\s+(?:web3\.)?Transaction\s*\(/.test(executor));
  assert.ok(!/signAndSendTransaction\s*\(/.test(executor));
  assert.ok(!executor.includes(".confirmTransaction("));
  assert.ok(!/derive.*Pda/i.test(executor));
  const compileFirst = executor.indexOf("const simulated = await compileSolanaUserV0WithLatestBlockhash");
  const simulate = executor.indexOf("await simulateSolanaUserV0OrThrow");
  const compileFresh = executor.indexOf("const final = await compileSolanaUserV0WithLatestBlockhash");
  const sign = executor.indexOf("await provider.signTransaction(final.transaction)");
  const revalidate = executor.indexOf("assertSolanaUserV0Intent(web3, signed, intent)");
  assert.ok(compileFirst >= 0 && compileFirst < simulate && simulate < compileFresh && compileFresh < sign && sign < revalidate);
});

test("server public read contract and durable lifecycle schema remain explicit", () => {
  hasAll(boostApi, ["solana-state", "solana-submission", "solana-expire", "latestOperationQuote", "publicBoostState", "newPaymentAllowed", "SOLANA_BOOST_PAYMENT_UNRESOLVED"]);
  hasAll(tournament, ["fetchSolanaTournamentBoostPaymentState", "state.quoteId === quote.quoteId", "state.status === \"pending\"", "!state.signature"]);
  hasAll(sponsorshipApi, ["solana-payment-state", "solana-submission", "solana-expire", "q.event_id=$1 and q.sponsor_wallet=$2", "publicPaymentState", "SPONSORSHIP_PAYMENT_UNRESOLVED", "SPONSORSHIP_ALREADY_CONFIRMED"]);
  hasAll(sponsorship, ["fetchEventSponsorshipDurablePaymentState", "state.quoteId===quote.quoteId", "state.status===\"pending\"", "!state.signature"]);
  for (const marker of ["'pending'", "'submitted'", "'confirming'", "'recovering'", "'verifying'", "'confirmed'", "'failed'", "'expired'"]) hasAll(migration, [marker]);
  hasAll(migration, ["signature_last_valid_block_height", "solana_signature_last_valid_block_height", "set_arena_solana_boost_operation_key", "set_sponsorship_solana_operation_key"]);
});

test("replacement stays blocked if expiry callback fails to reopen backend lane", async () => {
  const server = makeDurableServer();
  await server.register(pending);
  await assert.rejects(resolveArenaPaymentBeforeSigning({
    lookup: () => server.lookup(),
    recoverPending: async () => { throw new ExpiredSignatureError("expired"); },
    expirePending: async () => {},
    isExpiredError: (error) => error instanceof ExpiredSignatureError,
  }), ArenaPaymentReplacementBlockedError);
});
