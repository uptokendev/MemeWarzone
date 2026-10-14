// Founder 2026-10-12 (audit B-04 follow-up): logos are https or ipfs only. The app uploads the logo through
// api/upload.js, which stores it in Supabase storage under logos/<chainId>/<uuid>.<ext> and returns the bucket's public
// URL. That exact URL shape must pass the app's on-chain check (src/lib/onchainLogoUri.ts) and the API's gen-8 create
// parser (api/dev-fix/evmGen8CreateAuthorization.js), and data: / http: must not.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createClient } from "@supabase/supabase-js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const compiled = await build({
  absWorkingDir: dir,
  stdin: { contents: `export { assertOnchainLogoUri } from "./onchainLogoUri.ts";`, resolveDir: dir, sourcefile: "logoHarness.ts", loader: "ts" },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  packages: "external",
});
const harness = path.join(dir, `.logo-harness-${process.pid}.mjs`);
fs.writeFileSync(harness, compiled.outputFiles[0].text);
let assertOnchainLogoUri;
try {
  ({ assertOnchainLogoUri } = await import(harness));
} finally {
  fs.rmSync(harness, { force: true });
}
const { parseGen8CreateRequest } = await import("../../api/dev-fix/evmGen8CreateAuthorization.js");

// The URL api/upload.js returns: supabase.storage.from(bucket).getPublicUrl(name).data.publicUrl, computed by the client
// library from the project URL (no network).
function uploadUrl(bucket = "MEMEBATTLES", name = "logos/56/3f2c1c3e-2d2b-4b1a-9c0e-0a1b2c3d4e5f.png") {
  const supabase = createClient("https://vrnsbguutnwgtekcexls.supabase.co", "public-anon-key-for-url-shape-only");
  return supabase.storage.from(bucket).getPublicUrl(name).data.publicUrl;
}

const ENV = { EVM_GEN8_LAUNCHER_56: "0x00000000000000000000000000000000000000c8", EVM_GEN8_HOOK_56: "0x0000000000000000000000000000000000002aec" };
const request = (logoURI) => ({ campaignRequest: { name: "Logo", symbol: "LOGO", logoURI, description: "d" } });

test("the upload URL shape passes the app check and the API parser", () => {
  const url = uploadUrl();
  assert.match(url, /^https:\/\/vrnsbguutnwgtekcexls\.supabase\.co\/storage\/v1\/object\/public\/MEMEBATTLES\/logos\/56\/[0-9a-f-]+\.png$/);
  assert.equal(assertOnchainLogoUri(url), url);
  const parsed = parseGen8CreateRequest(request(url), 56, ENV);
  assert.equal(parsed.fields.logoURI, url);
  for (const bucket of ["memebattles", "MEMEBATTLES"]) assert.equal(assertOnchainLogoUri(uploadUrl(bucket)), uploadUrl(bucket));
  const ipfs = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/logo.png";
  assert.equal(parseGen8CreateRequest(request(ipfs), 56, ENV).fields.logoURI, ipfs, "ipfs stays allowed");
});

test("data: and http: logos are refused by both sides", () => {
  const data = "data:image/png;base64,iVBORw0KGgo=";
  assert.throws(() => assertOnchainLogoUri(data), /not configured|uploaded/);
  assert.throws(() => parseGen8CreateRequest(request(data), 56, ENV), /https:\/\/ or ipfs:\/\//);
  const http = "http://vrnsbguutnwgtekcexls.supabase.co/storage/v1/object/public/MEMEBATTLES/logos/56/a.png";
  assert.throws(() => parseGen8CreateRequest(request(http), 56, ENV), /https:\/\/ or ipfs:\/\//, "http is not https");
});
