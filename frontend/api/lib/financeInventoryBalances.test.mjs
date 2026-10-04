import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:pass@127.0.0.1:1/none";

const { inventoryRpcUrls, withInventoryBalances } = await import("./financeInventoryBalances.js");

const now = () => "2026-10-03T00:00:00.000Z";
const items = [
  { id: "a", chain: "bnb", kind: "vault", label: "A", address: "0x00000000000000000000000000000000000000a1", role: "r", status: "configured" },
  { id: "b", chain: "bnb", kind: "vault", label: "B", address: "0x00000000000000000000000000000000000000b2", role: "r", status: "configured" },
];
const bnb56 = { chainId: 56, chain: "bnb", decimals: 18, asset: "BNB", environment: "mainnet" };
const solMain = { chainId: 101, chain: "solana", decimals: 9, asset: "SOL", environment: "production", cluster: "mainnet-beta" };

test("a failed read is unknown with no amount, never zero", async () => {
  const readers = {
    readEvmNative: async ({ address }) => {
      if (address.endsWith("b2")) throw new Error("eth_getBalance HTTP 503");
      return { raw: "1500000000000000000", rpc: "bsc.example" };
    },
    readSolanaLamports: async () => { throw new Error("unused"); },
  };
  const out = await withInventoryBalances(items, bnb56, { env: { BSC_RPC_HTTP_56: "https://bsc.example" }, readers, now });
  assert.equal(out[0].balance.status, "ok");
  assert.equal(out[0].balance.amount, "1.5");
  assert.equal(out[0].balance.asset, "BNB");
  assert.equal(out[1].balance.status, "unknown");
  assert.equal(out[1].balance.amount, null);
  assert.equal(out[1].balance.raw, null);
  assert.match(out[1].balance.error, /503/);
  // The inventory fields themselves are untouched.
  assert.equal(out[1].address, items[1].address);
});

test("Solana mainnet reads lamports as SOL", async () => {
  const readers = {
    readEvmNative: async () => { throw new Error("unused"); },
    readSolanaLamports: async () => ({ raw: "2500000000", rpc: "rpc.example", slot: 1 }),
  };
  const out = await withInventoryBalances([{ ...items[0], chain: "solana", address: "fk5YYWb4ppwbFqME8YRugirMSaNfhGgPP3GjfMbbfGv" }], solMain, { env: {}, readers, now });
  assert.equal(out[0].balance.amount, "2.5");
  assert.equal(out[0].balance.asset, "SOL");
});

test("Solana mainnet RPC list never includes a devnet URL; devnet never a mainnet one", () => {
  const env = { SOLANA_RPC_URL: "https://api.devnet.solana.com", SOLANA_DEVNET_RPC_HTTP: "https://devnet.example" };
  assert.ok(inventoryRpcUrls(solMain, env).every((url) => !/devnet/.test(url)));
  const devnet = inventoryRpcUrls({ ...solMain, environment: "staging", cluster: "devnet" }, env);
  assert.deepEqual(devnet, ["https://devnet.example", "https://api.devnet.solana.com"]);
});

test("no RPC at all: unknown, not zero", async () => {
  const readers = { readEvmNative: async () => ({ raw: "0", rpc: "x" }), readSolanaLamports: async () => ({ raw: "0", rpc: "x" }) };
  const out = await withInventoryBalances(items.slice(0, 1), { ...solMain, cluster: "testnet" }, { env: {}, readers, now });
  assert.equal(out[0].balance.status, "unknown");
  assert.equal(out[0].balance.amount, null);
});
