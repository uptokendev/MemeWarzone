// t15: the DogeOS Bark deploy stack (scripts/lib/dogeosBarkStack.ts) deployed and opened through the real entrypoints
// (scripts/deploy-dogeos-testnet.ts, scripts/activate-dogeos-testnet.ts) on a Chikyū fork against Barkswap's deployed
// contracts, then every address and role read back (spec section 3 "Roles and keys (B9)", section 5 "Deployment 1";
// the t15 hand-offs in docs/dogeos/barkswap-audit.md).
//
//   npx hardhat --config hardhat.dogeos-bark-fork.config.ts test test/dogeos/barkswap/DogeosBarkStack.fork.spec.ts
//
// Needs the root build too (npx hardhat compile): the reused oracle and vaults deploy from artifacts/ (0.8.24, the
// bytecode BNB and Robinhood run), the Bark contracts from artifacts-bark/. Hardhat's local accounts sign: #0 is the
// deployer/admin, #1 the fork-local route authority (createSigner), #2 the fork-local DogeOS operator. Binance is
// replaced by a fixed price (no outside call); the manifest goes to a temp directory. Nothing reaches Chikyū.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "chai";
import { ethers } from "hardhat";
import { BARKSWAP, readyFork } from "./fixtures/barkswap";
import { runDogeosTestnetDeploy } from "../../../scripts/deploy-dogeos-testnet";
import { runDogeosTestnetActivate } from "../../../scripts/activate-dogeos-testnet";
import {
  BARK_PREDICTED_ORDER,
  DOGEOS_BARK_CHAIN_ID,
  linkBytecode,
  loadDogeosDeployGuards,
  loadStackArtifact,
  planBarkAddresses,
  readBackDogeosBarkStack,
} from "../../../scripts/lib/dogeosBarkStack";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const BLOCK_GAS = 10_000_000n;
const same = (a: string, b: string) => ethers.getAddress(a) === ethers.getAddress(b);
const esm = (rel: string): Promise<any> => Function("s", "return import(s)")(pathToFileURL(path.join(ROOT, rel)).href);

/** Binance stand-in: DOGE $0.25, ETH $3000 (8 dp). */
const PRICES: Record<string, string> = { DOGEUSDT: "0.25000000", ETHUSDT: "3000.00000000" };
const fakeFetch = async (input: any) => {
  const symbol = new URL(String(input)).searchParams.get("symbol") ?? "";
  if (!PRICES[symbol]) return new Response("{}", { status: 404 });
  return new Response(JSON.stringify({ symbol, price: PRICES[symbol] }), { status: 200 });
};

const ENV_KEYS = [
  "DOGEOS_TESTNET_DEPLOY_BROADCAST",
  "DOGEOS_TESTNET_ACTIVATE_BROADCAST",
  "DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS",
  "DOGEOS_OPERATOR_ADDRESS",
  "DOGEOS_TESTNET_MANIFEST",
] as const;

const view = (address: string, fragments: string[]) => new ethers.Contract(address, fragments, ethers.provider) as any;

/** The promise rejects with an error whose message matches `re`. */
async function rejects(promise: Promise<unknown>, re: RegExp): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  expect(error, `expected a rejection matching ${re}`).to.be.instanceOf(Error);
  expect((error as Error).message).to.match(re);
}

