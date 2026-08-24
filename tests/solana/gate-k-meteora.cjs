"use strict";

/**
 * Gate K local proof that the pinned Meteora DAMM v2 binary is loaded and
 * exercised. This is not the devnet canary.
 *
 * Requires solana-test-validator started with:
 *   --bpf-program 3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt <mwz.so>
 *   --bpf-program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG third_party/meteora/cp_amm.so
 *   --account-dir third_party/meteora/accounts
 */
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Connection, PublicKey } = require("@solana/web3.js");

const BPF_UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111";
const BPF_LOADER2 = "BPFLoader2111111111111111111111111111111111";

const ROOT = path.resolve(__dirname, "../..");
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(ROOT, "config/solana/meteora-cp-amm.certification.json"), "utf8"),
);
const PROGRAM_ID = new PublicKey("3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt");
const METEORA = new PublicKey(MANIFEST.program.id);
const RPC = process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";

describe("Gate K pinned Meteora DAMM v2", function () {
  this.timeout(120_000);
  const connection = new Connection(RPC, "confirmed");

  it("downloads are pinned: SHA256, size, and git blob match the certification manifest", function () {
    const soPath = path.join(ROOT, MANIFEST.artifact.localPath);
    assert.ok(fs.existsSync(soPath), `missing ${soPath}; run scripts/solana/fetch-pinned-meteora-cp-amm.mjs --with-accounts`);
    const buf = fs.readFileSync(soPath);
    assert.equal(buf.length, MANIFEST.artifact.bytes);
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    assert.equal(sha256, MANIFEST.artifact.sha256);
    const header = Buffer.from(`blob ${buf.length}\0`, "ascii");
    const blob = crypto.createHash("sha1").update(header).update(buf).digest("hex");
    assert.equal(blob, MANIFEST.source.gitBlobSha1);
  });

  it("frozen MemeWarzone program and pinned DAMM v2 binary are loaded on the local validator", async function () {
    const mwz = await connection.getAccountInfo(PROGRAM_ID, "confirmed");
    assert.ok(mwz, "MemeWarzone program is not loaded");
    assert.equal(mwz.executable, true);

    const meteora = await connection.getAccountInfo(METEORA, "confirmed");
    assert.ok(
      meteora,
      `Meteora DAMM v2 ${METEORA.toBase58()} is not loaded. Start the validator with --bpf-program ${METEORA.toBase58()} ${MANIFEST.artifact.localPath}`,
    );
    assert.equal(meteora.executable, true);
    const loader = meteora.owner.toBase58();
    assert.ok(
      loader === BPF_UPGRADEABLE || loader === BPF_LOADER2,
      `Meteora program uses unexpected loader ${loader}`,
    );
    // Upgradeable program IDs are 36-byte Program accounts that point at ProgramData.
    // Compare the dumped ELF with the pinned file instead of the program-ID account size.
    const soPath = path.join(ROOT, MANIFEST.artifact.localPath);
    const dumpPath = path.join(os.tmpdir(), "mwz-gate-k-dumped-cp-amm.so");
    const dump = spawnSync("solana", ["program", "dump", METEORA.toBase58(), dumpPath, "--url", RPC], {
      encoding: "utf8",
    });
    assert.equal(dump.status, 0, dump.stderr || dump.stdout || "solana program dump failed");
    const dumped = fs.readFileSync(dumpPath);
    const pinned = fs.readFileSync(soPath);
    assert.ok(dumped.length >= pinned.length, `dumped ELF ${dumped.length} < pinned ${pinned.length}`);
    assert.ok(
      dumped.subarray(0, pinned.length).equals(pinned),
      "deployed DAMM v2 ELF does not match the pinned SHA256 file",
    );
  });

  it("pinned Meteora account fixtures are present", async function () {
    const missing = [];
    for (const file of MANIFEST.accounts.files) {
      const pk = file.name.replace(/\.json$/, "");
      const info = await connection.getAccountInfo(new PublicKey(pk), "confirmed");
      if (!info) missing.push(pk);
    }
    assert.equal(
      missing.length,
      0,
      `missing Meteora fixtures (start validator with --account-dir ${MANIFEST.accounts.localDir}): ${missing.join(",")}`,
    );
  });
});
