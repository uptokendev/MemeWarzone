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
  strictEvmWallet,
} from "./evmGen8CreateAuthorization.js";
import { GEN8_MAX_OPEN_DELAY_SECONDS, GEN8_TARGET_DEFAULT_USD, GEN8_TARGET_TEST_USD, gen8AuthorizationPayload, gen8MetadataHash, gen8HashRequest, gen8PoolId, gen8PoolKey, gen8Progress, gen8RevertReason, sqrtAtTick } from "../../shared/evmGen8.mjs";
import { advanceTime, deployGen8Local, directSwap, gen8ArtifactsAvailable, gen8EnvFor, startAnvil } from "../lib/evmGen8LocalChain.testkit.mjs";

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
  const launcherOnly = { EVM_GEN8_LAUNCHER_97: LAUNCHER };
  assert.equal(isGen8CreateRequest({ chainId: 97, generation: 8 }, launcherOnly), true, "generation 8 stays on gen-8 when the hook is missing");
  assert.equal(isGen8CreateRequest({ chainId: 97, factoryAddress: LAUNCHER }, launcherOnly), true, "the launcher address stays on gen-8 when the hook is missing");
  assert.equal(isGen8CreateRequest({ chainId: 97, factoryAddress: CREATOR }, launcherOnly), false, "a different factory stays on gen-7");
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
  err(() => parseGen8CreateRequest({ campaignRequest: request({ graduationTarget: GEN8_TARGET_TEST_USD.toString() }) }, 4663, { ...baseEnv, ENABLE_TEST_GRADUATION_THRESHOLD: "1" }), "GEN8_TARGET_UNSUPPORTED");
  assert.equal(parseGen8CreateRequest({ campaignRequest: request({ graduationTarget: GEN8_TARGET_TEST_USD.toString() }) }, 97, { ...baseEnv, ENABLE_TEST_GRADUATION_THRESHOLD: "1" }).fields.targetUsd, GEN8_TARGET_TEST_USD);
  err(() => parseGen8CreateRequest({ campaignRequest: request({ feeChoice: "split" }) }, 97, baseEnv), "GEN8_FEE_CHOICE_INVALID");
  err(() => parseGen8CreateRequest({ campaignRequest: request({ feeChoice: "burn" }) }, 97, baseEnv), "GEN8_FEE_CHOICE_INVALID");
  err(() => parseGen8CreateRequest({ campaignRequest: request({ firstBuyValue: "-1" }) }, 97, baseEnv), "GEN8_CREATE_FIELD_INVALID");
  err(() => parseGen8CreateRequest({ campaignRequest: request({ metadataHash: "0x12" }) }, 97, baseEnv), "GEN8_CREATE_FIELD_INVALID");
  err(() => parseGen8CreateRequest({ campaignRequest: request({ logoURI: "" }) }, 97, baseEnv), "GEN8_CREATE_FIELD_INVALID");
});

test("B-03: the server computes metadataHash from the record it logs; a different client hash is refused", () => {
  const fields = { name: "N", symbol: "S", logoURI: "ipfs://x", xAccount: "https://x.com/n", website: "https://n.xyz", extraLink: "", description: "the description shown in the app" };
  const expected = gen8MetadataHash(fields);
  const p = parseGen8CreateRequest({ campaignRequest: fields }, 97, baseEnv);
  assert.equal(p.fields.metadataHash, expected, "absent: server hash");
  assert.equal(p.description, fields.description);
  assert.equal(parseGen8CreateRequest({ campaignRequest: { ...fields, metadataHash: expected.toUpperCase().replace("0X", "0x") } }, 97, baseEnv).fields.metadataHash, expected, "equal (any case): accepted");
  assert.throws(
    () => parseGen8CreateRequest({ campaignRequest: { ...fields, metadataHash: ethers.id("anything at all") } }, 97, baseEnv),
    (e) => e instanceof Gen8CreateError && e.httpStatus === 400 && e.code === "GEN8_METADATA_HASH_MISMATCH" && e.details.expected === expected,
  );
  // A hash made for another description does not pass either.
  assert.throws(() => parseGen8CreateRequest({ campaignRequest: { ...fields, metadataHash: gen8MetadataHash({ ...fields, description: "other" }) } }, 97, baseEnv), (e) => e.code === "GEN8_METADATA_HASH_MISMATCH");
});

