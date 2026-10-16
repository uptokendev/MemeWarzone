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

const { FORBIDDEN_KEEPER_ADDRESSES, assertKeeperKeyAllowed, forbiddenKeeperAddresses } = await import("../evm/evmGraduationKeeper.js");
const { assertOperatorKeyAllowed } = await import("../evm/evmCreatorChoiceConfig.js");
const { V3_GRADUATION_CHAINS, enabledKeeperChains, keeperConfig, keeperWallet, v3ObservationSlots } = await import(
  "../evm/evmGraduationKeeperConfig.js"
);
const { keeperRpc } = await import("../evm/evmGraduationKeeperWorker.js");

const DOGEOS_DEPLOYER = "0x6c5C684D8ddf1D4338DBEd21beb7D342dC8382f8";
const DOGEOS_UPDATER = "0x7dBDFe829309B4170346CF7e4496094CD126E9c1";
const DOGEOS_ROUTE_AUTHORITY = "0x4fcD24d620f8eCd298bF4d43CB1cA2F4D23876FF";

test("the gen-7 graduation keeper is off for 6281971: its enable flag is ignored (B8)", () => {
  assert.deepEqual(enabledKeeperChains({}), []);
  assert.deepEqual(enabledKeeperChains({ EVM_GRADUATION_KEEPER_ENABLED_6281971: "true" }), []);
  assert.deepEqual(enabledKeeperChains({ EVM_GRADUATION_KEEPER_ENABLED_46630: "1" }), [46630]);
  assert.deepEqual(
    enabledKeeperChains({
      EVM_GRADUATION_KEEPER_ENABLED_56: "1",
      EVM_GRADUATION_KEEPER_ENABLED_4663: "1",
      EVM_GRADUATION_KEEPER_ENABLED_97: "1",
      EVM_GRADUATION_KEEPER_ENABLED_46630: "1",
      EVM_GRADUATION_KEEPER_ENABLED_6281971: "1",
    }),
    [56, 4663, 97, 46630],
  );
});

