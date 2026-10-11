// Loads the gen-8 contracts as built by hardhat.gen8.config.ts (artifacts-gen8/), so the fork suite runs exactly the
// production bytecode the unit tests run (no second compiler). Links external libraries (MwzSwapSim) on request.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..", "..");
const ART = path.join(ROOT, "artifacts-gen8");

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".json") && !p.endsWith(".dbg.json")) out.push(p);
  }
  return out;
}

export function loadArtifacts() {
  if (!fs.existsSync(ART)) throw new Error("artifacts-gen8 missing: run `npx hardhat --config hardhat.gen8.config.ts compile` first");
  const contracts = {};
  let solcVersion = "";
  for (const p of walk(path.join(ART, "contracts"))) {
    const a = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!a.contractName || !a.bytecode || a.bytecode === "0x") continue;
    contracts[a.contractName] = {
      abi: a.abi,
      bytecode: a.bytecode,
      linkReferences: a.linkReferences || {},
      runtimeSize: (a.deployedBytecode.length - 2) / 2,
      sourceName: a.sourceName,
    };
  }
  // v4-core / v4-periphery helpers are not needed on forks (canonical deployments are used)
  const bi = path.join(ART, "build-info");
  if (fs.existsSync(bi)) {
    const f = fs.readdirSync(bi).find((x) => x.endsWith(".json"));
    if (f) solcVersion = JSON.parse(fs.readFileSync(path.join(bi, f), "utf8")).solcLongVersion || "";
  }
  contracts.link = (name, libs) => {
    const c = contracts[name];
    let hex = c.bytecode.slice(2);
    for (const file of Object.keys(c.linkReferences)) {
      for (const [lib, refs] of Object.entries(c.linkReferences[file])) {
        const addr = libs[lib];
        if (!addr) throw new Error(`${name}: library ${lib} address missing`);
        for (const { start, length } of refs) {
          hex = hex.slice(0, start * 2) + addr.toLowerCase().replace(/^0x/, "").padStart(length * 2, "0") + hex.slice((start + length) * 2);
        }
      }
    }
    if (hex.includes("__$")) throw new Error(`${name}: unlinked library placeholder left`);
    return { ...c, bytecode: "0x" + hex };
  };
  return { contracts, solcVersion };
}
