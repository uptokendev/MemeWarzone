// DogeOS TEST env-block generator for the Bark stack (barkswap plan t16; spec section 4 "Indexer", "Keepers", B9).
//
// Run: node --test scripts/dogeos-env-blocks.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { main, renderDogeosEnvBlocks } from "./dogeos-env-blocks.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The two readers the blocks feed (the round trip below): the API's and the indexer's gen-8 config.
const { evmGen8ApiConfig } = await import(pathToFileURL(join(ROOT, "frontend/api/lib/evmGen8Config.js")).href);
const { evmGen8BarkConfig, gen8MoneyDepth } = await import(pathToFileURL(join(ROOT, "realtime-indexer/src/evm/evmGen8Config.ts")).href);

const KEY_SHAPE = /0x[0-9a-fA-F]{64}/;
const ADDR = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const DOGEOS = 6281971;
const START = 8_600_123;

// Barkswap on Chikyū (scripts/lib/dogeosTestnetDeployGuards.mjs BARKSWAP_EXTERNAL_ADDRESSES): public, fixed.
const BARKSWAP = {
  factory: "0xF3961157f56C983316657f0267B4C04460beE43f",
  poolDeployer: "0x4151224471B0EeA41eE4295c632cc61779d339C2",
  customPoolEntryPoint: "0x19B1A502Ea56843343E60e44a4a95B3cf4C914f5",
  swapRouter: "0x911E5A1630fD1768E5A1710DAAFaBb865cB79531",
  quoterV2: "0x187b41968063Cb8A04A5f4d2113844EF2Ba21493",
  nonfungiblePositionManager: "0xf596329a6c7E03F0708199cB5435f86783DB4302",
  wdoge: "0xF6BDB158A5ddF77F1B83bC9074F6a472c58D78aE",
};

// MuchFi (removed, B8): none of these may reach the output.
const MUCHFI_ADDRESSES = [
  "0x7d175e06570CaFA1cfDF060850b84E0Ca23EfF0B",
  "0x7932C91f3BAD326ecd6C2bE81697D732714B9eC5",
  "0x54f7D7f6FeDf4E930eFd6b4742Ba0B9E8a6dC1CB",
  "0xd34FE9553CE3012F81c8a7D86F3063AcADb8201c",
  "0x5DE1Ea595653419f295511DEb781b98387a77cc2",
];

const ROLES = {
  deployer: "0x6c5C684D8ddf1D4338DBEd21beb7D342dC8382f8",
  routeAuthority: "0x4fcD24d620f8eCd298bF4d43CB1cA2F4D23876FF",
  updater: "0x7dBDFe829309B4170346CF7e4496094CD126E9c1",
  operator: "0x0000000000000000000000000000000000000Fe7",
};

const FIX = {
  dogeUsd: ADDR(0xa1),
  gradOracle: ADDR(0xa2),
  weekly: ADDR(0xb1),
  charity: ADDR(0xb2),
  monthly: ADDR(0xb3),
  recruiter: ADDR(0xb4),
  protocol: ADDR(0xb5),
  community: ADDR(0xb6),
  holderDistributor: ADDR(0xb7),
  airdropDistributor: ADDR(0xb8),
  launchLib: ADDR(0xc1),
  feeBooks: ADDR(0xc2),
  escrow: ADDR(0xc3),
  splitter: ADDR(0xc4),
  choiceVault: ADDR(0xc5),
  reserveLock: ADDR(0xc6),
  plugin: ADDR(0xc7),
  launcher: ADDR(0xc8),
  lens: ADDR(0xc9),
};

