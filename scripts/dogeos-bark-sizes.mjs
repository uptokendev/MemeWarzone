#!/usr/bin/env node
// EIP-170 gate for the DogeOS Barkswap contracts (contracts/dogeos/barkswap/**).
//
// Reads the Bark build (artifacts-bark/, from `npx hardhat --config hardhat.dogeos-bark-fork.config.ts compile`),
// prints the runtime (deployed) bytecode size of every contract and linked library with code under
// contracts/dogeos/barkswap (libraries are deployed on their own, so EIP-170 applies to each of them too), and exits
// non-zero if any is above 24,576 bytes (EIP-170, enforced on Chikyu), if the build is missing, or if no contract with
// code is found. Interfaces and internal-only libraries without code are counted but not listed. A contract that calls
// linked libraries lists them (its deployed bytecode holds a 20-byte placeholder per call site, so the size printed is
// already the linked size).
//
//   node scripts/dogeos-bark-sizes.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EIP170_LIMIT = 24_576;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const barkArtifacts = path.join(repoRoot, "artifacts-bark", "contracts", "dogeos", "barkswap");

function artifactFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...artifactFiles(full));
    else if (entry.name.endsWith(".json") && !entry.name.endsWith(".dbg.json")) out.push(full);
  }
  return out;
}

/** "library" if the artifact's source declares `library <Name>`, else "contract". */
function kindOf(artifact) {
  const file = path.join(repoRoot, artifact.sourceName);
  if (!fs.existsSync(file)) return "contract";
  const pattern = new RegExp(String.raw`^\s*library\s+` + artifact.contractName + String.raw`\b`, "m");
  return pattern.test(fs.readFileSync(file, "utf8")) ? "library" : "contract";
}

/** Runtime size in bytes of an artifact's deployedBytecode hex string. */
function runtimeSize(deployedBytecode) {
  const hex = String(deployedBytecode ?? "0x").replace(/^0x/, "");
  return hex.length / 2;
}

function main() {
  if (!fs.existsSync(barkArtifacts)) {
    console.error(`No Bark build at ${path.relative(repoRoot, barkArtifacts)}: run npx hardhat --config hardhat.dogeos-bark-fork.config.ts compile`);
    return 1;
  }
  const rows = [];
  let interfaces = 0;
  for (const file of artifactFiles(barkArtifacts)) {
    const artifact = JSON.parse(fs.readFileSync(file, "utf8"));
    const size = runtimeSize(artifact.deployedBytecode);
    if (size === 0) {
      interfaces += 1;
      continue;
    }
    const links = Object.values(artifact.deployedLinkReferences ?? {}).flatMap((bySource) => Object.keys(bySource));
    rows.push({ name: artifact.contractName, source: artifact.sourceName, size, kind: kindOf(artifact), links });
  }
  if (rows.length === 0) {
    console.error("No Bark contract with runtime code found in the build.");
    return 1;
  }
  rows.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
  const nameWidth = Math.max(...rows.map((r) => r.name.length), "Contract".length);
  console.log(`${"Contract".padEnd(nameWidth)}  ${"Kind".padEnd(8)}  ${"Runtime".padStart(7)}  ${"Headroom".padStart(8)}  Source`);
  let over = 0;
  for (const r of rows) {
    const headroom = EIP170_LIMIT - r.size;
    if (headroom < 0) over += 1;
    const links = r.links.length > 0 ? `  (links ${[...new Set(r.links)].sort().join(", ")})` : "";
    console.log(
      `${r.name.padEnd(nameWidth)}  ${r.kind.padEnd(8)}  ${String(r.size).padStart(7)}  ${String(headroom).padStart(8)}  ${r.source}${links}${headroom < 0 ? "  OVER EIP-170" : ""}`,
    );
  }
  const libraries = rows.filter((r) => r.kind === "library").length;
  console.log(
    `${rows.length - libraries} contract(s) and ${libraries} linked librar${libraries === 1 ? "y" : "ies"} with code, ${interfaces} without; limit ${EIP170_LIMIT} bytes.`,
  );
  if (over > 0) {
    console.error(`${over} contract(s) above the EIP-170 limit of ${EIP170_LIMIT} bytes.`);
    return 1;
  }
  return 0;
}

process.exitCode = main();
