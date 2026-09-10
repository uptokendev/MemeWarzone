import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  assertArenaV2DeploymentTarget,
  envNamesFor,
  defaultArenaV2DeploymentFile,
} = require("./lib/arenaV2DeploymentPolicy.cjs");

const deploy = fs.readFileSync(new URL("./deployArenaWarPoolTreasuryV2.ts", import.meta.url), "utf8");
const attest = fs.readFileSync(new URL("./verifyArenaWarPoolTreasuryV2Deployment.ts", import.meta.url), "utf8");
const warPool = fs.readFileSync(new URL("../contracts/ArenaWarPoolTreasuryV2.sol", import.meta.url), "utf8");
const league = fs.readFileSync(new URL("../contracts/PostGradLeagueTreasuryV2.sol", import.meta.url), "utf8");

test("deployment policy accepts BSC97, Robinhood46630, and preserves BSC56", () => {
  assert.doesNotThrow(() => assertArenaV2DeploymentTarget(97, "bscTestnet"));
  assert.doesNotThrow(() => assertArenaV2DeploymentTarget(46630, "robinhoodTestnet"));
  assert.doesNotThrow(() => assertArenaV2DeploymentTarget(56, "bscMainnet"));
});

test("deployment policy rejects Robinhood mainnet 4663 and all unknown/wrong network bindings", () => {
  assert.throws(() => assertArenaV2DeploymentTarget(4663, "robinhoodMainnet"), /not activated/i);
  assert.throws(() => assertArenaV2DeploymentTarget(1, "mainnet"), /restricted/i);
  assert.throws(() => assertArenaV2DeploymentTarget(97, "robinhoodTestnet"), /must use Hardhat network bscTestnet/i);
  assert.throws(() => assertArenaV2DeploymentTarget(46630, "bscTestnet"), /must use Hardhat network robinhoodTestnet/i);
});

test("local deployment remains explicitly opt-in", () => {
  assert.throws(() => assertArenaV2DeploymentTarget(31337, "hardhat"), /requires ARENA_V2_ALLOW_LOCAL=1/);
  assert.doesNotThrow(() => assertArenaV2DeploymentTarget(31337, "hardhat", { allowLocal: true }));
  assert.doesNotThrow(() => assertArenaV2DeploymentTarget(31337, "localhost", { allowLocal: true }));
});

test("Robinhood 46630 receiver/signing envs are strict and never fall back to generic/BSC inputs", () => {
  assert.deepEqual(envNamesFor(46630, "ARENA_BOOST_QUOTE_SIGNER_ADDRESS"), [
    "ARENA_BOOST_QUOTE_SIGNER_ADDRESS_46630",
  ]);
  assert.deepEqual(envNamesFor(46630, "ARENA_PROTOCOL_RECEIVER"), ["ARENA_PROTOCOL_RECEIVER_46630"]);
  assert.deepEqual(envNamesFor(46630, "ARENA_POSTGRAD_LEAGUE_TREASURY_V2_ADDRESS"), [
    "ARENA_POSTGRAD_LEAGUE_TREASURY_V2_ADDRESS_46630",
  ]);
  assert.deepEqual(envNamesFor(46630, "ARENA_MONTHLY_MWL_RECEIVER"), ["ARENA_MONTHLY_MWL_RECEIVER_46630"]);
  assert.deepEqual(envNamesFor(46630, "ARENA_QUARTERLY_RESERVE_RECEIVER"), [
    "ARENA_QUARTERLY_RESERVE_RECEIVER_46630",
  ]);

  assert.deepEqual(envNamesFor(97, "ARENA_PROTOCOL_RECEIVER"), [
    "ARENA_PROTOCOL_RECEIVER_97",
    "ARENA_PROTOCOL_RECEIVER",
  ]);
});

test("durable deployment paths are chain-specific", () => {
  assert.equal(defaultArenaV2DeploymentFile(97), "deployments/arena/war-pool-treasury-v2.bsc97.json");
  assert.equal(
    defaultArenaV2DeploymentFile(46630),
    "deployments/arena/war-pool-treasury-v2.robinhood46630.json",
  );
  assert.equal(defaultArenaV2DeploymentFile(56), "deployments/arena/war-pool-treasury-v2.bsc56.json");
});

test("contract generations and founder-locked economics are unchanged", () => {
  assert.match(warPool, /uint256 public constant GENERATION = 2;/);
  assert.match(warPool, /uint256 public constant ENTRY_LEAGUE_BPS = 2_000;/);
  assert.match(warPool, /uint256 public constant ENTRY_PROTOCOL_BPS = 500;/);
  assert.match(warPool, /uint256 public constant BOOST_PROTOCOL_BPS = 1_000;/);
  assert.match(league, /uint256 public constant GENERATION = 2;/);
  assert.match(league, /uint256 public constant MONTHLY_BPS = 6_000;/);
});

test("deployment tool uses existing contracts, authorizes League source, and writes full evidence", () => {
  assert.match(deploy, /getContractFactory\("PostGradLeagueTreasuryV2"\)/);
  assert.match(deploy, /getContractFactory\("ArenaWarPoolTreasuryV2"\)/);
  assert.match(deploy, /league\.setSource\(warPoolAddress, true\)/);
  assert.match(deploy, /runtimeBytecodeHash: ethers\.keccak256\(warPoolCode\)/);
  assert.match(deploy, /deploymentBlock:/);
  assert.match(deploy, /configurationTransactions:/);
  assert.match(deploy, /leagueSourceAuthorization:/);
  assert.match(deploy, /leagueOwnershipTransfer:/);
  assert.match(deploy, /ARENA_BOOST_QUOTE_SIGNER_ADDRESS_46630/);
  assert.match(deploy, /ARENA_PROTOCOL_RECEIVER_46630/);
  assert.match(deploy, /ARENA_POSTGRAD_LEAGUE_TREASURY_V2_ADDRESS_46630/);
  assert.match(deploy, /ARENA_MONTHLY_MWL_RECEIVER_46630/);
  assert.match(deploy, /ARENA_QUARTERLY_RESERVE_RECEIVER_46630/);
});

test("read-only attestation independently checks bytecode, identity, authorization and economics", () => {
  assert.match(attest, /getCode\(war\.address\)/);
  assert.match(attest, /keccak256\(warCode\)/);
  assert.match(attest, /warPool\.GENERATION\(\)/);
  assert.match(attest, /league\.GENERATION\(\)/);
  assert.match(attest, /league\.authorizedSources\(war\.address\)/);
  assert.match(attest, /warPool\.ENTRY_LEAGUE_BPS\(\)/);
  assert.match(attest, /warPool\.ENTRY_PROTOCOL_BPS\(\)/);
  assert.match(attest, /warPool\.BOOST_PROTOCOL_BPS\(\)/);
  assert.match(attest, /getTransactionReceipt/);
});

test("T2-PRE deployment tooling contains no Solana or Tournament application implementation", () => {
  assert.doesNotMatch(deploy, /@solana|Connection\(|PublicKey\(|arenaTournaments\.js|depositBuyIn\(/);
  assert.doesNotMatch(attest, /@solana|Connection\(|PublicKey\(|arenaTournaments\.js|depositBuyIn\(/);
});
