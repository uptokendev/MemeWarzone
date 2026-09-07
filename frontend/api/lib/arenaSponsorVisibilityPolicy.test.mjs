import assert from "node:assert/strict";
import test from "node:test";
import {
  PUBLIC_SPONSOR_EVENT_TYPES,
  canonicalPublicSponsorEventType,
  projectPublicSponsors,
  publicSponsorRegistryTypes,
  safeHttpsUrl,
} from "./arenaSponsorVisibilityPolicy.mjs";

const active = (overrides = {}) => ({
  sponsor_profile_id: "profile-a",
  sponsorship_status: "active",
  profile_status: "approved",
  project_name: "PROJECT A",
  founding_sponsor: false,
  ...overrides,
});

test("public visibility exposes Quarterly Championship but not the legacy Quarter Finals product name", () => {
  assert.deepEqual(PUBLIC_SPONSOR_EVENT_TYPES, [
    "normal_tournament",
    "vote_tournament",
    "monthly_mwl",
    "quarterly_championship",
  ]);
  assert.equal(PUBLIC_SPONSOR_EVENT_TYPES.includes("mwl_quarter_finals"), false);
  assert.equal(PUBLIC_SPONSOR_EVENT_TYPES.includes("weekly_league"), false);
  assert.equal(PUBLIC_SPONSOR_EVENT_TYPES.includes("battle"), false);
});

test("legacy quarterly registry identity maps to the canonical public Quarterly Championship", () => {
  assert.equal(canonicalPublicSponsorEventType("mwl_quarter_finals"), "quarterly_championship");
  assert.deepEqual(publicSponsorRegistryTypes("quarterly_championship"), ["quarterly_championship", "mwl_quarter_finals"]);
  assert.deepEqual(publicSponsorRegistryTypes("mwl_quarter_finals"), ["quarterly_championship", "mwl_quarter_finals"]);
});

test("only active sponsorships with approved sponsor profiles are publicly projected", () => {
  const rows = [
    active(),
    active({ sponsor_profile_id: "pending", sponsorship_status: "pending_payment", project_name: "PENDING" }),
    active({ sponsor_profile_id: "cancelled", sponsorship_status: "cancelled", project_name: "CANCELLED" }),
    active({ sponsor_profile_id: "expired", sponsorship_status: "expired", project_name: "EXPIRED" }),
    active({ sponsor_profile_id: "disabled", profile_status: "suspended", project_name: "DISABLED" }),
  ];
  assert.deepEqual(projectPublicSponsors(rows).map((row) => row.projectName), ["PROJECT A"]);
});

test("no sponsor produces no attribution payload", () => {
  assert.deepEqual(projectPublicSponsors([]), []);
});

test("multiple sponsors preserve deterministic authority order and dedupe profile identity across quarterly aliases", () => {
  const rows = [
    active({ sponsor_profile_id: "profile-a", project_name: "PROJECT A" }),
    active({ sponsor_profile_id: "profile-b", project_name: "PROJECT B" }),
    active({ sponsor_profile_id: "profile-a", project_name: "PROJECT A LEGACY DUPLICATE" }),
    active({ sponsor_profile_id: "profile-c", project_name: "PROJECT C" }),
  ];
  assert.deepEqual(projectPublicSponsors(rows).map((row) => row.projectName), ["PROJECT A", "PROJECT B", "PROJECT C"]);
});

test("safe link policy accepts HTTPS only for future authoritative destinations", () => {
  assert.equal(safeHttpsUrl("javascript:alert(1)"), null);
  assert.equal(safeHttpsUrl("http://example.com"), null);
  assert.equal(safeHttpsUrl("data:text/html,boom"), null);
  assert.equal(safeHttpsUrl("https://example.com/path"), "https://example.com/path");
});

test("public projection contains canonical promotional identity only", () => {
  const [row] = projectPublicSponsors([
    active({
      prize_native_raw: "700",
      marketing_native_raw: "200",
      protocol_native_raw: "100",
      payment_id: "payment-secret-ish",
      confirmed_at: "2026-09-07T00:00:00.000Z",
      signature_reference: "0xreceipt",
      verified_wallet: "0xwallet",
      logo_url: "https://legacy.example/logo.png",
      website_url: "https://legacy.example/",
      founding_sponsor: true,
    }),
  ]);
  assert.deepEqual(Object.keys(row).sort(), ["foundingSponsor", "projectName", "sponsorProfileId"].sort());
  assert.equal(row.foundingSponsor, true);
});
