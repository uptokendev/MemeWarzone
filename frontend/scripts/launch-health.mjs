import pg from "pg";
import { pathToFileURL } from "node:url";

const { Pool } = pg;
const TIMEOUT_MS = Math.max(1000, Number(process.env.LAUNCH_HEALTH_RPC_TIMEOUT_MS || 5000));

export function csvValues(...values) {
  return values.flatMap((value) => String(value || "").split(",")).map((value) => value.trim()).filter(Boolean);
}

export function rpcLabels(count) {
  return Array.from({ length: count }, (_, index) => (index === 0 ? "selected" : `fallback#${index}`));
}

export function launchHealthChainIds(env = process.env) {
  const bnb = Number(env.LAUNCH_HEALTH_BNB_CHAIN_ID || 56);
  const solana = Number(env.LAUNCH_HEALTH_SOLANA_CHAIN_ID || 101);
  const robinhood = Number(env.LAUNCH_HEALTH_ROBINHOOD_CHAIN_ID || 4663);
  if (![56, 97].includes(bnb)) throw new Error("unsupported BNB launch-health chain id");
  if (solana !== 101) throw new Error("unsupported Solana application chain id");
  if (![4663, 46630].includes(robinhood)) throw new Error("unsupported Robinhood launch-health chain id");
  return { bnb, solana, robinhood };
}

function bnbRpcCandidates(chainId) {
  if (chainId === 97) {
    return csvValues(
      process.env.BSC_RPC_HTTP_97,
      process.env.BSC_TESTNET_RPC_URL,
      process.env.BSC_TESTNET_RPC,
      process.env.VITE_BSC_TESTNET_RPC,
      process.env.VITE_PUBLIC_RPC_97,
    );
  }
  return csvValues(
    process.env.BSC_RPC_HTTP_56,
    process.env.BSC_MAINNET_RPC_URL,
    process.env.BSC_MAINNET_RPC,
    process.env.VITE_PUBLIC_RPC_56,
  );
}

function robinhoodRpcCandidates(chainId) {
  if (chainId === 46630) {
    return csvValues(
      process.env.ROBINHOOD_TESTNET_RPC_URL,
      process.env.ROBINHOOD_RPC_HTTP_46630,
      process.env.ROBINHOOD_RPC_URL_46630,
      process.env.VITE_PUBLIC_RPC_46630,
    );
  }
  return csvValues(
    process.env.ROBINHOOD_RPC_HTTP_4663,
    process.env.ROBINHOOD_RPC_URL_4663,
    process.env.VITE_PUBLIC_RPC_4663,
  );
}

async function rpcCall(url, method, params = []) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`http_${response.status}`);
    const payload = await response.json();
    if (payload?.error) throw new Error(`rpc_${payload.error.code ?? "error"}`);
    return payload?.result;
  } finally {
    clearTimeout(timer);
  }
}

function hexToNumber(value) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return null;
  const parsed = Number.parseInt(value, 16);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function checkEvmRpcSet(chainName, expectedChainId, urls) {
  const labels = rpcLabels(urls.length);
  const results = [];
  for (let index = 0; index < urls.length; index += 1) {
    try {
      const chainHex = await rpcCall(urls[index], "eth_chainId");
      const chainId = hexToNumber(chainHex);
      const head = hexToNumber(await rpcCall(urls[index], "eth_blockNumber"));
      results.push({ label: labels[index], ok: chainId === expectedChainId && head !== null, chainId, head });
    } catch {
      results.push({ label: labels[index], ok: false, chainId: null, head: null });
    }
  }
  const healthy = results.find((item) => item.ok) || null;
  return { chainName, expectedChainId, head: healthy?.head ?? null, results };
}

