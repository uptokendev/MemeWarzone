from pathlib import Path


def replace_exact(path: str, old: str, new: str, expected: int = 1) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    actual = text.count(old)
    if actual != expected:
        raise SystemExit(f"expected {expected} match(es) in {path}, found {actual}")
    p.write_text(text.replace(old, new, expected), encoding="utf-8")


replace_exact(
    "frontend/api/leagueRouter.js",
    '''    await client.query(
      `insert into public.league_epoch_payouts
        (chain_id, period, epoch_start, category, rank, recipient_address, amount_raw, tx_hash)
       values ($1,$2,$3::timestamptz,$4,$5,$6,$7,$8)
       on conflict (chain_id, period, epoch_start, category, rank) do nothing`,
      [
        row.chainId,
        row.period,
        row.epochStart,
        row.category,
        row.rank,
        row.recipientAddress,
        row.amountRaw,
        verification.txHash,
      ],
    );
''',
    '''    const { rows: payoutRows } = await client.query(
      `insert into public.league_epoch_payouts
        (chain_id, period, epoch_start, category, rank, recipient_address, amount_raw, tx_hash)
       values ($1,$2,$3::timestamptz,$4,$5,$6,$7,$8)
       on conflict (chain_id, period, epoch_start, category, rank)
       do update set
         recipient_address = excluded.recipient_address,
         amount_raw = excluded.amount_raw,
         tx_hash = excluded.tx_hash,
         paid_at = now()
       where public.league_epoch_payouts.tx_hash is null
       returning tx_hash as "txHash"`,
      [
        row.chainId,
        row.period,
        row.epochStart,
        row.category,
        row.rank,
        row.recipientAddress,
        row.amountRaw,
        verification.txHash,
      ],
    );
    if (!payoutRows[0]?.txHash) {
      const error = new Error("League payout slot was recorded concurrently and cannot be overwritten");
      error.code = "LEAGUE_PAYOUT_ALREADY_RECORDED";
      throw error;
    }
''',
)

replace_exact(
    "frontend/api/leaguePayouts.js",
    '''    const txHash = body.txHash ? String(body.txHash).toLowerCase().trim() : null;
    const payouts = Array.isArray(body.payouts) ? body.payouts : [];

    if (!Number.isFinite(chainId)) return json(res, 400, { error: "Invalid chainId" });
''',
    '''    const txHash = body.txHash ? String(body.txHash).toLowerCase().trim() : null;
    const payouts = Array.isArray(body.payouts) ? body.payouts : [];

    if (!Number.isFinite(chainId)) return json(res, 400, { error: "Invalid chainId" });
    if (txHash && !/^0x[a-f0-9]{64}$/.test(txHash)) return json(res, 400, { error: "Invalid txHash" });
''',
)
replace_exact(
    "frontend/api/leaguePayouts.js",
    '''      const r = await pool.query(
        `insert into public.league_epoch_payouts
           (chain_id, period, epoch_start, category, rank, recipient_address, amount_raw, tx_hash)
         values ($1,$2,$3::timestamptz,$4,$5,$6,$7::numeric,$8)
         on conflict (chain_id, period, epoch_start, category, rank) do nothing`,
        [chainId, period, epochStart, category, rank, recipient, amountRaw, txHash]
      );
''',
    '''      const r = await pool.query(
        `insert into public.league_epoch_payouts
           (chain_id, period, epoch_start, category, rank, recipient_address, amount_raw, tx_hash)
         values ($1,$2,$3::timestamptz,$4,$5,$6,$7::numeric,$8)
         on conflict (chain_id, period, epoch_start, category, rank)
         do update set
           recipient_address = excluded.recipient_address,
           amount_raw = excluded.amount_raw,
           tx_hash = excluded.tx_hash,
           paid_at = now()
         where public.league_epoch_payouts.tx_hash is null
           and excluded.tx_hash is not null`,
        [chainId, period, epochStart, category, rank, recipient, amountRaw, txHash]
      );
''',
)

