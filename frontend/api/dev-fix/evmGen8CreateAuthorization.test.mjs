// EVM generation 8 create authorization (D3) and the coin-page reader, against the real MwzV4Launcher, hook and
// lens on a local anvil chain (no fork, chain 97): the API's signature is the one the launcher verifies, a launch with
// it succeeds, the first-buy estimate is what the pool pays, and every refusal answers before signing.
import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import {
  Gen8CreateError,
  gen8CreateAuthorization,
  gen8CreateSigner,
  isGen8CreateRequest,
  parseGen8CreateRequest,
} from "./evmGen8CreateAuthorization.js";
import { GEN8_TARGET_DEFAULT_USD, GEN8_TARGET_TEST_USD, gen8AuthorizationPayload, gen8HashRequest, gen8PoolId, gen8PoolKey, gen8Progress } from "../../shared/evmGen8.mjs";
import { deployGen8Local, directSwap, gen8ArtifactsAvailable, gen8EnvFor, startAnvil } from "../lib/evmGen8LocalChain.testkit.mjs";

const LAUNCHER = "0x1111111111111111111111111111111111111111";
const HOOK = "0x2222222222222222222222222222222222222222";
const CREATOR = "0x3333333333333333333333333333333333333333";
const baseEnv = { EVM_GEN8_LAUNCHER_97: LAUNCHER, EVM_GEN8_HOOK_97: HOOK, EVM_GEN8_POOL_MANAGER_97: "0x4444444444444444444444444444444444444444" };
const request = (over = {}) => ({ name: "Gen Eight", symbol: "GEN8", logoURI: "ipfs://logo", ...over });

test("a create request is gen-8 only where gen-8 is configured and the request names that launcher", () => {
  assert.equal(isGen8CreateRequest({ chainId: 97, factoryAddress: LAUNCHER }, {}), false, "inert without env");
  assert.equal(isGen8CreateRequest({ chainId: 97, factoryAddress: LAUNCHER }, baseEnv), true);
  assert.equal(isGen8CreateRequest({ chainId: 97, launcherAddress: LAUNCHER.toUpperCase().replace("0X", "0x") }, baseEnv), true);
  assert.equal(isGen8CreateRequest({ chainId: 97, generation: 8 }, baseEnv), true);
  assert.equal(isGen8CreateRequest({ chainId: 97, factoryAddress: CREATOR }, baseEnv), false, "a gen-7 factory stays on the gen-7 path");
  assert.equal(isGen8CreateRequest({ chainId: 56, factoryAddress: LAUNCHER }, baseEnv), false, "other chain");
});

