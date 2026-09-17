import { ethers } from "ethers";
import { LAUNCH_CAMPAIGN_ABI } from "./abis.js";
import { pool } from "./db.js";
import { ENV } from "./env.js";
import { createStaticJsonRpcProvider, parseRpcList } from "./rpcProvider.js";

const CAMPAIGN_READ_ABI = [
  ...LAUNCH_CAMPAIGN_ABI,
  "function creator() view returns (address)",
  "function logoURI() view returns (string)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
];

const TOKEN_READ_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
];

function normalizeAddress(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function isAddress(value: string): boolean {
  return /^0x[a-f0-9]{40}$/.test(value);
}

function rpcUrlsFor(chainId: number): string[] {
  if (chainId === 56) return parseRpcList(ENV.BSC_RPC_HTTP_56);
  if (chainId === 46630) return parseRpcList(ENV.ROBINHOOD_RPC_HTTP_46630);
  if (chainId === 4663) return parseRpcList(ENV.ROBINHOOD_RPC_HTTP_4663);
  return parseRpcList(ENV.BSC_RPC_HTTP_97);
}

function rpcUrlFor(chainId: number): string {
  return rpcUrlsFor(chainId)[0] || "";
}

function toDec18(raw: bigint): number {
  try {
    const n = Number(ethers.formatUnits(raw, 18));
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * If cleanup / discovery lag left no campaigns row, hydrate one from chain so
 * trade indexing + resolve can attach to a real market key.
 */
export async function ensureCampaignRowFromChain(
  chainId: number,
  addressOrCampaign: string,
): Promise<{ campaign: string; created: boolean } | null> {
  const input = normalizeAddress(addressOrCampaign);
  if (!isAddress(input) || !Number.isInteger(chainId) || chainId <= 0) return null;

  const existing = await pool.query(
    `select campaign_address
     from public.campaigns
     where chain_id=$1
       and (campaign_address=$2 or token_address=$2)
     order by case when campaign_address=$2 then 0 else 1 end
     limit 1`,
    [chainId, input],
  );
  if (existing.rows[0]?.campaign_address) {
    return { campaign: normalizeAddress(existing.rows[0].campaign_address), created: false };
  }

  const rpcUrl = rpcUrlFor(chainId);
  if (!rpcUrl) return null;

  try {
    const provider = createStaticJsonRpcProvider(rpcUrl, chainId, { timeoutMs: 20_000 });
    // Prefer treating input as campaign (has token()).
    let campaignAddr = input;
    let tokenAddr = "";
    let factoryAddr = "";
    let creatorAddr = "";
    let name = "";
    let symbol = "";
    let logoURI = "";

    const asCampaign = new ethers.Contract(input, CAMPAIGN_READ_ABI, provider);
    let resolvedFromFactories = false;
    try {
      tokenAddr = normalizeAddress(await asCampaign.token());
      if (!isAddress(tokenAddr)) throw new Error("not a campaign");
      factoryAddr = normalizeAddress(await asCampaign.factory().catch(() => ""));
      creatorAddr = normalizeAddress(await asCampaign.creator().catch(() => ""));
      logoURI = String(await asCampaign.logoURI().catch(() => "") || "");
      try {
        name = String(await asCampaign.name().catch(() => "") || "");
        symbol = String(await asCampaign.symbol().catch(() => "") || "");
      } catch {
        // name/symbol may live only on the ERC-20
      }
      if ((!name || !symbol) && isAddress(tokenAddr)) {
        const token = new ethers.Contract(tokenAddr, TOKEN_READ_ABI, provider);
        if (!name) name = String(await token.name().catch(() => "") || "");
        if (!symbol) symbol = String(await token.symbol().catch(() => "") || "");
      }
      campaignAddr = input;
    } catch {
      // Input may be the ERC-20 token address — reverse via dual-test factory inventory only.
      const DEFAULT_FACTORIES_97 = [
        "0xa2b19f194826b6d930d18f3fbcad662fadc9459e", // previous / support
        "0x8d4937d3bee8a750411c0a24f888c0088754d3ed", // new dual-test / creation
      ];
      const factories = [
        ENV.FACTORY_ADDRESS_97,
        ...ENV.SUPPORTED_FACTORY_ADDRESSES_97,
        ...DEFAULT_FACTORIES_97,
        ENV.FACTORY_ADDRESS_56,
        ...ENV.SUPPORTED_FACTORY_ADDRESSES_56,
      ]
        .map((value) => normalizeAddress(value))
        .filter((value, index, arr) => isAddress(value) && arr.indexOf(value) === index);

      const pageAbi = [
        "function campaignsCount() view returns (uint256)",
        "function getCampaignPage(uint256 offset,uint256 limit) view returns (tuple(address campaign,address token,address creator,string name,string symbol,string logoURI,string metadataURI,string xAccount,string website,string extraLink,uint64 createdAt)[])",
      ];
      for (const factory of factories) {
        try {
          const f = new ethers.Contract(factory, pageAbi, provider);
          const count = Number(await f.campaignsCount());
          if (!Number.isFinite(count) || count <= 0) continue;
          // Scan newest first — recent launches are the usual Token Details targets.
          const window = Math.min(count, 80);
          const offset = Math.max(0, count - window);
          const page = await f.getCampaignPage(offset, window);
          for (const row of page || []) {
            const token = normalizeAddress((row as any)?.token ?? (row as any)?.[1]);
            const camp = normalizeAddress((row as any)?.campaign ?? (row as any)?.[0]);
            if (token === input && isAddress(camp)) {
              campaignAddr = camp;
              tokenAddr = token;
              factoryAddr = factory;
              creatorAddr = normalizeAddress((row as any)?.creator ?? (row as any)?.[2]);
              name = String((row as any)?.name ?? (row as any)?.[3] ?? "");
              symbol = String((row as any)?.symbol ?? (row as any)?.[4] ?? "");
              logoURI = String((row as any)?.logoURI ?? (row as any)?.[5] ?? "");
              resolvedFromFactories = true;
              break;
            }
          }
          if (resolvedFromFactories) break;
        } catch {
          // try next factory
        }
      }
      if (!resolvedFromFactories) return null;
    }

    if (!isAddress(tokenAddr) || !isAddress(campaignAddr)) return null;

    await pool.query(
      `insert into public.campaigns(
         chain_id,factory_address,campaign_address,token_address,creator_address,
         name,symbol,logo_uri,created_block,created_at_chain,is_active
       ) values($1,$2,$3,$4,$5,$6,$7,$8,0,now(),true)
       on conflict (chain_id,campaign_address) do update set
         token_address=coalesce(nullif(excluded.token_address,''), public.campaigns.token_address),
         factory_address=coalesce(nullif(excluded.factory_address,''), public.campaigns.factory_address),
         creator_address=coalesce(nullif(excluded.creator_address,''), public.campaigns.creator_address),
         name=coalesce(nullif(excluded.name,''), public.campaigns.name),
         symbol=coalesce(nullif(excluded.symbol,''), public.campaigns.symbol),
         logo_uri=coalesce(nullif(public.campaigns.logo_uri,''), nullif(excluded.logo_uri,'')),
         is_active=true,
         updated_at=now()`,
      [
        chainId,
        isAddress(factoryAddr) ? factoryAddr : null,
        campaignAddr,
        tokenAddr,
        isAddress(creatorAddr) ? creatorAddr : null,
        name || "Unknown",
        symbol || "",
        logoURI || null,
      ],
    );

    console.log("[indexer] ensured campaigns row from chain", {
      chainId,
      campaign: campaignAddr,
      token: tokenAddr,
      factory: factoryAddr || null,
    });
    return { campaign: campaignAddr, created: true };
  } catch (error) {
    console.warn("[indexer] ensureCampaignRowFromChain failed", {
      chainId,
      input,
      error: String((error as any)?.message || error),
    });
    return null;
  }
}

async function getLogsChunked(
  provider: ethers.JsonRpcProvider,
  filter: Omit<ethers.Filter, "fromBlock" | "toBlock">,
  fromBlock: number,
  toBlock: number,
): Promise<ethers.Log[]> {
  // Free Chapel public nodes reject wide eth_getLogs (coalesce / max range).
  // 500-block windows match what works without a paid provider.
  const chunk = Math.max(100, Math.min(ENV.LOG_CHUNK_SIZE || 500, 500));
  const out: ethers.Log[] = [];
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = Math.min(toBlock, start + chunk - 1);
    let attempt = 0;
    while (attempt < 3) {
      attempt += 1;
      try {
        if (ENV.INDEXER_LOG_CALL_DELAY_MS > 0) {
          await sleep(ENV.INDEXER_LOG_CALL_DELAY_MS);
        }
        const logs = await provider.getLogs({ ...filter, fromBlock: start, toBlock: end });
        out.push(...logs);
        break;
      } catch (error) {
        if (attempt < 3) {
          await sleep(150 * attempt);
          continue;
        }
        // Bisect on hard failure (public RPC range limits).
        if (end > start && end - start > 50) {
          const mid = Math.floor((start + end) / 2);
          const left = await getLogsChunked(provider, filter, start, mid);
          const right = await getLogsChunked(provider, filter, mid + 1, end);
          out.push(...left, ...right);
        } else {
          console.warn("[indexer] trade backfill getLogs failed", {
            fromBlock: start,
            toBlock: end,
            error: String((error as any)?.message || error),
          });
        }
      }
    }
  }
  return out;
}

/**
 * When a campaign has zero curve_trades (cleanup, cursor stuck, discovery lag),
 * scan TokensPurchased/TokensSold on-chain and insert missing rows.
 */
export async function backfillEmptyCampaignTrades(
  chainId: number,
  campaignAddress: string,
): Promise<{ inserted: number; scanned: number; reason?: string }> {
  const campaign = normalizeAddress(campaignAddress);
  if (!isAddress(campaign) || !Number.isInteger(chainId) || chainId <= 0) {
    return { inserted: 0, scanned: 0, reason: "invalid_args" };
  }

  const countRes = await pool.query(
    `select count(*)::int as n from public.curve_trades
     where chain_id=$1 and campaign_address=$2`,
    [chainId, campaign],
  );
  const existing = Number(countRes.rows[0]?.n || 0);
  if (existing > 0) return { inserted: 0, scanned: 0, reason: "has_trades" };

  const rpcUrls = rpcUrlsFor(chainId);
  if (!rpcUrls.length) return { inserted: 0, scanned: 0, reason: "no_rpc" };

  try {
    // Prefer Railway BSC_RPC_HTTP_97 first entry (BlockPI, etc.). Fall back down the CSV.
    let provider: ethers.JsonRpcProvider | null = null;
    let activeRpc = "";
    let latest = 0;
    for (const url of rpcUrls) {
      try {
        const candidate = createStaticJsonRpcProvider(url, chainId, { timeoutMs: 25_000 });
        latest = await candidate.getBlockNumber();
        provider = candidate;
        activeRpc = url;
        break;
      } catch (error) {
        console.warn("[indexer] trade backfill RPC unusable", {
          chainId,
          error: String((error as any)?.message || error),
        });
      }
    }
    if (!provider || !activeRpc) return { inserted: 0, scanned: 0, reason: "no_rpc" };

    const iface = new ethers.Interface(LAUNCH_CAMPAIGN_ABI);
    const buyTopic = iface.getEvent("TokensPurchased")?.topicHash;
    const sellTopic = iface.getEvent("TokensSold")?.topicHash;
    if (!buyTopic || !sellTopic) return { inserted: 0, scanned: 0, reason: "no_topics" };

    const campRow = await pool.query(
      `select coalesce(created_block,0)::bigint as created_block
       from public.campaigns where chain_id=$1 and campaign_address=$2 limit 1`,
      [chainId, campaign],
    );
    const createdBlock = Number(campRow.rows[0]?.created_block || 0);
    const factoryStart =
      chainId === 56 ? Number(ENV.FACTORY_START_BLOCK_56 || 0) : Number(ENV.FACTORY_START_BLOCK_97 || 0);
    // Dual-test A2B19f start when env missing — WIC lives on this factory.
    const knownFactoryFloor = chainId === 97 ? 122_024_169 : 0;
    const floor =
      createdBlock > 0
        ? createdBlock
        : factoryStart > 0
          ? factoryStart
          : knownFactoryFloor > 0
            ? knownFactoryFloor
            : Math.max(0, latest - 50_000);

    // Never try to walk 1M blocks in one API-triggered backfill (hangs /trades).
    // Scan tip first for live UX, then one bounded historical window from floor.
    const tipBlocks = Math.max(3_000, Number(ENV.INDEXER_TIP_SCAN_BLOCKS || 5_000));
    const histBlocks = Math.max(
      8_000,
      Math.min(60_000, Number(ENV.REPAIR_LOOKBACK_BLOCKS || 20_000) * 3),
    );
    const tipFrom = Math.max(0, latest - tipBlocks);
    // Prefer starting historical at created_block; if that range is huge, take the
    // oldest histBlocks window first so bonding-era trades are not permanently skipped.
    const histFrom = Math.max(0, floor - 2);
    const histTo = Math.min(latest, histFrom + histBlocks);

    const windows: Array<{ label: string; from: number; to: number }> = [
      { label: "tip", from: tipFrom, to: latest },
    ];
    if (histFrom < tipFrom) {
      windows.push({ label: "history", from: histFrom, to: Math.min(histTo, tipFrom) });
    }

    console.log("[indexer] trade backfill scan windows", {
      chainId,
      campaign,
      latest,
      createdBlock,
      factoryStart,
      windows,
      rpcHost: (() => {
        try {
          return new URL(activeRpc).host;
        } catch {
          return "unknown";
        }
      })(),
    });

    const insertLogs = async (logs: ethers.Log[]): Promise<number> => {
      let insertedLocal = 0;
      const tsCache = new Map<number, number>();
      logs.sort((a, b) => a.blockNumber - b.blockNumber || Number(a.index ?? 0) - Number(b.index ?? 0));
      for (const log of logs) {
        const parsed = iface.parseLog(log);
        if (!parsed) continue;
        const isSell = parsed.name === "TokensSold";
        const isBuy = parsed.name === "TokensPurchased";
        if (!isBuy && !isSell) continue;

        const txHash = String(log.transactionHash || "").toLowerCase();
        if (!/^0x[a-f0-9]{64}$/.test(txHash)) continue;
        const logIndex = Number(log.index ?? 0);
        const blockNumber = Number(log.blockNumber ?? 0);

        let tsSec = tsCache.get(blockNumber);
        if (!tsSec) {
          const blk = await provider.getBlock(blockNumber);
          tsSec = Number(blk?.timestamp ?? Math.floor(Date.now() / 1000));
          tsCache.set(blockNumber, tsSec);
        }

        const tokenRaw = BigInt(String(isSell ? (parsed.args as any).amountIn : (parsed.args as any).amountOut));
        const bnbRaw = BigInt(String(isSell ? (parsed.args as any).payout : (parsed.args as any).cost));
        const wallet = normalizeAddress(isSell ? (parsed.args as any).seller : (parsed.args as any).buyer);
        if (!isAddress(wallet) || tokenRaw <= 0n) continue;

        const tokenAmount = toDec18(tokenRaw);
        const bnbAmount = toDec18(bnbRaw);
        const priceBnb = tokenAmount > 0 ? bnbAmount / tokenAmount : null;

        const result = await pool.query(
          `insert into public.curve_trades(
             chain_id,campaign_address,tx_hash,log_index,block_number,block_time,
             side,wallet,token_amount_raw,bnb_amount_raw,token_amount,bnb_amount,price_bnb
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           on conflict (chain_id,tx_hash,log_index) do nothing`,
          [
            chainId,
            campaign,
            txHash,
            logIndex,
            blockNumber,
            new Date(tsSec * 1000),
            isSell ? "sell" : "buy",
            wallet,
            tokenRaw.toString(),
            bnbRaw.toString(),
            tokenAmount,
            bnbAmount,
            priceBnb,
          ],
        );
        if ((result.rowCount ?? 0) > 0) insertedLocal += 1;
      }
      return insertedLocal;
    };

    let inserted = 0;
    let scanned = 0;
    let maxSeenBlock = 0;

    for (const win of windows) {
      if (win.from > win.to) continue;
      // Scan buy + sell separately — some RPC providers mishandle multi-topic OR filters.
      const buyLogs = await getLogsChunked(
        provider,
        { address: campaign, topics: [buyTopic] },
        win.from,
        win.to,
      );
      const sellLogs = await getLogsChunked(
        provider,
        { address: campaign, topics: [sellTopic] },
        win.from,
        win.to,
      );
      const logs = [...buyLogs, ...sellLogs];
      scanned += logs.length;
      for (const log of logs) {
        maxSeenBlock = Math.max(maxSeenBlock, Number(log.blockNumber || 0));
      }
      inserted += await insertLogs(logs);
    }

    // Empty-campaign recovery: pin the historical cursor to the end of the history
    // window we just scanned (from created_block). The live loop continues from here
    // without jumping over bonding-era blocks to a far tip.
    const cursorSeed = Math.max(histFrom, histTo);
    await pool.query(
      `insert into public.indexer_state(chain_id,cursor,last_indexed_block)
       values ($1,$2,$3)
       on conflict (chain_id,cursor) do update
         set last_indexed_block = excluded.last_indexed_block,
             updated_at = now()`,
      [chainId, `campaign:${campaign}`, cursorSeed],
    );

    console.log("[indexer] backfilled empty campaign trades", {
      chainId,
      campaign,
      scanned,
      inserted,
      maxSeenBlock: maxSeenBlock || null,
      cursorSeed,
      reason: scanned === 0 ? "no_logs_in_window" : inserted > 0 ? "inserted" : "already_present",
    });

    return { inserted, scanned, reason: scanned === 0 ? "no_logs_in_window" : undefined };
  } catch (error) {
    console.warn("[indexer] backfillEmptyCampaignTrades failed", {
      chainId,
      campaign,
      error: String((error as any)?.message || error),
    });
    return { inserted: 0, scanned: 0, reason: "error" };
  }
}

/**
 * Called from public trade history API: ensure DB identity + recover empty trade history.
 */
export async function ensureCampaignTradeHistory(
  chainId: number,
  address: string,
): Promise<{ campaign: string; inserted: number }> {
  const ensured = await ensureCampaignRowFromChain(chainId, address);
  const campaign = ensured?.campaign || normalizeAddress(address);
  if (!isAddress(campaign)) return { campaign: "", inserted: 0 };

  const backfill = await backfillEmptyCampaignTrades(chainId, campaign);
  return { campaign, inserted: backfill.inserted };
}
