import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { buildTradeAuthorizationDigest } from "./dev-fix/routeAuthorizationSigner.js";
import {
  BUYBACK_ROUTE_PROFILE,
  TRADE_AUTH_BUY_EXACT_NATIVE,
  configuredCreatorVault,
  createEvmBuybackAuthorizationHandler,
  createEvmCreatorChoiceReadHandlers,
} from "./evmCreatorChoice.js";

const CHAIN = 56;
const VAULT = ethers.getAddress("0x00000000000000000000000000000000000000aa");
const FACTORY = ethers.getAddress("0x00000000000000000000000000000000000000fa");
const CAMPAIGN = ethers.getAddress("0x00000000000000000000000000000000000000c1");
const SECRET = "s3cret-for-tests";
const E18 = 10n ** 18n;
const signer = new ethers.Wallet("0x" + "11".repeat(32));

const campaignIface = new ethers.Interface([
  "function factory() view returns (address)",
  "function launched() view returns (bool)",
  "function graduationPending() view returns (bool)",
  "function quoteBuyExactBnb(uint256) view returns (uint256,uint256,uint256)",
]);
const factoryIface = new ethers.Interface([
  "function FACTORY_GENERATION() view returns (uint32)",
  "function isCampaign(address) view returns (bool)",
  "function campaignFeeChoice(address) view returns (address,uint8,uint8)",
  "function routeAuthority() view returns (address)",
]);
const vaultIface = new ethers.Interface([
  "function factory() view returns (address)",
  "function cfg(address) view returns (address,uint8,uint8,address,address)",
  "function limits() view returns (bool,uint256,uint256,uint256,uint256,uint256)",
  "function buybackBalance(address) view returns (uint256)",
]);

function world(over = {}) {
  const s = {
    chainId: CHAIN,
    campaignFactory: FACTORY,
    vaultFactory: FACTORY,
    isCampaign: true,
    generation: 6,
    feeChoice: [VAULT, 4, 0],
    cfgChoice: 4,
    paused: false,
    buyPerTx: E18,
    balance: 2n * E18,
    launched: false,
    pending: false,
    tokensOut: 1_000_000n * E18,
    authority: signer.address,
    ...over,
  };
  const table = {
    [CAMPAIGN]: [campaignIface, {
      factory: () => [s.campaignFactory], launched: () => [s.launched], graduationPending: () => [s.pending],
      quoteBuyExactBnb: () => [s.tokensOut, 1n, 0n],
    }],
    [FACTORY]: [factoryIface, {
      FACTORY_GENERATION: () => [s.generation], isCampaign: () => [s.isCampaign], campaignFeeChoice: () => s.feeChoice,
      routeAuthority: () => [s.authority],
    }],
    [VAULT]: [vaultIface, {
      factory: () => [s.vaultFactory], cfg: () => [ethers.ZeroAddress, s.cfgChoice, 0, ethers.ZeroAddress, ethers.ZeroAddress],
      limits: () => [s.paused, s.buyPerTx, 3n * E18, 3600n, 50n, 10n * E18], buybackBalance: () => [s.balance],
    }],
  };
  const provider = {
    async getNetwork() {
      return { chainId: BigInt(s.chainId) };
    },
    async call(tx) {
      const entry = table[ethers.getAddress(tx.to)];
      if (!entry) throw new Error(`no contract at ${tx.to}`);
      const [iface, fns] = entry;
      const fragment = iface.getFunction(tx.data.slice(0, 10));
      return iface.encodeFunctionResult(fragment, fns[fragment.name]());
    },
  };
  provider.provider = provider;
  return provider;
}

function makeRes() {
  return {
    statusCode: 0,
    body: null,
    setHeader() {},
    end(text) {
      this.body = JSON.parse(text);
    },
  };
}

const NOW_MS = 1_800_000_000_000;

function handler(over = {}, deps = {}) {
  const logs = [];
  const h = createEvmBuybackAuthorizationHandler({
    env: { EVM_CREATOR_CHOICE_API_SECRET: SECRET, [`EVM_CREATOR_VAULT_V2_${CHAIN}`]: `${VAULT}@123`, ...(deps.env || {}) },
    getProvider: async () => world(over),
    signer: "signer" in deps ? deps.signer : signer,
    logAuthorization: async (e) => logs.push(e),
    nowMs: () => NOW_MS,
  });
  return { h, logs };
}

