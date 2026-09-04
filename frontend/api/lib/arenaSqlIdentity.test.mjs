import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  arenaSqlIdentityAny,
  arenaSqlIdentityEquals,
  arenaSqlIdentityValues,
} from "./arenaSqlIdentity.js";
import { resolveArenaVoteToken } from "./arenaEligibility.js";

const here = path.dirname(fileURLToPath(import.meta.url));

test("Arena SQL identity preserves Solana Base58 case", () => {
  const predicate = arenaSqlIdentityEquals(101, "token_address", "$2");
  assert.equal(predicate, "coalesce(token_address, '') = $2");
  assert.doesNotMatch(predicate, /lower\(/i);

  const any = arenaSqlIdentityAny(101, "wallet_address", "$1");
  assert.equal(any, "coalesce(wallet_address, '') = any($1::text[])");
  assert.doesNotMatch(any, /lower\(/i);
  assert.deepEqual(
    arenaSqlIdentityValues(101, ["AbCd", "aBcD"]),
    ["AbCd", "aBcD"],
  );
});

test("Arena SQL identity keeps EVM lookup case-insensitive", () => {
  const predicate = arenaSqlIdentityEquals(56, "token_address", "$2");
  assert.equal(predicate, "lower(coalesce(token_address, '')) = lower($2)");

  const any = arenaSqlIdentityAny(56, "wallet_address", "$1");
  assert.equal(any, "lower(coalesce(wallet_address, '')) = any($1::text[])");
  assert.deepEqual(
    arenaSqlIdentityValues(56, ["0xAbCd", "0xEF01"]),
    ["0xabcd", "0xef01"],
  );
});

test("Arena eligibility uses exact Solana identity for native and imported tokens", async () => {
  const calls = [];
  const pool = {
    query: async (sql) => {
      calls.push(sql);
      return { rows: [] };
    },
  };
  await resolveArenaVoteToken(pool, 101, "AbCdEfGhijkLmnoPqrstUvwxYZ123456789ABCDE");
  assert.equal(calls.length, 2);
  assert.match(calls[0], /coalesce\(token_address::text, ''\) = \$2/);
  assert.match(calls[0], /coalesce\(campaign_address::text, ''\) = \$2/);
  assert.match(calls[1], /coalesce\(token_address, ''\) = \$2/);
  assert.doesNotMatch(calls.join("\n"), /lower\(/i);
});

test("Battle V2 volume path uses chain-aware token and wallet predicates", () => {
  const source = fs.readFileSync(path.join(here, "arenaBattleMetrics.js"), "utf8");
  const trades = source.split("export async function loadBattleWindowTrades")[1]?.split("export async function refreshCombatantVolumeAndPoints")[0] || "";
  const context = source.split("export async function loadVolumeContext")[1]?.split("function normalizeTradeUsd")[0] || "";

  assert.match(trades, /arenaSqlIdentityEquals\(chainId, '\"campaignAddress\"', "\$4"\)/);
  assert.match(trades, /arenaSqlIdentityEquals\(chainId, '\"tokenAddress\"', "\$5"\)/);
  assert.doesNotMatch(trades, /lower\(\"campaignAddress\"\)/);
  assert.doesNotMatch(trades, /lower\(coalesce\(\"tokenAddress\"/);

  assert.match(context, /arenaSqlIdentityAny\(chainId, "wallet_address", "\$1"\)/);
  assert.match(context, /arenaSqlIdentityAny\(chainId, "creator_wallet", "\$2"\)/);
  assert.match(context, /arenaSqlIdentityValues\(chainId, uniqueWallets\)/);
  assert.match(context, /arenaSqlIdentityValues\(chainId, creatorList\)/);
});
