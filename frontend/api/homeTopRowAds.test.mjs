import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// CO-21: the Home ad row (slot home-top-row) has its own prices, a banner image and 6 spots.
process.env.DATABASE_URL ||= "postgres://user:pass@127.0.0.1:1/none";
const { listPackagesForSlot, normalizePackageSlot } = await import("./sponsorship-packages.js");
const { packageFitsSlot } = await import("./sponsorship-applications.js");
const sponsored = await readFile(new URL("./sponsored.js", import.meta.url), "utf8");
const migration = await readFile(new URL("../../db/migrations/20261003_000003_home_top_row_ad_slot.sql", import.meta.url), "utf8");

const rows = [
  { code: "d3", slotCode: null, priceUsd: 49 },
  { code: "w1", slotCode: null, priceUsd: 99 },
  { code: "htr-d3", slotCode: "home-top-row", priceUsd: 25 },
];
const fakeDb = (list) => ({ query: async () => ({ rows: list }) });

test("no slot returns exactly the every-slot packages (today's list), never a slot's own prices", async () => {
  const items = await listPackagesForSlot(fakeDb(rows), "");
  assert.deepEqual(items.map((r) => r.code), ["d3", "w1"]);
});

test("a slot with its own packages gets only those; a slot without falls back to the shared list", async () => {
  assert.deepEqual((await listPackagesForSlot(fakeDb(rows), "home-top-row")).map((r) => r.code), ["htr-d3"]);
  assert.deepEqual((await listPackagesForSlot(fakeDb(rows), "featured-top-left")).map((r) => r.code), ["d3", "w1"]);
});

test("slot parameter is normalised and anything odd is ignored", () => {
  assert.equal(normalizePackageSlot(" Home-Top-Row "), "home-top-row");
  assert.equal(normalizePackageSlot("x'; drop table"), "");
  assert.equal(normalizePackageSlot(undefined), "");
});

test("a slot's own package cannot be booked for another slot", () => {
  assert.equal(packageFitsSlot(null, "featured-top-left"), true);
  assert.equal(packageFitsSlot("home-top-row", "home-top-row"), true);
  assert.equal(packageFitsSlot("home-top-row", "featured-top-left"), false);
});

test("sponsored feed: bannerUrl without depending on the column, 6-spot cap, priority desc, no house ad", () => {
  assert.match(sponsored, /nullif\(to_jsonb\(sp\) ->> 'banner_url', ''\) as "bannerUrl"/);
  assert.match(sponsored, /export const HOME_TOP_ROW_SPOTS = 6/);
  assert.match(sponsored, /slotFilter === HOME_TOP_ROW_SLOT \? HOME_TOP_ROW_SPOTS : 24/);
  assert.match(sponsored, /coalesce\(sp\.priority, 1000\) desc, sp\.starts_at asc nulls first/);
  assert.match(sponsored, /if \(slotFilter !== FEATURED_SLOT\) return items;/, "house ads stay Featured-only");
});

test("migration: slot_code + banner_url columns, ad row placeholder packages that never overwrite a price", () => {
  assert.match(migration, /alter table public\.sponsorship_packages add column if not exists slot_code text/);
  assert.match(migration, /alter table public\.sponsored_placements add column if not exists banner_url text/);
  assert.match(migration, /'htr-w1', '1 week',\s+7,\s+49\.00, 20, 'home-top-row'/);
  assert.doesNotMatch(migration.split("on conflict (code) do update set")[1], /price_usd/);
});

test("apply form and dialog show the image size of the chosen slot (CO-21)", async () => {
  const creative = await readFile(new URL("../src/lib/sponsorCreative.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("../src/pages/SponsorshipApplication.tsx", import.meta.url), "utf8");
  const dialog = await readFile(new URL("../src/components/home/SponsorshipApplyDialog.tsx", import.meta.url), "utf8");
  assert.match(creative, /FEATURED_SPONSOR_CREATIVE_W = 600;[\s\S]*FEATURED_SPONSOR_CREATIVE_H = 488;/, "redesign Featured card 300x244 at 2x");
  assert.match(creative, /uploadW: 480,\s*uploadH: 180,/, "Home top row banner 8:3 at 2x");
  assert.match(page, /const creativeSpec = sponsorCreativeSpec\(form\.preferredSlot\)/);
  assert.match(page, /\{creativeSpec\.copy\}/);
  assert.match(dialog, /sponsorCreativeSpec\(defaultSlot\)\.copy/);
});