async function call(h, body, headers = { "x-mwz-internal-secret": SECRET }, method = "POST") {
  const res = makeRes();
  await h({ method, headers, body }, res);
  return res;
}

const good = () => ({ chainId: CHAIN, campaign: CAMPAIGN, vault: VAULT, amountIn: (E18 / 10n).toString(), minOut: ((1_000_000n * E18 * 99n) / 100n).toString() });

test("signs the vault's buyback authorization: actor = vault, profile 1, action 1, deadline at most 10 minutes", async () => {
  const { h, logs } = handler();
  const res = await call(h, good());
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const deadline = Number(res.body.deadline);
  assert.equal(deadline, NOW_MS / 1000 + 600);
  assert.equal(res.body.actor, VAULT);
  assert.equal(res.body.routeProfile, BUYBACK_ROUTE_PROFILE);
  assert.equal(res.body.action, TRADE_AUTH_BUY_EXACT_NATIVE);
  const digest = buildTradeAuthorizationDigest({
    chainId: CHAIN, campaign: CAMPAIGN, actor: VAULT, routeProfile: 1, action: 1, amount: E18 / 10n, limit: BigInt(good().minOut), deadline,
  });
  assert.equal(ethers.verifyMessage(ethers.getBytes(digest), res.body.signature), signer.address);
  // The same digest LaunchCampaign._verifyTradeRouteAuthorization builds.
  const onchain = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "uint256", "address", "address", "uint8", "uint8", "uint256", "uint256", "uint64"],
    ["MWZ_ROUTE_TRADE_AUTH", CHAIN, CAMPAIGN, VAULT, 1, 1, E18 / 10n, BigInt(good().minOut), deadline],
  ));
  assert.equal(onchain, digest);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].walletAddress, VAULT);
  assert.equal(logs[0].routeKind, "trade");
});

test("the deadline is clamped to 60..600 seconds", async () => {
  const { h } = handler();
  assert.equal(Number((await call(h, { ...good(), ttlSeconds: 86_400 })).body.deadline), NOW_MS / 1000 + 600);
  assert.equal(Number((await call(h, { ...good(), ttlSeconds: 1 })).body.deadline), NOW_MS / 1000 + 60);
  assert.equal(Number((await call(h, { ...good(), ttlSeconds: 120 })).body.deadline), NOW_MS / 1000 + 120);
});

test("fails closed without the shared secret, with a wrong one, or without a route signer", async () => {
  const noSecret = createEvmBuybackAuthorizationHandler({ env: {}, getProvider: async () => world(), signer });
  assert.equal((await call(noSecret, good())).statusCode, 503);
  const { h } = handler();
  assert.equal((await call(h, good(), {})).statusCode, 401);
  assert.equal((await call(h, good(), { "x-mwz-internal-secret": SECRET + "x" })).statusCode, 401);
  assert.equal((await call(h, good(), { "x-mwz-internal-secret": SECRET }, "GET")).statusCode, 405);
  const noSigner = handler({}, { signer: null }).h;
  const res = await call(noSigner, good());
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, "ROUTE_SIGNER_UNAVAILABLE");
});

