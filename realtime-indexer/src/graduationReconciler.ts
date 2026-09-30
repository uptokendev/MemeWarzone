import { ethers } from "ethers";
import { ablyRest, tokenChannel } from "./ably.js";
import { LAUNCH_CAMPAIGN_ABI } from "./abis.js";
import { pool } from "./db.js";
import { ENV } from "./env.js";
import { reconcileGen5GraduationHandoff, reconcileGraduationHandoff } from "./marketContinuity.js";
import { GEN5_CAMPAIGN_IFACE } from "./evm/evmGen5CampaignLogs.js";
import { GEN5_GRADUATED_TOPIC, storedGraduatedFromRow, type StoredGraduated } from "./evm/evmGen5Handoff.js";
import { resolveCampaignGeneration } from "./evm/evmGen5Store.js";
import {
  graduationLogChunkRanges,
  graduationLogSearchWindow,
} from "./graduationSearch.js";
import { createWorkingProvider, maskRpcUrl, parseRpcList } from "./rpcProvider.js";

type ChainConfig = {
  chainId: number;
  rpcUrls: string[];
};

type Candidate = {
  campaignAddress: string;
  createdBlock: number;
  graduatedBlock: number | null;
  marketStage: string;
};

const LOOP_SYMBOL = Symbol.for("memewarzone.wtrGraduationReconcilerStarted");
const globalState = globalThis as any;

/** In-process cooldown: campaignKey → earliest next log-scan time (ms). */
const scanCooldownUntil = new Map<string, number>();

function campaignKey(chainId: number, campaign: string): string {
  return `${chainId}:${String(campaign || "").toLowerCase()}`;
}

function chainConfigs(): ChainConfig[] {
  const result: ChainConfig[] = [];
  const testnet = parseRpcList(ENV.BSC_RPC_HTTP_97);
  const mainnet = parseRpcList(ENV.BSC_RPC_HTTP_56);
  if (testnet.length) result.push({ chainId: 97, rpcUrls: testnet });
  if (mainnet.length) result.push({ chainId: 56, rpcUrls: mainnet });
  return result;
}

function isInScanCooldown(chainId: number, campaign: string): boolean {
  const until = scanCooldownUntil.get(campaignKey(chainId, campaign));
  if (!until) return false;
  if (Date.now() >= until) {
    scanCooldownUntil.delete(campaignKey(chainId, campaign));
    return false;
  }
  return true;
}

function markScanCooldown(chainId: number, campaign: string) {
  const ms = Math.max(30_000, ENV.GRADUATION_SCAN_COOLDOWN_MS);
  scanCooldownUntil.set(campaignKey(chainId, campaign), Date.now() + ms);
}

function clearScanCooldown(chainId: number, campaign: string) {
  scanCooldownUntil.delete(campaignKey(chainId, campaign));
}

