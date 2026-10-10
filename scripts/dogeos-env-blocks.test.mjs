// DogeOS TEST env-block generator (plan t24, spec section 7 / gate 5).
//
// Run: node --test scripts/dogeos-env-blocks.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

import { main, renderDogeosEnvBlocks } from "./dogeos-env-blocks.mjs";

const KEY_SHAPE = /0x[0-9a-fA-F]{64}/;
const ADDR = (n) => `0x${n.toString(16).padStart(40, "0")}`;

// MuchFi on Chikyu (plan global constraints): public, fixed.
const MUCHFI = {
  factory: "0x7d175e06570CaFA1cfDF060850b84E0Ca23EfF0B",
  poolDeployer: "0x6c04e808d5FfFb597cb6a5b539f2a1dDF3529348",
  positionManager: "0x7932C91f3BAD326ecd6C2bE81697D732714B9eC5",
  smartRouter: "0x54f7D7f6FeDf4E930eFd6b4742Ba0B9E8a6dC1CB",
  swapRouterWithDeadline: "0xd34FE9553CE3012F81c8a7D86F3063AcADb8201c",
  quoterV2: "0x5DE1Ea595653419f295511DEb781b98387a77cc2",
  wdoge: "0xF6BDB158A5ddF77F1B83bC9074F6a472c58D78aE",
};

const FIX = {
  factory: ADDR(0xf1),
  locker: ADDR(0xf2),
  tokenDeployer: ADDR(0xf3),
  campaignImpl: ADDR(0xf4),
  gradAdapter: ADDR(0xf5),
  dogeUsd: ADDR(0xa1),
  gradOracle: ADDR(0xa2),
  weekly: ADDR(0xb1),
  charity: ADDR(0xb2),
  monthly: ADDR(0xb3),
  recruiter: ADDR(0xb4),
  protocol: ADDR(0xb5),
  risk: ADDR(0xc2),
  router: ADDR(0xd1),
  creatorVault: ADDR(0xd2),
  holderDistributor: ADDR(0xd3),
  community: ADDR(0xd4),
  airdropDistributor: ADDR(0xd5),
  nativeSwapAdapter: ADDR(0xe1),
};

/** The dogeosManifestRecord shape (scripts/lib/dogeosGen7Stack.ts), with t36's `registries.creatorRegistry: null`. */
function fixtureManifest() {
  return {
    network: "dogeosTestnet",
    chainId: 6281971,
    kind: "dogeos-testnet-gen7",
    deployer: "0x6c5C684D8ddf1D4338DBEd21beb7D342dC8382f8",
    admin: "0x6c5C684D8ddf1D4338DBEd21beb7D342dC8382f8",
    owner: "0x6c5C684D8ddf1D4338DBEd21beb7D342dC8382f8",
    status: "deployed-paused",
    deployedAt: "2026-10-11T00:00:00.000Z",
    routeAuthority: "0x4fcD24d620f8eCd298bF4d43CB1cA2F4D23876FF",
    maxOracleAgeSeconds: 3600,
    dex: {
      venue: "MuchFi",
      v3Factory: MUCHFI.factory,
      poolDeployer: MUCHFI.poolDeployer,
      positionManager: MUCHFI.positionManager,
      smartRouter: MUCHFI.smartRouter,
      swapRouterWithDeadline: MUCHFI.swapRouterWithDeadline,
      quoterV2: MUCHFI.quoterV2,
      weth: MUCHFI.wdoge,
      feeTier: 10000,
      tickSpacing: 200,
    },
    oracle: {
      dogeUsd: FIX.dogeUsd,
      graduationOracle: FIX.gradOracle,
      maxPriceAge: 3600,
      updater: "0x7dBDFe829309B4170346CF7e4496094CD126E9c1",
      initialAnswer: "25000000",
    },
    registries: { creatorRegistry: null, riskRegistry: FIX.risk },
    vaults: {
      weekly: FIX.weekly,
      charity: FIX.charity,
      monthly: FIX.monthly,
      recruiter: FIX.recruiter,
      protocol: FIX.protocol,
      monthlyCapUsd: "1500000000000000000000000",
    },
    nativeSwapAdapter: FIX.nativeSwapAdapter,
    fees: {
      admin: "0x6c5C684D8ddf1D4338DBEd21beb7D342dC8382f8",
      router: FIX.router,
      vault: FIX.creatorVault,
      holderDistributor: FIX.holderDistributor,
      communityRewardsVault: FIX.community,
      airdropDistributor: FIX.airdropDistributor,
      // A bytes32 the generator must never copy into the output (key-shaped).
      airdrop: { batchId: `0x${"ab".repeat(32)}` },
      batchA7Sent: ["TreasuryRouterV4.setRecruiterRewardsVault"],
    },
    deployed: {
      LaunchFactory: FIX.factory,
      LaunchFactoryGen7: FIX.factory,
      MuchfiV3PositionLocker: FIX.locker,
      LaunchTokenDeployer: FIX.tokenDeployer,
      LaunchCampaignGen7Implementation: FIX.campaignImpl,
      MuchfiV3NativeGraduationAdapter: FIX.gradAdapter,
    },
    creatorVault: FIX.creatorVault,
  };
}

