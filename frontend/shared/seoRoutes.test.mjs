import test from "node:test";
import assert from "node:assert/strict";
import { APP_ORIGIN, ROUTE_RULES, matchRoute, headForPath, aliasTarget, canonicalForToken } from "./seoRoutes.mjs";

const INDEX = [
  "/", "/coins", "/warzone", "/warzone/battles", "/warzone/major-war-league", "/warzone/tournaments",
  "/league", "/war-room", "/airdrops", "/airdrops/winners", "/recruiters", "/squads", "/playbook",
  "/sponsorships/apply", "/create",
  "/token/0xAbC0000000000000000000000000000000000001", "/token/So11111111111111111111111111111111111111112",
  "/warzone/battles/123", "/warzone/tournaments/7", "/prepare/my-coin", "/post/55", "/recruiters/ABC123",
  "/profile/0xabc", "/profile/7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
];
const NOINDEX = [
  "/profile", "/profile/0xabc/command", "/profile/0xabc/command/coins/x", "/profile/0xabc/other",
  "/command", "/command/overview", "/command/support/reports/9", "/recruiter-dashboard", "/squad-dashboard",
  "/drafts/1/promotion", "/drafts/1/push-live", "/token/0xabc/edit", "/live", "/import", "/recruiter",
  "/recruiter/signup", "/warzone/verify-email", "/status", "/embed/chart/101/abc", "/story/101/abc",
  "/r/CODE",
];
const ALIASES = {
  "/leagues": "/league", "/feed": "/", "/docs": "/playbook", "/arena": "/warzone",
  "/arena/battles": "/warzone/battles", "/arena/battles/5": "/warzone/battles/5",
  "/warzone/leagues": "/warzone/major-war-league", "/events": "/warzone/tournaments",
  "/warzone/events": "/warzone/tournaments", "/tournament/9": "/warzone/tournaments/9",
  "/warzone/tournament/9": "/warzone/tournaments/9", "/battle/42": "/warzone/battles/42",
  "/command/feed": "/",
};

test("APP_ORIGIN", () => assert.equal(APP_ORIGIN, "https://app.memewar.zone"));

for (const p of INDEX) test(`index: ${p}`, () => {
  assert.equal(matchRoute(p).kind, "index");
  const h = headForPath(p);
  assert.equal(h.robots, "index,follow");
  assert.ok(h.title && h.description);
});
for (const p of NOINDEX) test(`noindex: ${p}`, () => {
  assert.equal(matchRoute(p).kind, "noindex");
  const h = headForPath(p);
  assert.match(h.robots, /^noindex/);
  assert.equal(h.canonical, null);
});
for (const [from, to] of Object.entries(ALIASES)) test(`alias: ${from} -> ${to}`, () => {
  assert.equal(matchRoute(from).kind, "alias");
  assert.equal(aliasTarget(from), to);
});
test("aliasTarget is null for non-alias", () => {
  assert.equal(aliasTarget("/league"), null);
  assert.equal(aliasTarget("/nope"), null);
});
test("alias trailing slash and query ignored in matching", () => {
  assert.equal(aliasTarget("/battle/42/"), "/warzone/battles/42");
  assert.equal(aliasTarget("/battle/42?x=1"), "/warzone/battles/42");
});

test("canonical strips query and trailing slash", () => {
  assert.equal(headForPath("/warzone/battles/?a=1#x").canonical, `${APP_ORIGIN}/warzone/battles`);
  assert.equal(headForPath("/league/").canonical, `${APP_ORIGIN}/league`);
  assert.equal(headForPath("/").canonical, `${APP_ORIGIN}/`);
  assert.equal(headForPath("/coins?q=doge").canonical, `${APP_ORIGIN}/coins`);
});
test("override canonical wins over default", () => {
  const c = canonicalForToken("0xAbC0000000000000000000000000000000000001", 4663);
  const h = headForPath("/token/0xabc0000000000000000000000000000000000001?chainId=4663", { canonical: c, title: "Doge" });
  assert.equal(h.canonical, c);
  assert.equal(h.title, "Doge");
  assert.equal(h.robots, "index,follow");
});
test("override cannot make a noindex route indexable", () => {
  const h = headForPath("/live", { canonical: `${APP_ORIGIN}/live` });
  assert.match(h.robots, /^noindex/);
  assert.equal(h.canonical, null);
});
test("unknown path is noindex page not found", () => {
  const h = headForPath("/definitely/not/a/page");
  assert.match(h.robots, /^noindex/);
  assert.equal(h.title, "Page not found");
  assert.equal(h.canonical, null);
});

test("canonicalForToken", () => {
  const evm = "0xAbC0000000000000000000000000000000000001";
  assert.equal(canonicalForToken(evm, 56), `${APP_ORIGIN}/token/${evm.toLowerCase()}`);
  assert.equal(canonicalForToken(evm, 4663), `${APP_ORIGIN}/token/${evm.toLowerCase()}?chainId=4663`);
  const mint = "So11111111111111111111111111111111111111112";
  assert.equal(canonicalForToken(mint, 101), `${APP_ORIGIN}/token/${mint}`);
  assert.equal(canonicalForToken(mint, "101"), `${APP_ORIGIN}/token/${mint}`);
  assert.equal(canonicalForToken("", 56), null);
});

test("copy rules", () => {
  for (const r of ROUTE_RULES) {
    for (const s of [r.title, r.description]) if (s) assert.doesNotMatch(s, /[–—]/, r.pattern);
    if (r.kind === "index" && r.description) {
      assert.ok(r.description.length >= 120 && r.description.length <= 160, `${r.pattern} desc ${r.description.length}`);
    }
    if (r.kind === "alias") assert.ok(r.aliasTo, r.pattern);
  }
});
