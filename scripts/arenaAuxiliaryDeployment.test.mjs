import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  assertArenaAuxiliaryTarget,
  envNameFor,
  confirmTokenFor,
  defaultArenaAuxiliaryFile,
} = require("./lib/arenaAuxiliaryDeploymentPolicy.cjs");

const deploy = fs.readFileSync(new URL("./deployArenaAuxiliaryBundle.ts", import.meta.url), "utf8");
const verify = fs.readFileSync(new URL("./verifyArenaAuxiliaryBundle.ts", import.meta.url), "utf8");
const prize = fs.readFileSync(new URL("../contracts/EventPrizeVaultV1.sol", import.meta.url), "utf8");
const sponsor = fs.readFileSync(new URL("../contracts/WarzoneSponsorshipRouterV1.sol", import.meta.url), "utf8");
const envTemplate = fs.readFileSync(new URL("../config/arena-auxiliary.env.example", import.meta.url), "utf8");

test("auxiliary policy binds all supported EVM chains to exact Hardhat networks", () => {
  assert.doesNotThrow(() => assertArenaAuxiliaryTarget(56, "bscMainnet"));
  assert.doesNotThrow(() => assertArenaAuxiliaryTarget(97, "bscTestnet"));
  assert.doesNotThrow(() => assertArenaAuxiliaryTarget(4663, "robinhoodMainnet"));
  assert.doesNotThrow(() => assertArenaAuxiliaryTarget(46630, "robinhoodTestnet"));
  assert.throws(() => assertArenaAuxiliaryTarget(56, "robinhoodMainnet"), /bscMainnet/);
  assert.throws(() => assertArenaAuxiliaryTarget(4663, "robinhoodTestnet"), /robinhoodMainnet/);
  assert.throws(() => assertArenaAuxiliaryTarget(1, "mainnet"), /restricted/i);
});

test("local auxiliary deployment remains explicit opt-in", () => {
  assert.throws(() => assertArenaAuxiliaryTarget(31337, "hardhat"), /ARENA_AUX_ALLOW_LOCAL=1/);
  assert.doesNotThrow(() => assertArenaAuxiliaryTarget(31337, "hardhat", { allowLocal: true }));
  assert.doesNotThrow(() => assertArenaAuxiliaryTarget(31337, "localhost", { allowLocal: true }));
});

test("all non-local authority and receiver inputs are exact-chain suffixed", () => {
  for (const chainId of [56, 97, 4663, 46630]) {
    for (const base of [
      "ARENA_AUX_EXPECTED_DEPLOYER",
      "ARENA_AUX_OWNER",
      "ARENA_AUX_VOTE_OWNER",
      "ARENA_SPONSORSHIP_QUOTE_SIGNER",
      "ARENA_MARKETING_RECEIVER",
      "ARENA_PROTOCOL_RECEIVER",
      "VOTE_TREASURY_ADDRESS",
    ]) {
      assert.equal(envNameFor(chainId, base), `${base}_${chainId}`);
    }
  }
});

test("confirmation tokens and durable manifests are chain-specific", () => {
  assert.equal(confirmTokenFor(56), "DEPLOY_ARENA_AUX_56");
  assert.equal(confirmTokenFor(97), "DEPLOY_ARENA_AUX_97");
  assert.equal(confirmTokenFor(4663), "DEPLOY_ARENA_AUX_4663");
  assert.equal(confirmTokenFor(46630), "DEPLOY_ARENA_AUX_46630");
  assert.equal(defaultArenaAuxiliaryFile(56), "deployments/arena/auxiliary-bundle.bsc56.json");
  assert.equal(defaultArenaAuxiliaryFile(97), "deployments/arena/auxiliary-bundle.bsc97.json");
  assert.equal(defaultArenaAuxiliaryFile(4663), "deployments/arena/auxiliary-bundle.robinhood4663.json");
  assert.equal(defaultArenaAuxiliaryFile(46630), "deployments/arena/auxiliary-bundle.robinhood46630.json");
});

test("existing contract generations and sponsorship economics are unchanged", () => {
  assert.match(prize, /uint256 public constant GENERATION = 1;/);
  assert.match(sponsor, /uint256 public constant GENERATION = 1;/);
  assert.match(sponsor, /uint256 public constant EVENT_BPS = 7_000;/);
  assert.match(sponsor, /uint256 public constant MARKETING_BPS = 2_000;/);
  assert.match(sponsor, /uint256 public constant BPS_DENOM = 10_000;/);
  assert.match(sponsor, /BPS_DENOM - EVENT_BPS - MARKETING_BPS/);
});