/** Splits the output into its three blocks and parses `NAME=value` lines (comments ignored). */
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

const START = 4242;

const EXPECTED = {
  frontend: {
    VITE_PUBLIC_RPC_6281971: "https://rpc.testnet.dogeos.com",
    VITE_FACTORY_ADDRESS_6281971: FIX.factory,
    VITE_SUPPORTED_FACTORY_ADDRESSES_6281971: FIX.factory,
    VITE_CAMPAIGN_IMPLEMENTATION_ADDRESS_6281971: FIX.campaignImpl,
    VITE_TREASURY_ROUTER_ADDRESS_6281971: FIX.router,
    VITE_TREASURY_VAULT_ADDRESS_6281971: FIX.weekly,
    VITE_RECRUITER_REWARDS_VAULT_ADDRESS_6281971: FIX.recruiter,
    VITE_COMMUNITY_REWARDS_VAULT_ADDRESS_6281971: FIX.community,
    VITE_PROTOCOL_REVENUE_VAULT_ADDRESS_6281971: FIX.protocol,
    VITE_RISK_REGISTRY_ADDRESS_6281971: FIX.risk,
    VITE_GRADUATION_ORACLE_ADDRESS_6281971: FIX.gradOracle,
    VITE_PERMANENT_LP_LOCKER_ADDRESS_6281971: FIX.locker,
    VITE_WRAPPED_NATIVE_ADDRESS_6281971: MUCHFI.wdoge,
    VITE_ROBINHOOD_V3_FACTORY_ADDRESS_6281971: MUCHFI.factory,
    VITE_ROBINHOOD_V3_POSITION_MANAGER_ADDRESS_6281971: MUCHFI.positionManager,
    VITE_ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_6281971: MUCHFI.smartRouter,
    VITE_ROBINHOOD_V3_QUOTER_ADDRESS_6281971: MUCHFI.quoterV2,
    VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_V2_ADDRESS_6281971: FIX.nativeSwapAdapter,
  },
  api: {
    DOGEOS_RPC_HTTP_6281971: "https://rpc.testnet.dogeos.com",
    FACTORY_ADDRESS_6281971: FIX.factory,
    VITE_FACTORY_ADDRESS_6281971: FIX.factory,
    REWARD_DISTRIBUTOR_ADDRESS_6281971: FIX.airdropDistributor,
    LP_LOCKER_ADDRESS_6281971: FIX.locker,
    EVM_GEN7_ROUTER_6281971: `${FIX.router}@${START}`,
    EVM_GEN7_CREATOR_VAULT_6281971: `${FIX.creatorVault}@${START}`,
    EVM_GEN7_HOLDER_DISTRIBUTOR_6281971: `${FIX.holderDistributor}@${START}`,
    EVM_GEN7_COMMUNITY_VAULT_6281971: FIX.community,
    ROUTE_AUTHORITY_PRIVATE_KEY: "<paste DOGEOS_TESTNET_ROUTE_AUTHORITY_PRIVATE_KEY from config/dogeos.local>",
  },
  indexer: {
    DOGEOS_RPC_HTTP_6281971: "https://rpc.testnet.dogeos.com",
    FACTORY_ADDRESS_6281971: FIX.factory,
    FACTORY_START_BLOCK_6281971: String(START),
    SUPPORTED_FACTORY_ADDRESSES_6281971: FIX.factory,
    SUPPORTED_FACTORY_START_BLOCKS_6281971: String(START),
    ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_6281971: MUCHFI.smartRouter,
    EVM_GEN7_ROUTER_6281971: `${FIX.router}@${START}`,
    EVM_GEN7_CREATOR_VAULT_6281971: `${FIX.creatorVault}@${START}`,
    EVM_GEN7_HOLDER_DISTRIBUTOR_6281971: `${FIX.holderDistributor}@${START}`,
    EVM_GEN7_COMMUNITY_VAULT_6281971: FIX.community,
    EVM_GRADUATION_KEEPER_ENABLED_6281971: "true",
    EVM_GRADUATION_KEEPER_PRIVATE_KEY_6281971: "<paste DOGEOS_TESTNET_GRADUATION_KEEPER_PRIVATE_KEY from config/dogeos.local>",
    EVM_KEEPER_V3_FACTORY_6281971: MUCHFI.factory,
    EVM_KEEPER_WETH_6281971: MUCHFI.wdoge,
    EVM_KEEPER_V3_FEE_6281971: "10000",
    DOGEOS_NATIVE_USD_ORACLE_ADDRESS_6281971: FIX.dogeUsd,
    DOGEOS_ORACLE_PUSH_ENABLED: "false",
    DOGEOS_TESTNET_ORACLE_UPDATER_PRIVATE_KEY: "<paste DOGEOS_TESTNET_ORACLE_UPDATER_PRIVATE_KEY from config/dogeos.local>",
  },
};

