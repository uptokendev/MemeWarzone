/**
 * The gen-8 sell asks the read provider for the receipt. The wallet is only asked to sign.
 *   node --test src/lib/gen8SellSteps.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  GEN8_FIRST_SELL_NOTE,
  GEN8_RECEIPT_POLL_MS,
  GEN8_WAITING_CONFIRMATION,
  gen8StepLabel,
  sendGen8Tx,
} from "./evmGen8Client.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const HASH = `0x${"ab".repeat(32)}`;
const FROM = `0x${"11".repeat(20)}`;
const TO = `0x${"22".repeat(20)}`;

test("a first sell names the two one-time approvals and the swap", () => {
  assert.equal(GEN8_FIRST_SELL_NOTE, "The first sell of a coin needs two one-time approvals.");
  assert.equal(GEN8_WAITING_CONFIRMATION, "Waiting for confirmation");
  assert.equal(gen8StepLabel({ index: 1, total: 3, kind: "erc20" }), "Step 1 of 3: approve the coin (one time)");
  assert.equal(gen8StepLabel({ index: 2, total: 3, kind: "permit2" }), "Step 2 of 3: allow the Uniswap router (one time)");
  assert.equal(gen8StepLabel({ index: 3, total: 3, kind: "sell" }), "Step 3 of 3: sell");
  assert.equal(GEN8_RECEIPT_POLL_MS, 250);
});

test("the next signature follows the read-provider receipt and does not poll the wallet", async () => {
  const events = [];
  const wallet = {
    async getBlockNumber() {
      events.push("wallet-block");
      return 1;
    },
    async getTransactionReceipt() {
      events.push("wallet-receipt");
      return null;
    },
    async estimateGas() {
      events.push("wallet-estimate");
      throw new Error("wallet estimate");
    },
    async send() {
      events.push("wallet-send");
      throw new Error("wallet rpc");
    },
  };
  let polls = 0;
  const readProvider = {
    async send(method) {
      events.push(`read:${method}`);
      if (method === "eth_gasPrice") return "0x3b9aca00";
      throw new Error(method);
    },
    async estimateGas() {
      events.push("read-estimate");
      return 80_000n;
    },
    async getTransactionReceipt() {
      polls += 1;
      events.push(`receipt:${polls}`);
      if (polls < 3) return null;
      return { hash: HASH, status: 1, blockNumber: 9 };
    },
    async getBlockNumber() {
      events.push("read-block");
      return 9;
    },
  };
  const signer = {
    provider: wallet,
    async getAddress() {
      return FROM;
    },
    async sendTransaction() {
      events.push("sign");
      return { hash: HASH, async wait() { events.push("wallet-wait"); return null; } };
    },
  };
  const phases = [];
  const receipt = await sendGen8Tx({
    signer,
    chainId: 46630,
    readProvider,
    tx: { to: TO, data: "0x", value: "0" },
    onPhase: (phase) => phases.push(phase),
    sleep: async (ms) => {
      events.push(`sleep:${ms}`);
    },
  });
  assert.equal(receipt.blockNumber, 9);
  assert.deepEqual(phases, ["sign", "pending"]);
  assert.deepEqual(events.filter((event) => event.startsWith("sleep:")), ["sleep:250", "sleep:250"]);
  assert.equal(events.some((event) => event.startsWith("wallet-")), false);
  const signed = events.indexOf("sign");
  const seen = events.indexOf("receipt:3");
  assert.ok(signed < seen, "the wallet signs before the receipt poll finishes");
  assert.ok(events.indexOf("read-estimate") < signed, "the estimate is on the read provider, before the prompt");
});

test("two sends in a row do not sleep between the receipt and the next signature", async () => {
  const events = [];
  let n = 0;
  const readProvider = {
    async send() {
      return "0x1";
    },
    async estimateGas() {
      events.push("estimate");
      return 50_000n;
    },
    async getTransactionReceipt(hash) {
      events.push(`receipt:${hash}`);
      return { hash, status: 1, blockNumber: 3 };
    },
  };
  const signer = {
    provider: {
      async getBlockNumber() {
        events.push("wallet-block");
        return 0;
      },
    },
    async getAddress() {
      return FROM;
    },
    async sendTransaction(tx) {
      n += 1;
      const hash = `0x${n.toString(16).padStart(64, "0")}`;
      events.push(`sign:${tx.to}`);
      return { hash };
    },
  };
  const sleep = async () => {
    events.push("sleep");
  };
  await sendGen8Tx({ signer, chainId: 97, readProvider, tx: { to: TO, data: "0x01", value: "0" }, sleep });
  await sendGen8Tx({ signer, chainId: 97, readProvider, tx: { to: TO, data: "0x02", value: "0" }, sleep });
  assert.deepEqual(events, [
    "estimate",
    `sign:${TO}`,
    "receipt:0x0000000000000000000000000000000000000000000000000000000000000001",
    "estimate",
    `sign:${TO}`,
    "receipt:0x0000000000000000000000000000000000000000000000000000000000000002",
  ]);
});

test("the trade panel and the widget show those steps", () => {
  const panel = fs.readFileSync(path.join(here, "../components/evm/Gen8TradePanel.tsx"), "utf8");
  const widget = fs.readFileSync(path.join(here, "../widget/gen8Widget.ts"), "utf8");
  assert.match(panel, /GEN8_FIRST_SELL_NOTE/);
  assert.match(panel, /GEN8_WAITING_CONFIRMATION/);
  assert.match(panel, /gen8StepLabel\(step\)/);
  assert.doesNotMatch(panel, /Confirm in your wallet/);
  assert.match(widget, /The first sell of a coin needs two one-time approvals\./);
  assert.match(widget, /Step \$\{stepIndex\} of \$\{stepTotal\}: approve the coin \(one time\)/);
  assert.match(widget, /Step \$\{stepIndex\} of \$\{stepTotal\}: allow the Uniswap router \(one time\)/);
  assert.match(widget, /Waiting for confirmation/);
  assert.match(widget, /setTimeout\(resolve, 250\)/);
  assert.doesNotMatch(widget, /setTimeout\(resolve, 1500\)/);
});
