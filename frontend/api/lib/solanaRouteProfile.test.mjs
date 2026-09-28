import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOLANA_ROUTE_PROFILE, isSolanaRouteProfile, resolveSolanaRouteProfileStrict } from "./solanaRouteProfile.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const fakeDb = (rows) => ({ query: async (sql, params) => ({ rows, sql, params }) });

test("ids match the program constants", () => {
  const lib = fs.readFileSync(path.join(repo, "programs/memewarzone_solana/src/lib.rs"), "utf8");
  assert.match(lib, /pub const ROUTE_PROFILE_LINKED: u8 = 0;/);
  assert.match(lib, /pub const ROUTE_PROFILE_UNLINKED: u8 = 1;/);
  assert.match(lib, /pub const ROUTE_PROFILE_OG: u8 = 2;/);
  assert.deepEqual(SOLANA_ROUTE_PROFILE, { LINKED: 0, UNLINKED: 1, OG: 2 });
});

test("unlinked, linked and OG creators", async () => {
  assert.equal(await resolveSolanaRouteProfileStrict(fakeDb([]), "W"), SOLANA_ROUTE_PROFILE.UNLINKED);
  assert.equal(await resolveSolanaRouteProfileStrict(fakeDb([{ is_og: false }]), "W"), SOLANA_ROUTE_PROFILE.LINKED);
  assert.equal(await resolveSolanaRouteProfileStrict(fakeDb([{ is_og: true }]), "W"), SOLANA_ROUTE_PROFILE.OG);
});

test("a database error throws instead of falling back to unlinked", async () => {
  const broken = { query: async () => { throw new Error("connection lost"); } };
  await assert.rejects(resolveSolanaRouteProfileStrict(broken, "W"), /connection lost/);
  await assert.rejects(resolveSolanaRouteProfileStrict(null, "W"), /no database/);
  await assert.rejects(resolveSolanaRouteProfileStrict(fakeDb([]), ""), /no wallet/);
});

test("same lookup as trade signing", () => {
  const trade = fs.readFileSync(path.join(repo, "frontend/api/dev-fix/solana-trade-authorization-v1.js"), "utf8");
  const mine = fs.readFileSync(path.join(here, "solanaRouteProfile.js"), "utf8");
  const norm = (s) => s.replace(/\s+/g, " ");
  const query = "select r.is_og from public.wallet_recruiter_links l join public.recruiters r on r.id = l.recruiter_id where l.wallet_address = $1 limit 1";
  assert.ok(norm(trade).includes(query), "trade signing query changed; update the graduation lookup to match");
  assert.ok(norm(mine).includes(query));
});

test("no graduation path hard-codes a route profile", () => {
  const operator = fs.readFileSync(path.join(repo, "scripts/solana/graduate-campaign.mjs"), "utf8");
  const api = fs.readFileSync(path.join(repo, "frontend/api/dev-fix/solana-graduation-authorization-v2.js"), "utf8");
  assert.doesNotMatch(operator, /finalizeRouteProfile:\s*ROUTE_PROFILE_UNLINKED/);
  assert.doesNotMatch(api, /const finalizeRouteProfile = ROUTE_PROFILE_UNLINKED;/);
  assert.ok(isSolanaRouteProfile(1) && !isSolanaRouteProfile(3) && !isSolanaRouteProfile("1"));
});
