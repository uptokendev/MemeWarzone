from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    if old not in text:
        raise SystemExit(f"pattern not found in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1), encoding="utf-8")


# Solana treasury supports both launch-visible native reward lanes that already
# have builders/reconciliation: airdrop and squad.
replace_once(
    "frontend/api/dev-fix/reward-claim-intent.js",
    'supportedRewardTypes: ["airdrop"],',
    'supportedRewardTypes: ["airdrop", "squad"],',
)

# A League claim request is not payment truth. Only a verified payout tx is.
replace_once(
    "frontend/api/rewards.js",
    '''        FROM league_epoch_winners w
        LEFT JOIN league_epoch_claims c
          ON c.chain_id = w.chain_id
         AND c.period = w.period
         AND c.epoch_start = w.epoch_start
         AND c.category = w.category
         AND c.rank = w.rank
        WHERE w.chain_id = $1
          AND ${recipientClause}
          AND c.claimed_at IS NULL''',
    '''        FROM league_epoch_winners w
        LEFT JOIN league_epoch_payouts p
          ON p.chain_id = w.chain_id
         AND p.period = w.period
         AND p.epoch_start = w.epoch_start
         AND p.category = w.category
         AND p.rank = w.rank
        WHERE w.chain_id = $1
          AND ${recipientClause}
          AND p.tx_hash IS NULL''',
)

# Duplicate-transaction protection is cross-EVM/Solana; make it hash-safe and
# avoid misleading Solana-only audit/error text on Robinhood/BNB recovery.
replace_once(
    "frontend/api/rewards.js",
    '''    const reused = await client.query(
      `select id
         from public.reward_ledger
        where claim_tx_hash = $1
          and id <> $2::uuid
        limit 1`,
      [verification.txHash, current.id],
    );
    if (reused.rows.length) {
      const error = new Error("Confirmed Solana claim signature is already attached to another reward entitlement");
      error.code = "SOLANA_CLAIM_TX_REUSED";
      throw error;
    }

    const reconciledAt = new Date().toISOString();
    const claimVerification = {
      ...verification,
      reconciliationSource: "deterministic_claim_receipt",
      reconciledAt,
    };''',
    '''    const reused = await client.query(
      `select id
         from public.reward_ledger
        where lower(coalesce(claim_tx_hash, '')) = lower($1)
          and id <> $2::uuid
        limit 1`,
      [verification.txHash, current.id],
    );
    if (reused.rows.length) {
      const error = new Error("Confirmed claim transaction is already attached to another reward entitlement");
      error.code = "CLAIM_TX_REUSED";
      throw error;
    }

    const isSolanaRecovery = Boolean(verification.claimReceiptAddress);
    const reconciledAt = new Date().toISOString();
    const claimVerification = {
      ...verification,
      reconciliationSource: isSolanaRecovery ? "deterministic_claim_receipt" : "reward_claimed_event",
      reconciledAt,
    };''',
)

replace_once(
    "frontend/api/rewards.js",
    '''       values
        ($1::uuid, 'system', 'solana-reconciler', 'claim_reconciled_onchain', $2, 'claimed',
         'Recovered confirmed Solana claim from deterministic receipt PDA', $3, $4::jsonb)`,
      [current.id, current.status, verification.txHash, JSON.stringify(claimVerification)],''',
    '''       values
        ($1::uuid, 'system', $5, 'claim_reconciled_onchain', $2, 'claimed',
         $6, $3, $4::jsonb)`,
      [
        current.id,
        current.status,
        verification.txHash,
        JSON.stringify(claimVerification),
        isSolanaRecovery ? "solana-reconciler" : "evm-reconciler",
        isSolanaRecovery
          ? "Recovered confirmed Solana claim from deterministic receipt PDA"
          : "Recovered confirmed EVM RewardDistributor claim from exact on-chain event",
      ],''',
)

replace_once(
    "frontend/api/rewards.js",
    '''// POST /api/rewards with action=reconcile-solana-claims is a proof-only state repair:
// it cannot move funds and only advances stale DB state after strict on-chain verification.''',
    '''// POST /api/rewards reconciliation actions are proof-only state repair:
// they cannot move funds and only advance stale DB state after strict on-chain verification.''',
)

print("agent6 claim recovery patch applied")
