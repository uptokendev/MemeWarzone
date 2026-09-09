import { Contract, Interface, JsonRpcProvider, Network, getAddress } from "ethers";

import { findProgramAddressSync, publicKeyBytes } from "../dev-fix/solana-v4-primitives.js";
import { RewardClaimVerificationError, verifyEvmRewardClaim } from "./rewardClaimVerification.js";

const EVM_CHAINS = new Set([56, 97, 4663, 46630]);
const SOLANA_CHAINS = new Set([101, 102]);
const BNB_CHAINS = new Set([56, 97]);
const ROBINHOOD_CHAINS = new Set([4663, 46630]);
const TOURNAMENT_CHAINS = new Set([...EVM_CHAINS, ...SOLANA_CHAINS]);
const BYTES32_RE = /^0x[a-fA-F0-9]{64}$/;
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const COMPETITION_POOL_SEED = Buffer.from("arena_competition_v2");
const CANONICAL_SOLANA_REWARDS_PROGRAM = "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX";
const REWARD_DISTRIBUTOR_INTERFACE = new Interface([
  "function hasClaimed(bytes32,address) view returns (bool)",
  "function batches(bytes32) view returns (bytes32 merkleRoot,uint256 totalFunded,uint256 totalClaimed,uint64 deadline,bool closed,bool exists)",
  "event RewardClaimed(bytes32 indexed batchId,address indexed account,uint256 amount)",
]);

function readMeta(row) {
  const value = row?.metadata;
  if (!value) return {};
  if (typeof value === "object") return value;
  try { return JSON.parse(String(value)) || {}; } catch { return {}; }
}