test("deploy bundle is fresh, dark, non-overwriting and collision-aware", () => {
  assert.match(deploy, /getContractFactory\("EventPrizeVaultV1"\)/);
  assert.match(deploy, /getContractFactory\("WarzoneSponsorshipRouterV1"\)/);
  assert.match(deploy, /getContractFactory\("UPVoteTreasury"\)/);
  assert.match(deploy, /ARENA_AUX_DEPLOY_CONFIRM/);
  assert.match(deploy, /confirmTokenFor\(chainId\)/);
  assert.match(deploy, /fs\.existsSync\(outputFile\)/);
  assert.match(deploy, /flag: local \? "w" : "wx"/);
  assert.match(deploy, /setRouter\(sponsorshipAddress\)/);
  assert.match(deploy, /setDepositsPaused\(true\)/);
  assert.match(deploy, /setPaymentsPaused\(true\)/);
  assert.match(deploy, /Arena vote treasury must be distinct from the launchpad vote treasury/);
  assert.match(deploy, /ROBINHOOD_MAINNET_DEPLOYER_PRIVATE_KEY/);
  assert.match(deploy, /ROBINHOOD_TESTNET_DEPLOYER_PRIVATE_KEY/);
  assert.doesNotMatch(deploy, /getContractAt\("UPVoteTreasury"/);
});

test("deployment artifact records bytecode, receipts, identities, economics and dark activation", () => {
  assert.match(deploy, /runtimeBytecodeHash: ethers\.keccak256\(prizeCode\)/);
  assert.match(deploy, /runtimeBytecodeHash: ethers\.keccak256\(sponsorCode\)/);
  assert.match(deploy, /runtimeBytecodeHash: ethers\.keccak256\(voteCode\)/);
  assert.match(deploy, /eventPrizeVaultRouter:/);
  assert.match(deploy, /eventPrizeVaultPause:/);
  assert.match(deploy, /sponsorshipPaymentsPause:/);
  assert.match(deploy, /sponsorship: \{ eventBps: 7_000, marketingBps: 2_000, protocolBps: 1_000 \}/);
  assert.match(deploy, /dark: true/);
  assert.match(deploy, /eventReceiversConfigured: false/);
  assert.match(deploy, /sponsorshipEventsEnabled: false/);
});

test("read-only verifier checks bytecode, receipts, identity, distinct treasury and paused state", () => {
  assert.match(verify, /getCode\(prize\.address\)/);
  assert.match(verify, /keccak256\(prizeCode\)/);
  assert.match(verify, /prizeVault\.depositsPaused\(\)/);
  assert.match(verify, /sponsorship\.paymentsPaused\(\)/);
  assert.match(verify, /sponsorship\.EVENT_BPS\(\)/);
  assert.match(verify, /sponsorship\.MARKETING_BPS\(\)/);
  assert.match(verify, /voteTreasury\.feeReceiver\(\)/);
  assert.match(verify, /Arena vote treasury collides with launchpad vote treasury/);
  assert.match(verify, /getTransactionReceipt/);
});

test("operator template exposes only suffixed chain inputs and no deployed addresses", () => {
  for (const chainId of [56, 97, 4663, 46630]) {
    for (const base of [
      "ARENA_AUX_EXPECTED_DEPLOYER",
      "ARENA_AUX_OWNER",
      "ARENA_AUX_VOTE_OWNER",
      "ARENA_SPONSORSHIP_QUOTE_SIGNER",
      "ARENA_MARKETING_RECEIVER",
      "ARENA_PROTOCOL_RECEIVER",
    ]) {
      assert.match(envTemplate, new RegExp(`^${base}_${chainId}=$`, "m"));
    }
  }
  assert.doesNotMatch(envTemplate, /^ARENA_(?:AUX|SPONSORSHIP|MARKETING|PROTOCOL).*=(?:0x[0-9a-fA-F]{40})$/m);
  assert.match(envTemplate, /depositsPaused = true/);
  assert.match(envTemplate, /paymentsPaused = true/);
});