test("request parsing: targets, fee choice, first buy, metadata hash", () => {
  const p = parseGen8CreateRequest({ campaignRequest: request() }, 97, baseEnv);
  assert.equal(p.fields.targetUsd, GEN8_TARGET_DEFAULT_USD, "no target = $50K");
  assert.equal(p.fields.feeChoice, 1);
  assert.equal(p.fields.feeCreatorPct, 0);
  assert.equal(p.fields.firstBuyValue, 0n);
  assert.match(p.fields.metadataHash, /^0x[0-9a-f]{64}$/);
  assert.equal(p.minFirstBuyOut, null);
  assert.equal(parseGen8CreateRequest({ campaignRequest: request({ feeChoice: "split", feeCreatorPct: 40 }) }, 97, baseEnv).fields.feeChoice, 3);
  assert.equal(parseGen8CreateRequest({ campaignRequest: request({ feeChoice: 2, feeCreatorPct: 40 }) }, 97, baseEnv).fields.feeCreatorPct, 0, "only split carries a pct");
  const err = (fn, code) => assert.throws(fn, (e) => e instanceof Gen8CreateError && e.code === code);
  err(() => parseGen8CreateRequest({ campaignRequest: request({ graduationTarget: (15_000n * 10n ** 18n).toString() }) }, 97, baseEnv), "GEN8_TARGET_UNSUPPORTED");
  err(() => parseGen8CreateRequest({ campaignRequest: request({ graduationTarget: GEN8_TARGET_TEST_USD.toString() }) }, 97, baseEnv), "GEN8_TARGET_UNSUPPORTED");
  err(() => parseGen8CreateRequest({ campaignRequest: request({ graduationTarget: GEN8_TARGET_TEST_USD.toString() }) }, 56, { ...baseEnv, ENABLE_TEST_GRADUATION_THRESHOLD: "1" }), "GEN8_TARGET_UNSUPPORTED");
  assert.equal(parseGen8CreateRequest({ campaignRequest: request({ graduationTarget: GEN8_TARGET_TEST_USD.toString() }) }, 97, { ...baseEnv, ENABLE_TEST_GRADUATION_THRESHOLD: "1" }).fields.targetUsd, GEN8_TARGET_TEST_USD);
  err(() => parseGen8CreateRequest({ campaignRequest: request({ feeChoice: "split" }) }, 97, baseEnv), "GEN8_FEE_CHOICE_INVALID");
  err(() => parseGen8CreateRequest({ campaignRequest: request({ feeChoice: "burn" }) }, 97, baseEnv), "GEN8_FEE_CHOICE_INVALID");
  err(() => parseGen8CreateRequest({ campaignRequest: request({ firstBuyValue: "-1" }) }, 97, baseEnv), "GEN8_CREATE_FIELD_INVALID");
  err(() => parseGen8CreateRequest({ campaignRequest: request({ metadataHash: "0x12" }) }, 97, baseEnv), "GEN8_CREATE_FIELD_INVALID");
  err(() => parseGen8CreateRequest({ campaignRequest: request({ logoURI: "" }) }, 97, baseEnv), "GEN8_CREATE_FIELD_INVALID");
});

test("signer: dedicated gen-8 key first, else the route authority key, else none", () => {
  const a = ethers.Wallet.createRandom();
  const b = ethers.Wallet.createRandom();
  assert.equal(gen8CreateSigner({ EVM_GEN8_CREATE_SIGNER_PRIVATE_KEY: a.privateKey }, b.privateKey).address, a.address);
  assert.equal(gen8CreateSigner({}, b.privateKey).address, b.address);
  assert.equal(gen8CreateSigner({}, ""), null);
});

test("refusals before any signature: not configured, no signer, quote-bound, preflight blocked", async () => {
  const deps = (over = {}) => ({
    env: baseEnv,
    signer: ethers.Wallet.createRandom(),
    getProvider: async () => { throw new Error("must not read chain"); },
    evaluateCreatePreflight: async () => ({ allowed: true }),
    getRouteDecision: async () => ({ tradeRouteProfileId: 1, finalizeRouteProfileId: 1, decision: null }),
    logRouteAuthorization: async () => { throw new Error("must not log"); },
    ...over,
  });
  const body = { chainId: 97, walletAddress: CREATOR, factoryAddress: LAUNCHER, campaignRequest: request() };
  assert.equal((await gen8CreateAuthorization(body, deps({ env: {} }))).body.code, "GEN8_NOT_CONFIGURED");
  assert.equal((await gen8CreateAuthorization(body, deps({ signer: null }))).status, 503);
  const quote = await gen8CreateAuthorization({ ...body, stockToken: CREATOR }, deps());
  assert.deepEqual([quote.status, quote.body.code], [400, "GEN8_NATIVE_ONLY"]);
  const wrong = await gen8CreateAuthorization({ ...body, factoryAddress: CREATOR }, deps());
  assert.deepEqual([wrong.status, wrong.body.code], [400, "GEN8_LAUNCHER_MISMATCH"]);
  const blocked = await gen8CreateAuthorization(body, deps({ evaluateCreatePreflight: async () => ({ allowed: false, reasons: ["Wallet is restricted."] }) }));
  assert.deepEqual([blocked.status, blocked.body.code, blocked.body.error], [403, "CREATE_PREFLIGHT_BLOCKED", "Wallet is restricted."]);
});

