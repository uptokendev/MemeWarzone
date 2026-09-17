import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const claimSource = await readFile(new URL("./projectImportXClaim.js", import.meta.url), "utf8");
const routeSource = await readFile(new URL("../projectImportXClaim.js", import.meta.url), "utf8");

test("Pump claim metadata keeps Metaplex first and falls back to Token-2022 mint metadata", () => {
  assert.match(claimSource, /getTokenMetadata/);
  assert.match(claimSource, /TOKEN_2022_PROGRAM_ID/);
  assert.match(claimSource, /metadataSource: "pump_metaplex_metadata"/);
  assert.match(claimSource, /metadataSource: "pump_token2022_metadata"/);
  assert.match(claimSource, /const account = await connection\.getAccountInfo\(metadataAddress[\s\S]*getTokenMetadata\(connection, mintKey/);
});

test("import image recovery prefers DexScreener then falls back to Solana program metadata", () => {
  assert.match(claimSource, /export async function resolveProjectImportImage/);
  assert.match(claimSource, /readDexScreenerPairs\(chainId, tokenAddress\)/);
  assert.match(claimSource, /if \(Number\(chainId\) === SOLANA_CHAIN_ID\)[\s\S]*readSolanaMetadataJson\(tokenAddress\)/);
  assert.match(claimSource, /metadata\?\.json\?\.image/);
});

test("X resolve backfills missing imported image without granting ownership", () => {
  assert.match(routeSource, /backfillProjectImage/);
  assert.match(routeSource, /image_url=\$2/);
  assert.match(routeSource, /image_url IS NULL OR btrim\(image_url\)=''/);
  assert.match(routeSource, /resolveProjectImportImage/);
  assert.doesNotMatch(routeSource, /ownership_status='ownership_verified'[\s\S]*backfillProjectImage/);
});

test("RapidLaunch Token-2022 metadata host remains explicitly allowlisted", () => {
  assert.match(claimSource, /ALLOWED_METADATA_HOSTS = new Set\(\[[\s\S]*"m\.rapidlaunch\.io"[\s\S]*\]\);/);
});


test("IPFS metadata uses working Pump/Pinata gateways and canonicalizes image URLs", () => {
  assert.match(claimSource, /IPFS_PRIMARY_GATEWAY = "https:\/\/pump\.mypinata\.cloud\/ipfs\/"/);
  assert.match(claimSource, /IPFS_FALLBACK_GATEWAY = "https:\/\/gateway\.pinata\.cloud\/ipfs\/"/);
  assert.match(claimSource, /function ipfsContentPath/);
  assert.match(claimSource, /function metadataFetchCandidates/);
  assert.match(claimSource, /for \(const metadataUrl of metadataFetchCandidates\(reference\.metadataUrl\)\)/);
  assert.match(claimSource, /const path = ipfsContentPath\(value\);[\s\S]*if \(path\) return ipfsGatewayUrl\(path\)/);
});
