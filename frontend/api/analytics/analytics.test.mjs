import assert from "node:assert/strict";
import test from "node:test";
import { CATALOG_EVENT_NAMES } from "./catalog.js";
import { isForbiddenEventName, stripForbiddenProperties } from "./denylist.js";
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
    ok: true,
  });
  assert.deepEqual(cleaned, { fn: "buy", ok: true });
});

test("path templates hide wallets and ids", () => {
  assert.equal(templatePath("/token/0x1234567890abcdef1234567890abcdef12345678"), "/token/:address");
  assert.equal(templatePath("/analytics/sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), "/analytics/sessions/:id");
});
