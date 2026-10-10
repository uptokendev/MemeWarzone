import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ethers } from "ethers";

import {
  GEN5_CAMPAIGN_IFACE_FULL,
  MUCHFI_V3_POOL_OBSERVATIONS_IFACE,
  V3_POOL_OBSERVATIONS_IFACE,
  createEthersKeeperReader,
  curvePriceToSqrtX96,
  v3PoolObservationsIface,
  v3PoolPriceAbi,
} from "../evm/evmGraduationKeeper.js";

// t30's recorded slot0() return of a real MuchFi 1% pool on DogeOS Chikyu (6281971). Its feeProtocol word is
// 3200 | 3200 << 16 = 209718400, which does not fit the uint8 our Uniswap V3 slot0 ABI declares.
const FIXTURE = JSON.parse(readFileSync(new URL("../../../test/fixtures/muchfiSlot0.json", import.meta.url), "utf8")) as {
  chainId: number;
  pool: { address: string; token0: string; token1: string; fee: number };
  rawReturn: string;
  decoded: {
    sqrtPriceX96: string;
    tick: number;
    observationIndex: number;
    observationCardinality: number;
    observationCardinalityNext: number;
    feeProtocol: number;
    unlocked: boolean;
  };
};
const DOGEOS = 6281971;
const OTHER_CHAINS = [56, 97, 4663, 46630];
const FROM = "0x00000000000000000000000000000000000000Ee";
const C = "0x00000000000000000000000000000000000000c1";
const SQRT = BigInt(FIXTURE.decoded.sqrtPriceX96);

test("fixture is the 6281971 MuchFi pool whose feeProtocol overflows uint8", () => {
  assert.equal(FIXTURE.chainId, DOGEOS);
  assert.equal(FIXTURE.decoded.feeProtocol, 209718400);
  assert.ok(FIXTURE.decoded.feeProtocol > 255);
});

test("DogeOS slot0 ABI decodes the MuchFi bytes: sqrtPrice, tick, cardinalities and the uint32 feeProtocol", () => {
  const r = MUCHFI_V3_POOL_OBSERVATIONS_IFACE.decodeFunctionResult("slot0", FIXTURE.rawReturn);
  assert.equal(r.sqrtPriceX96, SQRT);
  assert.equal(Number(r.tick), FIXTURE.decoded.tick);
  assert.equal(Number(r.observationIndex), FIXTURE.decoded.observationIndex);
  assert.equal(Number(r.observationCardinality), FIXTURE.decoded.observationCardinality);
  assert.equal(Number(r.observationCardinalityNext), FIXTURE.decoded.observationCardinalityNext);
  assert.equal(Number(r.feeProtocol), 209718400);
  assert.equal(r.unlocked, FIXTURE.decoded.unlocked);

  const p = new ethers.Interface(v3PoolPriceAbi(DOGEOS)).decodeFunctionResult("slot0", FIXTURE.rawReturn);
  assert.equal(p.sqrtPriceX96, SQRT);
  assert.equal(Number(p.tick), FIXTURE.decoded.tick);
  assert.equal(Number(p[5]), 209718400);
});

test("Robinhood/BNB slot0 ABIs are unchanged: uint8 feeProtocol, same bytes decode as before (masked)", () => {
  // The pre-existing declarations, verbatim. ethers 6 masks an over-wide uint word to the declared width,
  // so the same bytes still decode through the old path, with feeProtocol reading 209718400 & 0xff.
  assert.equal(
    V3_POOL_OBSERVATIONS_IFACE.getFunction("slot0")!.format("sighash") + V3_POOL_OBSERVATIONS_IFACE.getFunction("slot0")!.outputs.map((o) => o.type).join(","),
    "slot0()uint160,int24,uint16,uint16,uint16,uint8,bool",
  );
  for (const chainId of OTHER_CHAINS) {
    assert.deepEqual(v3PoolPriceAbi(chainId), [
      "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
      "function token0() view returns (address)",
    ]);
  }
  const r = V3_POOL_OBSERVATIONS_IFACE.decodeFunctionResult("slot0", FIXTURE.rawReturn);
  assert.equal(r.sqrtPriceX96, SQRT);
  assert.equal(Number(r.tick), FIXTURE.decoded.tick);
  assert.equal(Number(r.observationCardinalityNext), FIXTURE.decoded.observationCardinalityNext);
  assert.equal(Number(r.feeProtocol), 209718400 & 0xff);
  const p = new ethers.Interface(v3PoolPriceAbi(4663)).decodeFunctionResult("slot0", FIXTURE.rawReturn);
  assert.equal(Number(p[5]), 209718400 & 0xff);
});

