import { ethers } from "ethers";
import { pool } from "./db.js";
import { ENV } from "./env.js";
import {
  CAMPAIGN_CREATED_EVENT_LEGACY,
  CAMPAIGN_CREATED_EVENT_V2,
  CAMPAIGN_CREATED_EVENT_V3,
  LAUNCH_FACTORY_ABI,
  LEGACY_LAUNCH_FACTORY_ABI,
} from "./abis.js";
import { buildFactoryInventory, type SupportedFactory } from "./factoryInventory.js";
import { createStaticJsonRpcProvider, parseRpcList } from "./rpcProvider.js";
import { notifyCampaignCreated } from "./campaignLifecycleNotifications.js";

const CURRENT_FACTORY_IFACE = new ethers.Interface(LAUNCH_FACTORY_ABI);
const LEGACY_FACTORY_IFACE = new ethers.Interface(LEGACY_LAUNCH_FACTORY_ABI);
const FACTORY_COUNT_ABI = ["function campaignsCount() view returns (uint256)"] as const;
const MIN_PLAUSIBLE_CHAIN_TIMESTAMP = 1_577_836_800; // 2020-01-01 UTC
const MAX_FUTURE_TIMESTAMP_SKEW = 24 * 60 * 60;

type RegistryCampaign = {
  campaign: string;
  token: string;
  creator: string;
  name: string;
  symbol: string;
  logoURI: string | null;
  createdAtSeconds: number;
};

type CampaignEventVariant = {
  iface: ethers.Interface;
  topicHash: string;
};

const CAMPAIGN_EVENT_VARIANTS: CampaignEventVariant[] = [
  CAMPAIGN_CREATED_EVENT_V3,
  CAMPAIGN_CREATED_EVENT_V2,
  CAMPAIGN_CREATED_EVENT_LEGACY,
].map((eventAbi) => {
  const iface = new ethers.Interface([eventAbi]);
  const fragment = iface.getEvent("CampaignCreated");
  if (!fragment) throw new Error(`Invalid CampaignCreated event ABI: ${eventAbi}`);
  return { iface, topicHash: fragment.topicHash };
});

const CAMPAIGN_EVENT_BY_TOPIC = new Map(
  CAMPAIGN_EVENT_VARIANTS.map((variant) => [variant.topicHash.toLowerCase(), variant]),
);

function inventories(): SupportedFactory[] {
  const includeTestnet =
    Number(ENV.DEFAULT_EVM_CHAIN_ID) === 97 ||
    ["1", "true", "yes", "on"].includes(String(process.env.VITE_ENABLE_TESTNET_CAMPAIGNS || process.env.ENABLE_TESTNET_CAMPAIGNS || "").trim().toLowerCase());
  return [
    ...(includeTestnet
      ? buildFactoryInventory({
          chainId: 97,
          rpcHttp: ENV.BSC_RPC_HTTP_97,
          activeFactoryAddress: ENV.FACTORY_ADDRESS_97,
          activeFactoryStartBlock: ENV.FACTORY_START_BLOCK_97,
          supportedFactoryAddresses: ENV.SUPPORTED_FACTORY_ADDRESSES_97,
          supportedFactoryStartBlocks: ENV.SUPPORTED_FACTORY_START_BLOCKS_97,
        })
      : []),
    ...(ENV.BSC_RPC_HTTP_56
      ? buildFactoryInventory({
          chainId: 56,
          rpcHttp: ENV.BSC_RPC_HTTP_56,
          activeFactoryAddress: ENV.FACTORY_ADDRESS_56,
          activeFactoryStartBlock: ENV.FACTORY_START_BLOCK_56,
          supportedFactoryAddresses: ENV.SUPPORTED_FACTORY_ADDRESSES_56,
          supportedFactoryStartBlocks: ENV.SUPPORTED_FACTORY_START_BLOCKS_56,
        })
      : []),
  ];
}

function plausibleTimestamp(value: unknown): number {
  const timestamp = Number(value ?? 0);
  const max = Math.floor(Date.now() / 1000) + MAX_FUTURE_TIMESTAMP_SKEW;
  return Number.isFinite(timestamp) && timestamp >= MIN_PLAUSIBLE_CHAIN_TIMESTAMP && timestamp <= max
    ? Math.floor(timestamp)
    : 0;
}

