#!/usr/bin/env node
// ABI export for the DogeOS Barkswap contracts (plan t7; pattern: gen-8's scripts/gen8/export-abis.mjs at e129712b9).
//
// Writes contracts/dogeos/barkswap/abi/<Name>.abi.json for the seven Bark contracts, read from the Bark build
// (artifacts-bark/, `npx hardhat --config hardhat.dogeos-bark-fork.config.ts compile`). The launcher's ABI gets the
// custom errors of the linked libraries it calls (MwzBarkLaunchLib, MwzBarkFeeBooks; taken from its link references,
// not a hand-kept list) merged in, because a revert raised inside a DELEGATECALLed library surfaces from the launcher
// but is not in the launcher's own ABI. Later tasks (t15, t18, t21, t22) read only these files.
//
// Also writes AlgebraSwapRouter.abi.json and AlgebraQuoterV2.abi.json: the Barkswap periphery is not built here, so
// these are the fragments the research proof used (scripts/research/barkswap-plugin/run-proof.mjs, ROUTER_ABI and
// QUOTER_ABI), cross-checked at export time against the vendored Algebra Integral v1.2.1 interfaces
// (contracts/dogeos/barkswap/interfaces/periphery/*): every fragment must exist there with the same signature,
// outputs and state mutability, or the export fails. They are not compared in --check (nothing builds them).
//
//   node scripts/dogeos-bark-export-abis.mjs          write the files
//   node scripts/dogeos-bark-export-abis.mjs --check  compare the seven Bark ABIs with the build; exit 1 on drift
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Fragment, Interface } from "ethers";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const barkArtifacts = path.join(repoRoot, "artifacts-bark", "contracts", "dogeos", "barkswap");
const OUT = path.join(repoRoot, "contracts", "dogeos", "barkswap", "abi");

const CONTRACTS = [
  "MwzBarkPlugin",
  "MwzBarkLauncher",
  "MwzBarkFeeSplitter",
  "MwzBarkReserveLock",
  "MwzBarkLaunchLens",
  "MwzBarkCreatorChoiceVault",
  "MwzBarkCreatorEscrow",
];

// Human-readable fragments as used by the research proof (run-proof.mjs ROUTER_ABI / QUOTER_ABI), verbatim.
const PROOF_ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, address deployer, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 limitSqrtPrice) params) payable returns (uint256)",
  "function multicall(bytes[] data) payable returns (bytes[])",
  "function unwrapWNativeToken(uint256 amountMinimum, address recipient) payable",
  "function refundNativeToken() payable",
  "function poolDeployer() view returns (address)",
  "function WNativeToken() view returns (address)",
];
const PROOF_QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, address deployer, uint256 amountIn, uint160 limitSqrtPrice) params) returns (uint256 amountOut, uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate, uint16 fee)",
];
// The vendored v1.2.1 interfaces each proof fragment must match (the SwapRouter inherits all of these upstream).
const ALGEBRA = [
  { name: "AlgebraSwapRouter", fragments: PROOF_ROUTER_ABI, interfaces: ["ISwapRouter", "IMulticall", "IPeripheryPayments", "IPeripheryImmutableState"] },
  { name: "AlgebraQuoterV2", fragments: PROOF_QUOTER_ABI, interfaces: ["IQuoterV2"] },
];

function artifactFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...artifactFiles(full));
    else if (entry.name.endsWith(".json") && !entry.name.endsWith(".dbg.json")) out.push(full);
  }
  return out;
}

/** contractName -> artifact, for everything under contracts/dogeos/barkswap in the Bark build. */
function loadBarkArtifacts() {
  if (!fs.existsSync(barkArtifacts)) {
    throw new Error(`No Bark build at ${path.relative(repoRoot, barkArtifacts)}: run npx hardhat --config hardhat.dogeos-bark-fork.config.ts compile`);
  }
  const byName = {};
  for (const file of artifactFiles(barkArtifacts)) {
    const artifact = JSON.parse(fs.readFileSync(file, "utf8"));
    if (byName[artifact.contractName]) throw new Error(`Duplicate Bark artifact name ${artifact.contractName}`);
    byName[artifact.contractName] = artifact;
  }
  return byName;
}

/** ABI entry key: type + signature (errors and functions by selector-defining signature; events the same way). */
function entryKey(entry) {
  if (entry.type === "constructor" || entry.type === "fallback" || entry.type === "receive") return entry.type;
  return `${entry.type}:${Fragment.from(entry).format("sighash")}`;
}

