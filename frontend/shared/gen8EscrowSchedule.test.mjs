import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import {
  GEN8_CREATOR_BUY_ESCROW_COPY,
  GEN8_ESCROW_CLIFF_SECONDS,
  GEN8_ESCROW_STEP_SECONDS,
  gen8EscrowPosition,
  gen8EscrowUnlockLabel,
  gen8EscrowVested,
} from "./gen8EscrowSchedule.mjs";

const day = 24 * 60 * 60;

test("one creator buy releases 20% after 30 days, then 20% every 7 days", () => {
  const buy = { at: 1_000_000, amount: 500n };
  assert.equal(gen8EscrowVested([buy], buy.at + 30 * day), 100n);
  assert.equal(gen8EscrowVested([buy], buy.at + 30 * day - 1), 0n);
  assert.equal(gen8EscrowVested([buy], buy.at + 30 * day + 7 * day), 200n);
  assert.equal(gen8EscrowVested([buy], buy.at + 30 * day + 4 * 7 * day), 500n);
  const before = gen8EscrowPosition({ buys: [buy], claimed: 0n, now: buy.at + 1 });
  assert.equal(before.locked, 500n);
  assert.equal(before.claimable, 0n);
  assert.equal(before.next.at, buy.at + GEN8_ESCROW_CLIFF_SECONDS);
  assert.equal(before.next.amount, 100n);
  const mid = gen8EscrowPosition({
    buys: [buy],
    claimed: 100n,
    claimable: 0n,
    now: buy.at + GEN8_ESCROW_CLIFF_SECONDS + 1,
  });
  assert.equal(mid.locked, 400n);
  assert.equal(mid.next.at, buy.at + GEN8_ESCROW_CLIFF_SECONDS + GEN8_ESCROW_STEP_SECONDS);
  assert.equal(mid.next.amount, 100n);
  const done = gen8EscrowPosition({
    buys: [buy],
    claimed: 500n,
    now: buy.at + GEN8_ESCROW_CLIFF_SECONDS + 4 * GEN8_ESCROW_STEP_SECONDS,
  });
  assert.equal(done.locked, 0n);
  assert.equal(done.next, null);
});

test("the buy panel says the coins go to escrow on that schedule", () => {
  assert.match(GEN8_CREATOR_BUY_ESCROW_COPY, /go to escrow/);
  assert.match(GEN8_CREATOR_BUY_ESCROW_COPY, /20% unlocks after 30 days/);
  assert.match(GEN8_CREATOR_BUY_ESCROW_COPY, /20% every 7 days/);
  const panel = fs.readFileSync(new URL("../src/components/evm/Gen8TradePanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /GEN8_CREATOR_BUY_ESCROW_COPY/);
  assert.doesNotMatch(panel, /DBC_CREATOR_LOCK_COPY/);
  const panels = fs.readFileSync(new URL("../src/components/evm/Gen8CoinPanels.tsx", import.meta.url), "utf8");
  assert.match(panels, /data-gen8-escrow-lock/);
  assert.match(panels, /Next unlock/);
  const page = fs.readFileSync(new URL("../src/pages/TokenDetails.tsx", import.meta.url), "utf8");
  assert.match(page, /<Gen8EscrowLock/);
});

test("a contract total with no buy log still shows the locked coins and no date", () => {
  const pos = gen8EscrowPosition({ buys: [], claimed: 0n, claimable: 0n, now: 1, knownTotal: 500n });
  assert.equal(pos.total, 500n);
  assert.equal(pos.locked, 500n);
  assert.equal(pos.next, null);
  const buyAt = Math.floor(Date.parse("2026-10-18T23:59:53.000Z") / 1000);
  const ycc = gen8EscrowPosition({ buys: [{ at: buyAt, amount: 500n }], claimed: 0n, claimable: 0n, now: buyAt + 1 });
  assert.equal(gen8EscrowUnlockLabel(ycc.next.at), "17 Nov 2026, 23:59 UTC");
  assert.equal(ycc.next.amount, 100n);
});
