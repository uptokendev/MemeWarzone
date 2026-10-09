// CO-IMP rev 2 CI4 / CI7 source pins for ImportedTradePanel: the fee chip shows the quote's feeBps on
// every path (Kyber, Universal Router, fee router), and a BNB import never trades Topaz without the fee.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const panel = fs.readFileSync(new URL("./components/arena/ImportedTradePanel.tsx", import.meta.url), "utf8");

test("no fee-free Topaz trade: the Topaz path goes through ImportSwapFeeRouter or does not trade", () => {
  assert.doesNotMatch(panel, /executeTopazBuy|executeTopazSell|ensureTopazSellAllowance|quoteTopazBuy|quoteTopazSell/);
  assert.match(panel, /if \(!feeRouter\) throw new Error\(NO_IMPORT_SWAP_ROUTE\);/);
  assert.match(panel, /executeFeeRouterTrade\(\{ signer: tradeSigner, account: tradeAccount, quote \}\)/);
  assert.match(panel, /const feeRouter = importSwapFeeRouterAddress\(item\.chainId\)/);
  // Live's card layout (merge 2026-10-09): a connected wallet is disabled with no fee route.
  assert.match(panel, /disabled=\{account \? busy \|\| !amount \|\| noFeeRoute : false\}/);
  assert.match(panel, /data-import-no-fee-route="true"/);
});

test("fee chip and preview carry the quote's feeBps on every path", () => {
  assert.match(panel, /const feeLabel = preview \? importSwapFeeLabel\(preview\.feeBps\) : robinhoodFee \? importSwapFeeLabel\(activeImportSwapFeeTerms4663\(\)\.feeBps\) : null;/);
  assert.match(panel, /const quoted = \(aggregated && !noAggregatorRoute\) \|\| robinhoodFee \|\| feeRouted;/);
  assert.doesNotMatch(panel, /feeBps: 50,/, "the Robinhood preview no longer hard-codes 0.5%");
  assert.match(panel, /provider: "uniswap-universal-router",[\s\S]*?feeBps: quote\.feeBps,\s*creatorShareBps: quote\.creatorShareBps,/);
  assert.match(panel, /provider: "import-swap-fee-router",[\s\S]*?feeBps: quote\.feeBps,\s*creatorShareBps: quote\.creatorShareBps,/);
  assert.doesNotMatch(panel, /IMPORT_SWAP_FEE_LABEL/);
});

test("BNB imports: no PancakeSwap-only copy; the venue comes from the Kyber route (founder 2026-10-08: trade wherever the pool is)", () => {
  assert.doesNotMatch(panel, /NO_PANCAKESWAP_ROUTE|"PancakeSwap"/);
  assert.match(panel, /Best price via \$\{solana \? "Jupiter" : "KyberSwap"\}/);
  assert.match(panel, /preview\?\.provider === "kyberswap"/);
  assert.match(panel, /preview\.route\.map\(importSwapVenueLabel\)/);
  // The fee-router fallback still only runs on Kyber's no-route answer, and only with a router.
  assert.match(panel, /code === "IMPORT_SWAP_NO_ROUTE" && Number\(item\.chainId\) === 56 && feeRouter\) return quoteFeeRouterPreview\(raw\)/);
});
