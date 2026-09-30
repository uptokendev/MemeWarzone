import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import {
  CREATE_CANARY_CODE,
  CREATE_CANARY_MESSAGE,
  isCreateAllowedForWallet,
  isCreateCanaryActive,
} from "./createCanary.js";
import { createLaunchStatusHandler } from "../launch-status.js";

// The route modules import the DB module, which needs a URL (never connected in these tests).
process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:1/test";
const { routingCreateAuthorization } = await import("../dev-fix/route-auth.js");
const { solanaDirectCreateV4 } = await import("../dev-fix/solana-direct-create.js");
const { launchpadPreflightCreate } = await import("../dev-fix/security-current-time.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const EVM_FOUNDER = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const EVM_OTHER = "0x2222222222222222222222222222222222222222";
const SOL_FOUNDER = Keypair.generate().publicKey.toBase58();
const SOL_OTHER = Keypair.generate().publicKey.toBase58();

function fakeRes() {
  return {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    end(text) { this.body = text ? JSON.parse(text) : null; },
  };
}

async function call(handler, body, method = "POST") {
  const res = fakeRes();
  await handler({ method, url: "http://localhost/", headers: {}, body }, res);
  return res;
}

function withEnv(values, fn) {
  return async () => {
    const saved = {};
    for (const key of Object.keys(values)) saved[key] = process.env[key];
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      await fn();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
}

function assertCanaryRefusal(res) {
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, CREATE_CANARY_CODE);
  assert.equal(res.body.error, CREATE_CANARY_MESSAGE);
}

const LIST = `${EVM_FOUNDER}, ${SOL_FOUNDER}`;

test("allowlist: EVM compares case-insensitively, Solana exactly, unset or empty is off", () => {
  const env = { CREATE_CANARY_WALLETS: LIST };
  assert.equal(isCreateCanaryActive(env), true);
  assert.equal(isCreateAllowedForWallet(EVM_FOUNDER.toLowerCase(), env), true);
  assert.equal(isCreateAllowedForWallet(EVM_FOUNDER.toUpperCase().replace("0X", "0x"), env), true);
  assert.equal(isCreateAllowedForWallet(EVM_OTHER, env), false);
  assert.equal(isCreateAllowedForWallet(SOL_FOUNDER, env), true);
  assert.equal(isCreateAllowedForWallet(SOL_FOUNDER.toLowerCase(), env), false);
  assert.equal(isCreateAllowedForWallet(SOL_OTHER, env), false);
  assert.equal(isCreateAllowedForWallet("", env), false);
  for (const value of [undefined, "", " ", " , ,"]) {
    const off = { CREATE_CANARY_WALLETS: value };
    assert.equal(isCreateCanaryActive(off), false);
    assert.equal(isCreateAllowedForWallet(EVM_OTHER, off), true);
    assert.equal(isCreateAllowedForWallet(SOL_OTHER, off), true);
  }
});

test("GET /api/launch-status reports the canary flag and never the list", async () => {
  const on = await call(createLaunchStatusHandler({ env: { CREATE_CANARY_WALLETS: LIST } }), undefined, "GET");
  assert.equal(on.statusCode, 200);
  assert.deepEqual(on.body, { canary: true });
  const off = await call(createLaunchStatusHandler({ env: {} }), undefined, "GET");
  assert.deepEqual(off.body, { canary: false });
  const post = await call(createLaunchStatusHandler({ env: {} }), {}, "POST");
  assert.equal(post.statusCode, 405);
});

// EVM create authorization: native, gen 6, BNB approved quote and Robinhood stock creates all sign
// in routingCreateAuthorization. A request with no name stops at 400 right after the gate, before
// any chain read, so a 400 proves the wallet got past the canary.
const EVM_ENV = { ROUTE_AUTHORITY_PRIVATE_KEY: "0x" + "11".repeat(32) };
const evmBody = (walletAddress, extra = {}) => ({
  walletAddress,
  factoryAddress: "0x1111111111111111111111111111111111111111",
  chainId: 56,
  campaignRequest: { name: "", symbol: "X", graduationTarget: "1" },
  ...extra,
});
const evmVariants = [
  ["native / gen 6", {}],
  ["BNB approved quote", { graduationQuoteAssetId: "quote-1" }],
  ["Robinhood stock", { chainId: 4663, stockToken: "0x3333333333333333333333333333333333333333" }],
];

for (const [label, extra] of evmVariants) {
  test(`EVM create authorization (${label}): other wallet is refused with CREATE_CANARY_ONLY`,
    withEnv({ ...EVM_ENV, CREATE_CANARY_WALLETS: LIST }, async () => {
      assertCanaryRefusal(await call(routingCreateAuthorization, evmBody(EVM_OTHER, extra)));
    }));
  test(`EVM create authorization (${label}): allowlisted wallet passes the gate (any case)`,
    withEnv({ ...EVM_ENV, CREATE_CANARY_WALLETS: LIST }, async () => {
      const res = await call(routingCreateAuthorization, evmBody(EVM_FOUNDER.toLowerCase(), extra));
      assert.equal(res.statusCode, 400);
      assert.notEqual(res.body.code, CREATE_CANARY_CODE);
    }));
  test(`EVM create authorization (${label}): unset env is unchanged`,
    withEnv({ ...EVM_ENV, CREATE_CANARY_WALLETS: undefined }, async () => {
      const res = await call(routingCreateAuthorization, evmBody(EVM_OTHER, extra));
      assert.equal(res.statusCode, 400);
      assert.notEqual(res.body.code, CREATE_CANARY_CODE);
    }));
}

// Legacy Solana launchpad Direct create. With SOLANA_CREATE_AUTH_ENABLED unset the next step after
// the gate answers 503 SOLANA_CREATE_AUTH_DISABLED, which proves the wallet got past the canary.
for (const operation of ["preflight", "begin"]) {
  const body = (creatorWallet) => ({ operation, creatorWallet, chainId: 101, ticker: "CANARY" });
  test(`Solana Direct ${operation}: other wallet is refused`,
    withEnv({ SOLANA_CREATE_AUTH_ENABLED: undefined, CREATE_CANARY_WALLETS: LIST }, async () => {
      assertCanaryRefusal(await call(solanaDirectCreateV4, body(SOL_OTHER)));
    }));
  test(`Solana Direct ${operation}: allowlisted wallet passes the gate`,
    withEnv({ SOLANA_CREATE_AUTH_ENABLED: undefined, CREATE_CANARY_WALLETS: LIST }, async () => {
      const res = await call(solanaDirectCreateV4, body(SOL_FOUNDER));
      assert.equal(res.body.code, "SOLANA_CREATE_AUTH_DISABLED");
    }));
  test(`Solana Direct ${operation}: unset env is unchanged`,
    withEnv({ SOLANA_CREATE_AUTH_ENABLED: undefined, CREATE_CANARY_WALLETS: undefined }, async () => {
      const res = await call(solanaDirectCreateV4, body(SOL_OTHER));
      assert.equal(res.body.code, "SOLANA_CREATE_AUTH_DISABLED");
    }));
}

test("launchpad preflight-create refuses a wallet off the list, in the preflight shape the client reads",
  withEnv({ CREATE_CANARY_WALLETS: LIST }, async () => {
    const res = await call(launchpadPreflightCreate, { walletAddress: EVM_OTHER });
    assertCanaryRefusal(res);
    assert.equal(res.body.preflight.allowed, false);
    assert.deepEqual(res.body.preflight.reasons, [CREATE_CANARY_MESSAGE]);
  }));

// Paths whose next step needs a real database: pin where the gate sits in the source.
function source(rel) {
  return fs.readFileSync(path.join(here, rel), "utf8");
}

test("scheduled arm (draft deploy authorize_scheduled) is gated after owner auth, on the draft owner", () => {
  const src = source("../dev-fix/draft-deploy-base.js");
  const auth = src.indexOf('action: "deploy_draft"');
  const gate = src.indexOf("refuseCreateIfCanaryBlocked(res, row.creator_wallet)");
  const arm = src.indexOf("return authorizeScheduledLaunch(");
  assert.ok(auth > 0 && gate > auth && arm > gate, "gate must sit between owner auth and the scheduled signature");
  // Only arming is gated: the mark-deployed path after an on-chain create is not.
  assert.equal(src.split("refuseCreateIfCanaryBlocked(").length - 1, 1);
});

test("legacy Solana V4 draft deploy is gated after owner auth for a fresh create only", () => {
  const src = source("../dev-fix/solana-create-authorization-v4.js");
  const owner = src.indexOf("if (!ownerOk) return;");
  const gate = src.indexOf("if (!draft.campaign_address && refuseCreateIfCanaryBlocked(res, draft.creator_wallet)) return;");
  const sign = src.indexOf("loadOnchainPolicy({", owner);
  assert.ok(owner > 0 && gate > owner && sign > gate);
});

test("Solana Direct authorize and finalize check the wallet bound in the signed token", () => {
  const src = source("../dev-fix/solana-direct-create.js");
  assert.match(src, /verifySolanaDirectSessionToken\(body\.sessionToken\);\n\s+const creatorWallet = validateCreatorWallet\(session\.creatorWallet\);\n\s+assertCreateAllowedForWallet\(creatorWallet\);/);
  assert.match(src, /DIRECT_FINALIZE_PURPOSE\);\n\s+const creatorWallet = validateCreatorWallet\(token\.creatorWallet\);\n\s+assertCreateAllowedForWallet\(creatorWallet\);/);
});

test("drafts can still be saved while the canary is on", () => {
  for (const rel of ["../dev-fix/drafts.js", "../dev-fix/drafts-base.js"]) {
    assert.doesNotMatch(source(rel), /createCanary/);
  }
});
