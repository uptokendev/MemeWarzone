import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ethers } from 'ethers';

export const RH46630_CHAIN_ID = 46630;
export const FORBIDDEN_PRODUCTION_CHAIN_ID = 4663;
export const ARENA_WAR_POOL_TREASURY_V2 = '0x1eDd34933E5395c82F14CE2A220b81adF35C52B7';
export const ARENA_WAR_POOL_TREASURY_V2_RUNTIME_HASH =
  '0x79979c3684c328e866c2b5b03d276cda7072a4c39d7f5b55c42672f9cb82958d';
export const BATTLE_KIND = 0;
export const DEFAULT_RPC_URL = 'https://robinhood-sepolia-rpc.publicnode.com';

export const BATTLE_STAKE_ABI = [
  'function GENERATION() view returns (uint256)',
  'function openBattlePool(bytes32 poolId,address ownerA,address ownerB,uint96 stakeAmount,uint256 depositDeadline,uint256 resolveDeadline) payable',
  'function depositStake(bytes32 poolId) payable',
  'function pools(bytes32) view returns (uint8 kind,uint8 state,address ownerA,address ownerB,uint96 stakeAmount,uint96 buyInAmount,uint256 stakeA,uint256 stakeB,uint256 buyInTotal,uint256 boostTotal,address winnerPayout,uint256 pendingWinner,uint256 pendingProtocol,uint256 pendingLeague,uint256 depositDeadline,uint256 resolveDeadline,bool claimedWinner,bool claimedProtocol,bool claimedLeague,bool refundedA,bool refundedB)',
];

function cleanAddress(value) {
  const s = String(value || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) throw new Error(`INVALID_ADDRESS_${s || 'EMPTY'}`);
  return ethers.getAddress(s);
}

export function battlePoolId(battleId) {
  const id = String(battleId || '').trim();
  if (!id) throw new Error('BATTLE_ID_REQUIRED');
  return ethers.id(`arena-battle:${id}`);
}

export function assertBattleChainId(chainId) {
  const id = Number(chainId);
  if (id === FORBIDDEN_PRODUCTION_CHAIN_ID) throw new Error('PRODUCTION_4663_FORBIDDEN');
  if (id !== RH46630_CHAIN_ID) throw new Error(`WRONG_CHAIN_${id}`);
  return id;
}

export function liveRequested(env = process.env) {
  return String(env.T2_BATTLE_STAKE_LIVE || '').trim() === '1';
}

export function planBattleStake(input = {}, env = process.env) {
  const chainId = assertBattleChainId(input.chainId ?? env.T2_CHAIN_ID ?? RH46630_CHAIN_ID);
  const battleId = String(input.battleId || env.T2_BATTLE_ID || '').trim();
  if (!battleId) throw new Error('BATTLE_ID_REQUIRED');
  const ownerA = cleanAddress(input.ownerA || env.T2_BATTLE_OWNER_A);
  const ownerB = cleanAddress(input.ownerB || env.T2_BATTLE_OWNER_B);
  if (ownerA.toLowerCase() === ownerB.toLowerCase()) throw new Error('OWNERS_MUST_DIFFER');
  const stakeAmount = BigInt(String(input.stakeAmount || env.T2_STAKE_WEI || '0'));
  if (stakeAmount <= 0n) throw new Error('STAKE_AMOUNT_ZERO');

  const live = liveRequested(env);
  const keyA = String(env.T2_BATTLE_OWNER_A_PRIVATE_KEY || '').trim();
  const keyB = String(env.T2_BATTLE_OWNER_B_PRIVATE_KEY || '').trim();
  if (live && (!keyA || !keyB)) throw new Error('MISSING_OWNER_KEYS');

  const now = Number(input.now || Math.floor(Date.now() / 1000));
  const depositDeadline = BigInt(input.depositDeadline || now + 3600);
  const resolveDeadline = BigInt(input.resolveDeadline || now + 7200);
  const poolId = battlePoolId(battleId);

  return {
    mode: live ? 'live-gated' : 'dry-run',
    chainId,
    native: 'ETH',
    treasury: ARENA_WAR_POOL_TREASURY_V2,
    runtimeHash: ARENA_WAR_POOL_TREASURY_V2_RUNTIME_HASH,
    battleId,
    poolId,
    ownerA,
    ownerB,
    stakeAmount: stakeAmount.toString(),
    openBattlePool: {
      method: 'openBattlePool',
      args: [poolId, ownerA, ownerB, stakeAmount.toString(), depositDeadline.toString(), resolveDeadline.toString()],
    },
    depositStake: {
      method: 'depositStake',
      args: [poolId],
      value: stakeAmount.toString(),
    },
    liveRequested: live,
    sendRequired: live,
  };
}

