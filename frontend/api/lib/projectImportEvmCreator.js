import { Interface, getAddress, getBytes, getCreateAddress, id, keccak256, zeroPadValue, ZeroAddress } from "ethers";

// Who created an EVM token, when the token itself no longer names a wallet owner (founder
// 2026-10-29: automate BNB and Robinhood claims like Solana). Every source here is checked on
// chain. Off-chain data (four.meme's API, a hash the claimant pastes) is only a pointer to the
// transaction to read; it never decides the owner by itself.
//
// four.meme (BNB): TokenManager V2 emits TokenCreate(creator, token, ...) in the creation tx.
export const FOURMEME_TOKEN_MANAGER_V2 = "0x5c952063c7fc8610FFDB798152D69F0B9550762b";
export const FOURMEME_HELPER = "0xF251F83e40a78868FcfA3FA4599Dad6494E46034";
const FOURMEME_TOKEN_CREATE = id("TokenCreate(address,address,uint256,string,string,uint256,uint256,uint256)");
const FOURMEME_EVENT = new Interface(["event TokenCreate(address creator,address token,uint256 requestId,string name,string symbol,uint256 totalSupply,uint256 launchTime,uint256 launchFee)"]);
const FOURMEME_HELPER_ABI = new Interface(["function getTokenInfo(address) view returns(uint256 version,address tokenManager,address quote,uint256 lastPrice,uint256 tradingFeeRate,uint256 minTradingFee,uint256 launchTime,uint256 offers,uint256 maxOffers,uint256 funds,uint256 maxFunds,bool liquidityAdded)"]);
const FOURMEME_API = "https://four.meme/meme-api/v1/private/token/get/v2";
// Seen on mainnet 2026-10-29: the creation block lands 2-30 s after the API's createDate.
const FOURMEME_SCAN_BEFORE_S = 10;
const FOURMEME_SCAN_AFTER_S = 120;
// BSC blocks were 0.45 s on 2026-10-29; the time bound above is what ends the scan, this is a backstop.
const FOURMEME_SCAN_MAX_BLOCKS = 400;

// flap.sh (BNB): the portal (proxy) emits TokenCreated(uint256 ts, address creator, uint256 nonce,
// address token, string name, string symbol, string meta) in the creation tx (two launches read
// on mainnet 2026-10-29: creator == tx.from, tx sent to the portal).
export const FLAP_PORTAL = "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0";
const FLAP_TOKEN_CREATED = id("TokenCreated(uint256,address,uint256,address,string,string,string)");

// Robinhood launchpad router (unnamed). Its creation tx emits topic0 below with topic1 = creator
// (indexed) and data word 0 = the coin's own contract, which the token returns from deployer().
// 588 events read on mainnet 2026-10-29: topic1 == tx.from in every one.
export const RH_LAUNCHPAD_ROUTER = "0x6319141DCC29E7dCEaab6c4563Cca1Fb58e8cCe2";
const RH_LAUNCHPAD_CREATED = "0x01937e4cd42e9b7187e05b387d1e47c08cd90a82522fdaa889731e4bf52c462d";
// Robinhood token launcher (Uniswap-style; the token's creator() returns it). Coins are created by a
// direct call from the creator's wallet, createToken or multicall wrapping it, which mints the
// whole fixed supply in the same tx.
export const RH_TOKEN_LAUNCHER = "0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0";
const RH_LAUNCHER_CREATE_SELECTORS = new Set([
  id("createToken(address,string,string,uint8,uint128,address,bytes)").slice(0, 10),
  id("createToken(string,string,uint8,uint256,address,bytes,bytes32)").slice(0, 10),
  id("multicall(bytes[])").slice(0, 10),
]);
// The Robinhood RPC allows 10,000,000 blocks per getLogs query (2026-10-29).
const RH_LOG_SPAN = 9_999_999;

