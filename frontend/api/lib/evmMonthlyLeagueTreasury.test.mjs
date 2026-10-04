import assert from "node:assert/strict";
import test from "node:test";
import { AbiCoder, Interface, ZeroHash, getAddress } from "ethers";

import {
  MONTHLY_LEAGUE_FEE_ROUTERS_MAINNET,
  MONTHLY_LEAGUE_TREASURY_MAINNET,
  SUPERSEDED_MONTHLY_LEAGUE_TREASURIES,
  assertFeeRoutersFeedMonthlyTreasury,
  isSupersededMonthlyLeagueTreasury,
  monthlyLeagueTreasuryAddress,
  monthlyLeagueTreasuryForMonth,
} from "./evmMonthlyLeagueTreasury.js";

const BNB_NEW = "0x42D254A7451808Bb01df879d71BcAfDC5D605A38";
const BNB_OLD = "0xF62A09dea232bc8311D13bAEa89d79F48Cf7eCB8";
const RH_NEW = "0x576c1d6Ba6975020702Aa13dE0899D8CD92ECD1A";
const RH_OLD = "0xE72A281b4A728AFb5fa836f593B56C8f74Fd4238";

test("canonical mainnet treasuries are the 2026-09-27 replacements; the few-wei originals are superseded", () => {
  assert.equal(MONTHLY_LEAGUE_TREASURY_MAINNET[56], BNB_NEW);
  assert.equal(MONTHLY_LEAGUE_TREASURY_MAINNET[4663], RH_NEW);
  assert.deepEqual([...SUPERSEDED_MONTHLY_LEAGUE_TREASURIES[56]], [BNB_OLD]);
  assert.deepEqual([...SUPERSEDED_MONTHLY_LEAGUE_TREASURIES[4663]], [RH_OLD]);
  assert.equal(isSupersededMonthlyLeagueTreasury(56, BNB_OLD.toLowerCase()), true);
  assert.equal(isSupersededMonthlyLeagueTreasury(56, BNB_NEW), false);
  assert.equal(isSupersededMonthlyLeagueTreasury(4663, BNB_OLD), false, "superseded lists are per chain");
});

test("mainnet resolves the canonical vault with no env, and with an env equal to it", () => {
  assert.equal(monthlyLeagueTreasuryAddress(56, {}), BNB_NEW);
  assert.equal(monthlyLeagueTreasuryAddress(4663, {}), RH_NEW);
  assert.equal(monthlyLeagueTreasuryAddress("56", { MONTHLY_LEAGUE_TREASURY_ADDRESS_56: BNB_NEW.toLowerCase() }), BNB_NEW);
  // An unscoped address cannot say which chain it is for: ignored on mainnet.
  assert.equal(monthlyLeagueTreasuryAddress(4663, { MONTHLY_LEAGUE_TREASURY_ADDRESS: BNB_OLD }), RH_NEW);
});

test("fails closed: env set to the superseded vault, to another address, or to garbage", () => {
  assert.throws(() => monthlyLeagueTreasuryAddress(56, { MONTHLY_LEAGUE_TREASURY_ADDRESS_56: BNB_OLD }), (e) => e.code === "MONTHLY_TREASURY_SUPERSEDED");
  assert.throws(() => monthlyLeagueTreasuryAddress(4663, { MONTHLY_LEAGUE_TREASURY_ADDRESS_4663: RH_OLD }), (e) => e.code === "MONTHLY_TREASURY_SUPERSEDED");
  assert.throws(() => monthlyLeagueTreasuryAddress(4663, { MONTHLY_LEAGUE_TREASURY_ADDRESS_4663: BNB_NEW }), (e) => e.code === "MONTHLY_TREASURY_MISMATCH");
  assert.throws(() => monthlyLeagueTreasuryAddress(56, { MONTHLY_LEAGUE_TREASURY_ADDRESS_56: "0xpregrad" }), (e) => e.code === "MONTHLY_TREASURY_MISCONFIGURED");
});

