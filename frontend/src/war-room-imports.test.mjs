import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// CO-1 / CO-2 (War Trade Room half): imported coins list and trade in the War Trade Room on their
// own DEX. Source pins: the import path never reaches our launchpad trade panels, and the panel
// reads and signs on the coin's own chain.
const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [page, importRow, campaignRow, tradePanel, robinhoodRoute, importsClient, api] = await Promise.all([
  read("./pages/WarRoom.tsx"),
  read("./components/postgrad/WarRoomImportRow.tsx"),
  read("./components/postgrad/WarRoomCampaignRow.tsx"),
  read("./components/arena/ImportedTradePanel.tsx"),
  read("./lib/arenaImportedRobinhood.ts"),
  read("./lib/arenaImports.ts"),
  read("../api/arenaImports.js"),
]);

test("War Trade Room has an Imported tab and ranks imports with our coins in Trending", () => {
  assert.match(page, /\{ key: "imported", label: "Imported" \}/);
  assert.match(page, /const showImports = importsOnly \|\| activeMode === "trending"/);
  assert.match(page, /useWarRoomImports\(feedChainId, showImports\)/);
  assert.match(page, /importRankRow\(entry\.row, usd\)/, "imports join the one shared ranking");
  assert.match(page, /case "volume":\s*return Number\(row\.volume24hUsd \|\| 0\)/, "volume sorts on 24h USD, the same basis as our coins");
});

test("an import row mounts ImportedTradePanel and never our launchpad trade panels", () => {
  assert.match(page, /entry\.kind === "import"[\s\S]*<WarRoomImportRow/);
  assert.match(importRow, /<ImportedTradePanel item=\{importMarketRowToArenaItem\(row\)\} \/>/);
  assert.doesNotMatch(importRow, /WarRoomTradePanel|RobinhoodWarRoomTradePanel|launchpadClient/);
  assert.match(importRow, /row\.tradingBlocked \?/, "a honeypot / blocked scan shows no trade panel, like the coin page");
  assert.match(importRow, /WAR_ROOM_MARKET_GRID/, "same columns as a launched coin's row");
  // Our own rows are untouched: they still mount our panels.
  assert.match(campaignRow, /<WarRoomTradePanel campaign=\{campaign\} \/>/);
  assert.match(campaignRow, /<RobinhoodWarRoomTradePanel campaign=\{campaign\} \/>/);
});

test("imported trades read the coin's own chain and switch the wallet before signing", () => {
  assert.match(tradePanel, /getReadProvider\(chainId as SupportedChainId\)/);
  assert.doesNotMatch(tradePanel, /readImportTokenDecimals\([^)]*wallet\.provider/);
  assert.doesNotMatch(tradePanel, /resolveImportedRobinhoodV3Route\(\{\s*provider: wallet\.provider/);
  assert.match(tradePanel, /await wallet\.switchToChain\(item\.chainId as SupportedChainId\)/);
  assert.match(tradePanel, /executeBscImportSwap\(\{[^}]*signer: tradeSigner/);
  assert.match(tradePanel, /executeRobinhoodV3Buy\(\{ signer: tradeSigner/);
  assert.match(tradePanel, /executeRobinhoodV3Sell\(\{ signer: tradeSigner/);
  assert.doesNotMatch(tradePanel, /Switch your wallet to BNB Chain first/);
});

test("Robinhood imports trade on the deepest Uniswap V3 pool against WETH", () => {
  assert.match(robinhoodRoute, /function liquidity\(\) view returns \(uint128\)/);
  assert.match(robinhoodRoute, /if \(liquidity > bestLiquidity\)/);
  assert.match(tradePanel, /quoteRobinhoodPreview/);
});

test("imports market read: listed imports only, with the feed's stats and the coin page's block rule", () => {
  assert.match(importsClient, /\/api\/arena\/imports\/market\?/);
  assert.match(api, /path === "\/arena\/imports\/market"\) return handleMarket/);
  assert.match(api, /where i\.chain_id = \$1 and i\.status = 'passed'/);
  assert.match(api, /left join public\.arena_import_market_stats s on s\.chain_id = i\.chain_id and s\.token_address = i\.token_address/);
  assert.match(api, /tradingBlocked: importTradingBlocked\(/);
});

test("Robinhood mainnet imports pay the 0.5% platform fee through the Universal Router", async () => {
  const lib = await read("./lib/robinhoodImportSwap.mjs");
  assert.match(tradePanel, /const robinhoodFee = Number\(item\.chainId\) === 4663/);
  assert.match(tradePanel, /executeImportSwap4663\(\{ signer: tradeSigner, quote, token: item\.tokenAddress \}\)/);
  assert.match(lib, /IMPORT_SWAP_FEE_RECEIVER_4663 = "0x632061cA786f7B585Bbd46A792FDA92B02f70671"/);
  assert.match(lib, /export const IMPORT_SWAP_FEE_BPS = 50/);
});
