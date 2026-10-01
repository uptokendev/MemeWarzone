import assert from "node:assert/strict";
import test from "node:test";

import { FEED_SESSION_ACTION, createFeedSessionToken, hashFeedSessionToken } from "./feedSessionToken.js";

test("feed session tokens hash to 64 hex chars", () => {
  const token = createFeedSessionToken();
  assert.equal(token.length, 64);
  const hash = hashFeedSessionToken(token);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hashFeedSessionToken(token), hash);
  assert.notEqual(hashFeedSessionToken(`${token}x`), hash);
});

test("feed session action is feed_open_session", () => {
  assert.equal(FEED_SESSION_ACTION, "feed_open_session");
});