test("B-04: byte limits and forbidden characters on name, symbol, links and description", () => {
  const ok = (over) => parseGen8CreateRequest({ campaignRequest: request(over) }, 97, baseEnv);
  const bad = (over, label) => assert.throws(() => ok(over), (e) => e instanceof Gen8CreateError && e.httpStatus === 400 && e.code === "GEN8_CREATE_FIELD_INVALID", label);
  // at the limits
  ok({ name: "N".repeat(32), symbol: "S".repeat(10), logoURI: `https://a.b/${"x".repeat(500)}`, website: "w".repeat(512), xAccount: "x".repeat(512), extraLink: "e".repeat(512), description: "d".repeat(1000) });
  ok({ name: "\u{1F600}".repeat(8), symbol: "\u00e9".repeat(5) }); // 32 and 10 UTF-8 bytes
  ok({ description: "line one\nline two\r\n\tindented" });
  // over the limits (bytes, not characters)
  bad({ name: "N".repeat(33) }, "name 33 bytes");
  bad({ name: "\u{1F600}".repeat(8) + "a" }, "name 33 bytes of emoji");
  bad({ symbol: "S".repeat(11) }, "symbol 11 bytes");
  bad({ symbol: "\u00e9".repeat(6) }, "symbol 12 bytes in 6 characters");
  bad({ symbol: "X".repeat(65536) }, "64 KB symbol");
  bad({ logoURI: `https://a.b/${"x".repeat(501)}` }, "logoURI 513 bytes");
  for (const k of ["xAccount", "website", "extraLink"]) bad({ [k]: "u".repeat(513) }, `${k} 513 bytes`);
  bad({ description: "d".repeat(1001) }, "description 1001");
  // empty after trim
  bad({ name: "   " }, "blank name");
  bad({ symbol: "\t" }, "blank symbol");
  // control, zero-width, bidi, BOM
  const forbidden = ["\u0000", "\u0007", "\u001b", "\u007f", "\u0085", "\u009f", "\u200b", "\u200d", "\u200f", "\u202a", "\u202e", "\u2060", "\u2064", "\u2066", "\u2069", "\ufeff"];
  for (const ch of forbidden) {
    bad({ name: `a${ch}b` }, `name ${escape(ch)}`);
    bad({ symbol: `A${ch}` }, `symbol ${escape(ch)}`);
    bad({ logoURI: `https://a.b/${ch}` }, `logoURI ${escape(ch)}`);
    bad({ website: `https://a.b/${ch}` }, `website ${escape(ch)}`);
    bad({ description: `x${ch}y` }, `description ${escape(ch)}`);
  }
  bad({ name: "\u200b" }, "zero-width name");
  bad({ name: "a\nb" }, "newline in name");
  bad({ website: "https://a.b/\n" }, "newline in a link");
  // logo scheme: what the app uploads (https) or ipfs; never data:
  ok({ logoURI: "https://cdn.example/logo.png" });
  ok({ logoURI: "ipfs://bafy" });
  bad({ logoURI: "data:image/png;base64,AAAA" }, "data: logo");
  bad({ logoURI: "javascript:alert(1)" }, "javascript: logo");
  bad({ logoURI: "ftp://a.b/x" }, "ftp logo");
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
  const partial = await gen8CreateAuthorization(body, deps({ env: { EVM_GEN8_LAUNCHER_97: LAUNCHER } }));
  assert.equal(partial.body.code, "GEN8_NOT_CONFIGURED");
  assert.match(partial.body.error, /EVM_GEN8_HOOK_97/);
  assert.doesNotMatch(partial.body.error, /FACTORY_ADDRESS/);
  assert.equal((await gen8CreateAuthorization(body, deps({ signer: null }))).status, 503);
  const quote = await gen8CreateAuthorization({ ...body, stockToken: CREATOR }, deps());
  assert.deepEqual([quote.status, quote.body.code], [400, "GEN8_NATIVE_ONLY"]);
  const wrong = await gen8CreateAuthorization({ ...body, factoryAddress: CREATOR }, deps());
  assert.deepEqual([wrong.status, wrong.body.code], [400, "GEN8_LAUNCHER_MISMATCH"]);
  const blocked = await gen8CreateAuthorization(body, deps({ evaluateCreatePreflight: async () => ({ allowed: false, reasons: ["Wallet is restricted."] }) }));
  assert.deepEqual([blocked.status, blocked.body.code, blocked.body.error], [403, "CREATE_PREFLIGHT_BLOCKED", "Wallet is restricted."]);
});

