import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ethers } from 'ethers';

export const RH46630_CHAIN_ID = 46630;
export const FORBIDDEN_PRODUCTION_CHAIN_ID = 4663;
export const ARENA_WAR_POOL_TREASURY_V2 = '0x1eDd34933E5395c82F14CE2A220b81adF35C52B7';
export const ARENA_WAR_POOL_TREASURY_V2_RUNTIME_HASH =
  '0x79979c3684c328e866c2b5b03d276cda7072a4c39d7f5b55c42672f9cb82958d';
export const DEFAULT_RPC_URL = 'https://robinhood-sepolia-rpc.publicnode.com';
export const TOURNAMENT_KIND = 1;

export const TOURNAMENT_ABI = [
  'function GENERATION() view returns (uint256)',
  'function openTournamentPool(bytes32 poolId,uint96 buyInAmount,uint256 depositDeadline,uint256 resolveDeadline)',
  'function depositBuyIn(bytes32 poolId) payable',
  'function setTournamentLive(bytes32 poolId)',
  'function buyIns(bytes32,address) view returns (uint256)',
  'function pools(bytes32) view returns (uint8 kind,uint8 state,address ownerA,address ownerB,uint96 stakeAmount,uint96 buyInAmount,uint256 stakeA,uint256 stakeB,uint256 buyInTotal,uint256 boostTotal,address winnerPayout,uint256 pendingWinner,uint256 pendingProtocol,uint256 pendingLeague,uint256 depositDeadline,uint256 resolveDeadline,bool claimedWinner,bool claimedProtocol,bool claimedLeague,bool refundedA,bool refundedB)',
];

export function tournamentPoolId(tournamentId) {
  const id = String(tournamentId || '').trim();
  if (!id) throw new Error('TOURNAMENT_ID_REQUIRED');
  return ethers.id(`arena-tournament:${id}`);
}

export function assertTournamentChainId(chainId) {
  const id = Number(chainId);
  if (id === FORBIDDEN_PRODUCTION_CHAIN_ID) throw new Error('PRODUCTION_4663_FORBIDDEN');
  if (id !== RH46630_CHAIN_ID) throw new Error(`WRONG_CHAIN_${id}`);
  return id;
}

export function liveRequested(env = process.env) {
  return String(env.T2_TOURNAMENT_OPEN_LIVE || '').trim() === '1';
}

export function planTournamentOpenBuyIn(input = {}, env = process.env) {
  const chainId = assertTournamentChainId(input.chainId ?? env.T2_CHAIN_ID ?? RH46630_CHAIN_ID);
  const tournamentId = String(input.tournamentId || env.T2_TOURNAMENT_ID || '').trim();
  if (!tournamentId) throw new Error('TOURNAMENT_ID_REQUIRED');
  const buyInAmount = BigInt(String(input.buyInAmount || env.T2_BUY_IN_WEI || '0'));
  if (buyInAmount <= 0n) throw new Error('BUY_IN_AMOUNT_ZERO');
  const live = liveRequested(env);
  const creatorKey = String(env.T2_TOURNAMENT_CREATOR_PRIVATE_KEY || env.ROBINHOOD_TESTNET_DEPLOYER_PRIVATE_KEY || '').trim();
  const buyerKey = String(env.T2_TOURNAMENT_BUYER_PRIVATE_KEY || env.T2_EVM_OWNER_PRIVATE_KEY || '').trim();
  if (live && (!creatorKey || !buyerKey)) throw new Error('MISSING_TOURNAMENT_KEYS');
  const now = Number(input.now || Math.floor(Date.now() / 1000));
  const poolId = tournamentPoolId(tournamentId);
  return {
    mode: live ? 'live-gated' : 'dry-run',
    chainId,
    native: 'ETH',
    treasury: ARENA_WAR_POOL_TREASURY_V2,
    runtimeHash: ARENA_WAR_POOL_TREASURY_V2_RUNTIME_HASH,
    tournamentId,
    poolId,
    buyInAmount: buyInAmount.toString(),
    openTournamentPool: {
      method: 'openTournamentPool',
      args: [poolId, buyInAmount.toString(), String(now + 3600), String(now + 7200)],
    },
    depositBuyIn: { method: 'depositBuyIn', args: [poolId], value: buyInAmount.toString() },
    setTournamentLive: { method: 'setTournamentLive', args: [poolId] },
    liveRequested: live,
    sendRequired: live,
  };
}

