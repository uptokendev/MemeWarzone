import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";

import { battlePoolId, tournamentPoolId } from "./arenaWarPoolEscrow.js";
import { classifyLeaguePool, crankLeagueShares, leagueCrankMode, leagueEpochsFor, planWarPoolSteps } from "./arenaEvmLeagueCrank.js";

const resolvedPool = (over = {}) => ({ state: 2n, pendingProtocol: 100n, claimedProtocol: false, pendingLeague: 800n, claimedLeague: false, ...over });
const livePool = () => ({ state: 1n, pendingProtocol: 0n, claimedProtocol: false, pendingLeague: 0n, claimedLeague: false });

test("epochs follow the settlement month, in the format the app already hands out", () => {
  const e = leagueEpochsFor("2026-09-30T23:59:59Z");
  assert.equal(e.monthKey, "2026-09");
  assert.equal(e.quarterKey, "2026-Q3");
  assert.equal(e.monthlyEpoch, ethers.id("2026-09"));
  assert.equal(e.quarterlyEpoch, ethers.id("2026-Q3"));
  assert.equal(leagueEpochsFor("2026-10-01T00:00:00Z").quarterKey, "2026-Q4");
  assert.equal(leagueEpochsFor("2027-01-01T00:00:00Z").monthKey, "2027-01");
  assert.throws(() => leagueEpochsFor("nope"), /LEAGUE_EPOCH_DATE_INVALID/);
});

test("league claim only for a resolved, unclaimed pool with a league share", () => {
  assert.equal(classifyLeaguePool(resolvedPool()).action, "claim");
  assert.equal(classifyLeaguePool(resolvedPool({ claimedLeague: true })).reason, "already-claimed");
  assert.equal(classifyLeaguePool(resolvedPool({ pendingLeague: 0n })).reason, "no-league-share");
});

test("steps: live -> resolve; resolved -> protocol then league; nothing left -> terminal", () => {
  assert.deepEqual(planWarPoolSteps(livePool()).steps, ["resolve"]);
  assert.deepEqual(planWarPoolSteps(resolvedPool()).steps, ["claimProtocol", "claimLeague"]);
  assert.deepEqual(planWarPoolSteps(resolvedPool({ claimedProtocol: true })).steps, ["claimLeague"]);
  assert.equal(planWarPoolSteps(resolvedPool({ claimedProtocol: true, claimedLeague: true })).terminal, true);
  assert.equal(planWarPoolSteps({ state: 3n }).terminal, true, "cancelled");
  assert.deepEqual(planWarPoolSteps({ state: 0n, pendingProtocol: 0n, pendingLeague: 0n }).steps, [], "an open (never live) pool is left alone");
  assert.equal(planWarPoolSteps({ state: 0n }).terminal, false);
});

test("mode is off unless explicitly dry or send", () => {
  assert.equal(leagueCrankMode({}), "off");
  assert.equal(leagueCrankMode({ ARENA_EVM_LEAGUE_CRANK: "true" }), "off");
  assert.equal(leagueCrankMode({ ARENA_EVM_LEAGUE_CRANK: "DRY" }), "dry");
  assert.equal(leagueCrankMode({ ARENA_EVM_LEAGUE_CRANK: "send" }), "send");
});

// A fake V2 war pool that applies resolve / claims to its own state, like the contract.
function fakeChain(initial, { balance = 10n ** 16n, failStatic = false } = {}) {
  const pools = Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, { ...v }]));
  const sent = [];
  const method = (name, apply) => {
    const fn = async (...args) => { sent.push({ name, args }); apply(...args); return { hash: `0x${name}${sent.length}`, wait: async () => ({ status: 1 }) }; };
    fn.staticCall = async () => { if (failStatic) throw new Error("InvalidState"); };
    return fn;
  };
  const contract = {
    pools: async (id) => pools[id] || { state: 0n, pendingProtocol: 0n, claimedProtocol: false, pendingLeague: 0n, claimedLeague: false },
    resolve: method("resolve", (id) => { pools[id] = { ...pools[id], state: 2n, pendingProtocol: 50n, pendingLeague: 400n }; }),
    resolvePlaces: method("resolvePlaces", (id) => { pools[id] = { ...pools[id], state: 2n, pendingProtocol: 5n, pendingLeague: 40n }; }),
    claimProtocol: method("claimProtocol", (id) => { pools[id] = { ...pools[id], claimedProtocol: true, pendingProtocol: 0n }; }),
    claimLeague: method("claimLeague", (id) => { pools[id] = { ...pools[id], claimedLeague: true, pendingLeague: 0n }; }),
  };
  return { sent, pools, c: { wallet: { address: "0xop" }, provider: { getBalance: async () => balance }, contract } };
}

