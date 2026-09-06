import assert from "node:assert/strict";
import test from "node:test";

import { buildEvmLaunchpadSafetyStatus } from "./evmLaunchpadSafetyPresentation.mjs";

const commonKeys = [
  "launchFactory",
  "launchCampaignImplementation",
  "treasuryRouter",
  "treasuryVault",
  "recruiterRewardsVault",
  "communityRewardsVault",
  "protocolRevenueVault",
  "creatorRegistry",
  "riskRegistry",
  "graduationOracle",
  "permanentLpLocker",
  "voteTreasury",
];
const topazKeys = ["topazRouter", "topazFactory", "topazWbnb"];

function readiness(chainId, { configured = true, includeTopaz = chainId === 56 || chainId === 97 } = {}) {
  const requiredKeys = includeTopaz ? [...commonKeys, ...topazKeys] : commonKeys;
  const items = [...commonKeys, ...topazKeys].map((key) => {
    const required = requiredKeys.includes(key);
    const ready = configured && required;
    return { key, label: key, required, ready, address: ready ? "0x1111111111111111111111111111111111111111" : "" };
  });
  const missingRequired = items.filter((item) => item.required && !item.ready);
  return { chainId, ready: missingRequired.length === 0, items, missingRequired };
}

function status(chainId, configured = true) {
  return buildEvmLaunchpadSafetyStatus({
    chainId,
    factoryAddress: configured ? "0x1111111111111111111111111111111111111111" : "",
    hasSigner: true,
    hasAccount: true,
    walletChainId: chainId,
    contractReadiness: readiness(chainId, { configured }),
  });
}

function allCopy(value) {
  return JSON.stringify(value);
}

test("chain 56 retains BNB Smart Chain and Topaz presentation", () => {
  const result = status(56);
  assert.equal(result.chainLabel, "BNB Smart Chain");
  assert.equal(result.protocolStatus, "ready");
  assert.match(allCopy(result), /BNB-compatible wallet|BNB launch route|BNB launch services/);
  assert.match(allCopy(result), /Topaz graduation|Topaz liquidity pool/);
});

test("chain 97 retains BNB Testnet and Topaz presentation", () => {
  const result = status(97);
  assert.equal(result.chainLabel, "BNB Testnet");
  assert.equal(result.protocolStatus, "ready");
  assert.match(allCopy(result), /BNB-compatible wallet|BNB launch route|BNB launch services/);
  assert.match(allCopy(result), /Topaz graduation|Topaz liquidity pool/);
});

test("chain 4663 uses Robinhood Chain, ETH, and no BNB or Topaz copy", () => {
  const result = status(4663);
  const copy = allCopy(result);
  assert.equal(result.chainLabel, "Robinhood Chain");
  assert.equal(result.protocolStatus, "ready");
  assert.match(copy, /Robinhood launch route ready/);
  assert.match(copy, /Gas is paid in ETH/);
  assert.doesNotMatch(copy, /BNB Smart Chain|BNB Testnet|BNB-compatible wallet|BNB launch route|BNB launch services|Topaz|WBNB/);
});

test("chain 46630 uses Robinhood Chain Testnet, ETH, and no BNB or Topaz copy", () => {
  const result = status(46630);
  const copy = allCopy(result);
  assert.equal(result.chainLabel, "Robinhood Chain Testnet");
  assert.equal(result.protocolStatus, "ready");
  assert.match(copy, /Robinhood launch route ready/);
  assert.match(copy, /Gas is paid in ETH/);
  assert.doesNotMatch(copy, /BNB Smart Chain|BNB Testnet|BNB-compatible wallet|BNB launch route|BNB launch services|Topaz|WBNB/);
});

test("Robinhood missing contracts fail closed without BNB fallback", () => {
  for (const chainId of [4663, 46630]) {
    const result = status(chainId, false);
    const copy = allCopy(result);
    assert.equal(result.protocolStatus, "unavailable");
    assert.match(copy, /Robinhood launch services are not configured for this environment\./);
    assert.match(copy, /Robinhood graduation services are not configured for this environment\./);
    assert.doesNotMatch(copy, /BNB Smart Chain|BNB Testnet|BNB-compatible wallet|BNB launch route|BNB launch services|Topaz|WBNB/);
  }
});
