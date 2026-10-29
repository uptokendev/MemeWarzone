import { Interface, getAddress, id, zeroPadValue, ZeroAddress } from "ethers";

// Who created an EVM token, when the token itself no longer names a wallet owner (founder
// 2026-10-29: automate BNB and Robinhood claims like Solana). Only launchpads whose own
// creation record is verified on-chain are listed here; anything else stays on X / manual review.
//
// four.meme (BNB): TokenManager V2 emits TokenCreate(creator, token, ...) in the creation tx.
// four.meme's API gives the creator and creation time; that is only a pointer to the blocks to
// read. The proof is the on-chain event: emitted by the TokenManager, naming this token, with
// creator == tx.from, in a successful tx sent to the TokenManager.
export const FOURMEME_TOKEN_MANAGER_V2 = "0x5c952063c7fc8610FFDB798152D69F0B9550762b";
export const FOURMEME_HELPER = "0xF251F83e40a78868FcfA3FA4599Dad6494E46034";
const FOURMEME_TOKEN_CREATE = id("TokenCreate(address,address,uint256,string,string,uint256,uint256,uint256)");
const FOURMEME_EVENT = new Interface(["event TokenCreate(address creator,address token,uint256 requestId,string name,string symbol,uint256 totalSupply,uint256 launchTime,uint256 launchFee)"]);
const FOURMEME_HELPER_ABI = new Interface(["function getTokenInfo(address) view returns(uint256 version,address tokenManager,address quote,uint256 lastPrice,uint256 tradingFeeRate,uint256 minTradingFee,uint256 launchTime,uint256 offers,uint256 maxOffers,uint256 funds,uint256 maxFunds,bool liquidityAdded)"]);
const FOURMEME_API = "https://four.meme/meme-api/v1/private/token/get/v2";
// Seen on mainnet 2026-10-29: the creation block lands 2-30 s after the API's createDate.
const FOURMEME_SCAN_BEFORE_S = 10;
const FOURMEME_SCAN_AFTER_S = 120;
const FOURMEME_SCAN_MAX_BLOCKS = 240;

// Robinhood launchpad router (unnamed; read on mainnet 2026-10-29). Its creation tx emits
// topic0 below with topic1 = creator (indexed) and data word 0 = the coin's own contract, which
// the token returns from deployer(). Verified: router emitted it, creator == tx.from, contract ==
// token.deployer(), tx sent to the router and successful.
export const RH_LAUNCHPAD_ROUTER = "0x6319141DCC29E7dCEaab6c4563Cca1Fb58e8cCe2";
const RH_LAUNCHPAD_CREATED = "0x01937e4cd42e9b7187e05b387d1e47c08cd90a82522fdaa889731e4bf52c462d";
// The Robinhood RPC allows 10,000,000 blocks per getLogs query (2026-10-29).
const RH_LOG_SPAN = 9_999_999;

const TRANSFER = id("Transfer(address,address,uint256)");
const ZERO_TOPIC = zeroPadValue(ZeroAddress, 32);
const NEGATIVE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 1000;
const cache = new Map();
// Concurrent lookups for the same token share one scan (the claim dialog's lookup is unsigned).
const inFlight = new Map();

function lower(value) { return String(value || "").toLowerCase(); }
function sameAddress(a, b) { return Boolean(a && b) && lower(a) === lower(b); }
function rpcError(message, cause) { return Object.assign(new Error(message), { code: "PROJECT_IMPORT_RPC_UNAVAILABLE", cause }); }

/** A plain wallet: no code, or only an EIP-7702 delegation designator (0xef0100 + address). */
export function isWalletCode(code) {
  const value = lower(code);
  return value === "0x" || value === "" || /^0xef0100[0-9a-f]{40}$/.test(value);
}

export async function isWalletAddress(provider, address) {
  try { return isWalletCode(await provider.getCode(address)); }
  catch { return false; }
}

function cached(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt && hit.expiresAt < Date.now()) { cache.delete(key); return undefined; }
  return hit.value;
}

function remember(key, value, ttlMs = 0) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : 0 });
  return value;
}

export function clearEvmCreatorCacheForTest() { cache.clear(); inFlight.clear(); }

async function readFourmemeTokenManager(provider, token) {
  try {
    const raw = await provider.call({ to: FOURMEME_HELPER, data: FOURMEME_HELPER_ABI.encodeFunctionData("getTokenInfo", [token]) });
    const info = FOURMEME_HELPER_ABI.decodeFunctionResult("getTokenInfo", raw);
    return Number(info.version) > 0 ? getAddress(info.tokenManager) : null;
  } catch { return null; }
}