/** Optional knobs shown commented out, never set. */
const EXPECTED_COMMENTED = {
  indexer: [
    "EVM_GRADUATION_KEEPER_MAX_GAS_6281971",
    "DOGEOS_ORACLE_PUSH_MAX_INTERVAL_SECONDS",
    "DOGEOS_ORACLE_PUSH_DEVIATION_BPS",
  ],
};

/** Non-DogeOS names the spec lets TEST touch only as an append (instruction comments, never set). */
const APPEND_ONLY = { frontend: "VITE_ALLOWED_CHAIN_IDS", indexer: "EVM_INDEXER_CHAIN_IDS" };

function render(manifest = fixtureManifest(), opts = { startBlock: START }) {
  return renderDogeosEnvBlocks(manifest, { manifestPath: "deployments/dogeos/testnet.json", ...opts });
}

test("every expected key is present, with its manifest value, in each of the three blocks", () => {
  const blocks = parseBlocks(render());
  assert.deepEqual(Object.keys(blocks).sort(), ["api", "frontend", "indexer"]);
  for (const [block, expected] of Object.entries(EXPECTED)) {
    for (const [name, value] of Object.entries(expected)) {
      assert.ok(blocks[block].vars.has(name), `${block} block is missing ${name}`);
      assert.equal(blocks[block].vars.get(name), value, `${block} ${name}`);
    }
  }
});

test("the V3 swap router everywhere is the MuchFi SmartRouter, never the deadline SwapRouter", () => {
  const text = render();
  assert.ok(!text.toLowerCase().includes(MUCHFI.swapRouterWithDeadline.toLowerCase()), "SwapRouter (deadline) leaked into the output");
  const blocks = parseBlocks(text);
  assert.equal(blocks.frontend.vars.get("VITE_ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_6281971"), MUCHFI.smartRouter);
  assert.equal(blocks.indexer.vars.get("ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_6281971"), MUCHFI.smartRouter);
});

test("optional knobs are shown commented out only", () => {
  const blocks = parseBlocks(render());
  for (const [block, names] of Object.entries(EXPECTED_COMMENTED)) {
    for (const name of names) {
      assert.ok(!blocks[block].vars.has(name), `${name} must not be set`);
      assert.ok(blocks[block].comments.some((c) => c.startsWith(`# ${name}=`)), `${block} block lacks commented ${name}=`);
    }
  }
});

test("VITE_ALLOWED_CHAIN_IDS / EVM_INDEXER_CHAIN_IDS are append instructions, never a full overwrite", () => {
  const blocks = parseBlocks(render());
  for (const [block, name] of Object.entries(APPEND_ONLY)) {
    assert.ok(!blocks[block].vars.has(name), `${name} must not be set in the ${block} block`);
    assert.ok(
      blocks[block].comments.some((c) => c.includes(name) && c.includes(",6281971") && /append/i.test(c)),
      `${block} block lacks the append instruction for ${name}`,
    );
  }
  for (const block of ["frontend", "api", "indexer"]) {
    for (const name of blocks[block].vars.keys()) {
      const allowed = /_6281971$/.test(name) || /^DOGEOS_/.test(name) || (block === "api" && name === "ROUTE_AUTHORITY_PRIVATE_KEY");
      assert.ok(allowed, `${block} sets ${name}, which is neither _6281971, DOGEOS_* nor the TEST API route key`);
    }
  }
});

test("key values are always the config/dogeos.local paste placeholder", () => {
  const blocks = parseBlocks(render());
  let keys = 0;
  for (const block of Object.values(blocks)) {
    for (const [name, value] of block.vars) {
      if (!/PRIVATE_KEY/.test(name)) continue;
      keys += 1;
      assert.match(value, /^<paste DOGEOS_TESTNET_[A-Z_]+_PRIVATE_KEY from config\/dogeos\.local>$/, name);
    }
  }
  assert.equal(keys, 3, "route authority (API), keeper and oracle updater (indexer)");
});

