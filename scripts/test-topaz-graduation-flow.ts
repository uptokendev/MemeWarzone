import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { ethers, network } from "hardhat";

const {
  loadAuthoritativeTopazManifest,
  assertRuntimeTopazIdentity,
  assertRealStageManifest,
  sameAddress,
} = require("./lib/bnbRealTopazAuthority.cjs");
const { resolveExactCheckedOutHead } = require("./lib/exactSourceHead.cjs");

const EXPECTED_CHAIN_ID = 97;
const FOUNDER_OPERATOR = "0xEE2c6A7605ED378CF1D26D1d828446d63A3fdeDa";
const FOUNDER_ROUTE_AUTHORITY = "0x2b72A9E6C4Ea3525d83B8C5E8F2044BDbC1f1Dec";
const HISTORICAL_OPERATOR = "0x6404b7eA3156F621aD9616C32214CAf1D0780c3";
const HISTORICAL_ROUTE_AUTHORITY = "0xb989A99823eA96552c3E3198A40CdBF682EDf1aA";
const STAGE_MANIFEST = "reports/bnb-real-topaz-testnet-stage.json";
const ACCEPTED_PREFLIGHT = "scripts/test-topaz-graduation-flow-accepted-3-2.ts";

function fail(code: string): never {
  throw new Error(`GEN4_PREFLIGHT_FAILED:${code}`);
}

function normalizedPrivateKey(): string {
  const raw = String(process.env.DEPLOYER_PK || process.env.PRIVATE_KEY_DEPLOY || "").trim();
  if (!raw) fail("DEPLOYER_KEY_MISSING");
  return raw.startsWith("0x") ? raw : `0x${raw}`;
}

function configuredAddress(name: string, expected: string): string {
  const value = String(process.env[name] || expected).trim();
  if (!ethers.isAddress(value) || value === ethers.ZeroAddress) fail(`${name}_INVALID`);
  return ethers.getAddress(value);
}

