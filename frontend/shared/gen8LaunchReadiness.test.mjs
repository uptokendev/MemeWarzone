// A chain with only gen-8 envs can launch. A chain with no gen-8 launcher keeps the old sentence.
import assert from "node:assert/strict";
import test from "node:test";
import { getAddress } from "ethers";
import { evmLaunchConfigured, gen8LaunchReadiness, legacyLaunchIncompleteMessage } from "./gen8LaunchReadiness.mjs";

const addr = (n) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const OLD = "BNB Testnet launch contracts are incomplete — choose Draft or fix env wiring.";

const full97 = {
  VITE_EVM_GEN8_LAUNCHER_97: addr(1),
  VITE_EVM_GEN8_HOOK_97: addr(2),
  VITE_EVM_GEN8_LENS_97: addr(3),
  VITE_EVM_GEN8_POOL_MANAGER_97: addr(4),
  VITE_EVM_GEN8_UNIVERSAL_ROUTER_97: addr(5),
  VITE_EVM_GEN8_UNIVERSAL_ROUTER_LAYOUT_97: "v2.1",
  VITE_EVM_GEN8_V4_QUOTER_97: addr(6),
};

test("a chain with only gen-8 envs can launch, with no gen-6/7 factory", () => {
  const gate = evmLaunchConfigured({
    chainId: 97,
    env: full97,
    legacyReady: false,
    legacyFactory: "",
    chainLabel: "BNB Testnet",
  });
  assert.equal(gate.configured, true);
  assert.equal(gate.legacy, false);
  assert.equal(gate.message, "");
  assert.equal(gate.gen8.active, true);
  assert.equal(gate.gen8.launcher, addr(1));
  assert.equal(gate.gen8.missing.length, 0);
  assert.equal(legacyLaunchIncompleteMessage("BNB Testnet"), OLD);
});

test("a chain with no gen-8 launcher shows the old message", () => {
  const gate = evmLaunchConfigured({
    chainId: 97,
    env: { VITE_EVM_GEN8_HOOK_97: addr(2) },
    legacyReady: false,
    legacyFactory: "",
    chainLabel: "BNB Testnet",
  });
  assert.equal(gate.gen8.active, false);
  assert.equal(gate.configured, false);
  assert.equal(gate.legacy, true);
  assert.equal(gate.message, OLD);
  const readyLegacy = evmLaunchConfigured({
    chainId: 97,
    env: {},
    legacyReady: true,
    legacyFactory: addr(9),
    chainLabel: "BNB Testnet",
  });
  assert.equal(readyLegacy.configured, true);
  assert.equal(readyLegacy.message, "");
});

test("a launcher without a hook names that env and does not mention the factory", () => {
  const gate = evmLaunchConfigured({
    chainId: 97,
    env: { VITE_EVM_GEN8_LAUNCHER_97: addr(1) },
    legacyReady: true,
    legacyFactory: addr(9),
    chainLabel: "BNB Testnet",
  });
  assert.equal(gate.configured, false);
  assert.equal(gate.legacy, false);
  assert.match(gate.message, /VITE_EVM_GEN8_HOOK_97/);
  assert.doesNotMatch(gate.message, /VITE_FACTORY_ADDRESS/);
  assert.doesNotMatch(gate.message, /—/);
  assert.equal(gate.gen8.launcher, addr(1));
});

test("an unknown router without a layout names the layout env", () => {
  const env = { ...full97 };
  delete env.VITE_EVM_GEN8_UNIVERSAL_ROUTER_LAYOUT_97;
  const gap = gen8LaunchReadiness(97, env, { vite: true, scope: "launch" });
  assert.equal(gap.ready, false);
  assert.deepEqual(gap.missing.map((item) => item.env), ["VITE_EVM_GEN8_UNIVERSAL_ROUTER_LAYOUT_97"]);
});

test("a bad launcher value stays on gen-8 and names that env", () => {
  const gap = gen8LaunchReadiness(97, { VITE_EVM_GEN8_LAUNCHER_97: "not-an-address" }, { vite: true, scope: "launch" });
  assert.equal(gap.active, true);
  assert.equal(gap.ready, false);
  assert.equal(gap.launcher, null);
  assert.match(gap.message, /VITE_EVM_GEN8_LAUNCHER_97/);
  assert.doesNotMatch(gap.message, /VITE_FACTORY_ADDRESS/);
});

