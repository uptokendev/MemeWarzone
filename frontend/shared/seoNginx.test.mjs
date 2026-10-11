// Parses deploy/nginx/app.conf and checks routing the way nginx picks locations.
// Source of truth for routes: frontend/src/App.tsx; for aliases and noindex kinds: shared/seoRoutes.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ROUTE_RULES, aliasTarget } from "./seoRoutes.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CONF = path.join(here, "../../deploy/nginx/app.conf");
const APP_TSX = path.join(here, "../src/App.tsx");

// ---- tiny nginx parser ----
function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "#") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "{" || c === "}" || c === ";") { out.push({ t: c }); i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1, s = "";
      while (j < src.length && src[j] !== c) { if (src[j] === "\\" && /["'\\]/.test(src[j + 1])) { s += src[j + 1]; j += 2; } else s += src[j++]; }
      out.push({ t: "w", v: s, quoted: true }); i = j + 1; continue;
    }
    let j = i, s = "";
    while (j < src.length && !/[\s;{}]/.test(src[j])) s += src[j++];
    out.push({ t: "w", v: s }); i = j;
  }
  return out;
}
function parseBlock(toks, pos) {
  const directives = [];
  while (pos < toks.length) {
    const tk = toks[pos];
    if (tk.t === "}") return { directives, pos: pos + 1 };
    const args = [];
    while (toks[pos].t === "w") args.push(toks[pos++].v);
    if (toks[pos].t === ";") { directives.push({ name: args[0], args: args.slice(1) }); pos++; }
    else if (toks[pos].t === "{") {
      const inner = parseBlock(toks, pos + 1);
      directives.push({ name: args[0], args: args.slice(1), block: inner.directives });
      pos = inner.pos;
    } else throw new Error("parse error");
  }
  return { directives, pos };
}
const conf = parseBlock(tokenize(readFileSync(CONF, "utf8")), 0).directives;
const server = conf.find((d) => d.name === "server");
const mapDir = conf.find((d) => d.name === "map");

const locations = server.block.filter((d) => d.name === "location").map((d) => {
  const a = d.args;
  const [mod, pattern] = a.length === 2 ? a : ["", a[0]];
  return { mod, pattern, dirs: d.block, re: mod === "~" || mod === "~*" ? new RegExp(pattern) : null };
});
const dirsOf = (loc, name) => loc.dirs.filter((d) => d.name === name);
const headerNames = (loc) => dirsOf(loc, "add_header").map((d) => d.args[0]).sort();

function pickLocation(uri) {
  const exact = locations.find((l) => l.mod === "=" && l.pattern === uri);
  if (exact) return exact;
  let best = null;
  for (const l of locations) {
    if ((l.mod === "" || l.mod === "^~") && uri.startsWith(l.pattern) && (!best || l.pattern.length > best.pattern.length)) best = l;
  }
  if (best && best.mod === "^~") return best;
  const rx = locations.find((l) => l.re && l.re.test(uri));
  return rx || best;
}
function applyRewrite(loc, uri) {
  for (const d of dirsOf(loc, "rewrite")) {
    if (d.args[2] !== "permanent") continue;
    const m = new RegExp(d.args[0]).exec(uri);
    if (m) return d.args[1].replace(/\$(\d)/g, (_, n) => m[n]);
  }
  return null;
}
const isRenderProxy = (loc) => dirsOf(loc, "proxy_pass").some((d) => /\/__render\$request_uri$/.test(d.args[0]));
const isRedirect = (loc) => dirsOf(loc, "rewrite").some((d) => d.args[2] === "permanent");

// ---- robots map ----
const mapRules = mapDir.block.filter((d) => d.name !== "default").map((d) => ({ re: new RegExp(d.name.replace(/^~/, "")), value: d.args[0] }));
const robotsFor = (uri) => (mapRules.find((r) => r.re.test(uri)) || { value: "" }).value;

const DEFAULT_SET = ["Content-Security-Policy", "Referrer-Policy", "X-Content-Type-Options", "X-Frame-Options", "X-Robots-Tag"];

// ---- tests ----
test("server-level mechanics", () => {
  assert.ok(server.block.some((d) => d.name === "absolute_redirect" && d.args[0] === "off"));
  assert.ok(mapDir && mapDir.args[0] === "$request_uri" && mapDir.args[1] === "$robots_tag");
  assert.ok(server.block.some((d) => d.name === "resolver"));
});

test("home page resolves to the exact location and is rendered by the API", () => {
  const l = pickLocation("/");
  assert.equal(l.mod, "=");
  assert.equal(l.pattern, "/");
  assert.ok(isRenderProxy(l));
});

function appRoutePaths() {
  const src = readFileSync(APP_TSX, "utf8");
  const out = [];
  for (const m of src.matchAll(/\bpath="([^"]+)"/g)) {
    if (m[1] === "*") continue;
    out.push(m[1].replace(/:[A-Za-z]+/g, "abc123").replace(/\/\*$/, "/abc"));
  }
  return [...new Set(out)];
}

