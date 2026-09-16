import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const RH46630_CHAIN_ID = 46630;
export const FORBIDDEN_PRODUCTION_CHAIN_ID = 4663;
export const DEFAULT_RPC_URL = 'https://robinhood-sepolia-rpc.publicnode.com';

export const GREEN_FACTORY = '0xd03D1CC03d108B7F9b2195489DC6CFda1FB1a943';
export const CURRENT_STAGE_TREASURY_ROUTER = '0x144170c53ADBc5cF7Ec454612C948B931e231C9e';
export const CURRENT_STAGE_PROTOCOL_REVENUE_VAULT = '0xcDA6e2ca98c4BD6e831Ec04d4ED390535A6Da65C';
export const ARENA_WAR_POOL_TREASURY_V2 = '0x1eDd34933E5395c82F14CE2A220b81adF35C52B7';
export const POSTGRAD_LEAGUE_TREASURY_V2 = '0x794Cbd0912A71394f25B81C32f3994cC737A4B13';
export const WAR_POOL_OWNER = '0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714';

export const GREEN_FACTORY_RUNTIME_HASH = '0xeef9fc549717aa70bb357d0aa22ee96ef86f00b2d9b6bd4a54a1cd1b6bf0776f';
export const CURRENT_STAGE_TREASURY_ROUTER_RUNTIME_HASH = '0x753c301638e1aa741261e4afedd4836954183ae3b116e66e87f528e2aa1704f4';
export const CURRENT_STAGE_PROTOCOL_REVENUE_VAULT_RUNTIME_HASH = '0x94f992f07f7c26bb7152939e39321a5bd475f137fdbe24f92bf02f7a854f507a';
export const ARENA_WAR_POOL_TREASURY_V2_RUNTIME_HASH = '0x79979c3684c328e866c2b5b03d276cda7072a4c39d7f5b55c42672f9cb82958d';

export const CURRENT_STAGE_SOURCE_SHA = '7464993ba9066109eccfc7c7d3a14927a5544ecd';
export const CURRENT_STAGE_DEPLOYMENT_RUN = '35100925163';
export const DEFAULT_REPORT_PATH = 'reports/rh46630-arena-v2-receivers.json';

function cleanAddress(value) {
  const s = String(value || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) throw new Error(`INVALID_ADDRESS_${s || 'EMPTY'}`);
  return s;
}

export function sameAddress(a, b) {
  return cleanAddress(a).toLowerCase() === cleanAddress(b).toLowerCase();
}

export function assertSupportedChainId(chainId) {
  const id = Number(chainId);
  if (id === FORBIDDEN_PRODUCTION_CHAIN_ID) throw new Error('PRODUCTION_4663_FORBIDDEN');
  if (id !== RH46630_CHAIN_ID) throw new Error(`WRONG_CHAIN_${id}`);
  return id;
}

export function liveRequested(env = process.env) {
  return String(env.RH46630_ARENA_SET_RECEIVERS || '').trim() === '1';
}

function assertExpectedState(state) {
  assertSupportedChainId(state.chainId);
  if (!sameAddress(state.factory, GREEN_FACTORY)) throw new Error('GREEN_FACTORY_MISMATCH');
  if (!sameAddress(state.treasuryRouter, CURRENT_STAGE_TREASURY_ROUTER)) throw new Error('TREASURY_ROUTER_MISMATCH');
  if (!sameAddress(state.discoveredProtocolVault, CURRENT_STAGE_PROTOCOL_REVENUE_VAULT)) {
    throw new Error('PROTOCOL_REVENUE_VAULT_MISMATCH');
  }
  if (!sameAddress(state.warPool, ARENA_WAR_POOL_TREASURY_V2)) throw new Error('WAR_POOL_V2_MISMATCH');
  if (!sameAddress(state.warPoolOwner, WAR_POOL_OWNER)) throw new Error('WAR_POOL_OWNER_MISMATCH');
}

export function receiverSummary(state, env = process.env) {
  assertExpectedState(state);
  const protocolMatches = sameAddress(state.currentProtocolReceiver, state.discoveredProtocolVault);
  const leagueMatches = sameAddress(state.currentPostGradLeagueTreasury, POSTGRAD_LEAGUE_TREASURY_V2);
  const live = liveRequested(env);
  return {
    mode: live ? 'live-gated' : 'dry-run',
    chainId: Number(state.chainId),
    factory: state.factory,
    treasuryRouter: state.treasuryRouter,
    warPool: state.warPool,
    warPoolOwner: state.warPoolOwner,
    current: {
      protocolReceiver: state.currentProtocolReceiver,
      postGradLeagueTreasury: state.currentPostGradLeagueTreasury,
    },
    proposed: {
      protocolReceiver: state.discoveredProtocolVault,
      postGradLeagueTreasury: POSTGRAD_LEAGUE_TREASURY_V2,
    },
    matches: {
      protocolReceiver: protocolMatches,
      postGradLeagueTreasury: leagueMatches,
      all: protocolMatches && leagueMatches,
    },
    liveRequested: live,
    sendRequired: live && !(protocolMatches && leagueMatches),
  };
}

