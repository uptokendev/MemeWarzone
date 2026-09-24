#!/usr/bin/env node
/**
 * Source-verify contracts on Sourcify's v2 API, straight from hardhat's
 * build-info (the exact standard-JSON input and solc version that produced the
 * deployed bytecode). Used for Robinhood Chain (4663): its Blockscout explorer
 * blocks scripted requests behind a Cloudflare challenge and reads Sourcify;
 * hardhat-verify 2.1.x still targets Sourcify's retired v1 endpoints.
 *
 * Sourcify matches the submitted compilation against the on-chain runtime
 * bytecode itself, so no constructor arguments are involved and nothing can be
 * verified wrongly: the result is "exact_match", "match", or a failure.
 *
 *   node scripts/sourcify-verify.mjs 4663            # every contract in the manifest for that chain
 *   ONLY=LaunchFactory,RiskRegistry node scripts/sourcify-verify.mjs 4663
 */
import fs from "node:fs";
import path from "node:path";

const chainId = String(process.argv[2] || "");
const manifest = JSON.parse(fs.readFileSync(new URL("../config/verification/mainnet-contracts.json", import.meta.url), "utf8"));
const chain = manifest.chains[chainId];
if (!chain) { console.error("usage: node scripts/sourcify-verify.mjs <chainId in the manifest>"); process.exit(2); }
const only = String(process.env.ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
const base = process.env.SOURCIFY_API || "https://sourcify.dev/server";
const root = path.resolve(new URL(".", import.meta.url).pathname, "..");

const buildInfoCache = new Map();
function compilation(contract) {
  const [source, name] = contract.split(":");
  const dbg = path.join(root, "artifacts", source, `${name}.dbg.json`);
  const rel = JSON.parse(fs.readFileSync(dbg, "utf8")).buildInfo;
  const biPath = path.resolve(path.dirname(dbg), rel);
  if (!buildInfoCache.has(biPath)) buildInfoCache.set(biPath, JSON.parse(fs.readFileSync(biPath, "utf8")));
  const bi = buildInfoCache.get(biPath);
  return { stdJsonInput: bi.input, compilerVersion: bi.solcLongVersion, contractIdentifier: contract };
}

async function status(chainId, address) {
  const r = await fetch(`${base}/v2/contract/${chainId}/${address}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  return j.match || null;
}

async function submit(chainId, address, body) {
  const r = await fetch(`${base}/v2/verify/${chainId}/${address}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 409 && /already verified/i.test(JSON.stringify(j))) return { already: true };
  if (!r.ok || !j.verificationId) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return { verificationId: j.verificationId };
}

async function waitForJob(verificationId) {
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${base}/v2/verify/${verificationId}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    if (j.isJobCompleted) return j;
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error("verification job did not complete in time");
}

const summary = [];
for (const c of chain.contracts) {
  if (only.length && !only.some((o) => c.name.includes(o))) continue;
  try {
    const before = await status(chainId, c.address);
    if (before) { summary.push([c.name, `already ${before}`]); console.log(`  already ${before.padEnd(12)} ${c.name} ${c.address}`); continue; }
    const s = await submit(chainId, c.address, compilation(c.contract));
    if (s.already) { summary.push([c.name, "already verified"]); console.log(`  already verified     ${c.name} ${c.address}`); continue; }
    const job = await waitForJob(s.verificationId);
    const match = job.contract?.match || job.contract?.runtimeMatch || null;
    const err = job.error ? `${job.error.customCode || ""} ${job.error.message || ""}`.trim() : "";
    summary.push([c.name, match ? match : `FAILED ${err}`]);
    console.log(`  ${(match || "FAILED").padEnd(20)} ${c.name} ${c.address}${err ? `  (${err.slice(0, 140)})` : ""}`);
  } catch (error) {
    summary.push([c.name, `FAILED ${String(error.message || error).slice(0, 160)}`]);
    console.log(`  FAILED               ${c.name} ${c.address}  ${String(error.message || error).slice(0, 160)}`);
  }
}
const failed = summary.filter(([, v]) => v.startsWith("FAILED"));
console.log(`[sourcify] chain ${chainId}: ${summary.length} processed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
