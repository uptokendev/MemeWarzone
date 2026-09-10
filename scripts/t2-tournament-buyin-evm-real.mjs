import fs from "node:fs";
import path from "node:path";
import { Contract, JsonRpcProvider, Wallet, getAddress, keccak256 } from "ethers";

const AUTHORITY = Object.freeze({
  97: { treasury: "0xAb8cb6d117b79dd7502898e50C900360924fDa85", runtimeHash: "0xfec2ed674329f7145f202948cfae00abd0fd6fc4a8cdbdb129e8fd2c9c493422", native: "BNB" },
  46630: { treasury: "0x1eDd34933E5395c82F14CE2A220b81adF35C52B7", runtimeHash: "0x79979c3684c328e866c2b5b03d276cda7072a4c39d7f5b55c42672f9cb82958d", native: "ETH" },
});
const ABI = [
  "function GENERATION() view returns (uint256)",
  "function pools(bytes32) view returns (uint8 kind,uint8 state,address ownerA,address ownerB,uint96 stakeAmount,uint96 buyInAmount,uint256 stakeA,uint256 stakeB,uint256 buyInTotal,uint256 boostTotal,address winnerPayout,uint256 pendingWinner,uint256 pendingProtocol,uint256 pendingLeague,uint256 depositDeadline,uint256 resolveDeadline,bool claimedWinner,bool claimedProtocol,bool claimedLeague,bool refundedA,bool refundedB)",
  "function buyIns(bytes32,address) view returns (uint256)",
  "function depositBuyIn(bytes32) payable",
];

function required(name) { const value = String(process.env[name] || "").trim(); if (!value) throw new Error(`${name} is required`); return value; }
function enabled(name) { return /^(1|true|yes|on)$/i.test(String(process.env[name] || "").trim()); }
function apiBase() { return required("T2_API_BASE_URL").replace(/\/+$/, ""); }
function apiUrl(route) { return `${apiBase()}${route.startsWith("/api/") ? route : `/api${route}`}`; }
async function jsonFetch(url, init = {}) {
  const response = await fetch(url, init); const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok === false) throw new Error(`${response.status} ${body?.code || ""} ${body?.error || body?.reason || "request failed"}`.trim());
  return body;
}
async function status(tournamentId, token, wallet, chainId) {
  const qs = new URLSearchParams({ tokenAddress: token, walletAddress: wallet, chainId: String(chainId) });
  return jsonFetch(apiUrl(`/arena/tournaments/${encodeURIComponent(tournamentId)}/buy-in-status?${qs}`));
}
function buildMessage({ wallet, chainId, nonce, tournamentId, token, txHash = "" }) {
  return ["MemeWarzone API Action", "Action: arena_tournament_buy_in", `Wallet: ${wallet.toLowerCase()}`, `Chain ID: ${chainId}`, `Tournament: ${tournamentId}`, `Token: ${token.toLowerCase()}`, txHash ? `Tx: ${txHash}` : "Reconcile: authoritative chain state", `Nonce: ${nonce}`].join("\n");
}
async function auth(walletSigner, chainId, tournamentId, token, txHash = "") {
  const wallet = walletSigner.address;
  const nonceBody = await jsonFetch(apiUrl(`/auth/nonce?${new URLSearchParams({ chainId: String(chainId), address: wallet.toLowerCase() })}`));
  const nonce = String(nonceBody.nonce); const message = buildMessage({ wallet, chainId, nonce, tournamentId, token, txHash });
  return { action: "arena_tournament_buy_in", walletAddress: wallet.toLowerCase(), chainId, nonce, message, signature: await walletSigner.signMessage(message), walletType: "evm" };
}
async function reconcile(walletSigner, chainId, tournamentId, token, txHash = "") {
  const credential = await auth(walletSigner, chainId, tournamentId, token, txHash);
  return jsonFetch(apiUrl(`/arena/tournaments/${encodeURIComponent(tournamentId)}/buy-in-receipt`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tokenAddress: token, walletAddress: walletSigner.address, chainId, ...(txHash ? { txHash } : {}), auth: credential }) });
}

