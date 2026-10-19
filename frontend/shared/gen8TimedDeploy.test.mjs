import assert from "node:assert/strict";
import test from "node:test";
import { gen8DeployLanding } from "./gen8TimedDeploy.mjs";

const now = 1_700_000_000;

test("a future gen-8 open stays on the promotion page and stores the timer", () => {
  const landing = gen8DeployLanding({
    openAt: now + 3600,
    slug: "testdraft",
    tokenAddress: "0xabc",
    chainId: 97,
    nowSec: now,
  });
  assert.deepEqual(landing, { scheduledLaunchAt: now + 3600, path: "/prepare/testdraft" });
});

test("an immediate gen-8 launch opens the coin page and does not store a timer", () => {
  const landing = gen8DeployLanding({
    openAt: 0,
    slug: "testdraft",
    tokenAddress: "0xabc",
    chainId: 97,
    nowSec: now,
  });
  assert.deepEqual(landing, { scheduledLaunchAt: null, path: "/token/0xabc?chainId=97" });
});

test("an open time that has already passed opens the coin page", () => {
  const landing = gen8DeployLanding({
    openAt: now - 1,
    slug: "testdraft",
    tokenAddress: "0xabc",
    chainId: 46630,
    nowSec: now,
  });
  assert.equal(landing.scheduledLaunchAt, null);
  assert.equal(landing.path, "/token/0xabc?chainId=46630");
});