test("B-02: strictEvmWallet takes only 0x + 40 hex (valid checksum), nothing ethers would also accept", () => {
  const w = ethers.Wallet.createRandom().address;
  assert.deepEqual(strictEvmWallet(w), { ok: true, address: w });
  assert.deepEqual(strictEvmWallet(w.toLowerCase()), { ok: true, address: w });
  for (const empty of [undefined, null, ""]) assert.deepEqual([strictEvmWallet(empty).ok, strictEvmWallet(empty).empty], [false, true]);
  const refused = [
    w.slice(2), w.slice(2).toLowerCase(), ethers.getIcapAddress(w), ` ${w}`, `${w} `, `${w}\n`, `\t${w}`,
    `0X${w.slice(2)}`, `${w}00`, w.slice(0, 41), [w], { toString: () => w }, 123,
  ];
  // mixed case with a broken checksum: flip the case of the first letter
  const i = w.slice(2).search(/[a-fA-F]/) + 2;
  if (i >= 2 && /[a-f]/.test(w.slice(2).toLowerCase())) {
    const flipped = w[i] === w[i].toUpperCase() ? w[i].toLowerCase() : w[i].toUpperCase();
    const broken = w.slice(0, i) + flipped + w.slice(i + 1);
    if (broken !== broken.toLowerCase() && broken.slice(2) !== broken.slice(2).toUpperCase()) refused.push(broken);
  }
  for (const raw of refused) {
    const r = strictEvmWallet(raw);
    assert.equal(r.ok, false, `refused: ${String(raw)}`);
    assert.equal(r.empty, false);
  }
});

test("B-02: gen8CreateAuthorization refuses loose wallet forms and runs the canary itself, before any signature", async () => {
  const outsider = ethers.Wallet.createRandom().address;
  const canary = "0x9999999999999999999999999999999999999999";
  const deps = (over = {}) => ({
    env: { ...baseEnv, CREATE_CANARY_WALLETS: canary },
    signer: ethers.Wallet.createRandom(),
    getProvider: async () => { throw new Error("must not read chain"); },
    evaluateCreatePreflight: async () => { throw new Error("must not run preflight"); },
    getRouteDecision: async () => { throw new Error("must not route"); },
    logRouteAuthorization: async () => { throw new Error("must not log"); },
    ...over,
  });
  const body = (walletAddress) => ({ chainId: 97, walletAddress, factoryAddress: LAUNCHER, campaignRequest: request() });
  for (const loose of [outsider.slice(2), outsider.slice(2).toLowerCase(), ethers.getIcapAddress(outsider), ` ${outsider} `, ""]) {
    const r = await gen8CreateAuthorization(body(loose), deps());
    assert.equal(r.status, 400, `400 for ${JSON.stringify(loose)}`);
    assert.equal(r.body.error, "Invalid or missing walletAddress");
  }
  // No canaryAllows injected: the env list (CREATE_CANARY_WALLETS) still refuses an outsider.
  const byEnv = await gen8CreateAuthorization(body(outsider), deps());
  assert.deepEqual([byEnv.status, byEnv.body.code], [403, "CREATE_CANARY_ONLY"]);
  // Injected check (route-auth.js wiring) is used when given.
  const seen = [];
  const injected = await gen8CreateAuthorization(body(outsider.toLowerCase()), deps({ env: baseEnv, canaryAllows: (w) => { seen.push(w); return false; } }));
  assert.deepEqual([injected.status, injected.body.code], [403, "CREATE_CANARY_ONLY"]);
  assert.deepEqual(seen, [outsider], "the canary sees the checksummed strict address");
  // The canary wallet itself passes the canary and reaches the preflight.
  const passes = await gen8CreateAuthorization(body(canary), deps({ evaluateCreatePreflight: async () => ({ allowed: false, reasons: ["stop here"] }) }));
  assert.deepEqual([passes.status, passes.body.code], [403, "CREATE_PREFLIGHT_BLOCKED"]);
});

