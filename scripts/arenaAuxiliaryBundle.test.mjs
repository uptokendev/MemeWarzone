import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const deploy = fs.readFileSync(new URL("./deployArenaAuxiliaryBundle.ts", import.meta.url), "utf8");
const verify = fs.readFileSync(new URL("./verifyArenaAuxiliaryBundle.ts", import.meta.url), "utf8");
const vault = fs.readFileSync(new URL("../contracts/EventPrizeVaultV1.sol", import.meta.url), "utf8");
const router = fs.readFileSync(new URL("../contracts/WarzoneSponsorshipRouterV1.sol", import.meta.url), "utf8");
const vote = fs.readFileSync(new URL("../contracts/UPVoteTreasury.sol", import.meta.url), "utf8");

test("bundle targets BNB and Robinhood production/staging chain bindings", () => {
  for (const [chain, network] of [[56,"bscMainnet"],[97,"bscTestnet"],[4663,"robinhoodMainnet"],[46630,"robinhoodTestnet"]]) {
    assert.match(deploy, new RegExp(`${chain}: "${network}"`));
    assert.match(verify, new RegExp(`${chain}: "${network}"`));
  }
});

test("all auxiliary authority and receiver inputs are chain suffixed", () => {
  for (const key of [
    "ARENA_AUX_OWNER_",
    "ARENA_SPONSORSHIP_QUOTE_SIGNER_ADDRESS_",
    "ARENA_SPONSORSHIP_MARKETING_RECEIVER_",
    "ARENA_PROTOCOL_RECEIVER_",
    "ARENA_VOTE_FEE_RECEIVER_",
    "VOTE_TREASURY_ADDRESS_",
  ]) assert.match(deploy, new RegExp(key));
});

test("bundle deploys exactly the existing vault, sponsorship router and a distinct Arena vote treasury", () => {
  assert.match(deploy, /getContractFactory\("EventPrizeVaultV1"/);
  assert.match(deploy, /getContractFactory\("WarzoneSponsorshipRouterV1"/);
  assert.match(deploy, /getContractFactory\("UPVoteTreasury"/);
  assert.match(deploy, /launchpad vote treasury/i);
  assert.match(deploy, /unexpectedly collides/);
});

test("deployment is dark by default and artifact cannot be overwritten", () => {
  assert.match(deploy, /refusing to overwrite/);
  assert.match(deploy, /setPaymentsPaused\(true\)/);
  assert.match(deploy, /setAsset\(ethers\.ZeroAddress, false, 0\)/);
  assert.match(deploy, /activation: "dark"/);
});

test("verifier proves bytecode, wiring, economics and receipts", () => {
  assert.match(verify, /runtimeBytecodeHash/);
  assert.match(verify, /vault\.router\(\)/);
  assert.match(verify, /router\.eventPrizeVault\(\)/);
  assert.match(verify, /router\.EVENT_BPS\(\)/);
  assert.match(verify, /router\.MARKETING_BPS\(\)/);
  assert.match(verify, /vote\.feeReceiver\(\)/);
  assert.match(verify, /getTransactionReceipt/);
});

test("existing contract economics/generations remain unchanged", () => {
  assert.match(vault, /GENERATION = 1/);
  assert.match(router, /GENERATION = 1/);
  assert.match(router, /EVENT_BPS = 7_000/);
  assert.match(router, /MARKETING_BPS = 2_000/);
  assert.match(vote, /contract UPVoteTreasury/);
});