const TRANSFER = id("Transfer(address,address,uint256)");
const ZERO_TOPIC = zeroPadValue(ZeroAddress, 32);
// A wallet that directly deployed the token: its CREATE address for some nonce is the token.
const CREATE_NONCE_CAP = 20_000;
const NEGATIVE_TTL_MS = 10 * 60 * 1000;
const ERROR_TTL_MS = 60 * 1000;
const POSITIVE_MAX = 5000;
const NEGATIVE_MAX = 1000;
// Positive results live apart from misses so a flood of misses cannot evict them.
const positives = new Map();
const negatives = new Map();
// Concurrent lookups for the same token share one scan, and at most two block scans run at once.
const inFlight = new Map();
const SCAN_SLOTS = 2;
let scansRunning = 0;

function lower(value) { return String(value || "").toLowerCase(); }
function sameAddress(a, b) { return Boolean(a && b) && lower(a) === lower(b); }
function rpcError(message, cause) { return Object.assign(new Error(message), { code: "PROJECT_IMPORT_RPC_UNAVAILABLE", cause }); }

/** A plain wallet: no code, or only an EIP-7702 delegation designator (0xef0100 + address). */
export function isWalletCode(code) {
  const value = lower(code);
  return value === "0x" || value === "" || /^0xef0100[0-9a-f]{40}$/.test(value);
}

/** Throws PROJECT_IMPORT_RPC_UNAVAILABLE when the code cannot be read. */
export async function isWalletAddress(provider, address) {
  let code;
  try { code = await provider.getCode(address); }
  catch (error) { throw rpcError("Wallet check is temporarily unavailable. Please retry.", error); }
  return isWalletCode(code);
}

/** Ethereum log bloom membership for an address or 32-byte topic. */
export function bloomContains(bloom, value) {
  let bits, hash;
  try { bits = getBytes(bloom); hash = getBytes(keccak256(value)); } catch { return true; }
  if (bits.length !== 256) return true;
  for (let i = 0; i < 6; i += 2) {
    const bit = ((hash[i] << 8) | hash[i + 1]) & 2047;
    if ((bits[255 - (bit >> 3)] & (1 << (bit & 7))) === 0) return false;
  }
  return true;
}

/** A revert or undecodable result means "this method does not exist"; anything else is an RPC failure. */
function isMissingMethod(error) {
  return ["CALL_EXCEPTION", "BAD_DATA"].includes(String(error?.code || ""));
}

export function clearEvmCreatorCacheForTest() { positives.clear(); negatives.clear(); inFlight.clear(); scansRunning = 0; }

async function readFourmemeTokenManager(provider, token) {
  let raw;
  try { raw = await provider.call({ to: FOURMEME_HELPER, data: FOURMEME_HELPER_ABI.encodeFunctionData("getTokenInfo", [token]) }); }
  catch (error) {
    if (isMissingMethod(error)) return null;
    throw rpcError("BNB launchpad lookup is temporarily unavailable. Please retry.", error);
  }
  try {
    const info = FOURMEME_HELPER_ABI.decodeFunctionResult("getTokenInfo", raw);
    return Number(info.version) > 0 ? getAddress(info.tokenManager) : null;
  } catch { return null; }
}