async function runGen4ReadOnlyPreflight(): Promise<void> {
  const checkedOutSha = resolveExactCheckedOutHead(process.cwd());
  const gitHead = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], { encoding: "utf8" }).trim().toLowerCase();
  const githubSha = String(process.env.GITHUB_SHA || "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(checkedOutSha) || checkedOutSha !== gitHead || checkedOutSha !== githubSha) {
    fail("SOURCE_SHA_NOT_EXACT_HEAD");
  }

  const liveNetwork = await ethers.provider.getNetwork();
  const chainId = Number(liveNetwork.chainId);
  if (chainId !== EXPECTED_CHAIN_ID || network.name !== "bscTestnet") fail("CHAIN_NOT_97");

  const deployer = new ethers.Wallet(normalizedPrivateKey());
  const deployerAddress = ethers.getAddress(deployer.address);
  const admin = configuredAddress("BNB_TESTNET_ADMIN", FOUNDER_OPERATOR);
  const routeAuthority = configuredAddress("BNB_6C_ROUTE_AUTHORITY_ADDRESS", FOUNDER_ROUTE_AUTHORITY);

  if (!sameAddress(deployerAddress, FOUNDER_OPERATOR)) fail("DEPLOYER_NOT_FOUNDER_OPERATOR");
  if (!sameAddress(admin, FOUNDER_OPERATOR) || !sameAddress(admin, deployerAddress)) fail("ADMIN_NOT_DEPLOYER");
  if (!sameAddress(routeAuthority, FOUNDER_ROUTE_AUTHORITY)) fail("ROUTE_NOT_FOUNDER_AUTHORITY");
  if (sameAddress(routeAuthority, deployerAddress)) fail("ROUTE_EQUALS_DEPLOYER");

  for (const [label, actual] of [
    ["DEPLOYER", deployerAddress],
    ["ADMIN", admin],
    ["ROUTE", routeAuthority],
  ] as const) {
    if (sameAddress(actual, HISTORICAL_OPERATOR)) fail(`${label}_USES_HISTORICAL_OPERATOR`);
    if (sameAddress(actual, HISTORICAL_ROUTE_AUTHORITY)) fail(`${label}_USES_HISTORICAL_ROUTE`);
  }

  const operatorBalance = await ethers.provider.getBalance(FOUNDER_OPERATOR);
  const routeBalance = await ethers.provider.getBalance(FOUNDER_ROUTE_AUTHORITY);

  const { manifest: topaz } = loadAuthoritativeTopazManifest();
  const t = topaz.contracts;
  const codePresence: Record<string, boolean> = {};
  for (const [label, address] of Object.entries(t) as Array<[string, string]>) {
    const code = await ethers.provider.getCode(address);
    if (!code || code === "0x") fail(`TOPAZ_${label.toUpperCase()}_BYTECODE_MISSING`);
    codePresence[label] = true;
  }

  const router = new ethers.Contract(
    t.Router,
    [
      "function defaultFactory() view returns (address)",
      "function factoryRegistry() view returns (address)",
      "function weth() view returns (address)",
    ],
    ethers.provider,
  );
  const poolFactory = new ethers.Contract(
    t.PoolFactory,
    [
      "function implementation() view returns (address)",
      "function getFee(address,bool) view returns (uint256)",
    ],
    ethers.provider,
  );

  const runtime = {
    chainId,
    router: t.Router,
    poolFactory: await router.defaultFactory(),
    factoryRegistry: await router.factoryRegistry(),
    wbnb: await router.weth(),
    poolImplementation: await poolFactory.implementation(),
    volatileFeeBps: Number(await poolFactory.getFee(ethers.ZeroAddress, false)),
  };
  assertRuntimeTopazIdentity(runtime, topaz);
  if (runtime.volatileFeeBps !== 30) fail("TOPAZ_VOLATILE_FEE_NOT_30_BPS");

  let stageExists = false;
  if (fs.existsSync(STAGE_MANIFEST)) {
    stageExists = true;
    const stage = JSON.parse(fs.readFileSync(STAGE_MANIFEST, "utf8"));
    assertRealStageManifest(stage, topaz);
    if (!sameAddress(stage.admin, FOUNDER_OPERATOR)) fail("STAGE_ADMIN_MISMATCH");
    if (!sameAddress(stage.routeAuthority, FOUNDER_ROUTE_AUTHORITY)) fail("STAGE_ROUTE_MISMATCH");
    if (String(stage.sourceBaseSha || "").toLowerCase() !== checkedOutSha) fail("STAGE_SOURCE_SHA_MISMATCH");
  }

  console.log(`GEN4 SHA ${checkedOutSha}`);
  console.log("GEN4 CHAIN 97 VERIFIED YES");
  console.log(`GEN4 DEPLOYER ${deployerAddress}`);
  console.log("GEN4 DEPLOYER MATCH YES");
  console.log(`GEN4 ADMIN ${admin}`);
  console.log("GEN4 ADMIN MATCH YES");
  console.log(`GEN4 ROUTE AUTHORITY ${routeAuthority}`);
  console.log("GEN4 HISTORICAL OPERATOR USED NO");
  console.log("GEN4 HISTORICAL ROUTE AUTHORITY USED NO");
  console.log(`GEN4 OPERATOR BALANCE ${ethers.formatEther(operatorBalance)} tBNB`);
  console.log(`GEN4 ROUTE BALANCE ${ethers.formatEther(routeBalance)} tBNB`);
  console.log(`GEN4 TOPAZ BYTECODE Router=${codePresence.Router ? "YES" : "NO"} PoolFactory=${codePresence.PoolFactory ? "YES" : "NO"} FactoryRegistry=${codePresence.FactoryRegistry ? "YES" : "NO"} WBNB=${codePresence.WBNB ? "YES" : "NO"} PoolImplementation=${codePresence.PoolImplementation ? "YES" : "NO"}`);
  console.log(`GEN4 TOPAZ RUNTIME Router=${t.Router} PoolFactory=${runtime.poolFactory} FactoryRegistry=${runtime.factoryRegistry} WBNB=${runtime.wbnb} PoolImplementation=${runtime.poolImplementation} VolatileFeeBps=${runtime.volatileFeeBps}`);
  console.log("GEN4 TOPAZ LIVE VERIFIED YES");
  console.log("GEN4 SOURCE SHA VERIFIED YES");
  console.log(`GEN4 STAGE ALREADY EXISTS ${stageExists ? "YES" : "NO"}`);
  console.log("GEN4 DEPLOYMENT READY YES");
}

async function main(): Promise<void> {
  if (network.name !== "bscTestnet") fail("BSC_TESTNET_ONLY");

  // Preserve the accepted 3/2 preflight byte-for-byte and require it to pass first.
  execFileSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["hardhat", "run", ACCEPTED_PREFLIGHT, "--network", "bscTestnet"],
    { cwd: process.cwd(), env: process.env, stdio: "inherit" },
  );

  // This phase is read-only: signer derivation, RPC reads, bytecode reads and view calls only.
  await runGen4ReadOnlyPreflight();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