export async function runReceiverUpdate({
  env = process.env,
  readState,
  loadSigner,
  sendSetReceivers,
  writeReport,
  sourceSha = process.env.GITHUB_SHA || 'local',
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof readState !== 'function') throw new Error('READ_STATE_REQUIRED');
  const before = await readState();
  const summary = receiverSummary(before, env);

  if (!summary.liveRequested || !summary.sendRequired) {
    return { ...summary, sent: false, reportWritten: false };
  }

  if (typeof loadSigner !== 'function') throw new Error('LOAD_SIGNER_REQUIRED');
  if (typeof sendSetReceivers !== 'function') throw new Error('SEND_SET_RECEIVERS_REQUIRED');

  const signer = await loadSigner();
  if (!signer?.address || !sameAddress(signer.address, WAR_POOL_OWNER) || !sameAddress(signer.address, before.warPoolOwner)) {
    throw new Error(`WAR_POOL_OWNER_SIGNER_REQUIRED_${signer?.address || 'UNKNOWN'}`);
  }

  const sent = await sendSetReceivers({
    signer,
    protocolReceiver: before.discoveredProtocolVault,
    postGradLeagueTreasury: POSTGRAD_LEAGUE_TREASURY_V2,
  });

  const after = await readState();
  assertExpectedState(after);
  if (!sameAddress(after.currentProtocolReceiver, before.discoveredProtocolVault)) {
    throw new Error('POST_SEND_PROTOCOL_RECEIVER_MISMATCH');
  }
  if (!sameAddress(after.currentPostGradLeagueTreasury, POSTGRAD_LEAGUE_TREASURY_V2)) {
    throw new Error('POST_SEND_LEAGUE_TREASURY_MISMATCH');
  }

  const report = {
    generatedAt: now(),
    sourceSha,
    chainId: RH46630_CHAIN_ID,
    factory: GREEN_FACTORY,
    treasuryRouter: before.treasuryRouter,
    protocolRevenueVault: before.discoveredProtocolVault,
    warPool: ARENA_WAR_POOL_TREASURY_V2,
    warPoolOwner: before.warPoolOwner,
    before: {
      protocolReceiver: before.currentProtocolReceiver,
      postGradLeagueTreasury: before.currentPostGradLeagueTreasury,
    },
    transaction: sent,
    after: {
      protocolReceiver: after.currentProtocolReceiver,
      postGradLeagueTreasury: after.currentPostGradLeagueTreasury,
    },
    attestations: {
      currentStageSourceSha: CURRENT_STAGE_SOURCE_SHA,
      currentStageDeploymentRun: CURRENT_STAGE_DEPLOYMENT_RUN,
      factoryRuntimeHash: after.factoryRuntimeHash,
      treasuryRouterRuntimeHash: after.treasuryRouterRuntimeHash,
      protocolRevenueVaultRuntimeHash: after.protocolRevenueVaultRuntimeHash,
      arenaWarPoolTreasuryV2RuntimeHash: after.warPoolRuntimeHash,
    },
  };

  if (typeof writeReport === 'function') await writeReport(report);
  return { ...receiverSummary(after, env), sent: true, transaction: sent, reportWritten: typeof writeReport === 'function' };
}

