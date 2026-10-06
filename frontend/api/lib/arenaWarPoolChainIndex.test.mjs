import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ethers } from "ethers";

import {
  EVM_TOPICS,
  amountFromReceipt,
  base58Decode,
  battlePoolIdHex,
  decodeEvmArenaLog,
  decodeEvmBucket,
  decodeSolanaArenaTransaction,
  indexSolanaArena,
  movementRow,
  programDataByInstruction,
  receiptDepositSql,
  subjectMap,
  tournamentPoolIdHex,
} from "./arenaWarPoolChainIndex.js";
import { battlePoolId, tournamentPoolId } from "./arenaWarPoolEscrow.js";

// Real mainnet transactions of battle arena-mugwhj11-9b1973 (getTransaction, encoding "json",
// trimmed to the fields the decoder reads), fetched 2026-10-06.
const TXS = JSON.parse(readFileSync(new URL("./arenaWarPoolChainIndex.fixtures.json", import.meta.url), "utf8"));
const OPEN = "495VDDq3qqns3EWDeSUQPmen1fy1mC8ipUeb1fGNMuwYLG3NHi9v726mYvmepRXWsQghT2sNgNryNtE1qEvxRRAM";
const STAKE_B = "3khothUkon3qshHTjHGv8LfyKoZ3p7hedJ4LVGQ3oFtqLRVTSveiG7Q5PrdC2KUn2HfyHFAvgt1ai84U28pWQF7";
const BOOST = "wq3g1nJhrQwABy8j4qLJuVbvK3WL4vmV2SqrsMqq1PDBTLo1E1K7EdJSMwSMy1spsTyY9BPmsGbm5ySuPCQDwD9";
const RESOLVE = "5oAFoXsdrEdHUhzXZ4x2AnbYFQM4AMFkPLiW2L4JRgm8dLHk8XDViCttVMtrSFwvuevbKvTvixYprGABw6anq6mr";
const CLAIM_WINNER = "5tSmpCDrgJLQgaPPeRHBSTZAbeeVYY4yyZV3ZbiWLNhZqgXo2AoRfdoSXvZgCpqWDg99jnZkqtDDAbKQQPJiKnS9";
const CLAIM_PROTOCOL = "4Re9cf3ER27H9cHSLcdqfWqPjAegZgc7aKPdrjzjQrK2aQRSQpSefEpvSMtdjXiSdSvMMqdVzGGeHVScwt8GEzNn";
const CLAIM_MWL = "4Arn46wNchbCHa3wWQVapcQ4qaxP1rjRPXbJgWmS3V5KiraPpTkFGWSsh8WswGBrNbmsXzJNaW7qxvsT88377fq3";
const POOL = "0xc6e87fbb715159082bef6c682e926810ac47e6d893c8cc5cd4cb0c92edb6b8b7";
const BATTLE = "arena-mugwhj11-9b1973";
const OWNER_A = "7ZkEpeo8zcawdj39wpDtB7MbzkbyhNoQyVXLsswazohv";
const OWNER_B = "BVTKvynQ8VBJKKA2uau4FC4mNoTmkmb1t4h1y8gMv3Gk";

// The claim receipts of the same pool, read on mainnet 2026-10-05 (getMultipleAccounts, base64).
const RECEIPTS = {
  winner: "qRI34kwavhTG6H+7cVFZCCvvbGgukmgQrEfm2JPIzFzUywyS7ba4twCb3uY2FPVZ94zqvtFU1+hZ16ZO3puH0dDWVtqFL2Wkgd1brQYAAAAA/w==",
  protocol: "qRI34kwavhTG6H+7cVFZCCvvbGgukmgQrEfm2JPIzFzUywyS7ba4twGiQvtRL26GHZVluaVGJcE4zX0En0+zFgClIjcbUJ+jVe0QiwAAAAAA+w==",
  mwl: "qRI34kwavhTG6H+7cVFZCCvvbGgukmgQrEfm2JPIzFzUywyS7ba4twIFr3UcbxFPfI98EH6BGLq8/G1XNCIlxZMlAnma6eEdSAAtMQEAAAAA/w==",
};

const plain = (value) => JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

test("pool ids are the app's battlePoolId / tournamentPoolId without ethers", () => {
  assert.equal(battlePoolIdHex(BATTLE), POOL);
  assert.equal(battlePoolIdHex(BATTLE), battlePoolId(BATTLE));
  assert.equal(tournamentPoolIdHex("tour-1"), tournamentPoolId("tour-1"));
});

