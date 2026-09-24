import assert from "node:assert/strict";
import test from "node:test";

import { resolveAblyRestKey } from "./ablyRestKey.js";

test("the publish key is composed exactly like the token route's: full key, split pair, client key + secret, or nothing", () => {
  assert.equal(resolveAblyRestKey({ ABLY_API_KEY: "app.key:secret" }), "app.key:secret");
  assert.equal(resolveAblyRestKey({ ABLY_API_KEY: "app.key", ABLY_API_KEY_SECRET: "s" }), "app.key:s");
  assert.equal(resolveAblyRestKey({ ABLY_API_KEY_NAME: "app.key", ABLY_API_KEY_SECRET: "s" }), "app.key:s");
  assert.equal(resolveAblyRestKey({ VITE_ABLY_CLIENT_KEY: "app.key", ABLY_API_KEY_SECRET: "s" }), "app.key:s");
  assert.equal(resolveAblyRestKey({ ABLY_API_KEY: '"app.key:secret"' }), "app.key:secret");
  assert.equal(resolveAblyRestKey({ ABLY_API_KEY_SECRET: "s" }), "", "a secret alone is not a key");
  assert.equal(resolveAblyRestKey({}), "");
});

test("the creator-event publisher uses that composition, not ABLY_API_KEY alone", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync(new URL("./arenaCreatorAblyPublish.js", import.meta.url), "utf8");
  assert.match(source, /resolveAblyRestKey\(\)/);
  assert.doesNotMatch(source, /process\.env\.ABLY_API_KEY\b/);
});
