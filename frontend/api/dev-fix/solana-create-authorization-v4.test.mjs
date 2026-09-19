import assert from "node:assert/strict";
import test from "node:test";

import { solanaCreateAuthorizationV4 } from "./solana-create-authorization-v4.js";

// Metaplex metadata needs an absolute uri, so the create path now requires this.
process.env.PUBLIC_API_BASE_URL = process.env.PUBLIC_API_BASE_URL || "https://api.memewar.zone";

function responseRecorder() {
  let body = null;
  return {
    statusCode: 200,
    headers: new Map(),
    setHeader(name, value) {
      this.headers.set(String(name).toLowerCase(), value);
    },
    end(value) {
      body = value == null || value === "" ? null : JSON.parse(String(value));
    },
    get body() {
      return body;
    },
  };
}

function request(body = {}, draftId = "draft-id") {
  return {
    method: "POST",
    body,
    params: { draftId },
    async *[Symbol.asyncIterator]() {
      // Express has already populated req.body in production.
    },
  };
}

async function withEnv(values, work) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await work();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function loadDraftDeploy() {
  const module = await import("./draft-deploy.js");
  return module.draftDeploy;
}

test("Solana create authorization is disabled by default", async () => {
  await withEnv({ SOLANA_CREATE_AUTH_ENABLED: null }, async () => {
    const res = responseRecorder();
    await solanaCreateAuthorizationV4(request({}), res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, "SOLANA_CREATE_AUTH_DISABLED");
  });
});

test("enabled endpoint rejects a missing draft id before database access", async () => {
  await withEnv({ SOLANA_CREATE_AUTH_ENABLED: "true" }, async () => {
    const res = responseRecorder();
    await solanaCreateAuthorizationV4(request({}, ""), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "DRAFT_ID_REQUIRED");
  });
});

test("Direct Create remains blocked until canonical reservation preflight exists", async () => {
  await withEnv({ SOLANA_CREATE_AUTH_ENABLED: "true" }, async () => {
    const res = responseRecorder();
    await solanaCreateAuthorizationV4(request({ mode: "direct_create" }), res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, "SOLANA_DIRECT_CREATE_NOT_READY");
  });
});

test("draft deploy route requires accepted generation-manifest evidence", async () => {
  await withEnv(
    {
      DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
      SOLANA_GENERATION_MANIFEST_HASH: null,
    },
    async () => {
      const draftDeploy = await loadDraftDeploy();
      const res = responseRecorder();
      await draftDeploy(
        request({
          operation: "authorize_solana_v4",
          graduationTargetUsdMicros: "6000000",
          launchAt: "0",
        }),
        res,
      );
      assert.equal(res.statusCode, 503);
      assert.equal(res.body.code, "SOLANA_CREATE_CONFIGURATION_INCOMPLETE");
    },
  );
});

test("draft deploy route rejects malformed unsigned Solana economics and time values", async () => {
  await withEnv(
    {
      DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
      SOLANA_GENERATION_MANIFEST_HASH: "a".repeat(64),
    },
    async () => {
      const draftDeploy = await loadDraftDeploy();
      const targetRes = responseRecorder();
      await draftDeploy(
        request({
          operation: "authorize_solana_v4",
          graduationTargetUsdMicros: "6.00",
          launchAt: "0",
        }),
        targetRes,
      );
      assert.equal(targetRes.statusCode, 400);
      assert.equal(targetRes.body.code, "SOLANA_GRADUATION_TARGET_INVALID");

      const launchRes = responseRecorder();
      await draftDeploy(
        request({
          operation: "authorize_solana_v4",
          graduationTargetUsdMicros: "6000000",
          launchAt: "tomorrow",
        }),
        launchRes,
      );
      assert.equal(launchRes.statusCode, 400);
      assert.equal(launchRes.body.code, "SOLANA_LAUNCH_TIME_INVALID");
    },
  );
});