replace_exact(
    "frontend/api/lib/solanaRewardClaim.js",
    '''export function solanaRewardsProgramId() {
  const programId = String(process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID || "").trim();
  if (!programId) throw new Error("SOLANA_REWARDS_TREASURY_PROGRAM_ID is required");
  return programId;
}
''',
    '''export function solanaRewardsProgramId() {
  const programId = String(process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID || "").trim();
  if (!programId) return "";
  try {
    return publicKeyBytes(programId).length === 32 ? programId : "";
  } catch {
    return "";
  }
}
''',
)
replace_exact(
    "frontend/api/lib/solanaRewardClaim.js",
    '''  const programId = solanaRewardsProgramId();
  if (reason) {
''',
    '''  const programId = solanaRewardsProgramId();
  if (!reason && !programId) reason = "MISSING_SOLANA_REWARDS_PROGRAM_ID";
  if (reason) {
''',
    expected=2,
)

replace_exact(
    "frontend/api/dev-fix/reward-claim-intent.js",
    '''  buildSolanaRewardCall,
  isSolanaSignature,
  verifySolanaRewardClaim,
''',
    '''  buildSolanaRewardCall,
  isSolanaSignature,
  solanaRewardsProgramId,
  verifySolanaRewardClaim,
''',
)
replace_exact(
    "frontend/api/dev-fix/reward-claim-intent.js",
    '''  if (SOLANA_CHAINS.has(chain)) {
    return {
      chainId: chain,
      tokenSymbol: "SOL",
      enabled: true,
      mode: "solana_treasury",
      reason: null,
      distributorAddress: "",
      supportedRewardTypes: ["airdrop", "squad"],
    };
  }
''',
    '''  if (SOLANA_CHAINS.has(chain)) {
    const programId = solanaRewardsProgramId();
    const enabled = Boolean(programId);
    return {
      chainId: chain,
      tokenSymbol: "SOL",
      enabled,
      mode: enabled ? "solana_treasury" : "disabled",
      reason: enabled ? null : "MISSING_SOLANA_REWARDS_PROGRAM_ID",
      distributorAddress: "",
      programId,
      supportedRewardTypes: ["airdrop", "squad"],
    };
  }
''',
)
replace_exact(
    "frontend/api/dev-fix/reward-claim-intent.js",
    '''    supportedChains: [56, 97, 4663, 46630, 101, 102],
    disabledChains: [],
''',
    '''    supportedChains: [56, 97, 4663, 46630, 101, 102],
    disabledChains: config.enabled ? [] : [chainId],
''',
)

p = Path("frontend/scripts/agent6-all-claims-three-chain.test.mjs")
text = p.read_text(encoding="utf-8")
router_anchor = '''assert.match(router, /pg_advisory_xact_lock/);\n'''
router_add = '''assert.match(router, /where public\\.league_epoch_payouts\\.tx_hash is null/);\nassert.match(router, /LEAGUE_PAYOUT_ALREADY_RECORDED/);\n\nconst leaguePayouts = read("api/leaguePayouts.js");\nassert.match(leaguePayouts, /Invalid txHash/);\nassert.match(leaguePayouts, /where public\\.league_epoch_payouts\\.tx_hash is null/);\nassert.match(leaguePayouts, /excluded\\.tx_hash is not null/);\n'''
if text.count(router_anchor) != 1:
    raise SystemExit("router test insertion anchor mismatch")
text = text.replace(router_anchor, router_anchor + router_add, 1)
sol_anchor = '''assert.match(rewardSol, /if \\(rewardType !== "airdrop"\\) return unavailableCall/);\n'''
sol_add = '''assert.match(rewardSol, /MISSING_SOLANA_REWARDS_PROGRAM_ID/);\nassert.doesNotMatch(rewardSol, /SOLANA_REWARDS_TREASURY_PROGRAM_ID is required/);\nassert.match(intent, /disabledChains: config\\.enabled \\? \\[\\] : \\[chainId\\]/);\n'''
if text.count(sol_anchor) != 1:
    raise SystemExit("Solana test insertion anchor mismatch")
p.write_text(text.replace(sol_anchor, sol_anchor + sol_add, 1), encoding="utf-8")

Path("frontend/api/lib/solanaRewardClaim.test.mjs").write_text(r'''import assert from "node:assert/strict";
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
''', encoding="utf-8")
