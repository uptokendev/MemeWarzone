import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";

// env.ts reads process.env once at import, so every value the worker's keeperRpc relies on is set
// here, before the first dynamic import. Each chain gets a distinct sentinel so a DogeOS lookup that
// falls through to BSC (or Robinhood) is visible.
process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.ABLY_API_KEY ||= "test:key";

const DOGEOS = 6281971;
const RPC = {
  56: "https://bsc-56.rpc.invalid",
  97: "https://bsc-97.rpc.invalid",
  4663: "https://rh-4663.rpc.invalid",
  46630: "https://rh-46630.rpc.invalid",
  [DOGEOS]: "https://rpc.testnet.dogeos.com",
} as const;
Object.assign(process.env, {
  BSC_RPC_HTTP_56: RPC[56],
  BSC_RPC_HTTP_97: RPC[97],
  ROBINHOOD_RPC_HTTP_4663: RPC[4663],
  ROBINHOOD_RPC_HTTP_46630: RPC[46630],
  DOGEOS_RPC_HTTP_6281971: RPC[DOGEOS],
});

const { FORBIDDEN_KEEPER_ADDRESSES, assertKeeperKeyAllowed } = await import("../evm/evmGraduationKeeper.js");
const { V3_GRADUATION_CHAINS, enabledKeeperChains, keeperConfig, keeperWallet, v3ObservationSlots } = await import(
  "../evm/evmGraduationKeeperConfig.js"
);
const { keeperRpc } = await import("../evm/evmGraduationKeeperWorker.js");

const DOGEOS_DEPLOYER = "0x6c5C684D8ddf1D4338DBEd21beb7D342dC8382f8";
const DOGEOS_UPDATER = "0x7dBDFe829309B4170346CF7e4496094CD126E9c1";
const DOGEOS_ROUTE_AUTHORITY = "0x4fcD24d620f8eCd298bF4d43CB1cA2F4D23876FF";
const TEN_M = 10_000_000n;

test("keeper is enabled on 6281971 only with EVM_GRADUATION_KEEPER_ENABLED_6281971", () => {
  assert.deepEqual(enabledKeeperChains({}), []);
  assert.deepEqual(enabledKeeperChains({ EVM_GRADUATION_KEEPER_ENABLED_6281971: "true" }), [DOGEOS]);
  assert.deepEqual(enabledKeeperChains({ EVM_GRADUATION_KEEPER_ENABLED_6281971: "0" }), []);
  // Enabling another chain never switches DogeOS on.
  assert.deepEqual(enabledKeeperChains({ EVM_GRADUATION_KEEPER_ENABLED_46630: "1" }), [46630]);
  assert.deepEqual(
    enabledKeeperChains({
      EVM_GRADUATION_KEEPER_ENABLED_56: "1",
      EVM_GRADUATION_KEEPER_ENABLED_4663: "1",
      EVM_GRADUATION_KEEPER_ENABLED_97: "1",
      EVM_GRADUATION_KEEPER_ENABLED_46630: "1",
      EVM_GRADUATION_KEEPER_ENABLED_6281971: "1",
    }),
    [56, 4663, 97, 46630, DOGEOS],
  );
});

test("max gas on 6281971 defaults to <= 10M (Chikyu block gas limit) and env can lower but never raise it", () => {
  assert.ok(keeperConfig(DOGEOS, {}).maxGas <= TEN_M, "default must fit a 10M block");
  assert.equal(keeperConfig(DOGEOS, {}).maxGas, TEN_M);
  assert.equal(keeperConfig(DOGEOS, { EVM_GRADUATION_KEEPER_MAX_GAS_6281971: "15000000" }).maxGas, TEN_M);
  assert.equal(keeperConfig(DOGEOS, { EVM_GRADUATION_KEEPER_MAX_GAS: "15000000" }).maxGas, TEN_M);
  assert.equal(keeperConfig(DOGEOS, { EVM_GRADUATION_KEEPER_MAX_GAS_6281971: "8000000" }).maxGas, 8_000_000n);
  assert.equal(keeperConfig(DOGEOS, { EVM_GRADUATION_KEEPER_MAX_GAS: "7000000" }).maxGas, 7_000_000n);
  assert.equal(keeperConfig(DOGEOS, { EVM_GRADUATION_KEEPER_MAX_GAS_6281971: "abc" }).maxGas, TEN_M);
});

