// GET /sitemap.xml and GET /sitemaps/:file (coins.xml, coins-2.xml, ...).
// Logic lives in lib/sitemapSources.js; this file only binds the real pool, lazily, so importing
// the module never opens a database connection.
import { createSitemapHandlers } from "./lib/sitemapSources.js";
import { CHILD_NAMES } from "./lib/sitemapSources.js";
import { sitemapIndexXml, sitemapOrigin, urlsetXml } from "./lib/sitemapXml.mjs";

export { createSitemapHandlers };

let handlers = null;
async function get() {
  if (handlers) return handlers;
  const { pool } = await import("../server/db.js");
  handlers = createSitemapHandlers({ db: pool });
  return handlers;
}

// A missing database must still answer with XML, never HTML or a 500.
async function run(kind, req, res) {
  try {
    return await (await get())[kind](req, res);
  } catch (err) {
    console.error("[api/sitemap] unavailable", err?.message || err);
    if (res.headersSent) return;
    res.statusCode = 200;
    res.setHeader("content-type", "application/xml; charset=utf-8");
    res.setHeader("cache-control", "public, max-age=60");
    if (kind === "index") return res.end(sitemapIndexXml(CHILD_NAMES, sitemapOrigin()));
    const m = /^([a-z]+)(?:-(\d+))?\.xml$/.exec(String(req?.params?.file ?? ""));
    if (!m || !CHILD_NAMES.includes(m[1])) {
      res.statusCode = 404;
      return res.end('<?xml version="1.0" encoding="UTF-8"?>\n<error>Unknown sitemap</error>\n');
    }
    res.end(urlsetXml([]));
  }
}

export const sitemapIndex = (req, res) => run("index", req, res);
export const sitemapChild = (req, res) => run("child", req, res);
