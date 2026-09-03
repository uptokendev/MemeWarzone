import { ethers } from "ethers";
import { pool } from "./db.js";
import { ENV } from "./env.js";
import {
  CAMPAIGN_CREATED_EVENT_LEGACY,
  CAMPAIGN_CREATED_EVENT_V2,
  CAMPAIGN_CREATED_EVENT_V3,
  LAUNCH_CAMPAIGN_ABI,
  LAUNCH_FACTORY_ABI,
  LEGACY_LAUNCH_FACTORY_ABI,
} from "./abis.js";
import { buildFactoryInventory, type SupportedFactory } from "./factoryInventory.js";
import { createStaticJsonRpcProvider, parseRpcList } from "./rpcProvider.js";
import { TIMEFRAMES, bucketStart, type TF } from "./timeframes.js";

const CHAIN_ID = 46630;
const CURSOR_PREFIX = "robinhood-local";
const POLL_MS = Math.max(2_000, Number(process.env.ROBINHOOD_LOCAL_SCANNER_INTERVAL_MS || 5_000));
const CURRENT_FACTORY_IFACE = new ethers.Interface(LAUNCH_FACTORY_ABI);
const LEGACY_FACTORY_IFACE = new ethers.Interface(LEGACY_LAUNCH_FACTORY_ABI);
const CAMPAIGN_IFACE = new ethers.Interface(LAUNCH_CAMPAIGN_ABI);
const FACTORY_COUNT_ABI = ["function campaignsCount() view returns (uint256)"] as const;

const CREATED_VARIANTS = [
  CAMPAIGN_CREATED_EVENT_V3,
  CAMPAIGN_CREATED_EVENT_V2,
  CAMPAIGN_CREATED_EVENT_LEGACY,
].map((abi) => {
  const iface = new ethers.Interface([abi]);
  const fragment = iface.getEvent("CampaignCreated");
  if (!fragment) throw new Error(`Invalid CampaignCreated ABI: ${abi}`);
  return { iface, topicHash: fragment.topicHash };
});
const CREATED_BY_TOPIC = new Map(CREATED_VARIANTS.map((entry) => [entry.topicHash.toLowerCase(), entry]));

function requireEventTopic(iface: ethers.Interface, eventName: string): string {
  const fragment = iface.getEvent(eventName);
  if (!fragment) {
    throw new Error(`Robinhood local scanner could not resolve ${eventName} event topic`);
  }
  return fragment.topicHash;
}

const PURCHASED_TOPIC = requireEventTopic(CAMPAIGN_IFACE, "TokensPurchased");
const SOLD_TOPIC = requireEventTopic(CAMPAIGN_IFACE, "TokensSold");
const FINALIZED_TOPIC = requireEventTopic(CAMPAIGN_IFACE, "CampaignFinalized");

function runtimeIsLocal(): boolean {
  return String(process.env.RUNTIME_ENVIRONMENT || process.env.VITE_RUNTIME_ENVIRONMENT || "")
    .trim()
    .toLowerCase() === "local";
}

