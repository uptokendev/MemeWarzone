import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";

import {
  ESCROW_CLIFF_SECONDS,
  ESCROW_STEP_SECONDS,
  antiSniperFeeBpsAt,
  decodeCampaignRevert,
  parseGen5QuoteParams,
  readCreatorEscrow,
} from "./evmGen5CampaignState.js";

process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:1/test";
const { evmCampaignStateHandler, clearEvmCampaignStateCache } = await import("../evmCampaignState.js");
const { readCreatorBuyLock } = await import("../dev-fix/security-current-time.js");

test("anti-sniper fee matches C2: 5000 at launch, -80 bps per second with a 200 base, flat from 60 s", () => {
  const launchAt = 1_000;
  const at = (s) => antiSniperFeeBpsAt({ launchAt, protocolFeeBps: 200, now: launchAt + s });
  assert.equal(at(0), 5000);
  assert.equal(at(1), 4920);
  assert.equal(at(5), 4600);
  assert.equal(at(30), 2600);
  assert.equal(at(59), 280);
  assert.equal(at(60), 200);
  assert.equal(at(3600), 200);
  assert.equal(at(-100), 5000, "before launchAt the view reports the start value");
});

/** Reference model of C4: each buy of a at s releases a/5 at s + 30d + 7d*k. */
function model(buys) {
  return (t) => {
    let sum = 0n;
    for (let k = 0; k < 5; k += 1) {
      const cut = t - ESCROW_CLIFF_SECONDS - k * ESCROW_STEP_SECONDS;
      if (cut < 0) break;
      for (const [s, a] of buys) if (s <= cut) sum += a;
    }
    return sum / 5n;
  };
}

test("escrow: released, locked, the next release and the fully-free time, found against the vesting view", async () => {
  const day = 86_400;
  const buys = [[1_000_000, 500n], [1_000_000 + 10 * day, 1000n]];
  const vested = model(buys);
  let calls = 0;
  const vestedAt = async (t) => {
    calls += 1;
    return vested(Number(t));
  };

  const beforeCliff = await readCreatorEscrow({ vestedAt, total: 1500n, claimed: 0n, now: 1_000_000 + 20 * day });
  assert.equal(beforeCliff.vestedTokens, "0");
  assert.equal(beforeCliff.lockedTokens, "1500");
  assert.deepEqual(beforeCliff.nextRelease, { at: 1_000_000 + 30 * day, tokens: "100" });
  assert.equal(beforeCliff.fullyReleasedAt, 1_000_000 + 10 * day + 58 * day);
  assert.ok(calls < 80, `bounded probes, got ${calls}`);

  const mid = await readCreatorEscrow({ vestedAt, total: 1500n, claimed: 100n, now: 1_000_000 + 40 * day });
  // first buy: 2 tranches (30d, 37d) = 200; second: 1 tranche (40d) = 200
  assert.equal(mid.vestedTokens, "400");
  assert.equal(mid.claimableTokens, "300");
  assert.deepEqual(mid.nextRelease, { at: 1_000_000 + 44 * day, tokens: "100" });

  const done = await readCreatorEscrow({ vestedAt, total: 1500n, claimed: 1500n, now: 1_000_000 + 100 * day });
  assert.equal(done.lockedTokens, "0");
  assert.equal(done.nextRelease, null);

  const none = await readCreatorEscrow({ vestedAt: async () => { throw new Error("must not be called"); }, total: 0n, claimed: 0n, now: 5 });
  assert.equal(none.totalTokens, "0");
});

test("reverts decode to the campaign's error names", () => {
  const iface = new ethers.Interface(["error StartPriceOutOfBand()", "error GraduationNotDue()"]);
  assert.equal(decodeCampaignRevert({ data: iface.encodeErrorResult("StartPriceOutOfBand", []) }), "StartPriceOutOfBand");
  assert.equal(decodeCampaignRevert({ info: { error: { data: iface.encodeErrorResult("GraduationNotDue", []) } } }), "GraduationNotDue");
  assert.equal(decodeCampaignRevert({ data: "0xdeadbeef" }), "unknown:0xdeadbeef");
  assert.equal(decodeCampaignRevert({}), null);
});