function decodeRegistryCandidate(
  iface: ethers.Interface,
  rawResult: string,
  createdAtIndex: number,
): RegistryCampaign | null {
  try {
    const decoded = iface.decodeFunctionResult("getCampaign", rawResult);
    const info: any = decoded?.[0];
    const campaign = String(info?.campaign ?? info?.[0] ?? "");
    const token = String(info?.token ?? info?.[1] ?? "");
    const creator = String(info?.creator ?? info?.[2] ?? "");
    if (!ethers.isAddress(campaign) || campaign === ethers.ZeroAddress) return null;
    if (!ethers.isAddress(token) || token === ethers.ZeroAddress) return null;
    if (!ethers.isAddress(creator) || creator === ethers.ZeroAddress) return null;

    return {
      campaign,
      token,
      creator,
      name: String(info?.name ?? info?.[3] ?? ""),
      symbol: String(info?.symbol ?? info?.[4] ?? ""),
      logoURI: String(info?.logoURI ?? info?.logoUri ?? info?.[5] ?? "") || null,
      createdAtSeconds: plausibleTimestamp(info?.createdAt ?? info?.[createdAtIndex]),
    };
  } catch {
    return null;
  }
}

async function readRegistryCampaign(
  provider: ethers.JsonRpcProvider,
  factory: SupportedFactory,
  id: number,
): Promise<RegistryCampaign | null> {
  const callData = CURRENT_FACTORY_IFACE.encodeFunctionData("getCampaign", [id]);
  const rawResult = await provider.call({ to: factory.address, data: callData });

  const current = decodeRegistryCandidate(CURRENT_FACTORY_IFACE, rawResult, 10);
  const legacy = decodeRegistryCandidate(LEGACY_FACTORY_IFACE, rawResult, 9);

  // Prefer the layout that produces a real chain timestamp. The old ten-field
  // decoder can otherwise interpret a dynamic-string offset (for metadataURI or
  // extraLink) as a tiny uint64 timestamp, which produced 1970 dates in the DB.
  if (current?.createdAtSeconds) return current;
  if (legacy?.createdAtSeconds) return legacy;
  return current || legacy;
}

async function getCursor(factory: SupportedFactory): Promise<number> {
  const result = await pool.query(
    `select last_indexed_block from public.indexer_state where chain_id=$1 and cursor=$2`,
    [factory.chainId, factory.cursor],
  );
  return result.rowCount ? Number(result.rows[0].last_indexed_block || 0) : 0;
}

async function advanceCursor(factory: SupportedFactory, nextBlock: number): Promise<void> {
  await pool.query(
    `insert into public.indexer_state(chain_id,cursor,last_indexed_block)
     values($1,$2,$3)
     on conflict (chain_id,cursor) do update
       set last_indexed_block=greatest(public.indexer_state.last_indexed_block, excluded.last_indexed_block),
           updated_at=now()`,
    [factory.chainId, factory.cursor, nextBlock],
  );
}