test("every App.tsx route resolves to the allowlist, an alias, or an ^~ block (never the 404 default)", () => {
  const paths = appRoutePaths();
  assert.ok(paths.length > 60, `expected many routes, got ${paths.length}`);
  for (const p of paths) {
    const l = pickLocation(p);
    assert.ok(l, p);
    const ok = isRedirect(l) || isRenderProxy(l) || l.mod === "^~" || (l.mod === "=" && p === "/") || (l.mod === "~" && dirsOf(l, "try_files").some((d) => d.args.at(-1) === "/index.html"));
    assert.ok(ok, `${p} -> ${l.mod} ${l.pattern}`);
    assert.ok(l.mod !== "" || l.pattern !== "/", p);
  }
});

test("every alias in seoRoutes has an anchored rewrite with the right target", () => {
  const samples = [];
  for (const r of ROUTE_RULES.filter((x) => x.kind === "alias")) {
    const p = r.pattern.replace(":id", "abc.1_2-x").replace("/**", "/a/b-c");
    samples.push(p);
    if (r.pattern.endsWith("/**")) samples.push(r.pattern.replace("/**", "/solo"));
  }
  for (const p of samples) {
    const want = aliasTarget(p);
    assert.ok(want, p);
    const l = pickLocation(p);
    assert.ok(isRedirect(l), `${p} not redirected (${l.mod} ${l.pattern})`);
    for (const d of dirsOf(l, "rewrite")) assert.ok(d.args[0].startsWith("^") && d.args[0].endsWith("$"), `unanchored ${d.args[0]}`);
    assert.equal(applyRewrite(l, p), want, p);
  }
  // captures are restricted
  assert.equal(applyRewrite(pickLocation("/tournament/a b"), "/tournament/a b"), null);
});

test("unknown samples hit the default location; trailing slash is a 301", () => {
  for (const p of ["/nope", "/token", "/warzone/x/y/z", "/index.html", "/robots.txt", "/logo.png"]) {
    const l = pickLocation(p);
    assert.equal(`${l.mod}|${l.pattern}`, "|/", p);
  }
  const def = pickLocation("/nope");
  assert.deepEqual(dirsOf(def, "try_files")[0].args, ["$uri", "$uri.html", "=404"]);
  assert.deepEqual(dirsOf(def, "error_page")[0].args, ["404", "/index.html"]);
  const ts = pickLocation("/coins/");
  assert.equal(applyRewrite(ts, "/coins/"), "/coins");
  assert.equal(applyRewrite(pickLocation("/index"), "/index") ?? dirsOf(pickLocation("/index"), "return")[0].args.join(" "), "301 /");
});

test("robots map", () => {
  for (const p of ["/drafts/x", "/drafts/x/promotion", "/live", "/import", "/profile", "/profile/w/command/x", "/profile/w/command", "/profile/w/other", "/status", "/story/101/x", "/embed/chart/101/x", "/token/abc/edit", "/command", "/command/coins", "/recruiter", "/recruiter/signup", "/recruiter-dashboard", "/squad-dashboard", "/r/code", "/warzone/verify-email", "/live?x=1", "/status?a=/b", "/profile/@handle", "/profile/@handle?x=1"]) {
    assert.equal(robotsFor(p), "noindex", p);
  }
  for (const p of ["/", "/coins", "/token/0xabc", "/token/0xabc?chainId=4663", "/warzone/battles/1", "/league", "/profile/wallet1", "/profile/at@x", "/recruiters", "/recruiters/x", "/livestock", "/imports", "/statuses", "/prepare/x", "/post/1", "/playbook?x=/live"]) {
    assert.equal(robotsFor(p), "", p);
  }
  // consistent with ROUTE_RULES noindex kinds
  assert.equal(robotsFor("/command/feed"), "noindex"); // redirected first, harmless
});

