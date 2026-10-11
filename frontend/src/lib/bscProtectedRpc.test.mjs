// F13: the protected BSC RPC offer (src/lib/bscProtectedRpc.mjs): what the app asks the wallet to add, that only BNB
// Chain mainnet gets the offer, and that the per-browser memory never throws when storage is blocked.
import assert from "node:assert/strict";
import test from "node:test";
import {
  BSC_PROTECTED_RPCS,
  BSC_PROTECTED_RPC_DEFAULT,
  addProtectedBscRpc,
  forgetProtectedRpcChoice,
  offersProtectedRpc,
  protectedBscChainParams,
  readProtectedRpcChoice,
  rememberProtectedRpcChoice,
} from "./bscProtectedRpc.mjs";

function memoryScope() {
  const map = new Map();
  return { localStorage: { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) } };
}
const blocked = {
  get localStorage() {
    throw new Error("SecurityError: storage is blocked");
  },
};
const throwing = { localStorage: { getItem() { throw new Error("x"); }, setItem() { throw new Error("x"); }, removeItem() { throw new Error("x"); } } };

test("offer only on BNB Chain mainnet; the add request is chain 0x38 with one https private RPC", () => {
  assert.equal(offersProtectedRpc(56), true);
  for (const id of [97, 4663, 46630, 101]) assert.equal(offersProtectedRpc(id), false);
  assert.equal(BSC_PROTECTED_RPC_DEFAULT.url, "https://bscrpc.pancakeswap.finance");
  for (const r of BSC_PROTECTED_RPCS) assert.match(r.url, /^https:\/\/[a-z0-9.-]+$/);
  const p = protectedBscChainParams();
  assert.deepEqual(p, { chainId: "0x38", chainName: "BNB Smart Chain (private RPC)", nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: ["https://bscrpc.pancakeswap.finance"], blockExplorerUrls: ["https://bscscan.com/"] });
});

test("memory per browser: added / dismissed round-trip; blocked or throwing storage never throws", () => {
  const scope = memoryScope();
  assert.equal(readProtectedRpcChoice(scope), null);
  rememberProtectedRpcChoice("dismissed", "pancakeswap", scope, 123);
  assert.deepEqual(readProtectedRpcChoice(scope), { state: "dismissed", rpc: "pancakeswap", at: 123 });
  forgetProtectedRpcChoice(scope);
  assert.equal(readProtectedRpcChoice(scope), null);
  scope.localStorage.setItem("mwz:bsc-protected-rpc", "{not json");
  assert.equal(readProtectedRpcChoice(scope), null);
  for (const s of [blocked, throwing, {}, null]) {
    assert.doesNotThrow(() => rememberProtectedRpcChoice("added", "pancakeswap", s));
    assert.equal(readProtectedRpcChoice(s), null);
    assert.doesNotThrow(() => forgetProtectedRpcChoice(s));
  }
});

test("add: EIP-1193 request or ethers send with wallet_addEthereumChain; remembered only when the wallet accepts", async () => {
  const scope = memoryScope();
  const calls = [];
  await addProtectedBscRpc({ request: async (a) => calls.push(a) }, { scope });
  assert.deepEqual(calls, [{ method: "wallet_addEthereumChain", params: [protectedBscChainParams()] }]);
  assert.equal(readProtectedRpcChoice(scope).state, "added");

  const scope2 = memoryScope();
  const sent = [];
  await addProtectedBscRpc({ send: async (m, p) => sent.push([m, p]) }, { scope: scope2, rpc: BSC_PROTECTED_RPCS[1] });
  assert.deepEqual(sent, [["wallet_addEthereumChain", [protectedBscChainParams(BSC_PROTECTED_RPCS[1])]]]);
  assert.equal(readProtectedRpcChoice(scope2).rpc, "48club");

  const scope3 = memoryScope();
  await assert.rejects(addProtectedBscRpc({ request: async () => { throw Object.assign(new Error("User rejected the request."), { code: 4001 }); } }, { scope: scope3 }), /rejected/);
  assert.equal(readProtectedRpcChoice(scope3), null, "a rejection remembers nothing");
  await assert.rejects(addProtectedBscRpc(null, { scope: scope3 }), /Connect a wallet/);
});
