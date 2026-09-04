import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CANCEL_OPEN_SQL,
  applyCancelOpenUpdate,
  handleCancelOpen,
  inspectAutoDeployCancel,
} from "./arenaAutoDeployCancel.js";
import { presentAutoDeployStatus } from "../../src/lib/arena/autoDeployPresentation.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function readSrc(...parts) {
  return fs.readFileSync(path.join(here, ...parts), "utf8");
}

function waitingRow(overrides = {}) {
  return {
    id: "arena-wait-1",
    chain_id: 56,
    state: "waiting",
    source: "queue",
    tournament_id: null,
    challenger_token: "0x1111111111111111111111111111111111111111",
    defender_token: null,
    creator_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    stake_native: 1.5,
    duration_hours: 24,
    ...overrides,
  };
}

function fakeRes() {
  const captured = { status: 0, body: null };
  return {
    captured,
    res: {
      setHeader() {},
      end(text) {
        captured.body = JSON.parse(String(text || "{}"));
      },
      set statusCode(value) {
        captured.status = value;
      },
      get statusCode() {
        return captured.status;
      },
    },
  };
}

function mockQuery(plan) {
  plan.updateCalls = plan.updateCalls || [];
  return async (sql, params) => {
    const text = String(sql);
    if (text.includes("from public.arena_battles") && !text.includes("update")) {
      return { rows: plan.battle ? [plan.battle] : [] };
    }
    if (text.includes("from public.campaigns")) {
      return { rows: plan.native ? [plan.native] : [] };
    }
    if (text.includes("from public.arena_token_imports")) {
      return { rows: plan.imported ? [plan.imported] : [] };
    }
    if (text.includes("update public.arena_battles")) {
      plan.updateCalls.push({ text, params });
      return { rows: plan.updateRows || [] };
    }
    return { rows: [] };
  };
}

async function runCancel(plan, auth = { walletAddress: waitingRow().creator_address }) {
  const { res, captured } = fakeRes();
  await handleCancelOpen({ method: "POST" }, res, plan.battle?.id || "arena-wait-1", {
    query: mockQuery(plan),
    readJson: async () => ({ auth }),
    requireWalletActionAuth: async ({ expectedWallet, auth: payload, res: inner }) => {
      const got = String(payload?.walletAddress || "").toLowerCase();
      const expected = String(expectedWallet || "").toLowerCase();
      if (got !== expected) {
        inner.statusCode = 401;
        inner.end(JSON.stringify({ ok: false, error: "Connected wallet does not match request." }));
        return null;
      }
      return { walletAddress: expectedWallet };
    },
    nowIso: () => "2026-09-03T12:00:00.000Z",
  });
  return captured;
}

test("waiting source=queue is presented as AUTO DEPLOY searching", () => {
  assert.equal(presentAutoDeployStatus({ currentState: "waiting", eligibility: false }, { source: "queue", state: "waiting" }), "searching");
  assert.equal(presentAutoDeployStatus({ eligibility: true, currentState: "eligible" }, null), "available");
  assert.equal(presentAutoDeployStatus({ currentState: "matched" }, { source: "queue", state: "matched" }), "funding");
});

test("creator can disable their own waiting AUTO DEPLOY row to expired", async () => {
  const row = waitingRow();
  const captured = await runCancel({
    battle: row,
    native: { creator_address: row.creator_address },
    updateRows: [{ id: row.id, state: "expired", source: "queue", challenger_token: row.challenger_token }],
  });
  assert.equal(captured.status, 200);
  assert.equal(captured.body.state, "expired");
  assert.equal(captured.body.ok, true);
});

