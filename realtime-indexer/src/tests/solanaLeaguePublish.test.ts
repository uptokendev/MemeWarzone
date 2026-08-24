import assert from "node:assert/strict";
import test from "node:test";
import { buildCampaignCreatedMessage, SOLANA_LEAGUE_CHAIN_ID } from "../solanaLeaguePublish.js";

process.env.DATABASE_URL ||= "postgres://localhost/test";
process.env.ABLY_API_KEY ||= "app.key:secret";

const { leagueCampaignKey, createLeagueFeedPublisher } = await import("../leagueFeed.js");

const SOLANA_CAMPAIGN = "EFUF3bPBaN3MzSBpm4MfXMdbXDmesPWcKaoNsLzn45VH";
const EVM_CAMPAIGN = "0xABCDef0123456789ABCDef0123456789ABCDef01";

test("leagueCampaignKey preserves Solana base58 case on 101 and 102", () => {
  assert.equal(leagueCampaignKey(101, SOLANA_CAMPAIGN), SOLANA_CAMPAIGN);
  assert.equal(leagueCampaignKey(102, ` ${SOLANA_CAMPAIGN} `), SOLANA_CAMPAIGN);
  assert.notEqual(leagueCampaignKey(101, SOLANA_CAMPAIGN), SOLANA_CAMPAIGN.toLowerCase());
});

test("leagueCampaignKey lowercases EVM campaign addresses", () => {
  assert.equal(leagueCampaignKey(56, EVM_CAMPAIGN), EVM_CAMPAIGN.toLowerCase());
  assert.equal(leagueCampaignKey(97, ` ${EVM_CAMPAIGN} `), EVM_CAMPAIGN.toLowerCase());
});

test("buildCampaignCreatedMessage preserves addresses and uses ISO createdAtChain", () => {
  const blockTime = new Date("2026-08-22T12:34:56.000Z");
  const msg = buildCampaignCreatedMessage(
    {
      campaign: SOLANA_CAMPAIGN,
      mint: "So11111111111111111111111111111111111111112",
      creator: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    },
    440979634,
    blockTime,
    1_750_000_000,
  );

  assert.equal(msg.type, "campaign_created");
  assert.equal(msg.chainId, SOLANA_LEAGUE_CHAIN_ID);
  assert.equal(msg.chainId, 101);
  assert.equal(msg.ts, 1_750_000_000);
  assert.equal(msg.item.campaignAddress, SOLANA_CAMPAIGN);
  assert.equal(msg.item.tokenAddress, "So11111111111111111111111111111111111111112");
  assert.equal(msg.item.creatorAddress, "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
  assert.equal(msg.item.name, "Solana Launch");
  assert.equal(msg.item.symbol, "SOL");
  assert.equal(msg.item.createdAtChain, "2026-08-22T12:34:56.000Z");
  assert.equal(msg.item.blockNumber, 440979634);
  assert.match(msg.item.createdAtChain, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("queueStats mergePatch preserves Solana case and lowercases EVM", async () => {
  const published: Array<{ chainId: number; event: string; msg: any }> = [];
  const feed = createLeagueFeedPublisher({
    pool: { query: async () => ({ rows: [{ raised_total_bnb: 0 }] }) } as any,
    flushMs: 60_000,
    publish: async (chainId, event, msg) => {
      published.push({ chainId, event, msg });
    },
  });

  feed.queueStats(101, SOLANA_CAMPAIGN, {
    lastPriceBnb: "0.001",
    marketcapBnb: "12.5",
    vol24hBnb: "3",
  });
  feed.queueStats(56, EVM_CAMPAIGN, {
    lastPriceBnb: "0.002",
    marketcapBnb: "9",
    vol24hBnb: "1",
  });

  await feed.flush();

  const solana = published.find((p) => p.chainId === 101);
  const evm = published.find((p) => p.chainId === 56);

  assert.equal(solana?.event, "campaign_patch");
  assert.equal(solana?.msg.type, "campaign_patch");
  assert.equal(solana?.msg.items[0].campaignAddress, SOLANA_CAMPAIGN);
  assert.equal(solana?.msg.items[0].lastPriceBnb, "0.001");

  assert.equal(evm?.event, "campaign_patch");
  assert.equal(evm?.msg.items[0].campaignAddress, EVM_CAMPAIGN.toLowerCase());
});

test("queueRaisedDelta queries curve_trades with preserved Solana campaign key", async () => {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const published: any[] = [];
  const feed = createLeagueFeedPublisher({
    pool: {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values: values ?? [] });
        return { rows: [{ raised_total_bnb: 4 }] };
      },
    } as any,
    flushMs: 60_000,
    publish: async (_chainId, _event, msg) => {
      published.push(msg);
    },
  });

  feed.queueRaisedDelta(101, SOLANA_CAMPAIGN, 1.25);
  const deadline = Date.now() + 1000;
  while (published.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
    await feed.flush();
  }

  assert.equal(queries.length, 1);
  assert.equal(queries[0].values[0], 101);
  assert.equal(queries[0].values[1], SOLANA_CAMPAIGN);
  assert.equal(published[0].items[0].campaignAddress, SOLANA_CAMPAIGN);
  assert.equal(published[0].items[0].raisedTotalBnb, "5.25");
});
