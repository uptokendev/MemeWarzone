import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ethers } from 'ethers';

export const RH46630_CHAIN_ID = 46630;
export const FORBIDDEN_PRODUCTION_CHAIN_ID = 4663;
export const OWNER = '0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714';
export const FEE_RECEIVER = '0xcDA6e2ca98c4BD6e831Ec04d4ED390535A6Da65C';

export function assertChainId(chainId) {
  const id = Number(chainId);
  if (id === FORBIDDEN_PRODUCTION_CHAIN_ID) throw new Error('PRODUCTION_4663_FORBIDDEN');
  if (id !== RH46630_CHAIN_ID) throw new Error(`WRONG_CHAIN_${id}`);
  return id;
}

export function liveRequested(env = process.env) {
  return String(env.RH46630_DEPLOY_UPVOTE_TREASURY || '').trim() === '1';
}

export function planUpvoteTreasuryDeploy(input = {}, env = process.env) {
  const chainId = assertChainId(input.chainId ?? env.T2_CHAIN_ID ?? RH46630_CHAIN_ID);
  const live = liveRequested(env);
  return {
    mode: live ? 'live-gated' : 'dry-run',
    chainId,
    contract: 'UPVoteTreasury',
    constructor: { initialOwner: OWNER, initialFeeReceiver: FEE_RECEIVER },
    note: 'Native asset is ETH on 46630; voteWithBNB forwards native to ProtocolRevenueVault. Do not deploy on 4663.',
    liveRequested: live,
    sendRequired: live,
  };
}

export async function runUpvoteTreasuryDeploy({ env = process.env, plan, sendDeploy } = {}) {
  const resolved = plan || planUpvoteTreasuryDeploy({}, env);
  if (!resolved.sendRequired) return { ...resolved, sent: false, address: null };
  if (typeof sendDeploy !== 'function') throw new Error('SENDER_REQUIRED');
  const deployed = await sendDeploy(resolved);
  return { ...resolved, sent: true, address: deployed?.address || null, txHash: deployed?.txHash || null };
}

async function main() {
  const plan = planUpvoteTreasuryDeploy({}, process.env);
  if (!plan.sendRequired) {
    console.log(JSON.stringify({ ...plan, sent: false }, null, 2));
    return;
  }
  throw new Error('LIVE_DEPLOY_NOT_ARMED_IN_THIS_SCRIPT');
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`[rh46630-upvote-treasury-deploy] ${error?.stack || error}`);
    process.exitCode = 1;
  });
}
