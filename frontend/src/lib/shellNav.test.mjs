import test from "node:test";
import assert from "node:assert/strict";
import {
  COINS_PATH,
  activeNavKey,
  activeWarzoneChild,
  buildMainNav,
  buildMobileTabs,
  resolveBackBar,
} from "./shellNav.mjs";

const ALL = { warzone: true, warRoom: true, imports: true };

test("menu order follows the design and only names existing routes", () => {
  assert.deepEqual(buildMainNav(ALL).map((i) => i.path), [COINS_PATH, "/warzone", "/league", "/war-room", "/profile", "/import"]);
  assert.deepEqual(buildMainNav({ ...ALL, homeFeed: true })[0], { key: "home", label: "Home", path: "/", icon: "home" });
  const warzone = buildMainNav(ALL).find((i) => i.key === "warzone");
  assert.deepEqual(warzone.children.map((c) => c.path), ["/warzone", "/warzone/battles", "/warzone/tournaments", "/warzone/major-war-league"]);
});

test("flags hide exactly the items they gate, as the old menu did", () => {
  assert.deepEqual(buildMainNav({}).map((i) => i.key), ["coins", "leagues", "profile"]);
});

test("every old menu destination is still reachable from the new menu", () => {
  const paths = new Set();
  for (const item of buildMainNav(ALL)) {
    paths.add(item.path);
    for (const child of item.children || []) paths.add(child.path);
  }
  // Old LeftBattleSidebar + drawer: Launchpad "/", Leagues, Import, Warzone x4, War Trade Room, Profile, Create.
  // "/" is reached through the logo and through Coins (same page); /create is the Launch a coin button.
  for (const p of ["/league", "/import", "/warzone", "/warzone/battles", "/warzone/tournaments", "/warzone/major-war-league", "/war-room", "/profile"]) {
    assert.ok(paths.has(p), p);
  }
});

test("until the feed ships, / belongs to Coins", () => {
  assert.equal(activeNavKey("/"), "coins");
  assert.equal(activeNavKey("/coins"), "coins");
  assert.equal(activeNavKey("/", { homeFeed: true }), "home");
  assert.equal(activeNavKey("/feed", { homeFeed: true }), "home");
});

test("active item per route", () => {
  assert.equal(activeNavKey("/warzone/battles/abc"), "warzone");
  assert.equal(activeNavKey("/arena/battles"), "warzone");
  assert.equal(activeNavKey("/leagues"), "leagues");
  assert.equal(activeNavKey("/war-room"), "war-room");
  assert.equal(activeNavKey("/profile/0xabc/command/claims"), "profile");
  assert.equal(activeNavKey("/profile"), "profile");
  assert.equal(activeNavKey("/profile/0xabc"), null);
  assert.equal(activeNavKey("/token/0xabc"), null);
  assert.equal(activeWarzoneChild("/warzone"), "warzone-overview");
  assert.equal(activeWarzoneChild("/warzone/battles/x"), "warzone-battles");
  assert.equal(activeWarzoneChild("/warzone/tournaments/7"), "warzone-tournaments");
  assert.equal(activeWarzoneChild("/warzone/major-war-league"), "warzone-mwl");
});

test("back bar only on pages without a menu item", () => {
  assert.deepEqual(resolveBackBar("/token/0xabc"), { title: "Coin", fallback: COINS_PATH });
  assert.equal(resolveBackBar("/warzone/battles/arena-1").title, "Battle");
  assert.equal(resolveBackBar("/battle/9").title, "Battle");
  assert.equal(resolveBackBar("/profile/someone").title, "Profile");
  assert.equal(resolveBackBar("/recruiters/OG1").title, "Recruiter");
  assert.equal(resolveBackBar("/squads").title, "Squads");
  for (const p of ["/", "/coins", "/warzone", "/warzone/battles", "/league", "/profile", "/profile/0xabc/command", "/story/101/x"]) {
    assert.equal(resolveBackBar(p), null, p);
  }
});

test("mobile tabs put create in the middle when Home is present", () => {
  assert.deepEqual(buildMobileTabs({ warzone: true, homeFeed: true }).map((t) => t.key), ["home", "coins", "create", "warzone", "profile"]);
  assert.deepEqual(buildMobileTabs({ warzone: true }).map((t) => t.key), ["coins", "create", "warzone", "profile"]);
});
