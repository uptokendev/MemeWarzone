import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ethers } from 'ethers';

export const RH46630_CHAIN_ID = 46630;
export const FORBIDDEN_PRODUCTION_CHAIN_ID = 4663;
export const DEFAULT_RPC_URL = 'https://robinhood-sepolia-rpc.publicnode.com';

export const IDENTITIES = {
  weth: {
    address: '0x52A47A33930B8a90a2000b1bA3CB96e879569670',
    runtimeHash: '0x1e0202650085e0e5e843d6b4f41bfc5c6d4850589835ac95340341bc9a5a0398',
  },
  swapRouter: {
    address: '0xDfd381ECfA6D4CcD4248e319C6fecD76A6bf3296',
    runtimeHash: '0x692da8cfb61328473e4ef9276479f3c93f70fcf85d81cbf79005f10e0b14a94d',
  },
  positionManager: {
    address: '0xfF64Bd6970966dB58F0dd65BA76669D3b8BE9eC4',
    runtimeHash: '0xf3eb48c9738e0d58bc5f4abaa865c36d4dd78fdfce0370efcf8d201a37666a12',
  },
  v3Factory: {
    address: '0x948463E91d63a7A51cEeC0342735D1B738044aea',
    runtimeHash: '0x448e41846346428bbb4897541d27fee0a95096dc293919980b6191cf9a7a8168',
  },
  locker: {
    address: '0x1977178fDeAcE51318cA22B57dfdD246461b9f24',
    runtimeHash: '0x26a988d6510cb54c1e332dd631e6b3c1aad0c7ee931817a8beaa62565371fc29',
  },
  upvoteTreasury: {
    address: '0x670256a51020477e4E96d7D7a94ac1783F1B1789',
    runtimeHash: '0xf2d73cf3f0a3946d2b9b7b7a118ccbe5f097d33a54bbb4bbf34159faf32371ab',
  },
};

export function assertChainId(chainId) {
  const id = Number(chainId);
  if (id === FORBIDDEN_PRODUCTION_CHAIN_ID) throw new Error('PRODUCTION_4663_FORBIDDEN');
  if (id !== RH46630_CHAIN_ID) throw new Error(`WRONG_CHAIN_${id}`);
  return id;
}

export function classifyCode(code, expectedHash) {
  const empty = !code || code === '0x' || code === '0x0';
  if (empty) return { hasCode: false, runtimeHash: null, match: false, verdict: 'MISSING' };
  const runtimeHash = ethers.keccak256(code);
  const match = runtimeHash.toLowerCase() === String(expectedHash).toLowerCase();
  return { hasCode: true, runtimeHash, match, verdict: match ? 'PRESENT' : 'HASH_MISMATCH' };
}

export function summarizeInventory(results) {
  const values = Object.values(results);
  const allPresent = values.every((row) => row.verdict === 'PRESENT');
  return {
    chainId: RH46630_CHAIN_ID,
    upvoteTreasury: results.upvoteTreasury || { address: null, hasCode: false, verdict: 'MISSING' },
    identities: results,
    verdict: allPresent ? 'V3_AND_UPVOTE_TREASURY_PRESENT' : 'INCOMPLETE',
  };
}

export async function readInventory({ getCode, chainId = RH46630_CHAIN_ID } = {}) {
  assertChainId(chainId);
  if (typeof getCode !== 'function') throw new Error('GET_CODE_REQUIRED');
  const results = {};
  for (const [name, ident] of Object.entries(IDENTITIES)) {
    const code = await getCode(ident.address);
    results[name] = { address: ident.address, expectedHash: ident.runtimeHash, ...classifyCode(code, ident.runtimeHash) };
  }
  return summarizeInventory(results);
}

async function main() {
  const rpcUrl = String(process.env.ROBINHOOD_TESTNET_RPC_URL || DEFAULT_RPC_URL).trim();
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  assertChainId((await provider.getNetwork()).chainId);
  const report = await readInventory({
    getCode: (address) => provider.getCode(address),
  });
  console.log(JSON.stringify(report, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`[rh46630-v3-identity-inventory] ${error?.stack || error}`);
    process.exitCode = 1;
  });
}
