import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../package.json", import.meta.url));
const { transform } = require("esbuild");

export async function loadFrontendTsModule(relativeFromScripts) {
  const sourceUrl = new URL(relativeFromScripts, import.meta.url);
  const source = await readFile(fileURLToPath(sourceUrl), "utf8");
  const compiled = await transform(source, {
    format: "esm",
    loader: "ts",
    target: "es2022",
  });
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.code).toString("base64")}`;
  return import(moduleUrl);
}

export async function loadSolanaV0Module() {
  return loadFrontendTsModule("../src/lib/solanaV0Transaction.ts");
}

export async function loadSolanaUserV0Module() {
  return loadFrontendTsModule("../src/lib/solanaUserV0Transaction.ts");
}

export async function loadSolanaLaunchpadInstructions() {
  return loadFrontendTsModule("../src/lib/solanaLaunchpadInstructions.ts");
}