describe("DogeOS Bark deploy stack (t15) on the Chikyū fork", function () {
  const savedEnv: Record<string, string | undefined> = {};
  let guards: any;
  let admin: string;
  let routeAuthority: string;
  let operator: string;
  let tmp: string;
  let manifestPath: string;
  let record: any;

  before(async function () {
    await readyFork();
    guards = await loadDogeosDeployGuards();
    const signers = await ethers.getSigners();
    [admin, routeAuthority, operator] = await Promise.all(signers.slice(0, 3).map((s) => s.getAddress()));
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mwz-dogeos-bark-stack-"));
    manifestPath = path.join(tmp, "testnet.bark.json");
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS = routeAuthority;
    process.env.DOGEOS_OPERATOR_ADDRESS = operator;
    process.env.DOGEOS_TESTNET_MANIFEST = manifestPath;
    delete process.env.DOGEOS_TESTNET_DEPLOY_BROADCAST;
    delete process.env.DOGEOS_TESTNET_ACTIVATE_BROADCAST;
  });

  after(function () {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("pins: the guards' Barkswap addresses are the fixture's, and every pinned code hash is the fork's code", async function () {
    expect(DOGEOS_BARK_CHAIN_ID).to.equal(6281971n);
    for (const [key, address] of Object.entries(guards.BARKSWAP_EXTERNAL_ADDRESSES as Record<string, string>)) {
      expect(address, key).to.equal((BARKSWAP as Record<string, string>)[key]);
      expect(ethers.keccak256(await ethers.provider.getCode(address)), key).to.equal(guards.BARKSWAP_CODE_HASHES[key]);
    }
  });

  it("refuses before any send: no broadcast token, an operator that is the route authority, a missing operator", async function () {
    const nonce = await ethers.provider.getTransactionCount(admin);
    await rejects(runDogeosTestnetDeploy({ fetchImpl: fakeFetch, log: () => {} }), /DOGEOS_TESTNET_DEPLOY_BROADCAST=I_HAVE_FOUNDER_GO/);
    process.env.DOGEOS_TESTNET_DEPLOY_BROADCAST = "I_HAVE_FOUNDER_GO";
    process.env.DOGEOS_OPERATOR_ADDRESS = routeAuthority;
    await rejects(runDogeosTestnetDeploy({ fetchImpl: fakeFetch, log: () => {} }), /DOGEOS_OPERATOR_ADDRESS .* is the route authority/);
    delete process.env.DOGEOS_OPERATOR_ADDRESS;
    await rejects(runDogeosTestnetDeploy({ fetchImpl: fakeFetch, log: () => {} }), /DOGEOS_OPERATOR_ADDRESS is missing/);
    process.env.DOGEOS_OPERATOR_ADDRESS = operator;
    expect(await ethers.provider.getTransactionCount(admin)).to.equal(nonce);
    expect(fs.existsSync(manifestPath)).to.equal(false);
  });

  it("the deploy entrypoint deploys and wires the whole stack and writes the manifest and verification JSON outside the repo", async function () {
    const result = await runDogeosTestnetDeploy({ fetchImpl: fakeFetch, log: () => {} });
    expect(result.mode).to.equal("chikyu-fork");
    expect(path.resolve(result.manifestPath)).to.equal(path.resolve(manifestPath));
    expect(path.relative(ROOT, result.manifestPath).startsWith("..")).to.equal(true);
    record = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(record.kind).to.equal("dogeos-testnet-bark");
    expect(record.chainId).to.equal(6281971);
    expect(record.status).to.equal("deployed-paused");
    expect(same(record.admin, admin) && same(record.deployer, admin) && same(record.owner, admin)).to.equal(true);
    expect(same(record.routeAuthority, routeAuthority)).to.equal(true);
    expect(same(record.operator, operator)).to.equal(true);
    // the initial DOGE/USD answer and the choice-vault caps come from the (fake) Binance prices at run time
    expect(record.oracle.initialAnswer).to.equal("25000000");
    expect(record.choiceVault.caps.maxBuyPerTx).to.equal((2280n * 10n ** 18n).toString()); // 0.19 ETH at $3000 = 2280 DOGE at $0.25
    expect(record.choiceVault.caps.maxImpactBps).to.equal("50");
    const all = [
      ...Object.values(record.deployed as Record<string, string>),
      record.oracle.dogeUsd,
      record.oracle.graduationOracle,
      ...Object.entries(record.vaults as Record<string, string>).filter(([k]) => k !== "monthlyCapUsd").map(([, v]) => v),
    ];
    expect(new Set(all.map((a) => a.toLowerCase())).size).to.equal(all.length);
    for (const a of all) expect(await ethers.provider.getCode(a), a).to.not.equal("0x");
    const verification = guards.readVerificationList(JSON.parse(fs.readFileSync(result.verificationPath, "utf8")));
    expect(guards.assertVerificationMatchesManifest(verification, record)).to.equal(true);
    expect(guards.entriesForBuild(verification, "bark").map((e: any) => e.name)).to.deep.equal([...guards.BARK_DEPLOYED_KEYS]);
  });

  it("the Bark contracts sit at the addresses planned from the deployer's nonce (launcher predicted before its periphery)", async function () {
    const plan = planBarkAddresses(admin, record.barkNonce0);
    expect(Object.keys(plan)).to.deep.equal([...BARK_PREDICTED_ORDER]);
    for (const key of BARK_PREDICTED_ORDER) {
      const deployed = key === "CommunityRewardsVault" ? record.vaults.community : record.deployed[key];
      expect(same(deployed, plan[key]), key).to.equal(true);
    }
  });

  it("constructor cross-checks and the t7 hand-off read-backs hold (launcher, plugin, splitter, escrow, choice vault, reserve lock, lens)", async function () {
    const d = record.deployed;
    const L = view(d.MwzBarkLauncher, [
      "function entryPoint() view returns (address)",
      "function algebraFactory() view returns (address)",
      "function wNative() view returns (address)",
      "function plugin() view returns (address)",
      "function oracle() view returns (address)",
      "function reserveLock() view returns (address)",
      "function choiceVault() view returns (address)",
      "function treasuryRouter() view returns (address)",
      "function minNativeUsd() view returns (uint256)",
      "function maxNativeUsd() view returns (uint256)",
      "function maxOracleAge() view returns (uint256)",
      "function PLUGIN_CONFIG() view returns (uint8)",
    ]);
    expect(same(await L.entryPoint(), BARKSWAP.customPoolEntryPoint)).to.equal(true);
    expect(same(await L.algebraFactory(), BARKSWAP.factory)).to.equal(true);
    expect(same(await L.wNative(), BARKSWAP.wdoge)).to.equal(true);
    expect(same(await L.plugin(), d.MwzBarkPlugin)).to.equal(true);
    expect(same(await L.oracle(), record.oracle.graduationOracle)).to.equal(true);
    expect(same(await L.reserveLock(), d.MwzBarkReserveLock)).to.equal(true);
    expect(same(await L.choiceVault(), d.MwzBarkCreatorChoiceVault)).to.equal(true);
    expect(same(await L.treasuryRouter(), d.MwzBarkFeeSplitter)).to.equal(true);
    expect(await L.minNativeUsd()).to.equal(10n ** 16n);
    expect(await L.maxNativeUsd()).to.equal(10n * 10n ** 18n);
    expect(await L.maxOracleAge()).to.equal(3600n);
    const P = view(d.MwzBarkPlugin, [
      "function launcher() view returns (address)",
      "function wNative() view returns (address)",
      "function creatorEscrow() view returns (address)",
      "function choiceVault() view returns (address)",
      "function PLUGIN_CONFIG() view returns (uint8)",
    ]);
    expect(same(await P.launcher(), d.MwzBarkLauncher)).to.equal(true);
    expect(same(await P.wNative(), BARKSWAP.wdoge)).to.equal(true);
    expect(same(await P.creatorEscrow(), d.MwzBarkCreatorEscrow), "plugin.creatorEscrow() == escrow (audit I-11)").to.equal(true);
    expect(same(await P.choiceVault(), d.MwzBarkCreatorChoiceVault)).to.equal(true);
    expect(await P.PLUGIN_CONFIG()).to.equal(await L.PLUGIN_CONFIG());
    const launcherOf = (a: string) => view(a, ["function launcher() view returns (address)"]).launcher();
    expect(same(await launcherOf(d.MwzBarkFeeSplitter), d.MwzBarkLauncher), "splitter.launcher() (the launcher does not check it)").to.equal(true);
    expect(same(await launcherOf(d.MwzBarkCreatorEscrow), d.MwzBarkLauncher), "escrow.launcher() (nothing on chain checks it)").to.equal(true);
    expect(same(await launcherOf(d.MwzBarkReserveLock), d.MwzBarkLauncher)).to.equal(true);
    expect(same(await launcherOf(d.MwzBarkCreatorChoiceVault), d.MwzBarkLauncher)).to.equal(true);
    expect(same(await launcherOf(d.MwzBarkLaunchLens), d.MwzBarkLauncher)).to.equal(true);
    expect(same(await view(d.MwzBarkLaunchLens, ["function plugin() view returns (address)"]).plugin(), d.MwzBarkPlugin)).to.equal(true);
    // both libraries are deployed and linked into the launcher (DELEGATECALL targets in its runtime code)
    const launcherCode = (await ethers.provider.getCode(d.MwzBarkLauncher)).toLowerCase();
    for (const lib of ["MwzBarkLaunchLib", "MwzBarkFeeBooks"]) {
      expect(await ethers.provider.getCode(d[lib]), lib).to.not.equal("0x");
      expect(launcherCode.includes(d[lib].slice(2).toLowerCase()), `${lib} linked into the launcher`).to.equal(true);
    }
    // gen-8 wiring of the reused vaults: the splitter is the community vault's router (the only depositor)
    expect(same(await view(record.vaults.community, ["function router() view returns (address)"]).router(), d.MwzBarkFeeSplitter)).to.equal(true);
    const O2 = view(record.oracle.graduationOracle, ["function priceFeed() view returns (address)", "function maxPriceAge() view returns (uint256)"]);
    expect(same(await O2.priceFeed(), record.oracle.dogeUsd)).to.equal(true);
    expect(await O2.maxPriceAge()).to.equal(3600n);
    const O1 = view(record.oracle.dogeUsd, ["function updater() view returns (address)", "function localRehearsal() view returns (bool)"]);
    expect(same(await O1.updater(), guards.DOGEOS_TESTNET_ROLES.oracleUpdater)).to.equal(true);
    expect(await O1.localRehearsal()).to.equal(false);
  });

  it("every role per B9: deployer owns/administers everything, the route authority signs creates, the operator runs route / claimRouter / buyback / holder batches, the keeper holds nothing", async function () {
    const d = record.deployed;
    const v = record.vaults;
    const a = async (address: string, fn: string) => ethers.getAddress(await view(address, [`function ${fn}() view returns (address)`])[fn]());
    const roles: Array<[string, string, string]> = [
      ["launcher.owner", await a(d.MwzBarkLauncher, "owner"), admin],
      ["launcher.pendingOwner", await a(d.MwzBarkLauncher, "pendingOwner"), ethers.ZeroAddress],
      ["launcher.createSigner", await a(d.MwzBarkLauncher, "createSigner"), routeAuthority],
      ["launcher.pendingRouter", await a(d.MwzBarkLauncher, "pendingRouter"), ethers.ZeroAddress],
      ["splitter.admin", await a(d.MwzBarkFeeSplitter, "admin"), admin],
      ["splitter.operator (route, and the launcher's claimRouter operator via F4)", await a(d.MwzBarkFeeSplitter, "operator"), operator],
      ["choiceVault.admin", await a(d.MwzBarkCreatorChoiceVault, "admin"), admin],
      ["choiceVault.operator (buyback, executeHolderBatch)", await a(d.MwzBarkCreatorChoiceVault, "operator"), operator],
      ["choiceVault.holderDistributor", await a(d.MwzBarkCreatorChoiceVault, "holderDistributor"), v.holderDistributor],
      ["holderDistributor.owner", await a(v.holderDistributor, "owner"), admin],
      ["holderDistributor.batchOperator", await a(v.holderDistributor, "batchOperator"), d.MwzBarkCreatorChoiceVault],
      ["community.admin", await a(v.community, "admin"), admin],
      ["community.rewardDistributor", await a(v.community, "rewardDistributor"), v.airdropDistributor],
      ["community.airdropOperator", await a(v.community, "airdropOperator"), record.airdropOperator],
      ["airdropDistributor.owner", await a(v.airdropDistributor, "owner"), admin],
      ["airdropDistributor.batchOperator", await a(v.airdropDistributor, "batchOperator"), v.community],
      ["weekly.multisig", await a(v.weekly, "multisig"), admin],
      ["monthly.multisig", await a(v.monthly, "multisig"), admin],
      ["monthly.oracle", await a(v.monthly, "oracle"), record.oracle.graduationOracle],
      ["monthly.charityTreasury", await a(v.monthly, "charityTreasury"), v.charity],
      ["charity.multisig", await a(v.charity, "multisig"), admin],
      ["recruiter.admin", await a(v.recruiter, "admin"), admin],
      ["protocol.admin", await a(v.protocol, "admin"), admin],
    ];
    for (const [label, got, want] of roles) expect(got, label).to.equal(ethers.getAddress(want));
    expect(same(record.airdropOperator, admin), "airdrop operator: the admin, as gen-8 testnet").to.equal(true);
    expect(await view(d.MwzBarkCreatorChoiceVault, ["function operatorPaused() view returns (bool)"]).operatorPaused()).to.equal(false);
    expect(await view(d.MwzBarkCreatorChoiceVault, ["function holderBatchDelay() view returns (uint256)"]).holderBatchDelay()).to.equal(86_400n);
    const keeper = ethers.getAddress(guards.DOGEOS_TESTNET_ROLES.graduationKeeper);
    for (const [label, got] of roles) expect(got, `the keeper holds no role (${label})`).to.not.equal(keeper);
    for (const other of [admin, routeAuthority, guards.DOGEOS_TESTNET_ROLES.oracleUpdater, keeper]) {
      expect(same(operator, other), `operator differs from ${other}`).to.equal(false);
    }
  });

  it("readBackDogeosBarkStack passes on the deployed stack and fails on a manifest that names another operator or vault", async function () {
    const checks = await readBackDogeosBarkStack(record, { provider: ethers.provider, expectCreatePaused: true });
    expect(checks).to.be.greaterThan(60);
    await rejects(readBackDogeosBarkStack({ ...record, operator: admin }, { provider: ethers.provider }), /operator/);
    await rejects(
      readBackDogeosBarkStack({ ...record, vaults: { ...record.vaults, protocol: record.vaults.recruiter } }, { provider: ethers.provider }),
      /protocolRevenueVault/,
    );
    await rejects(readBackDogeosBarkStack(record, { provider: ethers.provider, expectCreatePaused: false }), /createPaused/);
  });

  it("the verification JSON is exact: every creation transaction is the artifact bytecode (libraries linked) plus its listed constructor arguments", async function () {
    const list = guards.readVerificationList(JSON.parse(fs.readFileSync(path.join(tmp, "dogeos-testnet-contracts.json"), "utf8")));
    expect(list.length).to.equal(19);
    for (const e of list) {
      const tx = (record.txs as any[]).find((t) => t.address && same(t.address, e.address));
      expect(tx, `${e.name}: a recorded creation transaction`).to.not.equal(undefined);
      const sent = await ethers.provider.getTransaction(tx.hash);
      const artifact = loadStackArtifact(e.build, e.contract);
      const bytecode = linkBytecode(artifact, e.libraries ?? {});
      const iface = new ethers.Interface(artifact.abi.filter((f: any) => f.type === "constructor"));
      const expected = ethers.concat([bytecode, iface.encodeDeploy(e.args)]);
      expect(sent!.data.toLowerCase(), `${e.name}: init code == artifact + listed args`).to.equal(expected.toLowerCase());
      expect(sent!.to, e.name).to.equal(null);
    }
  });

  it("gas: every deploy and wiring transaction fits Chikyū's 10M block", async function () {
    expect((record.txs as any[]).length).to.be.greaterThan(25);
    for (const t of record.txs) {
      const receipt = await ethers.provider.getTransactionReceipt(t.hash);
      expect(receipt!.status, t.label).to.equal(1);
      expect(receipt!.gasUsed, t.label).to.be.lessThan(BLOCK_GAS);
      expect(receipt!.gasUsed.toString(), t.label).to.equal(t.gasUsed);
    }
    const launcher = (record.txs as any[]).find((t) => t.label === "MwzBarkLauncher");
    console.log(`      launcher deploy gas ${launcher.gasUsed}; ${record.txs.length} transactions`);
  });

  it("the airdrop pot is wired exactly as the planner wires it (make-airdrop-setup-calls.mjs), with no batch authorized at deploy", async function () {
    const { airdropWiringCalls } = await esm("scripts/make-airdrop-setup-calls.mjs");
    const planned = airdropWiringCalls({ vault: record.vaults.community, distributor: record.vaults.airdropDistributor, operator: record.airdropOperator });
    const sent = (record.wiringSent as string[]).filter((w) => /CommunityRewardsVault|RewardDistributor \(airdrop\)/.test(w));
    expect(sent).to.deep.equal(planned.map((c: any) => `${c.contract === "RewardDistributor" ? "RewardDistributor (airdrop)" : c.contract}.${c.fn}`));
    expect((record.wiringSent as string[]).some((w) => /authorizeBatch/.test(w))).to.equal(false);
  });

  it("refuses a second deploy over its own outputs before sending anything", async function () {
    const nonce = await ethers.provider.getTransactionCount(admin);
    await rejects(runDogeosTestnetDeploy({ fetchImpl: fakeFetch, log: () => {} }), /already exist/);
    expect(await ethers.provider.getTransactionCount(admin)).to.equal(nonce);
  });

  it("lands paused; activation needs its own token, then opens create and reads everything back", async function () {
    const L = view(record.deployed.MwzBarkLauncher, ["function createPaused() view returns (bool)"]);
    expect(await L.createPaused()).to.equal(true);
    await rejects(runDogeosTestnetActivate({ log: () => {} }), /DOGEOS_TESTNET_ACTIVATE_BROADCAST=I_HAVE_FOUNDER_GO/);
    process.env.DOGEOS_TESTNET_ACTIVATE_BROADCAST = "I_HAVE_FOUNDER_GO";
    const result = await runDogeosTestnetActivate({ log: () => {} });
    expect(result.mode).to.equal("chikyu-fork");
    expect(same(result.launcher, record.deployed.MwzBarkLauncher)).to.equal(true);
    expect(result.calls).to.deep.equal(["setCreatePaused(false)"]);
    expect(await L.createPaused()).to.equal(false);
    expect(await readBackDogeosBarkStack(record, { provider: ethers.provider, expectCreatePaused: false })).to.be.greaterThan(60);
    await rejects(runDogeosTestnetActivate({ log: () => {} }), /already open/);
  });
});
