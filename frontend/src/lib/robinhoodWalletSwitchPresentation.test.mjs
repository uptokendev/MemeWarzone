import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const walletSource = await readFile(new URL("../hooks/useWallet.ts", import.meta.url), "utf8");
const panelSource = await readFile(new URL("../components/postgrad/RobinhoodWarRoomTradePanel.tsx", import.meta.url), "utf8");
const tokenDetailsSource = await readFile(new URL("../pages/TokenDetails.tsx", import.meta.url), "utf8");

test("4902 recovery adds Robinhood and explicitly switches again", () => {
  const addIndex = walletSource.indexOf('method: "wallet_addEthereumChain"');
  assert.ok(addIndex >= 0, "wallet_addEthereumChain recovery is missing");
  const switchAfterAdd = walletSource.indexOf('method: "wallet_switchEthereumChain"', addIndex + 1);
  assert.ok(switchAfterAdd > addIndex, "wallet must explicitly switch after wallet_addEthereumChain");
  assert.match(walletSource, /if \(cid2 === target[\s\S]*?return cid2;/);
});

test("switchToChain returns a fresh provider and signer on the exact target", () => {
  assert.match(walletSource, /Promise<EvmWalletSession>/);
  assert.match(walletSource, /const freshProvider = new BrowserProvider\(selectedProvider\);/);
  assert.match(walletSource, /const freshSigner = await freshProvider\.getSigner\(chosen\);/);
  assert.match(walletSource, /freshChainId !== targetChainId/);
  assert.match(walletSource, /return \{ provider: freshProvider, signer: freshSigner, account: chosen, chainId: freshChainId \};/);
});

test("connected BNB EVM wallet switches in place and continues RH quote/execute without modal loop", () => {
  assert.match(panelSource, /const switched = await wallet\.switchToChain\(chainId\);/);
  assert.match(panelSource, /tradeProvider = switched\.provider;/);
  assert.match(panelSource, /tradeSigner = switched\.signer;/);
  assert.match(panelSource, /quoteRobinhoodV3Buy\(tradeProvider, route, amountIn, SLIPPAGE_BPS\)/);
  assert.match(panelSource, /executeRobinhoodV3Buy\(\{ signer: tradeSigner, quote \}\)/);

  const switchCatch = panelSource.match(/if \(Number\(wallet\.chainId\) !== chainId\) \{([\s\S]*?)\n    \}/)?.[1] || "";
  assert.ok(switchCatch, "RH wrong-network branch is missing");
  assert.doesNotMatch(switchCatch, /openWalletModal\(\)/, "wrong-network handling must not reopen the wallet modal");
});

test("wallet modal remains the one-time path only when no EVM wallet is connected", () => {
  assert.match(panelSource, /if \(!wallet\.account \|\| !wallet\.signer \|\| !wallet\.provider\) \{\s*openWalletModal\(\);\s*return;/);
  assert.match(panelSource, /!wallet\.isConnected \|\| !wallet\.account\s*\? `Connect Robinhood wallet`/);
});

test("TokenDetails RH graduated buy is delegated to the corrected Robinhood trade panel", () => {
  assert.match(
    tokenDetailsSource,
    /isRobinhoodPage && \(contractGraduated \|\| isUniswapTradingActive\)[\s\S]*?<RobinhoodWarRoomTradePanel campaign=\{campaign as CampaignInfo\} \/>/,
  );
});