function firstString(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function rowChainId(row) {
  const meta = readMeta(row);
  const raw = String(row?.chain ?? "").trim().toLowerCase();
  if (raw === "solana" || raw === "sol") return Number(meta.chainId) || 101;
  if (raw === "robinhood" || raw === "rh") return Number(meta.chainId) || 4663;
  const numeric = Number(row?.chain);
  if (Number.isInteger(numeric) && numeric > 0) return numeric;
  const metadataChain = Number(meta.chainId);
  return Number.isInteger(metadataChain) && metadataChain > 0 ? metadataChain : 0;
}

function sameEvmAddress(left, right) {
  try { return getAddress(String(left || "")) === getAddress(String(right || "")); } catch { return false; }
}

function expectedNativeSymbol(chainId) {
  if (SOLANA_CHAINS.has(Number(chainId))) return "SOL";
  if (ROBINHOOD_CHAINS.has(Number(chainId))) return "ETH";
  return "BNB";
}

function requireBytes32(value, code, message) {
  const text = String(value || "").trim();
  if (!BYTES32_RE.test(text)) throw new RewardClaimVerificationError(code, message, 409);
  return text.toLowerCase();
}

function competitionBytes(hex) {
  return Buffer.from(requireBytes32(hex, "TOURNAMENT_ID_MISSING", "Tournament entitlement is missing its canonical 32-byte competition id.").slice(2), "hex");
}

function solanaProgramId(meta) {
  return firstString(meta, ["arenaMoneyProgramId", "rewardsProgramId", "programId"]) ||
    String(process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID || "").trim() ||
    CANONICAL_SOLANA_REWARDS_PROGRAM;
}

function evmRpcUrl(chainId) {
  const chain = Number(chainId);
  const candidates = [
    process.env[`REWARD_CLAIM_RPC_URL_${chain}`],
    process.env[`BSC_RPC_HTTP_${chain}`],
    process.env[`ROBINHOOD_RPC_HTTP_${chain}`],
    chain === 56 ? process.env.BSC_RPC_HTTP : null,
    chain === 4663 ? process.env.ROBINHOOD_RPC_HTTP : null,
  ];
  return String(candidates.find(Boolean) || "").split(",").map((v) => v.trim()).find(Boolean) || "";
}

function evmProvider(chainId) {
  const url = evmRpcUrl(chainId);
  if (!url) throw new RewardClaimVerificationError("CLAIM_RECOVERY_RPC_MISSING", `No claim recovery RPC configured for chain ${chainId}.`, 503);
  return new JsonRpcProvider(url, new Network(`tournament-${chainId}`, Number(chainId)), { staticNetwork: true });
}

function solanaRpcUrl(chainId) {
  const chain = Number(chainId);
  const candidates = [
    process.env[`SOLANA_REWARDS_RPC_URL_${chain}`],
    process.env[`SOLANA_RPC_URL_${chain}`],
    process.env.SOLANA_REWARDS_RPC_URL,
    process.env.SOLANA_RPC_URL,
    process.env.SOLANA_RPC_HTTP,
  ];
  return String(candidates.find(Boolean) || "").split(",").map((v) => v.trim()).find(Boolean) || "";
}

async function solanaRpc(chainId, method, params) {
  const url = solanaRpcUrl(chainId);
  if (!url) throw new RewardClaimVerificationError("CLAIM_RECOVERY_RPC_MISSING", `No Solana recovery RPC configured for chain ${chainId}.`, 503);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new RewardClaimVerificationError("CLAIM_RECOVERY_STATE_UNAVAILABLE", `Solana RPC ${method} HTTP ${response.status}.`, 503);
  const body = await response.json();
  if (body?.error) throw new RewardClaimVerificationError("CLAIM_RECOVERY_STATE_UNAVAILABLE", body.error.message || JSON.stringify(body.error), 503);
  return body?.result;
}

function u64le(buffer, offset) {
  let out = 0n;
  for (let i = 7; i >= 0; i -= 1) out = (out << 8n) + BigInt(buffer[offset + i] || 0);
  return out;
}

function base58Decode(value) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const char of String(value || "")) {
    const index = alphabet.indexOf(char);
    if (index < 0) return Buffer.alloc(0);
    n = n * 58n + BigInt(index);
  }
  const bytes = [];
  while (n > 0n) { bytes.push(Number(n & 255n)); n >>= 8n; }
  bytes.reverse();
  let leading = 0;
  for (const char of String(value || "")) { if (char === "1") leading += 1; else break; }
  return Buffer.concat([Buffer.alloc(leading), Buffer.from(bytes)]);
}

function accountKeyText(item) {
  if (typeof item === "string") return item;
  return String(item?.pubkey || "");
}

function solanaInstructionAccounts(ix, keys) {
  if (Array.isArray(ix?.accounts) && ix.accounts.every((v) => typeof v === "string")) return ix.accounts;
  if (Array.isArray(ix?.accounts)) return ix.accounts.map((i) => accountKeyText(keys[Number(i)])).filter(Boolean);
  return [];
}

function solanaInstructionProgram(ix, keys) {
  if (ix?.programId) return String(ix.programId);
  if (Number.isInteger(ix?.programIdIndex)) return accountKeyText(keys[ix.programIdIndex]);
  return "";
}

async function anchorDiscriminator(name) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

export function isNormalTournamentReward(row) {
  return String(row?.reward_type || "").trim().toLowerCase() === "tournament" && TOURNAMENT_CHAINS.has(rowChainId(row));
}