test("refuses anything but the configured vault acting for its own buyback campaign", async () => {
  const cases = [
    [{}, { ...good(), chainId: 1 }, "CHAIN_NOT_SUPPORTED"],
    [{}, { ...good(), vault: CAMPAIGN }, "VAULT_MISMATCH"],
    [{}, { ...good(), actor: signer.address }, "ACTOR_NOT_VAULT"],
    [{}, { ...good(), amountIn: "0" }, "BAD_REQUEST"],
    [{}, { ...good(), minOut: "-1" }, "BAD_REQUEST"],
    [{ chainId: 97 }, good(), "RPC_CHAIN_MISMATCH"],
    [{ campaignFactory: signer.address }, good(), "FACTORY_MISMATCH"],
    [{ isCampaign: false }, good(), "NOT_A_CAMPAIGN"],
    [{ generation: 5 }, good(), "GENERATION_NOT_SUPPORTED"],
    [{ feeChoice: [VAULT, 1, 0] }, good(), "NOT_BUYBACK"],
    [{ feeChoice: [CAMPAIGN, 4, 0] }, good(), "NOT_BUYBACK"],
    [{ cfgChoice: 2 }, good(), "NOT_BUYBACK"],
    [{ paused: true }, good(), "OPERATOR_PAUSED"],
    [{ buyPerTx: E18 / 20n }, good(), "ABOVE_BUY_CAP"],
    [{ balance: E18 / 20n }, good(), "ABOVE_BUYBACK_BALANCE"],
    [{ launched: true }, good(), "CURVE_CLOSED"],
    [{ pending: true }, good(), "CURVE_CLOSED"],
    [{}, { ...good(), minOut: ((1_000_000n * E18 * 94n) / 100n).toString() }, "MIN_OUT_OUT_OF_RANGE"],
    [{}, { ...good(), minOut: (1_000_001n * E18).toString() }, "MIN_OUT_OUT_OF_RANGE"],
    [{ authority: CAMPAIGN }, good(), "ROUTE_AUTHORITY_MISMATCH"],
  ];
  for (const [over, body, code] of cases) {
    const { h, logs } = handler(over);
    const res = await call(h, body);
    const show = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
    assert.equal(res.body.code, code, `${show(over)} ${show(body)} -> ${show(res.body)}`);
    assert.ok(res.statusCode >= 400);
    assert.equal(res.body.signature, undefined);
    assert.equal(logs.length, 0);
  }
  const unset = createEvmBuybackAuthorizationHandler({ env: { EVM_CREATOR_CHOICE_API_SECRET: SECRET }, getProvider: async () => world(), signer });
  assert.equal((await call(unset, good())).body.code, "VAULT_NOT_CONFIGURED");
});

test("configuredCreatorVault reads the indexer's EVM_CREATOR_VAULT_V2_<id> format", () => {
  assert.equal(configuredCreatorVault(56, { EVM_CREATOR_VAULT_V2_56: `${VAULT.toLowerCase()}@77, 0x00000000000000000000000000000000000000bb@9` }), VAULT);
  assert.equal(configuredCreatorVault(56, {}), "");
  assert.equal(configuredCreatorVault(56, { EVM_CREATOR_VAULT_V2_56: "nope" }), "");
});

test("read routes: week commitments and published holder leaf files", async () => {
  const db = {
    async query(sql, params) {
      if (/evm_creator_choice_weeks/.test(sql)) return { rows: [{ week_id: "2026-09-28", commitment: "ab", secret: null, revealed_at: null }] };
      if (/evm_holder_batches/.test(sql)) {
        return params[1] === "2026-09-21" ? { rows: [{ week_id: "2026-09-21", batch_id: "0x01", status: "proposed", leaf_file: { root: "0x02" }, executable_at: null, last_reason: "waiting" }] } : { rows: [] };
      }
      return { rows: [] };
    },
  };
  const { weeks, holderBatch } = createEvmCreatorChoiceReadHandlers({ db });
  let res = makeRes();
  await weeks({ method: "GET", url: "/api/evm/creator-choice?chainId=56" }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.weeks[0].commitment, "ab");
  assert.match(res.body.rule, /evm-week/);
  res = makeRes();
  await weeks({ method: "GET", url: "/api/evm/creator-choice?chainId=1" }, res);
  assert.equal(res.statusCode, 400);
  res = makeRes();
  await holderBatch({ method: "GET", url: "/api/evm/holder-batch?chainId=56&weekId=2026-09-21" }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.leafFile, { root: "0x02" });
  res = makeRes();
  await holderBatch({ method: "GET", url: "/api/evm/holder-batch?chainId=56&weekId=2026-09-14" }, res);
  assert.equal(res.statusCode, 404);
  res = makeRes();
  await holderBatch({ method: "GET", url: "/api/evm/holder-batch?chainId=56" }, res);
  assert.equal(res.statusCode, 400);
});
