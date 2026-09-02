import pg from "pg";

const { Client } = pg;
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");

const chainId = 46630;
const campaign = "0x0000000000000000000000000000000000004630";
const token = "0x0000000000000000000000000000000000004631";
const pair = "0x0000000000000000000000000000000000004632";
const wrapped = "0x0000000000000000000000000000000000004633";
const router = "0x0000000000000000000000000000000000004634";
const factory = "0x0000000000000000000000000000000000004635";
const creator = "0x0000000000000000000000000000000000004636";
const trader = "0x0000000000000000000000000000000000004637";
const stock = "0x0000000000000000000000000000000000004638";
const stockPair = "0x0000000000000000000000000000000000004639";
const curveTx = `0x${"11".repeat(32)}`;
const dexTx = `0x${"22".repeat(32)}`;
const stockDexTx = `0x${"44".repeat(32)}`;
const blockHash = `0x${"33".repeat(32)}`;
const cursor = `robinhood-v3:${pair}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const client = new Client({
  connectionString: DATABASE_URL,
  ssl: ["localhost", "127.0.0.1"].some((host) => DATABASE_URL.includes(host)) ? false : { rejectUnauthorized: false },
});

await client.connect();
await client.query("begin");
try {
  const required = await client.query(
    `select table_name from information_schema.tables
      where table_schema='public'
        and table_name = any($1::text[])`,
    [["campaigns", "curve_trades", "dex_trades", "market_pairs", "market_trades_v", "indexer_state"]],
  );
  const names = new Set(required.rows.map((row) => row.table_name));
  for (const name of ["campaigns", "curve_trades", "dex_trades", "market_pairs", "market_trades_v", "indexer_state"]) {
    assert(names.has(name), `Missing required market-continuity object: ${name}`);
  }

  await client.query(
    `insert into public.campaigns(
       chain_id,factory_address,campaign_address,token_address,creator_address,
       name,symbol,logo_uri,created_block,created_at_chain,is_active,
       bonding_active,support_enabled,indexing_enabled,market_stage
     ) values($1,$2,$3,$4,$5,'RH DB Proof','RHP','ipfs://rh-proof',100,now()-interval '2 minutes',false,false,true,true,'DEX_ACTIVE')
     on conflict(chain_id,campaign_address) do update set
       token_address=excluded.token_address,market_stage='DEX_ACTIVE',bonding_active=false,
       support_enabled=true,indexing_enabled=true,updated_at=now()`,
    [chainId, factory, campaign, token, creator],
  );

  await client.query(
    `insert into public.curve_trades(
       chain_id,campaign_address,tx_hash,log_index,block_number,block_time,side,wallet,
       token_amount_raw,bnb_amount_raw,token_amount,bnb_amount,price_bnb
     ) values($1,$2,$3,1,101,now()-interval '90 seconds','buy',$4,$5,$6,2,1,0.5)
     on conflict(chain_id,tx_hash,log_index) do nothing`,
    [chainId, campaign, curveTx, trader, "2000000000000000000", "1000000000000000000"],
  );

  const insertDex = () => client.query(
    `insert into public.dex_trades(
       chain_id,campaign_address,token_address,pair_address,tx_hash,log_index,
       block_number,block_hash,block_time,status,side,sender_address,recipient_address,
       transaction_from,token_amount_raw,native_amount_raw,token_amount,native_amount,
       price_bnb,base_amount_raw,quote_amount_raw,base_amount,quote_amount,price_quote,
       quote_asset_type,quote_token_address,execution_source,origin,created_at,updated_at
     ) values(
       $1,$2,$3,$4,$5,2,202,$6,now()-interval '30 seconds','confirmed','buy',$7,$7,$7,
       '1000000000000000000','600000000000000000',1,0.6,0.6,
       '1000000000000000000','600000000000000000',1,0.6,0.6,
       'WRAPPED_NATIVE',$8,'robinhood_v3','robinhood_v3',now(),now()
     ) on conflict(chain_id,tx_hash,log_index) do nothing
     returning tx_hash`,
    [chainId, campaign, token, pair, dexTx, blockHash, trader, wrapped],
  );

  const first = await insertDex();
  const replay = await insertDex();
  assert(first.rowCount === 1, "First Robinhood V3 trade insert did not persist");
  assert(replay.rowCount === 0, "Duplicate Robinhood V3 trade was not idempotent");

  const stockInsert = await client.query(
    `insert into public.dex_trades(
       chain_id,campaign_address,token_address,pair_address,tx_hash,log_index,
       block_number,block_hash,block_time,status,side,sender_address,recipient_address,
       transaction_from,token_amount_raw,native_amount_raw,token_amount,native_amount,
       price_bnb,base_amount_raw,quote_amount_raw,base_amount,quote_amount,price_quote,
       quote_asset_type,quote_token_address,execution_source,origin,created_at,updated_at
     ) values(
       $1,$2,$3,$4,$5,3,203,$6,now()-interval '15 seconds','confirmed','buy',$7,$7,$7,
       '10000000000000000000',null,10,null,null,
       '10000000000000000000','250000000',10,2.5,0.25,
       'STOCK_TOKEN',$8,'robinhood_v3','robinhood_v3',now(),now()
     ) returning tx_hash,native_amount_raw,quote_amount_raw,quote_asset_type,quote_token_address`,
    [chainId, campaign, token, stockPair, stockDexTx, blockHash, trader, stock],
  );
  assert(stockInsert.rowCount === 1, "Robinhood Stock Token trade did not persist");
  assert(stockInsert.rows[0].native_amount_raw === null, "Stock Token quote was incorrectly stored as native amount");
  assert(String(stockInsert.rows[0].quote_amount_raw) === "250000000", "Stock Token quote raw amount changed");
  assert(stockInsert.rows[0].quote_asset_type === "STOCK_TOKEN", "Stock Token quote classification changed");
  assert(String(stockInsert.rows[0].quote_token_address).toLowerCase() === stock.toLowerCase(), "Stock Token quote identity changed");

  const stream = await client.query(
    `select source,"txHash","blockNumber","nativeAmountRaw","priceBnb"
       from public.market_trades_v
      where "chainId"=$1 and lower("campaignAddress")=lower($2)
      order by "blockNumber" asc,"logIndex" asc`,
    [chainId, campaign],
  );
  assert(stream.rowCount === 3, `Expected exactly 3 continuous trades, got ${stream.rowCount}`);
  assert(stream.rows[0].source === "bonding", `Expected bonding source first, got ${stream.rows[0].source}`);
  assert(stream.rows[1].source === "robinhood_v3", `Expected robinhood_v3 source second, got ${stream.rows[1].source}`);
  assert(stream.rows[2].source === "robinhood_v3", `Expected stock robinhood_v3 source third, got ${stream.rows[2].source}`);
  assert(String(stream.rows[0].nativeAmountRaw) === "1000000000000000000", "Bonding native raw amount changed in unified view");
  assert(String(stream.rows[1].nativeAmountRaw) === "600000000000000000", "V3 native raw amount changed in unified view");
  assert(stream.rows[2].nativeAmountRaw === null, "Unified trade view relabeled Stock Token quote as native");
  assert(stream.rows[2].priceBnb === null, "Unified trade view relabeled Stock Token price as BNB");

  await client.query(
    `insert into public.indexer_state(chain_id,cursor,last_indexed_block)
     values($1,$2,204)
     on conflict(chain_id,cursor) do update set last_indexed_block=excluded.last_indexed_block,updated_at=now()`,
    [chainId, cursor],
  );
  const cursorRead = await client.query(
    `select last_indexed_block from public.indexer_state where chain_id=$1 and cursor=$2`,
    [chainId, cursor],
  );
  assert(Number(cursorRead.rows[0]?.last_indexed_block) === 204, "Robinhood V3 cursor did not persist across a read boundary");

  console.log("[robinhood-market-db] PASS", {
    chainId,
    continuousTrades: stream.rowCount,
    sources: stream.rows.map((row) => row.source),
    duplicateDexInsert: replay.rowCount,
    stockNativeAmountRaw: stream.rows[2].nativeAmountRaw,
    cursor: 204,
  });
} finally {
  await client.query("rollback");
  await client.end();
}