test("base58 decode matches a known instruction payload", () => {
  assert.deepEqual([...base58Decode("1")], [0]);
  assert.equal(base58Decode("2").toString("hex"), "01");
  assert.throws(() => base58Decode("0OIl"));
});

test("mainnet: owner A's stake is read from open_battle_pool_v2 (instruction 4, after Lighthouse checks)", () => {
  const d = decodeSolanaArenaTransaction(TXS[OPEN]);
  assert.deepEqual(d.warnings, []);
  assert.equal(d.blockTime, "2026-09-25T12:29:43.000Z");
  assert.deepEqual(plain(d.movements), [
    { table: "deposits", ixIndex: 4, instruction: "open_battle_pool_v2", poolId: POOL, purpose: "stake", wallet: OWNER_A, amount: "50000000" },
  ]);
});

test("mainnet: owner B's 0.05 SOL deposit (tx 3khothUk..., no receipt row) is decoded", () => {
  const d = decodeSolanaArenaTransaction(TXS[STAKE_B]);
  assert.equal(d.blockTime, "2026-09-25T14:02:35.000Z");
  assert.deepEqual(plain(d.movements), [
    { table: "deposits", ixIndex: 0, instruction: "deposit_stake_v2", poolId: POOL, purpose: "stake", wallet: OWNER_B, amount: "50000000" },
  ]);
});

test("mainnet: a prize boost is a deposit of purpose boost with the event amount", () => {
  const d = decodeSolanaArenaTransaction(TXS[BOOST]);
  assert.deepEqual(plain(d.movements), [
    { table: "deposits", ixIndex: 5, instruction: "deposit_prize_boost_v2", poolId: POOL, purpose: "boost", wallet: "9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H", amount: "8200755" },
  ]);
});

test("mainnet: resolve moves no money and is not recorded; the Ed25519 precompile does not break log matching", () => {
  const d = decodeSolanaArenaTransaction(TXS[RESOLVE]);
  assert.deepEqual(d.movements, []);
  assert.deepEqual(d.warnings, []);
});

test("mainnet: winner, protocol and MWL claims: amount = what left the vault, equal to the receipt the program wrote", () => {
  const winner = decodeSolanaArenaTransaction(TXS[CLAIM_WINNER]).movements;
  assert.deepEqual(plain(winner), [{
    table: "claims", ixIndex: 0, instruction: "claim_winner", poolId: POOL, bucket: "winner", place: 1, refundOf: null,
    wallet: OWNER_B, amount: "112024541", receipt: "DeDrL6NLeij2qTUDrZCq6fjRhgKkfgnrzrQNinhw6n2T",
  }]);
  const protocol = decodeSolanaArenaTransaction(TXS[CLAIM_PROTOCOL]).movements[0];
  const mwl = decodeSolanaArenaTransaction(TXS[CLAIM_MWL]).movements[0];
  assert.equal(protocol.bucket, "protocol");
  assert.equal(protocol.wallet, "BvQHb6qq22ZHAVUpXaaeizBaRhGpuu5T3i8Y3ebZ2que");
  assert.equal(mwl.bucket, "mwl");
  assert.equal(mwl.wallet, "PCDQmFBrYTV2kfdGtiGWJ2Au9TfaR5ZzBkXdtymV1Bd");
  for (const [movement, key] of [[winner[0], "winner"], [protocol, "protocol"], [mwl, "mwl"]]) {
    const fromReceipt = amountFromReceipt(movement, Buffer.from(RECEIPTS[key], "base64"));
    assert.equal(fromReceipt.amount, movement.amount, key);
    assert.equal(fromReceipt.wallet, movement.wallet, key);
  }
  // A receipt of another pool never fills an amount.
  assert.equal(amountFromReceipt({ ...protocol, poolId: `0x${"11".repeat(32)}` }, Buffer.from(RECEIPTS.protocol, "base64")), null);
});

test("two debits of one vault in one transaction: the amount is left to the receipt account", () => {
  const tx = structuredClone(TXS[CLAIM_PROTOCOL]);
  const ix = tx.transaction.message.instructions[0];
  tx.transaction.message.instructions.push({ ...ix });
  const d = decodeSolanaArenaTransaction(tx);
  assert.equal(d.movements.length, 2);
  assert.ok(d.movements.every((m) => m.amount === null && m.receipt === "EbvCy9yY21a9Wy75mwQEKRiZrBZRqZiFePJqEToqifNm"));
});

test("truncated logs: deposit events are matched to deposit instructions by order", () => {
  const tx = structuredClone(TXS[STAKE_B]);
  tx.meta.logMessages = [...tx.meta.logMessages, "Log truncated"];
  const d = decodeSolanaArenaTransaction(tx);
  assert.equal(d.movements.length, 1);
  assert.equal(d.movements[0].amount, 50000000n);
  assert.match(d.warnings[0], /matched by order/);
});