test("observation and repair helpers select the uint32 ABI only for 6281971", () => {
  assert.equal(v3PoolObservationsIface(DOGEOS), MUCHFI_V3_POOL_OBSERVATIONS_IFACE);
  const dogeosPrice = new ethers.Interface(v3PoolPriceAbi(DOGEOS)).getFunction("slot0")!.outputs.map((o) => o.type);
  assert.deepEqual(dogeosPrice, ["uint160", "int24", "uint16", "uint16", "uint16", "uint32", "bool"]);
  for (const chainId of [...OTHER_CHAINS, 31337, 101]) {
    assert.equal(v3PoolObservationsIface(chainId), V3_POOL_OBSERVATIONS_IFACE, `chain ${chainId}`);
    const types = new ethers.Interface(v3PoolPriceAbi(chainId)).getFunction("slot0")!.outputs.map((o) => o.type);
    assert.equal(types[5], "uint8", `chain ${chainId}`);
  }
  // Same selector and the same increaseObservationCardinalityNext calldata either way: only the decode differs.
  assert.equal(MUCHFI_V3_POOL_OBSERVATIONS_IFACE.getFunction("slot0")!.selector, V3_POOL_OBSERVATIONS_IFACE.getFunction("slot0")!.selector);
  assert.equal(
    MUCHFI_V3_POOL_OBSERVATIONS_IFACE.encodeFunctionData("increaseObservationCardinalityNext", [180]),
    V3_POOL_OBSERVATIONS_IFACE.encodeFunctionData("increaseObservationCardinalityNext", [180]),
  );
});

/** A provider answering eth_call from a (to, selector) table; the pool answers slot0 with the recorded bytes. */
function tableProvider(table: Map<string, string>) {
  return {
    async call(tx: any) {
      const hit = table.get(`${String(tx.to).toLowerCase()}:${String(tx.data).slice(0, 10)}`);
      if (!hit) throw Object.assign(new Error("execution reverted"), { data: "0x" });
      return hit;
    },
  } as unknown as ethers.Provider;
}

const SLOT0_SELECTOR = V3_POOL_OBSERVATIONS_IFACE.getFunction("slot0")!.selector;

test("ethers reader on 6281971: observation step reads the MuchFi pool's slot0", async () => {
  const pool = FIXTURE.pool.address;
  const table = new Map<string, string>();
  table.set(
    `${C}:${GEN5_CAMPAIGN_IFACE_FULL.getFunction("getGraduationState")!.selector}`,
    GEN5_CAMPAIGN_IFACE_FULL.encodeFunctionResult("getGraduationState", [pool, 1n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]),
  );
  table.set(`${pool.toLowerCase()}:${SLOT0_SELECTOR}`, FIXTURE.rawReturn);
  const r = createEthersKeeperReader(tableProvider(table), DOGEOS, FROM, {} as any);
  assert.deepEqual(await r.observationState!(C, 180), {
    pool: ethers.getAddress(pool),
    cardinalityNext: FIXTURE.decoded.observationCardinalityNext,
  });
});

test("ethers reader on 6281971: partial-repair price read takes sqrtPrice from the MuchFi slot0", async () => {
  const { address: pool, token0: meme, token1: wdoge, fee } = FIXTURE.pool;
  const adapter = "0x0000000000000000000000000000000000000ad1";
  const factory = "0x7d175e06570CaFA1cfDF060850b84E0Ca23EfF0B";
  const P = 10n ** 12n;
  const iface = (sigs: string[]) => new ethers.Interface(sigs);
  const adapterI = iface([
    "function v3Factory() view returns (address)",
    "function WETH() view returns (address)",
    "function POOL_FEE() view returns (uint24)",
  ]);
  const factoryI = iface(["function getPool(address,address,uint24) view returns (address)"]);
  const token0I = iface(["function token0() view returns (address)"]);
  const table = new Map<string, string>();
  const on = (to: string, i: ethers.Interface, fn: string, values: unknown[]) =>
    table.set(`${to.toLowerCase()}:${i.getFunction(fn)!.selector}`, i.encodeFunctionResult(fn, values));
  on(C, GEN5_CAMPAIGN_IFACE_FULL, "token", [meme]);
  on(C, GEN5_CAMPAIGN_IFACE_FULL, "graduationQuoteToken", [ethers.ZeroAddress]);
  on(C, GEN5_CAMPAIGN_IFACE_FULL, "nativeFallback", [false]);
  on(C, GEN5_CAMPAIGN_IFACE_FULL, "graduationAdapter", [adapter]);
  on(C, GEN5_CAMPAIGN_IFACE_FULL, "getGraduationState", [ethers.ZeroAddress, P, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]);
  on(adapter, adapterI, "v3Factory", [factory]);
  on(adapter, adapterI, "WETH", [wdoge]);
  on(adapter, adapterI, "POOL_FEE", [fee]);
  on(factory, factoryI, "getPool", [pool]);
  on(pool, token0I, "token0", [meme]);
  table.set(`${pool.toLowerCase()}:${SLOT0_SELECTOR}`, FIXTURE.rawReturn);

  const r = createEthersKeeperReader(tableProvider(table), DOGEOS, FROM, {} as any);
  assert.deepEqual(await r.repairContext(C), { currentSqrtX96: SQRT, targetSqrtX96: curvePriceToSqrtX96(P, true) });
});
