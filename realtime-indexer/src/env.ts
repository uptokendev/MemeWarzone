import "dotenv/config";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function firstEnv(...names: string[]): string {
  for (const name of names) {
    const v = String(process.env[name] || "").trim();
    if (v) return v;
  }
  return "";
}

function csvEnv(...names: string[]): string[] {
  const value = firstEnv(...names);
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export const ENV = {
  DATABASE_URL: req("DATABASE_URL"),
  ABLY_API_KEY: req("ABLY_API_KEY"),

  BSC_RPC_HTTP_97: process.env.BSC_RPC_HTTP_97 || "",
  BSC_RPC_HTTP_56: process.env.BSC_RPC_HTTP_56 || "",
  DEPLOYMENT_NETWORK: String(process.env.DEPLOYMENT_NETWORK || "mainnet").toLowerCase(),
  DEFAULT_EVM_CHAIN_ID: Number(process.env.DEFAULT_EVM_CHAIN_ID || (String(process.env.DEPLOYMENT_NETWORK || "mainnet").toLowerCase() === "testnet" ? 97 : 56)),

  // Creation resolves only against the accepted active factory. The former
  // scheduled-slot factory is never a fallback creation target.
  FACTORY_ADDRESS_97: firstEnv("FACTORY_ADDRESS_97", "VITE_FACTORY_ADDRESS_97", "FACTORY_ADDRESS", "VITE_FACTORY_ADDRESS"),
  FACTORY_ADDRESS_56: firstEnv("FACTORY_ADDRESS_56", "VITE_FACTORY_ADDRESS_56", "FACTORY_ADDRESS", "VITE_FACTORY_ADDRESS"),

  // Support inventory is deliberately separate from the one active creation
  // factory. Old factories remain readable and their campaigns continue to be
  // scanned through the campaigns table. Generation-aware factory discovery
  // should use this inventory with one checkpoint per address.
  SUPPORTED_FACTORY_ADDRESSES_97: csvEnv("SUPPORTED_FACTORY_ADDRESSES_97", "VITE_SUPPORTED_FACTORY_ADDRESSES_97"),
  SUPPORTED_FACTORY_START_BLOCKS_97: csvEnv("SUPPORTED_FACTORY_START_BLOCKS_97", "VITE_SUPPORTED_FACTORY_START_BLOCKS_97").map((value) => Number(value || 0)),
  SUPPORTED_FACTORY_ADDRESSES_56: csvEnv("SUPPORTED_FACTORY_ADDRESSES_56", "VITE_SUPPORTED_FACTORY_ADDRESSES_56"),
  SUPPORTED_FACTORY_START_BLOCKS_56: csvEnv("SUPPORTED_FACTORY_START_BLOCKS_56", "VITE_SUPPORTED_FACTORY_START_BLOCKS_56").map((value) => Number(value || 0)),

  SOLANA_RPC_HTTP: process.env.SOLANA_RPC_HTTP || "",
  SOLANA_LAUNCHPAD_PROGRAM_ID: process.env.SOLANA_LAUNCHPAD_PROGRAM_ID || "",
  SOLANA_START_SLOT: Number(process.env.SOLANA_START_SLOT || 0),
  SOLANA_LOOKBACK_SLOTS: Number(process.env.SOLANA_LOOKBACK_SLOTS || 50_000),
  SOLANA_SIGNATURE_LIMIT: Number(process.env.SOLANA_SIGNATURE_LIMIT || 500),
  SOLANA_SIGNATURE_PAGE_LIMIT: Number(process.env.SOLANA_SIGNATURE_PAGE_LIMIT || 5),
  SOLANA_INDEXER_INTERVAL_MS: Number(process.env.SOLANA_INDEXER_INTERVAL_MS || 10_000),
  SOLANA_FEE_ESCROW_WORKER_INTERVAL_MS: Number(process.env.SOLANA_FEE_ESCROW_WORKER_INTERVAL_MS || 15_000),
  SOLANA_FEE_ESCROW_FLUSH_THRESHOLD_LAMPORTS: process.env.SOLANA_FEE_ESCROW_FLUSH_THRESHOLD_LAMPORTS || "10000000",
  SOLANA_FEE_ESCROW_FLUSH_MAX_AGE_MS: Number(process.env.SOLANA_FEE_ESCROW_FLUSH_MAX_AGE_MS || 120_000),

  // UPVoteTreasury addresses (optional; if not set, vote indexing is disabled for that chain)
  VOTE_TREASURY_ADDRESS_97: firstEnv("VOTE_TREASURY_ADDRESS_97", "VITE_VOTE_TREASURY_ADDRESS_97", "VOTE_TREASURY_ADDRESS", "VITE_VOTE_TREASURY_ADDRESS"),
  VOTE_TREASURY_ADDRESS_56: firstEnv("VOTE_TREASURY_ADDRESS_56", "VITE_VOTE_TREASURY_ADDRESS_56", "VOTE_TREASURY_ADDRESS", "VITE_VOTE_TREASURY_ADDRESS"),

  // Indexing window controls
  FACTORY_START_BLOCK_97: Number(process.env.FACTORY_START_BLOCK_97 || 0),
  FACTORY_START_BLOCK_56: Number(process.env.FACTORY_START_BLOCK_56 || 0),

  // VoteTreasury start blocks (optional; if not set, fallback to latest - LOOKBACK)
  VOTE_TREASURY_START_BLOCK_97: Number(process.env.VOTE_TREASURY_START_BLOCK_97 || 0),
  VOTE_TREASURY_START_BLOCK_56: Number(process.env.VOTE_TREASURY_START_BLOCK_56 || 0),
  // If FACTORY_START_BLOCK_* is not set, we fallback to (latest - FACTORY_LOOKBACK_BLOCKS)
  FACTORY_LOOKBACK_BLOCKS: Number(process.env.FACTORY_LOOKBACK_BLOCKS || 250000),

  // Log scanning chunk sizes (smaller = slower but friendlier to free RPC tiers).
  // BlockPI / public Chapel nodes are happier with 500 than 1000.
  LOG_CHUNK_SIZE: Number(process.env.LOG_CHUNK_SIZE || "500"),
  // When we need to split ranges due to public RPC limits, don't split below this span.
  MIN_LOG_CHUNK_SIZE: Number(process.env.MIN_LOG_CHUNK_SIZE || "50"),

  // Optional daily repair job settings
  REPAIR_LOOKBACK_BLOCKS: Number(process.env.REPAIR_LOOKBACK_BLOCKS || 20000),
  REPAIR_REWIND_BLOCKS: Number(process.env.REPAIR_REWIND_BLOCKS || 200),

  // Poll interval for the always-on indexer loop in server.ts
  // NOTE: Testnet UX benefits from lower latency; tune up for mainnet / free RPCs.
  INDEXER_INTERVAL_MS: Number(process.env.INDEXER_INTERVAL_MS || 10000),
  // Factory discovery (registry + CampaignCreated logs) is heavier than trade ticks —
  // do not share the aggressive trade interval on free RPCs.
  FACTORY_DISCOVERY_INTERVAL_MS: Number(process.env.FACTORY_DISCOVERY_INTERVAL_MS || 60000),
  // If a single pass holds the lock longer than this, the next loop tick takes over.
  // Previously only *manual* jobs could take over — a wedged normal pass blocked forever.
  INDEXER_STALE_AFTER_MS: Number(process.env.INDEXER_STALE_AFTER_MS || 90000),
  // Cap historical catch-up per campaign per tick so 3 campaigns never monopolize RPC
  // for 20+ minutes (which left TTA tip trades invisible).
  INDEXER_CAMPAIGN_BLOCKS_PER_PASS: Number(process.env.INDEXER_CAMPAIGN_BLOCKS_PER_PASS || "8000"),
  // Always re-scan this recent tip every tick for live trades, even when the historical
  // cursor is far behind (does not advance the historical cursor past holes).
  // Keep wide enough that a buy from ~1h ago on Chapel (~3s blocks) still lands
  // in the tip window while history catch-up is lagging (TTA trade aged out of 3k).
  INDEXER_TIP_SCAN_BLOCKS: Number(process.env.INDEXER_TIP_SCAN_BLOCKS || "20000"),
  // "campaigns" (default): trade/finalize log scans only — factory discovery has its own loop.
  // "core": factory registry + campaign trades (heavier; can starve tip scans on small RPC budgets).
  // "full": factory/vote/router + campaigns. "factory": registry only.
  INDEXER_NORMAL_SCOPE: process.env.INDEXER_NORMAL_SCOPE || "campaigns",
  // 100ms is enough spacing for BlockPI; 400ms made 250k-block catch-ups take forever.
  INDEXER_LOG_CALL_DELAY_MS: Number(process.env.INDEXER_LOG_CALL_DELAY_MS || 100),
  // eth_getLogs on free tiers often exceeds 12s under load — default 30s.
  RPC_REQUEST_TIMEOUT_MS: Number(process.env.RPC_REQUEST_TIMEOUT_MS || 30000),

  // Lower default confirmations for faster UI updates (especially on testnet).
  CONFIRMATIONS: Number(process.env.CONFIRMATIONS || "1"),

  // Optional telemetry (recommended). If not set, telemetry is disabled.
  TELEMETRY_INGEST_URL: process.env.TELEMETRY_INGEST_URL || "https://memebattles-telemetry-production.up.railway.app/ingest",
  TELEMETRY_TOKEN: process.env.TELEMETRY_TOKEN || "",
  TELEMETRY_INTERVAL_MS: Number(process.env.TELEMETRY_INTERVAL_MS || "15000"),

  RANK_EVENTS_TOKEN: process.env.RANK_EVENTS_TOKEN || "",
  REWARD_REMINDER_WEBHOOK_URL: process.env.REWARD_REMINDER_WEBHOOK_URL || "",
  REWARD_REMINDER_RETRY_BACKOFF_MS: Number(process.env.REWARD_REMINDER_RETRY_BACKOFF_MS || "3600000"),
  ROUTE_AUTHORITY_PRIVATE_KEY: process.env.ROUTE_AUTHORITY_PRIVATE_KEY || "",
  ROUTE_AUTH_SIGNATURE_TTL_SECONDS: Number(process.env.ROUTE_AUTH_SIGNATURE_TTL_SECONDS || "300"),
  RECRUITER_LEADERBOARD_WEIGHT_LINKED_WALLETS: Number(process.env.RECRUITER_LEADERBOARD_WEIGHT_LINKED_WALLETS || "1"),
  RECRUITER_LEADERBOARD_WEIGHT_LINKED_CREATORS: Number(process.env.RECRUITER_LEADERBOARD_WEIGHT_LINKED_CREATORS || "3"),
  RECRUITER_LEADERBOARD_WEIGHT_LINKED_TRADERS: Number(process.env.RECRUITER_LEADERBOARD_WEIGHT_LINKED_TRADERS || "2"),
  RECRUITER_LEADERBOARD_WEIGHT_ROUTED_VOLUME_BNB: Number(process.env.RECRUITER_LEADERBOARD_WEIGHT_ROUTED_VOLUME_BNB || "0.05"),
  RECRUITER_LEADERBOARD_WEIGHT_TOTAL_EARNED_BNB: Number(process.env.RECRUITER_LEADERBOARD_WEIGHT_TOTAL_EARNED_BNB || "1"),
  AIRDROP_DRAW_SEED_SALT: process.env.AIRDROP_DRAW_SEED_SALT || "memewarzone-airdrops",
  AIRDROP_BASE_WINNER_COUNT: Number(process.env.AIRDROP_BASE_WINNER_COUNT || "1"),
  AIRDROP_WINNER_COUNT_PER_BNB: Number(process.env.AIRDROP_WINNER_COUNT_PER_BNB || "1"),
  AIRDROP_MAX_WINNER_COUNT: Number(process.env.AIRDROP_MAX_WINNER_COUNT || "25"),
  AIRDROP_WEIGHT_TIER_STEP_BNB: Number(process.env.AIRDROP_WEIGHT_TIER_STEP_BNB || "1"),
  AIRDROP_MAX_WEIGHT_TIER: Number(process.env.AIRDROP_MAX_WEIGHT_TIER || "25"),

  // War Trade Room market-continuity rollout. The handoff reconciler is safe to run
  // before the public API/chart/trading flags because it only verifies and records state.
  ENABLE_GRADUATION_HANDOFF_RECONCILER: String(process.env.ENABLE_GRADUATION_HANDOFF_RECONCILER || "1") === "1",
  // Default 60s (was 30s) — launched() polls are cheap; log scans are not.
  GRADUATION_HANDOFF_INTERVAL_MS: Number(process.env.GRADUATION_HANDOFF_INTERVAL_MS || "60000"),
  GRADUATION_HANDOFF_MAX_CAMPAIGNS: Number(process.env.GRADUATION_HANDOFF_MAX_CAMPAIGNS || "25"),
  // Recent tip window for CampaignFinalized eth_getLogs. Do NOT use FACTORY_LOOKBACK (250k).
  // ~20k blocks ≈ half a day on ~3s BSC blocks — enough to catch live graduations.
  GRADUATION_LOG_LOOKBACK_BLOCKS: Number(process.env.GRADUATION_LOG_LOOKBACK_BLOCKS || "20000"),
  // When campaigns.created_block is 0/null, never fall back to factory 250k lookback.
  GRADUATION_UNKNOWN_CREATED_LOOKBACK_BLOCKS: Number(
    process.env.GRADUATION_UNKNOWN_CREATED_LOOKBACK_BLOCKS || "12000",
  ),
  // After a miss (launched but no log in window), skip log scans for this campaign awhile.
  GRADUATION_SCAN_COOLDOWN_MS: Number(process.env.GRADUATION_SCAN_COOLDOWN_MS || "300000"),
  // Slice C defaults ON for postgrad/testnet continuity (durable dex_trades + market API).
  // Set explicitly to "0" on a host that must stay dark.
  ENABLE_UNIFIED_MARKET_API: String(process.env.ENABLE_UNIFIED_MARKET_API || "1") === "1",
  ENABLE_TOPAZ_POOL_INDEXER: String(process.env.ENABLE_TOPAZ_POOL_INDEXER || "1") === "1",
  ENABLE_UNIFIED_MARKET_CHART: String(process.env.ENABLE_UNIFIED_MARKET_CHART || "1") === "1",
  // Quote/trade kill-switches for the market-route API only; wallet still uses on-chain Topaz.
  ENABLE_TOPAZ_QUOTES: String(process.env.ENABLE_TOPAZ_QUOTES || "1") === "1",
  ENABLE_TOPAZ_TRADING: String(process.env.ENABLE_TOPAZ_TRADING || "1") === "1",

  PORT: Number(process.env.PORT || "3000"),
};
