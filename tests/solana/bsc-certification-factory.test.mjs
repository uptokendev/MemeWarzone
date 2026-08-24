import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const configPath = path.join(root, "config/bsc-testnet-certification.json");
const resolver = path.join(root, "scripts/resolve-bsc-certification-factory.mjs");

test("network canary distinguishes Topaz preflight from full-cycle", () => {
  const canary = fs.readFileSync(path.join(root, ".github/workflows/solana-network-canary.yml"), "utf8");
  const driver = fs.readFileSync(path.join(root, "scripts/run-bnb-lifecycle-certification.ts"), "utf8");
  const verifier = fs.readFileSync(path.join(root, "scripts/test-topaz-graduation-flow.ts"), "utf8");
  assert.match(canary, /bsc-testnet-preflight/);
  assert.match(canary, /bsc-testnet-full-cycle/);
  assert.match(canary, /run-bnb-lifecycle-certification\.ts/);
  assert.match(canary, /TOPAZ_ACCEPTANCE_REQUIRE_EVIDENCE/);
  assert.match(driver, /Do not fund this path until the dedicated testnet-certification/);
  assert.match(verifier, /acceptance preflight passed/);
});

test("BSC certification factory is resolved from the accepted test manifest", () => {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(config.chainId, 97);
  assert.equal(config.sourceManifest, "deployments/bscTestnet.clean-slate-factory.json");
  assert.ok(config.rejectedFactories.includes("0xF7872169265eCE4E4C93ef894F1635E84DC6F681"));
  assert.ok(config.rejectedFactories.includes("0xe0FbBa4533513110Cec7e78aa3e48EC45301B5E6"));

  const result = spawnSync(process.execPath, [resolver], { encoding: "utf8", cwd: root });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const start = result.stdout.indexOf("{");
  const end = result.stdout.lastIndexOf("}");
  assert.ok(start >= 0 && end > start, result.stdout);
  const parsed = JSON.parse(result.stdout.slice(start, end + 1));
  assert.equal(parsed.factory, "0x77Af7634837643d4f93d1086b492571268b30B5F");
  assert.equal(parsed.creationEnabled, true);
  assert.notEqual(parsed.factory.toLowerCase(), "0xF7872169265eCE4E4C93ef894F1635E84DC6F681".toLowerCase());
  assert.match(result.stdout, /FACTORY_ADDRESS=0x77Af7634837643d4f93d1086b492571268b30B5F/);
});