async function checkSolanaRpcSet(urls) {
  const labels = rpcLabels(urls.length);
  const results = [];
  for (let index = 0; index < urls.length; index += 1) {
    try {
      const slot = Number(await rpcCall(urls[index], "getSlot", [{ commitment: "confirmed" }]));
      const genesisHash = String(await rpcCall(urls[index], "getGenesisHash") || "");
      results.push({ label: labels[index], ok: Number.isSafeInteger(slot) && slot >= 0 && Boolean(genesisHash), slot });
    } catch {
      results.push({ label: labels[index], ok: false, slot: null });
    }
  }
  const healthy = results.find((item) => item.ok) || null;
  return { slot: healthy?.slot ?? null, results };
}

function dbConfigFromUrl(rawUrl) {
  const url = new URL(rawUrl);
  const sslDisabled = String(process.env.PG_DISABLE_SSL || "").trim() === "1";
  const allowSelfSigned = String(process.env.PG_SSL_ALLOW_SELF_SIGNED || "").trim() === "1";
  let ssl = false;
  if (!sslDisabled) {
    const b64 = String(process.env.PG_CA_CERT_B64 || "").trim();
    const rawCa = String(process.env.PG_CA_CERT || "").trim();
    const ca = b64 ? Buffer.from(b64, "base64").toString("utf8") : rawCa.replace(/\\n/g, "\n");
    ssl = ca ? { ca, rejectUnauthorized: true, servername: url.hostname } : { rejectUnauthorized: !allowSelfSigned, servername: url.hostname };
  }
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username || ""),
    password: decodeURIComponent(url.password || ""),
    database: url.pathname.replace(/^\//, "") || "postgres",
    ssl,
    max: 1,
    connectionTimeoutMillis: 5000,
  };
}

async function relationExists(client, relation) {
  const result = await client.query("select to_regclass($1) as relation", [relation]);
  return Boolean(result.rows[0]?.relation);
}

async function dbSnapshot(heads, chainIds) {
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) return { ready: false, cursors: [], reconciliationErrors: null };
  const pool = new Pool(dbConfigFromUrl(databaseUrl));
  try {
    const client = await pool.connect();
    try {
      await client.query("select 1 as ok");
      const trackedChainIds = [chainIds.bnb, chainIds.solana, chainIds.robinhood];
      const cursorRows = await client.query(`
        select chain_id, cursor, last_indexed_block, updated_at
          from public.indexer_state
         where chain_id = any($1::int[])
         order by chain_id asc, updated_at desc nulls last
      `, [trackedChainIds]);

      const bestByChain = new Map();
      for (const row of cursorRows.rows) {
        const chainId = Number(row.chain_id);
        if (!bestByChain.has(chainId)) bestByChain.set(chainId, row);
      }

      const cursors = trackedChainIds.map((chainId) => {
        const row = bestByChain.get(chainId);
        const indexed = row ? Number(row.last_indexed_block || 0) : null;
        const head = heads[chainId] ?? null;
        return {
          chainId,
          cursor: row ? String(row.cursor) : null,
          indexed,
          lag: Number.isFinite(indexed) && Number.isFinite(head) ? Math.max(0, head - indexed) : null,
          updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
        };
      });

      let reconciliationErrors = 0;
      if (await relationExists(client, "public.reward_program_epoch_reconciliations")) {
        const result = await client.query(`
          select count(*)::int as count
            from public.reward_program_epoch_reconciliations
           where unallocated_event_amount <> 0 or overallocated_event_amount <> 0
        `);
        reconciliationErrors += Number(result.rows[0]?.count || 0);
      }
      if (await relationExists(client, "public.solana_reward_payout_intents")) {
        const result = await client.query("select count(*)::int as count from public.solana_reward_payout_intents where status = 'failed'");
        reconciliationErrors += Number(result.rows[0]?.count || 0);
      }

      return { ready: true, cursors, reconciliationErrors };
    } finally {
      client.release();
    }
  } catch {
    return { ready: false, cursors: [], reconciliationErrors: null };
  } finally {
    await pool.end().catch(() => {});
  }
}

