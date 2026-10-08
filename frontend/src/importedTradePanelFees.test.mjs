// CO-IMP rev 2 CI4 / CI7 source pins for ImportedTradePanel: the fee chip shows the quote's feeBps on
// every path (Kyber, Universal Router, fee router), and a BNB import never trades Topaz without the fee.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const panel = fs.readFileSync(new URL("./components/arena/ImportedTradePanel.tsx", import.meta.url), "utf8");

test("no fee-free Topaz trade: the Topaz path goes through ImportSwapFeeRouter or does not trade", () => {
  assert.doesNotMatch(panel, /executeTopazBuy|executeTopazSell|ensureTopazSellAllowance|quoteTopazBuy|quoteTopazSell/);
  assert.match(panel, /if \(!feeRouter\) throw new Error\(NO_PANCAKESWAP_ROUTE\);/);
  assert.match(panel, /executeFeeRouterTrade\(\{ signer: tradeSigner, account: tradeAccount, quote \}\)/);
  assert.match(panel, /const feeRouter = importSwapFeeRouterAddress\(item\.chainId\)/);
  assert.match(panel, /disabled=\{busy \|\| !amount \|\| noFeeRoute\}/);
  assert.match(panel, /data-import-no-fee-route="true"/);
});

test("fee chip and preview carry the quote's feeBps on every path", () => {
  assert.match(panel, /Fee \{importSwapFeeLabel\(preview\.feeBps\)\}/);
  assert.doesNotMatch(panel, /feeBps: 50,/, "the Robinhood preview no longer hard-codes 0.5%");
  assert.match(panel, /provider: "uniswap-universal-router",[\s\S]*?feeBps: quote\.feeBps,\s*creatorShareBps: quote\.creatorShareBps,/);
  assert.match(panel, /provider: "import-swap-fee-router",[\s\S]*?feeBps: quote\.feeBps,\s*creatorShareBps: quote\.creatorShareBps,/);
  assert.doesNotMatch(panel, /IMPORT_SWAP_FEE_LABEL/);
});
