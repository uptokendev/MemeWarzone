// Entity loaders for the app SEO renderer (spec docs/templar/specs/2026-10-11-app-seo.md 1.3, 2.1, 3.5).
// One read-only loader per entity route. Each returns plain data, no HTML; the renderer escapes it.
// No database import: callers inject `db` (the pg Pool interface: `query(sql, params) -> { rows }`),
// so tests run on a fake. Loaders never throw: a failing read gives { found: false, error: true }.
//
// Result: { found, private?, robots, title, description, canonical?, image?, imageAlt?, ogType?,
//           jsonLd: object[], summary: { heading, lines: string[], links: { href, text }[] } }
//         or { found: false } (+ error: true when a read failed).
import { APP_ORIGIN, canonicalForToken } from "../../shared/seoRoutes.mjs";
import { publicHiddenWhere } from "./publicHiddenSql.js";
import { AUTHOR_PROFILE_LATERAL } from "./feedProfileJoin.js";

const INDEX = "index,follow";
const NOINDEX = "noindex,follow";
const CTX = "https://schema.org";
// Mainnets only: BNB, Solana, Robinhood (same list as sitemapSources.js).
const PUBLIC_CHAINS_SQL = "(56, 101, 4663)";
const CHAIN_NAMES = { 56: "BNB Chain", 101: "Solana", 4663: "Robinhood Chain" };
const isPublicChain = (id) => Number(id) in CHAIN_NAMES;
const chainName = (id) => CHAIN_NAMES[Number(id)] || "";
const DEFAULT_API_ORIGIN = "https://api.memewar.zone";

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const rowsOf = (r) => (r && Array.isArray(r.rows) ? r.rows : []);

// Plain text only: control characters out, whitespace collapsed, em and en dashes replaced.
function clean(v) {
  return String(v ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s*[—–]\s*/g, " - ")
    .replace(/\s+/g, " ")
    .trim();
}
function deepClean(v) {
  if (typeof v === "string") return clean(v);
  if (Array.isArray(v)) return v.map(deepClean);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepClean(x)]));
  return v;
}
// Cut at a word boundary, at most `max` characters.
function fit(text, max, ellipsis = false) {
  const s = clean(text);
  if (s.length <= max) return s;
  const room = ellipsis ? max - 3 : max;
  const cut = s.slice(0, room);
  const sp = cut.lastIndexOf(" ");
  const out = (sp > room * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, "");
  return ellipsis ? `${out}...` : out;
}
function iso(v) {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
const prune = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));
const sym = (s) => clean(s).replace(/^\$/, "").toUpperCase();
const walletKey = (w) => {
  const s = String(w ?? "").trim();
  return EVM_RE.test(s) ? s.toLowerCase() : s;
};

function breadcrumb(origin, trail, url) {
  return {
    "@context": CTX,
    "@type": "BreadcrumbList",
    url,
    itemListElement: trail.map(([name, item], i) => ({ "@type": "ListItem", position: i + 1, name, item })),
  };
}
function webPage({ name, description, url, image }) {
  return prune({ "@context": CTX, "@type": "WebPage", name, description, url, image });
}

const notFound = () => ({ found: false });
const failed = () => ({ found: false, error: true });

/**
 * @param {{ db: { query: Function }, loadBattle?: (id: string) => Promise<any>, appOrigin?: string, apiOrigin?: string, log?: Function, now?: () => number }} deps
 */
