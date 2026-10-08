import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";

import {
  ANTI_SNIPER_START_BPS,
  GEN5_CAMPAIGN_ABI,
  GEN6_ECONOMICS,
  GEN7_ANTI_SNIPER_START_BPS,
  GEN7_ECONOMICS,
  antiSniperFeeBpsAt,
  decodeCampaignRevert,
  readGen5CampaignState,
} from "./evmGen5CampaignState.js";
import { curveForMarketCap, gen7MarketCapNative, graduationRaise } from "../../shared/evmGen7Curve.mjs";

const WAD = 10n ** 18n;
const SUPPLY = 1_000_000_000n * WAD;
const CAMPAIGN = "0x00000000000000000000000000000000000000c1";
const FACTORY = "0x00000000000000000000000000000000000000f1";
const CREATOR = "0x00000000000000000000000000000000000000a1";
const TOKEN = "0x00000000000000000000000000000000000000b1";
const ZERO = ethers.ZeroAddress;

test("anti-sniper fee: gen-7 starts at 9000 and falls to the base in 60 s; the gen-6 default is unchanged", () => {
  assert.equal(GEN7_ANTI_SNIPER_START_BPS, 9000);
  const launchAt = 1_000;
  const g7 = (s) => antiSniperFeeBpsAt({ launchAt, protocolFeeBps: 200, now: launchAt + s, startBps: GEN7_ANTI_SNIPER_START_BPS });
  assert.equal(g7(0), 9000);
  assert.equal(g7(1), 200 + Math.floor((8800 * 59) / 60));
  assert.equal(g7(30), 4600);
  assert.equal(g7(60), 200);
  const g6 = (s) => antiSniperFeeBpsAt({ launchAt, protocolFeeBps: 200, now: launchAt + s });
  assert.equal(g6(0), ANTI_SNIPER_START_BPS);
  assert.equal(g6(1), 4920);
});

test("gen-7 init errors decode by name", () => {
  const iface = new ethers.Interface(["error VirtualNativeZero()", "error VirtualTokenTooSmall()"]);
  assert.equal(decodeCampaignRevert({ data: iface.encodeErrorResult("VirtualNativeZero", []) }), "VirtualNativeZero");
  assert.equal(decodeCampaignRevert({ data: iface.encodeErrorResult("VirtualTokenTooSmall", []) }), "VirtualTokenTooSmall");
});

const EXTRA_CAMPAIGN_ABI = [
  "function basePrice() view returns (uint256)",
  "function priceSlope() view returns (uint256)",
  "function virtualNative() view returns (uint256)",
  "function virtualToken() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function currentPrice() view returns (uint256)",
];
const FACTORY_ABI = [
  "function FACTORY_GENERATION() view returns (uint32)",
  "function CAMPAIGN_GENERATION() view returns (uint32)",
  "function campaignFeeChoice(address) view returns (address vault, uint8 choice, uint8 creatorPct)",
];

/** eth_call answered from handlers per address; a handler that is missing reverts with no data. */
function fakeProvider(contracts, { timestamp = 2_000_000, number = 123 } = {}) {
  const table = Object.fromEntries(Object.entries(contracts).map(([a, c]) => [a.toLowerCase(), { iface: new ethers.Interface(c.abi), handlers: c.handlers }]));
  return {
    async getBlock() {
      return { timestamp, number };
    },
    async call(tx) {
      const target = table[String(tx.to).toLowerCase()];
      const parsed = target.iface.parseTransaction({ data: tx.data });
      const handler = target.handlers[parsed.name];
      if (!handler) throw Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION", data: "0x" });
      const value = handler(...parsed.args);
      if (value instanceof Error) throw value;
      return target.iface.encodeFunctionResult(parsed.name, Array.isArray(value) ? value : [value]);
    },
  };
}

const notDue = Object.assign(new Error("reverted"), {
  code: "CALL_EXCEPTION",
  data: new ethers.Interface(["error GraduationNotDue()"]).encodeErrorResult("GraduationNotDue", []),
});

function campaignHandlers({ sold, curveSupply, nativeTarget, extra }) {
  return {
    factory: () => FACTORY,
    creator: () => CREATOR,
    token: () => TOKEN,
    launchAt: () => 1_000_000n,
    protocolFeeBps: () => 200n,
    currentTradeFeeBps: () => 200n,
    creatorEscrowTotal: () => 0n,
    creatorEscrowClaimed: () => 0n,
    creatorEscrowVested: () => 0n,
    launched: () => false,
    graduationPending: () => false,
    pendingSince: () => 0n,
    pendingTrigger: () => 0n,
    graduationQuoteToken: () => ZERO,
    nativeFallback: () => false,
    paused: () => false,
    graduationPaused: () => false,
    pendingCreatorGraduation: () => 0n,
    pendingCreatorQuote: () => 0n,
    pendingProtocolGraduationFee: () => 0n,
    creatorGraduationBeneficiary: () => ZERO,
    repairMemeSold: () => 0n,
    sold: () => sold,
    curveSupply: () => curveSupply,
    netRaisedWei: () => 0n,
    graduationTarget: () => 50_000n * WAD,
    graduationNativeTarget: () => nativeTarget,
    finalizedAt: () => 0n,
    graduate: () => notDue,
    ...extra,
  };
}

function chain({ factoryGeneration, campaignGeneration, campaign }) {
  return fakeProvider({
    [CAMPAIGN]: { abi: [...GEN5_CAMPAIGN_ABI, ...EXTRA_CAMPAIGN_ABI], handlers: campaign },
    [FACTORY]: {
      abi: FACTORY_ABI,
      handlers: {
        FACTORY_GENERATION: () => BigInt(factoryGeneration),
        CAMPAIGN_GENERATION: () => BigInt(campaignGeneration),
        campaignFeeChoice: () => [ZERO, 0n, 0n],
      },
    },
  });
}