async function listCandidates(chainId: number): Promise<Candidate[]> {
  const result = await pool.query(
    `select
       c.campaign_address,
       coalesce(c.created_block,0) as created_block,
       c.graduated_block,
       coalesce(cms.market_stage,c.market_stage,'BONDING') as market_stage
     from public.campaigns c
     left join public.campaign_market_state cms
       on cms.chain_id=c.chain_id and cms.campaign_address=c.campaign_address
     where c.chain_id=$1
       and c.support_enabled=true
       and c.indexing_enabled=true
       and coalesce(cms.market_stage,c.market_stage,'BONDING') in ('BONDING','GRADUATING','TOPAZ_PENDING','TOPAZ_DEGRADED')
     order by
       case when c.graduated_block is not null then 0 else 1 end,
       case when coalesce(cms.market_stage,c.market_stage,'BONDING') in ('GRADUATING','TOPAZ_PENDING','TOPAZ_DEGRADED') then 0 else 1 end,
       coalesce(c.graduated_at_chain,c.created_at_chain,c.updated_at) desc nulls last
     limit $2`,
    [chainId, Math.max(1, ENV.GRADUATION_HANDOFF_MAX_CAMPAIGNS)],
  );

  return result.rows.map((row: any) => ({
    campaignAddress: String(row.campaign_address).toLowerCase(),
    createdBlock: Number(row.created_block || 0),
    graduatedBlock: row.graduated_block == null ? null : Number(row.graduated_block),
    marketStage: String(row.market_stage || "BONDING"),
  }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function isTimeoutError(error: unknown): boolean {
  const msg = String((error as any)?.message || error || "").toLowerCase();
  const code = String((error as any)?.code || "").toLowerCase();
  return code === "timeout" || msg.includes("timeout") || msg.includes("timed out") || msg.includes("etimedout");
}

async function getLogsAdaptive(
  provider: ethers.JsonRpcProvider,
  address: string,
  topic0: string,
  fromBlock: number,
  toBlock: number,
  depth = 0,
): Promise<ethers.Log[]> {
  if (fromBlock > toBlock) return [];
  const span = toBlock - fromBlock + 1;
  const minSpan = Math.max(1, ENV.MIN_LOG_CHUNK_SIZE);
  try {
    if (ENV.INDEXER_LOG_CALL_DELAY_MS > 0) {
      await sleep(ENV.INDEXER_LOG_CALL_DELAY_MS);
    }
    return await provider.getLogs({ address, topics: [topic0], fromBlock, toBlock });
  } catch (error) {
    if (isTimeoutError(error) && depth < 6) {
      await sleep(1_000 + depth * 750);
      if (span > minSpan) {
        const mid = Math.floor((fromBlock + toBlock) / 2);
        const left = await getLogsAdaptive(provider, address, topic0, fromBlock, mid, depth + 1);
        const right = await getLogsAdaptive(provider, address, topic0, mid + 1, toBlock, depth + 1);
        return left.concat(right);
      }
      return getLogsAdaptive(provider, address, topic0, fromBlock, toBlock, depth + 1);
    }
    if (span <= minSpan) throw error;
    const mid = Math.floor((fromBlock + toBlock) / 2);
    const left = await getLogsAdaptive(provider, address, topic0, fromBlock, mid, depth + 1);
    const right = await getLogsAdaptive(provider, address, topic0, mid + 1, toBlock, depth + 1);
    return left.concat(right);
  }
}

async function findGraduationLog(
  provider: ethers.JsonRpcProvider,
  candidate: Candidate,
  finalizedHead: number,
  topic0?: string,
): Promise<ethers.Log | null> {
  const iface = new ethers.Interface(LAUNCH_CAMPAIGN_ABI);
  const event = iface.getEvent("CampaignFinalized");
  if (!event) throw new Error("CampaignFinalized event is missing from LAUNCH_CAMPAIGN_ABI");
  const topic = topic0 ?? event.topicHash;

  const window = graduationLogSearchWindow({
    finalizedHead,
    createdBlock: candidate.createdBlock,
    graduatedBlock: candidate.graduatedBlock,
    lookbackBlocks: ENV.GRADUATION_LOG_LOOKBACK_BLOCKS,
    unknownCreatedLookbackBlocks: ENV.GRADUATION_UNKNOWN_CREATED_LOOKBACK_BLOCKS,
    logChunkSize: ENV.LOG_CHUNK_SIZE,
  });

  if (window.fromBlock > window.toBlock) return null;

  const step = Math.max(250, ENV.LOG_CHUNK_SIZE);

  // Newest-first: stop at the first chunk that contains CampaignFinalized.
  for (const { start, end } of graduationLogChunkRanges(window.fromBlock, window.toBlock, step)) {
    const logs = await getLogsAdaptive(
      provider,
      candidate.campaignAddress,
      topic,
      start,
      end,
    );
    if (!logs.length) continue;
    return logs.sort(
      (a, b) => b.blockNumber - a.blockNumber || Number(b.index ?? 0) - Number(a.index ?? 0),
    )[0];
  }

  return null;
}

async function publishStageChange(input: {
  chainId: number;
  campaignAddress: string;
  from: string;
  to: string;
  blockNumber: number;
  txHash: string;
  reason?: string | null;
}) {
  if (input.from === input.to) return;
  try {
    const channel = ablyRest.channels.get(tokenChannel(input.chainId, input.campaignAddress));
    await channel.publish("market_stage_changed", {
      eventId: `${input.chainId}:${input.campaignAddress}:${input.blockNumber}:${input.to}`,
      chainId: input.chainId,
      campaignAddress: input.campaignAddress,
      from: input.from,
      to: input.to,
      marketStage: input.to,
      blockNumber: input.blockNumber,
      txHash: input.txHash,
      reason: input.reason ?? null,
    });
  } catch (error: any) {
    console.warn("[wtr] market stage realtime publish failed", error?.message || String(error));
  }
}

async function noteMissingGraduationLog(chainId: number, candidate: Candidate) {
  await pool.query(
    `insert into public.campaign_market_state(
       chain_id,campaign_address,token_address,factory_address,market_stage,
       pool_verified,indexing_enabled,last_error,created_at,updated_at
     )
     select
       c.chain_id,c.campaign_address,coalesce(c.token_address,''),c.factory_address,'TOPAZ_PENDING',
       false,true,'Campaign is launched on-chain but the finalized graduation log has not been recovered yet.',now(),now()
     from public.campaigns c
     where c.chain_id=$1 and c.campaign_address=$2
     on conflict (chain_id,campaign_address) do update set
       market_stage='TOPAZ_PENDING',
       pool_verified=false,
       indexing_enabled=true,
       last_error=excluded.last_error,
       updated_at=now()`,
    [chainId, candidate.campaignAddress],
  );

  await pool.query(
    `update public.campaigns
        set bonding_active=false,
            support_enabled=true,
            indexing_enabled=true,
            market_stage='TOPAZ_PENDING',
            updated_at=now()
      where chain_id=$1 and campaign_address=$2`,
    [chainId, candidate.campaignAddress],
  );
}

/** Generation 5? A failed resolution answers false; the old path then retries it next pass. */
async function isGen5Campaign(provider: ethers.JsonRpcProvider, chainId: number, campaign: string): Promise<boolean> {
  try {
    const info = await resolveCampaignGeneration(pool, provider, chainId, campaign);
    return info.gen5;
  } catch (error: any) {
    console.warn("[wtr] campaign generation unresolved; using the CampaignFinalized handoff", {
      chainId,
      campaign,
      error: error?.shortMessage || error?.message || String(error),
    });
    return false;
  }
}

/** The Graduated row the campaign scan already stored (evm_campaign_events), if any. */
async function storedGen5Graduated(chainId: number, campaign: string): Promise<StoredGraduated | null> {
  try {
    const r = await pool.query(
      `select tx_hash, block_number, block_time, args
         from public.evm_campaign_events
        where chain_id=$1 and campaign_address=$2 and contract_kind='campaign' and event_name='Graduated'
        order by block_number desc, log_index desc
        limit 1`,
      [chainId, campaign],
    );
    return storedGraduatedFromRow(r.rows[0]);
  } catch {
    // Table absent (migration not applied yet): fall back to the log search.
    return null;
  }
}

async function reconcileGen5Candidate(
  provider: ethers.JsonRpcProvider,
  chainId: number,
  candidate: Candidate,
  finalizedHead: number,
): Promise<"skipped" | "not_launched" | "cooldown" | "pending" | "reconciled"> {
  let graduated = await storedGen5Graduated(chainId, candidate.campaignAddress);
  if (!graduated) {
    if (isInScanCooldown(chainId, candidate.campaignAddress) && candidate.graduatedBlock == null) {
      return "cooldown";
    }
    const log = await findGraduationLog(provider, candidate, finalizedHead, GEN5_GRADUATED_TOPIC);
    if (!log) {
      markScanCooldown(chainId, candidate.campaignAddress);
      await noteMissingGraduationLog(chainId, candidate);
      console.log("[wtr] gen-5 Graduated log not in window (cooldown applied)", {
        chainId,
        campaign: candidate.campaignAddress,
        createdBlock: candidate.createdBlock,
      });
      return "pending";
    }
    const parsed = GEN5_CAMPAIGN_IFACE.parseLog(log);
    if (!parsed || parsed.name !== "Graduated") {
      throw new Error(`Unable to decode Graduated for ${candidate.campaignAddress}`);
    }
    graduated = { txHash: log.transactionHash.toLowerCase(), blockNumber: log.blockNumber, blockTime: null, args: parsed.args as any };
  }

  let blockTime = graduated.blockTime;
  if (!blockTime) {
    const block = await provider.getBlock(graduated.blockNumber);
    blockTime = new Date(Number(block?.timestamp || 0) * 1000);
  }
  const result = await reconcileGen5GraduationHandoff({
    provider,
    chainId,
    campaignAddress: candidate.campaignAddress,
    txHash: graduated.txHash,
    blockNumber: graduated.blockNumber,
    blockTime,
    args: graduated.args,
  });

  clearScanCooldown(chainId, candidate.campaignAddress);
  await publishStageChange({
    chainId,
    campaignAddress: candidate.campaignAddress,
    from: candidate.marketStage,
    to: result.marketStage,
    blockNumber: graduated.blockNumber,
    txHash: graduated.txHash,
    reason: result.reason,
  });
  console.log("[wtr] gen-5 graduation reconciled", result);
  return "reconciled";
}

async function reconcileCandidate(
  provider: ethers.JsonRpcProvider,
  chainId: number,
  candidate: Candidate,
  finalizedHead: number,
): Promise<"skipped" | "not_launched" | "cooldown" | "pending" | "reconciled"> {
  if (!ethers.isAddress(candidate.campaignAddress)) return "skipped";

  const campaign = new ethers.Contract(candidate.campaignAddress, LAUNCH_CAMPAIGN_ABI, provider) as any;
  let launched = false;
  try {
    launched = Boolean(await campaign.launched());
  } catch (error: any) {
    console.warn("[wtr] launched() read failed", {
      chainId,
      campaign: candidate.campaignAddress,
      error: error?.shortMessage || error?.message || String(error),
    });
    return "skipped";
  }
  if (!launched) return "not_launched";

  // Launch generation (campaign 5): hands off from Graduated, not CampaignFinalized. The old
  // generation never reaches this branch (E14).
  if (await isGen5Campaign(provider, chainId, candidate.campaignAddress)) {
    return reconcileGen5Candidate(provider, chainId, candidate, finalizedHead);
  }

  // Cheap eth_call only above; expensive getLogs behind cooldown after misses.
  if (isInScanCooldown(chainId, candidate.campaignAddress) && candidate.graduatedBlock == null) {
    return "cooldown";
  }

  const searchWindow = graduationLogSearchWindow({
    finalizedHead,
    createdBlock: candidate.createdBlock,
    graduatedBlock: candidate.graduatedBlock,
    lookbackBlocks: ENV.GRADUATION_LOG_LOOKBACK_BLOCKS,
    unknownCreatedLookbackBlocks: ENV.GRADUATION_UNKNOWN_CREATED_LOOKBACK_BLOCKS,
    logChunkSize: ENV.LOG_CHUNK_SIZE,
  });

  const log = await findGraduationLog(provider, candidate, finalizedHead);
  if (!log) {
    markScanCooldown(chainId, candidate.campaignAddress);
    await noteMissingGraduationLog(chainId, candidate);
    console.log("[wtr] graduation log not in window (cooldown applied)", {
      chainId,
      campaign: candidate.campaignAddress,
      mode: searchWindow.mode,
      fromBlock: searchWindow.fromBlock,
      toBlock: searchWindow.toBlock,
      estimatedChunks: searchWindow.estimatedChunks,
      createdBlock: candidate.createdBlock,
      cooldownMs: ENV.GRADUATION_SCAN_COOLDOWN_MS,
    });
    return "pending";
  }

  const iface = new ethers.Interface(LAUNCH_CAMPAIGN_ABI);
  const parsed = iface.parseLog(log);
  if (!parsed || parsed.name !== "CampaignFinalized") {
    throw new Error(`Unable to decode CampaignFinalized for ${candidate.campaignAddress}`);
  }

  const block = await provider.getBlock(log.blockNumber);
  const blockTime = new Date(Number(block?.timestamp || 0) * 1000);
  const result = await reconcileGraduationHandoff({
    provider,
    chainId,
    campaignAddress: candidate.campaignAddress,
    txHash: log.transactionHash,
    blockNumber: log.blockNumber,
    blockTime,
    args: parsed.args,
  });

  clearScanCooldown(chainId, candidate.campaignAddress);

  await publishStageChange({
    chainId,
    campaignAddress: candidate.campaignAddress,
    from: candidate.marketStage,
    to: result.marketStage,
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
    reason: result.reason,
  });

  console.log("[wtr] graduation reconciled", result);
  return "reconciled";
}

export async function runGraduationReconcilerOnce() {
  if (!ENV.ENABLE_GRADUATION_HANDOFF_RECONCILER) {
    return { enabled: false, scanned: 0, reconciled: 0, pending: 0, cooldown: 0, errors: 0 };
  }

  let scanned = 0;
  let reconciled = 0;
  let pending = 0;
  let cooldown = 0;
  let errors = 0;

  for (const config of chainConfigs()) {
    let provider: ethers.JsonRpcProvider | null = null;
    try {
      const working = await createWorkingProvider(config.rpcUrls, config.chainId, {
        label: `graduation-reconciler chain ${config.chainId}`,
        timeoutMs: ENV.RPC_REQUEST_TIMEOUT_MS,
      });
      provider = working.provider;
      console.log("[wtr] graduation reconciler RPC", {
        chainId: config.chainId,
        url: maskRpcUrl(working.url),
        headBlock: working.headBlock,
        lookbackBlocks: ENV.GRADUATION_LOG_LOOKBACK_BLOCKS,
        unknownCreatedLookback: ENV.GRADUATION_UNKNOWN_CREATED_LOOKBACK_BLOCKS,
      });
      const finalizedHead = Math.max(0, working.headBlock - Math.max(0, ENV.CONFIRMATIONS));
      const candidates = await listCandidates(config.chainId);
      for (const candidate of candidates) {
        scanned += 1;
        try {
          const outcome = await reconcileCandidate(provider, config.chainId, candidate, finalizedHead);
          if (outcome === "reconciled") reconciled += 1;
          else if (outcome === "pending") pending += 1;
          else if (outcome === "cooldown") cooldown += 1;
        } catch (error: any) {
          errors += 1;
          markScanCooldown(config.chainId, candidate.campaignAddress);
          console.error("[wtr] graduation reconciliation failed", {
            chainId: config.chainId,
            campaign: candidate.campaignAddress,
            error: error?.shortMessage || error?.message || String(error),
          });
        }
      }
    } catch (error: any) {
      errors += 1;
      console.error("[wtr] graduation reconciler RPC unavailable", {
        chainId: config.chainId,
        error: error?.shortMessage || error?.message || String(error),
      });
    } finally {
      provider?.destroy();
    }
  }

  return { enabled: true, scanned, reconciled, pending, cooldown, errors };
}

export function startGraduationReconcilerLoop() {
  if (!ENV.ENABLE_GRADUATION_HANDOFF_RECONCILER || globalState[LOOP_SYMBOL]) return;
  globalState[LOOP_SYMBOL] = true;

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runGraduationReconcilerOnce();
      if (result.scanned || result.errors || result.reconciled || result.pending) {
        console.log("[wtr] graduation reconciliation pass", result);
      }
    } catch (error: any) {
      console.error("[wtr] graduation reconciler loop failed", error?.message || String(error));
    } finally {
      running = false;
    }
  };

  const initial = setTimeout(() => void tick(), 2_000);
  initial.unref?.();
  const timer = setInterval(() => void tick(), Math.max(5_000, ENV.GRADUATION_HANDOFF_INTERVAL_MS));
  timer.unref?.();
}
