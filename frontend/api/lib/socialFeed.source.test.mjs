import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

function readRepo(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

test("social_posts migration keeps Solana case and caps body at 280", () => {
  const sql = readRepo("db/migrations/20261001_000002_social_posts.sql");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.social_posts/);
  assert.match(sql, /char_length\(body\) <= 280/);
  assert.doesNotMatch(sql, /author_address.+lower/i);
  assert.doesNotMatch(sql, /CHECK \(author_address = lower/i);
});

test("timeline omits private drafts and mixes deploy plus trades", () => {
  const src = readRepo("frontend/api/lib/socialTimeline.js");
  assert.match(src, /d\.visibility = 'public'/);
  assert.match(src, /from public\.campaigns c/);
  assert.match(src, /from public\.curve_trades t/);
  assert.match(src, /type: "draft_created"/);
  assert.match(src, /type: "coin_deployed"/);
  assert.doesNotMatch(src, /and \(.*chain_id.*=.*\$\d+.*\)\s*from public\.user_follows/s);
});

test("following feed uses user_follows without a chain filter", () => {
  const src = readRepo("frontend/api/lib/socialTimeline.js");
  const fn = src.slice(src.indexOf("export async function loadFollowingAddresses"));
  assert.match(fn, /from public\.user_follows/);
  assert.doesNotMatch(fn.slice(0, 500), /chain_id/);
});

test("portfolio endpoint fails closed with metrics null and no stub zeros", () => {
  const src = readRepo("frontend/api/profile/portfolio.js");
  assert.doesNotMatch(src, /portfolio endpoint is stubbed/);
  assert.match(src, /metrics: null/);
  assert.match(src, /holdingsCount: positiveBalanceCount/);
  assert.match(src, /getParsedTokenAccountsByOwner/);
});

test("unsigned posts are rejected and deleted posts stay out of For you", () => {
  const src = readRepo("frontend/api/feed/posts.js");
  assert.match(src, /if \(!signature\) return json\(res, 400, \{ error: "Signature missing" \}\)/);
  assert.match(src, /where p\.status = 0/);
  assert.match(src, /tab === "following"/);
  assert.match(src, /loadFollowingAddresses\(viewer\)/);
});

test("FeedComposer is mounted on Feed, Command Center, and Public Profile", () => {
  const feed = readRepo("frontend/src/pages/Feed.tsx");
  const command = readRepo("frontend/src/pages/command-center/CommandCenterFeed.tsx");
  const profile = readRepo("frontend/src/pages/PublicProfile.tsx");
  assert.match(feed, /<FeedComposer /);
  assert.match(command, /<FeedComposer /);
  assert.match(profile, /<FeedComposer /);
  assert.match(feed, /For you/);
  assert.match(feed, /Following/);
});

test("Command Center keeps the feed section on wallet-mismatch redirects", () => {
  const src = readRepo("frontend/src/components/command-center/CommandCenterShell.tsx");
  assert.match(src, /"feed"/);
});
