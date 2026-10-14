import assert from "node:assert/strict";
import test from "node:test";

import {
  DECLINED_RETRY_MS,
  UNSUPPORTED_RETRY_MS,
  isPublicRpcUrl,
  publicChainParams,
  readRpcUpdateState,
  requestRpcUpdate,
  rpcUpdateDue,
} from "./robinhoodWalletRpcUpdate.mjs";

const KEY = ["ab12", "cd34"].join("").repeat(4);
const RH_PARAMS = {
  chainId: "0x1237",
  chainName: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
  blockExplorerUrls: ["https://robinhoodchain.blockscout.com/"],
};

function memoryStorage() {
  const map = new Map();
  return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)) };
}

test("a paid or keyed RPC URL is never offered to a wallet", () => {
  assert.equal(isPublicRpcUrl("https://rpc.mainnet.chain.robinhood.com"), true);
  assert.equal(isPublicRpcUrl("https://bsc-rpc.publicnode.com"), true);
  assert.equal(isPublicRpcUrl(`https://robinhood-mainnet.core.chainstack.com/${KEY}`), false);
  assert.equal(isPublicRpcUrl(`https://mainnet.helius-rpc.com/?api-key=${KEY}`), false);
  assert.equal(isPublicRpcUrl(`https://rpc.example.org/?token=${KEY}`), false);
  assert.equal(isPublicRpcUrl("http://rpc.mainnet.chain.robinhood.com"), false);
  assert.equal(isPublicRpcUrl("not a url"), false);
  assert.deepEqual(
    publicChainParams({ ...RH_PARAMS, rpcUrls: [`https://robinhood-mainnet.core.chainstack.com/${KEY}`, RH_PARAMS.rpcUrls[0]] }).rpcUrls,
    [RH_PARAMS.rpcUrls[0]],
  );
  assert.equal(publicChainParams({ ...RH_PARAMS, rpcUrls: [`https://robinhood-mainnet.core.chainstack.com/${KEY}`] }), null);
});

test("offered once; declined comes back after 7 days, not supported after 30, updated never", () => {
  const t = 1_000_000_000_000;
  assert.equal(rpcUpdateDue(null, t), true);
  assert.equal(rpcUpdateDue({ status: "updated", at: t }, t + 10 * DECLINED_RETRY_MS), false);
  assert.equal(rpcUpdateDue({ status: "declined", at: t }, t + DECLINED_RETRY_MS - 1), false);
  assert.equal(rpcUpdateDue({ status: "declined", at: t }, t + DECLINED_RETRY_MS), true);
  assert.equal(rpcUpdateDue({ status: "unsupported", at: t }, t + UNSUPPORTED_RETRY_MS - 1), false);
  assert.equal(rpcUpdateDue({ status: "unsupported", at: t }, t + UNSUPPORTED_RETRY_MS), true);
});

test("accepted: the wallet gets wallet_addEthereumChain with the public params, state is updated", async () => {
  const storage = memoryStorage();
  const calls = [];
  const wallet = { send: async (method, params) => { calls.push({ method, params }); return null; } };
  assert.equal(await requestRpcUpdate(wallet, "metamask", { params: RH_PARAMS, now: () => 5, storage }), "updated");
  assert.deepEqual(calls, [{ method: "wallet_addEthereumChain", params: [RH_PARAMS] }]);
  assert.deepEqual(readRpcUpdateState("metamask", storage), { status: "updated", at: 5 });
});

test("user rejects (4001 or ethers ACTION_REJECTED): declined; other errors: unsupported", async () => {
  const storage = memoryStorage();
  const reject4001 = { send: async () => { throw Object.assign(new Error("User rejected"), { code: 4001 }); } };
  const rejectEthers = { send: async () => { throw Object.assign(new Error("rejected"), { code: "ACTION_REJECTED" }); } };
  const broken = { send: async () => { throw Object.assign(new Error("Unrecognized chain"), { code: -32603 }); } };
  assert.equal(await requestRpcUpdate(reject4001, "a", { params: RH_PARAMS, storage }), "declined");
  assert.equal(await requestRpcUpdate(rejectEthers, "b", { params: RH_PARAMS, storage }), "declined");
  assert.equal(await requestRpcUpdate(broken, "c", { params: RH_PARAMS, storage }), "unsupported");
  assert.equal(readRpcUpdateState("c", storage).status, "unsupported");
});

test("no public URL configured: the wallet is never called", async () => {
  let called = false;
  const wallet = { send: async () => { called = true; } };
  const params = { ...RH_PARAMS, rpcUrls: [`https://robinhood-mainnet.core.chainstack.com/${KEY}`] };
  assert.equal(await requestRpcUpdate(wallet, "metamask", { params, storage: memoryStorage() }), "skipped");
  assert.equal(called, false);
});

test("state is per wallet id, and corrupt storage reads as never offered", () => {
  const storage = memoryStorage();
  storage.setItem("mwz:rh_wallet_rpc_update:v1:rabby", "{not json");
  assert.equal(readRpcUpdateState("rabby", storage), null);
  assert.equal(readRpcUpdateState("metamask", storage), null);
});