/** four.meme's own record: creator wallet and creation time. Null when four.meme does not know the token; throws when the API is unreachable. */
async function readFourmemeHint(token, fetchImpl) {
  let response;
  try { response = await fetchImpl(`${FOURMEME_API}?address=${token}`, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (MemeWarzone ownership check)" }, signal: AbortSignal.timeout(7000) }); }
  catch (error) { throw rpcError("four.meme is temporarily unreachable. Please retry.", error); }
  if (!response.ok) throw rpcError(`four.meme returned ${response.status}. Please retry.`);
  const body = await response.json().catch(() => null);
  if (!body) throw rpcError("four.meme returned an unreadable answer. Please retry.");
  const data = body.data;
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

/** The four.meme creator if `receipt` (of `tx`) is this token's creation, else null. */
function fourmemeCreatorFrom(tx, receipt, token) {
  if (!receipt || receipt.status !== 1 || !sameAddress(tx?.to, FOURMEME_TOKEN_MANAGER_V2)) return null;
  for (const log of receipt.logs || []) {
    if (!sameAddress(log.address, FOURMEME_TOKEN_MANAGER_V2) || log.topics?.[0] !== FOURMEME_TOKEN_CREATE) continue;
    let event;
    try { event = FOURMEME_EVENT.parseLog(log); } catch { continue; }
    if (sameAddress(event.args.token, token) && sameAddress(event.args.creator, tx.from)) return getAddress(tx.from);
  }
  return null;
}

async function withScanSlot(run) {
  if (scansRunning >= SCAN_SLOTS) throw rpcError("Creation lookups are busy. Please retry in a minute.");
  scansRunning++;
  try { return await run(); } finally { scansRunning--; }
}

/** The four.meme TokenCreate creator for `token`, verified on-chain, or null. */
export async function findFourmemeCreator({ provider, token, fetchImpl = fetch }) {
  const manager = await readFourmemeTokenManager(provider, token);
  if (!sameAddress(manager, FOURMEME_TOKEN_MANAGER_V2)) return null;
  const hint = await readFourmemeHint(token, fetchImpl);
  if (!hint) return null;
  const readCreation = async (hash) => {
    const [tx, receipt] = await Promise.all([provider.getTransaction(hash), provider.getTransactionReceipt(hash)]);
    const creator = tx && sameAddress(tx.from, hint.creator) ? fourmemeCreatorFrom(tx, receipt, token) : null;
    return creator ? { creator, launchpad: "fourmeme", creationTx: hash, block: receipt.blockNumber } : null;
  };
  try {
    return await withScanSlot(async () => {
      const start = await firstBlockAtOrAfter(provider, hint.createdAt - FOURMEME_SCAN_BEFORE_S);
      const endBlock = await firstBlockAtOrAfter(provider, hint.createdAt + FOURMEME_SCAN_AFTER_S);
      // 1) getLogs over the window (one call where the RPC allows it).
      try {
        const logs = await provider.getLogs({ address: FOURMEME_TOKEN_MANAGER_V2, topics: [FOURMEME_TOKEN_CREATE], fromBlock: start, toBlock: endBlock });
        for (const log of logs) {
          let event;
          try { event = FOURMEME_EVENT.parseLog(log); } catch { continue; }
          if (sameAddress(event.args.token, token) && sameAddress(event.args.creator, hint.creator)) return await readCreation(log.transactionHash);
        }
        return null;
      } catch {
        // Public BSC nodes refuse getLogs: read headers and only fetch blocks whose bloom has this token.
      }
      for (let number = start, scanned = 0; number <= endBlock && scanned < FOURMEME_SCAN_MAX_BLOCKS; number++, scanned++) {
        const header = await provider.send("eth_getBlockByNumber", [`0x${number.toString(16)}`, false]);
        if (!header || !bloomContains(header.logsBloom, token) || !bloomContains(header.logsBloom, FOURMEME_TOKEN_MANAGER_V2)) continue;
        const block = await provider.getBlock(number, true);
        for (const tx of block?.prefetchedTransactions || []) {
          if (!sameAddress(tx.from, hint.creator) || !sameAddress(tx.to, FOURMEME_TOKEN_MANAGER_V2)) continue;
          const found = await readCreation(tx.hash);
          if (found) return found;
        }
      }
      return null;
    });
  } catch (error) {
    if (error?.code === "PROJECT_IMPORT_RPC_UNAVAILABLE") throw error;
    throw rpcError("BNB creation lookup is temporarily unavailable. Please retry.", error);
  }
}

async function firstMintLog(provider, token) {
  const latest = await provider.getBlockNumber();
  // Every range back to block 0 (about 11 on Robinhood), four queries at a time; the earliest mint wins.
  const ranges = [];
  for (let to = latest; to >= 0; to -= RH_LOG_SPAN + 1) ranges.push([Math.max(0, to - RH_LOG_SPAN), to]);
  let earliest = null;
  for (let i = 0; i < ranges.length; i += 4) {
    const batch = await Promise.all(ranges.slice(i, i + 4).map(([fromBlock, toBlock]) => provider.getLogs({ address: token, topics: [TRANSFER, ZERO_TOPIC], fromBlock, toBlock })));
    for (const logs of batch) if (logs.length && (!earliest || logs[0].blockNumber < earliest.blockNumber)) earliest = logs[0];
  }
  return earliest;
}

async function readTokenAddressMethod(provider, token, method) {
  const read = await readAuthority(provider, token, method);
  return read.address;
}

/** The 0x6319 launchpad creator if `tx` is this token's creation, else null. */
function rhLaunchpadCreatorFrom(tx, receipt, deployerContract) {
  if (!tx || !receipt || receipt.status !== 1 || !deployerContract || !sameAddress(tx.to, RH_LAUNCHPAD_ROUTER)) return null;
  const creatorTopic = lower(zeroPadValue(tx.from, 32));
  const record = (receipt.logs || []).find((log) => sameAddress(log.address, RH_LAUNCHPAD_ROUTER)
    && log.topics?.[0] === RH_LAUNCHPAD_CREATED
    && lower(log.topics?.[1]) === creatorTopic
    && String(log.data || "").length >= 66
    && sameAddress(`0x${String(log.data).slice(26, 66)}`, deployerContract));
  return record ? getAddress(tx.from) : null;
}

/**
 * Robinhood allows getLogs over the whole chain, so the token's first mint (its creation tx) is
 * found automatically and checked with the same recognisers as a pasted hash.
 */
export async function findRobinhoodCreator({ provider, token }) {
  let mint;
  try { mint = await firstMintLog(provider, token); }
  catch (error) { throw rpcError("Robinhood creation lookup is temporarily unavailable. Please retry.", error); }
  return mint ? verifyCreationTx({ provider, chainId: 4663, token, txHash: mint.transactionHash }) : null;
}

/**
 * A creation transaction the claimant pasted, checked against the launchpads we know. Returns
 * { creator, launchpad, creationTx, block } when the tx provably created `token`, else null.
 * The hash is only a pointer: every condition is read from the chain.
 */
export async function verifyCreationTx({ provider, chainId, token, txHash }) {
  const hash = String(txHash || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return null;
  let tx, receipt;
  try { [tx, receipt] = await Promise.all([provider.getTransaction(hash), provider.getTransactionReceipt(hash)]); }
  catch (error) { throw rpcError("Transaction lookup is temporarily unavailable. Please retry.", error); }
  if (!tx || !receipt || receipt.status !== 1) return null;
  const found = (launchpad, creator) => (creator ? { creator: getAddress(creator), launchpad, creationTx: hash, block: receipt.blockNumber } : null);
  // Deployed directly: the receipt names the token as the contract this tx created.
  if (sameAddress(receipt.contractAddress, token)) return found("direct_deploy", tx.from);
  const id56 = Number(chainId) === 56, id4663 = Number(chainId) === 4663;
  if (id56 && sameAddress(tx.to, FOURMEME_TOKEN_MANAGER_V2)) return found("fourmeme", fourmemeCreatorFrom(tx, receipt, token));
  if (id56 && sameAddress(tx.to, FLAP_PORTAL)) {
    const record = (receipt.logs || []).find((log) => sameAddress(log.address, FLAP_PORTAL) && log.topics?.[0] === FLAP_TOKEN_CREATED && String(log.data || "").length >= 2 + 64 * 4
      && sameAddress(`0x${log.data.slice(2 + 64 + 24, 2 + 128)}`, tx.from)
      && sameAddress(`0x${log.data.slice(2 + 192 + 24, 2 + 256)}`, token));
    return found("flap", record ? tx.from : null);
  }
  if (id4663 && sameAddress(tx.to, RH_LAUNCHPAD_ROUTER)) {
    const deployerContract = await readTokenAddressMethod(provider, token, "deployer");
    return found("robinhood_launchpad_0x6319", rhLaunchpadCreatorFrom(tx, receipt, deployerContract));
  }
  if (id4663 && sameAddress(tx.to, RH_TOKEN_LAUNCHER) && RH_LAUNCHER_CREATE_SELECTORS.has(lower(String(tx.data || "").slice(0, 10)))) {
    const launcherOwned = sameAddress(await readTokenAddressMethod(provider, token, "creator"), RH_TOKEN_LAUNCHER)
      || sameAddress(await readTokenAddressMethod(provider, token, "deployer"), RH_TOKEN_LAUNCHER);
    const mint = (receipt.logs || []).find((log) => sameAddress(log.address, token) && log.topics?.[0] === TRANSFER && lower(log.topics?.[1]) === lower(ZERO_TOPIC));
    if (!launcherOwned || !mint) return null;
    // Fixed supply: the whole supply was minted in this tx, so it is the token's creation.
    let supply;
    try { supply = BigInt(await provider.call({ to: token, data: id("totalSupply()").slice(0, 10) })); }
    catch (error) { if (isMissingMethod(error)) return null; throw rpcError("Token supply read is temporarily unavailable. Please retry.", error); }
    return found("robinhood_token_launcher", BigInt(mint.data) === supply ? tx.from : null);
  }
  return null;
}

/** Nonce at which `wallet` CREATE-deployed `token` directly, or null. One RPC call; the rest is local hashing. */
export async function createNonceFor({ provider, token, wallet }) {
  if (!wallet || sameAddress(wallet, ZeroAddress)) return null;
  let count;
  try { count = await provider.getTransactionCount(wallet); }
  catch (error) { throw rpcError("Wallet history lookup is temporarily unavailable. Please retry.", error); }
  const limit = Math.min(Number(count) || 0, CREATE_NONCE_CAP);
  for (let nonce = 0; nonce < limit; nonce++) if (sameAddress(getCreateAddress({ from: wallet, nonce }), token)) return nonce;
  return null;
}

/** A Safe (Gnosis Safe proxy): getThreshold() and getOwners() answer. */
async function readSafe(provider, address) {
  const safe = new Interface(["function getThreshold() view returns (uint256)", "function getOwners() view returns (address[])"]);
  try {
    const threshold = safe.decodeFunctionResult("getThreshold", await provider.call({ to: address, data: safe.encodeFunctionData("getThreshold") }))[0];
    const owners = safe.decodeFunctionResult("getOwners", await provider.call({ to: address, data: safe.encodeFunctionData("getOwners") }))[0];
    return Number(threshold) > 0 && owners.length > 0 ? { threshold: Number(threshold), owners: owners.map((owner) => getAddress(owner)) } : null;
  } catch (error) {
    if (isMissingMethod(error)) return null;
    throw rpcError("Safe lookup is temporarily unavailable. Please retry.", error);
  }
}

function cachedCreator(key) {
  if (positives.has(key)) return positives.get(key);
  const miss = negatives.get(key);
  if (!miss) return undefined;
  if (miss.expiresAt < Date.now()) { negatives.delete(key); return undefined; }
  if (miss.error) throw miss.error;
  return null;
}

function rememberCreator(key, found) {
  if (found) {
    if (positives.size >= POSITIVE_MAX) positives.delete(positives.keys().next().value);
    positives.set(key, found);
    negatives.delete(key);
  } else {
    if (negatives.size >= NEGATIVE_MAX) negatives.delete(negatives.keys().next().value);
    negatives.set(key, { expiresAt: Date.now() + NEGATIVE_TTL_MS });
  }
  return found;
}

function rememberError(key, error) {
  if (negatives.size >= NEGATIVE_MAX) negatives.delete(negatives.keys().next().value);
  negatives.set(key, { expiresAt: Date.now() + ERROR_TTL_MS, error });
}

/**
 * Launchpad creator for an EVM token with no live wallet owner: a pasted creation tx (checked on
 * chain), then the automatic lookups (four.meme on BNB, the first-mint tx on Robinhood). Returns
 * { creator, launchpad, creationTx, block } or null. Verified creators are cached per process,
 * misses for 10 minutes, RPC/API errors for 1 minute (rethrown).
 */
export async function resolveEvmLaunchpadCreator({ provider, chainId, token, creationTx = null, fetchImpl = fetch }) {
  const key = `${Number(chainId)}:${lower(token)}`;
  if (positives.has(key)) return positives.get(key);
  if (creationTx) {
    const pasted = await verifyCreationTx({ provider, chainId, token, txHash: creationTx });
    if (pasted && await isWalletAddress(provider, pasted.creator)) return rememberCreator(key, pasted);
  }
  const hit = cachedCreator(key);
  if (hit !== undefined) return hit;
  if (inFlight.has(key)) return inFlight.get(key);
  const lookup = (async () => {
    try {
      let found = null;
      if (Number(chainId) === 56) found = await findFourmemeCreator({ provider, token, fetchImpl });
      else if (Number(chainId) === 4663) found = await findRobinhoodCreator({ provider, token });
      if (found && !(await isWalletAddress(provider, found.creator))) found = null;
      return rememberCreator(key, found);
    } catch (error) {
      rememberError(key, error);
      throw error;
    }
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

/** { readable, address }: readable false only when the method reverts or is absent. RPC failures throw. */
async function readAuthority(provider, token, method) {
  let raw;
  try { raw = await provider.call({ to: token, data: AUTHORITY_READS.encodeFunctionData(method) }); }
  catch (error) {
    if (isMissingMethod(error)) return { readable: false, address: null };
    throw rpcError("Token ownership read is temporarily unavailable. Please retry.", error);
  }
  try {
    const address = getAddress(AUTHORITY_READS.decodeFunctionResult(method, raw)[0]);
    return { readable: true, address: address === ZeroAddress ? null : address };
  } catch { return { readable: false, address: null }; }
}

const UNAVAILABLE_MESSAGE = "automatic ownership verification unavailable";
const CREATOR_LABEL = {
  deployer: "token deployer", creator: "token creator", safe_deployer: "Safe that deployed the token",
  contract_deployer: "wallet that deployed the contract", creation_tx: "creator in the creation transaction",
  fourmeme_creator: "four.meme creator", launchpad_creator: "launchpad creator",
};

/**
 * Project authority for a BNB/Robinhood token, in this order:
 * 1. live owner()/getOwner() (wallet or contract) always wins, except four.meme's TokenManager
 *    and the flap.sh portal, which hold ownership only while the coin bonds;
 * 2. the token's own deployer()/creator() when it is a wallet (founder 2026-10-09), or a Safe;
 * 3. the signing wallet when it CREATE-deployed the token itself;
 * 4. a creator proven by the token's creation tx: pasted by the claimant, or found automatically
 *    for four.meme and the Robinhood launchpad.
 * A transfer from the authority to the claimant (projectImportEvmTransfer.js) can then prove consent.
 */
export async function resolveEvmProjectAuthority({ provider, chainId, token, signedWallet, creationTx = null, fetchImpl = fetch }) {
  let method = null;
  let owner = null;
  for (const candidate of ["owner", "getOwner"]) {
    const read = await readAuthority(provider, token, candidate);
    if (!read.readable) continue;
    method = candidate;
    owner = read.address;
    break;
  }
  // four.meme's TokenManager and the flap.sh portal own a coin only while it bonds on them.
  const launchpadHeld = Number(chainId) === 56 && (sameAddress(owner, FOURMEME_TOKEN_MANAGER_V2) || sameAddress(owner, FLAP_PORTAL));
  let currentOwner = launchpadHeld ? null : owner;
  let evidence = null;
  if (!currentOwner) {
    for (const candidate of ["deployer", "creator"]) {
      const read = await readAuthority(provider, token, candidate);
      if (!read.address) continue;
      if (await isWalletAddress(provider, read.address)) { method = candidate; currentOwner = read.address; break; }
      const safe = await readSafe(provider, read.address);
      if (safe) {
        method = "safe_deployer";
        currentOwner = read.address;
        evidence = { authorityType: "safe_deployer", safe: read.address, threshold: safe.threshold, owners: safe.owners };
        break;
      }
    }
    if (!currentOwner) {
      const nonce = await createNonceFor({ provider, token, wallet: signedWallet });
      if (nonce !== null) {
        method = "contract_deployer";
        currentOwner = signedWallet;
        evidence = { authorityType: "contract_deployer", deployer: getAddress(signedWallet), nonce };
      }
    }
    if (!currentOwner) {
      const launch = await resolveEvmLaunchpadCreator({ provider, chainId, token, creationTx, fetchImpl });
      if (launch) {
        method = { fourmeme: "fourmeme_creator", direct_deploy: "contract_deployer" }[launch.launchpad] || (creationTx ? "creation_tx" : "launchpad_creator");
        currentOwner = launch.creator;
        evidence = { authorityType: method, launchpad: launch.launchpad, creator: launch.creator, creationTx: launch.creationTx, block: launch.block };
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
