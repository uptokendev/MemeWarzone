import assert from "node:assert/strict";
import test from "node:test";
import { AbiCoder, keccak256, toUtf8Bytes } from "ethers";

import { buildExpectedEvmLeagueClaim, monthIdForEpochStart } from "./evmLeagueClaimVerification.js";

const recipient = "0x1111111111111111111111111111111111111111";

test("monthly EVM claims use MonthlyLeagueTreasury and monthId; weekly keeps TreasuryVaultV2", () => {
  process.env.TREASURY_VAULT_V2_ADDRESS_56 = "0xC9286EE3390A4dC642340bd703396E6B7b2521d5";
  const monthly = buildExpectedEvmLeagueClaim({ chainId: 56, period: "monthly", epochStart: "2026-09-01T00:00:00.000Z", category: "recruiter_league", rank: 7, recipient, amountRaw: "1000" });
  assert.equal(monthly.epochId, 202609n, "monthId YYYYMM, as MonthlyLeagueTreasury.sealMonth keys it");
  assert.equal(monthly.vaultAddress, "0xF62A09dea232bc8311D13bAEa89d79F48Cf7eCB8");
  assert.equal(monthly.claimedGetter, "monthLeafClaimed");
  const coder = AbiCoder.defaultAbiCoder();
  const expectedLeaf = keccak256(coder.encode(["uint256", "bytes32", "uint8", "address", "uint256"], [202609n, keccak256(toUtf8Bytes("recruiter_league")), 7, recipient, 1000n]));
  assert.equal(monthly.leaf, expectedLeaf, "the contract's leaf: abi.encode(monthId, category, rank, recipient, amount)");

  const weekly = buildExpectedEvmLeagueClaim({ chainId: 56, period: "weekly", epochStart: "2026-09-21T00:00:00.000Z", category: "biggest_hit", rank: 40, recipient, amountRaw: "5" });
  assert.equal(weekly.vaultAddress, "0xC9286EE3390A4dC642340bd703396E6B7b2521d5");
  assert.equal(weekly.claimedGetter, "epochLeafClaimed");
  assert.notEqual(weekly.epochId, 202609n);
});

test("poker ranks up to 255 are accepted, 0 and 256 refused", () => {
  process.env.TREASURY_VAULT_V2_ADDRESS_56 = "0xC9286EE3390A4dC642340bd703396E6B7b2521d5";
  const base = { chainId: 56, period: "weekly", epochStart: "2026-09-21T00:00:00.000Z", category: "top_earner", recipient, amountRaw: "5" };
  assert.doesNotThrow(() => buildExpectedEvmLeagueClaim({ ...base, rank: 255 }));
  assert.throws(() => buildExpectedEvmLeagueClaim({ ...base, rank: 256 }), /rank/i);
  assert.throws(() => buildExpectedEvmLeagueClaim({ ...base, rank: 0 }), /rank/i);
  assert.equal(monthIdForEpochStart(new Date("2026-12-01T00:00:00.000Z")), 202612n);
});
