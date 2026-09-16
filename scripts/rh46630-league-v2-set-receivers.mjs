import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ethers } from 'ethers';

export const RH46630_CHAIN_ID = 46630;
export const FORBIDDEN_PRODUCTION_CHAIN_ID = 4663;
export const DEFAULT_RPC_URL = 'https://robinhood-sepolia-rpc.publicnode.com';
export const POSTGRAD_LEAGUE_TREASURY_V2 = '0x794Cbd0912A71394f25B81C32f3994cC737A4B13';
export const WEEKLY_LEAGUE_VAULT = '0x290fD8eCA353637Be4a0cbC335095e5E6F5F16e2';
export const LEAGUE_OWNER = '0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714';
export const DEPLOYER_PLACEHOLDER = '0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714';

const ABI = [
  'function owner() view returns (address)',
  'function monthlyReceiver() view returns (address)',
  'function quarterlyReceiver() view returns (address)',
  'function setReceivers(address monthlyReceiver_, address quarterlyReceiver_)',
];

export function assertChainId(chainId) {
  const id = Number(chainId);
  if (id === FORBIDDEN_PRODUCTION_CHAIN_ID) throw new Error('PRODUCTION_4663_FORBIDDEN');
  if (id !== RH46630_CHAIN_ID) throw new Error(`WRONG_CHAIN_${id}`);
  return id;
}

export function liveRequested(env = process.env) {
  return String(env.RH46630_LEAGUE_SET_RECEIVERS || '').trim() === '1';
}

export function planLeagueReceivers(state, env = process.env) {
  assertChainId(state.chainId);
  const live = liveRequested(env);
  const monthlyMatches = String(state.monthlyReceiver).toLowerCase() === WEEKLY_LEAGUE_VAULT.toLowerCase();
  const quarterlyMatches = String(state.quarterlyReceiver).toLowerCase() === WEEKLY_LEAGUE_VAULT.toLowerCase();
  return {
    mode: live ? 'live-gated' : 'dry-run',
    chainId: RH46630_CHAIN_ID,
    league: POSTGRAD_LEAGUE_TREASURY_V2,
    owner: LEAGUE_OWNER,
    current: {
      monthlyReceiver: state.monthlyReceiver,
      quarterlyReceiver: state.quarterlyReceiver,
    },
    proposed: {
      monthlyReceiver: WEEKLY_LEAGUE_VAULT,
      quarterlyReceiver: WEEKLY_LEAGUE_VAULT,
      note: 'Quarterly destination is the same GREEN weekly TreasuryVaultV2 until founder names a distinct quarterly vault. 60/40 split is unchanged.',
    },
    matches: { monthly: monthlyMatches, quarterly: quarterlyMatches, all: monthlyMatches && quarterlyMatches },
    liveRequested: live,
    sendRequired: live && !(monthlyMatches && quarterlyMatches),
  };
}

export async function runLeagueReceivers({ env = process.env, plan, sendSetReceivers } = {}) {
  const resolved = plan || planLeagueReceivers({
    chainId: RH46630_CHAIN_ID,
    monthlyReceiver: DEPLOYER_PLACEHOLDER,
    quarterlyReceiver: DEPLOYER_PLACEHOLDER,
  }, env);
  if (!resolved.sendRequired) return { ...resolved, sent: false };
  if (typeof sendSetReceivers !== 'function') throw new Error('SENDER_REQUIRED');
  const tx = await sendSetReceivers(resolved);
  return { ...resolved, sent: true, tx: tx || null };
}

async function main() {
  const rpcUrl = String(process.env.ROBINHOOD_TESTNET_RPC_URL || DEFAULT_RPC_URL).trim();
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  assertChainId((await provider.getNetwork()).chainId);
  const league = new ethers.Contract(POSTGRAD_LEAGUE_TREASURY_V2, ABI, provider);
  const owner = await league.owner();
  if (owner.toLowerCase() !== LEAGUE_OWNER.toLowerCase()) throw new Error(`LEAGUE_OWNER_MISMATCH_${owner}`);
  const plan = planLeagueReceivers({
    chainId: RH46630_CHAIN_ID,
    monthlyReceiver: await league.monthlyReceiver(),
    quarterlyReceiver: await league.quarterlyReceiver(),
  });
  if (!plan.sendRequired) {
    console.log(JSON.stringify({ ...plan, sent: false }, null, 2));
    return;
  }
  const key = String(process.env.RH46630_LEAGUE_OWNER_PRIVATE_KEY || process.env.ROBINHOOD_TESTNET_DEPLOYER_PRIVATE_KEY || '').trim();
  if (!key) throw new Error('MISSING_LEAGUE_OWNER_KEY');
  const wallet = new ethers.Wallet(key.startsWith('0x') ? key : `0x${key}`, provider);
  if (wallet.address.toLowerCase() !== LEAGUE_OWNER.toLowerCase()) {
    throw new Error(`LEAGUE_SIGNER_REQUIRED_${wallet.address}`);
  }
  const tx = await league.connect(wallet).setReceivers(WEEKLY_LEAGUE_VAULT, WEEKLY_LEAGUE_VAULT);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error('SET_RECEIVERS_FAILED');
  const after = {
    monthlyReceiver: await league.monthlyReceiver(),
    quarterlyReceiver: await league.quarterlyReceiver(),
  };
  console.log(JSON.stringify({
    ...plan,
    sent: true,
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    after,
  }, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`[rh46630-league-v2-set-receivers] ${error?.stack || error}`);
    process.exitCode = 1;
  });
}