function renderRpcStatuses(results) {
  if (!results.length) return "not_configured";
  return results.map((item) => {
    const head = item.head ?? item.slot;
    const suffix = Number.isFinite(head) ? ` head=${head}` : "";
    return `${item.label}:${item.ok ? "OK" : "FAIL"}${suffix}`;
  }).join(" ");
}

export async function collectLaunchHealth() {
  const serviceSha = String(process.env.SOURCE_COMMIT || process.env.COOLIFY_GIT_COMMIT_SHA || process.env.GIT_SHA || "unset").trim() || "unset";
  const chainIds = launchHealthChainIds();
  const bnbUrls = bnbRpcCandidates(chainIds.bnb);
  const robinhoodUrls = robinhoodRpcCandidates(chainIds.robinhood);
  const solanaUrls = csvValues(process.env.SOLANA_RPC_URL_101, process.env.SOLANA_RPC_HTTP, process.env.SOLANA_RPC_URL, process.env.SOLANA_REWARDS_RPC_URL_101, process.env.SOLANA_REWARDS_RPC_URL);

  const [bnb, solana, robinhood] = await Promise.all([
    checkEvmRpcSet("BNB", chainIds.bnb, bnbUrls),
    checkSolanaRpcSet(solanaUrls),
    checkEvmRpcSet("ROBINHOOD", chainIds.robinhood, robinhoodUrls),
  ]);
  const db = await dbSnapshot({ [chainIds.bnb]: bnb.head, [chainIds.solana]: solana.slot, [chainIds.robinhood]: robinhood.head }, chainIds);
  return { serviceSha, chainIds, bnb, solana, robinhood, db };
}

export function renderLaunchHealth(snapshot) {
  const chainIds = snapshot.chainIds || { bnb: 56, solana: 101, robinhood: 4663 };
  const cursor = (chainId) => snapshot.db.cursors.find((item) => item.chainId === chainId) || {};
  const bnbCursor = cursor(chainIds.bnb);
  const solCursor = cursor(chainIds.solana);
  const rhCursor = cursor(chainIds.robinhood);
  return [
    `service_sha=${snapshot.serviceSha}`,
    `db_readiness=${snapshot.db.ready ? "READY" : "NOT_READY"}`,
    `bnb_chain_head=${snapshot.bnb.head ?? "unavailable"}`,
    `bnb_rpc=${renderRpcStatuses(snapshot.bnb.results)}`,
    `solana_slot=${snapshot.solana.slot ?? "unavailable"}`,
    `solana_rpc=${renderRpcStatuses(snapshot.solana.results)}`,
    `robinhood_chain_head=${snapshot.robinhood.head ?? "unavailable"}`,
    `robinhood_rpc=${renderRpcStatuses(snapshot.robinhood.results)}`,
    `indexer_bnb_cursor=${bnbCursor.indexed ?? "unavailable"} lag=${bnbCursor.lag ?? "unavailable"}`,
    `indexer_solana_cursor=${solCursor.indexed ?? "unavailable"} lag=${solCursor.lag ?? "unavailable"}`,
    `indexer_robinhood_cursor=${rhCursor.indexed ?? "unavailable"} lag=${rhCursor.lag ?? "unavailable"}`,
    `reconciliation_error_count=${snapshot.db.reconciliationErrors ?? "unavailable"}`,
  ].join("\n");
}

async function main() {
  const snapshot = await collectLaunchHealth();
  process.stdout.write(`${renderLaunchHealth(snapshot)}\n`);
  const rpcHealthy = [snapshot.bnb, snapshot.robinhood].every((chain) => chain.results.some((item) => item.ok)) && snapshot.solana.results.some((item) => item.ok);
  if (!snapshot.db.ready || !rpcHealthy || snapshot.db.reconciliationErrors === null) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch(() => {
    process.stdout.write("launch_health=FAILED\n");
    process.exitCode = 1;
  });
}
