import { readFile } from "node:fs/promises";
import * as nodeModule from "node:module";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

async function transformTypeScript(source, sourceUrl) {
  if (typeof nodeModule.stripTypeScriptTypes === "function") {
    return nodeModule.stripTypeScriptTypes(source, {
      mode: "transform",
      sourceMap: false,
      sourceUrl: sourceUrl.href,
    });
  }

  // Compatibility fallback for local/operator environments older than Node 22.13.
  // Frontend installs already bring esbuild through the Vite toolchain.
  const require = createRequire(new URL("../package.json", import.meta.url));
  const { transform } = require("esbuild");
  const compiled = await transform(source, {
    format: "esm",
    loader: "ts",
    target: "es2022",
  });
  return compiled.code;
}

export async function loadFrontendTsModule(relativeFromScripts) {
  const sourceUrl = new URL(relativeFromScripts, import.meta.url);
  const source = await readFile(fileURLToPath(sourceUrl), "utf8");
  const compiledCode = await transformTypeScript(source, sourceUrl);
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiledCode).toString("base64")}`;
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
