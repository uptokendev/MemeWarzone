#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ethers } from "ethers";
import { proveRobinhoodIndexerContinuity } from "./prove-robinhood-testnet-indexer-continuity.mjs";
import { loadRobinhoodTestnetFreeze } from "./robinhoodTestnetFreeze.mjs";

export const ROBINHOOD_TESTNET_CHAIN_ID = 46630;
const FACTORY_ABI = [
  "function campaignsCount() view returns (uint256)",
  "function getCampaign(uint256 id) view returns (tuple(address campaign,address token,address creator,string name,string symbol,string logoURI,string metadataURI,string xAccount,string website,string extraLink,uint64 createdAt))",
];

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function loadPg() {
  const require = createRequire(path.join(repoRoot(), "frontend", "package.json"));
  return require("pg");
}

function parseLocalEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const env = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eq = trimmed.indexOf("=");
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return env;
}

/** Prefer the isolated Robinhood local DB over a process DATABASE_URL that may be production. */
export function resolveRobinhoodAcceptanceDatabaseUrl(env = process.env) {
  const local = parseLocalEnvFile(path.join(repoRoot(), "config/robinhood.local"));
  return String(env.ROBINHOOD_DATABASE_URL || local.DATABASE_URL || "").trim();
}

function assertDedicatedRobinhoodDatabase(databaseUrl) {
  const url = new URL(databaseUrl);
  const localHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (!localHosts.has(url.hostname.toLowerCase())) {
    throw new Error(`Robinhood acceptance indexer requires a loopback PostgreSQL host; got ${url.hostname}`);
  }
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, "")).toLowerCase();
  if (!dbName.includes("robinhood") && !dbName.includes("local")) {
    throw new Error(`Robinhood acceptance indexer refuses shared database ${dbName}`);
  }
}

export async function indexRobinhoodTestnetAcceptance({
  databaseUrl,
  rpcUrl,
  factoryAddress,
  startBlock = 0,
}) {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!rpcUrl) throw new Error("ROBINHOOD_TESTNET_RPC_URL is required");
  if (!ethers.isAddress(factoryAddress)) throw new Error("launch factory address is required");
  assertDedicatedRobinhoodDatabase(databaseUrl);

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== ROBINHOOD_TESTNET_CHAIN_ID) {
    throw new Error(`acceptance indexer RPC chain is ${net.chainId}, not ${ROBINHOOD_TESTNET_CHAIN_ID}`);
  }

  const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, provider);
  const count = Number(await factory.campaignsCount());
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error("staged factory has no campaigns to index");
  }

  const pg = loadPg();
  const client = new pg.Client({ connectionString: databaseUrl, ssl: false });
  await client.connect();
  const indexed = [];
  try {
    const exists = await client.query("select to_regclass('public.campaigns') as relation");
    if (!exists.rows[0]?.relation) throw new Error("public.campaigns is missing");

    for (let id = 0; id < count; id += 1) {
      const info = await factory.getCampaign(id);
      const campaign = String(info.campaign).toLowerCase();
      const token = String(info.token).toLowerCase();
      const creator = String(info.creator).toLowerCase();
      const createdAt = Number(info.createdAt || 0);
      await client.query(
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
           created_block=case when coalesce(public.campaigns.created_block,0)=0 then excluded.created_block else public.campaigns.created_block end,
           created_at_chain=coalesce(public.campaigns.created_at_chain, excluded.created_at_chain),
           is_active=true,
           updated_at=now()`,
        [
          ROBINHOOD_TESTNET_CHAIN_ID,
          String(factoryAddress).toLowerCase(),
          campaign,
          token,
          creator,
          String(info.name || ""),
          String(info.symbol || ""),
          String(info.logoURI || "") || null,
          Number(startBlock || 0),
          createdAt > 1_500_000_000 ? new Date(createdAt * 1000) : null,
        ],
      );
      indexed.push(campaign);
    }

    const aliased = await client.query(
      `select campaign_address, chain_id from public.campaigns
       where chain_id=56 and lower(campaign_address) = any($1::text[])`,
      [indexed],
    );
    if (aliased.rowCount) {
      throw new Error(`Robinhood campaigns were aliased onto chain 56: ${aliased.rows.map((row) => row.campaign_address).join(",")}`);
    }
  } finally {
    await client.end();
  }

  return { chainId: ROBINHOOD_TESTNET_CHAIN_ID, factory: factoryAddress, indexed };
}

export async function proveIndexedRobinhoodCampaign({ databaseUrl, campaignAddress }) {
  const pg = loadPg();
  const client = new pg.Client({ connectionString: databaseUrl, ssl: false });
  await client.connect();
  try {
    const result = await client.query(
      `select chain_id, campaign_address, factory_address from public.campaigns where lower(campaign_address)=lower($1)`,
      [campaignAddress],
    );
    proveRobinhoodIndexerContinuity({ rows: result.rows, campaignAddress });
    return result.rows;
  } finally {
    await client.end();
  }
}

function runningAsCli() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (runningAsCli()) {
  const { config: loadDotenv } = await import("dotenv");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, "..");
  loadDotenv({ path: path.join(root, ".env") });
  loadDotenv({ path: path.join(root, "config/robinhood.local") });

  const freeze = loadRobinhoodTestnetFreeze();
  let factoryAddress = freeze?.factory;
  let startBlock = freeze?.factoryStartBlock;
  if (!factoryAddress) {
    const manifestPath = path.resolve(
      String(process.env.ROBINHOOD_STAGE_DEPLOYMENT_FILE || "deployments/robinhood/testnet.staged.json"),
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    factoryAddress = manifest.contracts.launchFactory;
    startBlock = Number(manifest.deploymentBlock || 0);
  }
  const campaignAddress = process.argv[2] || process.env.ROBINHOOD_CONTINUITY_CAMPAIGN || "";
  const databaseUrl = resolveRobinhoodAcceptanceDatabaseUrl(process.env);
  indexRobinhoodTestnetAcceptance({
    databaseUrl,
    rpcUrl: String(process.env.ROBINHOOD_TESTNET_RPC_URL || process.env.ROBINHOOD_RPC_HTTP_46630 || "").trim(),
    factoryAddress,
    startBlock: Number(startBlock || 0),
  })
    .then(async (result) => {
      console.log("[robinhood-index] indexed 46630 factory campaigns", result);
      const targets = campaignAddress ? [campaignAddress] : result.indexed;
      for (const campaign of targets) {
        await proveIndexedRobinhoodCampaign({ databaseUrl, campaignAddress: campaign });
      }
      const continuity = {
        ok: true,
        no56Alias: true,
        chainId: 46630,
        factory: factoryAddress,
        factoryStartBlock: Number(startBlock || 0),
        indexed: result.indexed,
        reason: "indexed from chain 46630 with no 56 alias",
      };
      const continuityOut = String(
        process.env.ROBINHOOD_5C_CONTINUITY_RESULT_FILE || path.join(root, "reports/robinhood-testnet-acceptance-5c.continuity.json"),
      ).trim();
      if (freeze) {
        fs.mkdirSync(path.dirname(continuityOut), { recursive: true });
        fs.writeFileSync(continuityOut, `${JSON.stringify(continuity, null, 2)}\n`);
      }
      console.log("Robinhood indexer continuity passed: chain_id=46630 with no 56 alias");
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