const chainTests = gen8ArtifactsAvailable() ? test : test.skip;

chainTests("the API's create authorization is the one MwzV4Launcher verifies; launch, campaign state and refusals on a local chain", { timeout: 240_000 }, async (t) => {
  const anvil = await startAnvil();
  t.after(() => anvil.stop());
  const provider = anvil.provider();
  const local = await deployGen8Local(provider);
  const env = { ...gen8EnvFor(local), ENABLE_TEST_GRADUATION_THRESHOLD: "1", ROUTE_AUTH_TTL_SECONDS: "600" };
  const logged = [];
  const apiSigner = new ethers.Wallet(local.apiSigner.privateKey);
  const deps = (over = {}) => ({
    env,
    signer: apiSigner,
    getProvider: async () => provider,
    evaluateCreatePreflight: async ({ walletAddress, chainId }) => ({ allowed: true, walletAddress, chainId }),
    getRouteDecision: async () => ({ tradeRouteProfileId: 1, finalizeRouteProfileId: 1, decision: { profile: "standard_unlinked" } }),
    logRouteAuthorization: async (row) => { logged.push(row); },
    now: () => Date.now(),
    ...over,
  });
  const creator = local.creator;
  const body = (over = {}) => ({
    chainId: 97,
    walletAddress: creator.address,
    factoryAddress: local.addresses.launcher,
    campaignRequest: request({ graduationTarget: GEN8_TARGET_TEST_USD.toString(), firstBuyValue: ethers.parseEther("0.005").toString(), description: "a coin", ...over }),
  });

  // 1. Signature = launcher.authorizationDigest, and a launch with it succeeds.
  const res = await gen8CreateAuthorization(body(), deps());
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { launchRequest, authorization, firstBuy } = res.body;
  assert.equal(res.body.launcher, local.addresses.launcher);
  assert.equal(res.body.generation.factoryGeneration, 8);
  const onChainDigest = await local.launcher.authorizationDigest(creator.address, launchRequest, authorization.deadline);
  assert.equal(onChainDigest, authorization.digest, "API digest == MwzV4Launcher.authorizationDigest");
  assert.equal(await local.launcher.hashRequest(launchRequest), gen8HashRequest(launchRequest), "hashRequest matches");
  assert.equal(ethers.verifyMessage(ethers.getBytes(gen8AuthorizationPayload({ chainId: 97, launcher: local.addresses.launcher, creator: creator.address, request: launchRequest, deadline: authorization.deadline })), authorization.signature), apiSigner.address);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].routeKind, "create");
  assert.equal(logged[0].metadata.generation.factoryGeneration, 8);
  assert.equal(logged[0].factoryAddress, local.addresses.launcher);
  assert.equal(launchRequest.firstBuyValue, ethers.parseEther("0.005").toString());
  assert.ok(BigInt(launchRequest.minFirstBuyOut) > 0n && BigInt(launchRequest.minFirstBuyOut) <= BigInt(firstBuy.expectedCoinsOut));

  const launcherAsCreator = local.launcher.connect(creator);
  const auth = { deadline: authorization.deadline, signature: authorization.signature };
  const rc = await (await launcherAsCreator.launch(launchRequest, auth, { value: BigInt(launchRequest.firstBuyValue) })).wait();
  const launched = rc.logs.map((l) => { try { return local.launcher.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Launched");
  assert.ok(launched, "Launched emitted");
  const token = launched.args.token;
  assert.equal(String(launched.args.id).toLowerCase(), gen8PoolId(token, local.addresses.hook), "pool id = keccak(pool key)");
  assert.equal(launched.args.firstBuyOut.toString(), firstBuy.expectedCoinsOut, "first-buy estimate is exact");
  assert.equal(launched.args.firstBuyIn.toString(), launchRequest.firstBuyValue);

  // 2. The same authorization cannot be used twice, nor by another wallet.
  await assert.rejects(launcherAsCreator.launch(launchRequest, auth, { value: BigInt(launchRequest.firstBuyValue) }));
  const res2 = await gen8CreateAuthorization(body({ firstBuyValue: "0" }), deps());
  assert.equal(res2.status, 200);
  assert.equal(res2.body.launchRequest.minFirstBuyOut, "0");
  await assert.rejects(local.launcher.connect(local.other).launch(res2.body.launchRequest, { deadline: res2.body.authorization.deadline, signature: res2.body.authorization.signature }));
  assert.notEqual(res2.body.launchRequest.salt, launchRequest.salt, "a fresh API salt per authorization");

  // 3. A split coin: the hook creator is the creator-choice vault.
  const split = await gen8CreateAuthorization(body({ feeChoice: "split", feeCreatorPct: 40, firstBuyValue: "0" }), deps());
  assert.equal(split.status, 200, JSON.stringify(split.body));
  const rcSplit = await (await launcherAsCreator.launch(split.body.launchRequest, { deadline: split.body.authorization.deadline, signature: split.body.authorization.signature })).wait();
  const ls = rcSplit.logs.map((l) => { try { return local.launcher.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Launched");
  assert.equal(ls.args.hookCreator, local.addresses.choiceVault);
  assert.equal(Number(ls.args.feeCreatorPct), 40);

  // 4. Refusals that need the chain.
  const tooBig = await gen8CreateAuthorization(body({ firstBuyValue: ethers.parseEther("100").toString() }), deps());
  assert.deepEqual([tooBig.status, tooBig.body.code], [400, "GEN8_FIRST_BUY_TOO_LARGE"]);
  const minHigh = await gen8CreateAuthorization(body({ minFirstBuyOut: (10n ** 30n).toString() }), deps());
  assert.deepEqual([minHigh.status, minHigh.body.code], [400, "GEN8_FIRST_BUY_MIN_OUT_TOO_HIGH"]);
  const otherKey = await gen8CreateAuthorization(body(), deps({ signer: ethers.Wallet.createRandom() }));
  assert.deepEqual([otherKey.status, otherKey.body.code], [503, "ROUTE_AUTHORITY_MISMATCH"]);
  await (await local.launcher.connect(local.safe).setCreatePaused(true)).wait();
  const paused = await gen8CreateAuthorization(body(), deps());
  assert.deepEqual([paused.status, paused.body.code], [503, "CREATE_FACTORY_NOT_READY"]);
  await (await local.launcher.connect(local.safe).setCreatePaused(false)).wait();
  const { gen8RoutingStatus } = await import("./evmGen8CreateAuthorization.js");
  const st = await gen8RoutingStatus({ chainId: 97, signer: apiSigner, getProvider: async () => provider, env });
  assert.deepEqual([st.status, st.ok, st.tradeAuthorization], ["ready", true, "none"]);
  const stWrong = await gen8RoutingStatus({ chainId: 97, signer: ethers.Wallet.createRandom(), getProvider: async () => provider, env });
  assert.equal(stWrong.status, "route_authority_mismatch");

  // 5. Campaign state from the hook / PoolManager / lens, and the progress the list computes from the indexer row.
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  t.after(() => { for (const k of Object.keys(env)) delete process.env[k]; });
  const { readGen8CampaignState, readGen8Pool } = await import("../lib/evmGen8CampaignState.js");
  const { evmCampaignStateHandler, clearEvmCampaignStateCache } = await import("../evmCampaignState.js");
  const { gen8ConfigFor } = await import("../lib/evmGen8Config.js");
  const { findGen8Coin } = await import("../lib/evmGen8Coins.js");
  const { gen8ItemProgress } = await import("../lib/evmCampaignProgress.js");
  const cfg = gen8ConfigFor(97, env);
  const key = gen8PoolKey(token, cfg.hook);
  await directSwap(local, key, local.buyer, { buy: true, amount: ethers.parseEther("0.002") });
  const pool = await readGen8Pool({ provider, cfg, token });
  assert.ok(pool);
  const state = await readGen8CampaignState({ provider, cfg, token, wallet: creator.address, pool });
  assert.equal(state.economics.generationKind, "gen8");
  assert.equal(state.gen8.tradePath, "gen8_pool");
  assert.equal(state.graduation.state, "trading");
  assert.equal(state.creator, creator.address);
  const lp = await local.lens.progress(pool.poolId);
  assert.equal(state.market.sqrtPriceX96, lp.sqrtPriceX96.toString(), "slot0 via extsload == lens");
  assert.equal(state.graduation.sold, lp.coinsSoldFromA.toString(), "progress == MwzLaunchLens.progress");
  assert.equal(state.graduation.curveSupply, lp.coinsInA.toString());
  assert.equal(state.tradeFee.currentBps, Number(await local.lens.currentFeeBps(pool.poolId, local.addresses.poolManager, { blockTag: state.blockNumber })), "fee rate == lens (same block)");
  assert.equal(state.creatorClaims.hookCreatorOwedWei, (await local.hook.creatorOwed(pool.poolId)).toString());
  assert.ok(BigInt(state.creatorClaims.hookCreatorOwedWei) > 0n, "560 bps of the bonding fees are the creator's");
  assert.equal(state.creatorClaims.reserve.amount, (20_000_000n * 10n ** 18n).toString());
  assert.equal(state.creatorClaims.reserve.releasable, false);
  assert.equal(state.viewer.canClaimHookCreatorFees, true);
  const listPct = await gen8ItemProgress({ chainId: 97, gen8: { poolId: pool.poolId, phase: "bonding", pool: { liqA: pool.liqA.toString(), tickStart: pool.tickStart, tickGrad: pool.tickGrad, sqrtPriceX96: lp.sqrtPriceX96.toString() } } }, { env });
  assert.equal(listPct, gen8Progress({ liqA: pool.liqA, tickStart: pool.tickStart, tickGrad: pool.tickGrad, sqrtPriceX96: lp.sqrtPriceX96 }).pct);
  assert.equal(listPct, Number((lp.coinsSoldFromA * 10_000n) / lp.coinsInA) / 100);
  const lensPct = await gen8ItemProgress({ chainId: 97, gen8: { poolId: pool.poolId, phase: "bonding", pool: null } }, { env, readLens: (c, lens, id) => local.lens.progress(id) });
  assert.equal(lensPct, listPct, "lens fallback == indexer-row progress");

  // Handler: gen-8 coin answered from the hook; any other address falls through to the gen-5 reader.
  clearEvmCampaignStateCache();
  const call = async (campaign) => {
    const out = { headers: {} };
    const res3 = { statusCode: 0, setHeader: (k, v) => { out.headers[k] = v; }, end: (text) => { out.code = res3.statusCode; out.body = JSON.parse(text); } };
    await evmCampaignStateHandler(
      { method: "GET", url: `/api/evm/campaign-state?chainId=97&campaign=${campaign}`, headers: {} },
      res3,
      { getProvider: async () => provider, readState: async () => ({ supported: false, from: "gen5" }), gen8Config: () => cfg },
    );
    return out;
  };
  const g8 = await call(token);
  assert.equal(g8.body.economics.generationKind, "gen8");
  const other = await call(local.addresses.splitter);
  assert.equal(other.body.from, "gen5");

  // findGen8Coin from the hook alone (no database row yet).
  const coin = await findGen8Coin({ chainId: 97, address: token, db: null, getProvider: async () => provider, env });
  assert.equal(coin.poolId, pool.poolId);
  assert.equal(coin.source, "hook");
  assert.equal(await findGen8Coin({ chainId: 97, address: local.addresses.splitter, db: null, getProvider: async () => provider, env }), null);
});