async function createRpcRuntime(env = process.env) {
  const { ethers } = await import('ethers');
  const rpcUrl = String(env.ROBINHOOD_TESTNET_RPC_URL || env.RH46630_RPC_URL || DEFAULT_RPC_URL).trim();
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  assertSupportedChainId(network.chainId);

  const factoryAbi = [
    'function owner() view returns(address)',
    'function leagueReceiver() view returns(address)',
  ];
  const treasuryAbi = ['function protocolRevenueVault() view returns(address)'];
  const warPoolAbi = [
    'function owner() view returns(address)',
    'function protocolReceiver() view returns(address)',
    'function postGradLeagueTreasury() view returns(address)',
    'function setReceivers(address protocolReceiver_, address postGradLeagueTreasury_)',
  ];

  const codeHash = async (address, label) => {
    const code = await provider.getCode(address);
    if (!code || code === '0x') throw new Error(`MISSING_RUNTIME_${label}`);
    return ethers.keccak256(code);
  };
  const requireHash = (actual, expected, label) => {
    if (String(actual).toLowerCase() !== String(expected).toLowerCase()) throw new Error(`${label}_RUNTIME_HASH_MISMATCH_${actual}`);
  };

  const readState = async () => {
    const currentNetwork = await provider.getNetwork();
    const chainId = assertSupportedChainId(currentNetwork.chainId);
    const factory = new ethers.Contract(GREEN_FACTORY, factoryAbi, provider);
    const treasuryRouter = await factory.leagueReceiver();
    const treasury = new ethers.Contract(treasuryRouter, treasuryAbi, provider);
    const discoveredProtocolVault = await treasury.protocolRevenueVault();
    const warPool = new ethers.Contract(ARENA_WAR_POOL_TREASURY_V2, warPoolAbi, provider);

    const [
      factoryRuntimeHash,
      treasuryRouterRuntimeHash,
      protocolRevenueVaultRuntimeHash,
      warPoolRuntimeHash,
      factoryOwner,
      warPoolOwner,
      currentProtocolReceiver,
      currentPostGradLeagueTreasury,
    ] = await Promise.all([
      codeHash(GREEN_FACTORY, 'GREEN_FACTORY'),
      codeHash(treasuryRouter, 'TREASURY_ROUTER'),
      codeHash(discoveredProtocolVault, 'PROTOCOL_REVENUE_VAULT'),
      codeHash(ARENA_WAR_POOL_TREASURY_V2, 'ARENA_WAR_POOL_TREASURY_V2'),
      factory.owner(),
      warPool.owner(),
      warPool.protocolReceiver(),
      warPool.postGradLeagueTreasury(),
    ]);

    requireHash(factoryRuntimeHash, GREEN_FACTORY_RUNTIME_HASH, 'GREEN_FACTORY');
    requireHash(treasuryRouterRuntimeHash, CURRENT_STAGE_TREASURY_ROUTER_RUNTIME_HASH, 'TREASURY_ROUTER');
    requireHash(protocolRevenueVaultRuntimeHash, CURRENT_STAGE_PROTOCOL_REVENUE_VAULT_RUNTIME_HASH, 'PROTOCOL_REVENUE_VAULT');
    requireHash(warPoolRuntimeHash, ARENA_WAR_POOL_TREASURY_V2_RUNTIME_HASH, 'ARENA_WAR_POOL_TREASURY_V2');

    return {
      rpcUrl,
      chainId,
      factory: GREEN_FACTORY,
      factoryOwner,
      factoryRuntimeHash,
      treasuryRouter,
      treasuryRouterRuntimeHash,
      discoveredProtocolVault,
      protocolRevenueVaultRuntimeHash,
      warPool: ARENA_WAR_POOL_TREASURY_V2,
      warPoolOwner,
      warPoolRuntimeHash,
      currentProtocolReceiver,
      currentPostGradLeagueTreasury,
    };
  };

  const loadSigner = async () => {
    const privateKey = String(
      env.RH46630_ARENA_WAR_POOL_OWNER_PRIVATE_KEY || env.ROBINHOOD_TESTNET_DEPLOYER_PRIVATE_KEY || '',
    ).trim();
    if (!privateKey) throw new Error('MISSING_RH46630_ARENA_WAR_POOL_OWNER_PRIVATE_KEY');
    const signer = new ethers.Wallet(privateKey, provider);
    return { address: signer.address, signer };
  };

  const sendSetReceivers = async ({ signer, protocolReceiver, postGradLeagueTreasury }) => {
    const warPool = new ethers.Contract(ARENA_WAR_POOL_TREASURY_V2, warPoolAbi, signer.signer);
    await warPool.setReceivers.estimateGas(protocolReceiver, postGradLeagueTreasury);
    const tx = await warPool.setReceivers(protocolReceiver, postGradLeagueTreasury);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error('SET_RECEIVERS_TRANSACTION_FAILED');
    return {
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed?.toString?.() || String(receipt.gasUsed || ''),
    };
  };

  const reportPath = String(env.RH46630_ARENA_RECEIVERS_REPORT || DEFAULT_REPORT_PATH).trim();
  const writeReport = async (report) => {
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  };

  return { rpcUrl, readState, loadSigner, sendSetReceivers, writeReport, reportPath };
}

async function main() {
  const runtime = await createRpcRuntime(process.env);
  const result = await runReceiverUpdate({
    env: process.env,
    readState: runtime.readState,
    loadSigner: runtime.loadSigner,
    sendSetReceivers: runtime.sendSetReceivers,
    writeReport: runtime.writeReport,
  });
  console.log(JSON.stringify({
    rpcUrl: runtime.rpcUrl,
    reportPath: result.sent ? runtime.reportPath : null,
    ...result,
  }, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`[rh46630-arena-v2-set-receivers] ${error?.stack || error}`);
    process.exitCode = 1;
  });
}
