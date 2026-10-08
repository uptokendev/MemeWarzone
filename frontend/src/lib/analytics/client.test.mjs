// The tracker sends CLS and INP once per page view with the final value (on hidden / pagehide and on
// SPA route change), LCP and TTFB once, and attributes a page's vitals to that page's path.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const dir = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(dir, "../..");
const compiled = await build({
  absWorkingDir: dir,
  stdin: { contents: `export { AnalyticsClient } from "./client.ts";`, resolveDir: dir, sourcefile: "clientHarness.ts", loader: "ts" },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  packages: "external",
  alias: { "@": srcRoot },
});
const { AnalyticsClient } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);

function setupBrowser() {
  const listeners = new Map();
  const observers = new Map();
  const storage = new Map();
  const sent = [];
  const location = { pathname: "/", search: "" };
  globalThis.window = {
    location,
    innerWidth: 1280,
    innerHeight: 800,
    setInterval: () => 1,
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) || []), fn]),
  };
  globalThis.document = { visibilityState: "visible", title: "MemeWarzone", referrer: "" };
  Object.defineProperty(globalThis, "navigator", { value: { language: "en" }, configurable: true });
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
  };
  globalThis.fetch = async (_url, init) => {
    sent.push(...JSON.parse(init.body).events);
    return { ok: true };
  };
  globalThis.PerformanceObserver = class {
    constructor(callback) {
      this.callback = callback;
    }
    observe(options) {
      observers.set(options.type, this.callback);
    }
  };
  globalThis.performance = { getEntriesByType: () => [{ responseStart: 120 }] };

  const emit = (type, entries) => observers.get(type)?.({ getEntries: () => entries });
  const fire = (type) => (listeners.get(type) || []).forEach((fn) => fn());
  const hide = () => {
    document.visibilityState = "hidden";
    fire("visibilitychange");
  };
  const show = () => {
    document.visibilityState = "visible";
    fire("visibilitychange");
  };
  return { location, emit, fire, hide, show, sent };
}

function startClient(browser) {
  const client = new AnalyticsClient();
  client.init({ endpoint: "https://api.example.test/api/analytics/ingest", writeKey: "k", app: "public" });
  client.observeWebVitals();
  client.page("/");
  return client;
}

const vitals = (client, browser, metric) =>
  [...browser.sent, ...client.queue].filter((e) => e.name === "$web_vital" && (!metric || e.properties.metric === metric));

test("CLS and INP are not sent per layout shift or interaction, only once when the page is hidden", async () => {
  const browser = setupBrowser();
  const client = startClient(browser);
  for (let i = 0; i < 200; i += 1) {
    browser.emit("layout-shift", [{ startTime: 100 + i * 10, value: 0.001, hadRecentInput: false }]);
    browser.emit("event", [{ interactionId: 1000 + i, duration: 48 + (i % 5) * 8 }]);
  }
  assert.equal(vitals(client, browser, "CLS").length, 0);
  assert.equal(vitals(client, browser, "INP").length, 0);

  browser.hide();
  await new Promise((r) => setImmediate(r));
  assert.equal(vitals(client, browser, "CLS").length, 1);
  assert.equal(vitals(client, browser, "INP").length, 1);

  // Coming back and leaving again on the same page view does not send a second value.
  browser.show();
  browser.emit("event", [{ interactionId: 5000, duration: 900 }]);
  browser.hide();
  browser.fire("pagehide");
  await new Promise((r) => setImmediate(r));
  assert.equal(vitals(client, browser, "CLS").length, 1);
  assert.equal(vitals(client, browser, "INP").length, 1);
});

test("LCP and TTFB are sent once", async () => {
  const browser = setupBrowser();
  const client = startClient(browser);
  browser.emit("largest-contentful-paint", [{ startTime: 1800 }]);
  browser.emit("largest-contentful-paint", [{ startTime: 2600 }]);
  browser.hide();
  client.page("/arena");
  browser.hide();
  await new Promise((r) => setImmediate(r));
  const lcp = vitals(client, browser, "LCP");
  assert.equal(lcp.length, 1);
  assert.equal(lcp[0].properties.value, 1800);
  assert.equal(vitals(client, browser, "TTFB").length, 1);
});

test("an SPA route change reports the previous page's final CLS / INP under that page, then starts fresh", async () => {
  const browser = setupBrowser();
  const client = startClient(browser);
  browser.emit("layout-shift", [{ startTime: 100, value: 0.05 }, { startTime: 300, value: 0.04 }]);
  browser.emit("event", [{ interactionId: 1, duration: 64 }, { interactionId: 1, duration: 120 }, { interactionId: 2, duration: 80 }]);

  browser.location.pathname = "/arena";
  client.page("/arena");
  const first = vitals(client, browser);
  assert.deepEqual(first.map((e) => e.properties.metric).sort(), ["CLS", "INP", "TTFB"]);
  const cls = first.find((e) => e.properties.metric === "CLS");
  const inp = first.find((e) => e.properties.metric === "INP");
  assert.equal(cls.properties.value, 0.09);
  assert.equal(inp.properties.value, 120, "longest duration of the longest interaction");
  assert.equal(cls.page.path, "/", "attributed to the page it happened on");
  assert.equal(inp.page.path, "/");

  // Nothing new on /arena: no CLS / INP for it.
  browser.hide();
  await new Promise((r) => setImmediate(r));
  assert.equal(vitals(client, browser, "CLS").length, 1);
  assert.equal(vitals(client, browser, "INP").length, 1);

  browser.show();
  browser.location.pathname = "/league";
  client.page("/league");
  browser.emit("event", [{ interactionId: 9, duration: 300 }]);
  browser.hide();
  await new Promise((r) => setImmediate(r));
  const inps = vitals(client, browser, "INP");
  assert.equal(inps.length, 2);
  assert.equal(inps[1].properties.value, 300);
  assert.equal(inps[1].properties.rating, "needs-improvement");
  assert.equal(inps[1].page.path, "/league");
});

test("CLS uses the largest session window and ignores shifts right after input", () => {
  const browser = setupBrowser();
  const client = startClient(browser);
  // Window 1: 0.1 + 0.1 within 1 s gaps. Window 2 (gap > 1 s): 0.15. Input-driven shift ignored.
  browser.emit("layout-shift", [
    { startTime: 0, value: 0.1 },
    { startTime: 900, value: 0.1 },
    { startTime: 3000, value: 0.15 },
    { startTime: 3100, value: 5, hadRecentInput: true },
  ]);
  assert.ok(Math.abs(client.currentCls() - 0.2) < 1e-12);
  // A window is capped at 5 s: shifts every 900 ms for 7 s split into two windows.
  const other = startClient(setupBrowser());
  for (let t = 0; t <= 7000; t += 900) other.recordLayoutShift({ startTime: t, value: 0.01 });
  assert.ok(Math.abs(other.currentCls() - 0.06) < 1e-12);
});

test("INP skips one outlier per 50 interactions and ignores non-interaction events", () => {
  const client = startClient(setupBrowser());
  client.recordInteraction({ interactionId: 0, duration: 999 });
  assert.equal(client.currentInp(), null);
  for (let i = 1; i <= 120; i += 1) client.recordInteraction({ interactionId: i, duration: i });
  // 120 interactions: skip the 2 longest (floor(120 / 50)), INP = 118.
  assert.equal(client.currentInp(), 118);
});