/** The exported ABI of one Bark contract: its own ABI plus the errors of the libraries it links, in a fixed order. */
function exportedAbi(byName, name) {
  const artifact = byName[name];
  if (!artifact) throw new Error(`Bark artifact ${name} not found in the build`);
  const abi = [...artifact.abi];
  const seen = new Set(abi.map(entryKey));
  const libraries = Object.values(artifact.deployedLinkReferences ?? {}).flatMap((bySource) => Object.keys(bySource)).sort();
  for (const lib of libraries) {
    const libArtifact = byName[lib];
    if (!libArtifact) throw new Error(`${name} links ${lib}, which is not in the build`);
    const errors = libArtifact.abi.filter((e) => e.type === "error").sort((a, b) => entryKey(a).localeCompare(entryKey(b)));
    for (const e of errors) {
      const key = entryKey(e);
      if (seen.has(key)) continue;
      seen.add(key);
      abi.push(e);
    }
  }
  return abi;
}

/** The proof's fragments as a JSON ABI, after checking each against the vendored interfaces. */
function algebraAbi(byName, spec) {
  const vendored = new Map();
  for (const ifaceName of spec.interfaces) {
    const artifact = byName[ifaceName];
    if (!artifact) throw new Error(`${spec.name}: vendored interface ${ifaceName} not in the build`);
    for (const entry of artifact.abi) {
      if (entry.type !== "function") continue;
      vendored.set(Fragment.from(entry).format("sighash"), Fragment.from(entry).format("minimal"));
    }
  }
  const iface = new Interface(spec.fragments);
  for (const fragment of iface.fragments) {
    const sighash = fragment.format("sighash");
    const upstream = vendored.get(sighash);
    if (!upstream) throw new Error(`${spec.name}: proof fragment ${sighash} is not in the vendored v1.2.1 interfaces ${spec.interfaces.join(", ")}`);
    const ours = fragment.format("minimal");
    if (ours !== upstream) throw new Error(`${spec.name}: proof fragment differs from v1.2.1\n  proof:    ${ours}\n  upstream: ${upstream}`);
  }
  // solc's ABI shape: drop ethers' legacy `constant` / `payable` duplicates of stateMutability
  return iface.fragments.map((f) => {
    const { constant, payable, ...entry } = JSON.parse(f.format("json"));
    return entry;
  });
}

function fileFor(name) {
  return path.join(OUT, `${name}.abi.json`);
}

function serialize(abi) {
  return JSON.stringify(abi, null, 2) + "\n";
}

function main(argv) {
  const check = argv.includes("--check");
  const byName = loadBarkArtifacts();
  const built = Object.fromEntries(CONTRACTS.map((name) => [name, exportedAbi(byName, name)]));
  if (check) {
    let drift = 0;
    for (const name of CONTRACTS) {
      const file = fileFor(name);
      if (!fs.existsSync(file)) {
        console.error(`${name}: ${path.relative(repoRoot, file)} missing`);
        drift += 1;
        continue;
      }
      const onDisk = fs.readFileSync(file, "utf8");
      const fromBuild = serialize(built[name]);
      if (onDisk !== fromBuild) {
        const a = new Set(JSON.parse(onDisk).map(entryKey));
        const b = new Set(built[name].map(entryKey));
        const added = [...b].filter((k) => !a.has(k));
        const removed = [...a].filter((k) => !b.has(k));
        console.error(`${name}: ABI drift (build vs ${path.relative(repoRoot, file)})`);
        for (const k of added) console.error(`  + ${k}`);
        for (const k of removed) console.error(`  - ${k}`);
        if (added.length === 0 && removed.length === 0) console.error("  (same entries, different order, names or formatting)");
        drift += 1;
      } else {
        console.log(`${name}: ${built[name].length} entries, matches the build`);
      }
    }
    if (drift > 0) {
      console.error(`${drift} ABI file(s) out of date: run node scripts/dogeos-bark-export-abis.mjs`);
      return 1;
    }
    console.log(`${CONTRACTS.length} Bark ABIs match the build (${ALGEBRA.map((s) => s.name).join(", ")} not checked: not built here).`);
    return 0;
  }
  fs.mkdirSync(OUT, { recursive: true });
  for (const name of CONTRACTS) {
    fs.writeFileSync(fileFor(name), serialize(built[name]));
    console.log(`${name}: ${built[name].length} entries`);
  }
  for (const spec of ALGEBRA) {
    const abi = algebraAbi(byName, spec);
    fs.writeFileSync(fileFor(spec.name), serialize(abi));
    console.log(`${spec.name}: ${abi.length} entries (proof fragments, checked against ${spec.interfaces.join(", ")})`);
  }
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
