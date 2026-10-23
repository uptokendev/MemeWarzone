import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { gen8EscrowBuysFromLogs } from "./useGen8EscrowBuys.ts";

test("an EscrowBuy log keeps its block time and coin amount", () => {
  const iface = new ethers.Interface([
    "event EscrowBuy(bytes32 indexed id, address indexed token, address indexed beneficiary, uint256 nativeSpent, uint256 coinsEscrowed)",
  ]);
  const token = "0xc2f9a2a6e20ab1d7d1d931f743c7e1b88a665307";
  const who = "0xf0558484531204645fb6eaf35c5082fc55d869a6";
  const amount = 500n;
  const encoded = iface.encodeEventLog(iface.getEvent("EscrowBuy")!, [ethers.id("pool"), token, who, 1n, amount]);
  const at = Math.floor(Date.parse("2026-10-18T23:59:53.000Z") / 1000);
  const buys = gen8EscrowBuysFromLogs(
    [{ topics: encoded.topics, data: encoded.data, blockNumber: 137602095 }],
    new Map([[137602095, at]]),
  );
  assert.equal(buys.length, 1);
  assert.equal(buys[0].at, at);
  assert.equal(buys[0].amount, amount);
  assert.equal(gen8EscrowBuysFromLogs([{ topics: encoded.topics, data: encoded.data, blockNumber: 1 }], new Map()).length, 0);
});