async function upsertCampaign(input: {
  factory: SupportedFactory;
  campaign: string;
  token: string;
  creator: string;
  name: string;
  symbol: string;
  logoURI?: string | null;
  createdBlock?: number;
  createdAt?: Date | null;
}): Promise<void> {
  await pool.query(
    `insert into public.campaigns(
       chain_id,factory_address,campaign_address,token_address,creator_address,
       name,symbol,logo_uri,created_block,created_at_chain,is_active
     ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)
     on conflict (chain_id,campaign_address) do update set
       factory_address=coalesce(public.campaigns.factory_address, excluded.factory_address),
       token_address=coalesce(excluded.token_address, public.campaigns.token_address),
       creator_address=coalesce(excluded.creator_address, public.campaigns.creator_address),
       name=coalesce(nullif(excluded.name,''), public.campaigns.name),
       symbol=coalesce(nullif(excluded.symbol,''), public.campaigns.symbol),
       logo_uri=coalesce(nullif(public.campaigns.logo_uri,''), nullif(excluded.logo_uri,'')),
       created_block=case
         when coalesce(public.campaigns.created_block,0)=0 then excluded.created_block
         else public.campaigns.created_block
       end,
       created_at_chain=case
         when excluded.created_at_chain is null then public.campaigns.created_at_chain
         when public.campaigns.created_at_chain is null
           or public.campaigns.created_at_chain < to_timestamp(${MIN_PLAUSIBLE_CHAIN_TIMESTAMP})
           then excluded.created_at_chain
         else public.campaigns.created_at_chain
       end,
       is_active=true,
       updated_at=now()`,
    [
      input.factory.chainId,
      input.factory.address,
      input.campaign.toLowerCase(),
      input.token.toLowerCase(),
      input.creator.toLowerCase(),
      input.name,
      input.symbol,
      input.logoURI || null,
      Number(input.createdBlock || 0),
      input.createdAt || null,
    ],
  );
  await notifyCampaignCreated(pool, {
    chainId: input.factory.chainId,
    campaignAddress: input.campaign,
    name: input.name,
    ticker: input.symbol,
    imageUrl: input.logoURI,
    creatorWallet: input.creator,
  });
}

async function syncRegistry(provider: ethers.JsonRpcProvider, factory: SupportedFactory): Promise<void> {
  const contract = new ethers.Contract(factory.address, FACTORY_COUNT_ABI, provider);
  const count = Number((await contract.campaignsCount()) as bigint);
  if (!Number.isFinite(count) || count <= 0) return;

  for (let id = 0; id < count; id += 1) {
    let info: RegistryCampaign | null = null;
    try {
      info = await readRegistryCampaign(provider, factory, id);
    } catch (error) {
      console.warn("[factory-discovery] getCampaign failed", {
        chainId: factory.chainId,
        factory: factory.address,
        id,
        error: String((error as any)?.message || error),
      });
      continue;
    }

    if (!info) continue;
    await upsertCampaign({
      factory,
      campaign: info.campaign,
      token: info.token,
      creator: info.creator,
      name: info.name,
      symbol: info.symbol,
      logoURI: info.logoURI,
      createdAt: info.createdAtSeconds > 0 ? new Date(info.createdAtSeconds * 1000) : null,
    });
  }
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
  filter: ethers.Filter,
  fromBlock: number,
  toBlock: number,
  depth = 0,
): Promise<ethers.Log[]> {
  try {
    if (ENV.INDEXER_LOG_CALL_DELAY_MS > 0) {
      await sleep(ENV.INDEXER_LOG_CALL_DELAY_MS);
    }
    return await provider.getLogs({ ...filter, fromBlock, toBlock });
  } catch (error) {
    const span = toBlock - fromBlock + 1;
    const minSpan = Math.max(1, ENV.MIN_LOG_CHUNK_SIZE);

    // Free RPCs often time out under concurrent load. Wait + shrink range instead of
    // immediately bisecting into a stampede of smaller calls on the same second.
    if (isTimeoutError(error) && depth < 6) {
      await sleep(1_000 + depth * 750);
      if (span > minSpan) {
        const middle = Math.floor((fromBlock + toBlock) / 2);
        const left = await getLogsAdaptive(provider, filter, fromBlock, middle, depth + 1);
        const right = await getLogsAdaptive(provider, filter, middle + 1, toBlock, depth + 1);
        return left.concat(right);
      }
      return getLogsAdaptive(provider, filter, fromBlock, toBlock, depth + 1);
    }

    if (span <= minSpan || depth >= 12) throw error;
    const middle = Math.floor((fromBlock + toBlock) / 2);
    const left = await getLogsAdaptive(provider, filter, fromBlock, middle, depth + 1);
    const right = await getLogsAdaptive(provider, filter, middle + 1, toBlock, depth + 1);
    return left.concat(right);
  }
}