async function main() {
  if (!enabled("T2_ALLOW_REAL_PAYMENT")) throw new Error("Real payment gate is closed. Set T2_ALLOW_REAL_PAYMENT=true only after Launch Control authorizes financial staging execution.");
  const chainId = Number(required("T2_CHAIN_ID")); const authority = AUTHORITY[chainId];
  if (!authority) throw new Error(`T2 EVM real runner only permits chain 97 or 46630; got ${chainId}`);
  const kind = required("T2_TOURNAMENT_TYPE").toLowerCase(); if (!new Set(["battle", "vote"]).has(kind)) throw new Error("T2_TOURNAMENT_TYPE must be battle or vote");
  const tournamentId = required("T2_TOURNAMENT_ID"); const token = getAddress(required("T2_TOKEN_ADDRESS"));
  const rpc = chainId === 97 ? (process.env.BSC_TESTNET_RPC || process.env.BSC_TESTNET_RPC_URL || process.env.BSC_RPC_HTTP_97) : (process.env.ROBINHOOD_TESTNET_RPC_URL || process.env.ROBINHOOD_TESTNET_RPC || process.env.ROBINHOOD_RPC_HTTP_46630);
  if (!rpc) throw new Error(`RPC env is missing for chain ${chainId}`);
  const provider = new JsonRpcProvider(String(rpc)); const network = await provider.getNetwork();
  if (Number(network.chainId) !== chainId) throw new Error(`RPC chain mismatch: expected ${chainId}, got ${network.chainId}`);
  const signer = new Wallet(required("T2_EVM_OWNER_PRIVATE_KEY"), provider); const treasury = getAddress(authority.treasury);
  const code = await provider.getCode(treasury); if (!code || code === "0x") throw new Error("ArenaWarPoolTreasuryV2 bytecode missing");
  if (keccak256(code).toLowerCase() !== authority.runtimeHash) throw new Error("ArenaWarPoolTreasuryV2 runtime hash mismatch");
  const contract = new Contract(treasury, ABI, signer); if (BigInt(await contract.GENERATION()) !== 2n) throw new Error("Arena generation mismatch");

  const before = await status(tournamentId, token, signer.address, chainId);
  if (getAddress(String(before.treasury)) !== treasury) throw new Error("Backend Treasury mismatch");
  const poolId = String(before.poolId); const expected = BigInt(String(before.amountRaw)); if (expected <= 0n) throw new Error("Configured buy-in is zero");
  const poolState = await contract.pools(poolId); if (Number(poolState.kind) !== 1) throw new Error("Wrong pool kind");
  if (BigInt(poolState.buyInAmount) !== expected) throw new Error("On-chain buy-in differs from backend/DB authority");

  let txHash = "";
  const paidBefore = BigInt(await contract.buyIns(poolId, signer.address));
  if (paidBefore === 0n) {
    const balance = await provider.getBalance(signer.address); if (balance <= expected) throw new Error(`Owner wallet lacks ${authority.native} for buy-in + gas`);
    const tx = await contract.depositBuyIn(poolId, { value: expected }); const receipt = await tx.wait();
    if (!receipt || Number(receipt.status) !== 1) throw new Error("depositBuyIn did not confirm"); txHash = tx.hash;
  } else if (paidBefore !== expected) throw new Error("Existing buyIns value is not the exact configured amount");

  const first = await reconcile(signer, chainId, tournamentId, token, txHash);
  const after = await status(tournamentId, token, signer.address, chainId);
  if (!after.buyInPaid || !after.chainPaid) throw new Error("API/chain did not converge to paid=true");
  const paidAfter = BigInt(await contract.buyIns(poolId, signer.address)); if (paidAfter !== expected) throw new Error("Economic payment changed unexpectedly");
  const duplicate = await reconcile(signer, chainId, tournamentId, token);
  const paidAfterDuplicate = BigInt(await contract.buyIns(poolId, signer.address)); if (paidAfterDuplicate !== expected) throw new Error("Duplicate reconciliation changed economic payment");

  const evidence = { accepted: true, type: kind, chainId, nativeSymbol: authority.native, tournamentId, token, wallet: signer.address, treasury, runtimeHash: authority.runtimeHash, poolId, amountRaw: expected.toString(), txHash: txHash || null, recoveredExistingDeposit: paidBefore === expected, firstReconciliationIdempotent: Boolean(first.idempotent), duplicateReconciliationIdempotent: Boolean(duplicate.idempotent), buyInsAfter: paidAfterDuplicate.toString(), dbPaidAfter: Boolean(after.buyInPaid), chainPaidAfter: Boolean(after.chainPaid) };
  const out = path.resolve(process.env.T2_EVIDENCE_FILE || `reports/t2-${kind}-tournament-buyin-${chainId}.json`); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`); console.log(JSON.stringify(evidence, null, 2));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
