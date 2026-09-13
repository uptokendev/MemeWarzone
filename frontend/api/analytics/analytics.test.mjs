import assert from "node:assert/strict";
import test from "node:test";
import { CATALOG_EVENT_NAMES } from "./catalog.js";
import { isForbiddenEventName, stripForbiddenProperties } from "./denylist.js";
import { sanitizeEvent } from "./ingest.js";
import { templatePath } from "./paths.js";

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

test("forbidden money properties are stripped", () => {
  const cleaned = stripForbiddenProperties({
    fn: "buy",
    amount: 12,
    fee: 0.1,
    value: 99,
    ok: true,
  });
  assert.deepEqual(cleaned, { fn: "buy", ok: true });
});

test("web vital keeps numeric measurement without weakening generic value denylist", () => {
  const event = sanitizeEvent(
    {
      event_id: "11111111-1111-4111-8111-111111111111",
      anonymous_id: "22222222-2222-4222-8222-222222222222",
      session_id: "33333333-3333-4333-8333-333333333333",
      app: "public",
      name: "$web_vital",
      page: { path: "/" },
      properties: { metric: "LCP", value: 1240.5, rating: "good" },
    },
    {
      headers: {
        "cf-ipcountry": "NL",
        "user-agent": "Mozilla/5.0 Chrome/152.0.0.0 Safari/537.36",
      },
      ip: "203.0.113.10",
    },
  );
  assert.equal(event?.properties.value, undefined);
  assert.equal(event?.properties.measurement, 1240.5);
  assert.equal(event?.properties.metric, "LCP");
  assert.equal(event?.context.country, "NL");
});

test("path templates hide wallets and ids", () => {
  assert.equal(templatePath("/token/0x1234567890abcdef1234567890abcdef12345678"), "/token/:address");
  assert.equal(templatePath("/analytics/sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), "/analytics/sessions/:id");
});
