import assert from "node:assert/strict";
import test from "node:test";
import { buildSolanaRewardCall, solanaRewardsProgramId } from "./solanaRewardClaim.js";

const WALLET = "11111111111111111111111111111111";

function withoutProgramEnv(fn) {
  const previous = process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID;
  delete process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID;
  try { return fn(); }
  finally {
    if (previous == null) delete process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID;
    else process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID = previous;
  }
}

test("missing Solana rewards program fails Airdrop closed without throwing", () => {
  withoutProgramEnv(() => {
    assert.equal(solanaRewardsProgramId(), "");
    const call = buildSolanaRewardCall({
      id: "airdrop-1",
      reward_type: "airdrop",
      chain: 101,
      wallet_address: WALLET,
      token_symbol: "SOL",
      amount: "1",
      metadata: { program: "airdrop_trader", epochIdNumeric: "1", merkleProof: [] },
    });
    assert.equal(call.enabled, false);
    assert.equal(call.reason, "MISSING_SOLANA_REWARDS_PROGRAM_ID");
    assert.equal(call.mode, "solana_airdrop");
  });
});

test("missing Solana rewards program fails Squad closed without throwing", () => {
  withoutProgramEnv(() => {
    const call = buildSolanaRewardCall({
      id: "squad-1",
      reward_type: "squad",
      chain: 101,
      wallet_address: WALLET,
      token_symbol: "SOL",
      amount: "1",
      metadata: { solanaRewardLane: { lane: "squad", epochId: "1", merkleProof: [] } },
    });
    assert.equal(call.enabled, false);
    assert.equal(call.reason, "MISSING_SOLANA_REWARDS_PROGRAM_ID");
    assert.equal(call.kind, "solana_reward_lane");
    assert.equal(call.instruction, "claim_squad");
  });
});

test("malformed Solana rewards program is treated as missing configuration", () => {
  const previous = process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID;
  process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID = "not-a-public-key";
  try { assert.equal(solanaRewardsProgramId(), ""); }
  finally {
    if (previous == null) delete process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID;
    else process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID = previous;
  }
});
