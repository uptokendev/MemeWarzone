/**
 * Airdrop pots per EVM chain (founder, 2026-10-08: gen-7 gets its own fees stack, so its own
 * CommunityRewardsVault; two pots instead of a weekly Safe merge, everything automated).
 *
 * A pot is one CommunityRewardsVault plus the RewardDistributor whose batchOperator is that vault
 * (RewardDistributor.batchOperator is a single address and createBatch is onlyOwnerOrBatchOperator,
 * so one distributor can serve one vault). Every pot keeps today's rules:
 *
 *   - "main": the existing vault/distributor. Env names, batch ids, DB rows: unchanged.
 *   - "gen7": the gen-7 TreasuryRouterV4's own vault and a second airdrop distributor. Only active
 *     when BOTH COMMUNITY_REWARDS_VAULT_ADDRESS_GEN7_<chainId> and REWARD_DISTRIBUTOR_ADDRESS_GEN7_<chainId>
 *     are set; neither set = exactly today's single-pot run; one of the two set = a config error.
 *
 * The operator key defaults to the main one (AIRDROP_OPERATOR_PRIVATE_KEY_<chainId>): the Safe sets the
 * same address as airdropOperator on both vaults, and its reach stays what the Safe pre-authorized per
 * distributor. AIRDROP_OPERATOR_PRIVATE_KEY_GEN7_<chainId> overrides it for the gen-7 pot.
 */
import { getAddress } from "ethers";

export const MAIN_POT = "main";
export const GEN7_POT = "gen7";
export const POT_LABELS = Object.freeze({ [MAIN_POT]: "main pot", [GEN7_POT]: "gen-7 pot" });

function text(env, name) {
  return String(env[name] ?? "").trim();
}

export function isMainPot(pot) {
  return !pot || pot === MAIN_POT;
}

/** Extra metadata a pot's rows carry. The main pot carries none, so its rows stay byte-identical. */
export function potMetadata(pot) {
  return isMainPot(pot) ? {} : { airdropPot: pot };
}

/** SQL predicate on a jsonb metadata column: rows of this pot (main = rows without airdropPot). */
export const POT_SQL = (column = "metadata") => `coalesce(${column}->>'airdropPot','${MAIN_POT}')`;

/** Operator key for a pot: the gen-7 override when set, else the chain's airdrop operator key. */
export function potOperatorKey(chainId, pot, env = process.env) {
  if (!isMainPot(pot)) {
    const own = text(env, `AIRDROP_OPERATOR_PRIVATE_KEY_${String(pot).toUpperCase()}_${chainId}`);
    if (own) return own;
  }
  return text(env, `AIRDROP_OPERATOR_PRIVATE_KEY_${chainId}`);
}

/**
 * The gen-7 pot's addresses for a chain, or null when it is not configured.
 * Throws when only one of the two is set, or when they equal the main pot's (a copy-paste would make
 * the gen-7 run fund the main distributor with ids the Safe never authorized there).
 */
export function gen7PotConfig(chainId, env = process.env) {
  const vaultRaw = text(env, `COMMUNITY_REWARDS_VAULT_ADDRESS_GEN7_${chainId}`);
  const distributorRaw = text(env, `REWARD_DISTRIBUTOR_ADDRESS_GEN7_${chainId}`);
  if (!vaultRaw && !distributorRaw) return null;
  if (!vaultRaw || !distributorRaw) {
    throw new Error(`Gen-7 airdrop pot on chain ${chainId} needs both COMMUNITY_REWARDS_VAULT_ADDRESS_GEN7_${chainId} and REWARD_DISTRIBUTOR_ADDRESS_GEN7_${chainId}`);
  }
  const vaultAddress = getAddress(vaultRaw);
  const distributorAddress = getAddress(distributorRaw);
  const mainVault = text(env, `COMMUNITY_REWARDS_VAULT_ADDRESS_${chainId}`) || text(env, "COMMUNITY_REWARDS_VAULT_ADDRESS");
  const mainDistributor = text(env, `REWARD_DISTRIBUTOR_ADDRESS_${chainId}`);
  if (mainVault && mainVault.toLowerCase() === vaultAddress.toLowerCase()) {
    throw new Error(`COMMUNITY_REWARDS_VAULT_ADDRESS_GEN7_${chainId} equals the main pot's vault`);
  }
  if (mainDistributor && mainDistributor.toLowerCase() === distributorAddress.toLowerCase()) {
    throw new Error(`REWARD_DISTRIBUTOR_ADDRESS_GEN7_${chainId} equals the main pot's distributor`);
  }
  return { pot: GEN7_POT, label: POT_LABELS[GEN7_POT], vaultAddress, distributorAddress };
}

/**
 * Every pot the runner draws on this chain, main first. The main pot's addresses are read exactly as
 * before (vault: COMMUNITY_REWARDS_VAULT_ADDRESS_<chainId> || COMMUNITY_REWARDS_VAULT_ADDRESS;
 * distributor: REWARD_DISTRIBUTOR_ADDRESS_<chainId>, required by the runner).
 */
export function airdropPots(chainId, env = process.env) {
  const pots = [{
    pot: MAIN_POT,
    label: POT_LABELS[MAIN_POT],
    vaultAddress: text(env, `COMMUNITY_REWARDS_VAULT_ADDRESS_${chainId}`) || text(env, "COMMUNITY_REWARDS_VAULT_ADDRESS") || null,
    distributorAddress: text(env, `REWARD_DISTRIBUTOR_ADDRESS_${chainId}`) || null,
  }];
  const gen7 = gen7PotConfig(chainId, env);
  if (gen7) pots.push(gen7);
  return pots;
}

/** Seed label of a pot's draw: the main pot keeps today's label, so its draws reproduce exactly. */
export function drawLabel(chainId, epochId, program, pot = MAIN_POT) {
  return isMainPot(pot) ? `${chainId}:${epochId}:${program}` : `${chainId}:${epochId}:${program}:${pot}`;
}

/** reward_ledger / reward_calculation_inputs source_id of a winner. */
export function winnerSourceId(epochId, program, rank, pot = MAIN_POT) {
  return isMainPot(pot) ? `${epochId}:${program}:${rank}` : `${epochId}:${pot}:${program}:${rank}`;
}