test("a failed transaction records nothing", () => {
  const tx = structuredClone(TXS[STAKE_B]);
  tx.meta.err = { InstructionError: [0, "Custom"] };
  const d = decodeSolanaArenaTransaction(tx);
  assert.equal(d.failed, true);
  assert.deepEqual(d.movements, []);
});

test("log attribution maps Program data to top-level instructions and skips precompiles", () => {
  const P = "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX";
  const logs = [
    `Program ${P} invoke [1]`, "Program data: AAAA", "Program X invoke [2]", "Program data: BBBB", "Program X success", `Program ${P} success`,
    `Program ${P} invoke [1]`, "Program data: CCCC", `Program ${P} success`,
  ];
  const map = programDataByInstruction(logs, P, ["Ed25519SigVerify111111111111111111111111111", P, P]);
  assert.deepEqual([...map.entries()], [[1, ["AAAA"]], [2, ["CCCC"]]]);
  assert.equal(programDataByInstruction(logs, P, [P]), null);
});

test("rows carry the subject and keep the exact base58 signature", () => {
  const d = decodeSolanaArenaTransaction(TXS[STAKE_B]);
  const row = movementRow(d.movements[0], { chainId: 101, txHash: d.signature, slot: d.slot, blockTime: d.blockTime, subjects: subjectMap([{ kind: "battle", id: BATTLE }]) });
  assert.deepEqual(row, {
    table: "deposits", chainId: 101, poolId: POOL, purpose: "stake", bucket: null, place: null, refundOf: null,
    wallet: OWNER_B, amount: "50000000", txHash: STAKE_B, ixIndex: 0, slot: TXS[STAKE_B].slot, blockTime: "2026-09-25T14:02:35.000Z",
    subjectKind: "battle", subjectId: BATTLE,
  });
});

test("indexSolanaArena: one pass over a pool's signatures (dry run classifies, never writes)", async () => {
  const sigs = [CLAIM_MWL, CLAIM_PROTOCOL, CLAIM_WINNER, RESOLVE, BOOST, STAKE_B, OPEN].map((signature) => ({ signature, err: null }));
  const rpc = async (method, params) => {
    if (method === "getSignaturesForAddress") return sigs;
    if (method === "getTransaction") return TXS[params[0]];
    throw new Error(`unexpected ${method}`);
  };
  const queries = [];
  const db = {
    async query(text, params) {
      queries.push(text);
      if (/from public\.arena_war_pool_deposits t/.test(text) && params[1] === OPEN) return { rows: [{ tx_hash: OPEN, amount: "50000000", purpose: "stake", source: "receipt", ix_index: null }] };
      return { rows: [] };
    },
  };
  const summary = await indexSolanaArena({ db, rpc, chainId: 101, subjects: [{ kind: "battle", id: BATTLE }], dryRun: true, ignoreCursor: true, logger: {} });
  assert.equal(summary.transactions, 7);
  assert.deepEqual(summary.actions, { insert: 5, "replace-receipt": 1 });
  assert.deepEqual(summary.rows.map((r) => [r.txHash.slice(0, 8), r.purpose || r.bucket, r.amount, r.action]), [
    ["495VDDq3", "stake", "50000000", "replace-receipt"],
    ["3khothUk", "stake", "50000000", "insert"],
    ["wq3g1nJh", "boost", "8200755", "insert"],
    ["5tSmpCDr", "winner", "112024541", "insert"],
    ["4Re9cf3E", "protocol", "9113837", "insert"],
    ["4Arn46wN", "mwl", "20000000", "insert"],
  ]);
  assert.ok(queries.every((q) => !/^\s*(insert|update|delete|with)/i.test(q)), "dry run sent a write");
});

// --------------------------------------------------------------------------
// EVM (ArenaWarPoolTreasuryV2 events, encoded from the contract's own signatures)

