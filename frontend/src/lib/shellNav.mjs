/**
 * App shell navigation (UI redesign, phase 0). Pure: which menu items exist, which one is
 * active for a path, and which pages get a back bar instead of a menu item.
 *
 * Every path here is a route that already exists (BUILD_PLAN Appendix B) plus `/coins`
 * (founder decision D1, 2026-10-02). Home (`/` as the feed) appears only once the feed ships;
 * until then `/` still renders Coins.
 */

export const COINS_PATH = "/coins";

/** Menu Profile goes to the connected wallet's public profile (founder, 2026-10-02); `/profile` without one. */
export function profilePath(ownWallet) {
  const w = String(ownWallet || "").trim();
  return w ? `/profile/${encodeURIComponent(w)}` : "/profile";
}

function isOwnProfilePath(path, ownWallet) {
  const w = String(ownWallet || "").trim();
  const m = /^\/profile\/([^/]+)$/.exec(path);
  if (!w || !m) return false;
  const seg = decodeURIComponent(m[1]);
  return /^0x/i.test(w) ? seg.toLowerCase() === w.toLowerCase() : seg === w;
}

/**
 * @param {{ warzone?: boolean, warRoom?: boolean, imports?: boolean, homeFeed?: boolean, ownWallet?: string | null }} flags
 */
export function buildMainNav({ warzone = false, warRoom = false, imports = false, homeFeed = false, ownWallet = null } = {}) {
  const items = [];
  if (homeFeed) items.push({ key: "home", label: "Home", path: "/", icon: "home" });
  items.push({ key: "coins", label: "Coins", path: COINS_PATH, icon: "coins" });
  if (warzone) {
    items.push({
      key: "warzone",
      label: "Warzone",
      path: "/warzone",
      icon: "warzone",
      children: [
        { key: "warzone-overview", label: "Overview", path: "/warzone" },
        { key: "warzone-battles", label: "Battles", path: "/warzone/battles" },
        { key: "warzone-tournaments", label: "Tournaments", path: "/warzone/tournaments" },
        { key: "warzone-mwl", label: "Major War League", path: "/warzone/major-war-league" },
      ],
    });
  }
  items.push({ key: "leagues", label: "Leagues", path: "/league", icon: "leagues" });
  if (warRoom) items.push({ key: "war-room", label: "War Trade Room", path: "/war-room", icon: "warRoom" });
  items.push({ key: "profile", label: "Profile", path: profilePath(ownWallet), icon: "profile" });
  if (imports) items.push({ key: "import", label: "Import memecoin", path: "/import", icon: "import" });
  return items;
}

/** Mobile bottom bar: up to two items, the create button, then up to two items. */
export function buildMobileTabs(flags = {}) {
  const tabs = [];
  if (flags.homeFeed) tabs.push({ key: "home", label: "Home", path: "/", icon: "home" });
  tabs.push({ key: "coins", label: "Coins", path: COINS_PATH, icon: "coins" });
  tabs.push({ key: "create", label: "Create", icon: "plus" });
  if (flags.warzone) tabs.push({ key: "warzone", label: "Warzone", path: "/warzone", icon: "warzone" });
  tabs.push({ key: "profile", label: "Profile", path: profilePath(flags.ownWallet), icon: "profile" });
  return tabs;
}

function under(pathname, base) {
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** Which top-level item is lit for a path. `homeFeed` decides who owns `/`. */
export function activeNavKey(pathname, { homeFeed = false, ownWallet = null } = {}) {
  const path = String(pathname || "/").replace(/\/+$/, "") || "/";
  if (path === "/") return homeFeed ? "home" : "coins";
  if (path === "/feed") return homeFeed ? "home" : null;
  if (under(path, COINS_PATH)) return "coins";
  if (under(path, "/warzone") || under(path, "/arena")) return "warzone";
  if (path === "/league" || path === "/leagues") return "leagues";
  if (under(path, "/war-room")) return "war-room";
  if (under(path, "/import")) return "import";
  if (isOwnProfilePath(path, ownWallet)) return "profile";
  if (path === "/profile" || /^\/profile\/[^/]+\/command(\/|$)/.test(path) || under(path, "/command")) return "profile";
  return null;
}

/** Which Warzone sub-item is lit. Overview only on the overview itself. */
export function activeWarzoneChild(pathname) {
  const path = String(pathname || "").replace(/\/+$/, "");
  if (path === "/warzone" || path === "/arena") return "warzone-overview";
  if (under(path, "/warzone/battles")) return "warzone-battles";
  if (under(path, "/warzone/tournaments") || under(path, "/warzone/tournament")) return "warzone-tournaments";
  if (under(path, "/warzone/major-war-league")) return "warzone-mwl";
  return null;
}

/**
 * Pages without a menu item get a back bar (BUILD_PLAN §3): coin page, battle, public profile,
 * recruiter, squads. `fallback` is where Back goes when there is no in-app history.
 * Your own public profile is the menu Profile page, so it has no back bar.
 * @returns {{ title: string, fallback: string } | null}
 */
export function resolveBackBar(pathname, { ownWallet = null } = {}) {
  const path = String(pathname || "").replace(/\/+$/, "");
  if (isOwnProfilePath(path, ownWallet)) return null;
  if (/^\/token\/[^/]+$/.test(path)) return { title: "Coin", fallback: COINS_PATH };
  if (/^\/token\/[^/]+\/edit$/.test(path)) return { title: "Edit coin page", fallback: COINS_PATH };
  if (/^\/warzone\/battles\/[^/]+$/.test(path) || /^\/battle\/[^/]+$/.test(path)) {
    return { title: "Battle", fallback: "/warzone/battles" };
  }
  if (/^\/profile\/[^/]+$/.test(path)) return { title: "Profile", fallback: COINS_PATH };
  if (/^\/recruiters\/[^/]+$/.test(path)) return { title: "Recruiter", fallback: "/recruiters" };
  if (path === "/squads") return { title: "Squads", fallback: COINS_PATH };
  return null;
}
