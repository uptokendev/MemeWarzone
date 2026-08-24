#!/usr/bin/env node
/**
 * Download the pinned Meteora DAMM v2 CP-AMM test artifact from an immutable
 * MeteoraAg/meteora-invent commit, hash it, and fail closed on mismatch.
 *
 * Usage:
 *   node scripts/solana/fetch-pinned-meteora-cp-amm.mjs
 *   node scripts/solana/fetch-pinned-meteora-cp-amm.mjs --with-accounts
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST_PATH = path.join(ROOT, "config/solana/meteora-cp-amm.certification.json");
const WITH_ACCOUNTS = process.argv.includes("--with-accounts");

function fail(message) {
  throw new Error(`[meteora-cp-amm-pin] ${message}`);
}

function gitBlobSha1(buf) {
  const header = Buffer.from(`blob ${buf.length}\0`, "ascii");
  return crypto.createHash("sha1").update(header).update(buf).digest("hex");
}

async function download(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) fail(`download failed ${response.status} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function downloadBinary(commit, relPath) {
  const urls = [
    `https://github.com/MeteoraAg/meteora-invent/raw/${commit}/${relPath}`,
    `https://raw.githubusercontent.com/MeteoraAg/meteora-invent/${commit}/${relPath}`,
  ];
  let lastError = null;
  for (const url of urls) {
    try {
      return await download(url);
    } catch (error) {
      lastError = error;
    }
  }
  fail(`could not download ${relPath} from pinned commit ${commit}: ${lastError?.message || lastError}`);
}

function writeFile(dest, buf) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const commit = manifest.source?.commit;
  const relPath = manifest.source?.path;
  const expectedSha = String(manifest.artifact?.sha256 || "").toLowerCase();
  const expectedBytes = Number(manifest.artifact?.bytes || manifest.source?.bytes || 0);
  const expectedBlob = String(manifest.source?.gitBlobSha1 || "").toLowerCase();
  const programId = manifest.program?.id;
  if (!commit || !relPath || !expectedSha || !expectedBytes || !programId) {
    fail(`certification manifest is incomplete: ${MANIFEST_PATH}`);
  }
  if (commit === "main" || commit === "master") {
    fail("refusing to pin a moving branch; use an immutable commit SHA");
  }

  const dest = path.join(ROOT, manifest.artifact.localPath);
  const buf = await downloadBinary(commit, relPath);
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  const blob = gitBlobSha1(buf);

  if (buf.length !== expectedBytes) {
    fail(`byte length mismatch: expected ${expectedBytes}, got ${buf.length}`);
  }
  if (sha256 !== expectedSha) {
    fail(`SHA256 mismatch: expected ${expectedSha}, got ${sha256}. Fail closed.`);
  }
  if (expectedBlob && blob !== expectedBlob) {
    fail(`git blob SHA1 mismatch: expected ${expectedBlob}, got ${blob}`);
  }

  writeFile(dest, buf);
  console.log("meteora_program_id", programId);
  console.log("meteora_source_commit", commit);
  console.log("meteora_source_path", relPath);
  console.log("meteora_bytes", buf.length);
  console.log("meteora_sha256", sha256);
  console.log("meteora_git_blob_sha1", blob);
  console.log("meteora_local_path", dest);
  console.log("meteora_sdk", `${manifest.sdk.package}@${manifest.sdk.version}`);

  if (!WITH_ACCOUNTS) return;

  const accountsDir = path.join(ROOT, manifest.accounts.localDir);
  fs.mkdirSync(accountsDir, { recursive: true });
  for (const file of manifest.accounts.files) {
    const rel = `${manifest.source.accountsPath}/${file.name}`;
    const accountBuf = await downloadBinary(commit, rel);
    if (accountBuf.length !== Number(file.bytes)) {
      fail(`account ${file.name} byte length mismatch: expected ${file.bytes}, got ${accountBuf.length}`);
    }
    const accountBlob = gitBlobSha1(accountBuf);
    if (accountBlob !== String(file.gitBlobSha1).toLowerCase()) {
      fail(`account ${file.name} git blob SHA1 mismatch: expected ${file.gitBlobSha1}, got ${accountBlob}`);
    }
    writeFile(path.join(accountsDir, file.name), accountBuf);
  }
  console.log("meteora_accounts", manifest.accounts.files.length);
  console.log("meteora_accounts_dir", accountsDir);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