const signedFor = (poolId, version = "2") => async () => ({
  status: 200,
  body: { ok: true, poolId, resolve: version === "2-places"
    ? { version, payouts: ["0xA"], bps: [10000], deadline: 9, signature: "0xsig" }
    : { version, winnerPayout: "0xWinner", deadline: 9, signature: "0xsig" } },
});

test("send: a live pool is resolved with the server-signed result, then both shares move, in one pass", async () => {
  const id = battlePoolId("b-live");
  const bnb = fakeChain({ [id]: livePool() });
  const db = { query: async () => ({ rows: [{ kind: "battle", id: "b-live", chain_id: 56, settled_at: new Date("2026-10-02T11:35:00Z") }] }) };
  const terminal = new Set();
  const out = await crankLeagueShares({ db, mode: "send", terminal, contractFor: (c) => (c === 56 ? bnb.c : null), resolutionFor: signedFor(id) });
  assert.deepEqual(bnb.sent.map((s) => s.name), ["resolve", "claimProtocol", "claimLeague"]);
  assert.deepEqual(bnb.sent[0].args, [id, "0xWinner", 9, "0xsig"]);
  assert.deepEqual(bnb.sent[2].args, [id, ethers.id("2026-10"), ethers.id("2026-Q4")]);
  assert.ok(out.every((o) => o.status === "sent"));
  assert.ok(terminal.has(`56:${id}`));
  // Done pools are never read again.
  const reads = [];
  await crankLeagueShares({ db, mode: "send", terminal, contractFor: (c) => (c === 56 ? { ...bnb.c, contract: { ...bnb.c.contract, pools: async (p) => { reads.push(p); return resolvedPool(); } } } : null), resolutionFor: signedFor(id) });
  assert.deepEqual(reads, []);
});

test("a tournament resolves through resolvePlaces", async () => {
  const id = tournamentPoolId("t-1");
  const rh = fakeChain({ [id]: livePool() });
  const db = { query: async () => ({ rows: [{ kind: "tournament", id: "t-1", chain_id: 4663, settled_at: new Date("2026-10-01T09:00:00Z") }] }) };
  await crankLeagueShares({ db, mode: "send", contractFor: (c) => (c === 4663 ? rh.c : null), resolutionFor: signedFor(id, "2-places") });
  assert.deepEqual(rh.sent.map((s) => s.name), ["resolvePlaces", "claimProtocol", "claimLeague"]);
});

test("dry: reports the first step only and sends nothing", async () => {
  const id = battlePoolId("b-live");
  const bnb = fakeChain({ [id]: livePool() });
  const db = { query: async () => ({ rows: [{ kind: "battle", id: "b-live", chain_id: 56, settled_at: new Date("2026-10-02T11:35:00Z") }] }) };
  const out = await crankLeagueShares({ db, mode: "dry", contractFor: (c) => (c === 56 ? bnb.c : null), resolutionFor: signedFor(id) });
  assert.equal(bnb.sent.length, 0);
  assert.deepEqual(out.map((o) => [o.step, o.status, o.winner]), [["resolve", "dry-run", "0xWinner"]]);
});

test("a missing or mismatched resolution blocks; no gas or a failed simulation never sends", async () => {
  const id = battlePoolId("b-live");
  const db = { query: async () => ({ rows: [{ kind: "battle", id: "b-live", chain_id: 56, settled_at: new Date("2026-10-02T11:35:00Z") }] }) };

  const a = fakeChain({ [id]: livePool() });
  const [missing] = await crankLeagueShares({ db, mode: "send", contractFor: (c) => (c === 56 ? a.c : null), resolutionFor: async () => ({ status: 503, body: { ok: false, code: "WAR_POOL_RESOLVER_MISSING" } }) });
  assert.equal(missing.status, "blocked");
  assert.match(missing.reason, /WAR_POOL_RESOLVER_MISSING/);

  const b = fakeChain({ [id]: livePool() });
  const [wrong] = await crankLeagueShares({ db, mode: "send", contractFor: (c) => (c === 56 ? b.c : null), resolutionFor: signedFor(battlePoolId("other")) });
  assert.match(wrong.reason, /different pool/);

  const poor = fakeChain({ [id]: resolvedPool() }, { balance: 0n });
  const [noGas] = await crankLeagueShares({ db, mode: "send", contractFor: (c) => (c === 56 ? poor.c : null) });
  assert.equal(noGas.status, "no-gas");

  const raced = fakeChain({ [id]: resolvedPool() }, { failStatic: true });
  const [failed] = await crankLeagueShares({ db, mode: "send", contractFor: (c) => (c === 56 ? raced.c : null) });
  assert.equal(failed.status, "send-failed");
  assert.equal(a.sent.length + b.sent.length + poor.sent.length + raced.sent.length, 0);
});
