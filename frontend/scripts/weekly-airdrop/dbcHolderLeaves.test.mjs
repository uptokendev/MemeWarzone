import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:1/test";
const { holderSelection } = await import("./run-solana-weekly-airdrop.mjs");
const { SOLANA_AIRDROP_PROGRAM_CODES } = await import("./solanaAirdrop.mjs");

test("DBC holder rounds become one code-2 leaf per wallet in the weekly tree", () => {
  assert.equal(SOLANA_AIRDROP_PROGRAM_CODES.dbc_holders, 2);
  const item = holderSelection([
    { week_id: "2026-09-21", leaves: { leaves: [{ owner: "W", amount: "6000000" }, { owner: "X", amount: "9000000" }] } },
    { week_id: "2026-09-28", leaves: { leaves: [{ owner: "W", amount: "1000000" }] } },
  ]);
  assert.equal(item.program, "dbc_holders");
  assert.deepEqual(item.winners.map((w) => w.walletAddress), ["X", "W"]);
  assert.deepEqual(item.payouts, [9_000_000n, 7_000_000n]);
  assert.equal(item.poolWei, 16_000_000n);
  assert.deepEqual(item.holderWeeks, ["2026-09-21", "2026-09-28"]);
  assert.equal(holderSelection([]), null);
});