test("embed, assets and index.html routing", () => {
  assert.deepEqual([pickLocation("/embed/chart/101/x").mod, pickLocation("/embed/chart/101/x").pattern], ["^~", "/embed/chart/"]);
  assert.deepEqual([pickLocation("/embed/other").mod, pickLocation("/embed/other").pattern], ["^~", "/embed/"]);
  for (const p of ["/api/arena/battles", "/api/price/bnb-usd", "/api/arena/league?chainId=56".split("?")[0]]) {
    const l = pickLocation(p);
    assert.deepEqual([l.mod, l.pattern], ["^~", "/api/"], p);
    assert.deepEqual(dirsOf(l, "try_files")[0].args, ["/index.html", "=404"]);
  }
  assert.deepEqual([pickLocation("/assets/x.js").mod, pickLocation("/assets/x.js").pattern], ["^~", "/assets/"]);
  const idx = pickLocation("/index.html");
  assert.equal(isRedirect(idx), false);
  assert.equal(pickLocation("/sitemap.xml").mod, "=");
  assert.equal(pickLocation("/sitemaps/a.xml").mod, "^~");
});

test("header sets per location", () => {
  const find = (mod, pattern) => locations.find((l) => l.mod === mod && l.pattern === pattern);
  const val = (l, name) => dirsOf(l, "add_header").find((d) => d.args[0] === name);
  const withHeaders = locations.filter((l) => dirsOf(l, "add_header").length);
  assert.ok(withHeaders.length >= 6);
  for (const l of withHeaders) {
    for (const d of dirsOf(l, "add_header")) {
      if (d.args[0] === "Cache-Control") continue; // kept exactly as in the live block
      assert.equal(d.args.at(-1), "always", `${l.mod} ${l.pattern} ${d.args[0]}`);
    }
  }
  const defaults = [find("=", "/"), find("^~", "/embed/"), find("^~", "/api/"), find("", "/"), locations.find((l) => l.mod === "~" && dirsOf(l, "try_files").length)];
  for (const l of defaults) {
    assert.ok(l, "default-set location missing");
    assert.deepEqual(headerNames(l), DEFAULT_SET, `${l.mod} ${l.pattern}`);
    assert.match(val(l, "Content-Security-Policy").args[1], /^frame-ancestors 'none'$/);
    assert.equal(val(l, "X-Frame-Options").args[1], "DENY");
    if (l.pattern !== "/embed/" && l.pattern !== "/api/") assert.equal(val(l, "X-Robots-Tag").args[1], "$robots_tag", l.pattern);
  }
  assert.equal(val(find("^~", "/embed/"), "X-Robots-Tag").args[1], "noindex");
  assert.equal(val(find("^~", "/api/"), "X-Robots-Tag").args[1], "noindex");
  const chart = find("^~", "/embed/chart/");
  assert.deepEqual(headerNames(chart), ["Content-Security-Policy", "X-Robots-Tag"]);
  assert.match(val(chart, "Content-Security-Policy").args[1], /crypticpump\.com/);
  assert.equal(val(chart, "X-Robots-Tag").args[1], "noindex");
  const assets = find("^~", "/assets/");
  assert.deepEqual(headerNames(assets), ["Cache-Control", "Content-Security-Policy", "X-Content-Type-Options"]);
});

const EVM = "0x1234567890abcdef1234567890abcdef12345678";
const MINT = "So11111111111111111111111111111111111111112";

test("index routes go to the renderer proxy", () => {
  const index = ["/", "/coins", "/warzone", "/warzone/battles", "/warzone/major-war-league", "/warzone/tournaments", "/league", "/war-room", "/airdrops", "/airdrops/winners", "/recruiters", "/squads", "/playbook", "/sponsorships/apply", "/create",
    `/token/${EVM}`, `/token/${MINT}`, "/warzone/battles/arena-mprhklw2-c5aa2c", "/warzone/tournaments/t-12", "/prepare/my-coin_1", "/post/12345", "/recruiters/ABC123", `/profile/${EVM}`, `/profile/${MINT}`];
  for (const p of index) {
    const l = pickLocation(p);
    assert.ok(isRenderProxy(l), `${p} -> ${l.mod} ${l.pattern.slice(0, 40)}`);
  }
  // every kind "index" rule in seoRoutes is covered
  for (const r of ROUTE_RULES.filter((x) => x.kind === "index")) {
    const sample = r.pattern.replace(/:wallet/, EVM).replace(/:[a-z]+/i, "abc123");
    assert.ok(isRenderProxy(pickLocation(sample)), sample);
  }
});