test("testnets need their own env; 97 also accepts the unscoped name; unknown chains throw", () => {
  const t = "0x1111111111111111111111111111111111111111";
  assert.throws(() => monthlyLeagueTreasuryAddress(46630, {}), (e) => e.code === "MONTHLY_TREASURY_UNAVAILABLE");
  assert.equal(monthlyLeagueTreasuryAddress(46630, { MONTHLY_LEAGUE_TREASURY_ADDRESS_46630: t }), getAddress(t));
  assert.equal(monthlyLeagueTreasuryAddress(97, { MONTHLY_LEAGUE_TREASURY_ADDRESS: t }), getAddress(t));
  assert.throws(() => monthlyLeagueTreasuryAddress(46630, { MONTHLY_LEAGUE_TREASURY_ADDRESS: t }), (e) => e.code === "MONTHLY_TREASURY_UNAVAILABLE");
});

// Minimal ethers runner: answers monthSeal(monthId) / monthlyLeagueTreasury() per contract address.
const iface = new Interface([
  "function monthSeal(uint256) view returns (bool isSealed, bytes32 winnersRoot, uint256 oraclePrice, uint256 capUsd, uint256 capNative, uint256 playerPool, uint256 winnerTotal, uint256 overflow, uint256 sealedAt)",
  "function monthlyLeagueTreasury() view returns (address)",
]);
function fakeProvider({ sealed = {}, routers = {}, fail = {} } = {}) {
  const calls = [];
  return {
    calls,
    async call(tx) {
      const to = getAddress(tx.to);
      calls.push(to);
      if (fail[to]) throw new Error("rpc down");
      const parsed = iface.parseTransaction({ data: tx.data });
      if (parsed.name === "monthlyLeagueTreasury") return AbiCoder.defaultAbiCoder().encode(["address"], [routers[to]]);
      const isSealed = Boolean(sealed[to]?.includes(Number(parsed.args[0])));
      return iface.encodeFunctionResult("monthSeal", [isSealed, isSealed ? "0x" + "ab".repeat(32) : ZeroHash, 0, 0, 0, 0, 0, 0, 0]);
    },
  };
}

test("per month: current vault unless the month was sealed only on a superseded vault", async () => {
  // Nothing sealed anywhere (the 2026-10-04 state): the current vault, so the next seal goes there.
  assert.equal(await monthlyLeagueTreasuryForMonth(fakeProvider(), 56, 202608n, {}), BNB_NEW);
  // Sealed on the current vault.
  assert.equal(await monthlyLeagueTreasuryForMonth(fakeProvider({ sealed: { [BNB_NEW]: [202609] } }), 56, 202609n, {}), BNB_NEW);
  // An old seal stays claimable where its reserve is, instead of pointing at a vault that never reserved it.
  assert.equal(await monthlyLeagueTreasuryForMonth(fakeProvider({ sealed: { [BNB_OLD]: [202608] } }), 56, 202608n, {}), BNB_OLD);
  assert.equal(await monthlyLeagueTreasuryForMonth(fakeProvider({ sealed: { [RH_OLD]: [202609] } }), 4663, 202609n, {}), RH_OLD);
});

test("per month: an RPC failure propagates instead of guessing a vault; bad config throws before any call", async () => {
  await assert.rejects(monthlyLeagueTreasuryForMonth(fakeProvider({ fail: { [BNB_OLD]: true } }), 56, 202608n, {}), /rpc down/);
  const provider = fakeProvider();
  await assert.rejects(monthlyLeagueTreasuryForMonth(provider, 56, 202608n, { MONTHLY_LEAGUE_TREASURY_ADDRESS_56: BNB_OLD }), (e) => e.code === "MONTHLY_TREASURY_SUPERSEDED");
  assert.equal(provider.calls.length, 0);
});

test("routers: a seal goes ahead only when every live fee router feeds the vault", async () => {
  const [v4, v3] = MONTHLY_LEAGUE_FEE_ROUTERS_MAINNET[56].map(getAddress);
  assert.deepEqual(await assertFeeRoutersFeedMonthlyTreasury(fakeProvider({ routers: { [v4]: BNB_NEW, [v3]: BNB_NEW } }), 56, BNB_NEW), [v4, v3]);
  await assert.rejects(
    assertFeeRoutersFeedMonthlyTreasury(fakeProvider({ routers: { [v4]: BNB_NEW, [v3]: BNB_OLD } }), 56, BNB_NEW),
    (e) => e.code === "MONTHLY_TREASURY_ROUTER_MISMATCH",
  );
  assert.deepEqual(await assertFeeRoutersFeedMonthlyTreasury(fakeProvider(), 97, BNB_NEW), [], "no pinned routers on testnets");
});
