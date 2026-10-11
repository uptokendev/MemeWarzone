// Route SEO table shared by the app (head tags), the API (renderer, sitemap) and tests.
// Pure module: no DOM, no I/O. Titles omit the " · MemeWarzone" suffix; the caller appends it.
// Source of truth for kinds and aliases: docs/templar/specs/2026-10-11-app-seo.md section 1.3.

export const APP_ORIGIN = "https://app.memewar.zone";

const ROBOTS_INDEX = "index,follow";
const ROBOTS_NOINDEX = "noindex,follow";

/**
 * Pattern syntax: literal segments, `:name` (one segment), `**` (trailing, zero or more segments).
 * Alias targets reuse `:name` and `**` captured from the pattern.
 * Order matters: the first matching rule wins.
 * @typedef {{ pattern: string, kind: "index"|"noindex"|"alias", title?: string, description?: string, aliasTo?: string }} RouteRule
 */

/** @type {RouteRule[]} */
export const ROUTE_RULES = [
  // 301 aliases (nginx redirects them; the table keeps the targets in one place).
  { pattern: "/leagues", kind: "alias", aliasTo: "/league" },
  { pattern: "/feed", kind: "alias", aliasTo: "/" },
  { pattern: "/docs", kind: "alias", aliasTo: "/playbook" },
  { pattern: "/arena", kind: "alias", aliasTo: "/warzone" },
  { pattern: "/arena/**", kind: "alias", aliasTo: "/warzone/**" },
  { pattern: "/warzone/leagues", kind: "alias", aliasTo: "/warzone/major-war-league" },
  { pattern: "/events", kind: "alias", aliasTo: "/warzone/tournaments" },
  { pattern: "/warzone/events", kind: "alias", aliasTo: "/warzone/tournaments" },
  { pattern: "/tournament/:id", kind: "alias", aliasTo: "/warzone/tournaments/:id" },
  { pattern: "/warzone/tournament/:id", kind: "alias", aliasTo: "/warzone/tournaments/:id" },
  { pattern: "/battle/:id", kind: "alias", aliasTo: "/warzone/battles/:id" },
  { pattern: "/command/feed", kind: "alias", aliasTo: "/" },

  // Index, fixed URLs.
  {
    pattern: "/", kind: "index",
    title: "Memecoin launchpad and battles on BNB Chain, Solana and Robinhood Chain",
    description: "MemeWarzone is a memecoin launchpad on BNB Chain, Solana and Robinhood Chain. Launch a coin, trade it on its bonding curve and enter coin battles.",
  },
  {
    pattern: "/coins", kind: "index",
    title: "Memecoins on BNB Chain, Solana and Robinhood Chain",
    description: "Browse memecoins launched on MemeWarzone across BNB Chain, Solana and Robinhood Chain. Search by name or symbol and sort by market cap, volume or age.",
  },
  {
    pattern: "/warzone", kind: "index",
    title: "Warzone",
    description: "The Warzone is where graduated memecoins on BNB Chain, Solana and Robinhood Chain battle each other. See live battles, tournaments and league standings.",
  },
  {
    pattern: "/warzone/battles", kind: "index",
    title: "Coin battles",
    description: "Live, queued and finished coin battles on MemeWarzone. Each battle pits two memecoins against each other, and the result is scored from market data.",
  },
  {
    pattern: "/warzone/major-war-league", kind: "index",
    title: "Major War League",
    description: "The Major War League ranks memecoins by points earned in MemeWarzone battles. See the current standings and how points are awarded across the season.",
  },
  {
    pattern: "/warzone/tournaments", kind: "index",
    title: "Tournaments",
    description: "Memecoin tournaments on MemeWarzone. See upcoming, running and finished brackets for coins on BNB Chain, Solana and Robinhood Chain, with results.",
  },
  {
    pattern: "/league", kind: "index",
    title: "League standings",
    description: "MemeWarzone league standings for coins and players. See the current rankings, points earned from battles and the rewards tied to each league period.",
  },
  {
    pattern: "/war-room", kind: "index",
    title: "War Room",
    description: "The MemeWarzone War Room shows live market data for memecoins in battle. Follow prices, volume and trades on BNB Chain, Solana and Robinhood Chain.",
  },
  {
    pattern: "/airdrops", kind: "index",
    title: "Airdrops",
    description: "MemeWarzone airdrops reward traders and holders of listed memecoins. See which airdrops are open, how to qualify and the schedule for each campaign.",
  },
  {
    pattern: "/airdrops/winners", kind: "index",
    title: "Airdrop winners",
    description: "Winners of past MemeWarzone airdrops. See which wallets received rewards, how much each one received and which campaign the payout belonged to.",
  },
  {
    pattern: "/recruiters", kind: "index",
    title: "Recruiter leaderboard",
    description: "The MemeWarzone recruiter leaderboard ranks recruiters by the traders they bring in. See each recruiter's referrals, volume and earned rewards.",
  },
  {
    pattern: "/squads", kind: "index",
    title: "Squad leaderboard",
    description: "The MemeWarzone squad leaderboard ranks squads by trading activity and battle results. See squad size, points and standings for the current period.",
  },
  {
    pattern: "/playbook", kind: "index",
    title: "Playbook",
    description: "The MemeWarzone playbook explains how to launch a memecoin, how bonding curves and graduation work, and how battles, leagues and rewards are scored.",
  },
  {
    pattern: "/sponsorships/apply", kind: "index",
    title: "Apply for a sponsorship",
    description: "Apply for a MemeWarzone sponsorship for your memecoin. Describe the project and the placement you want, and the team reviews every application.",
  },
  {
    pattern: "/create", kind: "index",
    title: "Launch a memecoin",
    description: "Launch a memecoin on BNB Chain, Solana or Robinhood Chain from MemeWarzone. Set the name, symbol and image, then deploy it on a bonding curve.",
  },

  // Noindex: more specific than the per-entity rules below, so they come first.
  { pattern: "/token/:id/edit", kind: "noindex", title: "Edit coin" },
  { pattern: "/profile/:wallet/command/**", kind: "noindex", title: "Command center" },
  // Exact profile first: `/profile/:wallet/**` below also matches zero extra segments.
  {
    pattern: "/profile/:wallet", kind: "index",
    title: "Profile",
    description: "A MemeWarzone trader profile. See the memecoins launched, holdings, battle record and activity for this wallet across BNB Chain, Solana and Robinhood Chain.",
  },
  { pattern: "/profile/:wallet/**", kind: "noindex", title: "Profile" },
  { pattern: "/profile", kind: "noindex", title: "Profile" },
  { pattern: "/command", kind: "noindex", title: "Command center" },
  { pattern: "/command/**", kind: "noindex", title: "Command center" },
  { pattern: "/recruiter-dashboard", kind: "noindex", title: "Recruiter dashboard" },
  { pattern: "/squad-dashboard", kind: "noindex", title: "Squad dashboard" },
  { pattern: "/drafts/**", kind: "noindex", title: "Draft" },
  { pattern: "/live", kind: "noindex", title: "Live" },
  { pattern: "/import", kind: "noindex", title: "Import a coin" },
  { pattern: "/recruiter", kind: "noindex", title: "Recruiter" },
  { pattern: "/recruiter/signup", kind: "noindex", title: "Recruiter sign-up" },
  { pattern: "/warzone/verify-email", kind: "noindex", title: "Verify email" },
  { pattern: "/status", kind: "noindex", title: "Status" },
  { pattern: "/embed/**", kind: "noindex", title: "Embed" },
  { pattern: "/story/**", kind: "noindex", title: "Story" },
  { pattern: "/r/:code", kind: "noindex", title: "Referral" },

  // Index, per entity. Titles and descriptions are generic; the renderer passes real ones as overrides.
  {
    pattern: "/token/:id", kind: "index",
    title: "Memecoin",
    description: "Price, market cap, trades and holders for a memecoin launched on MemeWarzone. See its bonding curve progress, chart and battle record.",
  },
  {
    pattern: "/warzone/battles/:id", kind: "index",
    title: "Coin battle",
    description: "A MemeWarzone coin battle between two memecoins. See the matchup, the live score, the time left and the final result once the battle is resolved.",
  },
  {
    pattern: "/warzone/tournaments/:id", kind: "index",
    title: "Tournament",
    description: "A MemeWarzone tournament bracket. See the entered coins, each round's matchups, the schedule and the final results once the tournament ends.",
  },
  {
    pattern: "/prepare/:slug", kind: "index",
    title: "Upcoming memecoin",
    description: "A memecoin being prepared for launch on MemeWarzone. See its name, symbol, image and description before it goes live on its bonding curve.",
  },
  {
    pattern: "/post/:id", kind: "index",
    title: "Post",
    description: "A post from the MemeWarzone community feed. Read the post with its replies and see which memecoins and traders it mentions, plus when it was posted and how many people reacted.",
  },
  {
    pattern: "/recruiters/:code", kind: "index",
    title: "Recruiter profile",
    description: "A MemeWarzone recruiter profile. See the recruiter's referral count, trading volume brought in and rewards earned through the recruiter program.",
  },
];

