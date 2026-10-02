import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";

import { battlePoolId, tournamentPoolId } from "./arenaWarPoolEscrow.js";
import { classifyLeaguePool, crankLeagueShares, leagueCrankMode, leagueEpochsFor } from "./arenaEvmLeagueCrank.js";

const resolved = (over = {}) => ({ state: 2n, pendingLeague: 800n, claimedLeague: false, ...over });

test("epochs follow the settlement month, in the format the app already hands out", () => {
  const e = leagueEpochsFor("2026-09-30T23:59:59Z");
  assert.equal(e.monthKey, "2026-09");
  assert.equal(e.quarterKey, "2026-Q3");
  assert.equal(e.monthlyEpoch, ethers.id("2026-09"));
  assert.equal(e.quarterlyEpoch, ethers.id("2026-Q3"));
  assert.equal(leagueEpochsFor("2026-10-01T00:00:00Z").quarterKey, "2026-Q4");
  assert.equal(leagueEpochsFor("2026-12-15T00:00:00Z").quarterKey, "2026-Q4");
  assert.equal(leagueEpochsFor("2027-01-01T00:00:00Z").monthKey, "2027-01");
  assert.throws(() => leagueEpochsFor("nope"), /LEAGUE_EPOCH_DATE_INVALID/);
});

test("only a resolved, unclaimed pool with a league share is claimed", () => {
  assert.equal(classifyLeaguePool(resolved()).action, "claim");
  assert.deepEqual(classifyLeaguePool(resolved({ claimedLeague: true })), { action: "skip", terminal: true, reason: "already-claimed" });
  assert.deepEqual(classifyLeaguePool(resolved({ pendingLeague: 0n })), { action: "skip", terminal: true, reason: "no-league-share" });
  assert.deepEqual(classifyLeaguePool({ state: 3n, pendingLeague: 0n, claimedLeague: false }), { action: "skip", terminal: true, reason: "cancelled" });
  assert.deepEqual(classifyLeaguePool({ state: 1n, pendingLeague: 0n, claimedLeague: false }), { action: "skip", terminal: false, reason: "not-resolved" });
  assert.deepEqual(classifyLeaguePool({ state: 0n, pendingLeague: 0n, claimedLeague: false }), { action: "skip", terminal: false, reason: "not-resolved" }, "a pool that was never opened reads as zeros");
});

test("mode is off unless explicitly dry or send", () => {
  assert.equal(leagueCrankMode({}), "off");
  assert.equal(leagueCrankMode({ ARENA_EVM_LEAGUE_CRANK: "true" }), "off");
  assert.equal(leagueCrankMode({ ARENA_EVM_LEAGUE_CRANK: "DRY" }), "dry");
  assert.equal(leagueCrankMode({ ARENA_EVM_LEAGUE_CRANK: "send" }), "send");
});

function fakeChain(poolsById, { balance = 10n ** 16n, failStatic = false } = {}) {
  const sent = [];
  const claimLeague = async (poolId, m, q) => { sent.push({ poolId, m, q }); return { hash: `0xtx${sent.length}`, wait: async () => ({ status: 1 }) }; };
  claimLeague.staticCall = async () => { if (failStatic) throw new Error("NothingToClaim"); };
  return {
    sent,
    c: {
      wallet: { address: "0xop" },
      provider: { getBalance: async () => balance },
      contract: { pools: async (id) => poolsById[id] || { state: 0n, pendingLeague: 0n, claimedLeague: false }, claimLeague },
    },
  };
}

const rows = [
  { kind: "battle", id: "b-sept", chain_id: 56, settled_at: new Date("2026-09-29T10:00:00Z") },
  { kind: "battle", id: "b-oct", chain_id: 56, settled_at: new Date("2026-10-02T11:35:00Z") },
  { kind: "battle", id: "b-done", chain_id: 56, settled_at: new Date("2026-10-02T11:00:00Z") },
  { kind: "tournament", id: "t-1", chain_id: 4663, settled_at: new Date("2026-10-01T09:00:00Z") },
];
const db = { query: async () => ({ rows }) };

test("send: claims each pool under its own settlement month, never under 'now'", async () => {
  const bnb = fakeChain({ [battlePoolId("b-sept")]: resolved(), [battlePoolId("b-oct")]: resolved(), [battlePoolId("b-done")]: resolved({ claimedLeague: true }) });
  const rh = fakeChain({ [tournamentPoolId("t-1")]: resolved({ pendingLeague: 5n }) });
  const terminal = new Set();
  const out = await crankLeagueShares({ db, mode: "send", terminal, contractFor: (id) => (id === 56 ? bnb.c : id === 4663 ? rh.c : null) });
  assert.deepEqual(bnb.sent.map((s) => s.m), [ethers.id("2026-09"), ethers.id("2026-10")]);
  assert.deepEqual(bnb.sent.map((s) => s.q), [ethers.id("2026-Q3"), ethers.id("2026-Q4")]);
  assert.equal(rh.sent[0].poolId, tournamentPoolId("t-1"));
  assert.ok(out.every((o) => o.status === "claimed"));
  // Claimed and already-claimed pools are terminal: a second pass reads and sends nothing.
  const reads = [];
  const again = await crankLeagueShares({ db, mode: "send", terminal, contractFor: (id) => (id === 56 ? { ...bnb.c, contract: { ...bnb.c.contract, pools: async (p) => { reads.push(p); return resolved(); } } } : null) });
  assert.deepEqual(again, []);
  assert.deepEqual(reads, []);
});

test("dry: reads and reports, sends nothing, marks nothing terminal that still needs a claim", async () => {
  const bnb = fakeChain({ [battlePoolId("b-oct")]: resolved() });
  const terminal = new Set();
  const out = await crankLeagueShares({ db, mode: "dry", terminal, contractFor: (id) => (id === 56 ? bnb.c : null) });
  assert.equal(bnb.sent.length, 0);
  assert.deepEqual(out.map((o) => [o.subject, o.status, o.month]), [["b-oct", "dry-run", "2026-10"]]);
  assert.ok(!terminal.has(`56:${battlePoolId("b-oct")}`));
});

test("no gas, a failed simulation, or off mode never sends", async () => {
  const poor = fakeChain({ [battlePoolId("b-oct")]: resolved() }, { balance: 0n });
  const out = await crankLeagueShares({ db, mode: "send", contractFor: (id) => (id === 56 ? poor.c : null) });
  assert.equal(out[0].status, "no-gas");
  assert.equal(poor.sent.length, 0);

  const raced = fakeChain({ [battlePoolId("b-oct")]: resolved() }, { failStatic: true });
  const out2 = await crankLeagueShares({ db, mode: "send", contractFor: (id) => (id === 56 ? raced.c : null) });
  assert.equal(out2[0].status, "send-failed");
  assert.equal(raced.sent.length, 0);

  let touched = false;
  assert.deepEqual(await crankLeagueShares({ db: { query: async () => { touched = true; return { rows }; } }, mode: "off" }), []);
  assert.equal(touched, false);
});