/** The deployments/dogeos/testnet.bark.json record (scripts/lib/dogeosBarkStack.ts dogeosBarkManifestRecord). */
function fixtureManifest() {
  return {
    network: "dogeosTestnet",
    chainId: DOGEOS,
    kind: "dogeos-testnet-bark",
    status: "deployed-paused",
    deployedAt: "2026-10-16T00:00:00.000Z",
    startBlock: START,
    deployer: ROLES.deployer,
    admin: ROLES.deployer,
    owner: ROLES.deployer,
    routeAuthority: ROLES.routeAuthority,
    operator: ROLES.operator,
    airdropOperator: ROLES.deployer,
    // codeHashes are bytes32 (key-shaped): the generator must never copy them.
    barkswap: { ...BARKSWAP, codeHashes: { factory: `0x${"cd".repeat(32)}` } },
    oracle: { dogeUsd: FIX.dogeUsd, graduationOracle: FIX.gradOracle, maxPriceAge: "3600", updater: ROLES.updater, initialAnswer: "25000000" },
    launcherConfig: { minNativeUsd: "10000000000000000", maxNativeUsd: "10000000000000000000", maxOracleAge: "3600" },
    vaults: {
      weekly: FIX.weekly,
      charity: FIX.charity,
      monthly: FIX.monthly,
      recruiter: FIX.recruiter,
      protocol: FIX.protocol,
      community: FIX.community,
      holderDistributor: FIX.holderDistributor,
      airdropDistributor: FIX.airdropDistributor,
      monthlyCapUsd: "1500000000000000000000000",
    },
    choiceVault: { holderBatchDelay: "86400", caps: { maxBuyPerTx: "1", maxBuybackPerCoinWeek: "1", minBuyInterval: "1", maxImpactBps: "1", maxHolderBatchPerWeek: "1" } },
    deployed: {
      MwzBarkLaunchLib: FIX.launchLib,
      MwzBarkFeeBooks: FIX.feeBooks,
      MwzBarkCreatorEscrow: FIX.escrow,
      MwzBarkFeeSplitter: FIX.splitter,
      MwzBarkCreatorChoiceVault: FIX.choiceVault,
      MwzBarkReserveLock: FIX.reserveLock,
      MwzBarkPlugin: FIX.plugin,
      MwzBarkLauncher: FIX.launcher,
      MwzBarkLaunchLens: FIX.lens,
    },
    barkNonce0: 9,
    wiringSent: ["MwzBarkCreatorChoiceVault.setOperator"],
    txs: [{ label: "DogeosTestnetDogeUsdOracle", hash: `0x${"ef".repeat(32)}`, nonce: 0, status: "mined" }],
  };
}

/** Splits the output into its three blocks and parses `NAME=value` lines (comments kept apart). */
function parseBlocks(text) {
  const blocks = {};
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const header = /^# =+ TEST (frontend|API|indexer)\b/.exec(line);
    if (header) {
      current = header[1].toLowerCase();
      blocks[current] = { vars: new Map(), comments: [] };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("#")) {
      blocks[current].comments.push(line);
      continue;
    }
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) {
      assert.ok(!blocks[current].vars.has(m[1]), `${m[1]} appears twice in the ${current} block`);
      blocks[current].vars.set(m[1], m[2]);
    } else {
      assert.equal(line.trim(), "", `unexpected line in the ${current} block: ${line}`);
    }
  }
  return blocks;
}

const envOf = (block) => Object.fromEntries(block.vars);
/** The API reader returns checksummed addresses; compare them case-insensitively. */
const lowerAddresses = (cfg) => Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : v]));

/**
 * The DogeOS keeper lanes (realtime-indexer/src/evm/dogeosBarkKeepers.ts BARK_LANE_FLAG, plan t20) and the send switch:
 * each is printed, and printed "false" (every lane off, dry run) until the founder's go.
 */
const KEEPERS_SOURCE = readFileSync(join(ROOT, "realtime-indexer/src/evm/dogeosBarkKeepers.ts"), "utf8");
const KEEPER_FLAG_NAMES = [
  "DOGEOS_BARK_COLLECT_ENABLED_6281971",
  "DOGEOS_BARK_GRAD_FEE_ENABLED_6281971",
  "DOGEOS_BARK_RESERVE_ENABLED_6281971",
  "DOGEOS_BARK_ADMIN_WATCH_ENABLED_6281971",
  "DOGEOS_BARK_SIDE_POOLS_ENABLED_6281971",
  "DOGEOS_BARK_ROUTE_ENABLED_6281971",
  "EVM_CREATOR_CHOICE_ENABLED_6281971",
  "DOGEOS_BARK_SEND_6281971",
];
const KEEPER_FLAGS_OFF = Object.fromEntries(KEEPER_FLAG_NAMES.map((name) => [name, "false"]));

