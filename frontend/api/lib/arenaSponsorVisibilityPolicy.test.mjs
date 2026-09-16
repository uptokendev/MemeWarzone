import assert from "node:assert/strict";
import test from "node:test";

import {
  PUBLIC_SPONSOR_EVENT_TYPES,
  canonicalPublicSponsorEventType,
  projectPublicSponsors,
  publicSponsorRegistryTypes,
} from "./arenaSponsorVisibilityPolicy.mjs";

const active = {
  sponsor_profile_id: "profile-a",
  project_name: "Project A",
  sponsorship_status: "active",
  payment_status: "confirmed",
  profile_status: "approved",
  event_window_valid: true,
};

test("ACTIVE + paid + approved + valid window is visible", () => {
  assert.deepEqual(projectPublicSponsors([active]), [{ sponsorProfileId: "profile-a", projectName: "Project A", foundingSponsor: false }]);
});

for (const [label, patch] of [
  ["pending sponsorship", { sponsorship_status: "pending_payment" }],
  ["cancelled sponsorship", { sponsorship_status: "cancelled" }],
  ["payment not confirmed", { payment_status: "pending" }],
  ["expired event window", { event_window_valid: false }],
  ["unapproved sponsor profile", { profile_status: "submitted" }],
]) {
  test(`${label} is hidden`, () => {
    assert.deepEqual(projectPublicSponsors([{ ...active, ...patch }]), []);
  });
}

test("legacy and canonical quarterly rows cannot duplicate sponsor attribution", () => {
  const duplicate = { ...active, event_founding_sponsor: true };
  assert.deepEqual(projectPublicSponsors([active, duplicate]), [{ sponsorProfileId: "profile-a", projectName: "Project A", foundingSponsor: false }]);
});

test("event classes remain isolated and legacy quarterly is canonical read compatibility only", () => {
  assert.deepEqual(PUBLIC_SPONSOR_EVENT_TYPES, ["normal_tournament", "vote_tournament", "monthly_mwl", "quarterly_championship"]);
  assert.equal(canonicalPublicSponsorEventType("monthly_mwl"), "monthly_mwl");
  assert.equal(canonicalPublicSponsorEventType("mwl_quarter_finals"), "quarterly_championship");
  assert.deepEqual(publicSponsorRegistryTypes("monthly_mwl"), ["monthly_mwl"]);
  assert.deepEqual(publicSponsorRegistryTypes("quarterly_championship"), ["quarterly_championship", "mwl_quarter_finals"]);
});

test("distinct sponsor profiles remain independently visible", () => {
  const rows = [active, { ...active, sponsor_profile_id: "profile-b", project_name: "Project B" }];
  assert.deepEqual(projectPublicSponsors(rows).map((item) => item.sponsorProfileId), ["profile-a", "profile-b"]);
});
