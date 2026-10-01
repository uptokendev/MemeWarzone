import assert from "node:assert/strict";
import test from "node:test";
import { readAccounts, solanaProgressRpcUrls } from "./solanaCampaignProgress.js";

test("RPC list: SOLANA_RPC_URL entries first, then the other mainnet names, http only, no duplicates", () => {
  const urls = solanaProgressRpcUrls({
    SOLANA_RPC_URL: "https://a.example, https://b.example",
    SOLANA_RPC_HTTP: "https://a.example",
    SOLANA_MAINNET_RPC: "not-a-url",
    VITE_SOLANA_RPC: "https://c.example",
  });
  assert.deepEqual(urls, ["https://a.example", "https://b.example", "https://c.example"]);
});

test("a refusing first RPC falls through to the next one instead of leaving every card at 0%", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url === "https://dead.example") return { ok: false, status: 429, json: async () => ({ error: { message: "rate limited" } }) };
    return { ok: true, status: 200, json: async () => ({ result: { value: [null] } }) };
  };
  const out = await readAccounts(["Hsa3rJRQHVs8hB9psXipLjRz66kKr9Nhcrc8wGmH9edA"], { urls: ["https://dead.example", "https://live.example"], fetchImpl });
  assert.deepEqual(seen, ["https://dead.example", "https://live.example"]);
  assert.equal(out.size, 1);
});

test("every RPC refusing throws, so the caller logs it instead of silently reporting nothing", async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({}) });
  await assert.rejects(readAccounts(["x"], { urls: ["https://dead.example"], fetchImpl }), /HTTP 403/);
});
