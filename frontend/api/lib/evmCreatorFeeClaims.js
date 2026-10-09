// Creator fees on BNB (56) and Robinhood (4663): earned, claimed and still
// claimable per coin, from the two creator vaults.
//
// CreatorRewardsVault (gen-4, contracts/CreatorRewardsVault.sol) keeps exact
// running totals per campaign: lifetimeCreatorFees, claimedCreatorFees and
// pendingCreatorFees, all public getters. Its claims are not indexed, so they
// have amounts but no transaction links.
//
// CreatorRewardsVaultV2 (gen-6, and gen-7's own vault; contracts/CreatorRewardsVaultV2.sol) keeps no
// claimed total. Its events (TradeFeeAccrued, CreatorFeesClaimed,
// CreatorQuoteClaimed) are indexed by the realtime indexer into
// evm_campaign_events (contract_kind 'creator_vault', evm/evmGen5Aux.ts) with
// a cursor in indexer_state ('gen5-aux:<vault>'), and creatorBalance(campaign)
// is what the creator can claim now.
//
// Read-only: eth_call getters and SELECTs. Pure helpers are exported for tests.

import { id as keccakId } from "ethers";

export const V2_CLAIM_EVENTS = Object.freeze(["CreatorFeesClaimed", "CreatorQuoteClaimed", "TradeFeeAccrued"]);

