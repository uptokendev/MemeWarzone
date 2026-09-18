#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const must = (text, pattern, label) => {
  const ok = typeof pattern === "string" ? text.includes(pattern) : pattern.test(text);
  if (!ok) throw new Error(`SOURCE GATE: missing ${label}`);
};
const forbid = (text, pattern, label) => {
  const hit = typeof pattern === "string" ? text.includes(pattern) : pattern.test(text);
  if (hit) throw new Error(`SOURCE GATE: forbidden ${label}`);
};

const evm = read("realtime-indexer/src/indexer.ts");
const topaz = read("realtime-indexer/src/topazPoolIndexer.ts");
const solana = read("realtime-indexer/src/solanaIndexer.ts");
const meteora = read("realtime-indexer/src/meteoraSwapIndexer.ts");
const abis = read("realtime-indexer/src/abis.ts");
const indexerSchema = read("db/migrations/003_indexer.sql");
const baseSchema = read("db/migrations/001_init.sql");
const socialSchema = read("db/migrations/002_social.sql");
const continuity = read("db/migrations/202607290001_war_trade_room_market_continuity_foundation.sql");

must(evm, /export async function runIndexerOnce/, "BNB one-pass indexer entrypoint");
must(evm, /campaign:\$\{campaign\.toLowerCase\(\)\}/, "BNB campaign cursor");
must(evm, /greatest\(public\.indexer_state\.last_indexed_block,\s*excluded\.last_indexed_block\)/, "BNB monotonic cursor");
must(evm, /on conflict \(chain_id,tx_hash,log_index\)/, "BNB bonding event idempotency");
must(abis, /TokensPurchased/, "BNB bonding BUY event ABI");
must(abis, /TokensSold/, "BNB bonding SELL event ABI");

must(topaz, /export async function runTopazPoolIndexerOnce/, "Topaz one-pass entrypoint");
must(topaz, /on conflict\(chain_id,tx_hash,log_index\) do nothing/, "Topaz duplicate suppression");
must(topaz, /if \(!inserted\.rowCount\) return false/, "Topaz derived-effect duplicate guard");
must(topaz, /last_indexed_block/, "Topaz persisted pool cursor");
must(abis, /event Swap/, "Topaz Swap event ABI");
must(abis, /event Sync/, "Topaz Sync event ABI");

must(solana, /export async function runSolanaIndexerOnce/, "Solana one-pass bonding entrypoint");
must(solana, /on conflict \(chain_id,tx_hash,log_index\) do nothing/, "Solana bonding duplicate suppression");
must(meteora, /export async function runMeteoraSwapIndexerOnce/, "Meteora one-pass entrypoint");
must(meteora, /const SOLANA_CHAIN_ID = 101/, "canonical Solana application chain 101");
must(meteora, /solana:meteora:\$\{poolAddress\}/, "Meteora pool cursor");
must(meteora, /greatest\(public\.indexer_state\.last_indexed_block,excluded\.last_indexed_block\)/, "Meteora monotonic cursor");
must(meteora, /if \(\(inserted\.rowCount \?\? 0\) === 0\) return/, "Meteora derived-effect duplicate guard");

must(indexerSchema, /PRIMARY KEY \(chain_id, cursor\)/, "chain-scoped indexer-state primary key");
must(indexerSchema, /PRIMARY KEY \(chain_id, tx_hash, log_index\)/, "chain-scoped bonding-trade primary key");
must(baseSchema, /UNIQUE \(chain_id, tx_hash, log_index\)/, "chain-scoped activity-event identity");
must(baseSchema, /PRIMARY KEY \(chain_id, checkpoint_key\)/, "chain-scoped checkpoint identity");
must(socialSchema, /PRIMARY KEY \(chain_id, campaign_address\)/, "chain-scoped campaign identity");
must(continuity, /primary key\(chain_id,pair_address\)/i, "chain-scoped post-grad pool identity");
must(continuity, /primary key\(chain_id,tx_hash,log_index\)/i, "chain-scoped post-grad trade identity");
must(continuity, /primary key\(chain_id,campaign_address\)/i, "chain-scoped normalized-market identity");
must(continuity, /trade_intents_tx_uidx[\s\S]*\(chain_id,transaction_hash\)/i, "chain-scoped trade-intent transaction identity");

for (const certPath of [
  ".github/workflows/agent5-nonarena-indexer-cert.yml",
  "scripts/certification/agent5-indexer-worker.mjs",
  "scripts/certification/agent5-indexer-restart-cert.mjs",
  "scripts/certification/agent5-chain-isolation-cert.mjs",
  "scripts/certification/agent5-rpc-cutoff-proxy.mjs",
]) {
  const full = path.join(root, certPath);
  if (!fs.existsSync(full)) continue;
  const value = fs.readFileSync(full, "utf8");
  forbid(value, /https?:\/\/[^\s"']*blockpi/i, "hard-coded BlockPI endpoint");
  forbid(value, /native:102/, "legacy Solana 102 quote identity");
  forbid(value, /SOLANA_APPLICATION_CHAIN_ID[^\n]*102/, "legacy Solana application chain 102");
}

console.log(JSON.stringify({
  result: "PASS",
  sourceAuthority: process.env.GITHUB_SHA || process.env.MEMEWARZONE_SOURCE_SHA || null,
  assertions: {
    bnbBondingRestartPrimitive: true,
    bnbBondingIdempotency: true,
    bnbTopazRestartPrimitive: true,
    bnbTopazDerivedEffectIdempotency: true,
    solanaBondingRestartPrimitive: true,
    solanaBondingIdempotency: true,
    solanaMeteoraRestartPrimitive: true,
    solanaMeteoraDerivedEffectIdempotency: true,
    chainScopedPrimaryKeys: true,
    blockpiCredentialAbsentFromCertificationSource: true,
    legacySolana102AbsentFromCertificationSource: true,
  },
}, null, 2));
