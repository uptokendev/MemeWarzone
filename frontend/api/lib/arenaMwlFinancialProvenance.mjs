const BSC_CHAIN_ID = 97;
const SOLANA_CHAIN_ID = 101;
const MONTHLY_BPS = 6000n;
const BPS_DENOMINATOR = 10000n;

function requiredString(value, code) {
  const out = String(value ?? '').trim();
  if (!out) throw new Error(code);
  return out;
}

function requiredBigInt(value, code) {
  let out;
  try { out = BigInt(value); } catch { throw new Error(code); }
  if (out <= 0n) throw new Error(code);
  return out;
}

export function splitLeagueGross(grossValue) {
  const gross = requiredBigInt(grossValue, 'MWL_GROSS_INVALID');
  const monthly = (gross * MONTHLY_BPS) / BPS_DENOMINATOR;
  const quarterly = gross - monthly;
  return { gross, monthly, quarterly };
}

export function validateMwlProvenance(input) {
  const chainId = Number(input?.chainId);
  if (chainId !== BSC_CHAIN_ID && chainId !== SOLANA_CHAIN_ID) throw new Error('MWL_CHAIN_UNSUPPORTED');

  const txHash = requiredString(input?.txHash, 'MWL_TX_REQUIRED');
  const sourceId = requiredString(input?.sourceId, 'MWL_SOURCE_REQUIRED');
  const authorityAddress = requiredString(input?.authorityAddress, 'MWL_AUTHORITY_REQUIRED');
  const sourceKind = requiredString(input?.sourceKind, 'MWL_SOURCE_KIND_REQUIRED');
  const providedGross = requiredBigInt(input?.grossAmount, 'MWL_GROSS_INVALID');
  const providedMonthly = requiredBigInt(input?.monthlyAmount, 'MWL_MONTHLY_INVALID');
  const providedQuarterly = requiredBigInt(input?.quarterlyAmount, 'MWL_QUARTERLY_INVALID');
  const expected = splitLeagueGross(providedGross);

  if (providedMonthly + providedQuarterly !== providedGross) throw new Error('MWL_GROSS_SPLIT_MISMATCH');
  if (providedMonthly !== expected.monthly || providedQuarterly !== expected.quarterly) throw new Error('MWL_60_40_MISMATCH');

  if (chainId === BSC_CHAIN_ID) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error('MWL_BSC_TX_INVALID');
    if (!/^0x[0-9a-fA-F]{40}$/.test(authorityAddress)) throw new Error('MWL_BSC_AUTHORITY_INVALID');
    if (!/^0x[0-9a-fA-F]{64}$/.test(sourceId)) throw new Error('MWL_BSC_SOURCE_INVALID');
    if (!Number.isInteger(Number(input?.eventIndex)) || Number(input.eventIndex) < 0) throw new Error('MWL_BSC_EVENT_INDEX_INVALID');
  }

  if (chainId === SOLANA_CHAIN_ID) {
    requiredString(input?.receiptAddress, 'MWL_SOLANA_RECEIPT_REQUIRED');
    if (sourceKind !== 'competition') throw new Error('MWL_SOLANA_SOURCE_KIND_INVALID');
  }

  return {
    chainId,
    txHash,
    sourceId,
    sourceKind,
    authorityAddress,
    receiptAddress: input?.receiptAddress ? String(input.receiptAddress).trim() : null,
    eventIndex: chainId === BSC_CHAIN_ID ? Number(input.eventIndex) : null,
    grossAmount: providedGross,
    monthlyAmount: providedMonthly,
    quarterlyAmount: providedQuarterly,
  };
}

export async function insertMwlProvenance(db, input) {
  const v = validateMwlProvenance(input);
  const sql = `
    insert into public.arena_war_pool_claims (
      pool_id, bucket, wallet, amount_wei, tx_hash, chain_id,
      source_id, source_kind, event_index,
      gross_amount_wei, monthly_amount_wei, quarterly_amount_wei,
      authority_address, receipt_address, reconciled_at
    ) values (
      $1, 'mwl', $2, $3, $4, $5,
      $6, $7, $8,
      $9, $10, $11,
      $12, $13, now()
    )
    on conflict (chain_id, tx_hash) do nothing
    returning *
  `;
  const params = [
    v.sourceId,
    v.authorityAddress,
    v.grossAmount.toString(),
    v.txHash,
    v.chainId,
    v.sourceId,
    v.sourceKind,
    v.eventIndex,
    v.grossAmount.toString(),
    v.monthlyAmount.toString(),
    v.quarterlyAmount.toString(),
    v.authorityAddress,
    v.receiptAddress,
  ];
  const result = await db.query(sql, params);
  if (result.rows?.[0]) return { inserted: true, row: result.rows[0] };

  const existing = await db.query(
    `select * from public.arena_war_pool_claims where chain_id=$1 and tx_hash=$2 and bucket='mwl' limit 1`,
    [v.chainId, v.txHash],
  );
  const row = existing.rows?.[0];
  if (!row) throw new Error('MWL_RECONCILIATION_CONFLICT_WITHOUT_ROW');
  if (String(row.source_id) !== v.sourceId) throw new Error('MWL_REPLAY_SOURCE_MISMATCH');
  if (BigInt(row.gross_amount_wei) !== v.grossAmount) throw new Error('MWL_REPLAY_AMOUNT_MISMATCH');
  if (BigInt(row.monthly_amount_wei) !== v.monthlyAmount || BigInt(row.quarterly_amount_wei) !== v.quarterlyAmount) throw new Error('MWL_REPLAY_SPLIT_MISMATCH');
  return { inserted: false, row };
}

export const MWL_FINANCIAL_CONSTANTS = Object.freeze({ BSC_CHAIN_ID, SOLANA_CHAIN_ID, MONTHLY_BPS: 6000, QUARTERLY_BPS: 4000 });
