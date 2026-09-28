import assert from "node:assert/strict";
import test from "node:test";
import {
  DBC_DUE_POPUP_COPY,
  isDueScheduledDraft,
  isScheduleLocked,
  shouldShowDbcDuePopup,
} from "../../shared/dbcSchedule.mjs";

test("due popup copy is the founder sentence", () => {
  assert.equal(DBC_DUE_POPUP_COPY, "Your launch time has arrived. Deploy now to go live.");
});

test("once-per-draft: dismissed ids are hidden until the next load clears them", () => {
  const dismissed = new Set(["draft-a"]);
  assert.equal(shouldShowDbcDuePopup({ draftId: "draft-a", dismissedIds: dismissed }), false);
  assert.equal(shouldShowDbcDuePopup({ draftId: "draft-b", dismissedIds: dismissed }), true);
  assert.equal(shouldShowDbcDuePopup({ draftId: "", dismissedIds: dismissed }), false);
});

test("schedule lock is true only before the time", () => {
  const now = Date.parse("2026-09-29T12:00:00Z");
  assert.equal(isScheduleLocked("2026-09-29T12:05:00Z", now), true);
  assert.equal(isScheduleLocked("2026-09-29T11:59:00Z", now), false);
  assert.equal(isScheduleLocked(null, now), false);
});

test("due drafts are the wallet's own scheduled DBC rows past the time", () => {
  const now = Date.parse("2026-09-29T12:00:00Z");
  assert.equal(isDueScheduledDraft({
    launchType: "dbc",
    status: "scheduled",
    scheduledLaunchAt: "2026-09-29T11:00:00Z",
  }, now), true);
  assert.equal(isDueScheduledDraft({
    launchType: "dbc",
    status: "scheduled",
    scheduledLaunchAt: "2026-09-29T13:00:00Z",
  }, now), false);
  assert.equal(isDueScheduledDraft({
    launchType: "launchpad",
    status: "scheduled",
    scheduledLaunchAt: "2026-09-29T11:00:00Z",
  }, now), false);
  assert.equal(isDueScheduledDraft({
    launchType: "dbc",
    status: "deployed",
    campaignAddress: "pool",
    scheduledLaunchAt: "2026-09-29T11:00:00Z",
  }, now), false);
});
