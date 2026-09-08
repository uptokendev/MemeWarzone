import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExpectedEvmLeagueClaim,
  evmLeagueClaimEventTopics,
} from "./evmLeagueClaimVerification.js";
import { rewardClaimEventTopics } from "./rewardClaimVerification.js";

const VAULT_BNB = "0x1111111111111111111111111111111111111111";
const VAULT_RH = "0x2222222222222222222222222222222222222222";
const RECIPIENT = "0x3333333333333333333333333333333333333333";
const GENERIC = "0x4444444444444444444444444444444444444444";

function claim(chainId) {
  return buildExpectedEvmLeagueClaim({
    chainId,
    period: "monthly",
    epochStart: "2026-09-01T00:00:00.000Z",
    category: "creator",
    rank: 1,
    recipient: RECIPIENT,
    amountRaw: "1230000000000000000",
  });
}

test("BNB and Robinhood League claim identities are chain-local", () => {
  process.env.TREASURY_VAULT_V2_ADDRESS_56 = VAULT_BNB;
  process.env.TREASURY_VAULT_V2_ADDRESS_4663 = VAULT_RH;
  const bnb = claim(56);
  const rh = claim(4663);
  assert.equal(bnb.vaultAddress, VAULT_BNB);
  assert.equal(rh.vaultAddress, VAULT_RH);
  assert.equal(bnb.recipient, RECIPIENT);
  assert.equal(rh.recipient, RECIPIENT);
  assert.equal(bnb.amountRaw, rh.amountRaw);
  assert.notEqual(bnb.epochId, rh.epochId);
  assert.notEqual(bnb.leaf, rh.leaf);
});

test("Robinhood League never inherits generic BNB TreasuryVaultV2 authority", () => {
  process.env.TREASURY_VAULT_V2_ADDRESS = GENERIC;
  delete process.env.TREASURY_VAULT_V2_ADDRESS_4663;
  assert.throws(
    () => claim(4663),
    (error) => error?.code === "LEAGUE_VAULT_UNAVAILABLE",
  );
});

test("League and RewardDistributor event filters bind exact recipient and claim identity", () => {
  process.env.TREASURY_VAULT_V2_ADDRESS_56 = VAULT_BNB;
  const expected = claim(56);
  const leagueTopics = evmLeagueClaimEventTopics(expected);
  assert.equal(leagueTopics.length, 4);
  assert.equal(leagueTopics[1].toLowerCase(), expected.epochIdHex.toLowerCase());
  assert.equal(leagueTopics[3].toLowerCase(), expected.leaf.toLowerCase());

  const batchId = `0x${"ab".repeat(32)}`;
  const rewardTopics = rewardClaimEventTopics(batchId, RECIPIENT);
  assert.equal(rewardTopics.length, 3);
  assert.equal(rewardTopics[1].toLowerCase(), batchId.toLowerCase());
  assert.ok(rewardTopics[2].toLowerCase().endsWith(RECIPIENT.slice(2).toLowerCase()));
});