test("quote parameters: positive whole numbers only", () => {
  assert.deepEqual(parseGen5QuoteParams({ buyWei: "10" }), { buyNativeWei: 10n, buyTokens: null, sellTokens: null });
  assert.throws(() => parseGen5QuoteParams({ sellTokens: "0" }));
  assert.throws(() => parseGen5QuoteParams({ buyTokens: "1e18" }));
});

function fakeRes() {
  return {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    end(payload) { this.body = payload ? JSON.parse(payload) : null; },
    json(payload) { this.body = payload; },
  };
}

test("handler: validates input, answers legacy campaigns as unsupported, caches per campaign", async () => {
  clearEvmCampaignStateCache();
  const campaign = "0x00000000000000000000000000000000000000c1";
  let reads = 0;
  const deps = {
    getProvider: async () => ({}),
    readState: async ({ campaignAddress }) => {
      reads += 1;
      return { campaignAddress: ethers.getAddress(campaignAddress), supported: false, generation: { factoryGeneration: 4, campaignGeneration: 3 } };
    },
  };
  const call = async (url) => {
    const res = fakeRes();
    await evmCampaignStateHandler({ method: "GET", url, query: Object.fromEntries(new URL(url, "http://x").searchParams) }, res, deps);
    return res;
  };
  assert.equal((await call(`/api/evm/campaign-state?chainId=101&campaign=${campaign}`)).statusCode, 400);
  assert.equal((await call("/api/evm/campaign-state?chainId=56&campaign=nope")).statusCode, 400);
  assert.equal((await call(`/api/evm/campaign-state?chainId=56&campaign=${campaign}&sellTokens=0`)).statusCode, 400);

  const first = await call(`/api/evm/campaign-state?chainId=56&campaign=${campaign}`);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.supported, false);
  assert.equal(first.body.cached, false);
  const second = await call(`/api/evm/campaign-state?chainId=56&campaign=${campaign}`);
  assert.equal(second.body.cached, true);
  assert.equal(reads, 1);

  const noRpc = fakeRes();
  await evmCampaignStateHandler(
    { method: "GET", url: `/x?chainId=4663&campaign=${campaign}`, query: { chainId: "4663", campaign } },
    noRpc,
    { ...deps, getProvider: async () => null },
  );
  assert.equal(noRpc.statusCode, 503);
});

test("trade preflight: a generation 5 campaign has no buy lock (escrow) and keeps the older legacy handling for others", async () => {
  const missing = Object.assign(new Error("missing revert data"), { code: "CALL_EXCEPTION", data: null });
  const gen5Provider = {};
  const campaign = { creatorBuyLockUntil: async () => { throw missing; } };
  // The probe contract is built from the address + provider; stub ethers.Contract through a provider call.
  const probeOk = { call: async () => ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [5000n]) };
  const read = await readCreatorBuyLock(campaign, "0x00000000000000000000000000000000000000c1", Object.assign(gen5Provider, probeOk));
  assert.deepEqual(read, { lockUntil: 0n, escrow: true });

  const probeFails = { call: async () => { throw missing; } };
  await assert.rejects(readCreatorBuyLock(campaign, "0x00000000000000000000000000000000000000c1", probeFails), (error) => error === missing);

  const legacy = { creatorBuyLockUntil: async () => 1234n };
  assert.deepEqual(await readCreatorBuyLock(legacy, "0x00000000000000000000000000000000000000c1", probeOk), { lockUntil: 1234n, escrow: false });

  const other = new Error("rate limited");
  await assert.rejects(readCreatorBuyLock({ creatorBuyLockUntil: async () => { throw other; } }, "0x00000000000000000000000000000000000000c1", probeOk), (e) => e === other);
});