test("max gas for the existing chains is unchanged", () => {
  assert.equal(keeperConfig(56, {}).maxGas, 15_000_000n);
  assert.equal(keeperConfig(97, {}).maxGas, 15_000_000n);
  assert.equal(keeperConfig(4663, {}).maxGas, 30_000_000n);
  assert.equal(keeperConfig(46630, {}).maxGas, 30_000_000n);
  assert.equal(keeperConfig(12345, {}).maxGas, 15_000_000n);
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

test("observation slots: 6281971 is no V3 graduation chain any more (MuchFi removed, B8); Robinhood/BNB unchanged", () => {
  assert.equal(V3_GRADUATION_CHAINS.has(DOGEOS), false);
  assert.equal(v3ObservationSlots(DOGEOS, {}), 0);
  assert.equal(v3ObservationSlots(DOGEOS, { EVM_KEEPER_V3_OBSERVATION_SLOTS_6281971: "180" }), 0);
  assert.equal(v3ObservationSlots(56, {}), 0);
  assert.equal(v3ObservationSlots(97, {}), 0);
  assert.equal(v3ObservationSlots(4663, {}), 180);
  assert.equal(v3ObservationSlots(46630, {}), 180);
  assert.deepEqual([...V3_GRADUATION_CHAINS], [4663, 46630]);
});

test("keeperRpc: 6281971 reads DOGEOS_RPC_HTTP_6281971 and never falls back to BSC/Robinhood", () => {
  assert.equal(keeperRpc(DOGEOS), RPC[DOGEOS]);
  assert.equal(keeperRpc(56), RPC[56]);
  assert.equal(keeperRpc(97), RPC[97]);
  assert.equal(keeperRpc(4663), RPC[4663]);
  assert.equal(keeperRpc(46630), RPC[46630]);
  assert.equal(keeperRpc(12345), "");
});

// Spec section 3 amendment + B9: FORBIDDEN_KEEPER_ADDRESSES for 6281971 also lists the DogeOS operator. Its address
// is known only after the founder generates the key (plan t29), so it comes from DOGEOS_OPERATOR_ADDRESS.
test("the keeper guard forbids the DogeOS operator from DOGEOS_OPERATOR_ADDRESS when set", () => {
  const operator = ethers.Wallet.createRandom();
  assert.deepEqual(forbiddenKeeperAddresses({}), FORBIDDEN_KEEPER_ADDRESSES, "unset: the hard-coded list only");
  const env = { DOGEOS_OPERATOR_ADDRESS: operator.address };
  const list = forbiddenKeeperAddresses(env);
  assert.ok(list.includes(operator.address.toLowerCase()), "the operator is in the forbidden list");
  for (const address of [DOGEOS_DEPLOYER, DOGEOS_UPDATER, DOGEOS_ROUTE_AUTHORITY]) {
    assert.ok(list.includes(address.toLowerCase()), `${address} stays forbidden`);
  }
  assert.doesNotThrow(() => assertKeeperKeyAllowed(operator.address, {}), "not forbidden while unset");
  assert.throws(() => assertKeeperKeyAllowed(operator.address, env), /refuses key/);
  assert.throws(() => assertKeeperKeyAllowed(operator.address.toLowerCase(), { DOGEOS_OPERATOR_ADDRESS: ` ${operator.address.toUpperCase().replace("0X", "0x")} ` }), /refuses key/);
});

test("keeperWallet on 6281971 refuses the operator's key", () => {
  const operator = ethers.Wallet.createRandom();
  const env = { EVM_GRADUATION_KEEPER_PRIVATE_KEY_6281971: operator.privateKey };
  assert.equal(keeperWallet(DOGEOS, env)?.address, operator.address);
  assert.throws(() => keeperWallet(DOGEOS, { ...env, DOGEOS_OPERATOR_ADDRESS: operator.address }), /refuses key/);
});

test("a malformed DOGEOS_OPERATOR_ADDRESS fails closed on 6281971: no DogeOS keeper key passes the guard", () => {
  const keeper = ethers.Wallet.createRandom();
  for (const bad of ["0x1234", "not-an-address", `${keeper.address}00`]) {
    assert.throws(() => assertKeeperKeyAllowed(keeper.address, { DOGEOS_OPERATOR_ADDRESS: bad }, DOGEOS), /DOGEOS_OPERATOR_ADDRESS/, bad);
    assert.throws(() => forbiddenKeeperAddresses({ DOGEOS_OPERATOR_ADDRESS: bad }, DOGEOS), /DOGEOS_OPERATOR_ADDRESS/, bad);
  }
});

// t20 review: the DogeOS operator address only concerns DogeOS keepers. A malformed value stops the 6281971 keepers and
// leaves every other chain's keeper (gen-7 graduation keeper on 56/97/4663/46630, the protocol forwarder keeper) as is.
test("a malformed DOGEOS_OPERATOR_ADDRESS does not stop the BNB / Robinhood keepers", () => {
  const keeper = ethers.Wallet.createRandom();
  const env = { DOGEOS_OPERATOR_ADDRESS: "0x1234" };
  for (const chainId of [56, 97, 4663, 46630, undefined]) {
    assert.doesNotThrow(() => assertKeeperKeyAllowed(keeper.address, env, chainId), String(chainId));
    assert.deepEqual(forbiddenKeeperAddresses(env, chainId), FORBIDDEN_KEEPER_ADDRESSES, String(chainId));
  }
  assert.equal(keeperWallet(97, { ...env, EVM_GRADUATION_KEEPER_PRIVATE_KEY_97: keeper.privateKey })?.address, keeper.address);
  // a deployer stays refused on every chain
  assert.throws(() => assertKeeperKeyAllowed(DOGEOS_DEPLOYER, env, 56), /refuses key/);
  // a well-formed operator is refused as a keeper on every chain
  const operator = ethers.Wallet.createRandom();
  for (const chainId of [56, 4663, DOGEOS, undefined]) {
    assert.throws(() => assertKeeperKeyAllowed(operator.address, { DOGEOS_OPERATOR_ADDRESS: operator.address }, chainId), /refuses key/, String(chainId));
  }
});

test("the operator keeps its operator role: the creator-choice operator guard does not refuse it (B9)", () => {
  const operator = ethers.Wallet.createRandom();
  assert.doesNotThrow(() => assertOperatorKeyAllowed(operator.address, { DOGEOS_OPERATOR_ADDRESS: operator.address }));
  assert.ok(!FORBIDDEN_KEEPER_ADDRESSES.includes(operator.address.toLowerCase()), "the hard-coded list never carries it");
});
