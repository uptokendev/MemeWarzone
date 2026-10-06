import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SESSION_AUTH_ACTIONS, SESSION_DRAFT_ACTIONS } from "./sessionActions.js";
import { hashFeedSessionToken } from "./feedSessionToken.js";
import { requireWalletActionAuth } from "./walletActionAuth.js";

const clientFile = fileURLToPath(new URL("../../src/lib/sessionActions.ts", import.meta.url));

function clientSet(name) {
  const src = fs.readFileSync(clientFile, "utf8");
  const block = src.match(new RegExp(`export const ${name} = new Set<string>\\(\\[([\\s\\S]*?)\\]\\)`));
  assert.ok(block, `${name} not found in sessionActions.ts`);
  return new Set([...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
}

test("client and server action lists are the same", () => {
  assert.deepEqual([...clientSet("SESSION_AUTH_ACTIONS")].sort(), [...SESSION_AUTH_ACTIONS].sort());
  assert.deepEqual([...clientSet("SESSION_DRAFT_ACTIONS")].sort(), [...SESSION_DRAFT_ACTIONS].sort());
});

test("money, deploy and sign-in actions are never on the list", () => {
  for (const action of [
    "feed_open_session", "claim", "claim_intent", "claim_record", "record", "arena_deposit_stake", "arena_tournament_buy_in",
    "arena_war_pool_support", "arena_battle_boost_quote", "arena_tournament_boost_quote", "deploy_draft", "campaign_upsert",
    "dbc_create", "dbc_schedule", "solana_direct_create", "upload_logo", "project_import_create", "manage_ticker_reservation",
    "read_draft", "draft_owner_session",
  ]) {
    assert.equal(SESSION_AUTH_ACTIONS.has(action), false, action);
    assert.equal(SESSION_DRAFT_ACTIONS.has(action), false, action);
  }
});

const SOL = "7MQwAJMMF2JvY7WZsphtxhxRc5uZo62z6JPHs4dc3pyX";
const OTHER = "9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H";
const EVM = "0x1111111111111111111111111111111111111111";

function fakePool(sessions) {
  return {
    async query(sql, params) {
      if (/social_feed_sessions/.test(sql)) {
        const row = sessions.get(params[0]);
        return { rows: row ? [{ wallet_address: row }] : [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

function fakeRes() {
  return { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(b) { this.body = b; return this; }, setHeader() {}, end(b) { this.body = JSON.parse(b); } };
}

async function run({ action, wallet, chainId, token, sessions }) {
  const res = fakeRes();
  const out = await requireWalletActionAuth({
    res,
    pool: fakePool(sessions),
    auth: { action, walletAddress: wallet, chainId, nonce: "session", message: "", signature: `session:${token}` },
    expectedWallet: wallet,
    chainId,
    action,
    strict: true,
  });
  return { out, res };
}

test("a live sign-in for the same wallet authorizes a listed action", async () => {
  const token = crypto.randomBytes(8).toString("hex");
  const sessions = new Map([[hashFeedSessionToken(token), SOL]]);
  const { out } = await run({ action: "arena_battle_vote", wallet: SOL, chainId: 101, token, sessions });
  assert.equal(out?.walletAddress, SOL);
  assert.equal(out?.session, true);
});

test("an EVM sign-in opened on another chain still counts for the same wallet", async () => {
  const token = "evm-token";
  const sessions = new Map([[hashFeedSessionToken(token), EVM.toUpperCase().replace("0X", "0x")]]);
  const { out } = await run({ action: "notification_prefs_set", wallet: EVM, chainId: 56, token, sessions });
  assert.equal(out?.walletAddress, EVM);
});

test("a money action with a sign-in is refused", async () => {
  const token = "t1";
  const sessions = new Map([[hashFeedSessionToken(token), SOL]]);
  const { out, res } = await run({ action: "arena_deposit_stake", wallet: SOL, chainId: 101, token, sessions });
  assert.equal(out, null);
  assert.equal(res.body?.code, "SIGNATURE_REQUIRED");
});

test("another wallet's sign-in is refused", async () => {
  const token = "t2";
  const sessions = new Map([[hashFeedSessionToken(token), OTHER]]);
  const { out, res } = await run({ action: "follow_user", wallet: SOL, chainId: 101, token, sessions });
  assert.equal(out, null);
  assert.equal(res.body?.code, "WALLET_MISMATCH");
});

test("an unknown or expired sign-in is refused with FEED_SESSION_REQUIRED", async () => {
  const { out, res } = await run({ action: "follow_user", wallet: SOL, chainId: 101, token: "nope", sessions: new Map() });
  assert.equal(out, null);
  assert.equal(res.body?.code, "FEED_SESSION_REQUIRED");
});
