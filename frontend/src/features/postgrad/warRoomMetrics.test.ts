import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { getWarRoomCampaignMetrics } from "./warRoomMetrics.ts";

const ETH_USD = 2698;

test("War Room values a gen-6 coin fully diluted (Robinhood 0x404d723d, /api/campaigns 2026-10-01)", () => {
  // The league patch rewrites priceBnb and soldTokens = mcap / price (price x sold), which drew $2.91.
  const row = {
    campaign: "0x404d723dabab33f0303d9fd26fa36936a87627f8", chainId: 4663, status: "live", isActive: true,
    priceBnb: 0.000000001578986154, soldTokens: 681160.1822125078, rtMarketcapBnb: 0.0010755424963696668,
    marketCapBnb: 1.578986154, athMarketCapBnb: 1.632993161, fullyDilutedSupply: 1_000_000_000,
    raisedTotalBnb: 0.000878351339591012, vol24hBnb: 0.0011,
  } as any;
  const m = getWarRoomCampaignMetrics(row, ETH_USD);
  assert.ok(Math.abs(m.marketCapUsd - 1.578986154 * ETH_USD) < 1e-6);
  assert.equal(m.marketCapLabel, "$4.26K");
  assert.ok(Math.abs(m.athMarketCapUsd - 1.632993161 * ETH_USD) < 1e-6);
  assert.ok(Math.abs(m.liquidityUsd - 0.000878351339591012 * ETH_USD) < 1e-9);
});

test("a BNB gen-6 coin with sold 0 is still priced at start price x supply, never $0 or a dash", () => {
  const m = getWarRoomCampaignMetrics(
    { campaign: "0x49ac80f9ccb0b4b88c2d98671a04cb146c0c6eb3", chainId: 56, status: "live", isActive: true,
      priceBnb: 0.000000001, soldTokens: 0, marketCapBnb: 1, athMarketCapBnb: 4.709190014, fullyDilutedSupply: 1_000_000_000 } as any,
    770,
  );
  assert.equal(m.marketCapLabel, "$770");
  assert.equal(m.athLabel, "$3.63K");
});

test("older coins keep price x sold", () => {
  const m = getWarRoomCampaignMetrics(
    { campaign: "0x36b2e5b717c47c181f06e3a53e9744b8b9c23de7", chainId: 56, status: "live", isActive: true,
      priceBnb: 0.000000002065261755, soldTokens: 1_253_221, marketCapBnb: 0.0025882874863088533 } as any,
    770,
  );
  assert.ok(Math.abs(m.marketCapUsd - 0.000000002065261755 * 1_253_221 * 770) < 1e-9);
});

test("the War Room routes Robinhood bonding coins away from the BNB-only trade panel", () => {
  const row = readFileSync(new URL("../../components/postgrad/WarRoomCampaignRow.tsx", import.meta.url), "utf8");
  assert.match(row, /isRobinhoodRow && metrics\.status === "graduated" \? \(\s*<RobinhoodWarRoomTradePanel/);
  assert.match(row, /\) : isRobinhoodRow \? \(/);
  assert.match(row, /data-testid="war-room-robinhood-bonding-trade"/);
  assert.match(row, /fixedSupplyWhole=\{Number\(rich\.fullyDilutedSupply\) > 0/);
  const feed = readFileSync(new URL("../../hooks/useWarRoomCampaignFeed.ts", import.meta.url), "utf8");
  assert.match(feed, /fullyDilutedSupply: toNumber\(item\?\.fullyDilutedSupply/);
  assert.match(feed, /stats\.bondingReserveBnb != null\s+\? stats\.bondingReserveBnb/);
});
