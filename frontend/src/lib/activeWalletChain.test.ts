import assert from "node:assert/strict";
import test from "node:test";
import { campaignWalletMatches, resolveActiveWalletKind } from "./activeWalletChain.ts";

test("explicit BNB session stays BNB even if Phantom is still injected", () => {
  assert.equal(
    resolveActiveWalletKind({ storedKind: "bnb", solanaConnected: true, bnbConnected: true }),
    "bnb",
  );
});

test("Solana campaign rejects an active BNB wallet", () => {
  assert.equal(
    campaignWalletMatches({
      isSolanaCampaign: true,
      storedKind: "bnb",
      solanaConnected: true,
      bnbConnected: true,
    }),
    false,
  );
});

test("BNB campaign rejects an active Solana wallet", () => {
  assert.equal(
    campaignWalletMatches({
      isSolanaCampaign: false,
      storedKind: "solana",
      solanaConnected: true,
      bnbConnected: true,
    }),
    false,
  );
});

test("matching wallet can trade", () => {
  assert.equal(
    campaignWalletMatches({
      isSolanaCampaign: true,
      storedKind: "solana",
      solanaConnected: true,
      bnbConnected: true,
    }),
    true,
  );
  assert.equal(
    campaignWalletMatches({
      isSolanaCampaign: false,
      storedKind: "bnb",
      solanaConnected: true,
      bnbConnected: true,
    }),
    true,
  );
});

test("no wallet cannot trade", () => {
  assert.equal(
    campaignWalletMatches({
      isSolanaCampaign: true,
      storedKind: null,
      solanaConnected: false,
      bnbConnected: false,
    }),
    false,
  );
});