const NOT_FOUND = Object.freeze({ title: "Page not found", description: "This page does not exist on MemeWarzone.", robots: ROBOTS_NOINDEX, canonical: null });

/** Split a raw path into clean segments: drops query, hash and empty segments. */
function segmentsOf(rawPath) {
  const path = String(rawPath ?? "").split(/[?#]/)[0];
  return path.split("/").filter(Boolean);
}

function matchPattern(pattern, segs) {
  const pSegs = pattern.split("/").filter(Boolean);
  const params = {};
  for (let i = 0; i < pSegs.length; i++) {
    const p = pSegs[i];
    if (p === "**") { params["**"] = segs.slice(i).join("/"); return params; }
    if (i >= segs.length) return null;
    if (p.startsWith(":")) params[p.slice(1)] = segs[i];
    else if (p !== segs[i]) return null;
  }
  return pSegs.length === segs.length ? params : null;
}

/**
 * First matching rule for a pathname (query, hash and trailing slash ignored).
 * @returns {(RouteRule & { params: Record<string, string> }) | null}
 */
export function matchRoute(pathname) {
  const segs = segmentsOf(pathname);
  for (const rule of ROUTE_RULES) {
    const params = matchPattern(rule.pattern, segs);
    if (params) return { ...rule, params };
  }
  return null;
}

/** Redirect target path for a 301 alias, or null when the path is not an alias. */
export function aliasTarget(pathname) {
  const rule = matchRoute(pathname);
  if (!rule || rule.kind !== "alias") return null;
  const out = String(rule.aliasTo)
    .split("/")
    .filter(Boolean)
    .map((seg) => (seg === "**" ? rule.params["**"] : seg.startsWith(":") ? rule.params[seg.slice(1)] : seg))
    .filter((seg) => seg !== "");
  return `/${out.join("/")}`;
}

function defaultCanonical(pathname) {
  const segs = segmentsOf(pathname);
  return `${APP_ORIGIN}/${segs.join("/")}`;
}

/**
 * Head values for a path.
 * @param {string} pathname
 * @param {{ title?: string, description?: string, canonical?: string|null }} [overrides]
 *   An override canonical wins over the query-stripped default, but never makes a noindex route indexable.
 * @returns {{ title: string, description: string, canonical: string|null, robots: string }}
 */
export function headForPath(pathname, overrides = {}) {
  const rule = matchRoute(pathname);
  if (!rule) return { ...NOT_FOUND };
  const title = overrides.title || rule.title || "";
  const description = overrides.description || rule.description || "";
  if (rule.kind !== "index") return { title, description, canonical: null, robots: ROBOTS_NOINDEX };
  return {
    title,
    description,
    canonical: overrides.canonical || defaultCanonical(pathname),
    robots: ROBOTS_INDEX,
  };
}

/**
 * The one canonical URL for a coin page. The app resolves a bare 0x address as BNB Chain and a bare
 * base58 address as Solana (TokenDetailsEntry), so those carry no query. Every other chain (Robinhood
 * 4663, testnets) needs `?chainId=` to be addressable. EVM addresses are lowercased.
 * @param {string} address
 * @param {number|string} chainId
 * @returns {string|null}
 */
export function canonicalForToken(address, chainId) {
  const raw = String(address ?? "").trim();
  if (!raw) return null;
  const cid = Number(chainId);
  const isEvm = /^0x[0-9a-fA-F]{40}$/.test(raw);
  const id = isEvm ? raw.toLowerCase() : raw;
  const bare = (isEvm && cid === 56) || (!isEvm && cid === 101);
  const base = `${APP_ORIGIN}/token/${encodeURIComponent(id)}`;
  return bare || !(cid > 0) ? base : `${base}?chainId=${cid}`;
}