test("max gas for the existing chains is unchanged", () => {
  assert.equal(keeperConfig(56, {}).maxGas, 15_000_000n);
  assert.equal(keeperConfig(97, {}).maxGas, 15_000_000n);
  assert.equal(keeperConfig(4663, {}).maxGas, 30_000_000n);
  assert.equal(keeperConfig(46630, {}).maxGas, 30_000_000n);
  assert.equal(keeperConfig(12345, {}).maxGas, 15_000_000n);
  // Env overrides still apply above 10M on non-DogeOS chains.
  assert.equal(keeperConfig(56, { EVM_GRADUATION_KEEPER_MAX_GAS_56: "20000000" }).maxGas, 20_000_000n);
  assert.equal(keeperConfig(46630, { EVM_GRADUATION_KEEPER_MAX_GAS: "25000000" }).maxGas, 25_000_000n);
});

test("assertKeeperKeyAllowed refuses the DogeOS deployer, updater and route authority (any case)", () => {
  for (const address of [DOGEOS_DEPLOYER, DOGEOS_UPDATER, DOGEOS_ROUTE_AUTHORITY]) {
    assert.ok(FORBIDDEN_KEEPER_ADDRESSES.includes(address.toLowerCase()), `${address} hard-coded lowercase`);
    assert.throws(() => assertKeeperKeyAllowed(address, {}), /refuses key/);
    assert.throws(() => assertKeeperKeyAllowed(address.toLowerCase(), {}), /refuses key/);
  }
  // The pre-existing entries stay.
  for (const address of [
    "0x77f96a7d3bea7a090aacbd00a50002d2b9ae0714",
    "0x13ad79765e14927df2c554d9662bbe539e89c8e8",
    "0x1a367016f10b230e28cf1abda2594c47bf60fe34",
  ]) {
    assert.ok(FORBIDDEN_KEEPER_ADDRESSES.includes(address));
  }
});

test("keeperWallet on 6281971: a throwaway key is allowed, and refused once its address is forbidden", () => {
  const throwaway = ethers.Wallet.createRandom();
  const env = { EVM_GRADUATION_KEEPER_PRIVATE_KEY_6281971: throwaway.privateKey };
  assert.equal(keeperWallet(DOGEOS, env)?.address, throwaway.address);
  assert.throws(
    () => keeperWallet(DOGEOS, { ...env, EVM_KEEPER_FORBIDDEN_ADDRESSES: `0x${"00".repeat(20)}, ${throwaway.address}` }),
    /refuses key/,
  );
  assert.equal(keeperWallet(DOGEOS, {}), null);
});

test("observation slots: 6281971 is a V3 graduation chain with 180 slots by default", () => {
  assert.equal(V3_GRADUATION_CHAINS.has(DOGEOS), true);
  assert.equal(v3ObservationSlots(DOGEOS, {}), 180);
  assert.equal(keeperConfig(DOGEOS, {}).v3ObservationSlots, 180);
  assert.equal(v3ObservationSlots(DOGEOS, { EVM_KEEPER_V3_OBSERVATION_SLOTS_6281971: "0" }), 0);
  // BNB stays off, Robinhood stays on.
  assert.equal(v3ObservationSlots(56, {}), 0);
  assert.equal(v3ObservationSlots(97, {}), 0);
  assert.equal(v3ObservationSlots(4663, {}), 180);
  assert.equal(v3ObservationSlots(46630, {}), 180);
});

test("keeperRpc: 6281971 reads DOGEOS_RPC_HTTP_6281971 and never falls back to BSC/Robinhood", () => {
  assert.equal(keeperRpc(DOGEOS), RPC[DOGEOS]);
  assert.equal(keeperRpc(56), RPC[56]);
  assert.equal(keeperRpc(97), RPC[97]);
  assert.equal(keeperRpc(4663), RPC[4663]);
  assert.equal(keeperRpc(46630), RPC[46630]);
  assert.equal(keeperRpc(12345), "");
});
