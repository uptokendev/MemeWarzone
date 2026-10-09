import assert from "node:assert/strict";
import test from "node:test";
import {
  AnalyticsWindowError,
  MAX_WINDOW_DAYS,
  normalizeTimeZone,
  parseWindow,
  seriesGranularity,
} from "./window.js";

const NOW = Date.parse("2026-10-08T10:37:12.345Z");
const DAY = 24 * 3600e3;
const iso = (ms) => new Date(ms).toISOString();

test("defaults: to = now, from = 7 days before, hourly, UTC", () => {
  const w = parseWindow({}, NOW);
  assert.equal(w.to, iso(NOW));
  assert.equal(w.from, iso(NOW - 7 * DAY));
  assert.equal(w.app, "public");
  assert.equal(w.granularity, "hour");
  assert.equal(w.timeZone, "UTC");
});

test("unparseable from/to fall back to the defaults as before", () => {
  const w = parseWindow({ from: "nope", to: "also nope" }, NOW);
  assert.equal(w.to, iso(NOW));
  assert.equal(w.from, iso(NOW - 7 * DAY));
});

test("granularity: hour up to 7 days, day beyond, explicit value honoured", () => {
  assert.equal(seriesGranularity(iso(NOW - 7 * DAY), iso(NOW)), "hour");
  assert.equal(seriesGranularity(iso(NOW - 7 * DAY - 1), iso(NOW)), "day");
  assert.equal(seriesGranularity(iso(NOW - 30 * DAY), iso(NOW)), "day");
  assert.equal(seriesGranularity(iso(NOW - DAY), iso(NOW), "day"), "day");
  assert.equal(seriesGranularity(iso(NOW - 30 * DAY), iso(NOW), "hour"), "hour");
  assert.throws(() => seriesGranularity(iso(NOW - 32 * DAY), iso(NOW), "hour"), AnalyticsWindowError);
  assert.throws(() => seriesGranularity(iso(NOW - DAY), iso(NOW), "week"), AnalyticsWindowError);
});

test("window cap: 366 local days pass (DST included), 367 days and reversed windows are 400", () => {
  // 366 whole Amsterdam days that include the autumn DST change are 366 days plus one hour.
  const from = Date.parse("2027-10-30T22:00:00.000Z");
  const w = parseWindow({ from: iso(from), to: iso(from + MAX_WINDOW_DAYS * DAY + 3600e3) }, NOW);
  assert.equal(w.granularity, "day");
  assert.throws(() => parseWindow({ from: iso(NOW - 367 * DAY), to: iso(NOW) }, NOW), (error) => {
    assert.ok(error instanceof AnalyticsWindowError);
    assert.equal(error.status, 400);
    assert.match(error.message, /366 days/);
    return true;
  });
  assert.throws(() => parseWindow({ from: iso(NOW), to: iso(NOW - DAY) }, NOW), AnalyticsWindowError);
});

test("time zone: IANA names pass, anything else is UTC", () => {
  assert.equal(normalizeTimeZone("Europe/Amsterdam"), "Europe/Amsterdam");
  assert.equal(normalizeTimeZone("America/New_York"), "America/New_York");
  assert.equal(normalizeTimeZone(""), "UTC");
  assert.equal(normalizeTimeZone("Not/AZone"), "UTC");
  assert.equal(normalizeTimeZone("Europe/Amsterdam'; drop table x"), "UTC");
  assert.equal(parseWindow({ tz: "Europe/Amsterdam", from: iso(NOW - 30 * DAY), to: iso(NOW) }, NOW).timeZone, "Europe/Amsterdam");
});
