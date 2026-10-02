import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyClaimOutcome,
  classifyResolveOutcome,
  operatorClaimsMode,
  operatorClaimsSettled,
  runOperatorClaims,
  runResolveDuePass,
} from "./arena-operator-scan.mjs";

test("claims are off unless ARENA_OPERATOR_CLAIMS is dry or send", () => {
  assert.equal(operatorClaimsMode({}), "off");
  assert.equal(operatorClaimsMode({ ARENA_OPERATOR_CLAIMS: "true" }), "off");
  assert.equal(operatorClaimsMode({ ARENA_OPERATOR_CLAIMS: "Dry" }), "dry");
  assert.equal(operatorClaimsMode({ ARENA_OPERATOR_CLAIMS: "send" }), "send");
});

test("claim outcomes map planOperatorClaim / runOperatorJob results", () => {
  assert.equal(classifyClaimOutcome({ ok: true, action: "sent", signature: "sig" }).state, "claimed");
  assert.equal(classifyClaimOutcome({ ok: true, action: "skip", reason: "already-claimed" }).state, "nothing-to-claim");
  assert.equal(classifyClaimOutcome({ ok: false, action: "block", reason: "nothing-to-claim" }).state, "nothing-to-claim");
  assert.deepEqual(classifyClaimOutcome({ ok: true, action: "claim", sent: false, amount: 80000000n }), { state: "planned", reason: "would claim 80000000 lamports", signature: null });
  assert.equal(classifyClaimOutcome({ ok: false, action: "block", reason: "pool-not-resolved" }).state, "blocked");
  assert.equal(classifyClaimOutcome(null).state, "blocked");
});

test("both shares are claimed in order, with send only in send mode", async () => {
  const calls = [];
  const out = await runOperatorClaims({ mode: "send", runClaim: async (cmd, send) => { calls.push([cmd, send]); return { ok: true, action: "sent", signature: cmd }; } });
  assert.deepEqual(calls, [["claim-mwl", true], ["claim-protocol", true]]);
  assert.ok(operatorClaimsSettled(out));

  const dry = [];
  const planned = await runOperatorClaims({ mode: "dry", runClaim: async (cmd, send) => { dry.push(send); return { ok: true, action: "claim", sent: false, amount: 1n }; } });
  assert.deepEqual(dry, [false, false]);
  assert.ok(!operatorClaimsSettled(planned), "a dry run never settles a pool");

  assert.deepEqual(await runOperatorClaims({ mode: "off", runClaim: async () => { throw new Error("must not run"); } }), []);
});

test("a thrown claim is blocked and keeps the pool unsettled", async () => {
  const out = await runOperatorClaims({ mode: "send", runClaim: async (cmd) => { if (cmd === "claim-mwl") throw new Error("rpc 429"); return { ok: true, action: "sent" }; } });
  assert.equal(out[0].state, "blocked");
  assert.equal(out[1].state, "claimed");
  assert.ok(!operatorClaimsSettled(out));
});

test("a resolved battle with an unclaimed share stays in the loop until both are gone", async () => {
  assert.equal(classifyResolveOutcome({ ok: true, action: "skip", claimsPending: true }).terminal, false);
  assert.equal(classifyResolveOutcome({ ok: true, action: "skip", claimsPending: true }).state, "already-resolved");
  assert.equal(classifyResolveOutcome({ ok: true, action: "skip", claimsPending: false }).terminal, true);

  const row = { id: "arena-muoo3g87-1efbe9", chain_id: 101, state: "finished" };
  const settled = new Set();
  const quiet = { log() {}, warn() {} };
  let pending = true;
  const resolveBattle = async () => ({ ok: true, action: "skip", reason: "already-resolved", claimsPending: pending });
  await runResolveDuePass({ loadDueRows: async () => [row], resolveBattle, settled, logger: quiet });
  assert.ok(!settled.has(row.id));
  pending = false;
  await runResolveDuePass({ loadDueRows: async () => [row], resolveBattle, settled, logger: quiet });
  assert.ok(settled.has(row.id));
});

import { buildDueTournamentQuery, selectDueBattles } from "./arena-operator-scan.mjs";

test("finished Solana tournaments are scanned too, as kind 'tournament'", () => {
  const q = buildDueTournamentQuery({ lookbackDays: 30, limit: 10 });
  assert.match(q.text, /'tournament' as kind/);
  assert.match(q.text, /t\.status = 'finished'/);
  assert.deepEqual(q.params, [101, "30", 10]);
  const rows = selectDueBattles([
    { id: "tour-1", chain_id: 101, state: "finished", kind: "tournament" },
    { id: "arena-1", chain_id: 101, state: "finished" },
    { id: "tour-1", chain_id: 101, state: "finished", kind: "tournament" },
  ]);
  assert.deepEqual(rows.map((r) => [r.id, r.kind || "battle"]), [["tour-1", "tournament"], ["arena-1", "battle"]]);
});

test("the worker dispatches tournaments to resolve-tournament and records their share as kind 'tournament'", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("./arena-operator-worker.mjs", import.meta.url), "utf8");
  assert.match(src, /if \(row\.kind === "tournament"\) return resolveTournament\(row\)/);
  assert.match(src, /command: "resolve-tournament"/);
  assert.match(src, /sweepShares\(\{ kind: "tournament"/);
  assert.match(src, /buildDueTournamentQuery\(\{ lookbackDays, limit \}\)/);
});