test("noindex, client-only and loop-guard paths never reach the renderer", () => {
  for (const p of ["/token/abc/edit", "/profile/w/command/x", "/profile/@handle", "/drafts/x/promotion", "/drafts/x/push-live", "/profile", "/live", "/status", "/story/101/x", "/r/code", "/embed/chart/101/x", "/import", "/recruiter", "/command", "/command/coins",
    "/index.html", "/assets/x.js", "/robots.txt", "/sitemap.xml", "/sitemaps/a.xml", "/api/arena/battles", "/logo.png", "/nope", "/__render/coins", "/__render/"]) {
    assert.ok(!isRenderProxy(pickLocation(p)), p);
  }
  const l = pickLocation("/__render/x");
  assert.deepEqual([l.mod, l.pattern], ["^~", "/__render/"]);
  assert.deepEqual(dirsOf(l, "return")[0].args, ["404"]);
});

test("renderer proxy directives and @spa fallback", () => {
  const proxies = locations.filter(isRenderProxy);
  assert.equal(proxies.length, 2); // exact "/" and the regex for the other index routes
  const one = (l, name) => dirsOf(l, name).map((d) => d.args.join(" "));
  for (const l of proxies) {
    assert.deepEqual(one(l, "set"), ["$api https://api.memewar.zone"]);
    assert.deepEqual(one(l, "proxy_pass"), ["$api/__render$request_uri"]);
    assert.deepEqual(one(l, "proxy_set_header").sort(), ['Authorization ', "Cookie ", "Host api.memewar.zone"].sort());
    assert.deepEqual(one(l, "proxy_connect_timeout"), ["1s"]);
    assert.deepEqual(one(l, "proxy_read_timeout"), ["3s"]);
    assert.deepEqual(one(l, "proxy_http_version"), ["1.1"]);
    assert.deepEqual(one(l, "proxy_ssl_server_name"), ["on"]);
    assert.deepEqual(one(l, "proxy_intercept_errors"), ["on"]);
    const ep = dirsOf(l, "error_page");
    assert.equal(ep.length, 1);
    assert.deepEqual(ep[0].args, ["401", "403", "408", "429", "500", "502", "503", "504", "=", "@spa"]);
    assert.ok(!ep[0].args.includes("404"));
    const hidden = dirsOf(l, "proxy_hide_header").map((d) => d.args[0]).sort();
    assert.deepEqual(hidden, ["Access-Control-Allow-Credentials", "Access-Control-Allow-Origin", "Content-Security-Policy", "Set-Cookie", "Strict-Transport-Security", "X-Frame-Options", "X-Powered-By"].sort());
    assert.ok(!hidden.includes("X-Robots-Tag"));
    assert.deepEqual(headerNames(l), DEFAULT_SET);
    assert.equal(dirsOf(l, "add_header").filter((d) => d.args[0] === "X-Robots-Tag").length, 1);
    for (const d of dirsOf(l, "add_header")) assert.equal(d.args.at(-1), "always");
  }
  const spa = locations.find((l) => l.mod === "" && l.pattern === "@spa");
  assert.ok(spa, "@spa missing");
  assert.deepEqual(headerNames(spa), DEFAULT_SET);
  assert.deepEqual(dirsOf(spa, "try_files")[0].args, ["/index.html", "=404"]);
  assert.equal(dirsOf(spa, "error_page").length, 0);
});

test("regex order: trailing slash, aliases, proxy, allowlist", () => {
  const regex = locations.filter((l) => l.re);
  const idx = (f) => regex.findIndex(f);
  const lastAlias = regex.map((l, i) => (isRedirect(l) ? i : -1)).reduce((a, b) => Math.max(a, b));
  assert.ok(idx(isRenderProxy) > lastAlias);
  assert.ok(idx((l) => dirsOf(l, "try_files").length > 0) > idx(isRenderProxy));
});
