import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { evmConnectTargetChainId } from "./walletConnectTarget.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const allowed = (chainId) => [56, 4663].includes(chainId);

test("off a token page the wallet's own network is kept: no target, whatever chains are allowed", () => {
  assert.equal(evmConnectTargetChainId({ onEvmTokenPage: false, pageChainId: 4663, isAllowedEvmChain: allowed }), null);
  assert.equal(evmConnectTargetChainId({ onEvmTokenPage: false, pageChainId: 56, isAllowedEvmChain: allowed }), null);
});

test("an EVM token page pins its chain, BNB or Robinhood alike, but never an unallowed or malformed one", () => {
  assert.equal(evmConnectTargetChainId({ onEvmTokenPage: true, pageChainId: 4663, isAllowedEvmChain: allowed }), 4663);
  assert.equal(evmConnectTargetChainId({ onEvmTokenPage: true, pageChainId: "56", isAllowedEvmChain: allowed }), 56);
  assert.equal(evmConnectTargetChainId({ onEvmTokenPage: true, pageChainId: 97, isAllowedEvmChain: allowed }), null);
  assert.equal(evmConnectTargetChainId({ onEvmTokenPage: true, pageChainId: 0, isAllowedEvmChain: allowed }), null);
  assert.equal(evmConnectTargetChainId({ onEvmTokenPage: true, pageChainId: "x", isAllowedEvmChain: allowed }), null);
});

test("the connect modal no longer forces Robinhood because it is allowed: it uses the helper, passes a target only when there is one, and latches the feed only then", () => {
  const modal = fs.readFileSync(path.join(here, "../components/wallet/ConnectWalletModal.tsx"), "utf8");
  assert.doesNotMatch(modal, /resolveRobinhoodFeedChainId|resolveBnbFeedChainId/, "the allowed-chain resolvers must not choose the connect target");
  assert.match(modal, /evmConnectTargetChainId\(\{/);
  assert.match(modal, /onEvmTokenPage: typeof window !== "undefined" && isEvmTokenPath\(window\.location\.pathname\)/);
  assert.match(modal, /await connect\(detectedWallet\.id, targetChainId \? \{ chainId: targetChainId \} : undefined\)/);
  assert.match(modal, /if \(targetChainId\) setSelectedFeedChainId\(targetChainId/);
});

test("the create page offers the chain switch while no wallet is connected and re-renders on feed changes", () => {
  const create = fs.readFileSync(path.join(here, "../pages/Create.tsx"), "utf8");
  assert.match(create, /const \[feedChainId\] = useSelectedFeedChainId\(\);/);
  assert.match(create, /const noWalletConnected = !wallet\.isConnected && !solanaWallet\.isSolanaConnected;/);
  assert.match(create, /getActiveChainId\(wallet\.chainId \?\? feedChainId\)/);
  assert.match(create, /\{noWalletConnected \? <ChainFeedSwitch \/> : null\}/);
});

test("a connected Solana wallet only makes a Solana launch while Solana is the chosen chain", () => {
  const create = fs.readFileSync(path.join(here, "../pages/Create.tsx"), "utf8");
  assert.match(create, /getActiveChainId\(wallet\.chainId \?\? feedChainId\) === SOLANA_CHAIN_ID,\n  \);/);
  assert.doesNotMatch(create, /=== SOLANA_CHAIN_ID \|\| !wallet\.isConnected\)/);
});