async function scanEvents(provider: ethers.JsonRpcProvider, factory: SupportedFactory): Promise<void> {
  const head = Math.max(0, (await provider.getBlockNumber()) - ENV.CONFIRMATIONS);
  const state = await getCursor(factory);
  const fallback = Math.max(0, head - ENV.FACTORY_LOOKBACK_BLOCKS);
  let fromBlock = state > 0 ? state : factory.startBlock > 0 ? factory.startBlock : fallback;
  if (fromBlock > head) return;

  const eventTopics = CAMPAIGN_EVENT_VARIANTS.map((variant) => variant.topicHash);
  const blockTimeCache = new Map<number, Date | null>();

  for (; fromBlock <= head; fromBlock += ENV.LOG_CHUNK_SIZE) {
    const toBlock = Math.min(head, fromBlock + ENV.LOG_CHUNK_SIZE - 1);
    const logs = await getLogsAdaptive(
      provider,
      { address: factory.address, topics: [eventTopics] },
      fromBlock,
      toBlock,
    );

    for (const log of logs) {
      const variant = CAMPAIGN_EVENT_BY_TOPIC.get(String(log.topics?.[0] || "").toLowerCase());
      if (!variant) continue;
      const parsed = variant.iface.parseLog(log);
      if (!parsed) continue;

      let createdAt = blockTimeCache.get(log.blockNumber);
      if (createdAt === undefined) {
        const block = await provider.getBlock(log.blockNumber);
        createdAt = block ? new Date(Number(block.timestamp) * 1000) : null;
        blockTimeCache.set(log.blockNumber, createdAt);
      }

      const args: any = parsed.args;
      await upsertCampaign({
        factory,
        campaign: String(args.campaign),
        token: String(args.token),
        creator: String(args.creator),
        name: String(args.name),
        symbol: String(args.symbol),
        logoURI: String(args.logoURI ?? "") || null,
        createdBlock: log.blockNumber,
        createdAt,
      });
    }

    await advanceCursor(factory, toBlock + 1);
  }
}

async function runFactory(factory: SupportedFactory): Promise<void> {
  const rpcUrls = parseRpcList(factory.rpcHttp);
  if (rpcUrls.length === 0) throw new Error(`No RPC configured for chain ${factory.chainId}`);

  let lastError: unknown;
  for (const rpcUrl of rpcUrls) {
    const provider = createStaticJsonRpcProvider(rpcUrl, factory.chainId, {
      timeoutMs: ENV.RPC_REQUEST_TIMEOUT_MS,
    });
    try {
      const code = await provider.getCode(factory.address);
      if (code === "0x") throw new Error(`No contract code at ${factory.address}`);
      await syncRegistry(provider, factory);
      await scanEvents(provider, factory);
      return;
    } catch (error) {
      lastError = error;
      console.warn("[factory-discovery] RPC failed", {
        chainId: factory.chainId,
        factory: factory.address,
        rpcUrl: rpcUrl.replace(/\/[a-f0-9]{16,}/i, "/…"),
        error: String((error as any)?.shortMessage || (error as any)?.message || error),
      });
      // Brief pause before next URL / factory so free tiers can recover.
      await sleep(750);
    }
  }
  throw lastError;
}

export async function runSupportedFactoryDiscoveryOnce(): Promise<void> {
  const factories = inventories();
  for (const factory of factories) {
    try {
      await runFactory(factory);
    } catch (error) {
      console.error("[factory-discovery] all RPCs failed", {
        chainId: factory.chainId,
        factory: factory.address,
        cursor: factory.cursor,
        error: String((error as any)?.shortMessage || (error as any)?.message || error),
      });
    }
    // Serialize factories with breathing room — concurrent free-tier getLogs thrashes RPS.
    await sleep(Math.max(250, ENV.INDEXER_LOG_CALL_DELAY_MS));
  }
}

export function startSupportedFactoryDiscoveryLoop(): void {
  let running = false;
  const intervalMs = Math.max(15_000, ENV.FACTORY_DISCOVERY_INTERVAL_MS);
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await runSupportedFactoryDiscoveryOnce();
    } finally {
      running = false;
    }
  };

  void run();
  setInterval(() => void run(), intervalMs);
  console.log("[factory-discovery] loop started", { intervalMs });
}
