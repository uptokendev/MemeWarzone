// DogeOS (6281971) route authorization and draft gates (plan t16, spec §1 Route authority / §3).
//
// The API handlers run unchanged against a local JSON-RPC stub that plays a LaunchFactoryGen7, so no
// request leaves this machine. Every private key below is a throwaway test key, never a real one.
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { ethers } from "ethers";

import {
  assertSupportedGenerations,
  expectedCampaignGeneration,
  generationRule,
  isSupportedGenerationPair,
} from "./routeAuthorizationSigner.js";

// route-auth.js, draft-deploy-base.js and drafts-base.js import the DB module, which needs a URL
// (never connected: every request here is answered before a query).
process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:1/test";

const DOGEOS = 6281971;
const WAD = 10n ** 18n;
const usd = (n) => (BigInt(n) * WAD).toString();
const FACTORY = "0x1111111111111111111111111111111111111111";
const CREATOR = "0x2222222222222222222222222222222222222222";

// Throwaway keys: the factory's route authority, an unrelated global key, and a Robinhood-only key.
const AUTHORITY_KEY = `0x${"a1".repeat(32)}`;
const OTHER_KEY = `0x${"b2".repeat(32)}`;
const AUTHORITY = new ethers.Wallet(AUTHORITY_KEY).address;

const FACTORY_ABI = new ethers.Interface([
  "function routeAuthority() view returns (address)",
  "function live() view returns (bool)",
  "function globalPaused() view returns (bool)",
  "function createPaused() view returns (bool)",
  "function creatorRegistry() view returns (address)",
  "function FACTORY_GENERATION() view returns (uint32)",
  "function CAMPAIGN_GENERATION() view returns (uint32)",
  "function creatorLaunchEligibility(address creator) view returns (bool allowed,uint256 cooldownEndsAt,uint256 currentLiveCount,uint256 maxLiveBonding)",
]);

// What the stub factory answers. Eligibility is "not allowed" so an arm that passes the route-authority
// check stops at the next (eligibility) check instead of reaching the database.
const FACTORY_STATE = {
  routeAuthority: [AUTHORITY],
  live: [true],
  globalPaused: [false],
  createPaused: [false],
  creatorRegistry: [ethers.ZeroAddress],
  FACTORY_GENERATION: [7],
  CAMPAIGN_GENERATION: [6],
  creatorLaunchEligibility: [false, 0, 0, 3],
};

function answer(call) {
  const { method, params = [] } = call;
  if (method === "eth_chainId") return ethers.toQuantity(DOGEOS);
  if (method === "net_version") return String(DOGEOS);
  if (method === "eth_blockNumber") return "0x1";
  if (method === "eth_getCode") return String(params[0]).toLowerCase() === FACTORY.toLowerCase() ? "0x6080" : "0x";
  if (method === "eth_call") {
    const tx = params[0] || {};
    if (String(tx.to).toLowerCase() !== FACTORY.toLowerCase()) throw new Error("call to an unknown address");
    const fragment = FACTORY_ABI.getFunction(String(tx.data).slice(0, 10));
    return FACTORY_ABI.encodeFunctionResult(fragment, FACTORY_STATE[fragment.name]);
  }
  throw new Error(`unsupported method ${method}`);
}

const rpc = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const reply = (call) => {
      try {
        return { jsonrpc: "2.0", id: call.id, result: answer(call) };
      } catch (error) {
        return { jsonrpc: "2.0", id: call.id, error: { code: -32000, message: String(error.message) } };
      }
    };
    const parsed = JSON.parse(raw);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(reply) : reply(parsed)));
  });
});
await new Promise((resolve) => rpc.listen(0, "127.0.0.1", resolve));
const RPC_URL = `http://127.0.0.1:${rpc.address().port}`;
test.after(() => rpc.close());

// Every chain the handlers read here is pointed at the stub, so none falls back to a public RPC.
process.env.DOGEOS_RPC_HTTP_6281971 = RPC_URL;
process.env.ROBINHOOD_RPC_HTTP_46630 = RPC_URL;
process.env.BSC_RPC_HTTP_97 = RPC_URL;

const { routingCreateAuthorization, routingStatus } = await import("./route-auth.js");
const { draftDeploy } = await import("./draft-deploy.js");
const { normalizeTargetForGeneration } = await import("./draft-deploy-base.js");
const { drafts } = await import("./drafts-base.js");

const ROUTE_KEY_ENV = [
  "ROUTE_AUTHORITY_PRIVATE_KEY",
  "MWZ_ROUTE_AUTHORITY_PRIVATE_KEY",
  "ROUTE_AUTH_PRIVATE_KEY",
  "ROUTE_AUTHORITY_PRIVATE_KEY_6281971",
  "ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY",
  "ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY_6281971",
  "ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY_46630",
];

