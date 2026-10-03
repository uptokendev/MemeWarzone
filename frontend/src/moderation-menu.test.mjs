import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, rel), "utf8");

// CO-30 (founder, 2026-10-03): every post and comment has the "…" menu top right with Report,
// Hide and Block; blocking never touches coin pages or trading; profiles have it too.
test("every post and comment surface mounts the item menu and filters hidden / blocked items", () => {
  const cards = read("components/feed/FeedCards.tsx");
  assert.match(cards, /<ItemMenu[\s\S]*?type: "post", id: item\.postId/);
  assert.match(cards, /moderation\.isBlocked\(item\.wallet\)/);
  assert.match(cards, /hide=\{\{ type: "coin_post", id: item\.id \}\}/);

  const thread = read("pages/PostThread.tsx");
  assert.match(thread, /subject: "Reported comment"/);
  assert.match(thread, /replies\.filter\(\(r\) => !moderation\.isHidden\("post", r\.postId\) && !moderation\.isBlocked\(r\.wallet\)\)/);

  assert.match(read("components/token/TokenComments.tsx"), /hide=\{\{ type: "comment", id: c\.id \}\}/);
  assert.match(read("pages/BattlePage.tsx"), /moderation\.isHidden\("battle_comment", comment\.id\)/);
  assert.match(read("components/token/CoinPageSocial.tsx"), /hide=\{\{ type: "coin_post", id: item\.id \}\}/);
});

test("coin updates are posted as the coin: Report and Hide only, never Block", () => {
  const cards = read("components/feed/FeedCards.tsx");
  const coinCard = cards.slice(cards.indexOf("export function FeedCoinPostCard"), cards.indexOf("export function FeedCoinPostCard") + 2200);
  assert.doesNotMatch(coinCard, /author=\{/);
  const coinPage = read("components/token/CoinPageSocial.tsx");
  const menu = coinPage.slice(coinPage.indexOf("<ItemMenu"), coinPage.indexOf("<ItemMenu") + 400);
  assert.doesNotMatch(menu, /author=\{/);
});

test("profiles: Report profile and Block in the menu, blocked view keeps only banner and picture with Unblock", () => {
  const profile = read("pages/PublicProfile.tsx");
  assert.match(profile, /entityType: "profile", subject: "Reported profile"/);
  assert.match(profile, /data-profile-blocked-view="true"/);
  assert.match(profile, /This user is blocked/);
  assert.match(profile, /moderation\.unblock\(profileWallet\)/);
  assert.match(read("pages/command-center/CommandCenterSettings.tsx"), /<BlockedAccountsCard \/>/);
});

// Founder, 2026-10-03: your own post or reply gets Delete in the "…" menu, on the feed session.
test("own posts and replies can be deleted from the … menu", () => {
  const read = (p) => fs.readFileSync(new URL(`./${p}`, import.meta.url), "utf8");
  assert.match(read("components/moderation/ItemMenu.tsx"), /if \(own\) return onDelete \? <OwnItemMenu/);
  assert.match(read("components/feed/FeedCards.tsx"), /onDelete=\{removeOwn\}/);
  assert.match(read("pages/PostThread.tsx"), /deleteFeedPost\(Number\(post\.postId\), token\)/);
  assert.match(read("pages/PostThread.tsx"), /deleteFeedPost\(Number\(r\.postId\), token\)/);
  assert.match(fs.readFileSync(new URL("../api/feed/posts.js", import.meta.url), "utf8"), /async function handleDelete[\s\S]{0,600}feedSession\.requireSession/);
});
