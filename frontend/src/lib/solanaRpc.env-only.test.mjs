import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = [
  new URL("./chainConfig.ts", import.meta.url),
  new URL("./solanaReadConnection.ts", import.meta.url),
  new URL("./solanaCampaignRead.ts", import.meta.url),
  new URL("./solanaRewardNetwork.ts", import.meta.url),
  new URL("./solanaTradeV1.ts", import.meta.url),
  new URL("./solanaV4CreateSubmit.ts", import.meta.url),
];

test("browser Solana RPC helpers do not hardcode publicnode or mainnet-beta", async () => {
  const sources = await Promise.all(files.map((url) => readFile(url, "utf8")));
  for (const source of sources) {
    assert.doesNotMatch(source, /solana-rpc\.publicnode\.com/);
    assert.doesNotMatch(source, /solana\.drpc\.org/);
  }
});

test("chainConfig prefers VITE_SOLANA_RPC over an empty MAINNET key", async () => {
  const source = await readFile(new URL("./chainConfig.ts", import.meta.url), "utf8");
  assert.match(source, /function firstSolanaMainnetRpc/);
  const rpcFirst = source.indexOf("firstFromCsv(import.meta.env.VITE_SOLANA_RPC");
  const mainnetFirst = source.indexOf("firstFromCsv(import.meta.env.VITE_SOLANA_MAINNET_RPC");
  assert.ok(rpcFirst >= 0 && mainnetFirst > rpcFirst);
});