const chainTests = gen8ArtifactsAvailable() ? test : test.skip;

chainTests("the API's create authorization is the one MwzV4Launcher verifies; launch, campaign state and refusals on a local chain", { timeout: 480_000 }, async (t) => {
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
  assert.equal(launchRequest.openAt, "0", "no openAt: trading opens at launch");
  assert.equal(Object.keys(launchRequest).at(-1), "openAt", "openAt is the request's last field");
  assert.equal(res.body.trading.openAt, 0);
  assert.equal(await local.launcher.hashRequest(launchRequest), gen8HashRequest(launchRequest), "hashRequest matches (openAt 0)");
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
      { getProvider: async () => provider, readState: async () => ({ supported: false, from: "gen5" }), gen8Config: () => cfg, db: null },
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
  // 6. B scheduled open: openAt is signed (hashRequest pinned against the launcher), a scheduled launch succeeds, no
  // swap before openAt (TradingNotOpen), the campaign state says when trading opens.
  // Raw RPC: ethers caches an identical getBlock("latest") for a moment, which would hide a time jump.
  const chainNow = async () => Number(BigInt((await provider.send("eth_getBlockByNumber", ["latest", false])).timestamp));
  // Time travel keeps the mock oracle fresh (GraduationOracle maxPriceAge 3600 s), as a live feed would be.
  const travel = async (seconds) => {
    await advanceTime(provider, seconds);
    await (await local.feed.set(600n * 10n ** 8n, await chainNow())).wait();
  };
  let t0 = await chainNow();
  const atChain = (over = {}) => deps({ now: () => t0 * 1000, ...over });
  const openAt = t0 + 3600;
  const sched = await gen8CreateAuthorization(body({ firstBuyValue: ethers.parseEther("0.002").toString(), openAt }), atChain());
  assert.equal(sched.status, 200, JSON.stringify(sched.body));
  assert.equal(sched.body.launchRequest.openAt, String(openAt), "openAt as a decimal string");
  assert.deepEqual(sched.body.trading, { openAt, scheduled: true, maxOpenDelaySeconds: GEN8_MAX_OPEN_DELAY_SECONDS });
  assert.equal(await local.launcher.hashRequest(sched.body.launchRequest), gen8HashRequest(sched.body.launchRequest), "hashRequest matches (future openAt)");
  assert.notEqual(gen8HashRequest({ ...sched.body.launchRequest, openAt: "0" }), gen8HashRequest(sched.body.launchRequest), "openAt is inside the signed hash");
  assert.equal(await local.launcher.authorizationDigest(creator.address, sched.body.launchRequest, sched.body.authorization.deadline), sched.body.authorization.digest);
  // The creator cannot move the open time: the same signature over another openAt is refused on chain.
  await assert.rejects(launcherAsCreator.launch({ ...sched.body.launchRequest, openAt: "0" }, { deadline: sched.body.authorization.deadline, signature: sched.body.authorization.signature }, { value: BigInt(sched.body.launchRequest.firstBuyValue) }));
  const rcSched = await (await launcherAsCreator.launch(sched.body.launchRequest, { deadline: sched.body.authorization.deadline, signature: sched.body.authorization.signature }, { value: BigInt(sched.body.launchRequest.firstBuyValue) })).wait();
  const lsched = rcSched.logs.map((l) => { try { return local.launcher.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Launched");
  assert.equal(Number(lsched.args.openAt), openAt, "Launched.openAt");
  assert.ok(lsched.args.firstBuyOut > 0n, "the creator first buy inside launch() runs before openAt");
  const schedToken = lsched.args.token;
  const schedKey = gen8PoolKey(schedToken, cfg.hook);
  const keyTuple = (k) => [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks];
  const early = await local.trader.connect(local.buyer).swap.staticCall(keyTuple(schedKey), true, -ethers.parseEther("0.001"), 0n, "0x", { value: ethers.parseEther("0.001") }).then(() => null, (e) => e);
  assert.ok(early, "a swap before openAt reverts");
  assert.equal(gen8RevertReason(early)?.name, "TradingNotOpen", `revert reason: ${early?.shortMessage || early?.message}`);
  await assert.rejects(directSwap(local, schedKey, local.buyer, { buy: true, amount: ethers.parseEther("0.001") }));
  const schedPool = await readGen8Pool({ provider, cfg, token: schedToken });
  assert.equal(schedPool.openAt, openAt, "hook pools().openAt");
  const sState = await readGen8CampaignState({ provider, cfg, token: schedToken, pool: schedPool });
  assert.deepEqual(
    [sState.openAt, sState.tradingOpen, sState.latched, sState.postPhase, sState.graduatedAt, sState.platformStatus, sState.reserveReleaseAt, sState.reserveReleasable],
    [openAt, false, false, false, null, "bonding", null, false],
  );
  assert.equal(sState.tradeFee.launchAt, openAt, "the launch fee decay runs from openAt");
  assert.equal(sState.tradeFee.antiSniperActive, false, "no decay window before trading opens");
  await travel(3600);
  await directSwap(local, schedKey, local.buyer, { buy: true, amount: ethers.parseEther("0.001") });
  const sOpen = await readGen8CampaignState({ provider, cfg, token: schedToken, pool: schedPool });
  assert.equal(sOpen.tradingOpen, true);
  assert.ok(sOpen.tradeFee.antiSniperActive, "the 60 s decay starts at openAt");

  // openAt bounds: past or 0 = open now (0 signed); beyond now + 30 days - TTL or not an integer = 400 before signing.
  t0 = await chainNow();
  const ttl = 600;
  const maxOpenAt = t0 + GEN8_MAX_OPEN_DELAY_SECONDS - ttl;
  const past = await gen8CreateAuthorization(body({ firstBuyValue: "0", openAt: t0 - 5 }), atChain());
  assert.equal(past.status, 200, JSON.stringify(past.body));
  assert.equal(past.body.launchRequest.openAt, "0");
  const asZero = await gen8CreateAuthorization(body({ firstBuyValue: "0", openAt: "0" }), atChain());
  assert.equal(asZero.body.launchRequest.openAt, "0");
  const signedBefore = logged.length;
  for (const bad of [maxOpenAt + 1, "1.5", 1.5, -1, "0x10", "soon", { at: 1 }]) {
    const r = await gen8CreateAuthorization(body({ firstBuyValue: "0", openAt: bad }), atChain());
    assert.deepEqual([r.status, r.body.code], [400, "GEN8_OPEN_AT_INVALID"], `openAt ${JSON.stringify(bad)}`);
  }
  assert.equal(logged.length, signedBefore, "no signature for a refused openAt");
  const atMax = await gen8CreateAuthorization(body({ firstBuyValue: "0", openAt: String(maxOpenAt) }), atChain());
  assert.equal(atMax.status, 200);
  assert.equal(atMax.body.launchRequest.openAt, String(maxOpenAt));
  // The furthest openAt the API signs launches even at the authorization's last second (no OpenAtTooFar).
  await travel(ttl - 20);
  await (await launcherAsCreator.launch(atMax.body.launchRequest, { deadline: atMax.body.authorization.deadline, signature: atMax.body.authorization.signature })).wait();

  // 7. F1 platform status and the reserve: graduate a coin, sell back into range A (latched, bonding), buy past the
  // graduation price again (graduated), and the reserve opens one hour after the latch, as MwzReserveLock decides.
  t0 = await chainNow();
  const g = await gen8CreateAuthorization(body({ firstBuyValue: "0" }), atChain());
  const rcG = await (await launcherAsCreator.launch(g.body.launchRequest, { deadline: g.body.authorization.deadline, signature: g.body.authorization.signature })).wait();
  const gToken = rcG.logs.map((l) => { try { return local.launcher.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Launched").args.token;
  const gKey = gen8PoolKey(gToken, cfg.hook);
  const gPool0 = await readGen8Pool({ provider, cfg, token: gToken });
  await travel(120); // past the 60 s launch fee window
  const lp0 = await local.lens.progress(gPool0.poolId);
  await directSwap(local, gKey, local.buyer, { buy: true, amount: (lp0.nativeTargetA * 110n) / 100n });
  const gPool = await readGen8Pool({ provider, cfg, token: gToken });
  assert.equal(gPool.graduated, true, "latched");
  assert.ok(gPool.graduatedAt > 0, "hook pools().graduatedAt");
  const grad = await readGen8CampaignState({ provider, cfg, token: gToken, pool: gPool });
  const lpGrad = await local.lens.progress(gPool.poolId);
  assert.deepEqual([grad.latched, grad.postPhase, grad.platformStatus, grad.graduatedAt], [true, true, "graduated", Number(lpGrad.graduatedAt)]);
  assert.equal(grad.postPhase, lpGrad.postPhase, "price phase == lens postPhase");
  assert.equal(grad.reserveReleaseAt, gPool.graduatedAt + 3600);
  assert.equal(grad.reserveReleasable, false, "inside the hour");
  assert.equal(grad.graduation.state, "graduated");
  const tooEarly = await local.reserveLock.release.staticCall(gPool.poolId).then(() => null, (e) => e);
  assert.equal(gen8RevertReason(tooEarly)?.name, "ReserveTooEarly");
  // Sell half of the buyer's coins: the price goes back inside range A.
  const gCoin = new ethers.Contract(gToken, local.tokenAbi, provider);
  await directSwap(local, gKey, local.buyer, { buy: false, amount: (await gCoin.balanceOf(local.buyer.address)) / 2n });
  const back = await readGen8CampaignState({ provider, cfg, token: gToken, pool: gPool });
  assert.ok(BigInt(back.market.sqrtPriceX96) > sqrtAtTick(gPool.tickGrad), "price back inside A");
  assert.deepEqual([back.latched, back.postPhase, back.platformStatus, back.graduation.state, back.gen8.phase], [true, false, "bonding", "trading", "bonding"]);
  assert.equal(back.postPhase, (await local.lens.progress(gPool.poolId)).postPhase, "== lens postPhase");
  assert.equal(back.tradeFee.currentBps, Number(await local.lens.currentFeeBps(gPool.poolId, local.addresses.poolManager, { blockTag: back.blockNumber })), "bonding rate again, as the lens");
  assert.equal(back.tradeFee.currentBps, 200);
  assert.ok(back.graduation.progressPct < 100, "progress from the price, not 100 because of the latch");
  await travel(3600);
  const backLater = await readGen8CampaignState({ provider, cfg, token: gToken, pool: gPool });
  assert.equal(backLater.reserveReleasable, false, "an hour later but back in A: not releasable");
  const below = await local.reserveLock.release.staticCall(gPool.poolId).then(() => null, (e) => e);
  assert.equal(gen8RevertReason(below)?.name, "PriceBelowGraduation");
  await directSwap(local, gKey, local.other, { buy: true, amount: (lp0.nativeTargetA * 110n) / 100n });
  const again = await readGen8CampaignState({ provider, cfg, token: gToken, pool: gPool });
  assert.deepEqual([again.postPhase, again.platformStatus, again.reserveReleasable, again.creatorClaims.reserve.releasable], [true, "graduated", true, true]);
  assert.equal(again.tradeFee.currentBps, 100);
  await (await local.reserveLock.release(gPool.poolId)).wait();

  // RPC down: the handler answers from the indexer's open_at / last_phase.
  clearEvmCampaignStateCache();
  const out = { headers: {} };
  const resX = { statusCode: 0, setHeader: (k, v) => { out.headers[k] = v; }, end: (text) => { out.code = resX.statusCode; out.body = JSON.parse(text); } };
  const gradAtSec = gPool.graduatedAt;
  await evmCampaignStateHandler(
    { method: "GET", url: `/api/evm/campaign-state?chainId=97&campaign=${gToken}`, headers: {} },
    resX,
    {
      getProvider: async () => provider, readState: async () => { throw new Error("gen5 reader must not run"); }, gen8Config: () => cfg,
      readGen8Pool: async () => { throw new Error("rpc down"); },
      loadGen8Indexed: async () => ({ poolId: gPool.poolId, token: gToken, creator: creator.address, openAt: 1000, lastPhase: "bonding", graduatedBlock: 5, graduatedAt: gradAtSec, tickStart: gPool.tickStart, tickGrad: gPool.tickGrad, liqA: null, sqrtPriceX96: null }),
    },
  );
  assert.equal(out.code, 200);
  assert.deepEqual([out.body.source, out.body.latched, out.body.postPhase, out.body.platformStatus, out.body.openAt, out.body.tradingOpen, out.body.reserveReleaseAt, out.body.reserveReleasable], ["indexer", true, false, "bonding", 1000, true, gradAtSec + 3600, false]);
});
