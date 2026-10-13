/**
 * CREATE ignores chain id, so one deployer nonce is the same address on 56 and 4663.
 * Signing batches are bound to one chain's deploy record and refused on the other.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import {
  AIRDROP_OPERATOR,
  CREATE_SIGNER,
  SAFE,
  VAULT_OPERATOR,
  buildDeployment,
  chainById,
  postflightBatches,
  writeBatchSet,
  writeSigningBatches,
} from "./gen8-mainnet-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..", "..");
const BEEF = "0xBEEF00000000000000000000000000000000BEEF";

function fakeAddress(n) {
  return ethers.getAddress(`0x${n.toString(16).padStart(40, "0")}`);
}

function recordFor(chainId, base) {
  const chain = chainById(chainId);
  const keys = ["swapSim", "factory", "community", "hook", "splitter", "vault", "lock", "launcher", "lens", "escrow", "holder", "airdrop"];
  const addresses = {};
  keys.forEach((key, i) => {
    addresses[key] = key === "factory" && !chain.displayFactory ? ethers.ZeroAddress : fakeAddress(base + i + 1);
  });
  return {
    kind: "mainnet-gen8",
    chainId,
    status: "deployed-create-paused",
    deployer: fakeAddress(base + 100),
    admin: SAFE,
    createSigner: CREATE_SIGNER,
    addresses,
  };
}

test("the same deployer and nonce share a CREATE address across 56 and 4663", () => {
  const bsc = buildDeployment(chainById(56), BEEF, 0);
  const rh = buildDeployment(chainById(4663), BEEF, 0);
  assert.equal(bsc.chain.id, 56);
  assert.equal(rh.chain.id, 4663);
  assert.notEqual(bsc.chain.id, rh.chain.id);
  // BNB choice vault is deployer nonce 6. Robinhood launcher is deployer nonce 6.
  // CREATE does not include the chain id, so the bytes match. The hook does not:
  // it is CREATE2 and its init code includes that chain's PoolManager.
  assert.equal(bsc.addr.vault, rh.addr.launcher);
  assert.notEqual(bsc.addr.launcher, rh.addr.launcher);
  assert.notEqual(bsc.addr.hook, rh.addr.hook);
  const shared = Object.keys(bsc.addr).filter((key) => {
    const other = Object.entries(rh.addr).find(([, value]) => value === bsc.addr[key]);
    return other && key !== "hookSalt";
  });
  assert.ok(shared.includes("vault"));
});

test("each chain's signing batch uses that chain's id and that chain's record", () => {
  const bscRecord = recordFor(56, 0x1000);
  const rhRecord = recordFor(4663, 0x2000);
  const bscDir = fs.mkdtempSync(path.join(os.tmpdir(), "mwz-gen8-bsc-"));
  const rhDir = fs.mkdtempSync(path.join(os.tmpdir(), "mwz-gen8-rh-"));
  writeSigningBatches(bscRecord, bscDir);
  writeSigningBatches(rhRecord, rhDir);
  const read = (dir) => Object.fromEntries(["setup", "opening-day", "set-create-signer"].map((slug) => [
    slug,
    JSON.parse(fs.readFileSync(path.join(dir, `mainnet.gen8.${slug}.safe-batch.json`), "utf8")),
  ]));
  const bscBatches = read(bscDir);
  const rhBatches = read(rhDir);
  for (const batch of Object.values(bscBatches)) assert.equal(batch.chainId, "56");
  for (const batch of Object.values(rhBatches)) assert.equal(batch.chainId, "4663");
  const bscTargets = new Set(bscBatches.setup.transactions.map((tx) => ethers.getAddress(tx.to)));
  const rhTargets = new Set(rhBatches.setup.transactions.map((tx) => ethers.getAddress(tx.to)));
  assert.ok(bscTargets.has(bscRecord.addresses.vault));
  assert.ok(rhTargets.has(rhRecord.addresses.vault));
  assert.equal(bscTargets.has(rhRecord.addresses.vault), false);
  assert.equal(rhTargets.has(bscRecord.addresses.vault), false);
  assert.equal(fs.existsSync(path.join(bscDir, "mainnet.gen8.payout-roles.json")), false);
  assert.equal(fs.existsSync(path.join(rhDir, "mainnet.gen8.roles.safe-batch.json")), false);
  postflightBatches(bscRecord, bscBatches);
  postflightBatches(rhRecord, rhBatches);
  assert.throws(() => postflightBatches(bscRecord, rhBatches), /chainId|record address|deploy record/);
  assert.throws(() => postflightBatches(rhRecord, bscBatches), /chainId|record address|deploy record/);

  const moved = structuredClone(bscBatches);
  moved.setup.transactions[0].to = bscRecord.addresses.splitter;
  assert.throws(() => postflightBatches(bscRecord, moved), /not the record address/);

  const otherChain = structuredClone(bscBatches);
  otherChain.setup.chainId = "4663";
  assert.throws(() => postflightBatches(bscRecord, otherChain), /chainId 4663 is not 56/);

  const edited = structuredClone(bscBatches);
  edited.setup.transactions[0].data = "0xdead";
  assert.throws(() => postflightBatches(bscRecord, edited), /data does not match/);

  assert.throws(
    () => writeSigningBatches({ ...bscRecord, rehearsal: true }, bscDir),
    /rehearsal record/,
  );
  assert.throws(
    () => writeSigningBatches({ ...bscRecord, doNotSign: true }, bscDir),
    /rehearsal record/,
  );
  assert.throws(
    () => writeSigningBatches({ ...rhRecord, addresses: { ...rhRecord.addresses, factory: bscRecord.addresses.factory } }, rhDir),
    /display factory/,
  );

  const rehearsalDir = fs.mkdtempSync(path.join(os.tmpdir(), "mwz-gen8-rehearsal-"));
  const plan = buildDeployment(chainById(56), BEEF, 0);
  assert.throws(() => writeBatchSet(rehearsalDir, plan, { rehearsal: false }), /after the real deploy/);
  writeBatchSet(rehearsalDir, plan, { rehearsal: true });
  const rehearsal = JSON.parse(fs.readFileSync(path.join(rehearsalDir, "mainnet.gen8.setup.safe-batch.json"), "utf8"));
  assert.equal(rehearsal.chainId, "56");
  assert.match(rehearsal.meta.description, /Do not sign/);
  assert.equal(fs.existsSync(path.join(rehearsalDir, "mainnet.gen8.payout-roles.json")), false);
  assert.ok(rehearsal.transactions.some((tx) => ethers.getAddress(tx.to) === plan.addr.vault));
  assert.ok(rehearsal.transactions.some((tx) => Object.values(tx.contractInputsValues).includes(VAULT_OPERATOR)));
  assert.ok(rehearsal.transactions.some((tx) => Object.values(tx.contractInputsValues).includes(AIRDROP_OPERATOR)));
});

function recordFromPlan(plan) {
  return {
    kind: "mainnet-gen8",
    chainId: plan.chain.id,
    status: "deployed-create-paused",
    deployer: plan.deployer,
    admin: SAFE,
    createSigner: CREATE_SIGNER,
    addresses: Object.fromEntries(
      ["swapSim", "factory", "community", "hook", "splitter", "vault", "lock", "launcher", "lens", "escrow", "holder", "airdrop"].map((key) => [key, plan.addr[key]]),
    ),
  };
}

test("a shared CREATE address is signed only on its own chain", () => {
  const bsc = buildDeployment(chainById(56), BEEF, 0);
  const rh = buildDeployment(chainById(4663), BEEF, 0);
  const bscRecord = recordFromPlan(bsc);
  const rhRecord = recordFromPlan(rh);
  const bscDir = fs.mkdtempSync(path.join(os.tmpdir(), "mwz-gen8-collide-bsc-"));
  const rhDir = fs.mkdtempSync(path.join(os.tmpdir(), "mwz-gen8-collide-rh-"));
  writeSigningBatches(bscRecord, bscDir);
  writeSigningBatches(rhRecord, rhDir);
  const load = (dir, slug) => JSON.parse(fs.readFileSync(path.join(dir, `mainnet.gen8.${slug}.safe-batch.json`), "utf8"));
  const bscSetup = load(bscDir, "setup");
  const rhSetup = load(rhDir, "setup");
  const rhOpen = load(rhDir, "opening-day");
  assert.equal(bscSetup.chainId, "56");
  assert.equal(rhSetup.chainId, "4663");
  assert.equal(rhOpen.chainId, "4663");
  assert.ok(bscSetup.transactions.some((tx) => ethers.getAddress(tx.to) === bsc.addr.vault));
  assert.equal(bsc.addr.vault, rh.addr.launcher);
  assert.equal(rhSetup.transactions.some((tx) => ethers.getAddress(tx.to) === rh.addr.launcher), false);
  assert.ok(rhSetup.transactions.some((tx) => ethers.getAddress(tx.to) === rh.addr.vault));
  assert.ok(rhOpen.transactions.some((tx) => ethers.getAddress(tx.to) === rh.addr.launcher));
  const read = (dir) => Object.fromEntries(["setup", "opening-day", "set-create-signer"].map((slug) => [slug, load(dir, slug)]));
  postflightBatches(bscRecord, read(bscDir));
  postflightBatches(rhRecord, read(rhDir));
  assert.throws(() => postflightBatches(bscRecord, read(rhDir)), /chainId|record address/);
  assert.throws(() => postflightBatches(rhRecord, read(bscDir)), /chainId|record address/);
});

test("the signing writer refuses a predicted deployer and a missing record", () => {
  const cli = path.join(ROOT, "scripts/gen8/deploy/write-gen8-mainnet-batches.mjs");
  assert.equal(fs.existsSync(path.join(ROOT, "deployments/bsc/mainnet.gen8.json")), false);
  assert.equal(fs.existsSync(path.join(ROOT, "deployments/robinhood/mainnet.gen8.json")), false);
  const predicted = spawnSync(process.execPath, [cli, "--chain", "56", "--deployer", BEEF, "--nonce", "0"], { encoding: "utf8" });
  assert.notEqual(predicted.status, 0);
  assert.match(`${predicted.stderr}\n${predicted.stdout}`, /refusing --deployer and --nonce/);
  const missing = spawnSync(process.execPath, [cli, "--chain", "4663"], { encoding: "utf8" });
  assert.notEqual(missing.status, 0);
  assert.match(`${missing.stderr}\n${missing.stdout}`, /missing .*mainnet\.gen8\.json/);
});
