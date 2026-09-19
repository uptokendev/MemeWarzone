import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./projectImportResolverAdapters.js", import.meta.url), "utf8");

test("Solana imported-token display metadata supports Token-2022 without replacing Metaplex-first authority", () => {
  assert.match(source, /getTokenMetadata/);
  assert.match(source, /TOKEN_2022_PROGRAM_ID/);
  assert.match(source, /resolveMetaplexMetadata/);
  assert.match(source, /resolveToken2022Metadata/);
  assert.match(source, /const metaplex = await resolveMetaplexMetadata[\s\S]*if \(metaplex\) return metaplex;[\s\S]*resolveToken2022Metadata/);
  assert.match(source, /source: "token_2022"/);
  assert.match(source, /type: "metadata_extension"/);
});
