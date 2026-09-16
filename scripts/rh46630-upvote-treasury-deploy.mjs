import fs from 'node:fs';
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

function loadArtifact() {
  const artifactPath = path.resolve('artifacts/contracts/UPVoteTreasury.sol/UPVoteTreasury.json');
  if (!fs.existsSync(artifactPath)) throw new Error('MISSING_UPVOTE_TREASURY_ARTIFACT');
  return JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
}

async function main() {
  const plan = planUpvoteTreasuryDeploy({}, process.env);
  if (!plan.sendRequired) {
    console.log(JSON.stringify({ ...plan, sent: false }, null, 2));
    return;
  }
  const rpcUrl = String(process.env.ROBINHOOD_TESTNET_RPC_URL || 'https://robinhood-sepolia-rpc.publicnode.com').trim();
  const key = String(process.env.RH46630_UPVOTE_OWNER_PRIVATE_KEY || process.env.ROBINHOOD_TESTNET_DEPLOYER_PRIVATE_KEY || '').trim();
  if (!key) throw new Error('MISSING_DEPLOYER_KEY');
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  assertChainId((await provider.getNetwork()).chainId);
  const wallet = new ethers.Wallet(key.startsWith('0x') ? key : `0x${key}`, provider);
  if (wallet.address.toLowerCase() !== OWNER.toLowerCase()) {
    throw new Error(`DEPLOYER_SIGNER_REQUIRED_${wallet.address}`);
  }
  const artifact = loadArtifact();
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const contract = await factory.deploy(OWNER, FEE_RECEIVER);
  const receipt = await contract.deploymentTransaction().wait();
  if (!receipt || receipt.status !== 1) throw new Error('DEPLOY_FAILED');
  const address = await contract.getAddress();
  const deployed = new ethers.Contract(address, [
    'function owner() view returns (address)',
    'function feeReceiver() view returns (address)',
  ], provider);
  const owner = await deployed.owner();
  const feeReceiver = await deployed.feeReceiver();
  if (owner.toLowerCase() !== OWNER.toLowerCase()) throw new Error(`OWNER_MISMATCH_${owner}`);
  if (feeReceiver.toLowerCase() !== FEE_RECEIVER.toLowerCase()) throw new Error(`FEE_RECEIVER_MISMATCH_${feeReceiver}`);
  console.log(JSON.stringify({
    ...plan,
    sent: true,
    address,
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    owner,
    feeReceiver,
  }, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`[rh46630-upvote-treasury-deploy] ${error?.stack || error}`);
    process.exitCode = 1;
  });
}
