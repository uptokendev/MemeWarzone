import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CATALOG_EVENT_NAMES } from "./catalog.js";
import { isForbiddenEventName, stripForbiddenProperties } from "./denylist.js";
import { templatePath } from "./paths.js";

const ingestSource = await readFile(new URL("./ingest.js", import.meta.url), "utf8");

test("catalog includes reserved and product events", () => {
  assert.equal(CATALOG_EVENT_NAMES.has("$pageview"), true);
  assert.equal(CATALOG_EVENT_NAMES.has("buy_submitted"), true);
  assert.equal(CATALOG_EVENT_NAMES.has("admin_signed_in"), true);
});

test("finance and security names are rejected", () => {
  assert.equal(isForbiddenEventName("lp_fee_harvested"), true);
  assert.equal(isForbiddenEventName("recruiter_payout_marked"), true);
  assert.equal(isForbiddenEventName("security_audit_log_viewed"), true);
  assert.equal(isForbiddenEventName("diagnostics_refreshed"), true);
  assert.equal(isForbiddenEventName("buy_submitted"), false);
});

test("forbidden money properties including generic value are stripped", () => {
  const cleaned = stripForbiddenProperties({
    fn: "buy",
    amount: 12,
    fee: 0.1,
    value: 99,
    ok: true,
  });
  assert.deepEqual(cleaned, { fn: "buy", ok: true });
});

test("web vital ingestion narrowly remaps its numeric value to measurement", () => {
  assert.match(ingestSource, /if \(name === "\$web_vital"\)/);
  assert.match(ingestSource, /Number\(raw\.properties\?\.value\)/);
  assert.match(ingestSource, /trimmed\.measurement = measurement/);
  assert.match(ingestSource, /event\.properties\.measurement/);
  assert.doesNotMatch(ingestSource, /trimmed\.value\s*=/);
});

test("coarse geography comes from edge headers rather than client coordinates", () => {
  assert.match(ingestSource, /cf-ipcountry/);
  assert.match(ingestSource, /x-vercel-ip-country/);
  assert.match(ingestSource, /country: geo\.country/);
  assert.doesNotMatch(ingestSource, /latitude|longitude|geocode/i);
});

test("path templates hide wallets and ids", () => {
  assert.equal(templatePath("/token/0x1234567890abcdef1234567890abcdef12345678"), "/token/:address");
  assert.equal(templatePath("/analytics/sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), "/analytics/sessions/:id");
});