test("no private-key-shaped string in the output, even when the manifest carries bytes32 values", () => {
  const text = render();
  assert.ok(!KEY_SHAPE.test(text), "output contains a 0x + 64 hex string");
});

test("refuses to emit if a key-shaped value would reach the output", () => {
  const manifest = fixtureManifest();
  manifest.oracle.dogeUsd = `0x${"11".repeat(32)}`;
  assert.throws(() => render(manifest), /oracle\.dogeUsd/);
});

test("header names the three TEST Coolify services and warns against production", () => {
  const text = render();
  const head = text.split(/^# =+ TEST /m)[0];
  for (const needle of [
    "Backend API Dev", "jkq5rjveklrueuuuputnpj6o",
    "realtime-indexer Dev", "s75mnp6dfpjtv8m8fcefxlay",
    "Frontend Dev", "4kdlgixhrtsorbqn6wi7kmr0",
  ]) {
    assert.ok(head.includes(needle), `header lacks ${needle}`);
  }
  assert.match(head, /never paste[^\n]*production/i);
});

test("without --start-block the start blocks are an explicit placeholder, not 0", () => {
  const blocks = parseBlocks(render(fixtureManifest(), {}));
  assert.equal(blocks.indexer.vars.get("FACTORY_START_BLOCK_6281971"), "<START_BLOCK>");
  assert.equal(blocks.indexer.vars.get("EVM_GEN7_ROUTER_6281971"), `${FIX.router}@<START_BLOCK>`);
});

test("a creator registry is optional: null emits no VITE_CREATOR_REGISTRY line, an address emits it", () => {
  const without = parseBlocks(render());
  assert.ok(!without.frontend.vars.has("VITE_CREATOR_REGISTRY_ADDRESS_6281971"));
  const manifest = fixtureManifest();
  manifest.registries = { creatorRegistry: ADDR(0xc1), riskRegistry: FIX.risk };
  const withReg = parseBlocks(render(manifest));
  assert.equal(withReg.frontend.vars.get("VITE_CREATOR_REGISTRY_ADDRESS_6281971"), ADDR(0xc1));
  const planName = fixtureManifest();
  planName.registries = { creator: null, riskRegistry: FIX.risk };
  assert.ok(!parseBlocks(render(planName)).frontend.vars.has("VITE_CREATOR_REGISTRY_ADDRESS_6281971"));
});

test("refuses a manifest for another chain", () => {
  const manifest = fixtureManifest();
  manifest.chainId = 46630;
  assert.throws(() => render(manifest), /6281971/);
});

test("refuses a manifest whose DEX is not the pinned MuchFi set (SmartRouter swapped for SwapRouter)", () => {
  const manifest = fixtureManifest();
  manifest.dex.smartRouter = MUCHFI.swapRouterWithDeadline;
  assert.throws(() => render(manifest), /dex\.smartRouter/);
  const fee = fixtureManifest();
  fee.dex.feeTier = 3000;
  assert.throws(() => render(fee), /feeTier/);
});

test("refuses a manifest with a missing deployed address instead of printing an empty value", () => {
  const manifest = fixtureManifest();
  delete manifest.fees.airdropDistributor;
  assert.throws(() => render(manifest), /fees\.airdropDistributor/);
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
  const manifestPath = "fixtures/dogeos-testnet.json";
  const fsMock = mockFs({ [manifestPath]: JSON.stringify(fixtureManifest()) });
  const stdout = capture();
  const stderr = capture();
  const code = main([manifestPath, "--start-block", String(START)], { fs: fsMock, stdout, stderr });
  assert.equal(code, 0, stderr.out.join(""));
  assert.deepEqual(fsMock.opened, [manifestPath]);
  assert.ok(!fsMock.opened.some((p) => /dogeos\.local|\.env/.test(p)));
  const blocks = parseBlocks(stdout.out.join(""));
  assert.equal(blocks.api.vars.get("FACTORY_ADDRESS_6281971"), FIX.factory);
});

test("main defaults to deployments/dogeos/testnet.json", () => {
  const fsMock = mockFs({ "deployments/dogeos/testnet.json": JSON.stringify(fixtureManifest()) });
  const code = main([], { fs: fsMock, stdout: capture(), stderr: capture() });
  assert.equal(code, 0);
  assert.deepEqual(fsMock.opened, ["deployments/dogeos/testnet.json"]);
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
  const manifestPath = join(dir, "testnet.json");
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