export async function runTournamentOpenBuyIn({
  env = process.env,
  plan,
  sendOpen,
  sendBuyIn,
  sendLive,
} = {}) {
  const resolved = plan || planTournamentOpenBuyIn({}, env);
  if (!resolved.sendRequired) return { ...resolved, sent: false };
  if (![sendOpen, sendBuyIn, sendLive].every((fn) => typeof fn === 'function')) throw new Error('SENDERS_REQUIRED');
  const openTx = await sendOpen(resolved);
  const buyInTx = await sendBuyIn(resolved);
  const liveTx = await sendLive(resolved);
  return { ...resolved, sent: true, openTx: openTx || null, buyInTx: buyInTx || null, liveTx: liveTx || null };
}

async function createRpcSenders(env = process.env) {
  const rpcUrl = String(env.ROBINHOOD_TESTNET_RPC_URL || env.RH46630_RPC_URL || DEFAULT_RPC_URL).trim();
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  assertTournamentChainId((await provider.getNetwork()).chainId);
  const code = await provider.getCode(ARENA_WAR_POOL_TREASURY_V2);
  if (!code || code === '0x') throw new Error('MISSING_RUNTIME');
  if (ethers.keccak256(code).toLowerCase() !== ARENA_WAR_POOL_TREASURY_V2_RUNTIME_HASH.toLowerCase()) {
    throw new Error('RUNTIME_HASH_MISMATCH');
  }
  const reader = new ethers.Contract(ARENA_WAR_POOL_TREASURY_V2, TOURNAMENT_ABI, provider);
  if ((await reader.GENERATION()) !== 2n) throw new Error('ARENA_GENERATION_MISMATCH');
  const creatorKey = String(env.T2_TOURNAMENT_CREATOR_PRIVATE_KEY || env.ROBINHOOD_TESTNET_DEPLOYER_PRIVATE_KEY).trim();
  const buyerKey = String(env.T2_TOURNAMENT_BUYER_PRIVATE_KEY || env.T2_EVM_OWNER_PRIVATE_KEY).trim();
  const creator = new ethers.Wallet(creatorKey.startsWith('0x') ? creatorKey : `0x${creatorKey}`, provider);
  const buyer = new ethers.Wallet(buyerKey.startsWith('0x') ? buyerKey : `0x${buyerKey}`, provider);
  const creatorC = reader.connect(creator);
  const buyerC = reader.connect(buyer);

  const sendOpen = async (plan) => {
    const pool = await reader.pools(plan.poolId);
    if (pool.ownerA !== ethers.ZeroAddress) return null;
    const args = plan.openTournamentPool.args;
    const tx = await creatorC.openTournamentPool(args[0], BigInt(args[1]), BigInt(args[2]), BigInt(args[3]));
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error('OPEN_TOURNAMENT_FAILED');
    return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
  };
  const sendBuyIn = async (plan) => {
    const paid = await reader.buyIns(plan.poolId, buyer.address);
    if (paid === BigInt(plan.buyInAmount)) return null;
    const tx = await buyerC.depositBuyIn(plan.poolId, { value: BigInt(plan.buyInAmount) });
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error('DEPOSIT_BUY_IN_FAILED');
    return { txHash: receipt.hash, buyer: buyer.address, blockNumber: receipt.blockNumber };
  };
  const sendLive = async (plan) => {
    const pool = await reader.pools(plan.poolId);
    if (Number(pool.kind) !== TOURNAMENT_KIND) throw new Error('WRONG_POOL_KIND');
    if (Number(pool.state) === 1) return null;
    const tx = await creatorC.setTournamentLive(plan.poolId);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error('SET_TOURNAMENT_LIVE_FAILED');
    return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
  };
  return { rpcUrl, sendOpen, sendBuyIn, sendLive };
}

async function main() {
  const plan = planTournamentOpenBuyIn({}, process.env);
  if (!plan.sendRequired) {
    console.log(JSON.stringify({ ...plan, sent: false }, null, 2));
    return;
  }
  const runtime = await createRpcSenders(process.env);
  const result = await runTournamentOpenBuyIn({ env: process.env, plan, ...runtime });
  console.log(JSON.stringify({ rpcUrl: runtime.rpcUrl, ...result }, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`[t2-tournament-open-buyin-evm-real] ${error?.stack || error}`);
    process.exitCode = 1;
  });
}
