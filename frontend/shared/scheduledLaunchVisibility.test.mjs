import assert from "node:assert/strict";
import test from "node:test";

import { tradingPageClosedUntil } from "./scheduledLaunchVisibility.mjs";

const now = 1_700_000_000;

test("a Solana countdown stays closed until scheduled_launch_at", () => {
  assert.equal(
    tradingPageClosedUntil({ status: "scheduled", scheduledLaunchAt: now + 600, gen8OpenAt: null, nowSec: now }),
    now + 600,
  );
  assert.equal(
    tradingPageClosedUntil({ status: "scheduled", scheduledLaunchAt: now - 1, gen8OpenAt: null, nowSec: now }),
    null,
  );
});

test("a gen-8 pool openAt keeps the coin page closed even when the draft says deployed", () => {
  assert.equal(
    tradingPageClosedUntil({ status: "deployed", scheduledLaunchAt: null, gen8OpenAt: now + 3600, nowSec: now }),
    now + 3600,
  );
  assert.equal(
    tradingPageClosedUntil({ status: "deployed", scheduledLaunchAt: null, gen8OpenAt: now, nowSec: now }),
    null,
  );
});

test("an immediate launch is public", () => {
  assert.equal(
    tradingPageClosedUntil({ status: "deployed", scheduledLaunchAt: null, gen8OpenAt: null, nowSec: now }),
    null,
  );
});