const iface = new ethers.Interface([
  "event StakeDeposited(bytes32 indexed poolId, address indexed owner, uint256 amount)",
  "event BuyInDeposited(bytes32 indexed poolId, address indexed owner, uint256 amount)",
  "event BattleBoosted(bytes32 indexed poolId, address indexed booster, address indexed sideToken, uint256 boostUnits, uint256 unitPriceNativeRaw, uint256 grossNativeRaw, uint256 pricingVersion, uint256 oracleTimestamp, uint256 nonce)",
  "event TournamentBoosted(bytes32 indexed poolId, bytes32 indexed matchId, uint256 indexed roundNumber, address booster, address sideToken, uint256 boostUnits, uint256 unitPriceNativeRaw, uint256 grossNativeRaw, uint256 pricingVersion, uint256 oracleTimestamp, uint256 nonce)",
  "event Claimed(bytes32 indexed poolId, bytes32 bucket, address indexed to, uint256 amount)",
  "event StakeRefunded(bytes32 indexed poolId, address indexed owner, uint256 amount)",
  "event BuyInRefunded(bytes32 indexed poolId, address indexed owner, uint256 amount)",
  "event BoostRefunded(bytes32 indexed poolId, address indexed funder, uint256 amount)",
]);
const EVM_POOL = battlePoolId("arena-evm-1");
const WALLET = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";

function log(name, args, logIndex = 3) {
  const { data, topics } = iface.encodeEventLog(name, args);
  return { address: "0xabc", data, topics, logIndex: `0x${logIndex.toString(16)}`, blockNumber: "0x10", transactionHash: "0xAA", removed: false };
}

test("EVM topics are the treasury's event signatures", () => {
  for (const [name, topic] of Object.entries(EVM_TOPICS)) assert.equal(topic, iface.getEvent(name).topicHash, name);
});

test("EVM: deposits, boosts, claims and refunds decode", () => {
  assert.deepEqual(plain(decodeEvmArenaLog(log("StakeDeposited", [EVM_POOL, WALLET, 5n], 7))), { ixIndex: 7, poolId: EVM_POOL, event: "StakeDeposited", table: "deposits", purpose: "stake", wallet: WALLET, amount: "5" });
  assert.equal(decodeEvmArenaLog(log("BuyInDeposited", [EVM_POOL, WALLET, 6n])).purpose, "buy_in");
  const boost = decodeEvmArenaLog(log("BattleBoosted", [EVM_POOL, WALLET, TOKEN, 2n, 50n, 100n, 1n, 9n, 4n]));
  assert.deepEqual([boost.purpose, boost.wallet, boost.amount], ["boost", WALLET, 100n]);
  const tBoost = decodeEvmArenaLog(log("TournamentBoosted", [EVM_POOL, ethers.id("m"), 2n, WALLET, TOKEN, 3n, 40n, 120n, 1n, 9n, 4n]));
  assert.deepEqual([tBoost.purpose, tBoost.wallet, tBoost.amount], ["boost", WALLET, 120n]);
  const winner = decodeEvmArenaLog(log("Claimed", [EVM_POOL, ethers.encodeBytes32String("winner"), WALLET, 77n]));
  assert.deepEqual([winner.table, winner.bucket, winner.place, winner.amount], ["claims", "winner", 1, 77n]);
  const place2 = decodeEvmArenaLog(log("Claimed", [EVM_POOL, ethers.toBeHex((0x706c616365n << 8n) | 2n, 32), WALLET, 11n]));
  assert.deepEqual([place2.bucket, place2.place], ["winner", 2]);
  assert.equal(decodeEvmArenaLog(log("Claimed", [EVM_POOL, ethers.encodeBytes32String("league"), WALLET, 1n])).bucket, "mwl");
  assert.equal(decodeEvmArenaLog(log("Claimed", [EVM_POOL, ethers.encodeBytes32String("operator"), WALLET, 1n])).bucket, "operator");
  assert.equal(decodeEvmArenaLog(log("Claimed", [EVM_POOL, ethers.encodeBytes32String("protocol"), WALLET, 1n])).bucket, "protocol");
  assert.equal(decodeEvmArenaLog(log("Claimed", [EVM_POOL, ethers.encodeBytes32String("unknown"), WALLET, 1n])), null);
  for (const [name, of] of [["StakeRefunded", "stake"], ["BuyInRefunded", "buy_in"], ["BoostRefunded", "boost"]]) {
    const r = decodeEvmArenaLog(log(name, [EVM_POOL, WALLET, 3n]));
    assert.deepEqual([r.bucket, r.refundOf, r.amount], ["refund", of, 3n]);
  }
  assert.equal(decodeEvmArenaLog({ ...log("StakeDeposited", [EVM_POOL, WALLET, 5n]), removed: true }), null);
  assert.equal(decodeEvmBucket(ethers.encodeBytes32String("winner").slice(2)).place, 1);
});

test("receipt insert has no conflict target and skips a transaction that already has a row", () => {
  const sql = receiptDepositSql("stake");
  assert.match(sql, /on conflict do nothing/);
  assert.doesNotMatch(sql, /on conflict \(/);
  assert.match(sql, /where not exists/);
  assert.throws(() => receiptDepositSql("boost"));
});
