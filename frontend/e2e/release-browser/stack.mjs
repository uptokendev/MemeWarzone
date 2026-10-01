#!/usr/bin/env node
/**
 * Local stack for the release browser test: API (3001), indexer (3002), vite (5173) against a local
 * Postgres (staging schema + this release's migrations), EVM testnets 46630 / 97 and Solana devnet.
 * Secrets are read from the operator's files at start and passed only through the child env; nothing
 * is written into the repo. Refuses to start if any configured RPC is not the expected test network.
 *
 *   node frontend/e2e/release-browser/stack.mjs          # start all, logs in ~/mwz-browser/logs
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(here, "../..");
const repoRoot = path.resolve(frontendDir, "..");
const indexerDir = path.join(repoRoot, "realtime-indexer");
const HOME = os.homedir();
const MAIN_REPO = process.env.MWZ_MAIN_REPO || "/mnt/e/network/Zakelijk/MemeWarzone";
const WORK = process.env.MWZ_BROWSER_WORK || path.join(HOME, "mwz-browser");
const LOGS = path.join(WORK, "logs");
fs.mkdirSync(LOGS, { recursive: true });

function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const rootEnv = readEnvFile(path.join(MAIN_REPO, ".env"));
const rhLocal = readEnvFile(path.join(MAIN_REPO, "config/robinhood.local"));
const devnetDir = path.join(HOME, ".config/memewarzone/solana-devnet");
const dbcKeys = JSON.parse(fs.readFileSync(path.join(devnetDir, "dbc-rehearsal/keys.json"), "utf8"));
const devnetDeployer = JSON.parse(fs.readFileSync(path.join(devnetDir, "deployer.json"), "utf8"));
const wallets = JSON.parse(fs.readFileSync(path.join(WORK, "wallets.json"), "utf8"));

const RH_RPC = rhLocal.ROBINHOOD_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com";
const BSC_RPC = rootEnv.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545";
// The public devnet endpoint rate-limits (429) under the indexer + browser; the keyed Helius account
// also serves devnet. Only its devnet host is used, and the genesis hash is checked below.
const heliusKey = (readEnvFile(path.join(MAIN_REPO, "frontend/.env.local")).SOLANA_RPC_URL || "").match(/api-key=([^&]+)/)?.[1];
const SOL_RPC = process.env.MWZ_DEVNET_RPC || (heliusKey ? `https://devnet.helius-rpc.com/?api-key=${heliusKey}` : "https://api.devnet.solana.com");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const ROUTE_KEY = rootEnv.ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY;
if (!ROUTE_KEY) throw new Error("ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY missing");

async function rpc(url, method, params = []) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
if (Number(await rpc(RH_RPC, "eth_chainId")) !== 46630) throw new Error("RH RPC is not 46630");
if (Number(await rpc(BSC_RPC, "eth_chainId")) !== 97) throw new Error("BSC RPC is not 97");
if ((await rpc(SOL_RPC, "getGenesisHash")) !== DEVNET_GENESIS) throw new Error("Solana RPC is not devnet");

const rh = JSON.parse(fs.readFileSync(path.join(repoRoot, "deployments/robinhood/testnet.gen6b.json"), "utf8"));
const bsc = JSON.parse(fs.readFileSync(path.join(repoRoot, "deployments/bscTestnet/testnet.gen6.json"), "utf8"));
const RH_OLD_FACTORY = "0xde9f7055f768A6A1AFBCD5263be64961241927a4";
const RH_OLD_START = "123211064";
const BSC_OLD_FACTORY = "0xFb8159f46BAB4e214F658c2c8f5CfF76C102E848";
const BSC_OLD_START = process.env.MWZ_BSC_OLD_FACTORY_START || "0";

const C46630 = {
  FACTORY: rh.generation.deployed.LaunchFactory,
  START: String(rh.factoryStartBlock),
  CAMPAIGN_IMPLEMENTATION: rh.generation.deployed.LaunchCampaignImplementation,
  TREASURY_ROUTER: rh.fees.router,
  TREASURY_VAULT: rh.fees.reusedVaults.weekly,
  RECRUITER_REWARDS_VAULT: rh.fees.reusedVaults.recruiter,
  COMMUNITY_REWARDS_VAULT: rh.fees.communityRewardsVault,
  PROTOCOL_REVENUE_VAULT: rh.fees.reusedVaults.protocol,
  CREATOR_REGISTRY: rh.generation.registries.creatorRegistry,
  RISK_REGISTRY: rh.generation.registries.riskRegistry,
  GRADUATION_ORACLE: rh.generation.reused.graduationOracle,
  PERMANENT_LP_LOCKER: rh.generation.deployed.PermanentV3PositionLocker,
  VOTE_TREASURY: "0xEEEfa12B14ea922B21bAf05Ad4aa79B2643c8eA6",
  CREATOR_VAULT: rh.fees.creatorRewardsVaultV2,
  WRAPPED_NATIVE: rh.v3Stack.weth,
  V3_FACTORY: rh.v3Stack.v3Factory,
  V3_PM: rh.v3Stack.positionManager,
  V3_ROUTER: rh.v3Stack.swapRouter02,
  SWAP_ADAPTER: rh.generation.deployed.RobinhoodV3NativeSwapAdapter,
};
const g = bsc.generation;
const C97 = {
  FACTORY: g.contracts.BnbBasicLaunchFactory,
  START: String(bsc.factoryStartBlock),
  CAMPAIGN_IMPLEMENTATION: g.contracts.LaunchCampaignImplementation,
  TREASURY_ROUTER: bsc.fees.router,
  TREASURY_VAULT: bsc.fees.reusedVaults.weekly,
  RECRUITER_REWARDS_VAULT: bsc.fees.reusedVaults.recruiter,
  COMMUNITY_REWARDS_VAULT: bsc.fees.communityRewardsVault,
  PROTOCOL_REVENUE_VAULT: bsc.fees.reusedVaults.protocol,
  CREATOR_REGISTRY: g.inputs.creatorRegistry,
  RISK_REGISTRY: g.inputs.riskRegistry,
  GRADUATION_ORACLE: bsc.graduationOracle,
  PERMANENT_LP_LOCKER: g.contracts.PermanentLpLocker,
  VOTE_TREASURY: g.contracts.PostGradLeagueTreasuryV2,
  CREATOR_VAULT: bsc.fees.creatorRewardsVaultV2,
};

function evmAppEnv(id, c) {
  const e = {};
  for (const k of ["FACTORY", "CAMPAIGN_IMPLEMENTATION", "TREASURY_ROUTER", "TREASURY_VAULT", "RECRUITER_REWARDS_VAULT", "COMMUNITY_REWARDS_VAULT", "PROTOCOL_REVENUE_VAULT", "CREATOR_REGISTRY", "RISK_REGISTRY", "GRADUATION_ORACLE", "PERMANENT_LP_LOCKER", "VOTE_TREASURY"]) {
    e[`VITE_${k}_ADDRESS_${id}`] = c[k];
    // Plain VOTE_TREASURY_* would make the indexer scan a contract that is not a vote treasury.
    if (k !== "VOTE_TREASURY") e[`${k}_ADDRESS_${id}`] = c[k];
  }
  return e;
}

const keeperKey = "0x" + crypto.createHash("sha256").update("mwz-release-browser-keeper-" + wallets.evm.graduator.pk).digest("hex");
const API = "http://127.0.0.1:3001";
const IDX = "http://127.0.0.1:3002";
const DB = process.env.MWZ_BROWSER_DB || "postgres://postgres@127.0.0.1:55440/mwz";

const common = {
  DATABASE_URL: DB,
  PG_DISABLE_SSL: "1",
  DEPLOYMENT_NETWORK: "testnet",
  NODE_ENV: "development",
  // chains
  ROBINHOOD_RPC_HTTP_46630: RH_RPC,
  ROBINHOOD_TESTNET_RPC_URL: RH_RPC,
  BSC_RPC_HTTP_97: BSC_RPC,
  BSC_TESTNET_RPC: BSC_RPC,
  BSC_RPC_HTTP_56: "",
  ROBINHOOD_RPC_HTTP_4663: "",
  ROBINHOOD_MAINNET_RPC_URL: "",
  BSC_MAINNET_RPC: "",
  SOLANA_RPC_URL: SOL_RPC,
  SOLANA_RPC_HTTP: SOL_RPC,
  SOLANA_CLUSTER: "devnet",
  ENABLE_TESTNET_CAMPAIGNS: "true",
  VITE_ENABLE_TESTNET_CAMPAIGNS: "true",
  DEFAULT_EVM_CHAIN_ID: "46630",
  EVM_INDEXER_CHAIN_IDS: "97,46630",
  ...evmAppEnv(46630, C46630),
  ...evmAppEnv(97, C97),
  FACTORY_START_BLOCK_46630: C46630.START,
  FACTORY_START_BLOCK_97: C97.START,
  SUPPORTED_FACTORY_ADDRESSES_46630: `${C46630.FACTORY},${RH_OLD_FACTORY}`,
  SUPPORTED_FACTORY_START_BLOCKS_46630: `${C46630.START},${RH_OLD_START}`,
  SUPPORTED_FACTORY_ADDRESSES_97: `${C97.FACTORY},${BSC_OLD_FACTORY}`,
  SUPPORTED_FACTORY_START_BLOCKS_97: `${C97.START},${BSC_OLD_START}`,
  EVM_GEN5_FACTORIES_46630: C46630.FACTORY,
  EVM_GEN5_FACTORIES_97: C97.FACTORY,
  EVM_CREATOR_VAULT_V2_46630: `${C46630.CREATOR_VAULT}@${C46630.START}`,
  EVM_CREATOR_VAULT_V2_97: `${C97.CREATOR_VAULT}@${C97.START}`,
  EVM_GEN5_LP_LOCKERS_46630: `${C46630.PERMANENT_LP_LOCKER}@${C46630.START}`,
  EVM_GEN5_LP_LOCKERS_97: `${C97.PERMANENT_LP_LOCKER}@${C97.START}`,
  TREASURY_ROUTERS_EXTRA_46630: `${C46630.TREASURY_ROUTER}@${C46630.START}`,
  TREASURY_ROUTERS_EXTRA_97: `${C97.TREASURY_ROUTER}@${C97.START}`,
  // route authority (testnet signer 0x2501...Bde0)
  ROUTE_AUTHORITY_PRIVATE_KEY: ROUTE_KEY,
  ENABLE_TEST_GRADUATION_THRESHOLD: "true",
  VITE_ENABLE_TEST_GRADUATION_THRESHOLD: "true",
  // DBC devnet
  DBC_LAUNCH_ENABLED: "true",
  DBC_CONFIG_PAYER_SECRET: JSON.stringify(devnetDeployer),
  DBC_FEE_COLLECTOR: "",
  SOLANA_ROUTE_SIGNER_SECRET_KEY: crypto.randomBytes(32).toString("hex"),
  // isolation
  LOCAL_DISABLE_ABLY: "1",
  LOCAL_DISABLE_REMOTE_SUPABASE: "1",
  ENABLE_DATA_URL_UPLOADS: "1",
  TELEMETRY_INGEST_URL: "",
  TELEMETRY_TOKEN: "",
  ABLY_API_KEY: "",
};

// Fee collector pubkey from the rehearsal partner key (public part of a 64-byte secret).
{
  const { Keypair } = await import(path.join(frontendDir, "node_modules/@solana/web3.js/lib/index.cjs.js"));
  common.DBC_FEE_COLLECTOR = Keypair.fromSecretKey(Uint8Array.from(dbcKeys.partner)).publicKey.toBase58();
}

const indexerEnv = {
  ...common,
  RUNTIME_ENVIRONMENT: "local",
  PORT: "3002",
  ENABLE_SOLANA_MARKET_STATS: "0",
  // The old launchpad program is not under test; point its indexer at an unused key so it does not
  // spend the shared public devnet RPC quota the DBC screens need.
  SOLANA_LAUNCHPAD_PROGRAM_ID: "MwzReLeaseBrowserTest1111111111111111111111",
  ENABLE_TOPAZ_POOL_INDEXER: "0",
  ENABLE_GRADUATION_HANDOFF_RECONCILER: "0",
  ENABLE_CANONICAL_CANDLE_MATERIALIZER: "0",
  ENABLE_ROBINHOOD_V3_POOL_INDEXER: "1",
  // Without it the V3 pool indexer records router 0x0 for a graduated pool.
  ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_46630: C46630.V3_ROUTER,
  ROBINHOOD_V3_FACTORY_ADDRESS_46630: C46630.V3_FACTORY,
  WRAPPED_NATIVE_ADDRESS_46630: C46630.WRAPPED_NATIVE,
  EVM_GRADUATION_KEEPER_ENABLED_46630: "true",
  EVM_GRADUATION_KEEPER_ENABLED_97: "true",
  EVM_GRADUATION_KEEPER_SEND: "false",
  EVM_GRADUATION_KEEPER_PRIVATE_KEY: keeperKey,
  DBC_GRADUATION_ENABLED: "true",
  DBC_GRADUATION_SEND: "false",
  DBC_FEE_COLLECTOR_SECRET: JSON.stringify(dbcKeys.partner),
};

// MWZ_INDEXER_SKIP_97=1: index only 46630 (the public BSC testnet RPC rate-limits getLogs and its slow
// passes use up the shared pass deadline, which starves 46630's event ingestion).
if (process.env.MWZ_INDEXER_SKIP_97 === "1") indexerEnv.BSC_RPC_HTTP_97 = "";

const apiEnv = {
  ...common,
  RUNTIME_ENVIRONMENT: "local",
  PORT: "3001",
  API_RAILWAY_PROXY: "1",
  RAILWAY_API_BASE_URL: IDX,
  RAILWAY_INDEXER_URL: IDX,
  // Arena routes (battles, share card) for E6.
  POSTGRAD_API_ENABLED: "true",
};

const viteEnv = {
  ...common,
  VITE_RUNTIME_ENVIRONMENT: "staging",
  VITE_ALLOWED_CHAIN_IDS: "56,97,101,46630",
  VITE_DEFAULT_CHAIN_ID: "46630",
  VITE_PUBLIC_RPC_46630: RH_RPC,
  VITE_PUBLIC_RPC_97: BSC_RPC,
  VITE_BSC_TESTNET_RPC: BSC_RPC,
  VITE_BSC_RPC_97: BSC_RPC,
  VITE_SOLANA_CLUSTER: "devnet",
  VITE_SOLANA_RPC: SOL_RPC,
  VITE_SOLANA_DEVNET_RPC: SOL_RPC,
  VITE_PUBLIC_RPC_101: SOL_RPC,
  VITE_PUBLIC_RPC_SOLANA: SOL_RPC,
  VITE_SOLANA_MAINNET_RPC: SOL_RPC,
  VITE_DBC_LAUNCH_ENABLED: "true",
  VITE_ENABLE_DIRECT_ROBINHOOD_DEPLOY: "true",
  VITE_ENABLE_DIRECT_BNB_DEPLOY: "true",
  VITE_ENABLE_TESTNET_FEATURED_FEED: "true",
  VITE_ENABLE_ONCHAIN_CAMPAIGN_FALLBACK: "true",
  VITE_ENABLE_ONCHAIN_TRADE_FALLBACK: "1",
  VITE_SUPPORTED_FACTORY_ADDRESSES_46630: common.SUPPORTED_FACTORY_ADDRESSES_46630,
  VITE_SUPPORTED_FACTORY_START_BLOCKS_46630: common.SUPPORTED_FACTORY_START_BLOCKS_46630,
  VITE_SUPPORTED_FACTORY_ADDRESSES_97: common.SUPPORTED_FACTORY_ADDRESSES_97,
  VITE_SUPPORTED_FACTORY_START_BLOCKS_97: common.SUPPORTED_FACTORY_START_BLOCKS_97,
  VITE_TOPAZ_ROUTER_ADDRESS_97: bsc.topaz.router,
  VITE_TOPAZ_FACTORY_ADDRESS_97: bsc.topaz.poolFactory,
  VITE_TOPAZ_WBNB_ADDRESS_97: bsc.topaz.wbnb,
  VITE_WRAPPED_NATIVE_ADDRESS_46630: C46630.WRAPPED_NATIVE,
  VITE_ROBINHOOD_V3_FACTORY_ADDRESS_46630: C46630.V3_FACTORY,
  VITE_ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_46630: C46630.V3_ROUTER,
  VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_ADDRESS_46630: C46630.SWAP_ADAPTER,
  VITE_ENABLE_POSTGRAD: "true",
  VITE_ENABLE_POSTGRAD_ARENA: "true",
  VITE_ENABLE_POSTGRAD_BATTLE: "true",
  VITE_FRONTEND_API_BASE: API,
  VITE_RAILWAY_FRONTEND_API_BASE: API,
  VITE_TOKEN_API_BASE: API,
  VITE_REALTIME_API_BASE: API,
  VITE_API_BASE: API,
  VITE_DEV_API_PORT: "3001",
  VITE_DEV_API_PROXY_TARGET: API,
  // secrets never reach vite
  ROUTE_AUTHORITY_PRIVATE_KEY: "",
  DBC_CONFIG_PAYER_SECRET: "",
  SOLANA_ROUTE_SIGNER_SECRET_KEY: "",
};

const only = process.argv.slice(2);
const children = [];
function start(name, cmd, args, cwd, env) {
  if (only.length && !only.includes(name)) return;
  const out = fs.openSync(path.join(LOGS, `${name}.log`), "a");
  const child = spawn(cmd, args, { cwd, env: { PATH: process.env.PATH, HOME, ...env }, stdio: ["ignore", out, out], detached: true });
  fs.writeFileSync(path.join(LOGS, `${name}.pid`), String(child.pid));
  children.push(child);
  console.log(`[stack] ${name} pid ${child.pid} -> ${path.join(LOGS, name + ".log")}`);
}

start("indexer", "npx", ["tsx", "--import", "./src/tokenSidePreload.ts", "--import", "./src/wtrPreload.ts", "src/main.ts"], indexerDir, indexerEnv);
start("api", "node", ["--import", "./api/load-local-env.mjs", "api/server.mjs"], frontendDir, apiEnv);
start("vite", "npx", ["vite", "--host", "127.0.0.1", "--port", "5173", "--strictPort"], frontendDir, viteEnv);
for (const c of children) c.unref();
spawnSync("true");
