// DogeOS live DOGE gas reserve (barkswap plan t34, founder decision A 2026-10-17; measured in the t27 rehearsal,
// reports/dogeos/bark-fork-rehearsal.json). Before a DogeOS buy or launch the app keeps back max(floor, live estimate):
// L1GasPriceOracle.getL1Fee for a representative raw transaction of the right size, plus gasLimit x gas price, x 1.5.
// The floor is used when the read fails. Only DogeOS chains have an oracle here.
//
//   node --test shared/dogeosGasReserve.test.mjs
//
// No network: the provider is a fake of ethers JsonRpcProvider.send(method, params), the only provider method used.
import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";

import {
  DOGEOS_BUY_GAS_LIMIT,
  DOGEOS_BUY_RAW_TX_BYTES,
  DOGEOS_L1_GAS_PRICE_ORACLE,
  DOGEOS_LAUNCH_GAS_LIMIT,
  DOGEOS_REPRESENTATIVE_LAUNCH_STRINGS,
  DOGEOS_RESERVE_CACHE_MS,
  DOGEOS_RESERVE_MARGIN_PCT,
  DOGE_BUY_RESERVE_FLOOR_WEI,
  DOGE_LAUNCH_RESERVE_FLOOR_WEI,
  L1_MARGIN,
  LEGACY_TX_ENVELOPE_BYTES,
  barkLaunchCalldataBytes,
  createDogeosReserveCache,
  dogeosL1OracleFor,
  dogeosReserveFloorWei,
  dogeosReserveFromFees,
  dogeosReserveRawTxBytes,
  encodeGetL1FeeCall,
  estimateDogeosReserveWei,
  formatDogeReserve,
  l1MarginBytes,
  paddedForL1,
  representativeL1Payload,
} from "./dogeosGasReserve.mjs";

const DOGE = 10n ** 18n;
const DOGEOS = 6281971;
const byteLen = (hex) => (hex.length - 2) / 2;
const hex = (n) => `0x${BigInt(n).toString(16)}`;

// The rehearsal's live numbers (oracle "latest", 2026-10-15): L2 price and the L1 fee of the dearest buy and launch.
const L2_PRICE = 15_680_108n;
const BUY_L1_FEE = 39_348_292_944_445_076n;
const LAUNCH_L1_FEE = 119_281_117_292_503_475n;
// The 2026-10-14 oracle (fork block): ~25x dearer.
const BUY_L1_FEE_HIGH = 902_602_157_710_850_566n;