async function readFourmemeHint(token, fetchImpl) {
  const response = await fetchImpl(`${FOURMEME_API}?address=${token}`, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (MemeWarzone ownership check)" }, signal: AbortSignal.timeout(7000) });
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  const data = body?.data;
  if (!data || !sameAddress(data.address, token)) return null;
  let creator;
  try { creator = getAddress(String(data.userAddress || "")); } catch { return null; }
  const createdAt = Math.floor(Number(data.createDate) / 1000);
  return Number.isFinite(createdAt) && createdAt > 0 ? { creator, createdAt } : null;
}

async function firstBlockAtOrAfter(provider, timestamp) {
  let lo = 0, hi = await provider.getBlockNumber();
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const block = await provider.getBlock(mid);
    if (!block) throw new Error(`block ${mid} unavailable`);
    if (block.timestamp < timestamp) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** The four.meme TokenCreate creator for `token`, verified on-chain, or null. */
export async function findFourmemeCreator({ provider, token, fetchImpl = fetch }) {
  const manager = await readFourmemeTokenManager(provider, token);
  if (!sameAddress(manager, FOURMEME_TOKEN_MANAGER_V2)) return null;
  let hint;
  try { hint = await readFourmemeHint(token, fetchImpl); } catch { hint = null; }
  if (!hint) return null;
  try {
    let number = await firstBlockAtOrAfter(provider, hint.createdAt - FOURMEME_SCAN_BEFORE_S);
    for (let scanned = 0; scanned < FOURMEME_SCAN_MAX_BLOCKS; scanned++, number++) {
      const block = await provider.getBlock(number, true);
      if (!block) break;
      if (block.timestamp > hint.createdAt + FOURMEME_SCAN_AFTER_S) break;
      for (const tx of block.prefetchedTransactions || []) {
        if (!sameAddress(tx.from, hint.creator) || !sameAddress(tx.to, FOURMEME_TOKEN_MANAGER_V2)) continue;
        const receipt = await provider.getTransactionReceipt(tx.hash);
        if (!receipt || receipt.status !== 1) continue;
        for (const log of receipt.logs || []) {
          if (!sameAddress(log.address, FOURMEME_TOKEN_MANAGER_V2) || log.topics?.[0] !== FOURMEME_TOKEN_CREATE) continue;
          let event;
          try { event = FOURMEME_EVENT.parseLog(log); } catch { continue; }
          if (!sameAddress(event.args.token, token) || !sameAddress(event.args.creator, tx.from)) continue;
          return { creator: getAddress(tx.from), launchpad: "fourmeme", creationTx: tx.hash, block: number };
        }
      }
    }
  } catch (error) {
    throw rpcError("BNB creation lookup is temporarily unavailable. Please retry.", error);
  }
  return null;
}

async function firstMintLog(provider, token) {
  const latest = await provider.getBlockNumber();
  let earliest = null;
  // Newest range first; keep going back while ranges still hold mints. At most ~11 queries.
  for (let to = latest; to >= 0; to -= RH_LOG_SPAN + 1) {
    const from = Math.max(0, to - RH_LOG_SPAN);
    const logs = await provider.getLogs({ address: token, topics: [TRANSFER, ZERO_TOPIC], fromBlock: from, toBlock: to });
    if (logs.length) earliest = logs[0];
    else if (earliest) break;
  }
  return earliest;
}

/** The Robinhood launchpad creator for `token` whose deployer() is `deployerContract`, verified on-chain, or null. */
export async function findRobinhoodLaunchpadCreator({ provider, token, deployerContract }) {
  if (!deployerContract) return null;
  let mint;
  try { mint = await firstMintLog(provider, token); }
  catch (error) { throw rpcError("Robinhood creation lookup is temporarily unavailable. Please retry.", error); }
  if (!mint) return null;
  let tx, receipt;
  try { [tx, receipt] = await Promise.all([provider.getTransaction(mint.transactionHash), provider.getTransactionReceipt(mint.transactionHash)]); }
  catch (error) { throw rpcError("Robinhood creation lookup is temporarily unavailable. Please retry.", error); }
  if (!tx || !receipt || receipt.status !== 1 || !sameAddress(tx.to, RH_LAUNCHPAD_ROUTER)) return null;
  const creatorTopic = lower(zeroPadValue(tx.from, 32));
  const record = (receipt.logs || []).find((log) => sameAddress(log.address, RH_LAUNCHPAD_ROUTER)
    && log.topics?.[0] === RH_LAUNCHPAD_CREATED
    && lower(log.topics?.[1]) === creatorTopic
    && String(log.data || "").length >= 66
    && sameAddress(`0x${String(log.data).slice(26, 66)}`, deployerContract));
  if (!record) return null;
  return { creator: getAddress(tx.from), launchpad: "robinhood_launchpad_0x6319", creationTx: tx.hash, block: receipt.blockNumber };
}

/**
 * Launchpad creator for an EVM token with no live wallet owner. Returns
 * { creator, launchpad, creationTx, block } or null. The creator must be a wallet.
 * Positive results are cached per process; "not found" for 10 minutes; RPC errors throw.
 */
export async function resolveEvmLaunchpadCreator({ provider, chainId, token, deployerContract = null, fetchImpl = fetch }) {
  const key = `${Number(chainId)}:${lower(token)}`;
  const hit = cached(key);
  if (hit !== undefined) return hit;
  if (inFlight.has(key)) return inFlight.get(key);
  const lookup = (async () => {
    let found = null;
    if (Number(chainId) === 56) found = await findFourmemeCreator({ provider, token, fetchImpl });
    else if (Number(chainId) === 4663) found = await findRobinhoodLaunchpadCreator({ provider, token, deployerContract });
    if (found && !(await isWalletAddress(provider, found.creator))) found = null;
    return remember(key, found, found ? 0 : NEGATIVE_TTL_MS);
  })();
  inFlight.set(key, lookup);
  try { return await lookup; } finally { inFlight.delete(key); }
}

const AUTHORITY_READS = new Interface([
  "function owner() view returns (address)",
  "function getOwner() view returns (address)",
  "function deployer() view returns (address)",
  "function creator() view returns (address)",
]);

async function readAuthority(provider, token, method) {
  let raw;
  try { raw = await provider.call({ to: token, data: AUTHORITY_READS.encodeFunctionData(method) }); }
  catch { return { readable: false, address: null }; }
  try {
    const address = getAddress(AUTHORITY_READS.decodeFunctionResult(method, raw)[0]);
    return { readable: true, address: address === ZeroAddress ? null : address };
  } catch { return { readable: false, address: null }; }
}

const UNAVAILABLE_MESSAGE = "automatic ownership verification unavailable";
const CREATOR_LABEL = { deployer: "token deployer", creator: "token creator", fourmeme_creator: "four.meme creator", launchpad_creator: "launchpad creator" };

/**
 * Project authority for a BNB/Robinhood token, in this order:
 * 1. live owner()/getOwner() (wallet or contract) always wins, except four.meme's TokenManager,
 *    which holds ownership only while the coin bonds;
 * 2. the token's own deployer()/creator() when it is a wallet (founder 2026-10-09);
 * 3. a known launchpad's creation record verified on-chain (resolveEvmLaunchpadCreator).
 * Same result shape the BNB/EVM resolvers returned before, plus `evidence`.
 */
export async function resolveEvmProjectAuthority({ provider, chainId, token, signedWallet, fetchImpl = fetch }) {
  let method = null;
  let owner = null;
  for (const candidate of ["owner", "getOwner"]) {
    const read = await readAuthority(provider, token, candidate);
    if (!read.readable) continue;
    method = candidate;
    owner = read.address;
    break;
  }
  const launchpadHeld = Number(chainId) === 56 && sameAddress(owner, FOURMEME_TOKEN_MANAGER_V2);
  let currentOwner = launchpadHeld ? null : owner;
  let evidence = null;
  if (!currentOwner) {
    let deployerContract = null;
    for (const candidate of ["deployer", "creator"]) {
      const read = await readAuthority(provider, token, candidate);
      if (!read.address) continue;
      if (await isWalletAddress(provider, read.address)) { method = candidate; currentOwner = read.address; break; }
      deployerContract ||= read.address;
    }
    if (!currentOwner) {
      const launch = await resolveEvmLaunchpadCreator({ provider, chainId, token, deployerContract, fetchImpl });
      if (launch) {
        method = launch.launchpad === "fourmeme" ? "fourmeme_creator" : "launchpad_creator";
        currentOwner = launch.creator;
        evidence = { authorityType: method, launchpad: launch.launchpad, creator: launch.creator, creationTx: launch.creationTx, block: launch.block, deployerContract };
      }
    }
  }
  if (!currentOwner) {
    return { method, currentOwner: null, automaticOwnershipVerified: false, automaticOwnershipVerification: "unavailable", message: UNAVAILABLE_MESSAGE, evidence: null };
  }
  const label = CREATOR_LABEL[method] || "current owner";
  const verified = sameAddress(currentOwner, signedWallet);
  return {
    method,
    currentOwner: getAddress(currentOwner),
    automaticOwnershipVerified: verified,
    automaticOwnershipVerification: verified ? "verified" : "rejected",
    message: verified ? `signed connected wallet matches ${label}` : `signed connected wallet does not match ${label}`,
    evidence,
  };
}