const EXPECTED = {
  frontend: {
    VITE_PUBLIC_RPC_6281971: "https://rpc.testnet.dogeos.com",
    VITE_EVM_GEN8_LAUNCHER_6281971: FIX.launcher,
    VITE_EVM_GEN8_PLUGIN_6281971: FIX.plugin,
    VITE_EVM_GEN8_LENS_6281971: FIX.lens,
    VITE_EVM_GEN8_ESCROW_6281971: FIX.escrow,
    VITE_EVM_GEN8_CHOICE_VAULT_6281971: FIX.choiceVault,
    VITE_EVM_GEN8_RESERVE_LOCK_6281971: FIX.reserveLock,
    VITE_TREASURY_VAULT_ADDRESS_6281971: FIX.weekly,
    VITE_RECRUITER_REWARDS_VAULT_ADDRESS_6281971: FIX.recruiter,
    VITE_COMMUNITY_REWARDS_VAULT_ADDRESS_6281971: FIX.community,
    VITE_PROTOCOL_REVENUE_VAULT_ADDRESS_6281971: FIX.protocol,
    VITE_GRADUATION_ORACLE_ADDRESS_6281971: FIX.gradOracle,
  },
  api: {
    DOGEOS_RPC_HTTP_6281971: "https://rpc.testnet.dogeos.com",
    EVM_GEN8_LAUNCHER_6281971: `${FIX.launcher}@${START}`,
    EVM_GEN8_PLUGIN_6281971: `${FIX.plugin}@${START}`,
    EVM_GEN8_LENS_6281971: FIX.lens,
    EVM_GEN8_SPLITTER_6281971: `${FIX.splitter}@${START}`,
    EVM_GEN8_CHOICE_VAULT_6281971: FIX.choiceVault,
    EVM_GEN8_RESERVE_LOCK_6281971: FIX.reserveLock,
    EVM_GEN8_ESCROW_6281971: FIX.escrow,
    REWARD_DISTRIBUTOR_ADDRESS_6281971: FIX.airdropDistributor,
    ROUTE_AUTHORITY_PRIVATE_KEY: "<paste DOGEOS_TESTNET_ROUTE_AUTHORITY_PRIVATE_KEY from config/dogeos.local>",
  },
  indexer: {
    DOGEOS_RPC_HTTP_6281971: "https://rpc.testnet.dogeos.com",
    EVM_GEN8_LAUNCHER_6281971: `${FIX.launcher}@${START}`,
    EVM_GEN8_PLUGIN_6281971: `${FIX.plugin}@${START}`,
    EVM_GEN8_SPLITTER_6281971: `${FIX.splitter}@${START}`,
    EVM_GEN8_CHOICE_VAULT_6281971: FIX.choiceVault,
    EVM_GEN8_RESERVE_LOCK_6281971: FIX.reserveLock,
    EVM_GEN8_ESCROW_6281971: FIX.escrow,
    EVM_GEN8_LENS_6281971: FIX.lens,
    DOGEOS_OPERATOR_ADDRESS: ROLES.operator,
    ...KEEPER_FLAGS_OFF,
    DOGEOS_BARK_KEEPER_PRIVATE_KEY_6281971: "<paste DOGEOS_TESTNET_GRADUATION_KEEPER_PRIVATE_KEY from config/dogeos.local>",
    EVM_GEN8_OPERATOR_KEY_6281971: "<paste DOGEOS_TESTNET_OPERATOR_PRIVATE_KEY from config/dogeos.local>",
    DOGEOS_NATIVE_USD_ORACLE_ADDRESS_6281971: FIX.dogeUsd,
    DOGEOS_ORACLE_PUSH_ENABLED: "false",
    DOGEOS_TESTNET_ORACLE_UPDATER_PRIVATE_KEY: "<paste DOGEOS_TESTNET_ORACLE_UPDATER_PRIVATE_KEY from config/dogeos.local>",
  },
};

/** Optional knobs shown commented out, never set. */
const EXPECTED_COMMENTED = {
  indexer: ["EVM_GEN8_MONEY_DEPTH_6281971", "DOGEOS_ORACLE_PUSH_MAX_INTERVAL_SECONDS", "DOGEOS_ORACLE_PUSH_DEVIATION_BPS"],
};

/**
 * Env names the gen-7 / MuchFi DogeOS stack used (removed, B8), and the Uniswap V4 names that disable a Barkswap chain.
 * None may appear anywhere in the output, not even in a comment.
 */