/** A fake read provider: JsonRpcProvider.send(method, params). Answers eth_call to the oracle and eth_gasPrice. */
function fakeProvider({ l1FeeWei = BUY_L1_FEE, gasPriceWei = L2_PRICE, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    async send(method, params) {
      calls.push({ method, params });
      if (fail === method || fail === "all") throw new Error(`rpc down (${method})`);
      if (method === "eth_gasPrice") return hex(gasPriceWei);
      if (method === "eth_call") {
        const [tx, tag] = params;
        assert.equal(tag, "latest");
        assert.equal(tx.to, DOGEOS_L1_GAS_PRICE_ORACLE);
        return ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [typeof l1FeeWei === "function" ? l1FeeWei(tx.data) : l1FeeWei]);
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

test("floors: 0.05 DOGE for a buy, 0.2 DOGE for a launch; margin 150%; cache 30 s", () => {
  assert.equal(DOGE_BUY_RESERVE_FLOOR_WEI, 5n * 10n ** 16n);
  assert.equal(DOGE_LAUNCH_RESERVE_FLOOR_WEI, 2n * 10n ** 17n);
  assert.equal(dogeosReserveFloorWei("buy"), DOGE_BUY_RESERVE_FLOOR_WEI);
  assert.equal(dogeosReserveFloorWei("launch"), DOGE_LAUNCH_RESERVE_FLOOR_WEI);
  assert.throws(() => dogeosReserveFloorWei("sell"), /buy or launch/);
  assert.equal(DOGEOS_RESERVE_MARGIN_PCT, 150);
  assert.equal(DOGEOS_RESERVE_CACHE_MS, 30_000);
  // the app's gas limits: BARK_TRADE_GAS_FLOOR binds on a buy (rehearsal appGasLimit 1,000,000); a launch measured
  // appGasLimit 7,915,397 (6,292,318 x 1.25 + 50,000), so 8M covers it.
  assert.equal(DOGEOS_BUY_GAS_LIMIT, 1_000_000n);
  assert.equal(DOGEOS_LAUNCH_GAS_LIMIT, 8_000_000n);
});

test("the oracle is the L1GasPriceOracle predeploy, and only DogeOS has one", () => {
  assert.equal(DOGEOS_L1_GAS_PRICE_ORACLE, "0x5300000000000000000000000000000000000002");
  assert.equal(dogeosL1OracleFor(DOGEOS), DOGEOS_L1_GAS_PRICE_ORACLE);
  for (const id of [56, 97, 101, 4663, 46630, 1, 0, null, undefined, "6281971x"]) assert.equal(dogeosL1OracleFor(id), null, String(id));
});

test("getL1Fee(bytes) calldata is the ABI encoding ethers produces", () => {
  const iface = new ethers.Interface(["function getL1Fee(bytes) view returns (uint256)"]);
  for (const payload of ["0x", "0xab", `0x${"5a".repeat(31)}`, `0x${"5a".repeat(32)}`, `0x${"c3".repeat(440)}`]) {
    assert.equal(encodeGetL1FeeCall(payload), iface.encodeFunctionData("getL1Fee", [payload]), `payload of ${byteLen(payload)} bytes`);
  }
  assert.throws(() => encodeGetL1FeeCall("0xabc"), /whole-byte hex/);
});

test("L1 margin and padding are the rehearsal's (scripts/lib/dogeosBarkBudget.mjs re-exports these)", () => {
  assert.deepEqual(L1_MARGIN, { minBytes: 64, pct: 5 });
  assert.equal(l1MarginBytes(375), 64);
  assert.equal(l1MarginBytes(1281), 65);
  const padded = paddedForL1(`0x${"00".repeat(375)}`);
  assert.equal(byteLen(padded), 439);
  // the margin filler never has a zero byte (the oracle prices compressibility)
  assert.doesNotMatch(padded.slice(2 + 375 * 2).match(/../g).join(","), /(^|,)00(,|$)/);
});

test("representative sizes: a buy is the rehearsal's dearest buy (376 raw bytes, 440 with margin)", () => {
  assert.equal(DOGEOS_BUY_RAW_TX_BYTES, 376);
  assert.equal(dogeosReserveRawTxBytes({ kind: "buy" }), 376);
  const payload = representativeL1Payload(376);
  assert.equal(byteLen(payload), 440);
  // non-zero pseudo-random bytes throughout: no cheap pattern the oracle could compress
  const bytes = payload.slice(2).match(/../g);
  assert.ok(!bytes.includes("00"));
  assert.ok(new Set(bytes).size > 100, "varied filler");
  // deterministic
  assert.equal(representativeL1Payload(376), payload);
});

test("launch size: the Bark launch calldata as ethers encodes it, plus a legacy envelope that covers the rehearsal's raw launch", () => {
  const LAUNCH_REQUEST_T =
    "(string name,string symbol,string logoURI,string xAccount,string website,string extraLink,bytes32 metadataHash,uint256 targetUsd,uint8 feeChoice,uint8 feeCreatorPct,uint256 firstBuyValue,uint256 minFirstBuyOut,uint256 salt,uint64 openAt)";
  const iface = new ethers.Interface([`function launch(${LAUNCH_REQUEST_T} req, (uint64 deadline, bytes signature) auth) payable`]);
  const encode = (s) =>
    byteLen(
      iface.encodeFunctionData("launch", [
        { ...s, metadataHash: ethers.ZeroHash, targetUsd: 1n, feeChoice: 1, feeCreatorPct: 0, firstBuyValue: 0n, minFirstBuyOut: 0n, salt: 0n, openAt: 0n },
        { deadline: 0n, signature: `0x${"11".repeat(65)}` },
      ]),
    );
  const rehearsal = DOGEOS_REPRESENTATIVE_LAUNCH_STRINGS;
  assert.deepEqual(rehearsal, {
    name: "Bark Test Coin",
    symbol: "BARK",
    logoURI: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
    xAccount: "",
    website: "",
    extraLink: "",
  });
  assert.equal(barkLaunchCalldataBytes(), encode(rehearsal));
  const real = {
    name: "Much Wow Dogé Coin ✨",
    symbol: "WOW",
    logoURI: "https://vrnsbguutnwgtekcexls.supabase.co/storage/v1/object/public/campaign-logos/0x1234567890abcdef1234567890abcdef12345678/1792227710-logo.png",
    xAccount: "https://x.com/muchwowdoge",
    website: "https://muchwow.example",
    extraLink: "https://t.me/muchwowdoge_chat_with_a_long_name_over_32_bytes",
  };
  assert.equal(barkLaunchCalldataBytes(real), encode(real));
  // missing fields take the rehearsal's strings
  assert.equal(barkLaunchCalldataBytes({ name: real.name }), encode({ ...rehearsal, name: real.name }));
  // raw = calldata + envelope: covers the rehearsal's measured launch (1,175 raw bytes) with its strings
  assert.equal(LEGACY_TX_ENVELOPE_BYTES, 128);
  assert.equal(dogeosReserveRawTxBytes({ kind: "launch" }), barkLaunchCalldataBytes() + 128);
  assert.ok(dogeosReserveRawTxBytes({ kind: "launch" }) >= 1175);
  assert.equal(dogeosReserveRawTxBytes({ kind: "launch", calldataBytes: 2000 }), 2128);
  // a legacy DogeOS tx with large fields still fits the envelope
  const tx = ethers.Transaction.from({ type: 0, chainId: BigInt(DOGEOS), nonce: 65_535, gasPrice: 2n ** 40n - 1n, gasLimit: 2n ** 32n - 1n, to: ethers.ZeroAddress.replace(/0$/, "1"), value: 2n ** 96n - 1n, data: `0x${"ab".repeat(1000)}` });
  tx.signature = ethers.Signature.from({ r: `0x${"ff".repeat(32)}`, s: `0x7f${"ff".repeat(31)}`, yParity: 1 });
  assert.ok(byteLen(tx.serialized) - 1000 <= LEGACY_TX_ENVELOPE_BYTES, `envelope ${byteLen(tx.serialized) - 1000}`);
  assert.throws(() => dogeosReserveRawTxBytes({ kind: "launch", calldataBytes: -1 }), /calldata/);
});

test("reserve math: max(floor, (l1Fee + gasLimit x gasPrice) x 1.5), rounded up", () => {
  // today's buy: 0.03935 DOGE L1 + 0.0000157 L2 -> x1.5 = 0.05905 DOGE, above the 0.05 floor
  const buy = dogeosReserveFromFees({ kind: "buy", l1FeeWei: BUY_L1_FEE, gasLimit: 1_000_000n, gasPriceWei: L2_PRICE });
  assert.equal(buy, ((BUY_L1_FEE + 1_000_000n * L2_PRICE) * 150n + 99n) / 100n);
  assert.ok(buy > DOGE_BUY_RESERVE_FLOOR_WEI);
  // today's launch: 0.1193 + 0.000125 -> x1.5 = 0.179, under the 0.2 floor
  assert.equal(dogeosReserveFromFees({ kind: "launch", l1FeeWei: LAUNCH_L1_FEE, gasLimit: 8_000_000n, gasPriceWei: L2_PRICE }), DOGE_LAUNCH_RESERVE_FLOOR_WEI);
  // 2026-10-14's oracle: a buy needs ~1.35 DOGE kept back
  const high = dogeosReserveFromFees({ kind: "buy", l1FeeWei: BUY_L1_FEE_HIGH, gasLimit: 1_000_000n, gasPriceWei: L2_PRICE });
  assert.ok(high > 13n * 10n ** 17n && high < 14n * 10n ** 17n, String(high));
  // rounding up by one wei
  assert.equal(dogeosReserveFromFees({ kind: "buy", l1FeeWei: DOGE, gasLimit: 0n, gasPriceWei: 0n }), 15n * 10n ** 17n);
  assert.equal(dogeosReserveFromFees({ kind: "buy", l1FeeWei: DOGE + 1n, gasLimit: 0n, gasPriceWei: 0n }), 15n * 10n ** 17n + 2n);
  assert.throws(() => dogeosReserveFromFees({ kind: "buy", l1FeeWei: -1n, gasLimit: 0n, gasPriceWei: 0n }), /l1FeeWei/);
  assert.throws(() => dogeosReserveFromFees({ kind: "buy", l1FeeWei: 1, gasLimit: 0n, gasPriceWei: 0n }), /l1FeeWei/);
});

test("estimate: reads getL1Fee for the representative payload and eth_gasPrice on the given provider", async () => {
  const seen = [];
  const provider = fakeProvider({
    l1FeeWei: (data) => {
      seen.push(data);
      return BUY_L1_FEE;
    },
  });
  const wei = await estimateDogeosReserveWei({ provider, chainId: DOGEOS, kind: "buy", cache: createDogeosReserveCache() });
  assert.equal(wei, dogeosReserveFromFees({ kind: "buy", l1FeeWei: BUY_L1_FEE, gasLimit: DOGEOS_BUY_GAS_LIMIT, gasPriceWei: L2_PRICE }));
  assert.deepEqual(provider.calls.map((c) => c.method).sort(), ["eth_call", "eth_gasPrice"]);
  assert.equal(seen[0], encodeGetL1FeeCall(representativeL1Payload(DOGEOS_BUY_RAW_TX_BYTES)));
  // a launch sized from its calldata: the oracle is asked for that many bytes (+ envelope + margin)
  const launchSeen = [];
  const lp = fakeProvider({ l1FeeWei: (data) => (launchSeen.push(data), LAUNCH_L1_FEE * 3n) });
  const lw = await estimateDogeosReserveWei({ provider: lp, chainId: DOGEOS, kind: "launch", calldataBytes: 1500, cache: createDogeosReserveCache() });
  assert.equal(launchSeen[0], encodeGetL1FeeCall(representativeL1Payload(1628)));
  assert.equal(lw, dogeosReserveFromFees({ kind: "launch", l1FeeWei: LAUNCH_L1_FEE * 3n, gasLimit: DOGEOS_LAUNCH_GAS_LIMIT, gasPriceWei: L2_PRICE }));
  // a caller's own gas limit is used
  const gp = fakeProvider({ l1FeeWei: 0n, gasPriceWei: 10n ** 12n });
  assert.equal(await estimateDogeosReserveWei({ provider: gp, chainId: DOGEOS, kind: "buy", gasLimit: 100_000n, cache: createDogeosReserveCache() }), 15n * 10n ** 16n);
});

test("estimate: a failed or malformed read falls back to the floor (and is not cached)", async () => {
  const errors = [];
  for (const fail of ["eth_call", "eth_gasPrice", "all"]) {
    const cache = createDogeosReserveCache();
    const provider = fakeProvider({ l1FeeWei: BUY_L1_FEE_HIGH, fail });
    assert.equal(await estimateDogeosReserveWei({ provider, chainId: DOGEOS, kind: "buy", cache, onError: (e) => errors.push(e) }), DOGE_BUY_RESERVE_FLOOR_WEI, fail);
    assert.equal(await estimateDogeosReserveWei({ provider, chainId: DOGEOS, kind: "launch", cache }), DOGE_LAUNCH_RESERVE_FLOOR_WEI, fail);
    // not cached: the next estimate reads again
    const before = provider.calls.length;
    await estimateDogeosReserveWei({ provider, chainId: DOGEOS, kind: "buy", cache });
    assert.ok(provider.calls.length > before, `${fail}: retried`);
  }
  assert.equal(errors.length, 3);
  const bad = { calls: [], async send(method) { this.calls.push(method); return method === "eth_call" ? "0x" : "0xnope"; } };
  assert.equal(await estimateDogeosReserveWei({ provider: bad, chainId: DOGEOS, kind: "buy", cache: createDogeosReserveCache() }), DOGE_BUY_RESERVE_FLOOR_WEI);
  // no provider: the floor, no throw
  assert.equal(await estimateDogeosReserveWei({ provider: null, chainId: DOGEOS, kind: "launch", cache: createDogeosReserveCache() }), DOGE_LAUNCH_RESERVE_FLOOR_WEI);
});

test("estimate: cached per chain, kind and size for 30 s, one read in flight", async () => {
  let t = 1_000_000;
  const cache = createDogeosReserveCache({ now: () => t });
  const provider = fakeProvider({ l1FeeWei: BUY_L1_FEE });
  const [a, b] = await Promise.all([
    estimateDogeosReserveWei({ provider, chainId: DOGEOS, kind: "buy", cache }),
    estimateDogeosReserveWei({ provider, chainId: DOGEOS, kind: "buy", cache }),
  ]);
  assert.equal(a, b);
  assert.equal(provider.calls.length, 2, "one eth_call + one eth_gasPrice for both");
  t += 29_999;
  await estimateDogeosReserveWei({ provider, chainId: DOGEOS, kind: "buy", cache });
  assert.equal(provider.calls.length, 2, "still cached");
  // another kind or size is its own entry
  await estimateDogeosReserveWei({ provider, chainId: DOGEOS, kind: "launch", cache });
  assert.equal(provider.calls.length, 4);
  await estimateDogeosReserveWei({ provider, chainId: DOGEOS, kind: "launch", calldataBytes: 3000, cache });
  assert.equal(provider.calls.length, 6);
  t += 1;
  await estimateDogeosReserveWei({ provider, chainId: DOGEOS, kind: "buy", cache });
  assert.equal(provider.calls.length, 8, "expired after 30 s");
});

test("estimate: refuses a chain without a DogeOS oracle and never reads it (BNB, Robinhood, Solana unchanged)", async () => {
  for (const chainId of [56, 97, 101, 4663, 46630]) {
    const provider = fakeProvider();
    await assert.rejects(estimateDogeosReserveWei({ provider, chainId, kind: "buy", cache: createDogeosReserveCache() }), /not a DogeOS chain/, String(chainId));
    assert.deepEqual(provider.calls, [], String(chainId));
  }
  await assert.rejects(estimateDogeosReserveWei({ provider: fakeProvider(), chainId: DOGEOS, kind: "sell" }), /buy or launch/);
});

test("formatDogeReserve: rounded up to 0.01 DOGE, trailing zeros dropped", () => {
  assert.equal(formatDogeReserve(59_045_000_000_000_000n), "0.06");
  assert.equal(formatDogeReserve(DOGE_BUY_RESERVE_FLOOR_WEI), "0.05");
  assert.equal(formatDogeReserve(DOGE_LAUNCH_RESERVE_FLOOR_WEI), "0.2");
  assert.equal(formatDogeReserve(1_350_000_000_000_000_001n), "1.36");
  assert.equal(formatDogeReserve(2n * DOGE), "2");
  assert.equal(formatDogeReserve(1n), "0.01");
  assert.equal(formatDogeReserve(0n), "0");
});
