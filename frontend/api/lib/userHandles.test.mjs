import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgres://user:pass@127.0.0.1:1/none";
const { handleProblem, walletKey, attachHandles, HANDLE_CHANGE_COOLDOWN_DAYS } = await import("./userHandles.js");

test("username rules (founder, 2026-10-02): 3-20 of a-z 0-9 _, reserved names refused", () => {
  assert.equal(handleProblem("abc"), "");
  assert.equal(handleProblem("The_General_2"), "");
  assert.equal(handleProblem("ab"), "format");
  assert.equal(handleProblem("a".repeat(21)), "format");
  assert.equal(handleProblem("has space"), "format");
  assert.equal(handleProblem("dash-name"), "format");
  assert.equal(handleProblem("Admin"), "reserved");
  assert.equal(handleProblem("memewarzone"), "reserved");
  assert.equal(HANDLE_CHANGE_COOLDOWN_DAYS, 30);
});

test("wallet keys match the feed: EVM lowercased, Solana as-is, junk empty", () => {
  assert.equal(walletKey("0xAbCdEf0000000000000000000000000000000001"), "0xabcdef0000000000000000000000000000000001");
  assert.equal(walletKey("9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H"), "9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H");
  assert.equal(walletKey("TheGeneral"), "");
  assert.equal(walletKey(""), "");
});

test("attachHandles leaves items alone when there are no wallets", async () => {
  const items = [{ id: "x", body: "hi" }];
  assert.deepEqual(await attachHandles(items), items);
  assert.deepEqual(await attachHandles(null), []);
});
