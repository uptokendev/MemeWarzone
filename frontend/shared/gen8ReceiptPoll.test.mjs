// The 250 ms gen-8 receipt poll: a deadline that wins over a hung read, and no further read after a receipt.
//   node --test shared/gen8ReceiptPoll.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { pollGen8Receipt } from "./gen8ReceiptPoll.mjs";

const done = (value) => Boolean(value);

test("a read that never returns stops at the timeout and does not pause", async () => {
  let polls = 0;
  let slept = 0;
  await assert.rejects(
    () => pollGen8Receipt(
      () => {
        polls += 1;
        return new Promise(() => {});
      },
      { timeoutMs: 30, intervalMs: 250, sleep: async () => { slept += 1; }, isDone: done },
    ),
    (error) => error.code === "GEN8_RECEIPT_TIMEOUT" && /not confirmed in time/.test(error.message),
  );
  assert.equal(polls, 1);
  assert.equal(slept, 0);
});

test("a late receipt after the timeout does not start another read", async () => {
  let polls = 0;
  let release = () => {};
  const pending = pollGen8Receipt(
    () => {
      polls += 1;
      return new Promise((resolve) => {
        release = () => resolve({ status: 1 });
      });
    },
    { timeoutMs: 20, intervalMs: 250, sleep: async () => { throw new Error("slept"); }, isDone: done },
  );
  await assert.rejects(pending, (error) => error.code === "GEN8_RECEIPT_TIMEOUT");
  release();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(polls, 1);
});

test("the first finished receipt stops the poll", async () => {
  let polls = 0;
  let sleeps = 0;
  const receipt = await pollGen8Receipt(
    async () => {
      polls += 1;
      return polls < 2 ? null : { status: 1, blockNumber: 4 };
    },
    {
      timeoutMs: 1_000,
      intervalMs: 250,
      sleep: async (ms) => {
        sleeps += 1;
        assert.equal(ms, 250);
      },
      isDone: done,
    },
  );
  assert.equal(receipt.blockNumber, 4);
  assert.equal(polls, 2);
  assert.equal(sleeps, 1);
});
