const SUPPORTED_BNB_CHAINS = new Set([56, 97]);

function requiredText(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new TypeError(`${field} is required`);
  return normalized;
}

function lowerAddress(value, field) {
  const normalized = requiredText(value, field).toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) throw new TypeError(`${field} must be an EVM address`);
  return normalized;
}

function clampLimit(value) {
  const parsed = Number(value ?? 100);
  if (!Number.isFinite(parsed)) return 100;
  return Math.max(1, Math.min(500, Math.trunc(parsed) || 100));
}

export async function selectPendingBnbBondingProtocolRevenue(db, options = {}) {
  if (!db || typeof db.query !== "function") throw new TypeError("db.query is required");

  const chainId = Number(options.chainId);
  if (!SUPPORTED_BNB_CHAINS.has(chainId)) {
    throw new TypeError("BNB bonding revenue backfill selector only supports chain 56 or 97");
  }

  const networkKey = requiredText(options.networkKey, "networkKey");
  const deploymentGeneration = requiredText(options.deploymentGeneration, "deploymentGeneration");
  const expectedSourceContract = lowerAddress(options.expectedSourceContract, "expectedSourceContract");
  const limit = clampLimit(options.limit);

  const { rows } = await db.query(
    `SELECT
       re.id,
       re.chain_id,
       re.tx_hash,
       re.log_index,
       re.block_number,
       re.occurred_at,
       re.epoch_id,
       re.wallet_address,
       re.campaign_address,
       re.route_kind,
       re.route_profile,
       re.league_amount,
       re.recruiter_amount,
       re.airdrop_amount,
       re.squad_amount,
       re.protocol_amount,
       re.raw_amount,
       re.source_contract,
       re.source_event,
       re.matched_activity_source,
       re.metadata
     FROM public.reward_events re
     WHERE re.chain_id = $1
       AND re.route_kind = 'trade'
       AND re.protocol_amount > 0
       AND re.source_contract = $2
       AND NOT EXISTS (
         SELECT 1
         FROM public.finance_chain_evidence fce
         WHERE fce.chain_family = 'evm'
           AND fce.chain_id = re.chain_id
           AND fce.network_key = $3
           AND fce.deployment_generation = $4
           AND fce.transaction_ref = re.tx_hash
           AND fce.event_index = re.log_index
           AND fce.inner_event_index = -1
           AND fce.source_event_type = 'BondingTradeProtocolRevenue'
       )
     ORDER BY re.block_number ASC, re.log_index ASC, re.id ASC
     LIMIT $5`,
    [chainId, expectedSourceContract, networkKey, deploymentGeneration, limit],
  );

  return rows;
}
