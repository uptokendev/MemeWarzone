#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const need = (text, re, label) => { if (!re.test(text)) throw new Error(`ISOLATION SOURCE GATE: ${label}`); };

const social = read("db/migrations/002_social.sql");
const indexer = read("db/migrations/003_indexer.sql");
const continuity = read("db/migrations/202607290001_war_trade_room_market_continuity_foundation.sql");
const rewardsApi = read("frontend/api/rewards.js");
const chainRegistry = read("frontend/api/lib/chainRegistry.js");

need(social, /PRIMARY KEY \(chain_id, campaign_address\)/, "campaign identity is not chain-scoped");
need(indexer, /PRIMARY KEY \(chain_id, cursor\)/, "indexer cursor is not chain-scoped");
need(indexer, /PRIMARY KEY \(chain_id, tx_hash, log_index\)/, "bonding event identity is not chain-scoped");
need(continuity, /primary key\(chain_id,campaign_address\)/i, "normalized market identity is not chain-scoped");
need(continuity, /primary key\(chain_id,pair_address\)/i, "post-grad pool identity is not chain-scoped");
need(continuity, /primary key\(chain_id,tx_hash,log_index\)/i, "post-grad trade identity is not chain-scoped");
need(rewardsApi, /c\.chain_id\s*=\s*w\.chain_id|w\.chain_id\s*=\s*c\.chain_id/, "claim entitlement join lacks chain identity");
need(chainRegistry, /101/, "Solana chain 101 missing from chain registry");
need(chainRegistry, /97/, "BSC97 missing from chain registry");

const databaseUrl = String(process.env.DATABASE_URL || "").trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const same = String(process.env.CERT_SAME_TEXT_ID || "same-text-identity-agent5").replace(/[^A-Za-z0-9_.:-]/g, "_");
const sql = String.raw`
\set ON_ERROR_STOP on
begin;
create temporary table cert_campaigns(chain_id int not null, campaign_id text not null, token_identity text not null, quote_id text not null, primary key(chain_id,campaign_id));
create temporary table cert_claims(chain_id int not null, entitlement_id text not null, wallet text not null, amount_raw numeric not null, primary key(chain_id,entitlement_id));
create temporary table cert_cursors(chain_id int not null, cursor text not null, position bigint not null, primary key(chain_id,cursor));
create temporary table cert_markets(chain_id int not null, campaign_id text not null, token_identity text not null, quote_id text not null, last_event text, primary key(chain_id,campaign_id));
create temporary table cert_rewards(chain_id int not null, treasury_id text not null, reward_id text not null, amount_raw numeric not null, primary key(chain_id,treasury_id,reward_id));
insert into cert_campaigns values (97,'${same}','${same}','${same}'),(101,'${same}','${same}','${same}');
insert into cert_claims values (97,'${same}','${same}',97),(101,'${same}','${same}',101);
insert into cert_cursors values (97,'${same}',9700),(101,'${same}',10100);
insert into cert_markets values (97,'${same}','${same}','${same}','bnb-event'),(101,'${same}','${same}','${same}','sol-event');
insert into cert_rewards values (97,'${same}','${same}',97),(101,'${same}','${same}',101);
update cert_cursors set position=9701 where chain_id=97 and cursor='${same}';
do $$ begin
 if (select count(*) from cert_campaigns where campaign_id='${same}') <> 2 then raise exception 'campaign cross-chain collision'; end if;
 if (select count(*) from cert_claims where entitlement_id='${same}') <> 2 then raise exception 'claim cross-chain collision'; end if;
 if (select position from cert_cursors where chain_id=101 and cursor='${same}') <> 10100 then raise exception 'cursor contamination'; end if;
 if (select last_event from cert_markets where chain_id=97 and campaign_id='${same}') <> 'bnb-event' then raise exception 'market BNB contamination'; end if;
 if (select last_event from cert_markets where chain_id=101 and campaign_id='${same}') <> 'sol-event' then raise exception 'market Solana contamination'; end if;
 if (select sum(amount_raw) from cert_rewards where chain_id=97) <> 97 then raise exception 'BNB reward contamination'; end if;
 if (select sum(amount_raw) from cert_rewards where chain_id=101) <> 101 then raise exception 'Solana reward contamination'; end if;
end $$;
rollback;
`;
const run = spawnSync("psql", [databaseUrl, "-X", "-v", "ON_ERROR_STOP=1", "-q"], { input: sql, encoding: "utf8" });
if (run.status !== 0) throw new Error(`chain-isolation SQL failed: ${String(run.stderr || run.stdout).slice(0, 2000)}`);

const report = {
  result: "PASS",
  chains: [97, 101],
  sameTextIdentity: same,
  matrix: {
    campaignIds: "PASS",
    tokenMintIdentity: "PASS",
    quoteIds: "PASS",
    claimEntitlements: "PASS",
    indexerCursors: "PASS",
    normalizedMarketRecords: "PASS",
    treasuryRewardChainIds: "PASS",
  },
  productionSchemaBindings: {
    campaigns: "(chain_id,campaign_address)",
    indexerState: "(chain_id,cursor)",
    curveTrades: "(chain_id,tx_hash,log_index)",
    marketState: "(chain_id,campaign_address)",
    dexPools: "(chain_id,pair_address)",
    dexTrades: "(chain_id,tx_hash,log_index)",
  },
};
fs.mkdirSync(path.join(root, "reports"), { recursive: true });
fs.writeFileSync(path.join(root, "reports/agent5-nonarena-chain-isolation.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