async function withEnv(values, work) {
  const keys = new Set([...ROUTE_KEY_ENV, "VITE_ENABLE_TEST_GRADUATION_THRESHOLD", "CREATE_CANARY_WALLETS", ...Object.keys(values)]);
  const previous = new Map([...keys].map((key) => [key, process.env[key]]));
  for (const key of keys) {
    const value = values[key];
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await work();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function responseRecorder() {
  let body = null;
  return {
    statusCode: 200,
    setHeader() {},
    end(value) {
      body = value == null || value === "" ? null : JSON.parse(String(value));
    },
    get body() {
      return body;
    },
  };
}

function post(body) {
  return { method: "POST", body, async *[Symbol.asyncIterator]() {} };
}

async function call(handler, req) {
  const res = responseRecorder();
  await handler(req, res);
  return res;
}

function createRequest(chainId, graduationTarget) {
  return post({
    chainId,
    walletAddress: CREATOR,
    factoryAddress: FACTORY,
    campaignRequest: { name: "Doge Seven", symbol: "DSEVEN", logoURI: "ipfs://doge", graduationTarget },
  });
}

test("6281971 signs exactly the gen-7 pair 7/6", () => {
  assert.equal(isSupportedGenerationPair(DOGEOS, 7, 6), true);
  for (const [f, c] of [[6, 5], [7, 5], [6, 6], [4, 3], [3, 2], [5, 4]]) {
    assert.equal(isSupportedGenerationPair(DOGEOS, f, c), false, `${f}/${c}`);
  }
  assert.equal(generationRule(DOGEOS), "7/6");
  assert.equal(expectedCampaignGeneration(DOGEOS), 6);
  assert.deepEqual(assertSupportedGenerations(DOGEOS, 7, 6), { factoryGen: 7, campaignGen: 6 });
  assert.throws(() => assertSupportedGenerations(DOGEOS, 6, 5));
  // Existing chains keep their pairs.
  assert.equal(generationRule(46630), "4/3-or-6/5-or-7/6");
  assert.equal(generationRule(97), "3/2-or-4/2-or-4/3-or-6/5-or-7/6");
});

test("create authorization: the $150 gen-7 test tier passes the target gate on 6281971 (as on 97 and 46630)", async () => {
  await withEnv({ ENABLE_TEST_GRADUATION_THRESHOLD: "true", ROUTE_AUTHORITY_PRIVATE_KEY: OTHER_KEY }, async () => {
    // A signer that is not the factory's route authority stops right after the target gate, so
    // ROUTE_AUTHORITY_MISMATCH proves the target was accepted and the factory was read.
    for (const chainId of [97, 46630, DOGEOS]) {
      const res = await call(routingCreateAuthorization, createRequest(chainId, usd(150)));
      assert.equal(res.statusCode, 503, `${chainId}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, "ROUTE_AUTHORITY_MISMATCH", String(chainId));
    }
    // Mainnets never take the test tier.
    const mainnet = await call(routingCreateAuthorization, createRequest(56, usd(150)));
    assert.equal(mainnet.statusCode, 400);
    assert.equal(mainnet.body.error, "Unsupported graduation target");
  });
});

test("create authorization: the $150 tier on 6281971 follows the test-threshold switch", async () => {
  await withEnv({ ENABLE_TEST_GRADUATION_THRESHOLD: "false", ROUTE_AUTHORITY_PRIVATE_KEY: AUTHORITY_KEY }, async () => {
    const res = await call(routingCreateAuthorization, createRequest(DOGEOS, usd(150)));
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "Unsupported graduation target");
  });
});

test("create authorization: gen-7 on 6281971 refuses $6 and $15K before signing, with the matching signer", async () => {
  await withEnv({ ENABLE_TEST_GRADUATION_THRESHOLD: "true", ROUTE_AUTHORITY_PRIVATE_KEY: AUTHORITY_KEY }, async () => {
    for (const target of [usd(6), usd(15_000)]) {
      const res = await call(routingCreateAuthorization, createRequest(DOGEOS, target));
      assert.equal(res.statusCode, 400, `${target}: ${JSON.stringify(res.body)}`);
      // Refused by the generation check (the factory was read), not by the chain-level target gate.
      assert.match(res.body.error, /Generation 7 coins graduate at a \$30,000 or \$50,000 market cap/);
      assert.equal(res.body.authorization, undefined, "nothing is signed");
    }
  });
});

test("routing status: the global ROUTE_AUTHORITY_PRIVATE_KEY is the 6281971 signer and matches the factory", async () => {
  await withEnv({ ROUTE_AUTHORITY_PRIVATE_KEY: AUTHORITY_KEY, FACTORY_ADDRESS_6281971: FACTORY }, async () => {
    const res = await call(routingStatus, { method: "GET", url: `/api/routing/status?chainId=${DOGEOS}` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.chainId, DOGEOS);
    assert.equal(res.body.signerConfigured, true);
    assert.equal(res.body.routeAuthority, AUTHORITY);
    assert.equal(res.body.onchainRouteAuthority, AUTHORITY);
    assert.equal(res.body.matchesOnchain, true);
    assert.equal(res.body.status, "ready");
  });
});

function scheduledArm() {
  return post({ operation: "authorize_scheduled", chainId: DOGEOS, factoryAddress: FACTORY, walletAddress: CREATOR });
}

test("scheduled arm (draft-deploy.js): 6281971 resolves the global route-authority key, never the Robinhood one", async () => {
  // Global key = the factory's authority: the route-authority check passes and the arm stops at the
  // (stubbed) creator eligibility check.
  await withEnv({ FACTORY_ADDRESS_6281971: FACTORY, ROUTE_AUTHORITY_PRIVATE_KEY: AUTHORITY_KEY }, async () => {
    const res = await call(draftDeploy, scheduledArm());
    assert.equal(res.body.code, "SCHEDULED_CREATE_ONCHAIN_ELIGIBILITY_BLOCKED", JSON.stringify(res.body));
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.preflight.factoryGeneration, 7);
    assert.equal(res.body.preflight.campaignGeneration, 6);
  });
  // The Robinhood route-authority keys hold the factory's authority, the global key does not:
  // 6281971 is not a Robinhood chain, so the arm is refused as a mismatch.
  await withEnv(
    {
      FACTORY_ADDRESS_6281971: FACTORY,
      ROUTE_AUTHORITY_PRIVATE_KEY: OTHER_KEY,
      ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY: AUTHORITY_KEY,
      ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY_6281971: AUTHORITY_KEY,
    },
    async () => {
      const res = await call(draftDeploy, scheduledArm());
      assert.equal(res.statusCode, 503);
      assert.equal(res.body.code, "SCHEDULED_CREATE_ROUTE_AUTHORITY_MISMATCH");
    },
  );
  // No key at all: refused, never signed by anything else.
  await withEnv({ FACTORY_ADDRESS_6281971: FACTORY }, async () => {
    const res = await call(draftDeploy, scheduledArm());
    assert.equal(res.body.code, "SCHEDULED_CREATE_ROUTE_AUTHORITY_MISMATCH");
  });
});

test("scheduled arm targets on 6281971: gen-7 tiers incl. $150; $6 and $15K refused", async () => {
  await withEnv({ ENABLE_TEST_GRADUATION_THRESHOLD: null }, async () => {
    assert.equal(normalizeTargetForGeneration(DOGEOS, usd(150), 7), usd(150));
    assert.equal(normalizeTargetForGeneration(DOGEOS, usd(30_000), 7), usd(30_000));
    assert.equal(normalizeTargetForGeneration(DOGEOS, usd(50_000), 7), usd(50_000));
    assert.throws(() => normalizeTargetForGeneration(DOGEOS, usd(6), 7), /market cap/);
    assert.throws(() => normalizeTargetForGeneration(DOGEOS, usd(15_000), 7), /market cap/);
  });
});

function draftRequest(chainId, graduationTargetWei) {
  return post({ chainId, creatorWallet: CREATOR, name: "Doge Seven", ticker: "DSEVEN", graduationTargetWei });
}

test("draft save: 6281971 accepts the $150 gen-7 tier and still refuses $6", async () => {
  // Past the target gate the save asks for wallet auth (none is sent): 401, not INVALID_GRADUATION_TARGET.
  for (const chainId of [97, 46630, DOGEOS]) {
    const res = await call(drafts, draftRequest(chainId, usd(150)));
    assert.notEqual(res.body?.code, "INVALID_GRADUATION_TARGET", `${chainId}: ${JSON.stringify(res.body)}`);
    assert.equal(res.statusCode, 401, String(chainId));
  }
  for (const target of [usd(30_000), usd(50_000)]) {
    assert.equal((await call(drafts, draftRequest(DOGEOS, target))).statusCode, 401);
  }
  // $6: gen-7 arming refuses it, so a DogeOS draft may never be saved with it. Existing chains unchanged.
  const dogeos6 = await call(drafts, draftRequest(DOGEOS, usd(6)));
  assert.equal(dogeos6.statusCode, 400);
  assert.equal(dogeos6.body.code, "INVALID_GRADUATION_TARGET");
  assert.equal((await call(drafts, draftRequest(46630, usd(6)))).body.code, "INVALID_GRADUATION_TARGET");
  assert.equal((await call(drafts, draftRequest(97, usd(6)))).statusCode, 401);
  assert.equal((await call(drafts, draftRequest(56, usd(150)))).body.code, "INVALID_GRADUATION_TARGET");
});
