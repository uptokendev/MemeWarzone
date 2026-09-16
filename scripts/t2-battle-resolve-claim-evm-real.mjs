import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ethers } from 'ethers';

import { signResolvePoolV2 } from '../frontend/api/lib/arenaWarPoolEscrow.js';

export const RH46630_CHAIN_ID = 46630;
export const FORBIDDEN_PRODUCTION_CHAIN_ID = 4663;
export const ARENA_WAR_POOL_TREASURY_V2 = '0x1eDd34933E5395c82F14CE2A220b81adF35C52B7';
export const ARENA_WAR_POOL_TREASURY_V2_RUNTIME_HASH =
  '0x79979c3684c328e866c2b5b03d276cda7072a4c39d7f5b55c42672f9cb82958d';
export const DEFAULT_POOL_ID = '0x3e10ac583831e39e248b81a2516c5f79c3b73e34e1fcd7b2da8536a9f20abdc4';
export const DEFAULT_WINNER = '0xeAE58347aA643a228C88Bd62295651388163E1CA';
export const RESOLVER = '0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714';
export const DEFAULT_RPC_URL = 'https://robinhood-sepolia-rpc.publicnode.com';
export const LIVE_STATE = 1;
export const RESOLVED_STATE = 2;

export const RESOLVE_CLAIM_ABI = [
  'function GENERATION() view returns (uint256)',
  'function resolver() view returns (address)',
  'function pools(bytes32) view returns (uint8 kind,uint8 state,address ownerA,address ownerB,uint96 stakeAmount,uint96 buyInAmount,uint256 stakeA,uint256 stakeB,uint256 buyInTotal,uint256 boostTotal,address winnerPayout,uint256 pendingWinner,uint256 pendingProtocol,uint256 pendingLeague,uint256 depositDeadline,uint256 resolveDeadline,bool claimedWinner,bool claimedProtocol,bool claimedLeague,bool refundedA,bool refundedB)',
  'function resolve(bytes32 poolId,address winnerPayout,uint256 deadline,bytes signature)',
  'function claimWinner(bytes32 poolId)',
  'function claimProtocol(bytes32 poolId)',
  'function claimLeague(bytes32 poolId,bytes32 monthlyEpoch,bytes32 quarterlyEpoch)',
];

export function assertBattleChainId(chainId) {
  const id = Number(chainId);
  if (id === FORBIDDEN_PRODUCTION_CHAIN_ID) throw new Error('PRODUCTION_4663_FORBIDDEN');
  if (id !== RH46630_CHAIN_ID) throw new Error(`WRONG_CHAIN_${id}`);
  return id;
}

export function liveRequested(env = process.env) {
  return String(env.T2_BATTLE_RESOLVE_LIVE || '').trim() === '1';
}

export function leagueEpochs(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  return {
    monthlyEpoch: ethers.id(`${year}-${String(month).padStart(2, '0')}`),
    quarterlyEpoch: ethers.id(`${year}-Q${Math.floor((month - 1) / 3) + 1}`),
  };
}

export function planResolveClaim(input = {}, env = process.env) {
  const chainId = assertBattleChainId(input.chainId ?? env.T2_CHAIN_ID ?? RH46630_CHAIN_ID);
  const poolId = String(input.poolId || env.T2_BATTLE_POOL_ID || DEFAULT_POOL_ID).trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(poolId)) throw new Error('POOL_ID_REQUIRED');
  const winnerPayout = ethers.getAddress(input.winnerPayout || env.T2_WINNER_PAYOUT || DEFAULT_WINNER);
  const live = liveRequested(env);
  const resolverKey = String(env.ARENA_WAR_POOL_RESOLVER_KEY || env.ROBINHOOD_TESTNET_DEPLOYER_PRIVATE_KEY || '').trim();
  const winnerKey = String(env.T2_BATTLE_WINNER_PRIVATE_KEY || env.T2_BATTLE_OWNER_A_PRIVATE_KEY || '').trim();
  if (live && !resolverKey) throw new Error('MISSING_RESOLVER_KEY');
  if (live && !winnerKey) throw new Error('MISSING_WINNER_KEY');
  const epochs = leagueEpochs();
  return {
    mode: live ? 'live-gated' : 'dry-run',
    chainId,
    native: 'ETH',
    treasury: ARENA_WAR_POOL_TREASURY_V2,
    runtimeHash: ARENA_WAR_POOL_TREASURY_V2_RUNTIME_HASH,
    poolId,
    winnerPayout,
    resolver: RESOLVER,
    claimLeague: { method: 'claimLeague', ...epochs },
    liveRequested: live,
    sendRequired: live,
  };
}

export async function runResolveClaim({
  env = process.env,
  plan,
  sendResolve,
  sendClaimWinner,
  sendClaimProtocol,
  sendClaimLeague,
} = {}) {
  const resolved = plan || planResolveClaim({}, env);
  if (!resolved.sendRequired) {
    return { ...resolved, sent: false };
  }
  if (![sendResolve, sendClaimWinner, sendClaimProtocol, sendClaimLeague].every((fn) => typeof fn === 'function')) {
    throw new Error('SENDERS_REQUIRED');
  }
  const resolveTx = await sendResolve(resolved);
  const winnerTx = await sendClaimWinner(resolved);
  const protocolTx = await sendClaimProtocol(resolved);
  const leagueTx = await sendClaimLeague(resolved);
  return {
    ...resolved,
    sent: true,
    resolveTx: resolveTx || null,
    claimWinnerTx: winnerTx || null,
    claimProtocolTx: protocolTx || null,
    claimLeagueTx: leagueTx || null,
  };
}

