// Sitemap child sources and the request handlers behind /sitemap.xml and /sitemaps/:file.
// Read-only SQL only. No database import: callers inject `db` (the pg Pool interface:
// `query(sql, params) -> { rows }`), so tests run on a fake. api/sitemap.js wires the real pool.
import { ROUTE_RULES, canonicalForToken } from "../../shared/seoRoutes.mjs";
import {
  absoluteLoc,
  chunkEntries,
  chunkName,
  sitemapIndexXml,
  sitemapOrigin,
  urlsetXml,
} from "./sitemapXml.mjs";
import { publicHiddenWhere } from "./publicHiddenSql.js";

export const CHILD_NAMES = ["static", "coins", "battles", "tournaments", "recruiters", "posts", "profiles", "prepare"];

const ROW_LIMIT = 200000;
const TTL_MS = 10 * 60_000;
const FAIL_TTL_MS = 60_000;
// Mainnets only: BNB, Solana, Robinhood. Testnets (97, 46630) and devnet are never listed.
const PUBLIC_CHAINS_SQL = "(56, 101, 4663)";

const ident = (v) => String(v ?? "").trim();
const rowsOf = (result) => (result && Array.isArray(result.rows) ? result.rows : []);

export function staticEntries() {
  return ROUTE_RULES
    .filter((r) => r.kind === "index" && !r.pattern.includes(":") && !r.pattern.includes("**"))
    .map((r) => ({ loc: absoluteLoc(r.pattern) }));
}

function dedupe(entries) {
  const seen = new Set();
  return entries.filter((e) => e.loc && !seen.has(e.loc) && seen.add(e.loc));
}

// Campaigns: public hidden filter copied from api/lib/publicHiddenSql.js (used by campaigns.js:164
// via loadPublicHiddenCampaignKeys); future-scheduled drafts excluded as in campaigns.js:183-184.
// Imports: api/arenaImports.js handleRecent (public list) takes status = 'passed'.
export async function coinEntries(db) {
  const campaigns = await db.query(
    `select c.chain_id, c.campaign_address, coalesce(c.created_at_chain, c.created_at) as lastmod
       from public.campaigns c
      where c.chain_id in ${PUBLIC_CHAINS_SQL}
        and c.campaign_address is not null
        and not (${publicHiddenWhere("c")})
        and not exists (
          select 1 from public.campaign_drafts d
           where d.chain_id = c.chain_id
             and d.campaign_address is not null
             and lower(d.campaign_address) = lower(c.campaign_address)
             and d.scheduled_launch_at > now()
        )
      order by c.chain_id, c.campaign_address
      limit ${ROW_LIMIT}`,
    [],
  );
  const imports = await db.query(
    `select i.chain_id, i.token_address, coalesce(i.updated_at, i.created_at) as lastmod
       from public.arena_token_imports i
      where i.chain_id in ${PUBLIC_CHAINS_SQL}
        and i.status = 'passed'
        and i.token_address is not null
      order by i.chain_id, i.token_address
      limit ${ROW_LIMIT}`,
    [],
  );
  const out = [];
  for (const r of rowsOf(campaigns)) {
    const loc = canonicalForToken(r.campaign_address, r.chain_id);
    if (loc) out.push({ loc, lastmod: r.lastmod || undefined });
  }
  for (const r of rowsOf(imports)) {
    const loc = canonicalForToken(r.token_address, r.chain_id);
    if (loc) out.push({ loc, lastmod: r.lastmod || undefined });
  }
  return dedupe(out);
}

// arenaBattles.js:66 LIST_STATES and handleList (:1008). Waiting/challenged/matched battles are
// transient and 'expired' ones are dead pages, so only live and finished battles are listed.
export async function battleEntries(db) {
  const r = await db.query(
    `select id, coalesce(finished_at, updated_at, created_at) as lastmod
       from public.arena_battles
      where state in ('live', 'finished')
      order by coalesce(updated_at, created_at) desc, id
      limit ${ROW_LIMIT}`,
    [],
  );
  return rowsOf(r).filter((x) => ident(x.id)).map((x) => ({ loc: absoluteLoc(`/warzone/battles/${encodeURIComponent(ident(x.id))}`), lastmod: x.lastmod || undefined }));
}

// arenaTournaments.js:218 (status <> 'cancelled').
export async function tournamentEntries(db) {
  const r = await db.query(
    `select id, coalesce(updated_at, created_at) as lastmod
       from public.arena_tournaments
      where status <> 'cancelled'
      order by starts_at asc, id
      limit ${ROW_LIMIT}`,
    [],
  );
  return rowsOf(r).filter((x) => ident(x.id)).map((x) => ({ loc: absoluteLoc(`/warzone/tournaments/${encodeURIComponent(ident(x.id))}`), lastmod: x.lastmod || undefined }));
}

// dev-fix/attribution.js:739 `recruiters` (status = 'active'), without the 250 cap. The wallet-risk
// cluster exclusions there depend on link tables and are not repeated; only active recruiters list.
export async function recruiterEntries(db) {
  const r = await db.query(
    `select r.code, r.updated_at as lastmod
       from public.recruiters r
      where r.status = 'active'
        and r.code is not null
      order by r.created_at asc, r.code
      limit ${ROW_LIMIT}`,
    [],
  );
  return rowsOf(r).filter((x) => ident(x.code)).map((x) => ({ loc: absoluteLoc(`/recruiters/${encodeURIComponent(ident(x.code))}`), lastmod: x.lastmod || undefined }));
}

