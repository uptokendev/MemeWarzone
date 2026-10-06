// Moderation holds (B7) in the weekly airdrop: a wallet under a blanket hold is not in the draw (BNB,
// Robinhood and Solana all build candidates through exclusionSets), and a DBC holder round that pays
// a held wallet waits whole instead of being split.
import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:1/test";
const { exclusionSets, isWalletExcluded, traderCandidates } = await import("./candidates.mjs");
const { holderRoundsWithoutHeldWallets, holderSelection } = await import("./run-solana-weekly-airdrop.mjs");
const { thresholdsFor } = await import("./usdRules.mjs");

const START = new Date("2026-09-28T00:00:00Z");
const END = new Date("2026-10-05T00:00:00Z");
const HELD_SOL = "CVqCRi5cRVKBriiEuwcWtbx8EJ7inFHhxagagJZjS5Cf";
const FREE_SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const HELD_EVM = "0x348fF00000000000000000000000000000000001";

function fakeClient({ installed = true, held = [], traders = [] } = {}) {
  return {
    async query(sql) {
      if (sql.includes("to_regclass('public.moderation_holds')")) return { rows: [{ ok: installed }] };
      if (sql.includes("from public.moderation_holds")) return { rows: held.map((w) => ({ wallet_key: w.toLowerCase() })) };
      if (sql.includes("total_volume_raw")) return { rows: traders };
      return { rows: [] };
    },
  };
}
const trader = (wallet) => ({ wallet_address: wallet, total_volume_raw: "5000000000000000000", trade_count: 5, active_days: 3, campaign_count: 2 });

test("a held wallet is out of the draw on Solana (exact case) and EVM (any case)", async () => {
  const sol = await exclusionSets(fakeClient({ held: [HELD_SOL] }), { chainId: 101, start: START, end: END, env: {} });
  assert.equal(sol.moderationHeldCount, 1);
  assert.ok(isWalletExcluded(sol, HELD_SOL));
  assert.equal(isWalletExcluded(sol, FREE_SOL), false);
  const client = fakeClient({ held: [HELD_SOL], traders: [trader(HELD_SOL), trader(FREE_SOL)] });
  const ex = await exclusionSets(client, { chainId: 101, start: START, end: END, env: {} });
  const drawn = await traderCandidates(client, { chainId: 101, start: START, end: END, exclusions: ex, thresholds: thresholdsFor(101, 150) });
  assert.deepEqual(drawn.map((r) => r.walletAddress), [FREE_SOL]);

  const evm = await exclusionSets(fakeClient({ held: [HELD_EVM] }), { chainId: 56, start: START, end: END, env: {} });
  assert.ok(isWalletExcluded(evm, HELD_EVM.toLowerCase()));
  assert.ok(isWalletExcluded(evm, HELD_EVM));
});

test("before the migration is applied nothing is held and the draw is unchanged", async () => {
  const ex = await exclusionSets(fakeClient({ installed: false, held: [HELD_SOL] }), { chainId: 101, start: START, end: END, env: {} });
  assert.equal(ex.moderationHeldCount, 0);
  assert.equal(isWalletExcluded(ex, HELD_SOL), false);
});

test("a DBC holder round paying a held wallet waits whole; other rounds go out", () => {
  const rounds = [
    { week_id: "2026-09-21", leaves: { leaves: [{ owner: HELD_SOL, amount: "6000000" }, { owner: FREE_SOL, amount: "9000000" }] } },
    { week_id: "2026-09-28", leaves: { leaves: [{ owner: FREE_SOL, amount: "1000000" }] } },
  ];
  const { ready, deferred } = holderRoundsWithoutHeldWallets(rounds, new Set([HELD_SOL.toLowerCase()]));
  assert.deepEqual(ready.map((r) => r.week_id), ["2026-09-28"]);
  assert.deepEqual(deferred.map((r) => r.week_id), ["2026-09-21"]);
  const item = holderSelection(ready);
  assert.deepEqual(item.holderWeeks, ["2026-09-28"], "only the ready round is marked into this week's tree");
  assert.deepEqual(item.payouts.map(String), ["1000000"]);
  assert.deepEqual(holderRoundsWithoutHeldWallets(rounds, new Set()).ready, rounds);
});