export function normalTournamentEntitlementIdentity(row, { requestedChainId, requestedWallet } = {}) {
  if (String(row?.reward_type || "").trim().toLowerCase() !== "tournament") {
    throw new RewardClaimVerificationError("TOURNAMENT_CLAIM_TYPE_MISMATCH", "Normal Tournament recovery accepts only Tournament reward entitlements.", 400);
  }
  const chainId = rowChainId(row);
  if (!TOURNAMENT_CHAINS.has(chainId)) throw new RewardClaimVerificationError("TOURNAMENT_CLAIM_CHAIN_UNSUPPORTED", "Tournament entitlement is on an unsupported claim chain.", 400);
  if (requestedChainId != null && Number(requestedChainId) !== chainId) throw new RewardClaimVerificationError("REWARD_CHAIN_MISMATCH", "Tournament entitlement belongs to a different chain.", 409);

  const tournamentId = String(row?.source_id || "").trim();
  if (!tournamentId) throw new RewardClaimVerificationError("TOURNAMENT_SOURCE_ID_MISSING", "Tournament entitlement is missing its tournament/source identity.", 409);
  const meta = readMeta(row);
  const version = firstString(meta, ["entitlementVersion", "tournamentVersion", "version", "battleVersion"]) || "normal-v1";
  const amount = String(row?.amount ?? "").trim();
  if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) throw new RewardClaimVerificationError("CLAIM_AMOUNT_MISMATCH", "Tournament entitlement amount is invalid.", 409);
  const asset = String(row?.token_symbol || "").trim().toUpperCase();
  const expectedAsset = expectedNativeSymbol(chainId);
  if (asset !== expectedAsset) throw new RewardClaimVerificationError("TOURNAMENT_CLAIM_ASSET_MISMATCH", `Tournament claims on chain ${chainId} must settle in ${expectedAsset}.`, 409);

  if (SOLANA_CHAINS.has(chainId)) {
    const recipient = String(row?.wallet_address || "").trim();
    let recipientBytes;
    try { recipientBytes = publicKeyBytes(recipient); } catch {}
    if (!recipientBytes || recipientBytes.length !== 32) throw new RewardClaimVerificationError("CLAIM_WALLET_MISMATCH", "Tournament entitlement does not contain a valid Solana recipient.", 409);
    if (requestedWallet && String(requestedWallet).trim() !== recipient) throw new RewardClaimVerificationError("CLAIM_WALLET_MISMATCH", "Connected wallet does not match Tournament recipient.", 409);
    const competitionId = requireBytes32(firstString(meta, ["competitionIdBytes32", "tournamentIdBytes32", "competitionId", "onchainCompetitionId"]), "TOURNAMENT_ID_MISSING", "Solana Tournament entitlement is missing its canonical competition id.");
    const programId = solanaProgramId(meta);
    const poolAddress = findProgramAddressSync([COMPETITION_POOL_SEED, competitionBytes(competitionId)], programId).publicKey;
    return { chainId, tournamentId, version, recipient, amount, asset, competitionId, programId, poolAddress };
  }

  const recipient = String(row?.wallet_address || "").trim();
  if (!ADDRESS_RE.test(recipient)) throw new RewardClaimVerificationError("CLAIM_WALLET_MISMATCH", "Tournament entitlement does not contain a valid EVM recipient.", 409);
  if (requestedWallet && !sameEvmAddress(recipient, requestedWallet)) throw new RewardClaimVerificationError("CLAIM_WALLET_MISMATCH", "Connected wallet does not match Tournament recipient.", 409);
  const contractBatchId = requireBytes32(firstString(meta, ["contractBatchId", "merkleBatchId", "batchIdBytes32", "rewardBatchBytes32", "claimBatchBytes32"]), "CLAIM_BATCH_MISMATCH", "Tournament entitlement is missing its RewardDistributor batch id.");
  const merkleRoot = requireBytes32(firstString(meta, ["merkleRoot", "root", "claimRoot"]), "CLAIM_BATCH_ROOT_MISMATCH", "Tournament entitlement is missing its Merkle root.");
  const distributorRaw = firstString(meta, ["distributorAddress", "rewardDistributorAddress", "claimContractAddress", "contractAddress"]);
  let distributorAddress;
  try { distributorAddress = getAddress(distributorRaw); } catch { throw new RewardClaimVerificationError("CLAIM_CONTRACT_MISMATCH", "Tournament entitlement is missing a valid RewardDistributor address.", 409); }
  return { chainId, tournamentId, version, recipient: getAddress(recipient), amount, asset, contractBatchId, merkleRoot, distributorAddress };
}

