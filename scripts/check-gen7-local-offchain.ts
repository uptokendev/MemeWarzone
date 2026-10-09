/**
 * Step 3 end-to-end (docs/evm-launch/EVM_GEN7_V2_PLAN.md): the API, indexer and shared app maths, run against
 * the gen-7 contracts on the LOCAL hardhat node (chain 31337 only; refuses anything else).
 *
 *   npx hardhat node                                                     # terminal 1
 *   npx hardhat run scripts/local-gen7-stack.ts --network localhost      # terminal 2
 *   realtime-indexer/node_modules/.bin/tsx scripts/check-gen7-local-offchain.ts
 *
 * Flow: the API prices and validates a 70% first buy (readGen6FactoryCreateContext + prepareGen6CreateOptions,
 * gen-7 branch), the API signer authorises the create, the creator creates with exactly the API's max cost
 * (the factory refunds the rest), the API's campaign-state, the indexer's curve reader and fee annotation are
 * compared with the chain at each step, then the public buys the rest of the curve, the coin enters Pending
 * in that buy, graduates through the mock adapter, and campaign-state reports it.
 * Signs only with hardhat's public test accounts on the local node.
 */
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import {
  readGen6FactoryCreateContext,
  prepareGen6CreateOptions,
} from "../frontend/api/lib/evmLaunchGen6.js";
import {
  signCreateAuthorization,
  signTradeAuthorization,
  hashCampaignRequest,
  isSupportedGenerationPair,
} from "../frontend/api/dev-fix/routeAuthorizationSigner.js";
import { readGen5CampaignState } from "../frontend/api/lib/evmGen5CampaignState.js";
import * as shared from "../frontend/shared/evmGen7Curve.mjs";
import { readBnbCurveParams, bnbCurveStateFor, BNB_CURVE_PARAM_FRAGMENTS, bigintRatio } from "../realtime-indexer/src/bnbCurvePricing.js";
import { gen5TradeFeeBps } from "../realtime-indexer/src/evm/evmGen5Trade.js";
import { isLikelyDue } from "../realtime-indexer/src/evm/evmGraduationKeeper.js";

const ROOT = path.join(__dirname, "..");
const rec = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "localhost", "gen7.json"), "utf8"));
const art = (name: string) => JSON.parse(fs.readFileSync(path.join(ROOT, "artifacts", "contracts", "gen7", `${name}.sol`, `${name}.json`), "utf8")).abi;
const E = (v: string | number) => ethers.parseEther(String(v));

let checks = 0;
function eq(label: string, got: unknown, want: unknown) {
  checks += 1;
  if (String(got) !== String(want)) throw new Error(`${label}: got ${String(got)}, want ${String(want)}`);
  console.log(`  ok  ${label}: ${String(got)}`);
}
function ok(label: string, cond: boolean, detail = "") {
  checks += 1;
  if (!cond) throw new Error(`${label} failed ${detail}`);
  console.log(`  ok  ${label}${detail ? ` (${detail})` : ""}`);
}

