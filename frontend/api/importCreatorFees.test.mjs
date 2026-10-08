import assert from "node:assert/strict";
import test from "node:test";
process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";
const { summarizeCreatorFees } = await import("./importCreatorFees.js");

const MINT = "2wT8AcQFEzXMEjb6qbs1GDg3mJ3DKBw6eBWp7GqsBAGS";
const now = new Date("2026-10-20T00:00:00Z");

test("unclaimed coin: waiting total shown, no owner, no payout date", () => {
  const out = summarizeCreatorFees({ chainId: 101, token: MINT, now, owner: { ownership_status: "ownership_pending" }, totals: [{ status: "waiting", total: "840000000", oldest_expires_at: "2027-01-01T00:00:00Z" }] });
  assert.equal(out.claimed, false);
  assert.equal(out.ownerWallet, null);
  assert.equal(out.waitingRaw, "840000000");
  assert.equal(out.paidRaw, "0");
  assert.equal(out.payoutsFrom, null);
  assert.equal(out.asset, "SOL");
  assert.equal(out.windowDays, 90);
});

test("claimed coin: payouts open 7 days after verification", () => {
  const owner = { ownership_status: "ownership_verified", project_owner_wallet: "Owner111111111111111111111111111111111111111", ownership_verified_at: "2026-10-15T00:00:00Z" };
  const early = summarizeCreatorFees({ chainId: 101, token: MINT, now, owner, totals: [] });
  assert.equal(early.claimed, true);
  assert.equal(early.payoutsFrom, "2026-10-22T00:00:00.000Z");
  assert.equal(early.payoutsOpen, false);
  const later = summarizeCreatorFees({ chainId: 101, token: MINT, now: new Date("2026-10-23T00:00:00Z"), owner, totals: [{ status: "paid", total: "5" }] });
  assert.equal(later.payoutsOpen, true);
  assert.equal(later.paidRaw, "5");
});

test("a verified status without a wallet is not claimed", () => {
  const out = summarizeCreatorFees({ chainId: 56, token: "0xabc", now, owner: { ownership_status: "ownership_verified", project_owner_wallet: null }, totals: [] });
  assert.equal(out.claimed, false);
  assert.equal(out.asset, "BNB");
});

test("testnets 97 / 46630 are readable so the gen-7 testnet run shows the notice", () => {
  assert.equal(summarizeCreatorFees({ chainId: 97, token: "0xabc", now, owner: null, totals: [] }).asset, "tBNB");
  assert.equal(summarizeCreatorFees({ chainId: 46630, token: "0xabc", now, owner: null, totals: [] }).asset, "ETH");
});