export async function runBattleStake({
  env = process.env,
  plan,
  sendOpen,
  sendDepositA,
  sendDepositB,
} = {}) {
  const resolved = plan || planBattleStake({}, env);
  if (!resolved.sendRequired) {
    return { ...resolved, sent: false, opens: 0, deposits: 0 };
  }
  if (typeof sendOpen !== 'function' || typeof sendDepositA !== 'function' || typeof sendDepositB !== 'function') {
    throw new Error('SENDERS_REQUIRED');
  }
  const opened = await sendOpen(resolved);
  const depositA = await sendDepositA(resolved);
  const depositB = await sendDepositB(resolved);
  return {
    ...resolved,
    sent: true,
    opens: opened ? 1 : 0,
    deposits: Number(Boolean(depositA)) + Number(Boolean(depositB)),
    openTx: opened || null,
    depositATx: depositA || null,
    depositBTx: depositB || null,
  };
}

async function createRpcSenders(env = process.env) {
  const rpcUrl = String(env.ROBINHOOD_TESTNET_RPC_URL || env.RH46630_RPC_URL || DEFAULT_RPC_URL).trim();
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  assertBattleChainId(network.chainId);
  const code = await provider.getCode(ARENA_WAR_POOL_TREASURY_V2);
  if (!code || code === '0x') throw new Error('MISSING_RUNTIME_ARENA_WAR_POOL_TREASURY_V2');
  const hash = ethers.keccak256(code);
  if (hash.toLowerCase() !== ARENA_WAR_POOL_TREASURY_V2_RUNTIME_HASH.toLowerCase()) {
    throw new Error(`ARENA_WAR_POOL_TREASURY_V2_RUNTIME_HASH_MISMATCH_${hash}`);
  }
  const reader = new ethers.Contract(ARENA_WAR_POOL_TREASURY_V2, BATTLE_STAKE_ABI, provider);
  if ((await reader.GENERATION()) !== 2n) throw new Error('ARENA_GENERATION_MISMATCH');

  const walletA = new ethers.Wallet(env.T2_BATTLE_OWNER_A_PRIVATE_KEY, provider);
  const walletB = new ethers.Wallet(env.T2_BATTLE_OWNER_B_PRIVATE_KEY, provider);
  const contractA = reader.connect(walletA);
  const contractB = reader.connect(walletB);

  const sendOpen = async (plan) => {
    const pool = await reader.pools(plan.poolId);
    if (pool.ownerA !== ethers.ZeroAddress) return null;
    const args = plan.openBattlePool.args;
    const tx = await contractA.openBattlePool(args[0], args[1], args[2], BigInt(args[3]), BigInt(args[4]), BigInt(args[5]));
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error('OPEN_BATTLE_POOL_FAILED');
    return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
  };

  const sendDeposit = (walletContract, owner) => async (plan) => {
    const pool = await reader.pools(plan.poolId);
    if (Number(pool.kind) !== BATTLE_KIND) throw new Error('WRONG_POOL_KIND');
    const already = owner === 'A' ? pool.stakeA : pool.stakeB;
    if (already === BigInt(plan.stakeAmount)) return null;
    const tx = await walletContract.depositStake(plan.poolId, { value: BigInt(plan.stakeAmount) });
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error(`DEPOSIT_STAKE_${owner}_FAILED`);
    return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
  };

  return {
    rpcUrl,
    sendOpen,
    sendDepositA: sendDeposit(contractA, 'A'),
    sendDepositB: sendDeposit(contractB, 'B'),
  };
}

async function main() {
  const plan = planBattleStake({}, process.env);
  if (!plan.sendRequired) {
    console.log(JSON.stringify({ ...plan, sent: false }, null, 2));
    return;
  }
  const runtime = await createRpcSenders(process.env);
  const result = await runBattleStake({
    env: process.env,
    plan,
    sendOpen: runtime.sendOpen,
    sendDepositA: runtime.sendDepositA,
    sendDepositB: runtime.sendDepositB,
  });
  console.log(JSON.stringify({ rpcUrl: runtime.rpcUrl, ...result }, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`[t2-battle-stake-evm-real] ${error?.stack || error}`);
    process.exitCode = 1;
  });
}
