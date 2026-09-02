import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.join(here, "..");
const frontendRoot = path.join(apiRoot, "..");
const repoRoot = path.join(frontendRoot, "..");

function readFrom(root, rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function readApi(rel) {
  return readFrom(apiRoot, rel);
}

function readFrontend(rel) {
  return readFrom(frontendRoot, rel);
}

function readRepo(rel) {
  return readFrom(repoRoot, rel);
}

test("Phase 9 migration is additive, URL-only, and keeps import writes service-role", () => {
  const migration = readRepo("db/migrations/20260903_000001_arena_import_token_profile_v2.sql");
  for (const column of ["image_url", "description", "website", "x_url", "telegram_url", "verified_at", "metadata_updated_at"]) {
    assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`, "i"));
  }
  assert.match(migration, /image_url_not_data/i);
  assert.match(migration, /image_url\s+IS\s+NULL\s+OR\s+image_url\s+!~\*\s+'\^data:'/i);
  assert.match(migration, /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.arena_token_imports FROM anon, authenticated/i);
  assert.match(migration, /token_metadata_registry/i);
});

test("import image upload authorizes against stored owner and validates actual bytes", () => {
  const upload = readApi("upload.js");
  assert.match(upload, /kind === ["']arena_import["']/);
  assert.match(upload, /loadArenaImport\(importId\)/);
  assert.match(upload, /address = normalizeUploadAddress\(arenaImport\.owner_wallet, chainId\)/);
  assert.match(upload, /action:\s*defaultAction/);
  assert.match(upload, /arena_import_image/);
  assert.match(upload, /inspectImageFile\(buf/);
  assert.match(upload, /arena-imports\/\$\{chainId\}\/\$\{importId\}\/\$\{uuid\}/);
  assert.match(upload, /persistArenaImportImage/);
  assert.match(upload, /set image_url = \$1/i);
  assert.match(upload, /if \(kind === ["']arena_import["']\) \{\s*return bad\(res, 503, ["']Imported token image storage is not configured["']\)/s);
});

test("normalized Arena token profile enriches UI without inventing price parity", () => {
  const profile = readApi("lib/arenaTokenProfile.js");
  assert.match(profile, /getArenaMarketSnapshot/);
  assert.match(profile, /origin:\s*["']import["']/);
  assert.match(profile, /origin:\s*["']native["']/);
  assert.match(profile, /priceUsd:\s*null/);
  assert.match(profile, /safeImage/);
  assert.doesNotMatch(profile, /data:image/i);
});

test("Phase 9 rollout is centralized, owner-only, and uses explicit upload labels", () => {
  const config = readFrontend("src/features/postgrad/config.ts");
  const component = readFrontend("src/components/arena/ArenaImportImageUpload.tsx");
  assert.match(config, /importImageUpload:\s*arenaEnabled\s*&&\s*readFlag\(import\.meta\.env\.VITE_ARENA_IMPORT_IMAGE_UPLOAD, false\)/);
  assert.match(component, /postGradFlags\.importImageUpload/);
  assert.match(component, /isOwner/);
  assert.match(component, /UPLOAD TOKEN IMAGE/);
  assert.match(component, /REPLACE TOKEN IMAGE/);
  assert.match(component, /arena_import_image/);
});

test("Battle combat cards hydrate metadata through normalized Arena token profile", () => {
  const card = readFrontend("src/components/arena/BattleCombatantCard.tsx");
  assert.match(card, /useArenaTokenProfile/);
  assert.match(card, /profile\?\.imageUrl/);
  assert.match(card, /profile\?\.creatorWallet/);
  assert.match(card, /profile\?\.origin === ["']native["']/);
  assert.match(card, /metricsSide\?\.points\.total/);
});

test("touched import lookup paths preserve Solana Base58 case", () => {
  const imports = readApi("arenaImports.js");
  assert.match(imports, /isSolanaChain\(chainId\)[\s\S]*token_address::text = \$2/);
  assert.match(imports, /solanaLookup \? ["']token_address = \$1["']/);
  assert.match(imports, /exactOwner \? `owner_wallet = \$\$\{values\.length\}`/);
});