test("another wallet cannot disable AUTO DEPLOY", async () => {
  const row = waitingRow();
  const captured = await runCancel(
    { battle: row, native: { creator_address: row.creator_address }, updateRows: [{ id: row.id, state: "expired" }] },
    { walletAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
  );
  assert.equal(captured.status, 401);
});

test("challenged cannot be disabled through AUTO DEPLOY", () => {
  const blocked = inspectAutoDeployCancel(waitingRow({ state: "challenged", source: "challenge" }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.code, "NOT_QUEUE");
});

test("matched cannot be disabled", () => {
  const blocked = inspectAutoDeployCancel(waitingRow({ state: "matched" }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "STATE_CHANGED");
});

test("live cannot be disabled", () => {
  const blocked = inspectAutoDeployCancel(waitingRow({ state: "live" }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "STATE_CHANGED");
});

test("tournament row cannot be disabled", () => {
  const blocked = inspectAutoDeployCancel(waitingRow({ source: "tournament", tournament_id: "t1", state: "waiting" }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "TOURNAMENT_BATTLE");
});

test("cancellation losing a race to matching returns conflict and does not undo the match", async () => {
  const row = waitingRow();
  const plan = {
    battle: row,
    native: { creator_address: row.creator_address },
    updateRows: [],
  };
  const query = mockQuery(plan);
  const { res, captured } = fakeRes();
  let selects = 0;
  const wrapped = async (sql, params) => {
    const text = String(sql);
    if (text.includes("from public.arena_battles") && !text.includes("update")) {
      selects += 1;
      if (selects > 1) return { rows: [{ ...row, state: "matched", source: "queue" }] };
    }
    return query(sql, params);
  };
  await handleCancelOpen({ method: "POST" }, res, row.id, {
    query: wrapped,
    readJson: async () => ({ auth: { walletAddress: row.creator_address } }),
    requireWalletActionAuth: async () => ({ walletAddress: row.creator_address }),
    nowIso: () => "2026-09-03T12:00:00.000Z",
  });
  assert.equal(captured.status, 409);
  assert.equal(captured.body.code, "STATE_CHANGED");
  assert.equal(captured.body.currentState, "matched");
  assert.equal(plan.updateCalls.length, 1);
  assert.match(plan.updateCalls[0].text, /state = 'waiting'/);
  assert.match(plan.updateCalls[0].text, /source = 'queue'/);
  assert.equal(plan.updateCalls[0].params[0], row.id);
});

test("conditional update SQL never blindly expires unmatched states", async () => {
  assert.match(CANCEL_OPEN_SQL, /state = 'waiting'/);
  assert.match(CANCEL_OPEN_SQL, /source = 'queue'/);
  const missed = await applyCancelOpenUpdate(async () => ({ rows: [] }), "arena-wait-1", "now");
  assert.equal(missed, null);
});

test("imported and native owners use the same cancel path", async () => {
  const row = waitingRow({ creator_address: "0xcccccccccccccccccccccccccccccccccccccccc" });
  const captured = await runCancel(
    {
      battle: row,
      imported: { owner_wallet: row.creator_address },
      updateRows: [{ id: row.id, state: "expired", source: "queue" }],
    },
    { walletAddress: row.creator_address },
  );
  assert.equal(captured.status, 200);
  assert.equal(captured.body.state, "expired");
});

test("AUTO DEPLOY wiring preserves open/queue matching and the manual challenge path", () => {
  const battles = readSrc("../arenaBattles.js");
  const ui = readSrc("../../src/pages/command-center/CommandCenterBattles.tsx");
  const client = readSrc("../../src/features/postgrad/apiClient.ts");
  const cancel = readSrc("./arenaAutoDeployCancel.js");
  const netlify = readSrc("../../netlify/functions/api.mjs");

  assert.match(battles, /async function tryAutoMatch/);
  assert.match(battles, /\/arena\/battles\/open/);
  assert.match(battles, /source: "queue"/);
  assert.match(battles, /handleCancelOpen/);
  assert.doesNotMatch(battles.split("async function tryAutoMatch")[1].split("async function currentMcap")[0], /cancel-open/);

  assert.match(ui, /ENABLE AUTO DEPLOY/);
  assert.match(ui, /AUTO DEPLOY: SEARCHING/);
  assert.match(ui, /DISABLE AUTO DEPLOY/);
  assert.match(ui, /openPostGradBattle/);
  assert.match(ui, /arena_open_battle/);
  assert.match(ui, /arena_cancel_open_battle/);
  assert.match(ui, /const \[stake, setStake\]/);
  assert.match(ui, /const \[durationHours, setDurationHours\]/);
  assert.match(ui, /FindMatchPanel/);
  assert.match(ui, /setChallengeTarget\(tokenId\)/);
  assert.match(ui, /challengePostGradBattle/);
  assert.match(ui, /acceptPostGradBattle/);
  assert.match(ui, /counterPostGradBattle/);
  assert.match(ui, /declinePostGradBattle/);
  assert.match(ui, /item.origin === "import" \? "imported" : "graduated"/);
  assert.doesNotMatch(ui, /BattleCombatEffects/);

  assert.match(client, /\/api\/arena\/battles\/open/);
  assert.match(client, /\/cancel-open/);
  assert.match(netlify, /battles\/:battleId\/cancel-open/);
  assert.doesNotMatch(cancel, /signTransaction|sendTransaction|wallet.sign/);
  assert.doesNotMatch(cancel, /calculateMatchQuality|marketCapWeight|tryAutoMatch/);
});