// feed/posts.js:708: public reads use `p.status = 0` on public.social_posts. Replies (parent_id,
// feed/posts.js:301) are thin pages and stay out.
export async function postEntries(db) {
  const r = await db.query(
    `select p.id, p.created_at as lastmod
       from public.social_posts p
      where p.status = 0
        and p.parent_id is null
      order by p.id
      limit ${ROW_LIMIT}`,
    [],
  );
  return rowsOf(r).filter((x) => ident(x.id)).map((x) => ({ loc: absoluteLoc(`/post/${encodeURIComponent(ident(x.id))}`), lastmod: x.lastmod || undefined }));
}

// Wallets with a handle (public.user_handles, api/profile/handle.js:39) or that created a launched,
// non-hidden coin on a mainnet (campaigns.creator_address, campaigns-base.js:244).
export async function profileEntries(db) {
  const r = await db.query(
    `select wallet from (
        select h.wallet_key as wallet from public.user_handles h where h.wallet_key is not null
        union
        select c.creator_address as wallet from public.campaigns c
         where c.creator_address is not null
           and c.chain_id in ${PUBLIC_CHAINS_SQL}
           and not (${publicHiddenWhere("c")})
      ) w
      order by wallet
      limit ${ROW_LIMIT}`,
    [],
  );
  const seen = new Set();
  const out = [];
  for (const x of rowsOf(r)) {
    const raw = ident(x.wallet);
    if (!raw) continue;
    const w = /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : raw;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push({ loc: absoluteLoc(`/profile/${encodeURIComponent(w)}`) });
  }
  return out;
}

// Launched drafts (status 'deployed', dev-fix/drafts.js:323; or a campaign_address whose launch time has
// passed, drafts.js:327-331) have a coin page, so they are left out.
// campaigns.js:183. prepare-og.js:75-79: a draft is private when visibility = 'private'; everything else with a slug is public.
export async function prepareEntries(db) {
  const r = await db.query(
    `select d.slug, d.updated_at as lastmod
       from public.campaign_drafts d
      where d.slug is not null
        and d.slug <> ''
        and lower(coalesce(d.visibility, 'public')) <> 'private'
        and d.chain_id in ${PUBLIC_CHAINS_SQL}
        and coalesce(d.status, 'draft') <> 'deployed'
        and not (d.campaign_address is not null and d.scheduled_launch_at <= now())
      order by d.slug
      limit ${ROW_LIMIT}`,
    [],
  );
  return rowsOf(r).filter((x) => ident(x.slug)).map((x) => ({ loc: absoluteLoc(`/prepare/${encodeURIComponent(ident(x.slug))}`), lastmod: x.lastmod || undefined }));
}

const SOURCES = {
  static: async () => staticEntries(),
  coins: coinEntries,
  battles: battleEntries,
  tournaments: tournamentEntries,
  recruiters: recruiterEntries,
  posts: postEntries,
  profiles: profileEntries,
  prepare: prepareEntries,
};

const XML_HEADERS = {
  "content-type": "application/xml; charset=utf-8",
  "cache-control": "public, max-age=600",
};

function send(res, status, body) {
  res.statusCode = status;
  for (const [k, v] of Object.entries(XML_HEADERS)) res.setHeader(k, v);
  res.end(body);
}

const notFoundXml = '<?xml version="1.0" encoding="UTF-8"?>\n<error>Unknown sitemap</error>\n';

/** @param {{ db: { query: Function }, now?: () => number, log?: (...a: any[]) => void }} deps */
export function createSitemapHandlers({ db, now = Date.now, log = console.error } = {}) {
  const cache = new Map(); // name -> { at, ttl, chunks }
  const inflight = new Map();

  async function load(name) {
    const hit = cache.get(name);
    if (hit && now() - hit.at < hit.ttl) return hit.chunks;
    if (inflight.has(name)) return inflight.get(name);
    const p = (async () => {
      let entries = [];
      let ttl = TTL_MS;
      try {
        entries = await SOURCES[name](db);
      } catch (err) {
        log(`[api/sitemap] ${name} failed`, err?.message || err);
        entries = [];
        ttl = FAIL_TTL_MS;
      }
      const chunks = chunkEntries(entries);
      cache.set(name, { at: now(), ttl, chunks });
      return chunks;
    })().finally(() => inflight.delete(name));
    inflight.set(name, p);
    return p;
  }

  async function index(_req, res) {
    const names = [];
    const all = await Promise.all(CHILD_NAMES.map((name) => load(name)));
    for (const [idx, name] of CHILD_NAMES.entries()) {
      const chunks = all[idx];
      const count = Math.max(1, chunks.length);
      for (let i = 0; i < count; i++) names.push(chunkName(name, i));
    }
    send(res, 200, sitemapIndexXml(names, sitemapOrigin()));
  }

  async function child(req, res) {
    const file = String(req?.params?.file ?? "");
    const m = /^([a-z]+)(?:-(\d+))?\.xml$/.exec(file);
    if (!m || !CHILD_NAMES.includes(m[1])) return send(res, 404, notFoundXml);
    const n = m[2] === undefined ? 1 : Number(m[2]);
    if (!Number.isInteger(n) || (n < 2 && m[2] !== undefined)) return send(res, 404, notFoundXml);
    const chunks = await load(m[1]);
    if (n > Math.max(1, chunks.length)) return send(res, 404, notFoundXml);
    return send(res, 200, urlsetXml(chunks[n - 1] || []));
  }

  return { index, child };
}