test("campaign-state: a gen-7 campaign is supported, with its CP curve, market caps and gen-7 economics", async () => {
  const mc = 80n * WAD;
  const { virtualNative, virtualToken } = curveForMarketCap(mc, SUPPLY, 8500n, 1300n);
  const curveSupply = (SUPPLY * 8500n) / 10_000n;
  const sold = 123_456_789n * WAD;
  const raise = graduationRaise(virtualNative, virtualToken, curveSupply);
  const provider = chain({
    factoryGeneration: 7,
    campaignGeneration: 6,
    campaign: campaignHandlers({
      sold,
      curveSupply,
      nativeTarget: raise,
      extra: { virtualNative: () => virtualNative, virtualToken: () => virtualToken, totalSupply: () => SUPPLY },
    }),
  });
  const state = await readGen5CampaignState({ provider, campaignAddress: CAMPAIGN });
  assert.equal(state.supported, true);
  assert.deepEqual(state.generation, { factoryAddress: ethers.getAddress(FACTORY), factoryGeneration: 7, campaignGeneration: 6 });
  assert.equal(state.tradeFee.antiSniperStartBps, 9000);
  assert.deepEqual(state.curve, {
    kind: "cp",
    virtualNative: virtualNative.toString(),
    virtualToken: virtualToken.toString(),
    totalSupply: SUPPLY.toString(),
    curveSupply: curveSupply.toString(),
    marketCapNativeWei: gen7MarketCapNative({ virtualNative, virtualToken, sold, totalSupply: SUPPLY }).toString(),
    graduationMarketCapNativeWei: gen7MarketCapNative({ virtualNative, virtualToken, sold: curveSupply, totalSupply: SUPPLY }).toString(),
  });
  // the sold-out market cap is the target the factory sized the curve for (within rounding of the 0.01% pool margin)
  const atGrad = BigInt(state.curve.graduationMarketCapNativeWei);
  assert.ok(atGrad <= mc && atGrad * 10_000n >= mc * 9_998n, `${atGrad} vs ${mc}`);
  assert.deepEqual(state.economics, { ...GEN7_ECONOMICS, generationKind: "gen7" });
  assert.equal(state.economics.graduationCreatorBps, 0);
  assert.equal(state.economics.graduationProtocolBps, 200);
  assert.equal(state.economics.firstBuyMaxSupplyBps, 7000);
  assert.equal(state.economics.firstBuyMaxTargetBps, null);
  assert.equal(state.economics.graduationTargetKind, "market_cap_usd");
  assert.equal(state.graduation.nativeTargetWei, raise.toString());
  assert.equal(state.graduation.targetUsdWad, (50_000n * WAD).toString());
  assert.deepEqual(state.graduation.graduate, { callable: false, repairNeeded: false, reason: "GraduationNotDue" });
});

test("campaign-state: a gen-6 campaign keeps every field it had; curve is linear and economics are gen-6's", async () => {
  const provider = chain({
    factoryGeneration: 6,
    campaignGeneration: 5,
    campaign: campaignHandlers({
      sold: 10n * WAD,
      curveSupply: (SUPPLY * 7000n) / 10_000n,
      nativeTarget: 40n * WAD,
      extra: { basePrice: () => 1_000_000_000n, priceSlope: () => 1_000n },
    }),
  });
  const state = await readGen5CampaignState({ provider, campaignAddress: CAMPAIGN });
  assert.equal(state.supported, true);
  assert.equal(state.tradeFee.antiSniperStartBps, 5000);
  assert.deepEqual(state.curve, { kind: "linear", basePrice: "1000000000", priceSlope: "1000" });
  assert.deepEqual(state.economics, { ...GEN6_ECONOMICS, generationKind: "gen6" });
  assert.equal(state.economics.graduationCreatorBps, 1980);
  assert.deepEqual(Object.keys(state), [
    "campaignAddress", "supported", "generation", "blockNumber", "blockTimestamp", "creator", "token", "tradeFee", "quotes",
    "curve", "economics", "creatorEscrow", "graduation", "creatorClaims", "viewer",
  ]);
  assert.deepEqual(Object.keys(state.graduation), [
    "state", "pendingSince", "pendingTrigger", "finalizedAt", "sold", "curveSupply", "netRaisedWei", "targetUsdWad", "nativeTargetWei",
    "quoteToken", "nativeFallback", "nativeFallbackAvailableAt", "nativeFallbackAvailable", "pauseHonouredUntil", "graduate",
    "repairMemeSold", "pendingProtocolGraduationFeeWei",
  ]);

  // a gen-6 campaign without the curve views still answers (curve values null), nothing else depends on them
  const bare = chain({
    factoryGeneration: 6,
    campaignGeneration: 5,
    campaign: campaignHandlers({ sold: 0n, curveSupply: 1n, nativeTarget: 1n, extra: {} }),
  });
  const s2 = await readGen5CampaignState({ provider: bare, campaignAddress: CAMPAIGN });
  assert.deepEqual(s2.curve, { kind: "linear", basePrice: null, priceSlope: null });
});

test("campaign-state: older factories stay unsupported", async () => {
  const provider = chain({ factoryGeneration: 4, campaignGeneration: 3, campaign: { factory: () => FACTORY } });
  const state = await readGen5CampaignState({ provider, campaignAddress: CAMPAIGN });
  assert.equal(state.supported, false);
  assert.equal(state.curve, undefined);
});
