import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/memewarzone_test";
process.env.PG_DISABLE_SSL = "1";
process.env.NODE_ENV = "test";
process.env.API_AUTH_ENFORCE_USER_WRITES = "1";
process.env.RANK_EVENTS_TOKEN = "test-internal-upsert-token";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "upsert.js"), "utf8");

const CAMPAIGN = "0xa2bab12270d724ce70d5462024fe0d067b8b94e5";
const TOKEN = "0xa9d9350de50b2b413663b3f0b08352a8d92871d5";

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    setHeader() {},
    end(raw) {
      this.body = raw ? JSON.parse(String(raw)) : null;
    },
  };
}

function mockReq(body, headers = {}) {
  return {
    method: "POST",
    body,
    headers,
    url: "/api/campaigns/upsert",
  };
}

function installPool(pool, { consumeNonce = true } = {}) {
  pool.query = async (sql) => {
    if (String(sql).includes("update public.auth_nonces")) {
      return consumeNonce ? { rows: [{ expires_at: new Date(Date.now() + 60_000).toISOString() }] } : { rows: [] };
    }
    return { rows: [] };
  };
}

test("upsert binds dual-auth helpers instead of relying on globals", () => {
  assert.match(source, /from "\.\.\/lib\/apiAuth\.js"/);
  assert.match(source, /from "\.\.\/lib\/walletActionAuth\.js"/);
  assert.match(source, /getExpectedInternalToken/);
  assert.match(source, /readInternalToken/);
  assert.match(source, /requireWalletActionAuth/);
});

test("valid internal token returns 200 and never 500", async () => {
  const { default: handler } = await import("./upsert.js");
  const { pool } = await import("../../server/db.js");
  installPool(pool);
  const wallet = ethers.Wallet.createRandom().address.toLowerCase();
  const res = mockRes();
  await handler(
    mockReq(
      {
        chainId: 56,
        campaignAddress: CAMPAIGN,
        tokenAddress: TOKEN,
        creatorAddress: wallet,
        name: "BNBisTHeWay",
        symbol: "BTW",
      },
      { authorization: "Bearer test-internal-upsert-token" },
    ),
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body?.ok, true);
  assert.notEqual(res.statusCode, 500);
});

test("valid creator signature returns 200", async () => {
  const { default: handler } = await import("./upsert.js");
  const { pool } = await import("../../server/db.js");
  const { buildWalletActionMessage } = await import("../lib/walletActionAuth.js");
  installPool(pool);
  const signer = ethers.Wallet.createRandom();
  const wallet = signer.address.toLowerCase();
  const nonce = "upsert-nonce-1";
  const message = buildWalletActionMessage({
    action: "campaign_upsert",
    walletAddress: wallet,
    chainId: 56,
    nonce,
    extraLines: [`Campaign: ${CAMPAIGN}`],
  });
  const signature = await signer.signMessage(message);
  const res = mockRes();
  await handler(
    mockReq({
      chainId: 56,
      campaignAddress: CAMPAIGN,
      tokenAddress: TOKEN,
      creatorAddress: wallet,
      name: "BNBisTHeWay",
      symbol: "BTW",
      action: "campaign_upsert",
      walletAddress: wallet,
      nonce,
      message,
      signature,
    }),
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body?.ok, true);
});

test("missing auth returns 401 not 500 when user-write enforce is on", async () => {
  const { default: handler } = await import("./upsert.js");
  const { pool } = await import("../../server/db.js");
  installPool(pool);
  const wallet = ethers.Wallet.createRandom().address.toLowerCase();
  const res = mockRes();
  await handler(
    mockReq({
      chainId: 56,
      campaignAddress: CAMPAIGN,
      tokenAddress: TOKEN,
      creatorAddress: wallet,
      name: "BNBisTHeWay",
      symbol: "BTW",
    }),
    res,
  );
  assert.equal(res.statusCode, 401);
  assert.equal(res.body?.code, "SIGNATURE_REQUIRED");
  assert.notEqual(res.statusCode, 500);
  assert.notEqual(res.body?.error, "Server error");
});

test("undefined auth helpers cannot collapse upsert into a generic 500", async () => {
  const { getExpectedInternalToken, readInternalToken } = await import("../lib/apiAuth.js");
  const { requireWalletActionAuth } = await import("../lib/walletActionAuth.js");
  assert.equal(typeof getExpectedInternalToken, "function");
  assert.equal(typeof readInternalToken, "function");
  assert.equal(typeof requireWalletActionAuth, "function");
  const { default: handler } = await import("./upsert.js");
  const { pool } = await import("../../server/db.js");
  installPool(pool);
  const res = mockRes();
  await handler(mockReq({ chainId: 56 }), res);
  assert.notEqual(res.statusCode, 500);
  assert.equal(res.statusCode, 400);
});