async function createRpcSenders(env = process.env) {
  const rpcUrl = String(env.ROBINHOOD_TESTNET_RPC_URL || env.RH46630_RPC_URL || DEFAULT_RPC_URL).trim();
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  assertBattleChainId((await provider.getNetwork()).chainId);
  const code = await provider.getCode(ARENA_WAR_POOL_TREASURY_V2);
  if (!code || code === '0x') throw new Error('MISSING_RUNTIME');
  if (ethers.keccak256(code).toLowerCase() !== ARENA_WAR_POOL_TREASURY_V2_RUNTIME_HASH.toLowerCase()) {
    throw new Error('RUNTIME_HASH_MISMATCH');
  }
  const reader = new ethers.Contract(ARENA_WAR_POOL_TREASURY_V2, RESOLVE_CLAIM_ABI, provider);
  if ((await reader.GENERATION()) !== 2n) throw new Error('ARENA_GENERATION_MISMATCH');
  const onchainResolver = await reader.resolver();
  if (onchainResolver.toLowerCase() !== RESOLVER.toLowerCase()) throw new Error('RESOLVER_MISMATCH');

  const resolverKey = String(env.ARENA_WAR_POOL_RESOLVER_KEY || env.ROBINHOOD_TESTNET_DEPLOYER_PRIVATE_KEY).trim();
  const winnerKey = String(env.T2_BATTLE_WINNER_PRIVATE_KEY || env.T2_BATTLE_OWNER_A_PRIVATE_KEY).trim();
  const resolverWallet = new ethers.Wallet(resolverKey.startsWith('0x') ? resolverKey : `0x${resolverKey}`, provider);
  const winnerWallet = new ethers.Wallet(winnerKey.startsWith('0x') ? winnerKey : `0x${winnerKey}`, provider);
  if (resolverWallet.address.toLowerCase() !== RESOLVER.toLowerCase()) {
    throw new Error(`RESOLVER_SIGNER_REQUIRED_${resolverWallet.address}`);
  }

  const resolverContract = reader.connect(resolverWallet);
  const winnerContract = reader.connect(winnerWallet);

  const sendResolve = async (plan) => {
    const pool = await reader.pools(plan.poolId);
    if (Number(pool.state) === RESOLVED_STATE) return null;
    if (Number(pool.state) !== LIVE_STATE) throw new Error(`POOL_NOT_LIVE_${pool.state}`);
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const stakeTotal = BigInt(pool.stakeA) + BigInt(pool.stakeB);
    const signed = await signResolvePoolV2({
      treasuryAddress: ARENA_WAR_POOL_TREASURY_V2,
      chainId: RH46630_CHAIN_ID,
      poolId: plan.poolId,
      winnerPayout: plan.winnerPayout,
      stakeTotal,
      buyInTotal: BigInt(pool.buyInTotal),
      boostTotal: BigInt(pool.boostTotal),
      deadline,
    });
    if (!signed) throw new Error('RESOLVE_SIGNATURE_MISSING');
    const tx = await resolverContract.resolve(plan.poolId, plan.winnerPayout, deadline, signed.signature);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error('RESOLVE_FAILED');
    return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
  };

  const sendClaimWinner = async (plan) => {
    if (winnerWallet.address.toLowerCase() !== plan.winnerPayout.toLowerCase()) {
      throw new Error(`WINNER_SIGNER_REQUIRED_${winnerWallet.address}`);
    }
    const pool = await reader.pools(plan.poolId);
    if (pool.claimedWinner) return null;
    const tx = await winnerContract.claimWinner(plan.poolId);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error('CLAIM_WINNER_FAILED');
    return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
  };

  const sendClaimProtocol = async (plan) => {
    const pool = await reader.pools(plan.poolId);
    if (pool.claimedProtocol) return null;
    const tx = await resolverContract.claimProtocol(plan.poolId);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error('CLAIM_PROTOCOL_FAILED');
    return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
  };

  const sendClaimLeague = async (plan) => {
    const pool = await reader.pools(plan.poolId);
    if (pool.claimedLeague) return null;
    const tx = await resolverContract.claimLeague(
      plan.poolId,
      plan.claimLeague.monthlyEpoch,
      plan.claimLeague.quarterlyEpoch,
    );
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error('CLAIM_LEAGUE_FAILED');
    return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
  };

  return { rpcUrl, sendResolve, sendClaimWinner, sendClaimProtocol, sendClaimLeague };
}

async function main() {
  const plan = planResolveClaim({}, process.env);
  if (!plan.sendRequired) {
    console.log(JSON.stringify({ ...plan, sent: false }, null, 2));
    return;
  }
  const runtime = await createRpcSenders(process.env);
  const result = await runResolveClaim({ env: process.env, plan, ...runtime });
  console.log(JSON.stringify({ rpcUrl: runtime.rpcUrl, ...result }, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`[t2-battle-resolve-claim-evm-real] ${error?.stack || error}`);
    process.exitCode = 1;
  });
}
