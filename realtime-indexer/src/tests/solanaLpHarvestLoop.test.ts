import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";
process.env.ABLY_API_KEY ||= "test:test";
const { harvestableItems, runSolanaLpHarvestPass, solanaLpHarvestBlocker, solanaLpHarvestMode } = await import("../solanaLpHarvestLoop.js");

test("off unless dry or send", () => {
  assert.equal(solanaLpHarvestMode({} as NodeJS.ProcessEnv), "off");
  assert.equal(solanaLpHarvestMode({ SOLANA_LP_HARVEST_AUTO: "true" } as NodeJS.ProcessEnv), "off");
  assert.equal(solanaLpHarvestMode({ SOLANA_LP_HARVEST_AUTO: "SEND" } as NodeJS.ProcessEnv), "send");
});

test("refuses to run without an explicit protocol treasury (never the devnet deployer fallback)", () => {
  assert.match(String(solanaLpHarvestBlocker({} as NodeJS.ProcessEnv)), /SOLANA_PROTOCOL_TREASURY_ADDRESS/);
  assert.equal(solanaLpHarvestBlocker({ SOLANA_PROTOCOL_TREASURY_ADDRESS: "BvQHb6qq22ZHAVUpXaaeizBaRhGpuu5T3i8Y3ebZ2que" } as NodeJS.ProcessEnv), null);
});

const items = [
  { campaignAddress: "A", symbol: "AAA", fees: { unharvested: { token0: 0.5, token1: 0 } } },
  { campaignAddress: "B", symbol: "BBB", fees: { unharvested: { token0: 0, token1: 0 } } },
  { campaignAddress: "C", symbol: "CCC", fees: { error: "rpc" } },
  { campaignAddress: "D", symbol: "DDD", fees: { unharvested: { token0: 0, token1: 12 } } },
];

test("only positions with unclaimed fees are harvested", () => {
  assert.deepEqual(harvestableItems(items as never).map((i) => i.campaignAddress), ["A", "D"]);
});

test("send harvests each, dry harvests none, a failure does not stop the pass", async () => {
  const calls: string[] = [];
  const deps = {
    list: (async () => ({ items })) as never,
    harvest: (async ({ campaign }: { campaign: string }) => { calls.push(campaign); if (campaign === "A") throw new Error("rpc 429"); return { lastTx: "sig" }; }) as never,
  };
  const out = await runSolanaLpHarvestPass("send", deps);
  assert.deepEqual(calls, ["A", "D"]);
  assert.deepEqual(out.map((o) => o.status), ["failed", "harvested"]);
  calls.length = 0;
  const dry = await runSolanaLpHarvestPass("dry", deps);
  assert.deepEqual(calls, []);
  assert.deepEqual(dry.map((o) => o.status), ["dry-run", "dry-run"]);
});