async function main() {
  const provider = new ethers.JsonRpcProvider(rec.rpc, undefined, { staticNetwork: true, cacheTimeout: -1 });
  const chainId = Number((await provider.getNetwork()).chainId);
  if (chainId !== 31337) throw new Error(`local node only, got chain ${chainId}`);
  const authority = await provider.getSigner(rec.routeAuthority);
  const creator = await provider.getSigner(rec.creator);
  const alice = await provider.getSigner(rec.traders[0]);
  const factory = new ethers.Contract(rec.factory, art("LaunchFactoryGen7"), provider);
  // The node stamps the next block with max(latest + 1, wall clock + any evm_increaseTime offset).
  const nextTime = async () => Math.max(Number((await provider.getBlock("latest"))!.timestamp), Math.floor(Date.now() / 1000)) + 120;
  const mine = async (seconds: number) => {
    await provider.send("evm_increaseTime", [seconds]);
    await provider.send("evm_mine", []);
  };

  console.log("1. generation pair and API create context");
  const [fg, cg] = [Number(await factory.FACTORY_GENERATION()), Number(await factory.CAMPAIGN_GENERATION())];
  ok("API accepts the factory's pair on 31337", isSupportedGenerationPair(chainId, fg, cg), `${fg}/${cg}`);
  ok("shared module sees a gen-7 pair", shared.isEvmGen7Pair(fg, cg));
  const target = E(50_000);
  const ctx: any = await readGen6FactoryCreateContext({ provider, factoryAddress: rec.factory, graduationTarget: target, factoryGeneration: fg });
  eq("context generation", ctx.factoryGeneration, 7);

  console.log("2. API prices a 70% first buy (draft arm path, auto max cost)");
  const seventy = (ctx.totalSupply * 7000n) / 10000n;
  const readContext = async ({ graduationTarget }: any) =>
    readGen6FactoryCreateContext({ provider, factoryAddress: rec.factory, graduationTarget, factoryGeneration: fg });
  const prepared: any = await prepareGen6CreateOptions({ source: { feeChoice: "keep", firstBuyTokens: seventy.toString() }, graduationTarget: target, readContext, autoMaxCost: true });
  eq("API first-buy tokens", prepared.firstBuy.tokens, seventy);
  const mc = BigInt(await (new ethers.Contract(rec.oracle, ["function nativeTargetForUsd(uint256) view returns (uint256)"], provider)).nativeTargetForUsd(target));
  const curve = shared.curveForMarketCap(mc, ctx.totalSupply);
  const q = shared.quoteGen7FirstBuy({ tokens: seventy, ...curve, protocolFeeBps: ctx.protocolFeeBps });
  eq("API quoted cost = shared quote", prepared.firstBuy.quotedCost, q.total);
  const raise = shared.graduationRaise(curve.virtualNative, curve.virtualToken, (ctx.totalSupply * 8500n) / 10000n);
  ok("70% first buy costs ~42.1% of the raise", Math.abs(Number((q.costNoFee * 100000n) / raise) / 1000 - 42.14) < 0.05, `${Number((q.costNoFee * 100000n) / raise) / 1000}%`);
  let tooBig: any = null;
  try {
    await prepareGen6CreateOptions({ source: { feeChoice: "keep", firstBuyTokens: (seventy + 1n).toString() }, graduationTarget: target, readContext, autoMaxCost: true });
  } catch (e) {
    tooBig = e;
  }
  eq("API refuses 70% + 1 wei", tooBig?.code, "GEN6_FIRST_BUY_TOO_LARGE");

  console.log("3. API signs, creator creates with the API's max cost");
  const request = {
    name: "E2E Gen7", symbol: "E2E7", logoURI: "ipfs://e2e", xAccount: "", website: "", extraLink: "",
    graduationTarget: target,
    firstBuyTokens: BigInt(prepared.requestFields.firstBuyTokens),
    firstBuyMaxCost: BigInt(prepared.requestFields.firstBuyMaxCost),
    feeChoice: prepared.requestFields.feeChoice,
    feeCreatorPct: prepared.requestFields.feeCreatorPct,
  };
  const deadline = (await nextTime()) + 600;
  const signature = await signCreateAuthorization({
    signer: authority, chainId, factoryAddress: rec.factory, creator: rec.creator, request, factoryGeneration: fg,
    tradeRouteProfileId: 1, finalizeRouteProfileId: 1, deadline,
  });
  const before = await provider.getBalance(rec.creator);
  const tx = await (factory.connect(creator) as any).createCampaignAuthorized(request, { tradeRouteProfile: 1, finalizeRouteProfile: 1, deadline, signature }, { value: request.firstBuyMaxCost });
  const receipt = await tx.wait();
  const gas = receipt.gasUsed * receipt.gasPrice;
  eq("creator paid exactly the quote (slack refunded)", before - (await provider.getBalance(rec.creator)) - gas, q.total);
  ok("request hash layout is gen-6's", hashCampaignRequest(request, { factoryGeneration: fg }).length === 66);
  const info = await factory.getCampaign((await factory.campaignsCount()) - 1n);
  const campaign = new ethers.Contract(info.campaign, art("LaunchCampaignGen7"), provider);
  eq("sold after first buy", await campaign.sold(), seventy);
  eq("chain virtualNative = shared", await campaign.virtualNative(), curve.virtualNative);

  console.log("4. API campaign-state and indexer reader on the fresh coin (launch window)");
  let st: any = await readGen5CampaignState({ provider, campaignAddress: info.campaign });
  eq("supported", st.supported, true);
  eq("economics.generationKind", st.economics.generationKind, "gen7");
  eq("economics.graduationCreatorBps", st.economics.graduationCreatorBps, 0);
  eq("tradeFee.antiSniperStartBps", st.tradeFee.antiSniperStartBps, 9000);
  eq("curve.kind", st.curve.kind, "cp");
  eq("curve.virtualToken", st.curve.virtualToken, curve.virtualToken);
  eq("graduation.nativeTargetWei = raise", st.graduation.nativeTargetWei, raise);
  eq("graduation.targetUsdWad (market cap)", st.graduation.targetUsdWad, target);
  const launchAt = BigInt(st.tradeFee.launchAt);
  const t0 = BigInt((await provider.getBlock("latest"))!.timestamp);
  eq("indexer launch fee = chain fee now", gen5TradeFeeBps(BigInt(st.tradeFee.baseBps), launchAt, t0, 9000n), await campaign.currentTradeFeeBps());
  const reader = new ethers.Contract(info.campaign, BNB_CURVE_PARAM_FRAGMENTS as any, provider) as any;
  const params = await readBnbCurveParams(reader);
  eq("indexer reads cp params", params.kind, "cp");
  const spot = bnbCurveStateFor(params, seventy);
  eq("indexer spot = chain currentPrice", spot.spotNative, bigintRatio(BigInt(await campaign.currentPrice()), 10n ** 18n));

  console.log("5. public buys the rest of the curve after the window; the buy that sells out enters Pending");
  await mine(120);
  const curveSupply = BigInt(await campaign.curveSupply());
  const rest = curveSupply - BigInt(await campaign.sold());
  const cost = BigInt(await campaign.quoteBuyExactTokens(rest));
  ok("keeper filter says not due before sell-out", !isLikelyDue({ soldRaw: seventy, netRaisedWei: raise, curveSupply, nativeTarget: raise, slackBps: 200, soldOutOnly: true }));
  const tdl = (await nextTime()) + 600;
  const tsig = await signTradeAuthorization({ signer: authority, chainId, campaignAddress: info.campaign, actor: rec.traders[0], routeProfileId: 1, action: 0, amount: rest, limit: cost, deadline: tdl });
  await (await (campaign.connect(alice) as any).buyExactTokensAuthorized(rest, cost, 1, tdl, tsig, { value: cost })).wait();
  st = await readGen5CampaignState({ provider, campaignAddress: info.campaign });
  eq("graduation.state", st.graduation.state, "pending");
  eq("graduation.pendingTrigger", st.graduation.pendingTrigger, "sold_out");
  eq("netRaised = raise at sell-out", st.graduation.netRaisedWei, raise);
  ok("keeper filter says due at sell-out", isLikelyDue({ soldRaw: curveSupply, netRaisedWei: raise, curveSupply, nativeTarget: raise, slackBps: 200, soldOutOnly: true }));
  const endMc = shared.gen7MarketCapNative({ virtualNative: curve.virtualNative, virtualToken: curve.virtualToken, sold: curveSupply, totalSupply: ctx.totalSupply });
  ok("sold-out market cap = $50K target (within 0.02%)", Math.abs(Number((endMc * 1_000_000n) / mc) / 1e4 - 100) < 0.02, `${Number((endMc * 1_000_000n) / mc) / 1e4}%`);
  eq("campaign-state graduation market cap", st.curve.graduationMarketCapNativeWei, endMc);

  console.log("6. graduation through the mock adapter");
  const routerBefore = await provider.getBalance(rec.feeRouter);
  await (await (campaign.connect(alice) as any).graduate()).wait();
  st = await readGen5CampaignState({ provider, campaignAddress: info.campaign });
  eq("graduation.state", st.graduation.state, "graduated");
  eq("2% of the raise to the fee router", (await provider.getBalance(rec.feeRouter)) - routerBefore, (raise * 200n) / 10000n);
  eq("creator graduation payout", await campaign.pendingCreatorGraduation(), 0);

  console.log(`\nall ${checks} checks passed on local chain ${chainId}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
