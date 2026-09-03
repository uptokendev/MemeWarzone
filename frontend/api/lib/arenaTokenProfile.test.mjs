import assert from "node:assert/strict";
import test from "node:test";

import { getArenaTokenProfile } from "./arenaTokenProfile.js";

function queryStub(responses) {
  let index = 0;
  return async () => responses[index++] || { rows: [] };
}

const market = {
  marketCapUsd: 250000,
  volume24hUsd: 42000,
  holders: 1337,
  liquidityUsd: 75000,
  updatedAt: "2026-09-03T00:00:00.000Z",
  dataSource: "normalized_market_stats",
  healthy: true,
  reasons: [],
};

test("normalizes imported profile metadata with the shared market snapshot", async () => {
  const query = queryStub([
    { rows: [] },
    { rows: [{
      chain_id: 56,
      token_address: "0x1111111111111111111111111111111111111111",
      owner_wallet: "0x2222222222222222222222222222222222222222",
      name: "Imported Alpha",
      symbol: "ALPHA",
      image_url: "https://cdn.example/alpha.webp",
      description: "External token",
      website: "https://alpha.example",
      x_url: "https://x.com/alpha",
      telegram_url: "https://t.me/alpha",
      verified_at: "2026-09-03T00:00:00.000Z",
      metadata_updated_at: "2026-09-03T00:00:00.000Z",
    }] },
  ]);
  const profile = await getArenaTokenProfile(56, "0x1111111111111111111111111111111111111111", {
    query,
    getMarketSnapshot: async () => market,
  });
  assert.equal(profile.origin, "import");
  assert.equal(profile.imageUrl, "https://cdn.example/alpha.webp");
  assert.equal(profile.creatorWallet, "0x2222222222222222222222222222222222222222");
  assert.equal(profile.marketCapUsd, 250000);
  assert.equal(profile.holders, 1337);
  assert.equal(profile.liquidityUsd, 75000);
  assert.equal(profile.priceUsd, null);
  assert.equal(profile.marketDataHealthy, true);
});

test("rejects data URLs from profile output even if legacy data contains one", async () => {
  const query = queryStub([
    { rows: [] },
    { rows: [{
      chain_id: 56,
      token_address: "0x3333333333333333333333333333333333333333",
      owner_wallet: "0x4444444444444444444444444444444444444444",
      name: "No Blob",
      symbol: "NOBLOB",
      image_url: "data:image/png;base64,AAAA",
    }] },
  ]);
  const profile = await getArenaTokenProfile(56, "0x3333333333333333333333333333333333333333", {
    query,
    getMarketSnapshot: async () => ({ ...market, healthy: false, reasons: ["market_missing"] }),
  });
  assert.equal(profile.imageUrl, null);
  assert.equal(profile.marketDataHealthy, false);
  assert.deepEqual(profile.marketDataReasons, ["market_missing"]);
});

test("uses exact Solana token identity in imported-profile SQL", async () => {
  const calls = [];
  const query = async (sql) => {
    calls.push(sql);
    if (calls.length === 1) return { rows: [] };
    return { rows: [{
      chain_id: 101,
      token_address: "AbCdEfGhijkLmnoPqrstUvwxYZ123456789ABCDE",
      owner_wallet: "ZyxWVutsRqponMLKjihGFedcba987654321ABCDE",
      name: "Sol Import",
      symbol: "SOLI",
    }] };
  };
  const profile = await getArenaTokenProfile(101, "AbCdEfGhijkLmnoPqrstUvwxYZ123456789ABCDE", {
    query,
    getMarketSnapshot: async () => market,
  });
  assert.equal(profile.origin, "import");
  assert.match(calls[1], /token_address = \$2/);
  assert.doesNotMatch(calls[1], /lower\(coalesce\(token_address/);
});

test("uses exact Solana identity for native metadata registry joins", async () => {
  const calls = [];
  const query = async (sql) => {
    calls.push(sql);
    return { rows: [{
      chain_id: 101,
      campaign_address: "CampAbCdEfGhijkLmnoPqrstUvwxYZ123456789AB",
      token_address: "TokAbCdEfGhijkLmnoPqrstUvwxYZ123456789ABC",
      creator_address: "OwnAbCdEfGhijkLmnoPqrstUvwxYZ123456789ABC",
      name: "Native Sol",
      symbol: "NSOL",
      logo_uri: "https://cdn.example/nsol.png",
    }] };
  };
  const profile = await getArenaTokenProfile(101, "TokAbCdEfGhijkLmnoPqrstUvwxYZ123456789ABC", {
    query,
    getMarketSnapshot: async () => market,
  });
  assert.equal(profile.origin, "native");
  assert.equal(profile.imageUrl, "https://cdn.example/nsol.png");
  assert.match(calls[0], /m\.token_address = coalesce\(c\.token_address::text, ''\)/);
  assert.match(calls[0], /m\.campaign_address = c\.campaign_address::text/);
  assert.doesNotMatch(calls[0], /lower\(m\.token_address\)/);
  assert.doesNotMatch(calls[0], /lower\(m\.campaign_address\)/);
});