const REMOVED_NAMES = [
  "FACTORY_ADDRESS_6281971",
  "FACTORY_START_BLOCK_6281971",
  "SUPPORTED_FACTORY_ADDRESSES_6281971",
  "SUPPORTED_FACTORY_START_BLOCKS_6281971",
  "ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_6281971",
  "VITE_CAMPAIGN_IMPLEMENTATION_ADDRESS_6281971",
  "VITE_TREASURY_ROUTER_ADDRESS_6281971",
  "VITE_RISK_REGISTRY_ADDRESS_6281971",
  "VITE_CREATOR_REGISTRY_ADDRESS_6281971",
  "VITE_PERMANENT_LP_LOCKER_ADDRESS_6281971",
  "VITE_ROBINHOOD_V3_",
  "LP_LOCKER_ADDRESS_6281971",
  "EVM_GEN7_",
  "EVM_GRADUATION_KEEPER_",
  "EVM_KEEPER_V3_",
  "EVM_KEEPER_WETH_6281971",
  "ENABLE_ROBINHOOD_V3_POOL_INDEXER",
  "VITE_ENABLE_DIRECT_ROBINHOOD_DEPLOY",
  "EVM_GEN8_HOOK_6281971",
  "EVM_GEN8_POOL_MANAGER_6281971",
  "EVM_GEN8_UNIVERSAL_ROUTER_6281971",
  "EVM_GEN8_V4_QUOTER_6281971",
  "EVM_GEN8_CREATE_SIGNER_PRIVATE_KEY",
];

function render(manifest = fixtureManifest()) {
  return renderDogeosEnvBlocks(manifest, { manifestPath: "deployments/dogeos/testnet.bark.json" });
}

test("every expected name is present, with its manifest value, in each of the three blocks", () => {
  const blocks = parseBlocks(render());
  assert.deepEqual(Object.keys(blocks).sort(), ["api", "frontend", "indexer"]);
  for (const [block, expected] of Object.entries(EXPECTED)) {
    for (const [name, value] of Object.entries(expected)) {
      assert.ok(blocks[block].vars.has(name), `${block} block is missing ${name}`);
      assert.equal(blocks[block].vars.get(name), value, `${block} ${name}`);
    }
    assert.deepEqual([...blocks[block].vars.keys()].sort(), Object.keys(expected).sort(), `${block} block sets exactly the expected names`);
  }
});

test("round trip: the API block is a valid Barkswap config for the API reader (evmGen8ApiConfig)", () => {
  const { api } = parseBlocks(render());
  const { config, reason } = evmGen8ApiConfig(DOGEOS, envOf(api));
  assert.equal(reason, null);
  assert.deepEqual(lowerAddresses(config), {
    chainId: DOGEOS,
    venue: "barkswap",
    launcher: FIX.launcher,
    plugin: FIX.plugin,
    hook: null,
    poolManager: null,
    lens: FIX.lens,
    splitter: FIX.splitter,
    choiceVault: FIX.choiceVault,
    reserveLock: FIX.reserveLock,
    escrow: FIX.escrow,
  });
});

test("round trip: the indexer block is a valid Barkswap config for the indexer reader (evmGen8BarkConfig)", () => {
  const { indexer } = parseBlocks(render());
  const env = envOf(indexer);
  const { config, invalid, reason } = evmGen8BarkConfig(DOGEOS, env);
  assert.equal(reason, null);
  assert.deepEqual(invalid, []);
  const lc = (a) => a.toLowerCase();
  assert.deepEqual(config, {
    chainId: DOGEOS,
    venue: "barkswap",
    launcher: { address: lc(FIX.launcher), startBlock: START },
    plugin: { address: lc(FIX.plugin), startBlock: START },
    splitter: { address: lc(FIX.splitter), startBlock: START },
    choiceVault: lc(FIX.choiceVault),
    reserveLock: lc(FIX.reserveLock),
    escrow: lc(FIX.escrow),
    startBlock: START,
  });
  // The money depth stays at its 20-block default (the knob is shown commented out only).
  assert.equal(gen8MoneyDepth(DOGEOS, env), 20);
});

