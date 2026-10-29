import crypto from "node:crypto";
import { Interface, getAddress, id } from "ethers";

// BNB/Robinhood transfer check (founder 2026-10-29: "yes with solid proof"). The wallet the chain
// names as the project's authority (live owner, deployer/creator, launchpad creator or a Safe)
// sends an exact small amount of BNB/ETH to the claimant's wallet; the claimant then submits the
// tx hash. Stateless: the challenge is HMAC-signed and carries everything the check needs, so no
// table is required. Replaying a valid proof can only bind the same claimant again.

export const EVM_TRANSFER_TTL_MS = 30 * 60 * 1000;
// A proof may be checked up to an hour after the window closes (slow wallets, retries).
const CHECK_GRACE_MS = 60 * 60 * 1000;
// 0.00001-0.0001 BNB/ETH in steps of 1 gwei: a unique, recognisable amount worth a cent or two.
const MIN_WEI = 10_000_000_000_000n;
const SPAN_WEI = 90_000_000_000_000n;
const SAFE = new Interface(["function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)"]);
const SAFE_EXECUTION_SUCCESS = id("ExecutionSuccess(bytes32,uint256)");

function lower(value) { return String(value || "").toLowerCase(); }
function sameAddress(a, b) { return Boolean(a && b) && lower(a) === lower(b); }
function challengeError(message, code = "PROJECT_IMPORT_TRANSFER_PROOF_INVALID") { return Object.assign(new Error(message), { code }); }

function secret() {
  // Its own secret only (review 2026-10-29): never reuse the X OAuth secrets, which X itself knows.
  const value = String(process.env.PROJECT_IMPORT_CHALLENGE_SECRET || "").trim();
  if (!value) throw challengeError("Transfer verification is not configured", "PROJECT_IMPORT_TRANSFER_NOT_CONFIGURED");
  return value;
}

function sign(encoded) { return crypto.createHmac("sha256", secret()).update(`evm-transfer:${encoded}`).digest("base64url"); }

/** A signed challenge binding project, token, authority wallet and claimant to an exact amount and time window. */
export function issueEvmTransferChallenge({ chainId, tokenAddress, projectId, authority, claimant, now = Date.now() }) {
  const step = BigInt(`0x${crypto.randomBytes(8).toString("hex")}`) % (SPAN_WEI / 1_000_000_000n);
  const payload = {
    v: 1,
    chainId: Number(chainId),
    token: getAddress(tokenAddress),
    projectId: String(projectId),
    authority: getAddress(authority),
    claimant: getAddress(claimant),
    amountWei: (MIN_WEI + step * 1_000_000_000n).toString(),
    issuedAt: now,
    expiresAt: now + EVM_TRANSFER_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return { ...payload, challenge: `${encoded}.${sign(encoded)}` };
}

export function readEvmTransferChallenge(challenge) {
  const [encoded, supplied] = String(challenge || "").split(".");
  if (!encoded || !supplied) throw challengeError("Transfer challenge is invalid");
  const expected = sign(encoded);
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw challengeError("Transfer challenge is invalid");
  try { return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
  catch { throw challengeError("Transfer challenge is invalid"); }
}

/** The {to, value} a tx moved from `authority`: a plain transfer, or a Safe executing a plain transfer. */
function transferFrom(tx, receipt, authority) {
  if (sameAddress(tx.from, authority) && (!tx.data || tx.data === "0x")) return { to: tx.to, value: BigInt(tx.value ?? 0) };
  if (!sameAddress(tx.to, authority)) return null;
  let call;
  try { call = SAFE.parseTransaction({ data: tx.data, value: tx.value }); } catch { return null; }
  if (call?.name !== "execTransaction") return null;
  const [to, value, data, operation] = call.args;
  if (Number(operation) !== 0 || (data && data !== "0x")) return null;
  const executed = (receipt.logs || []).some((log) => sameAddress(log.address, authority) && log.topics?.[0] === SAFE_EXECUTION_SUCCESS);
  return executed ? { to, value: BigInt(value) } : null;
}

/**
 * Check a submitted transfer against its challenge and the authority the chain names right now.
 * Returns the proof fields the assessment records; throws PROJECT_IMPORT_TRANSFER_PROOF_INVALID otherwise.
 */
export async function verifyEvmTransferProof({ provider, challenge, txHash, chainId, tokenAddress, projectId, authority, claimant, now = Date.now() }) {
  const payload = readEvmTransferChallenge(challenge);
  if (payload.v !== 1 || payload.chainId !== Number(chainId) || !sameAddress(payload.token, tokenAddress) || String(payload.projectId) !== String(projectId)) throw challengeError("Transfer challenge belongs to another project");
  if (!sameAddress(payload.claimant, claimant)) throw challengeError("Transfer challenge belongs to another wallet");
  if (!sameAddress(payload.authority, authority)) throw challengeError("The project authority changed. Start a new transfer check.", "PROJECT_IMPORT_TRANSFER_AUTHORITY_CHANGED");
  if (now > Number(payload.expiresAt) + CHECK_GRACE_MS) throw challengeError("This transfer check expired. Start a new one.", "PROJECT_IMPORT_TRANSFER_EXPIRED");
  const hash = String(txHash || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw challengeError("Enter the transaction hash of the transfer");
  let tx, receipt, block;
  try {
    [tx, receipt] = await Promise.all([provider.getTransaction(hash), provider.getTransactionReceipt(hash)]);
    block = receipt ? await provider.getBlock(receipt.blockNumber) : null;
  } catch (error) {
    throw Object.assign(new Error("Transaction lookup is temporarily unavailable. Please retry."), { code: "PROJECT_IMPORT_RPC_UNAVAILABLE", cause: error });
  }
  if (!tx || !receipt || !block) throw challengeError("That transaction was not found yet. Wait for it to confirm and retry.", "PROJECT_IMPORT_TRANSFER_NOT_FOUND");
  if (receipt.status !== 1) throw challengeError("That transaction failed on chain");
  const sentAt = Number(block.timestamp) * 1000;
  if (sentAt < Number(payload.issuedAt) - 5000 || sentAt > Number(payload.expiresAt)) throw challengeError("That transfer was not sent inside the check's time window");
  const moved = transferFrom(tx, receipt, payload.authority);
  if (!moved) throw challengeError("That transaction is not a plain transfer from the project wallet");
  if (!sameAddress(moved.to, payload.claimant)) throw challengeError("That transfer went to another wallet");
  if (moved.value !== BigInt(payload.amountWei)) throw challengeError("That transfer is not the exact amount");
  return {
    ownershipProofSource: "evm_authority_transfer",
    ownershipProofTxSignature: hash,
    ownershipProofCreatorWallet: getAddress(payload.authority),
    ownershipProofClaimantWallet: getAddress(payload.claimant),
    ownershipProofVerifiedAt: new Date(now).toISOString(),
  };
}
