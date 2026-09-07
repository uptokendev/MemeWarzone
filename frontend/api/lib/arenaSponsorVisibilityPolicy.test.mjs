import assert from "node:assert/strict";
import test from "node:test";
import { PUBLIC_SPONSOR_EVENT_TYPES, projectPublicSponsors, safeHttpsUrl } from "./arenaSponsorVisibilityPolicy.mjs";

const active = (overrides = {}) => ({
  sponsor_profile_id: "profile-a",
  sponsorship_status: "active",
  profile_status: "approved",
  project_name: "PROJECT A",
  logo_url: "https://cdn.example.com/a.png",
  website_url: "https://project-a.example/",
  founding_sponsor: false,
  founding_sponsor_badge: null,
  ...overrides,
});

test("public visibility supports the authoritative event classes without weekly-league expansion", () => {
  assert.deepEqual(PUBLIC_SPONSOR_EVENT_TYPES, [
    "normal_tournament",
    "vote_tournament",
    "monthly_mwl",
    "quarterly_championship",
    "mwl_quarter_finals",
  ]);
  assert.equal(PUBLIC_SPONSOR_EVENT_TYPES.includes("weekly_league"), false);
  assert.equal(PUBLIC_SPONSOR_EVENT_TYPES.includes("battle"), false);
});

test("only active sponsorships with approved sponsor profiles are publicly projected", () => {
  const rows = [
    active(),
    active({ sponsor_profile_id: "pending", sponsorship_status: "pending_payment", project_name: "PENDING" }),
    active({ sponsor_profile_id: "cancelled", sponsorship_status: "cancelled", project_name: "CANCELLED" }),
    active({ sponsor_profile_id: "expired", sponsorship_status: "expired", project_name: "EXPIRED" }),
    active({ sponsor_profile_id: "disabled", profile_status: "disabled", project_name: "DISABLED" }),
  ];
  assert.deepEqual(projectPublicSponsors(rows).map((row) => row.projectName), ["PROJECT A"]);
});

test("no sponsor produces no attribution payload", () => {
  assert.deepEqual(projectPublicSponsors([]), []);
});

test("multiple sponsors preserve deterministic authority order and dedupe profile identity", () => {
  const rows = [
    active({ sponsor_profile_id: "profile-a", project_name: "PROJECT A" }),
    active({ sponsor_profile_id: "profile-b", project_name: "PROJECT B" }),
    active({ sponsor_profile_id: "profile-a", project_name: "PROJECT A DUPLICATE" }),
    active({ sponsor_profile_id: "profile-c", project_name: "PROJECT C" }),
  ];
  assert.deepEqual(projectPublicSponsors(rows).map((row) => row.projectName), ["PROJECT A", "PROJECT B", "PROJECT C"]);
});

test("safe links accept HTTPS only", () => {
  assert.equal(safeHttpsUrl("javascript:alert(1)"), null);
  assert.equal(safeHttpsUrl("http://example.com"), null);
  assert.equal(safeHttpsUrl("data:text/html,boom"), null);
  assert.equal(safeHttpsUrl("https://example.com/path"), "https://example.com/path");
});

test("public projection contains promotional identity only", () => {
  const [row] = projectPublicSponsors([
    active({
      prize_native_raw: "700",
      marketing_native_raw: "200",
      protocol_native_raw: "100",
      payment_id: "payment-secret-ish",
      confirmed_at: "2026-09-07T00:00:00.000Z",
      signature_reference: "0xreceipt",
      verified_wallet: "0xwallet",
      founding_sponsor: true,
      founding_sponsor_badge: "FOUNDING",
    }),
  ]);
  assert.deepEqual(Object.keys(row).sort(), [
    "foundingSponsor",
    "foundingSponsorBadge",
    "logoUrl",
    "projectName",
    "sponsorProfileId",
    "websiteUrl",
  ].sort());
  assert.equal(row.foundingSponsor, true);
});
