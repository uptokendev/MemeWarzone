import assert from "node:assert/strict";
import test from "node:test";
import {
  GEN8_FDV_WHOLE,
  gen8HolderExcludeList,
  gen8LaunchPriceNative,
  gen8LensNative,
  gen8MarketCapNative,
  gen8PlatformGraduated,
  gen8SpotNative,
  gen8SpotWindowChanges,
  gen8VenueHolderAddresses,
  isGen8DexSource,
  weiStringToNumber,
} from "./gen8TokenPage.ts";

const G8DIR_NOW = Math.floor(Date.parse("2026-10-12T18:19:22Z") / 1000);
const G8DIR_CANDLES = [
  { bucket_start: "2026-10-12T14:28:37.000Z", price_c: "0.000000000008225593", c: "0.000000000008225593" },
  { bucket_start: "2026-10-12T14:29:56.000Z", price_c: "0.000000000160168193", c: "0.000000000160168193" },
  { bucket_start: "2026-10-12T14:30:05.000Z", price_c: "0.000000000160163783", c: "0.000000000160163783" },
];

test("YCC launch price is the spot at tickStart 260100", () => {
  const price = gen8LaunchPriceNative(260100);
  assert.ok(price != null && price > 0);
  assert.ok(Math.abs(price - 5.064834e-12) / 5.064834e-12 < 1e-6);
  assert.equal(gen8LaunchPriceNative(null), null);
  assert.equal(gen8LaunchPriceNative(887273), null);
});

test("G8DIR window change is spot to spot, not the fill-to-fill 977%", () => {
  const changes = gen8SpotWindowChanges({
    candles: G8DIR_CANDLES,
    spotNow: 1.60163783e-10,
    nowSec: G8DIR_NOW,
    windows: { "5m": 300, "1h": 3600, "4h": 14400, "24h": 86400 },
  });
  assert.equal(changes["24h"], 1847.14);
  assert.equal(changes["4h"], 1847.14);
  assert.equal(changes["1h"], 0);
  assert.equal(changes["5m"], 0);
  assert.notEqual(changes["24h"], 977.27);
  assert.notEqual(changes["24h"], 977.29);
});

test("a 5m bucket uses its open when the launch and the graduation share that bucket", () => {
  const changes = gen8SpotWindowChanges({
    candles: [
      {
        bucket_start: "2026-10-12T14:25:00.000Z",
        price_o: "0.000000000008225593",
        price_c: "0.000000000160168193",
      },
      {
        bucket_start: "2026-10-12T14:30:00.000Z",
        price_o: "0.000000000160168193",
        price_c: "0.000000000160163783",
      },
    ],
    spotNow: 1.60163783e-10,
    nowSec: G8DIR_NOW,
    windows: { "5m": 300, "1h": 3600, "24h": 86400 },
  });
  assert.equal(changes["24h"], 1847.14);
  assert.equal(changes["1h"], 0);
  assert.equal(changes["5m"], 0);
});

test("a quiet window uses the last close before it, so change is zero", () => {
  const changes = gen8SpotWindowChanges({
    candles: G8DIR_CANDLES,
    spotNow: Number("0.000000000160163783"),
    nowSec: G8DIR_NOW,
    windows: { "5m": 300 },
  });
  assert.equal(changes["5m"], 0);
});

test("lens FDV and spot come from wei strings without dropping zeros", () => {
  const state = {
    market: {
      priceNative: null,
      priceNativeWeiPerCoin: "160163783",
      marketCapNativeWei: "160163783000000000",
    },
  };
  assert.equal(weiStringToNumber("160163783"), 1.60163783e-10);
  assert.equal(gen8SpotNative(state), 1.60163783e-10);
  assert.equal(gen8MarketCapNative(state), 0.160163783);
  assert.equal(GEN8_FDV_WHOLE, 1_000_000_000);
  const product = (gen8SpotNative({ market: { priceNative: 1.60163783e-10 } }) || 0) * GEN8_FDV_WHOLE;
  assert.ok(Math.abs(product - 0.160163783) < 1e-9);
});

test("platform graduated ignores a latched coin that traded back into bonding", () => {
  assert.equal(gen8PlatformGraduated({ platformStatus: "graduated", postPhase: true, graduation: { phase: "graduated" } }), true);
  assert.equal(gen8PlatformGraduated({ platformStatus: "bonding", postPhase: true, graduation: { phase: "bonding" } }), true);
  assert.equal(gen8PlatformGraduated({ platformStatus: "bonding", postPhase: false, graduation: { phase: "graduated" } }), true);
  assert.equal(gen8PlatformGraduated({ platformStatus: "bonding", postPhase: false, graduation: { phase: "bonding" } }), false);
  assert.equal(gen8PlatformGraduated(null), false);
});