function assertIsolation(): void {
  if (!runtimeIsLocal()) {
    throw new Error("Robinhood local scanner refuses to run outside RUNTIME_ENVIRONMENT=local");
  }
  if (ENV.DEFAULT_EVM_CHAIN_ID !== CHAIN_ID) {
    throw new Error(`Robinhood local scanner requires DEFAULT_EVM_CHAIN_ID=${CHAIN_ID}`);
  }
  const active = [...ENV.EVM_INDEXER_CHAIN_IDS].sort((a, b) => a - b);
  if (active.length !== 1 || active[0] !== CHAIN_ID) {
    throw new Error(`Robinhood local scanner requires EVM_INDEXER_CHAIN_IDS=${CHAIN_ID} only`);
  }
  if (ENV.BSC_RPC_HTTP_56 || ENV.BSC_RPC_HTTP_97 || ENV.SOLANA_RPC_HTTP) {
    throw new Error("Robinhood local scanner refuses to start while BNB or Solana RPCs are configured");
  }
  const dbUrl = new URL(ENV.DATABASE_URL);
  const localHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (!localHosts.has(dbUrl.hostname.toLowerCase())) {
    throw new Error(`Robinhood local scanner requires a loopback PostgreSQL host; got ${dbUrl.hostname}`);
  }
  const dbName = decodeURIComponent(dbUrl.pathname.replace(/^\//, "")).toLowerCase();
  if (!dbName.includes("robinhood") && !dbName.includes("local")) {
    throw new Error(`Robinhood local scanner refuses shared database ${dbName}`);
  }
}

function factories(): SupportedFactory[] {
  return buildFactoryInventory({
    chainId: CHAIN_ID,
    rpcHttp: ENV.ROBINHOOD_RPC_HTTP_46630,
    activeFactoryAddress: ENV.FACTORY_ADDRESS_46630,
    activeFactoryStartBlock: ENV.FACTORY_START_BLOCK_46630,
    supportedFactoryAddresses: ENV.SUPPORTED_FACTORY_ADDRESSES_46630,
    supportedFactoryStartBlocks: ENV.SUPPORTED_FACTORY_START_BLOCKS_46630,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function cursorKey(kind: "factory" | "campaign", address: string): string {
  return `${CURSOR_PREFIX}:${kind}:${address.toLowerCase()}`;
}

async function getCursor(kind: "factory" | "campaign", address: string): Promise<number> {
  const result = await pool.query(
    `select last_indexed_block from public.indexer_state where chain_id=$1 and cursor=$2`,
    [CHAIN_ID, cursorKey(kind, address)],
  );
  return result.rowCount ? Number(result.rows[0].last_indexed_block || 0) : 0;
}

async function setCursor(kind: "factory" | "campaign", address: string, nextBlock: number): Promise<void> {
  await pool.query(
    `insert into public.indexer_state(chain_id,cursor,last_indexed_block)
     values($1,$2,$3)
     on conflict(chain_id,cursor) do update
       set last_indexed_block=greatest(public.indexer_state.last_indexed_block, excluded.last_indexed_block),
           updated_at=now()`,
    [CHAIN_ID, cursorKey(kind, address), nextBlock],
  );
}

async function blockTime(provider: ethers.JsonRpcProvider, blockNumber: number): Promise<Date> {
  const block = await provider.getBlock(blockNumber);
  if (!block) throw new Error(`Robinhood block ${blockNumber} was not found`);
  return new Date(Number(block.timestamp) * 1_000);
}

async function upsertCampaign(input: {
  factoryAddress: string;
  campaign: string;
  token: string;
  creator: string;
  name: string;
  symbol: string;
  logoURI?: string | null;
  createdBlock: number;
  createdAt: Date | null;
}): Promise<void> {
  await pool.query(
    `insert into public.campaigns(
       chain_id,factory_address,campaign_address,token_address,creator_address,
       name,symbol,logo_uri,created_block,created_at_chain,is_active
     ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)
     on conflict(chain_id,campaign_address) do update set
       factory_address=coalesce(public.campaigns.factory_address, excluded.factory_address),
       token_address=coalesce(excluded.token_address, public.campaigns.token_address),
       creator_address=coalesce(excluded.creator_address, public.campaigns.creator_address),
       name=coalesce(nullif(excluded.name,''), public.campaigns.name),
       symbol=coalesce(nullif(excluded.symbol,''), public.campaigns.symbol),
       logo_uri=coalesce(nullif(public.campaigns.logo_uri,''), nullif(excluded.logo_uri,'')),
       created_block=case when coalesce(public.campaigns.created_block,0)=0 then excluded.created_block else public.campaigns.created_block end,
       created_at_chain=coalesce(public.campaigns.created_at_chain, excluded.created_at_chain),
       is_active=true,
       updated_at=now()`,
    [
      CHAIN_ID,
      input.factoryAddress.toLowerCase(),
      input.campaign.toLowerCase(),
      input.token.toLowerCase(),
      input.creator.toLowerCase(),
      input.name,
      input.symbol,
      input.logoURI || null,
      input.createdBlock,
      input.createdAt,
    ],
  );
}

function decodeRegistryCandidate(iface: ethers.Interface, raw: string, createdAtIndex: number) {
  try {
    const decoded = iface.decodeFunctionResult("getCampaign", raw);
    const info: any = decoded?.[0];
    const campaign = String(info?.campaign ?? info?.[0] ?? "");
    const token = String(info?.token ?? info?.[1] ?? "");
    const creator = String(info?.creator ?? info?.[2] ?? "");
    if (!ethers.isAddress(campaign) || !ethers.isAddress(token) || !ethers.isAddress(creator)) return null;
    const createdAtSeconds = Number(info?.createdAt ?? info?.[createdAtIndex] ?? 0);
    return {
      campaign,
      token,
      creator,
      name: String(info?.name ?? info?.[3] ?? ""),
      symbol: String(info?.symbol ?? info?.[4] ?? ""),
      logoURI: String(info?.logoURI ?? info?.[5] ?? "") || null,
      createdAtSeconds: Number.isFinite(createdAtSeconds) && createdAtSeconds > 1_500_000_000 ? createdAtSeconds : 0,
    };
  } catch {
    return null;
  }
}

async function syncFactoryRegistry(provider: ethers.JsonRpcProvider, factory: SupportedFactory): Promise<void> {
  const contract = new ethers.Contract(factory.address, FACTORY_COUNT_ABI, provider);
  const count = Number((await contract.campaignsCount()) as bigint);
  if (!Number.isInteger(count) || count <= 0) return;

  for (let id = 0; id < count; id += 1) {
    const callData = CURRENT_FACTORY_IFACE.encodeFunctionData("getCampaign", [id]);
    let raw: string;
    try {
      raw = await provider.call({ to: factory.address, data: callData });
    } catch (error) {
      console.warn("[robinhood-scanner] getCampaign failed", { id, error: String((error as any)?.message || error) });
      continue;
    }
    const current = decodeRegistryCandidate(CURRENT_FACTORY_IFACE, raw, 10);
    const legacy = decodeRegistryCandidate(LEGACY_FACTORY_IFACE, raw, 9);
    const info = (current?.createdAtSeconds ? current : legacy?.createdAtSeconds ? legacy : current || legacy);
    if (!info) continue;
    await upsertCampaign({
      factoryAddress: factory.address,
      campaign: info.campaign,
      token: info.token,
      creator: info.creator,
      name: info.name,
      symbol: info.symbol,
      logoURI: info.logoURI,
      createdBlock: 0,
      createdAt: info.createdAtSeconds ? new Date(info.createdAtSeconds * 1_000) : null,
    });
  }
}

async function scanFactoryEvents(provider: ethers.JsonRpcProvider, factory: SupportedFactory, head: number): Promise<void> {
  const current = await getCursor("factory", factory.address);
  const fallback = Math.max(0, head - ENV.FACTORY_LOOKBACK_BLOCKS);
  let from = current > 0 ? current : factory.startBlock > 0 ? factory.startBlock : fallback;
  if (from > head) return;

  const topics = CREATED_VARIANTS.map((entry) => entry.topicHash);
  for (; from <= head; from += ENV.LOG_CHUNK_SIZE) {
    const to = Math.min(head, from + ENV.LOG_CHUNK_SIZE - 1);
    const logs = await provider.getLogs({ address: factory.address, topics: [topics], fromBlock: from, toBlock: to });
    for (const log of logs) {
      const variant = CREATED_BY_TOPIC.get(String(log.topics[0] || "").toLowerCase());
      const parsed = variant?.iface.parseLog(log);
      if (!parsed) continue;
      const args: any = parsed.args;
      await upsertCampaign({
        factoryAddress: factory.address,
        campaign: String(args.campaign),
        token: String(args.token),
        creator: String(args.creator),
        name: String(args.name),
        symbol: String(args.symbol),
        logoURI: String(args.logoURI ?? "") || null,
        createdBlock: log.blockNumber,
        createdAt: await blockTime(provider, log.blockNumber),
      });
    }
    await setCursor("factory", factory.address, to + 1);
  }
}

async function writeCandle(campaign: string, blockDate: Date, price: number, nativeAmount: number): Promise<void> {
  const timestamp = Math.floor(blockDate.getTime() / 1_000);
  for (const tf of TIMEFRAMES as TF[]) {
    const bucket = new Date(bucketStart(timestamp, tf) * 1_000);
    await pool.query(
      `insert into public.token_candles(
         chain_id,campaign_address,timeframe,bucket_start,o,h,l,c,volume_bnb,trades_count,
         source_mask,bonding_trade_count,bonding_volume_bnb,last_block_number,last_log_index
       ) values($1,$2,$3,$4,$5,$5,$5,$5,$6,1,1,1,$6,null,null)
       on conflict(chain_id,campaign_address,timeframe,bucket_start) do update set
         h=greatest(public.token_candles.h, excluded.h),
         l=least(public.token_candles.l, excluded.l),
         c=excluded.c,
         volume_bnb=public.token_candles.volume_bnb + excluded.volume_bnb,
         trades_count=public.token_candles.trades_count + 1,
         source_mask=(public.token_candles.source_mask | 1),
         bonding_trade_count=public.token_candles.bonding_trade_count + 1,
         bonding_volume_bnb=public.token_candles.bonding_volume_bnb + excluded.bonding_volume_bnb,
         updated_at=now()`,
      [CHAIN_ID, campaign, tf, bucket, price, nativeAmount],
    );
  }
}

async function recordTrade(input: {
  campaign: string;
  token: string | null;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockDate: Date;
  side: "buy" | "sell";
  wallet: string;
  tokenRaw: bigint;
  nativeRaw: bigint;
}): Promise<void> {
  const tokenAmount = Number(ethers.formatUnits(input.tokenRaw, 18));
  const nativeAmount = Number(ethers.formatUnits(input.nativeRaw, 18));
  const price = tokenAmount > 0 ? nativeAmount / tokenAmount : 0;
  const campaign = input.campaign.toLowerCase();

  await pool.query(
    `insert into public.curve_trades(
       chain_id,campaign_address,tx_hash,log_index,block_number,block_time,side,wallet,
       token_amount_raw,bnb_amount_raw,token_amount,bnb_amount,price_bnb
     ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict(chain_id,tx_hash,log_index) do nothing`,
    [
      CHAIN_ID,
      campaign,
      input.txHash.toLowerCase(),
      input.logIndex,
      input.blockNumber,
      input.blockDate,
      input.side,
      input.wallet.toLowerCase(),
      input.tokenRaw.toString(),
      input.nativeRaw.toString(),
      tokenAmount,
      nativeAmount,
      price,
    ],
  );

  if (price > 0) {
    await writeCandle(campaign, input.blockDate, price, nativeAmount);
    await pool.query(
      `insert into public.token_stats(chain_id,campaign_address,last_price_bnb,vol_24h_bnb,updated_at)
       values($1,$2,$3,$4,now())
       on conflict(chain_id,campaign_address) do update set
         last_price_bnb=excluded.last_price_bnb,
         vol_24h_bnb=(
           select coalesce(sum(bnb_amount),0)
           from public.curve_trades
           where chain_id=$1 and campaign_address=$2 and block_time >= now() - interval '24 hours'
         ),
         updated_at=now()`,
      [CHAIN_ID, campaign, price, nativeAmount],
    );
  }

  await pool.query(
    `insert into public.activity_events(
       chain_id,event_type,tx_hash,log_index,block_number,block_time,actor_address,
       campaign_address,token_address,amount_in_wei,amount_out_wei,cost_wei,payout_wei,meta
     ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     on conflict(chain_id,tx_hash,log_index) do nothing`,
    [
      CHAIN_ID,
      input.side === "buy" ? "BUY" : "SELL",
      input.txHash.toLowerCase(),
      input.logIndex,
      input.blockNumber,
      input.blockDate,
      input.wallet.toLowerCase(),
      campaign,
      input.token?.toLowerCase() || null,
      input.side === "sell" ? input.tokenRaw.toString() : input.nativeRaw.toString(),
      input.side === "buy" ? input.tokenRaw.toString() : input.nativeRaw.toString(),
      input.side === "buy" ? input.nativeRaw.toString() : null,
      input.side === "sell" ? input.nativeRaw.toString() : null,
      JSON.stringify({ runtime: "robinhood-local", chainId: CHAIN_ID }),
    ],
  );
}

async function recordFinalization(campaign: string, token: string | null, log: ethers.Log, blockDate: Date): Promise<void> {
  const parsed = CAMPAIGN_IFACE.parseLog(log);
  const args: any = parsed?.args;
  if (!args) return;
  const pair = String(args.pair || "").toLowerCase();
  const normalized = campaign.toLowerCase();

  await pool.query(
    `update public.campaigns
       set is_active=false,
           bonding_active=false,
           graduated_at_chain=$3,
           graduated_block=$4,
           market_stage='GRADUATING',
           updated_at=now()
     where chain_id=$1 and campaign_address=$2`,
    [CHAIN_ID, normalized, blockDate, log.blockNumber],
  );

  if (token) {
    await pool.query(
      `insert into public.campaign_market_state(
         chain_id,campaign_address,token_address,market_stage,graduation_tx_hash,
         graduation_block,graduation_time,dex_pair_address,graduated_liquidity_token_raw,
         graduated_liquidity_bnb_raw,graduated_lp_raw,burned_unsold_token_raw,
         burned_unused_lp_token_raw,post_burn_total_supply_raw,final_curve_price_bnb,
         initial_dex_price_bnb,pool_verified,indexing_enabled
       ) values($1,$2,$3,'GRADUATING',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,false,true)
       on conflict(chain_id,campaign_address) do update set
         market_stage='GRADUATING',
         graduation_tx_hash=excluded.graduation_tx_hash,
         graduation_block=excluded.graduation_block,
         graduation_time=excluded.graduation_time,
         dex_pair_address=excluded.dex_pair_address,
         graduated_liquidity_token_raw=excluded.graduated_liquidity_token_raw,
         graduated_liquidity_bnb_raw=excluded.graduated_liquidity_bnb_raw,
         graduated_lp_raw=excluded.graduated_lp_raw,
         burned_unsold_token_raw=excluded.burned_unsold_token_raw,
         burned_unused_lp_token_raw=excluded.burned_unused_lp_token_raw,
         post_burn_total_supply_raw=excluded.post_burn_total_supply_raw,
         final_curve_price_bnb=excluded.final_curve_price_bnb,
         initial_dex_price_bnb=excluded.initial_dex_price_bnb,
         updated_at=now()`,
      [
        CHAIN_ID,
        normalized,
        token.toLowerCase(),
        log.transactionHash.toLowerCase(),
        log.blockNumber,
        blockDate,
        pair || null,
        String(args.liquidityTokens),
        String(args.liquidityBnb),
        String(args.liquidityLp),
        String(args.burnedUnsoldTokens),
        String(args.burnedUnusedLpTokens),
        String(args.postBurnTotalSupply),
        String(args.finalCurvePrice),
        String(args.initialDexPrice),
      ],
    );
  }
}

async function scanCampaign(provider: ethers.JsonRpcProvider, campaign: { campaign_address: string; token_address: string | null; created_block: string | number | null }, head: number): Promise<void> {
  const address = String(campaign.campaign_address).toLowerCase();
  const current = await getCursor("campaign", address);
  const created = Number(campaign.created_block || 0);
  const fallback = Math.max(0, head - ENV.INDEXER_TIP_SCAN_BLOCKS);
  let from = current > 0 ? current : created > 0 ? created : fallback;
  if (from > head) return;

  for (; from <= head; from += ENV.LOG_CHUNK_SIZE) {
    const to = Math.min(head, from + ENV.LOG_CHUNK_SIZE - 1);
    const logs = await provider.getLogs({
      address,
      topics: [[PURCHASED_TOPIC, SOLD_TOPIC, FINALIZED_TOPIC]],
      fromBlock: from,
      toBlock: to,
    });
    const times = new Map<number, Date>();
    for (const log of logs) {
      let date = times.get(log.blockNumber);
      if (!date) {
        date = await blockTime(provider, log.blockNumber);
        times.set(log.blockNumber, date);
      }
      const parsed = CAMPAIGN_IFACE.parseLog(log);
      if (!parsed) continue;
      if (parsed.name === "TokensPurchased") {
        await recordTrade({
          campaign: address,
          token: campaign.token_address,
          txHash: log.transactionHash,
          logIndex: log.index,
          blockNumber: log.blockNumber,
          blockDate: date,
          side: "buy",
          wallet: String(parsed.args.buyer),
          tokenRaw: BigInt(parsed.args.amountOut),
          nativeRaw: BigInt(parsed.args.cost),
        });
      } else if (parsed.name === "TokensSold") {
        await recordTrade({
          campaign: address,
          token: campaign.token_address,
          txHash: log.transactionHash,
          logIndex: log.index,
          blockNumber: log.blockNumber,
          blockDate: date,
          side: "sell",
          wallet: String(parsed.args.seller),
          tokenRaw: BigInt(parsed.args.amountIn),
          nativeRaw: BigInt(parsed.args.payout),
        });
      } else if (parsed.name === "CampaignFinalized") {
        await recordFinalization(address, campaign.token_address, log, date);
      }
    }
    await setCursor("campaign", address, to + 1);
  }
}

async function runOnce(provider: ethers.JsonRpcProvider): Promise<{ head: number; factoryCount: number; campaignCount: number }> {
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== CHAIN_ID) {
    throw new Error(`Robinhood RPC returned chain ${network.chainId}; expected ${CHAIN_ID}`);
  }
  const head = Math.max(0, (await provider.getBlockNumber()) - Math.max(0, ENV.CONFIRMATIONS));
  const inventory = factories();
  for (const factory of inventory) {
    const code = await provider.getCode(factory.address);
    if (code === "0x") throw new Error(`No LaunchFactory bytecode at ${factory.address}`);
    await syncFactoryRegistry(provider, factory);
    await scanFactoryEvents(provider, factory, head);
  }

  const campaigns = await pool.query(
    `select campaign_address, token_address, created_block
     from public.campaigns
     where chain_id=$1 and coalesce(indexing_enabled,true)=true
     order by created_block asc, campaign_address asc`,
    [CHAIN_ID],
  );
  for (const campaign of campaigns.rows) {
    await scanCampaign(provider, campaign, head);
  }
  return { head, factoryCount: inventory.length, campaignCount: campaigns.rowCount || 0 };
}

async function createProvider(): Promise<ethers.JsonRpcProvider> {
  const urls = parseRpcList(ENV.ROBINHOOD_RPC_HTTP_46630);
  if (!urls.length) throw new Error("ROBINHOOD_RPC_HTTP_46630 is required for Robinhood local scanner");
  let lastError: unknown;
  for (const url of urls) {
    const provider = createStaticJsonRpcProvider(url, CHAIN_ID, { timeoutMs: ENV.RPC_REQUEST_TIMEOUT_MS });
    try {
      const network = await provider.getNetwork();
      if (Number(network.chainId) !== CHAIN_ID) throw new Error(`RPC chain ${network.chainId} != ${CHAIN_ID}`);
      return provider;
    } catch (error) {
      provider.destroy();
      lastError = error;
    }
  }
  throw lastError || new Error("No Robinhood testnet RPC was usable");
}

assertIsolation();
const provider = await createProvider();
let stopped = false;
let running = false;
let lastIdleLog = 0;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopped = true;
    try { provider.destroy(); } catch {}
    void pool.end().finally(() => process.exit(0));
  });
}

console.log("[robinhood-scanner] isolation verified: local DB + chain 46630 only");
console.log(`[robinhood-scanner] RPC connected; polling every ${POLL_MS}ms`);

while (!stopped) {
  if (!running) {
    running = true;
    try {
      const result = await runOnce(provider);
      if ((result.factoryCount > 0 || result.campaignCount > 0) || Date.now() - lastIdleLog > 60_000) {
        console.log("[robinhood-scanner] pass", result);
        lastIdleLog = Date.now();
      }
    } catch (error) {
      console.error("[robinhood-scanner] pass failed", String((error as any)?.shortMessage || (error as any)?.message || error));
    } finally {
      running = false;
    }
  }
  await sleep(POLL_MS);
}