test("mainnet defaults cover PoolManager, router, and quoter; an explicit bad PoolManager does not", () => {
  const env = {
    VITE_EVM_GEN8_LAUNCHER_56: addr(1),
    VITE_EVM_GEN8_HOOK_56: addr(2),
    VITE_EVM_GEN8_LENS_56: addr(3),
  };
  assert.equal(gen8LaunchReadiness(56, env, { vite: true, scope: "launch" }).ready, true);
  const bad = gen8LaunchReadiness(56, { ...env, VITE_EVM_GEN8_POOL_MANAGER_56: "nope" }, { vite: true, scope: "launch" });
  assert.equal(bad.ready, false);
  assert.match(bad.message, /VITE_EVM_GEN8_POOL_MANAGER_56/);
});

test("the API create check is launcher, hook, and PoolManager", () => {
  const env = {
    EVM_GEN8_LAUNCHER_97: addr(1),
    EVM_GEN8_HOOK_97: addr(2),
    EVM_GEN8_POOL_MANAGER_97: addr(4),
  };
  const create = gen8LaunchReadiness(97, env, { vite: false, scope: "create" });
  assert.equal(create.ready, true);
  const launch = gen8LaunchReadiness(97, env, { vite: false, scope: "launch" });
  assert.equal(launch.ready, false);
  assert.match(launch.message, /EVM_GEN8_LENS_97/);
  assert.doesNotMatch(launch.message, /VITE_/);
  const onlyLauncher = gen8LaunchReadiness(97, { EVM_GEN8_LAUNCHER_97: addr(1) }, { vite: false, scope: "create" });
  assert.match(onlyLauncher.message, /EVM_GEN8_HOOK_97/);
  assert.match(onlyLauncher.message, /EVM_GEN8_POOL_MANAGER_97/);
});

// Barkswap venue (DogeOS 6281971): launcher + plugin (+ lens for the app button); no hook, PoolManager, router or quoter.
const fullDoge = {
  VITE_EVM_GEN8_LAUNCHER_6281971: `${addr(11)}@8600000`,
  VITE_EVM_GEN8_PLUGIN_6281971: `${addr(12)}@8600000`,
  VITE_EVM_GEN8_LENS_6281971: addr(13),
};

test("Barkswap: launcher, plugin and lens are a ready launch; the create scope needs launcher and plugin only", () => {
  const launch = gen8LaunchReadiness(6281971, fullDoge, { vite: true, scope: "launch" });
  assert.equal(launch.ready, true);
  assert.equal(launch.active, true);
  assert.equal(launch.launcher, addr(11));
  assert.equal(launch.message, "");
  const gate = evmLaunchConfigured({ chainId: 6281971, env: fullDoge, legacyReady: false, legacyFactory: "" });
  assert.equal(gate.configured, true);
  assert.equal(gate.legacy, false);
  const api = { EVM_GEN8_LAUNCHER_6281971: addr(11), EVM_GEN8_PLUGIN_6281971: addr(12) };
  assert.equal(gen8LaunchReadiness(6281971, api, { vite: false, scope: "create" }).ready, true);
  const noLens = gen8LaunchReadiness(6281971, api, { vite: false, scope: "launch" });
  assert.deepEqual(noLens.missing.map((m) => m.env), ["EVM_GEN8_LENS_6281971"]);
});

test("Barkswap: a missing plugin is named; a Uniswap V4 setting on the chain makes it not ready", () => {
  const { VITE_EVM_GEN8_PLUGIN_6281971: _p, ...noPlugin } = fullDoge;
  const gap = gen8LaunchReadiness(6281971, noPlugin, { vite: true, scope: "launch" });
  assert.equal(gap.ready, false);
  assert.deepEqual(gap.missing.map((m) => m.env), ["VITE_EVM_GEN8_PLUGIN_6281971"]);
  assert.match(gap.message, /^DogeOS Testnet launch contracts are incomplete\. Missing VITE_EVM_GEN8_PLUGIN_6281971\.$/);
  const v4 = gen8LaunchReadiness(6281971, { ...fullDoge, VITE_EVM_GEN8_HOOK_6281971: addr(2) }, { vite: true, scope: "launch" });
  assert.equal(v4.ready, false);
  assert.match(v4.message, /Remove the Uniswap V4 settings VITE_EVM_GEN8_HOOK_6281971/);
});

test("Barkswap trade gap: the plugin only; V4 chains unchanged", async () => {
  const { gen8TradeGap } = await import("./gen8LaunchReadiness.mjs");
  assert.equal(gen8TradeGap(6281971, fullDoge, { vite: true }).ready, true);
  const { VITE_EVM_GEN8_PLUGIN_6281971: _p, ...noPlugin } = fullDoge;
  assert.deepEqual(gen8TradeGap(6281971, noPlugin, { vite: true }).missing.map((m) => m.env), ["VITE_EVM_GEN8_PLUGIN_6281971"]);
  assert.equal(gen8TradeGap(97, full97, { vite: true }).ready, true);
});