test("lens native is the bonding reserve, and remaining is target minus that", () => {
  const lens = gen8LensNative({
    graduation: { lensNativeInAWei: "6498544923116963", lensNativeTargetAWei: "6631168288894861" },
  });
  assert.equal(lens.inCurveWei, 6498544923116963n);
  assert.equal(lens.targetWei, 6631168288894861n);
  assert.equal(lens.remainingWei, 6631168288894861n - 6498544923116963n);
  assert.equal(gen8LensNative({ graduation: {} }).remainingWei, null);
});

test("gen8_v4 is a pool swap and holder excludes cover protocol wallets", () => {
  assert.equal(isGen8DexSource("gen8_v4"), true);
  assert.equal(isGen8DexSource("GEN8_V4"), true);
  assert.equal(isGen8DexSource("curve"), false);
  const excluded = gen8HolderExcludeList({
    chainId: 46630,
    addresses: [
      "0x68C681F488Bae70DEEa2f1D375037958a0f80073",
      "0xb18105cb239885aad85Fbf9e62cEe56b6415A8eC",
      "0x8366a39cc670b4001a1121b8f6a443a643e40951",
      "not-an-address",
      null,
    ],
  });
  assert.deepEqual(
    excluded.map((value) => value.toLowerCase()),
    [
      "0x68c681f488bae70deea2f1d375037958a0f80073",
      "0xb18105cb239885aad85fbf9e62cee56b6415a8ec",
      "0x8366a39cc670b4001a1121b8f6a443a643e40951",
      "0x000000000000000000000000000000000000dead",
    ],
  );
  const bnb = gen8HolderExcludeList({ chainId: 56, addresses: [] });
  assert.ok(bnb.some((value) => value.toLowerCase() === "0x238a358808379702088667322f80ac48bad5e6c4"));
});

// DogeOS (Barkswap venue, barkswap plan t22): the coin's Algebra pool holds A + B, so a Transfer census ranks it first
// unless it is excluded. The indexer excludes pool, launcher, plugin, reserve lock, escrow and choice vault
// (realtime-indexer evmGen8Holders.ts for 6281971); the page excludes the same from the API's Bark state.
const BARK_STATE = {
  gen8: {
    venue: "barkswap",
    pool: "0xB9a2852ed4DCFFD2beF97A09a77Ea23A1ADd5196",
    plugin: "0x1613beB3B2C4f22Ee086B2b38C1476A3cE7f78E8",
    launcher: "0xf5059a5D33d5853360D16C683c16e67980206f36",
    hook: null,
    poolManager: null,
    displayPair: null,
  },
  creatorClaims: {
    vault: { address: "0x9E545E3C0baAB3E08CdfD552C960A1050f373042" },
    reserve: { address: "0x84eA74d481Ee0A5332c457a4d796187F6Ba67fEB" },
    escrow: { address: "0xa82fF9aFd8f496c3d6ac40E2a0F282E47488CFc9" },
  },
};

test("a Barkswap coin's holder census excludes its pool, plugin and the Bark periphery", () => {
  const extra = gen8VenueHolderAddresses(BARK_STATE);
  const excluded = gen8HolderExcludeList({ chainId: 6281971, addresses: ["0x66C585D8e24F880E0E8a20C728424160F7559B3f", ...extra] }).map((a) => a.toLowerCase());
  for (const address of [
    BARK_STATE.gen8.pool,
    BARK_STATE.gen8.plugin,
    // Barkswap's community vault (every pool's, docs/dogeos/barkswap-facts.md): it receives the community fee in coins
    "0xA305F8BDf7EaA3233b3918A39d1e0867c6116c83",
    BARK_STATE.gen8.launcher,
    BARK_STATE.creatorClaims.vault.address,
    BARK_STATE.creatorClaims.reserve.address,
    BARK_STATE.creatorClaims.escrow.address,
  ]) {
    assert.ok(excluded.includes(address.toLowerCase()), address);
  }
});

test("a V4 coin's holder census is unchanged: the venue helper adds nothing", () => {
  const v4 = { gen8: { venue: undefined, pool: "0xB9a2852ed4DCFFD2beF97A09a77Ea23A1ADd5196", plugin: "0x1613beB3B2C4f22Ee086B2b38C1476A3cE7f78E8", hook: "0x68C681F488Bae70DEEa2f1D375037958a0f80073" } };
  assert.deepEqual(gen8VenueHolderAddresses(v4), []);
  assert.deepEqual(gen8VenueHolderAddresses({ gen8: { ...v4.gen8, venue: "v4" } }), []);
  assert.deepEqual(gen8VenueHolderAddresses(null), []);
});
