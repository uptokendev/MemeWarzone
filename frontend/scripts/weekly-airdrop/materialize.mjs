import { AbiCoder, concat, getAddress, keccak256, toUtf8Bytes } from "ethers";

const coder = AbiCoder.defaultAbiCoder();

export function weeklyContractBatchId(chainId, epochId, program) {
  return keccak256(toUtf8Bytes(`mwz-weekly-airdrop:${chainId}:${epochId}:${program}`));
}

function nativeSymbol(chainId) {
  return Number(chainId) === 4663 || Number(chainId) === 46630 ? "ETH" : "BNB";
}

function leafFor(walletAddress, amount) {
  const inner = keccak256(coder.encode(["address", "uint256"], [getAddress(walletAddress), BigInt(amount)]));
  return keccak256(inner);
}

function hashPair(left, right) {
  return keccak256(concat(left.toLowerCase() <= right.toLowerCase() ? [left, right] : [right, left]));
}

function merklePlan(entries) {
  if (!entries.length) throw new Error("Cannot materialize an empty airdrop batch");
  const leaves = entries.map((entry) => leafFor(entry.walletAddress, entry.amount));
  const levels = [leaves];
  while (levels.at(-1).length > 1) {
    const current = levels.at(-1);
    const next = [];
    for (let index = 0; index < current.length; index += 2) {
      next.push(index + 1 < current.length ? hashPair(current[index], current[index + 1]) : current[index]);
    }
    levels.push(next);
  }
  const proofs = leaves.map((_leaf, leafIndex) => {
    const proof = [];
    let index = leafIndex;
    for (let levelIndex = 0; levelIndex < levels.length - 1; levelIndex += 1) {
      const level = levels[levelIndex];
      const pairIndex = index % 2 === 0 ? index + 1 : index - 1;
      if (pairIndex < level.length) proof.push(level[pairIndex]);
      index = Math.floor(index / 2);
    }
    return proof;
  });
  return { root: levels.at(-1)[0], leaves, proofs };
}

export async function materializeAirdropBatch(client, {
  chainId,
  epochId,
  program,
  winners,
  payouts,
  claimDeadline,
  distributorAddress,
  metadata = {},
}) {
  if (winners.length !== payouts.length || !winners.length) throw new Error("Winner and payout counts must match");
  const entries = winners.map((winner, index) => {
    const walletAddress = getAddress(winner.walletAddress);
    const amount = BigInt(payouts[index]);
    if (amount <= 0n) throw new Error(`Invalid payout for ${walletAddress}`);
    return { winner, walletAddress, amount: amount.toString() };
  });
  const totalAmount = entries.reduce((sum, entry) => sum + BigInt(entry.amount), 0n).toString();

  await client.query("begin");
  try {
    const duplicate = await client.query(
      `select id,status from public.reward_batches
        where reward_type='airdrop' and chain::text=$1 and metadata->>'epochId'=$2 and metadata->>'program'=$3
          and status<>'archived' limit 1 for update`,
      [String(chainId), epochId, program],
    );
    if (duplicate.rows[0]) throw new Error(`A ${program} batch already exists for epoch ${epochId}`);

    const { rows: batchRows } = await client.query(
      `insert into public.reward_batches
        (reward_type,chain,token_symbol,status,total_amount,recipient_count,claimable_count,claimed_count,failed_count,source,metadata)
       values ('airdrop',$1,$5,'funding_check',$2::numeric,$3,0,0,0,'weekly_airdrop_scheduler',$4::jsonb)
       returning *`,
      [String(chainId), totalAmount, entries.length, JSON.stringify({ ...metadata, epochId, program, automated: true }), nativeSymbol(chainId)],
    );
    let batch = batchRows[0];
    // Deterministic per chain / week / program, so the Safe can pre-authorize future weeks on the
    // RewardDistributor (authorizeBatch) and the Coolify operator key can only fund those.
    const contractBatchId = weeklyContractBatchId(chainId, epochId, program);
    const { root, leaves, proofs } = merklePlan(entries);
    const claimMetadata = {
      claimMode: "reward_distributor_merkle",
      claimContract: "RewardDistributor",
      distributorAddress: getAddress(distributorAddress),
      rewardDistributorAddress: getAddress(distributorAddress),
      contractBatchId,
      merkleBatchId: contractBatchId,
      merkleRoot: root,
      merkleRecipientCount: entries.length,
      merkleTotalAmount: totalAmount,
      merkleLeafEncoding: "keccak256(bytes.concat(keccak256(abi.encode(account, amount))))",
      merklePairSorting: "openzeppelins_commutative_hash",
      claimDeadline,
      fundingCheckStartedAt: new Date().toISOString(),
    };
    const { rows: updatedBatchRows } = await client.query(
      `update public.reward_batches set metadata=coalesce(metadata,'{}'::jsonb)||$2::jsonb,updated_at=now()
        where id=$1::uuid returning *`,
      [batch.id, JSON.stringify(claimMetadata)],
    );
    batch = updatedBatchRows[0] || batch;

    const ledgerItems = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const winnerMetadata = {
        ...entry.winner,
        batchId: batch.id,
        batchIndex: index,
        claimMode: claimMetadata.claimMode,
        claimContract: claimMetadata.claimContract,
        distributorAddress: claimMetadata.distributorAddress,
        rewardDistributorAddress: claimMetadata.rewardDistributorAddress,
        contractBatchId,
        merkleBatchId: contractBatchId,
        merkleRoot: root,
        merkleProof: proofs[index],
        merkleLeaf: leaves[index],
        claimAmount: entry.amount,
        claimDeadline,
      };
      const { rows } = await client.query(
        `insert into public.reward_ledger
          (reward_type,source_id,source_label,wallet_address,chain,token_symbol,amount,status,metadata)
         values ('airdrop',$1,'weekly_airdrop_scheduler',$2,$3,$6,$4::numeric,'approved',$5::jsonb)
         returning *`,
        [`${epochId}:${program}:${entry.winner.winnerRank}`, entry.walletAddress.toLowerCase(), String(chainId), entry.amount, JSON.stringify(winnerMetadata), nativeSymbol(chainId)],
      );
      const ledger = rows[0];
      await client.query(
        `insert into public.reward_batch_items
          (batch_id,reward_ledger_id,wallet_address,amount,status,metadata)
         values ($1,$2,$3,$4::numeric,'approved',$5::jsonb)`,
        [batch.id, ledger.id, entry.walletAddress.toLowerCase(), entry.amount, JSON.stringify(winnerMetadata)],
      );
      ledgerItems.push(ledger);
    }

    await client.query(
      `insert into public.reward_audit_logs
        (batch_id,actor_type,actor_id,action,new_value,reason,metadata)
       values ($1,'scheduler','weekly_airdrop_runner','automatic_airdrop_batch_materialized',$2,$3,$4::jsonb)`,
      [batch.id, JSON.stringify({ status: "funding_check", recipientCount: entries.length, totalAmount }), `Automatic ${program} batch materialized`, JSON.stringify({ chainId, epochId, program, merkleRoot: root })],
    );
    await client.query("commit");
    return { batch, items: ledgerItems };
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}