test("round trip: the app's VITE_EVM_GEN8_* names are the API names with the VITE_ prefix", () => {
  const { frontend } = parseBlocks(render());
  const stripped = Object.fromEntries(
    [...frontend.vars].filter(([name]) => name.startsWith("VITE_EVM_GEN8_")).map(([name, value]) => [name.slice("VITE_".length), value]),
  );
  const { config: raw, reason } = evmGen8ApiConfig(DOGEOS, stripped);
  assert.equal(reason, null);
  const config = lowerAddresses(raw);
  assert.equal(config.launcher, FIX.launcher);
  assert.equal(config.plugin, FIX.plugin);
  assert.equal(config.lens, FIX.lens);
  assert.equal(config.escrow, FIX.escrow);
  assert.equal(config.choiceVault, FIX.choiceVault);
  assert.equal(config.reserveLock, FIX.reserveLock);
});

test("no removed gen-7 / MuchFi name and no Uniswap V4 name appears in the output, and no MuchFi address", () => {
  const text = render();
  for (const name of REMOVED_NAMES) assert.ok(!text.includes(name), `output names ${name}`);
  for (const address of MUCHFI_ADDRESSES) assert.ok(!text.toLowerCase().includes(address.toLowerCase()), `output carries MuchFi ${address}`);
  assert.ok(!/muchfi/i.test(text), "output mentions MuchFi");
});

test("the operator address is only ever the public DOGEOS_OPERATOR_ADDRESS; its key has one slot, the indexer's EVM_GEN8_OPERATOR_KEY_6281971", () => {
  const text = render();
  const blocks = parseBlocks(text);
  const occurrences = text.toLowerCase().split(ROLES.operator.toLowerCase()).length - 1;
  assert.equal(occurrences, 1, "the operator address appears once, as DOGEOS_OPERATOR_ADDRESS");
  assert.equal(blocks.indexer.vars.get("DOGEOS_OPERATOR_ADDRESS"), ROLES.operator);
  assert.ok(!blocks.api.vars.has("DOGEOS_OPERATOR_ADDRESS"));
  const operatorSlots = [];
  for (const [blockName, block] of Object.entries(blocks)) {
    for (const [name, value] of block.vars) {
      if (!/KEY|_PK$/.test(name)) continue;
      assert.ok(!value.toLowerCase().includes(ROLES.operator.toLowerCase()), `${name} carries the operator address`);
      if (/OPERATOR/i.test(value)) operatorSlots.push(`${blockName}:${name}=${value}`);
    }
  }
  // B9 / plan t20: the route worker and the choice-vault buyback sign with the operator key, on the TEST indexer only
  assert.deepEqual(operatorSlots, ["indexer:EVM_GEN8_OPERATOR_KEY_6281971=<paste DOGEOS_TESTNET_OPERATOR_PRIVATE_KEY from config/dogeos.local>"]);
  // the keeper slot never names the operator key
  assert.doesNotMatch(blocks.indexer.vars.get("DOGEOS_BARK_KEEPER_PRIVATE_KEY_6281971"), /OPERATOR/i);
});

