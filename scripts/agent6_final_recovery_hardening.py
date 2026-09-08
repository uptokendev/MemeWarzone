from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected exactly one match in {path}, found {count}")
    p.write_text(text.replace(old, new, 1), encoding="utf-8")


# EVM League reconciliation may encounter an admin-created placeholder payout row
# whose tx_hash is still NULL. Strictly verified chain evidence may fill only that
# empty slot; an existing non-null payment can never be overwritten.
replace_once(
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

# The legacy admin/multisig recorder may create a placeholder with no tx hash.
# Permit a later real EVM hash to fill that placeholder, but never overwrite a
# non-null recorded payment.
replace_once(
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
replace_once(
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

# Missing or malformed Solana program configuration is a normal CONFIG REQUIRED
# state, not an exception. Return a disabled claim call so API/config surfaces can
# fail closed with a useful code instead of advertising enabled then throwing 500.
replace_once(
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
replace_once(
    "frontend/api/lib/solanaRewardClaim.js",
    '''  const programId = solanaRewardsProgramId();
  if (reason) {
''',
    '''  const programId = solanaRewardsProgramId();
  if (!reason && !programId) reason = "MISSING_SOLANA_REWARDS_PROGRAM_ID";
  if (reason) {
''',
)
# There are two builder sites with the same original marker. The first replacement
# above consumes the Squad site; this second call consumes the Airdrop site.
replace_once(
    "frontend/api/lib/solanaRewardClaim.js",
    '''  const programId = solanaRewardsProgramId();
  if (reason) {
''',
    '''  const programId = solanaRewardsProgramId();
  if (!reason && !programId) reason = "MISSING_SOLANA_REWARDS_PROGRAM_ID";
  if (reason) {
''',
)

replace_once(
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
replace_once(
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
replace_once(
    "frontend/api/dev-fix/reward-claim-intent.js",
    '''    supportedChains: [56, 97, 4663, 46630, 101, 102],
    disabledChains: [],
''',
    '''    supportedChains: [56, 97, 4663, 46630, 101, 102],
    disabledChains: config.enabled ? [] : [chainId],
''',
)

# Strengthen the static matrix around the two recovered launch blockers.
p = Path("frontend/scripts/agent6-all-claims-three-chain.test.mjs")
text = p.read_text(encoding="utf-8")
anchor = '''assert.match(router, /pg_advisory_xact_lock/);\n'''
addition = '''assert.match(router, /where public\\.league_epoch_payouts\\.tx_hash is null/);\nassert.match(router, /LEAGUE_PAYOUT_ALREADY_RECORDED/);\n\nconst leaguePayouts = read("api/leaguePayouts.js");\nassert.match(leaguePayouts, /Invalid txHash/);\nassert.match(leaguePayouts, /where public\\.league_epoch_payouts\\.tx_hash is null/);\nassert.match(leaguePayouts, /excluded\\.tx_hash is not null/);\n'''
if anchor not in text:
    raise SystemExit("test insertion anchor not found")
text = text.replace(anchor, anchor + addition, 1)
sol_anchor = '''assert.match(rewardSol, /if \\(rewardType !== "airdrop"\\) return unavailableCall/);\n'''
sol_addition = '''assert.match(rewardSol, /MISSING_SOLANA_REWARDS_PROGRAM_ID/);\nassert.doesNotMatch(rewardSol, /SOLANA_REWARDS_TREASURY_PROGRAM_ID is required/);\nassert.match(intent, /disabledChains: config\\.enabled \\? \\[\\] : \\[chainId\\]/);\n'''
if sol_anchor not in text:
    raise SystemExit("Solana test insertion anchor not found")
p.write_text(text.replace(sol_anchor, sol_anchor + sol_addition, 1), encoding="utf-8")

# Runtime unit coverage: valid-looking Airdrop/Squad entitlements must become a
# structured disabled call when the program env is absent/invalid, never throw.
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
