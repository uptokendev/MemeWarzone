import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./upgrade-mainnet-rewards-treasury.cjs", import.meta.url), "utf8");

test("rewards mainnet executor pins the canonical program and mainnet genesis", () => {
  assert.match(source, /2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX/);
  assert.match(source, /5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d/);
  assert.match(source, /Refusing non-mainnet genesis/);
  assert.match(source, /refuses devnet\/testnet RPC/);
});

test("execute path requires exact candidate hash, authority key and explicit broadcast token", () => {
  assert.match(source, /SOLANA_REWARDS_RELEASE_CANDIDATE_SHA256/);
  assert.match(source, /SOLANA_REWARDS_UPGRADE_AUTHORITY_KEYPAIR/);
  assert.match(source, /SOLANA_REWARDS_MAINNET_BROADCAST/);
  assert.match(source, /UPGRADE_MWZ_REWARDS_MAINNET/);
  assert.match(source, /on-chain authority is/);
});

test("zero-write preflight and live dump happen before the program deploy write", () => {
  const preflight = source.indexOf('run("bash", [PREFLIGHT');
  const liveDump = source.indexOf("liveBinary = dumpProgram");
  const firstWrite = source.indexOf("// FIRST WRITE");
  const deploy = source.indexOf('"program", "deploy"');
  assert.ok(preflight >= 0);
  assert.ok(liveDump > preflight);
  assert.ok(firstWrite > liveDump);
  assert.ok(deploy > firstWrite);
});

test("post-deploy verification dumps the program and requires exact byte equality", () => {
  const deploy = source.indexOf('"program", "deploy"');
  const verification = source.indexOf("deploymentVerification: true");
  assert.ok(verification > deploy);
  assert.match(source, /candidate\.equals\(deployed\)/);
  assert.match(source, /DEPLOYMENT VERIFICATION FAILED/);
  assert.match(source, /Keep rewards\/Arena claims paused/);
});

test("dry-run exits before any deployment transaction", () => {
  const dryRun = source.indexOf('console.log("Dry-run only. No transaction sent.")');
  const returnAfterDryRun = source.indexOf("return;", dryRun);
  const firstWrite = source.indexOf("// FIRST WRITE");
  assert.ok(dryRun >= 0);
  assert.ok(returnAfterDryRun > dryRun && returnAfterDryRun < firstWrite);
});

test("unnecessary same-binary upgrade is refused", () => {
  assert.match(source, /already deployed; refusing unnecessary upgrade transaction/);
});
