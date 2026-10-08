/**
 * Launch-generation contracts next to the campaigns: CreatorRewardsVaultV2 (C6 fee choice, accruals,
 * claims, buybacks, holder batches) and the lockers of this generation (E9 harvest: MemeFeesSold,
 * FeesHarvested; E13 PoolFeeRecorded). Their events land in evm_campaign_events keyed by campaign
 * where the event names one, or by the graduated pool otherwise (looked up in
 * evm_campaign_gen5_state.graduated_pool).
 *
 * Addresses come from env, "0xaddr@startBlock" entries, comma separated:
 *   EVM_CREATOR_VAULT_V2_<chainId>   the generation's CreatorRewardsVaultV2
 *   EVM_GEN5_LP_LOCKERS_<chainId>    the generation's PermanentLpLocker (BNB) / PermanentV3PositionLocker (RH)
 *   EVM_GEN7_CREATOR_VAULT_<chainId> gen-7's own CreatorRewardsVaultV2 (evmGen7Fees.ts), appended
 * TreasuryRouterV4's RouteExecuted has the V3 topic and is scanned by the reward-router scan
 * (TREASURY_ROUTERS_<id> / TREASURY_ROUTERS_EXTRA_<id>).
 */
import { ethers } from "ethers";
import { CREATOR_REWARDS_VAULT_V2_EVENTS, LP_LOCKER_EVENTS, V3_LOCKER_EVENTS } from "./evmGen5Abi.js";
import { recordEvmEvent, serializeEventArgs, setGen5FeeChoice, type EvmContractKind, type Queryable } from "./evmGen5Store.js";
import { evmGen7FeesStack } from "./evmGen7Fees.js";

export const CREATOR_VAULT_V2_IFACE = new ethers.Interface(CREATOR_REWARDS_VAULT_V2_EVENTS as unknown as string[]);
export const GEN5_LOCKER_IFACE = new ethers.Interface([...LP_LOCKER_EVENTS, ...V3_LOCKER_EVENTS] as unknown as string[]);

function topics(iface: ethers.Interface): string[] {
  const out: string[] = [];
  iface.forEachEvent((e) => {
    out.push(e.topicHash);
  });
  return out;
}

export const CREATOR_VAULT_V2_TOPICS = topics(CREATOR_VAULT_V2_IFACE);
export const GEN5_LOCKER_TOPICS = topics(GEN5_LOCKER_IFACE);

export type AuxContract = { address: string; startBlock: number; kind: Extract<EvmContractKind, "creator_vault" | "lp_locker"> };

function parseEntries(raw: string | undefined, kind: AuxContract["kind"]): AuxContract[] {
  return String(raw || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [address, block] = entry.split("@");
      return { address: String(address || "").toLowerCase(), startBlock: Number(block || 0) || 0, kind };
    })
    .filter((c) => /^0x[a-f0-9]{40}$/.test(c.address));
}

export function configuredGen5AuxContracts(chainId: number, env: NodeJS.ProcessEnv = process.env): AuxContract[] {
  const gen7Vault = evmGen7FeesStack(chainId, env).creatorVault;
  const out = [
    ...parseEntries(env[`EVM_CREATOR_VAULT_V2_${chainId}`], "creator_vault"),
    ...parseEntries(env[`EVM_GEN5_LP_LOCKERS_${chainId}`], "lp_locker"),
    // Gen-7's own CreatorRewardsVaultV2 (EVM_GEN7_CREATOR_VAULT_<id>): same events, its own cursor.
    ...(gen7Vault ? [{ address: gen7Vault.address.toLowerCase(), startBlock: gen7Vault.startBlock, kind: "creator_vault" as const }] : []),
  ];
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.address) ? false : (seen.add(c.address), true)));
}

export function auxTopics(kind: AuxContract["kind"]): string[] {
  return kind === "creator_vault" ? CREATOR_VAULT_V2_TOPICS : GEN5_LOCKER_TOPICS;
}

async function campaignForPool(db: Queryable, chainId: number, pool: string): Promise<string | null> {
  const r = await db.query(
    `select campaign_address from public.evm_campaign_gen5_state where chain_id = $1 and graduated_pool = $2 limit 1`,
    [chainId, pool.toLowerCase()],
  );
  if (r.rows[0]?.campaign_address) return String(r.rows[0].campaign_address);
  const reg = await db.query(
    `select campaign_address from public.evm_campaign_events
      where chain_id = $1 and contract_kind = 'lp_locker' and event_name = 'GraduationPoolRegistered'
        and args->>'pool' = $2 and campaign_address is not null
      limit 1`,
    [chainId, pool.toLowerCase()],
  );
  return reg.rows[0]?.campaign_address ? String(reg.rows[0].campaign_address) : null;
}

/** Decode and record one vault / locker log. Returns the event name, or null for an unknown topic. */
export async function recordGen5AuxLog(
  db: Queryable,
  chainId: number,
  contract: AuxContract,
  log: { topics: readonly string[]; data: string; transactionHash?: string | null; index?: number; logIndex?: number; blockNumber: number },
  blockTime: Date | null,
): Promise<string | null> {
  const iface = contract.kind === "creator_vault" ? CREATOR_VAULT_V2_IFACE : GEN5_LOCKER_IFACE;
  let parsed: ethers.LogDescription | null = null;
  try {
    parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
  } catch {
    parsed = null;
  }
  if (!parsed || !log.transactionHash) return null;
  const args = serializeEventArgs(parsed.fragment, parsed.args);
  let campaign = typeof args.campaign === "string" ? args.campaign : null;
  if (!campaign && typeof args.pool === "string") campaign = await campaignForPool(db, chainId, args.pool);
  await recordEvmEvent(db, {
    chainId,
    contractAddress: contract.address,
    contractKind: contract.kind,
    campaignAddress: campaign,
    eventName: parsed.name,
    txHash: log.transactionHash,
    logIndex: Number(log.index ?? log.logIndex ?? 0),
    blockNumber: log.blockNumber,
    blockTime,
    args,
  });
  if (parsed.name === "CampaignChoiceSet" && campaign) {
    await setGen5FeeChoice(db, chainId, campaign, {
      vault: contract.address,
      choice: Number(args.choice),
      creatorPct: Number(args.creatorPct),
    });
  }
  return parsed.name;
}
