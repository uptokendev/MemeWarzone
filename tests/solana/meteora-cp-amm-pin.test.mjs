import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = path.join(root, "config/solana/meteora-cp-amm.certification.json");
const fetchScript = path.join(root, "scripts/solana/fetch-pinned-meteora-cp-amm.mjs");
const graduate = path.join(root, "tools/solana-meteora-graduation/graduate.mjs");
const sdkPkg = path.join(root, "tools/solana-meteora-graduation/package.json");

test("Meteora CP-AMM certification pin is immutable and fail-closed", () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const source = fs.readFileSync(fetchScript, "utf8");
  assert.equal(manifest.program.id, "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
  assert.equal(manifest.source.repository, "https://github.com/MeteoraAg/meteora-invent");
  assert.equal(manifest.source.commit, "6787734f46c85e9c490d298c9ddfd210e262fe4e");
  assert.equal(manifest.source.path, "studio/src/tests/artifacts/cp_amm.so");
  assert.equal(manifest.source.gitBlobSha1, "c42dface0964d1e82e93fbae2cdb35500cc08f5b");
  assert.equal(manifest.artifact.bytes, 1522368);
  assert.match(manifest.artifact.sha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.sdk.package, "@meteora-ag/cp-amm-sdk");
  assert.equal(manifest.sdk.version, "1.4.5");
  assert.notEqual(manifest.source.commit, "main");
  assert.equal(manifest.accounts.files.length, 14);
  assert.match(source, /Fail closed/);
  assert.match(source, /SHA256 mismatch/);
  assert.match(source, /refusing to pin a moving branch/);
});

test("graduation operator tool pins DAMM v2 program ID and SDK 1.4.5", () => {
  const source = fs.readFileSync(graduate, "utf8");
  const pkg = JSON.parse(fs.readFileSync(sdkPkg, "utf8"));
  assert.match(source, /cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG/);
  assert.equal(pkg.dependencies["@meteora-ag/cp-amm-sdk"], "1.4.5");
});
