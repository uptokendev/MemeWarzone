import test from "node:test";
import assert from "node:assert/strict";
import { frameAllowedPath, isFramed, shouldRefuseFramed } from "./frameGuard.mjs";

const top = {};
const framedWin = (pathname) => ({ self: {}, top, location: { pathname } });
const topWin = (pathname) => {
  const w = { location: { pathname } };
  w.self = w;
  w.top = w;
  return w;
};

test("only the partner chart route may be framed", () => {
  assert.equal(frameAllowedPath("/embed/chart/101/abc"), true);
  assert.equal(frameAllowedPath("/embed/chart/56/0xabc?x=1"), true);
  assert.equal(frameAllowedPath("/"), false);
  assert.equal(frameAllowedPath("/token/56/0xabc"), false);
  assert.equal(frameAllowedPath("/embed/other"), false);
});

test("a framed app refuses every page except the chart; an unframed app never refuses", () => {
  assert.equal(shouldRefuseFramed(framedWin("/token/56/0xabc")), true);
  assert.equal(shouldRefuseFramed(framedWin("/create")), true);
  assert.equal(shouldRefuseFramed(framedWin("/embed/chart/101/abc")), false);
  assert.equal(shouldRefuseFramed(topWin("/token/56/0xabc")), false);
});

test("a cross-origin parent that throws on access counts as framed", () => {
  const w = { self: {}, location: { pathname: "/" } };
  Object.defineProperty(w, "top", { get() { throw new Error("SecurityError"); } });
  assert.equal(isFramed(w), true);
  assert.equal(shouldRefuseFramed(w), true);
});
