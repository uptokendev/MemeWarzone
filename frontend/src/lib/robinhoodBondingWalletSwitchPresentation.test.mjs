import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const entrySource = await readFile(new URL("../pages/TokenDetailsEntry.tsx", import.meta.url), "utf8");
const tokenDetailsSource = await readFile(new URL("../pages/TokenDetails.tsx", import.meta.url), "utf8");
const launchpadSource = await readFile(new URL("./launchpadClient.ts", import.meta.url), "utf8");
const walletSource = await readFile(new URL("../hooks/useWallet.ts", import.meta.url), "utf8");

test("Robinhood TokenDetails keeps an already-connected EVM wallet on the EVM path", () => {
  assert.match(entrySource, /if \(!robinhoodRoute \|\| isSolanaRoute\) return;/);
  assert.match(entrySource, /if \(!wallet\.isConnected \|\| !wallet\.account\) return;/);
  assert.match(entrySource, /setActiveWalletKind\("bnb"\);/);
});

test("bonding RH buy switches the connected wallet and consumes the fresh session", () => {
  assert.match(
    launchpadSource,
    /const isRobinhoodBuy = targetChainId === ROBINHOOD_CHAIN_ID \|\| targetChainId === ROBINHOOD_TESTNET_CHAIN_ID;/,
  );
  assert.match(launchpadSource, /if \(isRobinhoodBuy && Number\(wallet\.chainId\) !== targetChainId\)/);
  assert.match(launchpadSource, /const switched = await wallet\.switchToChain\(targetChainId\);/);
  assert.match(launchpadSource, /tradeSigner = switched\.signer;/);
  assert.match(launchpadSource, /tradeAccount = switched\.account;/);
  assert.match(launchpadSource, /new Contract\(normalizedCampaign, CAMPAIGN_ABI, tradeSigner\)/);
  assert.match(launchpadSource, /fetchLaunchpadBuyPreflight\(tradeAccount, normalizedCampaign, activeChainId\)/);
  assert.match(launchpadSource, /walletAddress: tradeAccount/);
});

test("bonding buy still opens the wallet modal when there is no usable wallet", () => {
  assert.match(
    tokenDetailsSource,
    /onClick=\{walletMatchesCampaign \? handlePlaceTrade : openWalletModal\}/,
  );
  assert.match(
    launchpadSource,
    /if \(!tradeSigner \|\| !tradeAccount\) throw new Error\("Wallet not connected"\);/,
  );
});

test("switchToChain contract remains EvmWalletSession and exact-chain verified", () => {
  assert.match(walletSource, /switchToChain: \(chainId: number\) => Promise<EvmWalletSession>;/);
  assert.match(walletSource, /const cid = await ensureSupportedEvmChain\(selectedProvider, targetChainId\);/);
  assert.match(walletSource, /freshChainId !== targetChainId/);
  assert.match(walletSource, /return \{ provider: freshProvider, signer: freshSigner, account: chosen, chainId: freshChainId \};/);
});
