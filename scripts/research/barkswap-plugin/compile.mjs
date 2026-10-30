// Compiles ./contracts/*.sol with solc-js 0.8.26 (evm paris, like the deployed Algebra 1.2.1), resolving
// @openzeppelin imports from the repo's node_modules. Research only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const solc = require("solc");
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "contracts");
const ROOT_NM = path.resolve(here, "../../../node_modules");

function findImports(p) {
  for (const c of [path.join(ROOT_NM, p), path.join(SRC, p)]) if (fs.existsSync(c)) return { contents: fs.readFileSync(c, "utf8") };
  return { error: `not found: ${p}` };
}

export function compileAll() {
  const sources = {};
  for (const f of fs.readdirSync(SRC).filter((f) => f.endsWith(".sol"))) sources[f] = { content: fs.readFileSync(path.join(SRC, f), "utf8") };
  const input = {
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: "paris",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const errors = (out.errors || []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  const contracts = {};
  for (const file of Object.keys(out.contracts)) {
    for (const [name, c] of Object.entries(out.contracts[file])) {
      contracts[name] = { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object, runtimeSize: c.evm.deployedBytecode.object.length / 2 };
    }
  }
  return { contracts, warnings: (out.errors || []).filter((e) => e.severity !== "error").map((e) => e.formattedMessage), solcVersion: solc.version() };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const t = Date.now();
  const r = compileAll();
  for (const [n, c] of Object.entries(r.contracts)) if (!n.startsWith("I") && c.runtimeSize > 0) console.log(n, "runtime bytes", c.runtimeSize);
  for (const w of r.warnings) console.log("warning:", w.split("\n")[0]);
  console.log("solc", r.solcVersion, "ms", Date.now() - t);
}