export function buildNormalTournamentClaimCall(row) {
  const identity = normalTournamentEntitlementIdentity(row);
  if (SOLANA_CHAINS.has(identity.chainId)) {
    return {
      rewardLedgerId: String(row.id), chainId: identity.chainId, tokenSymbol: "SOL", mode: "solana_tournament",
      kind: "solana_tournament", enabled: true, reason: null, instruction: "claim_competition_winner_v2",
      programId: identity.programId, poolAddress: identity.poolAddress, recipient: identity.recipient,
      competitionId: identity.competitionId, amount: identity.amount, explorerTxBase: "https://explorer.solana.com/tx/",
    };
  }
  const meta = readMeta(row);
  const proofRaw = Array.isArray(meta.merkleProof) ? meta.merkleProof : Array.isArray(meta.proof) ? meta.proof : [];
  const proof = proofRaw.map((v) => String(v || "").trim());
  if (!proof.every((v) => BYTES32_RE.test(v))) throw new RewardClaimVerificationError("INVALID_MERKLE_PROOF", "Tournament Merkle proof is invalid.", 409);
  return {
    rewardLedgerId: String(row.id), chainId: identity.chainId, tokenSymbol: identity.asset, mode: "reward_distributor_merkle",
    enabled: true, reason: null, distributorAddress: identity.distributorAddress, contractAddress: identity.distributorAddress,
    contractName: "RewardDistributor", functionName: "claim", functionSignature: "claim(bytes32,uint256,bytes32[])",
    contractBatchId: identity.contractBatchId, batchId: identity.contractBatchId, amount: identity.amount, proof,
    args: [identity.contractBatchId, identity.amount, proof],
  };
}

async function recoverEvmTournament(identity) {
  const provider = evmProvider(identity.chainId);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== identity.chainId) throw new RewardClaimVerificationError("CLAIM_PROVIDER_CHAIN_MISMATCH", "Tournament recovery RPC returned the wrong chain.", 503);
  const distributor = new Contract(identity.distributorAddress, REWARD_DISTRIBUTOR_INTERFACE, provider);
  let hasClaimed, batch, latest;
  try { [hasClaimed, batch, latest] = await Promise.all([distributor.hasClaimed(identity.contractBatchId, identity.recipient), distributor.batches(identity.contractBatchId), provider.getBlockNumber()]); }
  catch (error) { throw new RewardClaimVerificationError("CLAIM_RECOVERY_STATE_UNAVAILABLE", `Could not read Tournament RewardDistributor state: ${error?.message || error}`, 503); }
  if (!Boolean(batch?.exists ?? batch?.[5])) throw new RewardClaimVerificationError("CLAIM_BATCH_MISSING", "Tournament RewardDistributor batch does not exist.", 409);
  const root = String(batch?.merkleRoot ?? batch?.[0] ?? "");
  if (root.toLowerCase() !== identity.merkleRoot.toLowerCase()) throw new RewardClaimVerificationError("CLAIM_BATCH_ROOT_MISMATCH", "Tournament RewardDistributor root does not match entitlement.", 409);
  if (!Boolean(hasClaimed)) return { claimed: false, identity };

  const configuredFrom = Number(process.env[`REWARD_CLAIM_RECOVERY_FROM_BLOCK_${identity.chainId}`] ?? process.env.REWARD_CLAIM_RECOVERY_FROM_BLOCK ?? 0);
  const fromBlock = Number.isFinite(configuredFrom) && configuredFrom >= 0 ? Math.floor(configuredFrom) : 0;
  const filter = REWARD_DISTRIBUTOR_INTERFACE.encodeFilterTopics(REWARD_DISTRIBUTOR_INTERFACE.getEvent("RewardClaimed"), [identity.contractBatchId, identity.recipient]);
  let logs;
  try { logs = await provider.getLogs({ address: identity.distributorAddress, topics: filter, fromBlock, toBlock: latest }); }
  catch (error) { throw new RewardClaimVerificationError("CLAIM_RECOVERY_EVENT_SCAN_FAILED", `Could not scan Tournament payout events: ${error?.message || error}`, 503); }
  let match = null;
  for (const log of logs) {
    try {
      const parsed = REWARD_DISTRIBUTOR_INTERFACE.parseLog(log);
      if (BigInt(parsed.args?.[2] ?? 0n) === BigInt(identity.amount)) { match = log; break; }
    } catch {}
  }
  if (!match) throw new RewardClaimVerificationError("CLAIM_RECOVERY_EVENT_NOT_FOUND", "RewardDistributor reports Tournament claimed but the exact payout event was not found. Refusing another payout request.", 503);
  const verified = await verifyEvmRewardClaim({ chainId: identity.chainId, txHash: match.transactionHash, walletAddress: identity.recipient, distributorAddress: identity.distributorAddress, batchId: identity.contractBatchId, amount: identity.amount, minConfirmations: 1, provider });
  return { claimed: true, ...verified, tournamentId: identity.tournamentId, version: identity.version, asset: identity.asset };
}