export function createSeoEntities({ db, loadBattle, appOrigin = APP_ORIGIN, apiOrigin = DEFAULT_API_ORIGIN, log = console.error, now = Date.now } = {}) {
  const app = String(appOrigin).replace(/\/+$/, "");
  const api = String(apiOrigin).replace(/\/+$/, "");
  const q = async (sql, params) => rowsOf(await db.query(sql, params));

  // Wrap a loader so it never throws and always returns clean plain text.
  const safe = (name, fn) => async (...args) => {
    try {
      const out = await fn(...args);
      return out && out.found ? deepClean(out) : out || notFound();
    } catch (err) {
      try { log(`[seoEntities] ${name} failed`, err?.message || err); } catch { /* ignore */ }
      return failed();
    }
  };

  // ---- coins ----
  // campaigns: same public rule as sitemapSources.coinEntries (publicHiddenWhere, mainnets, future
  // scheduled drafts excluded). Description comes from the draft row; the share image is the story card
  // URL (api/story.js: /api/story/card/:chainId/:token.png), which the API renders and caches on demand.
  // loadStory is not called: it builds market stats and bars, far too heavy for a page render.
  async function coin(id, chainId) {
    const raw = String(id ?? "").trim();
    const isEvm = EVM_RE.test(raw);
    const key = isEvm ? raw.toLowerCase() : raw;
    const cid = Number(chainId) > 0 ? Number(chainId) : isEvm ? 56 : 101;
    if (!isPublicChain(cid)) return notFound();
    const match = isEvm ? "lower(%s) = lower($1)" : "%s = $1";
    const tokenMatch = match.replace("%s", "c.token_address");
    const campMatch = match.replace("%s", "c.campaign_address");
    const rows = await q(
      `select c.chain_id, c.campaign_address, c.token_address, c.name, c.symbol, c.logo_uri, c.creator_address,
              d.description, coalesce(c.created_at_chain, c.created_at) as created_at
         from public.campaigns c
         left join lateral (
           select dd.description from public.campaign_drafts dd
            where dd.chain_id = c.chain_id and dd.campaign_address is not null
              and lower(dd.campaign_address) = lower(c.campaign_address)
            order by dd.updated_at desc nulls last limit 1
         ) d on true
        where c.chain_id in ${PUBLIC_CHAINS_SQL}
          and c.chain_id = $2
          and c.campaign_address is not null
          and (${tokenMatch} or ${campMatch})
          and not (${publicHiddenWhere("c")})
          and not exists (
            select 1 from public.campaign_drafts d2
             where d2.chain_id = c.chain_id
               and d2.campaign_address is not null
               and lower(d2.campaign_address) = lower(c.campaign_address)
               and d2.scheduled_launch_at > now()
          )
        order by (${tokenMatch}) desc
        limit 1`,
      [key, cid],
    );
    let row = rows[0];
    let blurb = row?.description;
    if (!row) {
      const imp = await q(
        `select i.chain_id, i.token_address, i.name, i.symbol, i.image_url
           from public.arena_token_imports i
          where i.chain_id in ${PUBLIC_CHAINS_SQL}
            and i.chain_id = $2
            and i.status = 'passed'
            and ${match.replace("%s", "i.token_address")}
          limit 1`,
        [key, cid],
      );
      if (!imp[0]) return notFound();
      row = { chain_id: imp[0].chain_id, token_address: imp[0].token_address, name: imp[0].name, symbol: imp[0].symbol, logo_uri: imp[0].image_url };
      blurb = "";
    }
    const chain = Number(row.chain_id);
    const address = row.token_address || row.campaign_address;
    const canonical = canonicalForToken(address, chain);
    if (!canonical) return notFound();
    const name = clean(row.name) || "Memecoin";
    const ticker = sym(row.symbol);
    const label = ticker ? `${name} ($${ticker})` : name;
    const tail = " See its price, chart, holders and battle record.";
    const description = fit(`${label} is a memecoin on ${chainName(chain)} launched on MemeWarzone.${blurb ? ` ${clean(blurb)}` : ""}${tail}`, 160);
    const image = `${api}/api/story/card/${chain}/${encodeURIComponent(address)}.png`;
    const title = ticker ? `${name} ($${ticker}) price, chart and battles` : `${name} price, chart and battles`;
    return {
      found: true,
      robots: INDEX,
      title,
      description,
      canonical,
      image,
      imageAlt: `${label} on MemeWarzone`,
      ogType: "website",
      jsonLd: [
        webPage({ name: title, description, url: canonical, image }),
        breadcrumb(app, [["MemeWarzone", `${app}/`], ["Coins", `${app}/coins`], [label, canonical]], canonical),
      ],
      summary: {
        heading: label,
        lines: [`${label} is a memecoin on ${chainName(chain)}.`, blurb ? clean(blurb) : "Trade it on its bonding curve and follow its coin battles on MemeWarzone."].filter(Boolean),
        links: [{ href: `${app}/coins`, text: "All coins" }, { href: `${app}/warzone/battles`, text: "Coin battles" }],
      },
    };
  }

  // ---- battles ----
  // Data: loadPublicBattleSharePayload (api/lib/publicBattleSharePayload.mjs). Image: the battle share card
  // URL that api/battle-og.js builds (`/api/battle-share-card?battleId=..&v=1`), on the API origin: on the app
  // host /api/* returns the app shell, not the image.
  let battleLoader = loadBattle;
  async function battle(id) {
    if (!battleLoader) battleLoader = (await import("./publicBattleSharePayload.mjs")).loadPublicBattleSharePayload;
    const payload = await battleLoader(String(id ?? ""));
    const b = payload?.battle;
    if (!b?.id) return notFound();
    const parts = Array.isArray(b.participants) ? b.participants : [];
    const label = (p, i) => sym(p?.symbol) || clean(p?.tokenName) || `Coin ${i + 1}`;
    const left = label(parts[0], 0);
    const right = label(parts[1], 1);
    const chain = Number(b.chainId);
    const canonical = `${app}/warzone/battles/${encodeURIComponent(String(b.id))}`;
    const state = String(b.state || "");
    const winnerKey = String(b.winnerToken || "").toLowerCase();
    const winner = winnerKey ? parts.map((p, i) => ({ p, i })).find(({ p }) => [p?.tokenAddress, p?.tokenId, p?.campaignAddress].some((v) => v && String(v).toLowerCase() === winnerKey)) : null;
    const status = state === "finished" ? (winner ? `Finished, ${label(winner.p, winner.i)} won.` : "Finished.") : state === "live" ? "Live now." : "Not started yet.";
    const scoring = String(b.battleMode || "").toLowerCase() === "vote" ? "Scored on votes." : "Scored on market data.";
    const where = chainName(chain);
    const title = `${left} vs ${right} coin battle`;
    const description = fit(`${left} vs ${right}, a memecoin battle${where ? ` on ${where}` : ""} on MemeWarzone. ${status} ${scoring}`, 160);
    const startDate = iso(b.startedAt);
    const endDate = iso(b.endsAt);
    const image = `${api}/api/battle-share-card?battleId=${encodeURIComponent(String(b.id))}&v=1`;
    const event = prune({
      "@context": CTX,
      "@type": "Event",
      name: title,
      description,
      url: canonical,
      startDate,
      endDate,
      eventStatus: "https://schema.org/EventScheduled",
      eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode",
      location: { "@type": "VirtualLocation", url: canonical },
      image,
    });
    return {
      found: true,
      robots: (state === "live" || state === "finished") && isPublicChain(chain) ? INDEX : NOINDEX,
      title,
      description,
      canonical,
      image,
      imageAlt: `${left} vs ${right} battle card`,
      ogType: "website",
      jsonLd: [event],
      summary: {
        heading: title,
        lines: [`${left} and ${right} are in a coin battle${where ? ` on ${where}` : ""}.`, `${status} ${scoring}`].map(clean),
        links: [{ href: `${app}/warzone/battles`, text: "All coin battles" }, { href: `${app}/warzone`, text: "Warzone" }],
      },
    };
  }

  // ---- tournaments ---- arenaTournaments.js:218 (status <> 'cancelled'), public fields as mapPublic (:33).
  async function tournament(id) {
    const rows = await q(
      `select id, name, status, chain_id, starts_at, ends_at, terms, cap, buy_in_native, native_symbol, updated_at
         from public.arena_tournaments
        where id::text = $1 and status <> 'cancelled'
        limit 1`,
      [String(id ?? "")],
    );
    const r = rows[0];
    if (!r) return notFound();
    const chain = Number(r.chain_id);
    const where = chainName(chain);
    const name = clean(r.name) || "Tournament";
    const canonical = `${app}/warzone/tournaments/${encodeURIComponent(String(r.id))}`;
    const capText = Number(r.cap) > 0 ? `${Number(r.cap)} coins` : "";
    const buyIn = Number(r.buy_in_native) > 0 ? `Buy-in ${Number(r.buy_in_native)} ${clean(r.native_symbol)}.` : "";
    const status = String(r.status) === "finished" ? "Finished." : String(r.status) === "upcoming" ? "Registration and schedule are on the page." : "In progress.";
    const description = fit(`${name}, a memecoin tournament${where ? ` on ${where}` : ""} on MemeWarzone.${capText ? ` Up to ${capText}.` : ""} ${buyIn} ${status} ${clean(r.terms)}`, 160);
    const startDate = iso(r.starts_at);
    const endDate = iso(r.ends_at);
    const event = prune({
      "@context": CTX,
      "@type": "Event",
      name,
      description,
      url: canonical,
      startDate,
      endDate,
      eventStatus: "https://schema.org/EventScheduled",
      eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode",
      location: { "@type": "VirtualLocation", url: canonical },
    });
    return {
      found: true,
      robots: isPublicChain(chain) ? INDEX : NOINDEX,
      title: `${name} tournament`,
      description,
      canonical,
      ogType: "website",
      jsonLd: [event],
      summary: {
        heading: name,
        lines: [`${name} is a memecoin tournament${where ? ` on ${where}` : ""}.`, [capText && `Up to ${capText}.`, buyIn, status].filter(Boolean).join(" "), clean(r.terms)].filter(Boolean),
        links: [{ href: `${app}/warzone/tournaments`, text: "All tournaments" }],
      },
    };
  }

  // ---- prepare ---- query and privacy rule copied from api/prepare-og.js:68-80 and :110-130.
  async function prepare(slug) {
    const rows = await q(
      `select id, chain_id, slug, name, ticker, description, logo_url, status, visibility,
              campaign_address, token_address, scheduled_launch_at
         from public.campaign_drafts
        where lower(slug) = lower($1)
        limit 1`,
      [String(slug ?? "")],
    );
    const d = rows[0];
    if (!d) return notFound();
    const canonical = `${app}/prepare/${encodeURIComponent(String(d.slug))}`;
    if (String(d.visibility || "").toLowerCase() === "private") {
      const description = "A private Prepare Mode dossier on MemeWarzone.";
      return { found: true, private: true, robots: NOINDEX, title: "MemeWarzone Prepare Mode", description, jsonLd: [], summary: { heading: "MemeWarzone Prepare Mode", lines: [description], links: [{ href: `${app}/`, text: "MemeWarzone" }] } };
    }
    const name = clean(d.name) || "Campaign";
    const ticker = sym(d.ticker);
    const label = ticker ? `${name} ($${ticker})` : name;
    const chain = Number(d.chain_id);
    const launched = String(d.status || "") === "deployed" || (d.campaign_address && d.scheduled_launch_at && new Date(d.scheduled_launch_at).getTime() <= now());
    let promo = {};
    try {
      promo = (await q(`select mission_statement, creator_note from public.campaign_draft_promotion where draft_id = $1 limit 1`, [d.id]))[0] || {};
    } catch { /* promotion table optional, as in prepare-og.js */ }
    const blurb = clean(d.description) || clean(promo.mission_statement) || clean(promo.creator_note);
    const description = fit(`${label} is preparing to launch${chainName(chain) ? ` on ${chainName(chain)}` : ""} on MemeWarzone.${blurb ? ` ${blurb}` : ""} Follow the countdown and the launch dossier.`, 160);
    const image = `${api}/api/prepare-share-card?slug=${encodeURIComponent(String(d.slug))}&v=4`;
    let url = canonical;
    let robots = isPublicChain(chain) ? INDEX : NOINDEX;
    if (launched) {
      const coinUrl = d.token_address ? canonicalForToken(d.token_address, chain) : null;
      if (coinUrl) url = coinUrl;
      else robots = NOINDEX;
    }
    const title = `${label} launch dossier`;
    return {
      found: true,
      robots,
      title,
      description,
      canonical: url,
      image,
      imageAlt: `${label} prepare card`,
      ogType: "website",
      jsonLd: [webPage({ name: title, description, url, image }), breadcrumb(app, [["MemeWarzone", `${app}/`], [label, url]], url)],
      summary: { heading: label, lines: [description], links: launched && url !== canonical ? [{ href: url, text: `${label} coin page` }] : [{ href: `${app}/coins`, text: "All coins" }] },
    };
  }

  // ---- posts ---- feed/posts.js: public reads are `p.status = 0`; author name via AUTHOR_PROFILE_LATERAL.
  async function post(id) {
    const n = Number(id);
    if (!Number.isFinite(n) || n <= 0) return notFound();
    const rows = await q(
      `select p.id, p.author_address, p.body, p.created_at, p.parent_id, up.display_name as author_display_name
         from public.social_posts p
         ${AUTHOR_PROFILE_LATERAL}
        where p.status = 0 and p.id = $1
        limit 1`,
      [Math.trunc(n)],
    );
    const p = rows[0];
    if (!p) return notFound();
    const author = walletKey(p.author_address);
    let handle = null;
    try { handle = (await q(`select handle from public.user_handles where wallet_key = $1 limit 1`, [author]))[0]?.handle || null; } catch (e) { if (e?.code !== "42P01") throw e; }
    const short = author.length > 12 ? `${author.slice(0, 6)}...${author.slice(-4)}` : author;
    const who = handle ? `@${clean(handle)}` : clean(p.author_display_name) || short || "A trader";
    const body = clean(p.body);
    const canonical = `${app}/post/${Math.trunc(n)}`;
    const title = fit(`${who} on MemeWarzone: ${body || "post"}`, 70, true);
    const description = fit(body || `A post by ${who} on MemeWarzone.`, 160, true);
    const created = iso(p.created_at);
    const posting = prune({
      "@context": CTX,
      "@type": "DiscussionForumPosting",
      headline: fit(body || `Post by ${who}`, 110, true),
      text: fit(body, 500, true),
      url: canonical,
      datePublished: created,
      author: { "@type": "Person", name: who },
    });
    return {
      found: true,
      robots: p.parent_id == null ? INDEX : NOINDEX,
      title,
      description,
      canonical,
      ogType: "article",
      jsonLd: [posting],
      summary: { heading: `Post by ${who}`, lines: [fit(body, 500, true)].filter(Boolean), links: [{ href: `${app}/`, text: "MemeWarzone feed" }] },
    };
  }

  // ---- recruiters ---- attribution.js:190 findRecruiterByCode (status must be 'active', :422). Hidden
  // check: the leaderboard query from sitemapSources.recruiterEntries (attribution.js:739) for this id.
  async function recruiter(code) {
    const rows = await q(
      `select id, wallet_address, code, display_name, is_og, status, created_at, updated_at
         from public.recruiters
        where lower(code) = lower($1)
        limit 1`,
      [String(code ?? "")],
    );
    const r = rows[0];
    if (!r || String(r.status) !== "active") return notFound();
    const visible = await q(
      `select r.id
         from public.recruiters r
         left join public.wallet_recruiter_links l on l.recruiter_id = r.id and l.is_active = true and lower(l.wallet_address) <> lower(r.wallet_address)
         left join public.wallet_squad_memberships s on s.recruiter_id = r.id and s.is_active = true and lower(s.wallet_address) <> lower(r.wallet_address)
         left join public.wallet_risk_profiles lwr on lower(lwr.wallet_address) = lower(l.wallet_address)
         left join public.wallet_risk_profiles swr on lower(swr.wallet_address) = lower(s.wallet_address)
         left join public.wallet_risk_profiles rwr on lower(rwr.wallet_address) = lower(r.wallet_address)
        where r.id = $1
          and r.status = 'active'
          and not (lwr.cluster_id is not null and rwr.cluster_id is not null and lwr.cluster_id = rwr.cluster_id)
          and not (swr.cluster_id is not null and rwr.cluster_id is not null and swr.cluster_id = rwr.cluster_id)
        group by r.id
        limit 1`,
      [r.id],
    );
    const name = clean(r.display_name) || clean(r.code);
    const canonical = `${app}/recruiters/${encodeURIComponent(String(r.code))}`;
    const title = `${name} recruiter profile`;
    const description = fit(`${name} is a MemeWarzone recruiter${r.is_og ? " and an OG member" : ""}. Referral code ${clean(r.code)}. See the referrals and rewards earned through the recruiter program.`, 160);
    return {
      found: true,
      robots: visible.length ? INDEX : NOINDEX,
      title,
      description,
      canonical,
      ogType: "profile",
      jsonLd: [webPage({ name: title, description, url: canonical }), breadcrumb(app, [["MemeWarzone", `${app}/`], ["Recruiters", `${app}/recruiters`], [name, canonical]], canonical)],
      summary: { heading: name, lines: [description], links: [{ href: `${app}/recruiters`, text: "Recruiter leaderboard" }] },
    };
  }

  // ---- profiles ---- eligibility (founder decision): a handle (public.user_handles, handle.js:39) or a
  // launched public mainnet coin created by the wallet (campaigns.creator_address, as sitemap profileEntries).
  async function profile(wallet) {
    const w = walletKey(wallet);
    if (!w) return notFound();
    const isEvm = EVM_RE.test(w);
    let handle = null;
    try { handle = (await q(`select handle from public.user_handles where wallet_key = $1 limit 1`, [w]))[0]?.handle || null; } catch (e) { if (e?.code !== "42P01") throw e; }
    let displayName = null;
    try {
      displayName = (await q(
        `select display_name from public.user_profiles up
          where lower(up.address) = lower($1) and up.display_name is not null and length(btrim(up.display_name)) > 0
          order by up.updated_at desc nulls last limit 1`,
        [w],
      ))[0]?.display_name || null;
    } catch (e) { if (e?.code !== "42P01") throw e; }
    const coins = await q(
      `select c.chain_id, c.token_address, c.campaign_address, c.name, c.symbol
         from public.campaigns c
        where ${isEvm ? "lower(c.creator_address) = lower($1)" : "c.creator_address = $1"}
          and c.chain_id in ${PUBLIC_CHAINS_SQL}
          and c.campaign_address is not null
          and not (${publicHiddenWhere("c")})
        order by coalesce(c.created_at_chain, c.created_at) desc nulls last
        limit 5`,
      [w],
    );
    const eligible = Boolean(handle) || coins.length > 0;
    const short = w.length > 12 ? `${w.slice(0, 6)}...${w.slice(-4)}` : w;
    const name = handle ? `@${clean(handle)}` : clean(displayName) || short;
    const canonical = `${app}/profile/${encodeURIComponent(w)}`;
    const title = `${name} trader profile`;
    const coinLinks = coins
      .map((c) => ({ href: canonicalForToken(c.token_address || c.campaign_address, c.chain_id), text: clean(c.symbol) ? `${clean(c.name)} ($${sym(c.symbol)})` : clean(c.name) || "Coin" }))
      .filter((l) => l.href);
    const launched = coins.length ? ` Launched ${coins.length === 1 ? "1 memecoin" : `${coins.length} or more memecoins`} on MemeWarzone.` : "";
    const description = fit(`${name} on MemeWarzone.${launched} See holdings, battle record and activity across BNB Chain, Solana and Robinhood Chain.`, 160);
    return {
      found: true,
      robots: eligible ? INDEX : NOINDEX,
      title,
      description,
      canonical,
      ogType: "profile",
      jsonLd: eligible ? [webPage({ name: title, description, url: canonical }), breadcrumb(app, [["MemeWarzone", `${app}/`], [name, canonical]], canonical)] : [],
      summary: { heading: name, lines: [description], links: coinLinks.length ? coinLinks : [{ href: `${app}/coins`, text: "All coins" }] },
    };
  }

  return {
    coin: safe("coin", coin),
    battle: safe("battle", battle),
    tournament: safe("tournament", tournament),
    prepare: safe("prepare", prepare),
    post: safe("post", post),
    recruiter: safe("recruiter", recruiter),
    profile: safe("profile", profile),
  };
}