/** eth_call data for a getter that takes one address. */
export function encodeAddressGetter(fn, address) {
  const selector = keccakId(`${fn}(address)`).slice(0, 10);
  return `${selector}${String(address).toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

function wordToRaw(hex) {
  const text = String(hex || "").trim();
  if (!/^0x[0-9a-fA-F]*$/.test(text)) throw new Error("Malformed getter return.");
  if (text === "0x") throw new Error("Empty getter return (no contract at that address?).");
  return BigInt(text.slice(0, 66)).toString();
}

function digits(value) {
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) ? text : "0";
}

const lower = (value) => String(value || "").toLowerCase();

/**
 * Groups indexed V2 vault events by campaign: native creator claims (with
 * transaction links), quote-token claims (counted apart, other asset) and the
 * creator part of each trade fee (earned).
 */
export function summarizeV2Events(rows, { vault } = {}) {
  const byCampaign = new Map();
  const get = (campaign) => {
    const key = lower(campaign);
    if (!byCampaign.has(key)) byCampaign.set(key, { claims: [], claimedRaw: 0n, earnedRaw: 0n, quoteClaims: 0 });
    return byCampaign.get(key);
  };
  for (const row of rows || []) {
    if (vault && row.contract_address && lower(row.contract_address) !== lower(vault)) continue;
    const args = typeof row.args === "string" ? safeJson(row.args) : row.args || {};
    const campaign = row.campaign_address || args.campaign;
    if (!campaign) continue;
    const c = get(campaign);
    if (row.event_name === "CreatorFeesClaimed") {
      const amount = BigInt(digits(args.amount));
      c.claimedRaw += amount;
      c.claims.push({
        at: row.block_time ? new Date(row.block_time).toISOString() : null,
        amountRaw: amount.toString(),
        txHash: row.tx_hash || null,
        logIndex: Number(row.log_index ?? 0),
        wallet: args.creator ? lower(args.creator) : null,
      });
    } else if (row.event_name === "TradeFeeAccrued") {
      c.earnedRaw += BigInt(digits(args.toCreator));
    } else if (row.event_name === "CreatorQuoteClaimed") {
      c.quoteClaims += 1;
    }
  }
  for (const c of byCampaign.values()) c.claims.sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")) || a.logIndex - b.logIndex);
  return byCampaign;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/**
 * Per-campaign getters on both vaults. `readEvmCall` is the fee-routing
 * reader ({urls, to, data, fetchImpl} -> {hex}). A vault address that is
 * missing is skipped; a failed read throws so the caller can report
 * "unknown" instead of a zero.
 */
export async function readEvmCreatorVaultCoins({ readEvmCall, urls, fetchImpl, v1, v2, campaigns }) {
  const call = async (to, fn, campaign) => wordToRaw((await readEvmCall({ urls, to, data: encodeAddressGetter(fn, campaign), fetchImpl })).hex);
  const out = [];
  for (const campaign of campaigns) {
    const row = { campaign, v1: null, v2: null };
    if (v1) {
      const [lifetime, claimed, pending] = await Promise.all([
        call(v1, "lifetimeCreatorFees", campaign),
        call(v1, "claimedCreatorFees", campaign),
        call(v1, "pendingCreatorFees", campaign),
      ]);
      row.v1 = { earnedRaw: lifetime, claimedRaw: claimed, claimableRaw: pending };
    }
    if (v2) row.v2 = { claimableRaw: await call(v2, "creatorBalance", campaign) };
    out.push(row);
  }
  return out;
}

// --------------------------------------------------------------------------
// On-demand V2 log read, for when the indexer started scanning after the vault
// was deployed (Robinhood: the indexer cursor began after the first trades).
// Bounded and cached: an incremental scan from the deploy block, at most
// MAX_LOG_REQUESTS calls per read, a vault re-scanned at most every 10 min.

/** Deploy blocks from deployments/<chain>/mainnet.evmgen-fees.json (deployBlocks.vault). */
export const CREATOR_VAULT_V2_DEPLOY_BLOCKS = Object.freeze({ 56: 125085249, 4663: 77308016 });

const V2_EVENT_SIGNATURES = Object.freeze({
  CreatorFeesClaimed: "CreatorFeesClaimed(address,address,uint256)",
  CreatorQuoteClaimed: "CreatorQuoteClaimed(address,address,address,uint256)",
  TradeFeeAccrued: "TradeFeeAccrued(address,uint256,uint256,uint256,uint256)",
});
export const V2_EVENT_TOPICS = Object.freeze(Object.fromEntries(Object.entries(V2_EVENT_SIGNATURES).map(([name, sig]) => [name, keccakId(sig)])));
const TOPIC_TO_NAME = new Map(Object.entries(V2_EVENT_TOPICS).map(([name, topic]) => [topic.toLowerCase(), name]));

function topicAddress(topic) {
  return `0x${String(topic || "").slice(-40)}`.toLowerCase();
}

function dataWords(data) {
  const text = String(data || "").replace(/^0x/, "");
  const out = [];
  for (let i = 0; i + 64 <= text.length; i += 64) out.push(BigInt(`0x${text.slice(i, i + 64)}`).toString());
  return out;
}

/** One raw eth_getLogs entry -> the evm_campaign_events row shape, or null for another event. */
export function decodeV2Log(log) {
  const name = TOPIC_TO_NAME.get(String(log?.topics?.[0] || "").toLowerCase());
  if (!name) return null;
  const words = dataWords(log.data);
  const campaign = topicAddress(log.topics[1]);
  let args;
  if (name === "CreatorFeesClaimed") args = { campaign, creator: topicAddress(log.topics[2]), amount: words[0] ?? "0" };
  else if (name === "CreatorQuoteClaimed") args = { campaign, creator: topicAddress(log.topics[2]), quote: topicAddress(log.topics[3]), amount: words[0] ?? "0" };
  else args = { campaign, amount: words[0] ?? "0", toCreator: words[1] ?? "0", toHolders: words[2] ?? "0", toBuyback: words[3] ?? "0" };
  return {
    contract_address: String(log.address || "").toLowerCase(),
    campaign_address: campaign,
    event_name: name,
    args,
    tx_hash: String(log.transactionHash || "").toLowerCase(),
    log_index: Number(BigInt(log.logIndex ?? "0x0")),
    block_number: Number(BigInt(log.blockNumber ?? "0x0")),
    block_time: null,
  };
}

/** Indexed rows plus chain rows, each event once (tx hash + log index). */
export function mergeV2Rows(dbRows, chainRows) {
  const seen = new Map();
  for (const row of [...(dbRows || []), ...(chainRows || [])]) {
    const key = `${String(row.tx_hash || "").toLowerCase()}:${Number(row.log_index ?? 0)}`;
    const prev = seen.get(key);
    // Keep the indexed row (it has a block time) unless only the chain row has one.
    if (!prev || (!prev.block_time && row.block_time)) seen.set(key, row);
  }
  return [...seen.values()];
}

const LOG_TIMEOUT_MS = 8000;
const MAX_LOG_REQUESTS = 40;
const FIRST_SPAN = 200_000;
const MIN_SPAN = 2_000;
const RESCAN_MS = 10 * 60_000;
const logCache = new Map();

export function clearV2LogCache() {
  logCache.clear();
}

async function rpcCall(fetchImpl, urls, method, params) {
  let last = new Error("No RPC configured.");
  for (const url of urls || []) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOG_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: controller.signal });
      if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
      const payload = await res.json();
      if (payload?.error) throw new Error(`${method}: ${payload.error.message || "rpc error"}`);
      return payload.result;
    } catch (error) {
      last = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}

/**
 * Reads the V2 vault's claim and accrual logs from its deploy block to the
 * chain head. Returns { rows, complete, scannedTo, head, error? }; complete
 * means every block from the deploy block to the head was read.
 */
export async function readV2LogsFromChain({ chainId, vault, urls, fetchImpl = fetch, nowMs = Date.now(), fromBlock = null }) {
  // fromBlock: another vault's deploy block (gen-7's own vault, EVM_GEN7_CREATOR_VAULT_<id>@block); default the gen-6 one.
  const deploy = Number(fromBlock) > 0 ? Number(fromBlock) : CREATOR_VAULT_V2_DEPLOY_BLOCKS[Number(chainId)];
  if (!deploy || !vault) return { rows: [], complete: false, scannedTo: null, head: null, error: "No deploy block known for this vault." };
  const key = `${chainId}:${String(vault).toLowerCase()}`;
  const state = logCache.get(key) || { rows: [], next: deploy, span: FIRST_SPAN, at: 0, head: null, error: null };
  if (state.at && nowMs - state.at < RESCAN_MS) return { rows: state.rows, complete: state.head != null && state.next > state.head, scannedTo: state.next - 1, head: state.head, cached: true, ...(state.error ? { error: state.error } : {}) };
  state.error = null;
  try {
    state.head = Number(BigInt(await rpcCall(fetchImpl, urls, "eth_blockNumber", [])));
    const topics = [Object.values(V2_EVENT_TOPICS)];
    for (let requests = 0; requests < MAX_LOG_REQUESTS && state.next <= state.head; requests += 1) {
      const to = Math.min(state.head, state.next + state.span - 1);
      let logs;
      try {
        logs = await rpcCall(fetchImpl, urls, "eth_getLogs", [{ address: vault, fromBlock: `0x${state.next.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics }]);
      } catch (error) {
        if (state.span <= MIN_SPAN) throw error;
        state.span = Math.max(MIN_SPAN, Math.floor(state.span / 4));
        continue;
      }
      for (const log of Array.isArray(logs) ? logs : []) {
        const row = decodeV2Log(log);
        if (!row) continue;
        if (row.event_name === "CreatorFeesClaimed") {
          const block = await rpcCall(fetchImpl, urls, "eth_getBlockByNumber", [`0x${row.block_number.toString(16)}`, false]).catch(() => null);
          if (block?.timestamp) row.block_time = new Date(Number(BigInt(block.timestamp)) * 1000).toISOString();
        }
        state.rows.push(row);
      }
      state.next = to + 1;
    }
  } catch (error) {
    state.error = String(error?.message || "log read failed").slice(0, 200);
  }
  state.at = nowMs;
  logCache.set(key, state);
  return { rows: state.rows, complete: state.head != null && state.next > state.head, scannedTo: state.next - 1, head: state.head, cached: false, ...(state.error ? { error: state.error } : {}) };
}