async function readSolanaPool(identity) {
  const result = await solanaRpc(identity.chainId, "getAccountInfo", [identity.poolAddress, { encoding: "base64", commitment: "confirmed" }]);
  const encoded = result?.value?.data?.[0];
  if (!encoded) throw new RewardClaimVerificationError("TOURNAMENT_POOL_MISSING", "Solana Tournament competition pool is missing.", 409);
  const data = Buffer.from(encoded, "base64");
  if (data.length < 338) throw new RewardClaimVerificationError("TOURNAMENT_POOL_INVALID", "Solana Tournament competition pool layout is invalid.", 409);
  const competitionId = `0x${data.subarray(9, 41).toString("hex")}`;
  const kind = data[41];
  const winnerWallet = data.subarray(279, 311);
  const pendingWinner = u64le(data, 311);
  const winnerClaimed = Boolean(data[335]);
  return { data, competitionId, kind, winnerWallet, pendingWinner, winnerClaimed };
}

async function verifySolanaTournamentTx(identity, txHash) {
  if (!SOLANA_SIGNATURE_RE.test(String(txHash || ""))) throw new RewardClaimVerificationError("INVALID_SOLANA_TX_SIGNATURE", "Invalid Solana Tournament transaction signature.", 400);
  const tx = await solanaRpc(identity.chainId, "getTransaction", [txHash, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
  if (!tx || tx?.meta?.err) throw new RewardClaimVerificationError("SOLANA_CLAIM_TX_FAILED", "Solana Tournament payout transaction is missing or failed.", 409);
  const keys = tx?.transaction?.message?.accountKeys || [];
  const instructions = tx?.transaction?.message?.instructions || [];
  const discriminator = await anchorDiscriminator("claim_competition_winner_v2");
  const expectedCompetition = competitionBytes(identity.competitionId);
  let matching = null;
  for (const ix of instructions) {
    if (solanaInstructionProgram(ix, keys) !== identity.programId) continue;
    const accounts = solanaInstructionAccounts(ix, keys);
    if (accounts[0] !== identity.recipient || accounts[1] !== identity.poolAddress) continue;
    const data = base58Decode(ix.data);
    if (data.length !== 40 || !data.subarray(0, 8).equals(discriminator) || !data.subarray(8).equals(expectedCompetition)) continue;
    matching = ix;
    break;
  }
  if (!matching) throw new RewardClaimVerificationError("SOLANA_CLAIM_INSTRUCTION_MISMATCH", "Confirmed transaction did not execute the exact Tournament winner claim instruction.", 409);
  const poolIndex = keys.findIndex((key) => accountKeyText(key) === identity.poolAddress);
  const pre = tx?.meta?.preBalances || [];
  const post = tx?.meta?.postBalances || [];
  if (poolIndex < 0 || pre[poolIndex] == null || post[poolIndex] == null) throw new RewardClaimVerificationError("SOLANA_CLAIM_BALANCE_UNAVAILABLE", "Tournament pool balance delta is unavailable.", 409);
  const paid = BigInt(pre[poolIndex]) - BigInt(post[poolIndex]);
  if (paid !== BigInt(identity.amount)) throw new RewardClaimVerificationError("CLAIM_AMOUNT_MISMATCH", "Solana Tournament payout amount does not match entitlement.", 409);
  return { verified: true, claimed: true, chainId: identity.chainId, txHash: String(txHash), programId: identity.programId, poolAddress: identity.poolAddress, recipient: identity.recipient, amount: identity.amount, tournamentId: identity.tournamentId, version: identity.version, asset: "SOL" };
}

async function recoverSolanaTournament(identity) {
  const pool = await readSolanaPool(identity);
  if (pool.kind !== 1) throw new RewardClaimVerificationError("TOURNAMENT_POOL_KIND_MISMATCH", "Solana competition pool is not a Normal Tournament.", 409);
  if (pool.competitionId.toLowerCase() !== identity.competitionId.toLowerCase()) throw new RewardClaimVerificationError("TOURNAMENT_ID_MISMATCH", "Solana competition pool identity does not match entitlement.", 409);
  const recipientBytes = Buffer.from(publicKeyBytes(identity.recipient));
  if (!pool.winnerWallet.equals(recipientBytes)) throw new RewardClaimVerificationError("CLAIM_WALLET_MISMATCH", "Solana Tournament winner does not match entitlement recipient.", 409);
  if (!pool.winnerClaimed) {
    if (pool.pendingWinner !== BigInt(identity.amount)) throw new RewardClaimVerificationError("CLAIM_AMOUNT_MISMATCH", "Solana Tournament pending winner amount does not match entitlement.", 409);
    return { claimed: false, identity };
  }
  if (pool.pendingWinner !== 0n) throw new RewardClaimVerificationError("CLAIM_RECOVERY_STATE_MISMATCH", "Solana Tournament is marked claimed but pending winner amount is non-zero.", 503);
  const signatures = await solanaRpc(identity.chainId, "getSignaturesForAddress", [identity.poolAddress, { limit: 1000, commitment: "confirmed" }]);
  for (const item of signatures || []) {
    if (item?.err || !item?.signature) continue;
    try { return await verifySolanaTournamentTx(identity, item.signature); } catch (error) {
      if (error?.code === "SOLANA_CLAIM_INSTRUCTION_MISMATCH" || error?.code === "CLAIM_AMOUNT_MISMATCH") continue;
      throw error;
    }
  }
  throw new RewardClaimVerificationError("CLAIM_RECOVERY_EVENT_NOT_FOUND", "Solana Tournament is marked claimed but the exact payout transaction was not found. Refusing another payout request.", 503);
}

export async function recoverNormalTournamentClaim({ row, requestedChainId, requestedWallet }) {
  const identity = normalTournamentEntitlementIdentity(row, { requestedChainId, requestedWallet });
  const evidence = SOLANA_CHAINS.has(identity.chainId) ? await recoverSolanaTournament(identity) : await recoverEvmTournament(identity);
  return { claimed: Boolean(evidence?.claimed), identity, evidence };
}

export async function verifyNormalTournamentClaim({ row, txHash, requestedChainId, requestedWallet }) {
  const identity = normalTournamentEntitlementIdentity(row, { requestedChainId, requestedWallet });
  if (SOLANA_CHAINS.has(identity.chainId)) return verifySolanaTournamentTx(identity, txHash);
  return verifyEvmRewardClaim({ chainId: identity.chainId, txHash, walletAddress: identity.recipient, distributorAddress: identity.distributorAddress, batchId: identity.contractBatchId, amount: identity.amount, minConfirmations: 1 });
}
