import test from "node:test";
import assert from "node:assert/strict";
import { Interface, ZeroAddress, getAddress } from "ethers";
import {
  AUTOMATIC_OWNERSHIP_UNAVAILABLE,
  resolveProjectOwnershipBnb,
} from "./projectOwnershipResolveBnb.js";

const ABI = new Interface([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function owner() view returns (address)",
  "function getOwner() view returns (address)",
]);

const TOKEN = getAddress("0x00000000000000000000000000000000000000A1");
const OWNER = getAddress("0x00000000000000000000000000000000000000B2");
const OTHER = getAddress("0x00000000000000000000000000000000000000C3");

function selector(data) {
  return String(data).slice(0, 10);
}

function makeProvider({
  code = "0x6001600055",
  name = "Meme Coin",
  symbol = "MEME",
  decimals = 18,
  totalSupply = 1_000_000n,
  owner = OWNER,
  ownerAvailable = true,
  getOwner = null,
  getOwnerAvailable = false,
  totalSupplyAvailable = true,
} = {}) {
  const calls = [];
  return {
    calls,
    async getCode(address) {
      calls.push({ type: "getCode", address });
      return code;
    },
    async call({ to, data }) {
      calls.push({ type: "call", to, data });
      const sig = selector(data);
      if (sig === selector(ABI.encodeFunctionData("name"))) return ABI.encodeFunctionResult("name", [name]);
      if (sig === selector(ABI.encodeFunctionData("symbol"))) return ABI.encodeFunctionResult("symbol", [symbol]);
      if (sig === selector(ABI.encodeFunctionData("decimals"))) return ABI.encodeFunctionResult("decimals", [decimals]);
      if (sig === selector(ABI.encodeFunctionData("totalSupply"))) {
        if (!totalSupplyAvailable) throw new Error("missing totalSupply");
        return ABI.encodeFunctionResult("totalSupply", [totalSupply]);
      }
      if (sig === selector(ABI.encodeFunctionData("owner"))) {
        if (!ownerAvailable) throw new Error("missing owner");
        return ABI.encodeFunctionResult("owner", [owner]);
      }
      if (sig === selector(ABI.encodeFunctionData("getOwner"))) {
        if (!getOwnerAvailable) throw new Error("missing getOwner");
        return ABI.encodeFunctionResult("getOwner", [getOwner]);
      }
      throw new Error("unexpected call");
    },
  };
}

async function resolve(provider, wallet = OWNER) {
  return resolveProjectOwnershipBnb({
    provider,
    chainId: 56,
    contractAddress: TOKEN,
    signedConnectedWallet: wallet,
  });
}

test("valid ERC20 resolves", async () => {
  const result = await resolve(makeProvider());
  assert.equal(result.ok, true);
  assert.equal(result.token.name, "Meme Coin");
  assert.equal(result.token.symbol, "MEME");
  assert.equal(result.token.decimals, 18);
  assert.equal(result.token.totalSupply, "1000000");
});

test("no bytecode fails safely", async () => {
  const result = await resolve(makeProvider({ code: "0x" }));
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "NO_DEPLOYED_BYTECODE");
});

test("correct owner() verifies", async () => {
  const result = await resolve(makeProvider());
  assert.equal(result.ownership.method, "owner");
  assert.equal(result.ownership.automaticOwnershipVerified, true);
});

test("correct getOwner() verifies when owner() unavailable", async () => {
  const result = await resolve(makeProvider({ ownerAvailable: false, getOwnerAvailable: true, getOwner: OWNER }));
  assert.equal(result.ownership.method, "getOwner");
  assert.equal(result.ownership.automaticOwnershipVerified, true);
});

test("wrong wallet rejected", async () => {
  const result = await resolve(makeProvider(), OTHER);
  assert.equal(result.ok, true);
  assert.equal(result.ownership.automaticOwnershipVerified, false);
  assert.equal(result.ownership.automaticOwnershipVerification, "rejected");
});

test("zero owner does not auto-verify", async () => {
  const result = await resolve(makeProvider({ owner: ZeroAddress }));
  assert.equal(result.ok, true);
  assert.equal(result.ownership.automaticOwnershipVerified, false);
  assert.equal(result.ownership.automaticOwnershipVerification, "unavailable");
  assert.equal(result.ownership.message, AUTOMATIC_OWNERSHIP_UNAVAILABLE);
});

test("missing owner methods does not reject onboarding", async () => {
  const result = await resolve(makeProvider({ ownerAvailable: false, getOwnerAvailable: false }));
  assert.equal(result.ok, true);
  assert.equal(result.ownership.automaticOwnershipVerification, "unavailable");
});

test("totalSupply unreadable handled safely", async () => {
  const result = await resolve(makeProvider({ totalSupplyAvailable: false }));
  assert.equal(result.ok, true);
  assert.equal(result.token.totalSupply, null);
});

test("resolver performs no Topaz or trading calls and returns no Arena status", async () => {
  const provider = makeProvider();
  const result = await resolve(provider);
  const encodedCalls = provider.calls.filter((entry) => entry.type === "call").map((entry) => entry.data);
  for (const data of encodedCalls) {
    assert.ok([
      "name",
      "symbol",
      "decimals",
      "totalSupply",
      "owner",
      "getOwner",
    ].some((method) => selector(data) === selector(ABI.encodeFunctionData(method))));
  }
  assert.equal("arenaStatus" in result, false);
  assert.equal("status" in result, false);
  assert.equal("market" in result, false);
});
