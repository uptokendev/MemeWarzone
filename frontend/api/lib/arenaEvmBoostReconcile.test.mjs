import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://unused@127.0.0.1:1/unused";
const { blockRangeFor, reconcileEvmBoostPayments, BATTLE_BOOSTED_TOPIC } = await import("./arenaEvmBoostReconcile.js");
const { Interface, zeroPadValue } = await import("ethers");
const { expectedBattleBoostPoolId } = await import("./arenaBoostChainVerification.mjs");

const TREASURY = "0x" + "7".repeat(40);
const WALLET = "0x" + "b".repeat(40);
const TOKEN = "0x" + "1".repeat(40);
const iface = new Interface(["event BattleBoosted(bytes32 indexed poolId,address indexed booster,address indexed sideToken,uint256 boostUnits,uint256 unitPriceNativeRaw,uint256 grossNativeRaw,uint256 pricingVersion,uint256 oracleTimestamp,uint256 nonce)"]);

function chain({ nowSec, logs = [] }) {
  const latest = 50_000;
  const genesis = nowSec - latest;
  return {
    genesis,
    async getBlockNumber() { return latest; },
    async getBlock(n) { return { timestamp: genesis + Number(n) }; },
    async getLogs({ topics, fromBlock, toBlock }) {
      return logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock && topics.every((t, i) => String(l.topics[i]).toLowerCase() === String(t).toLowerCase()));
    },
  };
}

function fakeDb(rows) {
  const updates = [];
  return {
    updates,
    async query(text, params) {
      if (/from public\.arena_boost_quote_reservations/.test(text)) return { rows };
      if (/update public\.arena_boost_quote_reservations/.test(text)) { updates.push({ text, params }); return { rows: [] }; }
      return { rows: [] };
    },
  };
}

test("block range covers the quote window with margin on both sides", async () => {
  const nowSec = 1_800_000_000;
  const provider = chain({ nowSec });
  const { fromBlock, toBlock } = await blockRangeFor(provider, (nowSec - 900) * 1000, (nowSec - 600) * 1000);
  assert.ok(provider.genesis + fromBlock <= nowSec - 900 - 180);
  assert.ok(provider.genesis + toBlock >= nowSec - 600);
  assert.ok(toBlock - fromBlock < 3_000);
});

test("paid quote is recorded from its log; unpaid expired quote is voided; refusal is noted once", async () => {
  const nowSec = 1_800_000_000;
  const nowMs = nowSec * 1000;
  const iso = (sec) => new Date(sec * 1000).toISOString();
  const ev = iface.encodeEventLog("BattleBoosted", [expectedBattleBoostPoolId("b-1"), WALLET, TOKEN, 1n, 1000n, 1000n, 1n, BigInt(nowSec - 900), 21n]);
  const provider = chain({ nowSec });
  const log = { address: TREASURY, topics: ev.topics, data: ev.data, index: 4, transactionHash: "0x" + "a".repeat(64), blockNumber: nowSec - 850 - provider.genesis };
  const withLog = chain({ nowSec, logs: [log] });
  assert.equal(ev.topics[0], BATTLE_BOOSTED_TOPIC);
  assert.equal(ev.topics[2].toLowerCase(), zeroPadValue(WALLET, 32).toLowerCase());

  const base = { chain_id: 56, battle_id: "b-1", tournament_id: null, round_number: 0, match_id: null, wallet: WALLET, treasury_address: TREASURY, created_at: iso(nowSec - 900), deadline: iso(nowSec - 600), status: "pending" };
  const db = fakeDb([{ ...base, id: 1, nonce: "21" }, { ...base, id: 2, nonce: "22" }, { ...base, id: 3, nonce: "21", battle_id: "b-1" }]);
  const recorded = [];
  let calls = 0;
  const summary = await reconcileEvmBoostPayments({
    db, nowMs, getProvider: async () => withLog,
    readNonceUsed: async (row) => row.nonce === "21",
    recorders: {
      battle: async (body) => { recorded.push(body); calls += 1; return calls === 1 ? { status: 201, body: { ok: true } } : { status: 409, body: { ok: false, error: "Boost is only available for a live Battle" } }; },
      tournament: async () => { throw new Error("not a tournament"); },
    },
    logger: { warn() {} },
  });
  assert.deepEqual([summary.recorded, summary.voided, summary.refused, summary.errors.length], [1, 1, 1, 0]);
  assert.deepEqual(
    [recorded[0].txHash, recorded[0].logIndex, recorded[0].wallet, recorded[0].targetToken, recorded[0].boostUnits, recorded[0].grossNativeRaw, recorded[0].poolNativeRaw, recorded[0].protocolNativeRaw],
    ["0x" + "a".repeat(64), 4, WALLET, TOKEN, "1", "1000", "900", "100"],
  );
  assert.ok(db.updates.some((u) => /set status = 'void'/.test(u.text) && u.params[0] === 2));
  const note = db.updates.find((u) => /record_note = \$4/.test(u.text));
  assert.equal(note.params[0], 3);
  assert.match(note.params[3], /live Battle/);
});

test("RPC failure keeps the reservation for the next run", async () => {
  const db = fakeDb([{ id: 9, chain_id: 56, battle_id: "b", wallet: WALLET, nonce: "1", treasury_address: TREASURY, created_at: new Date().toISOString(), deadline: new Date(Date.now() - 600_000).toISOString(), status: "pending" }]);
  const summary = await reconcileEvmBoostPayments({ db, getProvider: async () => ({}), readNonceUsed: async () => { throw new Error("rpc down"); }, recorders: {} });
  assert.equal(summary.errors.length, 1);
  assert.equal(db.updates.length, 0);
});

test("browser reports EVM Boosts and the worker runs the backstop", () => {
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
  assert.match(read("../../src/components/arena/BattleBoostPanel.tsx"), /reportBattleBoostPayment\(\{ chainId, battleId, txHash: submitted\.txHash \}\)/);
  assert.match(read("../../src/components/arena/TournamentBoostControls.tsx"), /reportTournamentBoostPayment\(\{ tournamentId, matchRef, chainId, txHash: submitted\.txHash \}\)/);
  assert.match(read("../../scripts/run-arena-battle-realtime-worker.mjs"), /reconcileEvmBoostPayments\(\{ db: pool \}\)/);
  assert.match(read("../arenaBoosts.js"), /"\/arena\/boosts\/evm-payment"/);
  assert.match(read("../arenaTournamentBoosts.js"), /\(quote\|confirm\|evm-payment\)/);
});