test("the DogeOS keeper lanes are printed off, with the flag and key names the indexer reads (dogeosBarkKeepers.ts)", () => {
  const { indexer } = parseBlocks(render());
  for (const name of KEEPER_FLAG_NAMES) {
    assert.ok(KEEPERS_SOURCE.includes(`"${name}"`), `dogeosBarkKeepers.ts does not read ${name}`);
    assert.equal(indexer.vars.get(name), "false", name);
  }
  const flagged = [...KEEPERS_SOURCE.matchAll(/"((?:DOGEOS_BARK|EVM_CREATOR_CHOICE)_[A-Z_]*ENABLED_6281971)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(flagged)].sort(), KEEPER_FLAG_NAMES.filter((n) => n.includes("ENABLED")).sort(), "every lane flag of the keepers is printed");
  assert.ok(KEEPERS_SOURCE.includes('BARK_KEEPER_KEY_ENV = "DOGEOS_BARK_KEEPER_PRIVATE_KEY_6281971"'));
  assert.ok(KEEPERS_SOURCE.includes('BARK_OPERATOR_KEY_ENV = "EVM_GEN8_OPERATOR_KEY_6281971"'));
  assert.ok(KEEPERS_SOURCE.includes('BARK_LENS_ENV = "EVM_GEN8_LENS_6281971"'));
  assert.equal(indexer.vars.get("EVM_GEN8_LENS_6281971"), FIX.lens);
});

test("key values are always the config/dogeos.local paste placeholder (route authority on the API; updater, keeper and operator on the indexer)", () => {
  const blocks = parseBlocks(render());
  const keys = [];
  for (const [blockName, block] of Object.entries(blocks)) {
    for (const [name, value] of block.vars) {
      if (!/PRIVATE_KEY|_KEY_\d+$|_PK$/.test(name)) continue;
      keys.push(`${blockName}:${name}`);
      assert.match(value, /^<paste DOGEOS_TESTNET_(ROUTE_AUTHORITY|ORACLE_UPDATER|GRADUATION_KEEPER|OPERATOR)_PRIVATE_KEY from config\/dogeos\.local>$/, name);
    }
  }
  assert.deepEqual(keys.sort(), [
    "api:ROUTE_AUTHORITY_PRIVATE_KEY",
    "indexer:DOGEOS_BARK_KEEPER_PRIVATE_KEY_6281971",
    "indexer:DOGEOS_TESTNET_ORACLE_UPDATER_PRIVATE_KEY",
    "indexer:EVM_GEN8_OPERATOR_KEY_6281971",
  ]);
});

test("optional knobs are shown commented out only", () => {
  const blocks = parseBlocks(render());
  for (const [block, names] of Object.entries(EXPECTED_COMMENTED)) {
    for (const name of names) {
      assert.ok(!blocks[block].vars.has(name), `${name} must not be set`);
      assert.ok(blocks[block].comments.some((c) => c.startsWith(`# ${name}=`)), `${block} block lacks commented ${name}=`);
    }
  }
  assert.ok(blocks.indexer.comments.includes("# EVM_GEN8_MONEY_DEPTH_6281971=20"));
});

test("only DogeOS names are set; VITE_ALLOWED_CHAIN_IDS is an append instruction, never a full overwrite", () => {
  const blocks = parseBlocks(render());
  assert.ok(!blocks.frontend.vars.has("VITE_ALLOWED_CHAIN_IDS"));
  assert.ok(
    blocks.frontend.comments.some((c) => c.includes("VITE_ALLOWED_CHAIN_IDS") && c.includes(",6281971") && /append/i.test(c)),
    "frontend block lacks the append instruction for VITE_ALLOWED_CHAIN_IDS",
  );
  for (const block of ["frontend", "api", "indexer"]) {
    for (const name of blocks[block].vars.keys()) {
      const allowed = /_6281971$/.test(name) || /^DOGEOS_/.test(name) || (block === "api" && name === "ROUTE_AUTHORITY_PRIVATE_KEY");
      assert.ok(allowed, `${block} sets ${name}, which is neither _6281971, DOGEOS_* nor the TEST API route key`);
    }
  }
});

test("no private-key-shaped string in the output, even though the manifest carries bytes32 hashes", () => {
  assert.ok(!KEY_SHAPE.test(render()), "output contains a 0x + 64 hex string");
});

test("refuses to emit if a key-shaped value sits where an address is read", () => {
  const manifest = fixtureManifest();
  manifest.deployed.MwzBarkLauncher = `0x${"11".repeat(32)}`;
  assert.throws(() => render(manifest), /deployed\.MwzBarkLauncher/);
});

test("header names the three TEST Coolify services, the manifest and warns against production", () => {
  const text = render();
  const head = text.split(/^# =+ TEST /m)[0];
  for (const needle of [
    "Backend API Dev", "jkq5rjveklrueuuuputnpj6o",
    "realtime-indexer Dev", "s75mnp6dfpjtv8m8fcefxlay",
    "Frontend Dev", "4kdlgixhrtsorbqn6wi7kmr0",
    "deployments/dogeos/testnet.bark.json",
  ]) {
    assert.ok(head.includes(needle), `header lacks ${needle}`);
  }
  assert.match(head, /never paste[^\n]*production/i);
});

test("refuses a manifest of another kind (the gen-7 record, a partial run) or another chain", () => {
  const gen7 = fixtureManifest();
  gen7.kind = "dogeos-testnet-gen7";
  assert.throws(() => render(gen7), /dogeos-testnet-bark/);
  assert.throws(() => render({ status: "partial", chainId: DOGEOS, deployed: {}, txs: [] }), /dogeos-testnet-bark/);
  const other = fixtureManifest();
  other.chainId = 46630;
  assert.throws(() => render(other), /6281971/);
});

test("refuses a missing or non-positive start block instead of printing @0", () => {
  for (const bad of [undefined, null, 0, -1, "12a", 1.5]) {
    const manifest = fixtureManifest();
    manifest.startBlock = bad;
    assert.throws(() => render(manifest), /startBlock/, String(bad));
  }
});

test("refuses a manifest with a missing Bark address instead of printing an empty value", () => {
  for (const [section, key] of [["deployed", "MwzBarkPlugin"], ["deployed", "MwzBarkLaunchLens"], ["vaults", "airdropDistributor"], ["oracle", "dogeUsd"]]) {
    const manifest = fixtureManifest();
    delete manifest[section][key];
    assert.throws(() => render(manifest), new RegExp(`${section}\\.${key}`));
  }
  const noOperator = fixtureManifest();
  delete noOperator.operator;
  assert.throws(() => render(noOperator), /operator/);
});

test("refuses a manifest whose operator is another role's key (spec B9)", () => {
  for (const role of ["deployer", "admin", "routeAuthority"]) {
    const manifest = fixtureManifest();
    manifest.operator = manifest[role];
    assert.throws(() => render(manifest), /operator/, role);
  }
  const updater = fixtureManifest();
  updater.operator = ROLES.updater.toLowerCase();
  assert.throws(() => render(updater), /operator/);
});

test("refuses a manifest deployed against another Barkswap (the app trades through the pinned SwapRouter)", () => {
  const manifest = fixtureManifest();
  manifest.barkswap.swapRouter = ADDR(0x5e);
  assert.throws(() => render(manifest), /barkswap\.swapRouter/);
});

test("every pinned Barkswap address is checked, the factory the side-pool watch reads included", () => {
  for (const key of Object.keys(BARKSWAP)) {
    const manifest = fixtureManifest();
    manifest.barkswap[key] = ADDR(0x5e);
    assert.throws(() => render(manifest), new RegExp(`barkswap\\.${key}`), key);
    const missing = fixtureManifest();
    delete missing.barkswap[key];
    assert.throws(() => render(missing), new RegExp(`barkswap\\.${key}`), key);
  }
});

function mockFs(files) {
  const opened = [];
  const record = (p) => opened.push(String(p));
  return {
    opened,
    readFileSync(p) {
      record(p);
      if (Object.hasOwn(files, String(p))) return files[String(p)];
      const err = new Error(`ENOENT: ${p}`);
      err.code = "ENOENT";
      throw err;
    },
    existsSync(p) {
      record(p);
      return Object.hasOwn(files, String(p));
    },
    openSync(p) {
      record(p);
      throw new Error(`openSync not allowed: ${p}`);
    },
  };
}

function capture() {
  const out = [];
  return { out, write: (s) => out.push(String(s)) };
}

test("main reads only the manifest through the injected fs; config/dogeos.local is never opened", () => {
  const manifestPath = "fixtures/dogeos-testnet.bark.json";
  const fsMock = mockFs({ [manifestPath]: JSON.stringify(fixtureManifest()) });
  const stdout = capture();
  const stderr = capture();
  const code = main([manifestPath], { fs: fsMock, stdout, stderr });
  assert.equal(code, 0, stderr.out.join(""));
  assert.deepEqual(fsMock.opened, [manifestPath]);
  const blocks = parseBlocks(stdout.out.join(""));
  assert.equal(blocks.api.vars.get("EVM_GEN8_LAUNCHER_6281971"), `${FIX.launcher}@${START}`);
});

test("main defaults to deployments/dogeos/testnet.bark.json", () => {
  const fsMock = mockFs({ "deployments/dogeos/testnet.bark.json": JSON.stringify(fixtureManifest()) });
  const code = main([], { fs: fsMock, stdout: capture(), stderr: capture() });
  assert.equal(code, 0);
  assert.deepEqual(fsMock.opened, ["deployments/dogeos/testnet.bark.json"]);
});

test("main refuses config/dogeos.local or any .env file as the manifest without opening it", () => {
  for (const bad of ["config/dogeos.local", "config\\dogeos.local", "frontend/.env", "frontend/.env.local", ".env.example"]) {
    const fsMock = mockFs({ [bad]: "{}" });
    const stderr = capture();
    const code = main([bad], { fs: fsMock, stdout: capture(), stderr });
    assert.notEqual(code, 0, bad);
    assert.deepEqual(fsMock.opened, [], `${bad} was opened`);
    assert.match(stderr.out.join(""), /refus/i);
  }
});

test("main with the real fs module never touches config/dogeos.local (fs methods spied)", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mwz-dogeos-env-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manifestPath = join(dir, "testnet.bark.json");
  writeFileSync(manifestPath, JSON.stringify(fixtureManifest()));
  const touched = [];
  for (const name of ["readFileSync", "openSync", "existsSync", "statSync", "readFile", "createReadStream"]) {
    const original = fs[name];
    mock.method(fs, name, function spy(p, ...rest) {
      touched.push(String(p));
      return original.call(this, p, ...rest);
    });
  }
  t.after(() => mock.restoreAll());
  const stdout = capture();
  const code = main([manifestPath], { stdout, stderr: capture() });
  mock.restoreAll();
  assert.equal(code, 0);
  assert.ok(touched.includes(manifestPath), "the manifest is read through fs");
  assert.ok(!touched.some((p) => /dogeos\.local|[\\/]\.env/.test(p)), `touched: ${touched.join(", ")}`);
  assert.ok(!KEY_SHAPE.test(stdout.out.join("")));
});

// ------------------------------------------------------------------ env examples (placeholders only)

const EXAMPLES = [".env.example", "frontend/.env.example", "config/coolify-qa-staging.env.example"];

/** Every NAME on a `NAME=` or `# NAME=` line of the file. */
function exampleNames(text) {
  return text
    .split(/\r?\n/)
    .map((line) => /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line.trim()))
    .filter(Boolean)
    .map((m) => m[1]);
}

test("env examples carry no removed gen-7 / MuchFi DogeOS name and no key value", () => {
  for (const file of EXAMPLES) {
    const text = readFileSync(join(ROOT, file), "utf8");
    const dogeosNames = exampleNames(text).filter((n) => /_6281971$/.test(n));
    for (const name of dogeosNames) {
      const removed = REMOVED_NAMES.find((r) => name === r || (r.endsWith("_") && name.startsWith(r)));
      assert.ok(!removed, `${file} still names ${name}`);
    }
    assert.ok(!/muchfi/i.test(text), `${file} still mentions MuchFi`);
    for (const address of MUCHFI_ADDRESSES) assert.ok(!text.toLowerCase().includes(address.toLowerCase()), `${file} carries MuchFi ${address}`);
    assert.ok(!KEY_SHAPE.test(text), `${file} carries a key-shaped value`);
    assert.ok(!text.includes("deployments/dogeos/testnet.json"), `${file} points at the gen-7 manifest`);
  }
});

test("env examples list the gen-8 Bark names (launcher + plugin) for DogeOS, empty until the deploy", () => {
  const want = {
    "frontend/.env.example": ["VITE_EVM_GEN8_LAUNCHER_6281971", "VITE_EVM_GEN8_PLUGIN_6281971", "EVM_GEN8_LAUNCHER_6281971", "EVM_GEN8_PLUGIN_6281971"],
    "config/coolify-qa-staging.env.example": [
      "VITE_EVM_GEN8_LAUNCHER_6281971", "VITE_EVM_GEN8_PLUGIN_6281971", "EVM_GEN8_LAUNCHER_6281971", "EVM_GEN8_PLUGIN_6281971", "DOGEOS_OPERATOR_ADDRESS",
    ],
  };
  for (const [file, names] of Object.entries(want)) {
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const name of names) {
      const line = text.split(/\r?\n/).find((l) => new RegExp(`^#?\\s*${name}=`).test(l.trim()));
      assert.ok(line, `${file} lacks ${name}`);
      assert.match(line.trim(), new RegExp(`^#?\\s*${name}=$`), `${file} ${name} must be empty (placeholder) until the deploy`);
    }
  }
});
