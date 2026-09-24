#!/usr/bin/env node
/**
 * Per-contract minimal standard-JSON inputs for Blockscout verification, each
 * proven locally before anyone uploads it: the input is compiled with the exact
 * solc build hardhat used and the resulting runtime bytecode is compared with
 * the bytecode on chain (immutable slots masked). Blockscout's verifier timed
 * out (504) on the full 36-source project input; trimming to each contract's
 * import closure is the only lever we have on their compile time.
 *
 *   node scripts/blockscout-standard-inputs.mjs 4663 [--only LaunchFactory,RiskRegistry]
 * writes docs/build_plans/verification/<chain>/inputs/<Name>.standard-input.json
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ethers } = require("ethers");

const chainId = String(process.argv[2] || "");
const only = (process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : "").split(",").map((s) => s.trim()).filter(Boolean);
const manifest = require("../config/verification/mainnet-contracts.json");
const chain = manifest.chains[chainId]; if (!chain) { console.error("chain not in manifest"); process.exit(2); }
const rpc = chainId === "4663" ? (process.env.ROBINHOOD_MAINNET_RPC || process.env.ROBINHOOD_MAINNET_RPC_URL) : "https://bsc-dataseed.binance.org";
const provider = new ethers.JsonRpcProvider(rpc, undefined, { staticNetwork: true });
const root = path.resolve(new URL(".", import.meta.url).pathname, "..");
const outDir = path.join(root, "docs", "build_plans", "verification", chainId, "inputs"); fs.mkdirSync(outDir, { recursive: true });
const solc = path.join(process.env.HOME, ".cache/hardhat-nodejs/compilers-v2/linux-amd64/solc-linux-amd64-v0.8.24+commit.e11b9ed9");

const resolveImport = (from, imp) => (imp.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(from), imp)) : imp);
function closure(sources, rootFile) { const seen = new Set(); const stack = [rootFile]; while (stack.length) { const f = stack.pop(); if (seen.has(f) || !sources[f]) continue; seen.add(f); for (const m of sources[f].content.matchAll(/import\s+(?:[^;]*?from\s+)?["']([^"']+)["']/g)) stack.push(resolveImport(f, m[1])); } return [...seen].sort(); }
function maskImmutables(code, refs) { let out = Buffer.from(code.replace(/^0x/, ""), "hex"); for (const list of Object.values(refs || {})) for (const r of list) out.fill(0, r.start, r.start + r.length); return "0x" + out.toString("hex"); }

let ok = 0; const results = [];
for (const c of chain.contracts) {
  const [src, name] = c.contract.split(":");
  if (only.length && !only.some((o) => name.includes(o))) continue;
  const dbg = path.join(root, "artifacts", src, `${name}.dbg.json`); const bi = require(path.resolve(path.dirname(dbg), require(dbg).buildInfo));
  const keep = closure(bi.input.sources, src);
  const input = { language: bi.input.language, sources: Object.fromEntries(keep.map((k) => [k, bi.input.sources[k]])), settings: { ...bi.input.settings, outputSelection: { "*": { "*": ["evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences"] } } } };
  const t0 = Date.now();
  const outJson = JSON.parse(execFileSync(solc, ["--standard-json"], { input: JSON.stringify(input), maxBuffer: 1 << 28 }).toString());
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const errors = (outJson.errors || []).filter((e) => e.severity === "error"); if (errors.length) { console.log(`  FAIL ${name}: ${errors[0].formattedMessage.slice(0, 200)}`); continue; }
  const compiled = outJson.contracts[src][name].evm.deployedBytecode;
  const onchain = await provider.getCode(c.address);
  const same = maskImmutables("0x" + compiled.object, compiled.immutableReferences) === maskImmutables(onchain, compiled.immutableReferences);
  if (same) ok++;
  // write the input Blockscout should receive (default outputSelection, as hardhat sends it)
  const upload = { language: input.language, sources: input.sources, settings: bi.input.settings };
  fs.writeFileSync(path.join(outDir, `${name}.standard-input.json`), JSON.stringify(upload));
  results.push({ name, address: c.address, sources: keep.length, compileSeconds: Number(secs), bytecodeMatches: same, file: `inputs/${name}.standard-input.json` });
  console.log(`  ${same ? "ok  " : "MISMATCH"} ${name.padEnd(38)} ${keep.length} sources  compile ${secs}s  ${(fs.statSync(path.join(outDir, `${name}.standard-input.json`)).size / 1024).toFixed(0)} KB`);
}
fs.writeFileSync(path.join(outDir, "..", "inputs.json"), JSON.stringify({ chainId, compiler: "v0.8.24+commit.e11b9ed9", generatedAt: new Date().toISOString(), results }, null, 2));
console.log(`[inputs] ${ok}/${results.length} trimmed inputs reproduce the on-chain bytecode`);
