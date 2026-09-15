import { ethers } from 'ethers';

export const EXPECTED_CHAIN_ID = 46630;
export const FORBIDDEN_CHAIN_ID = 4663;
export const EXPECTED_ORACLE = '0x5D2A88b0963Bb5b561B495a5fDCba869C01a8cAb';
export const EXPECTED_UPDATER = '0xE755A2c52654b2133c7A4fdC5349821C6527A766';
export const MAX_ORACLE_AGE_SECONDS = 900n;

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

export function parseHonestPrice(raw) {
  const value = String(raw ?? '').trim();
  if (!/^\d+$/.test(value)) throw new Error('ORACLE_PRICE_MUST_BE_POSITIVE_INTEGER');
  const answer = BigInt(value);
  if (answer <= 0n) throw new Error('ORACLE_PRICE_MUST_BE_POSITIVE');
  return answer;
}

export function assessFreshness({ latestTimestamp, updatedAt }) {
  const latest = BigInt(latestTimestamp);
  const updated = BigInt(updatedAt);
  const age = latest - updated;
  if (age < 0n) throw new Error(`ORACLE_UPDATED_AT_IN_FUTURE_${age}`);
  return { age, needsRefresh: age >= MAX_ORACLE_AGE_SECONDS };
}

export function assertUpdaterIdentity({ signerAddress, onchainUpdater, expectedUpdater = EXPECTED_UPDATER }) {
  if (!same(signerAddress, expectedUpdater)) throw new Error(`ORACLE_UPDATER_SIGNER_MISMATCH_${signerAddress}`);
  if (!same(onchainUpdater, expectedUpdater)) throw new Error(`ORACLE_UPDATER_RUNTIME_MISMATCH_${onchainUpdater}`);
}

export function validateRefreshedSnapshot({
  beforeUpdatedAt,
  afterUpdatedAt,
  afterAnswer,
  decimals,
  latestTimestamp,
  receiptStatus,
}) {
  if (Number(receiptStatus) !== 1) throw new Error('ORACLE_REFRESH_TX_FAILED');
  if (Number(decimals) !== 8) throw new Error(`ORACLE_DECIMALS_MISMATCH_${decimals}`);
  const answer = BigInt(afterAnswer);
  if (answer <= 0n) throw new Error('ORACLE_REFRESH_ANSWER_NOT_POSITIVE');
  const before = BigInt(beforeUpdatedAt);
  const after = BigInt(afterUpdatedAt);
  if (after <= before) throw new Error(`ORACLE_UPDATED_AT_NOT_ADVANCED_${before}_${after}`);
  const freshness = assessFreshness({ latestTimestamp, updatedAt: after });
  if (freshness.age >= MAX_ORACLE_AGE_SECONDS) throw new Error(`ORACLE_REFRESH_STILL_STALE_${freshness.age}`);
  return freshness;
}

export async function ensureRh46630OracleFreshness({
  provider,
  oracleAddress = EXPECTED_ORACLE,
  expectedUpdater = EXPECTED_UPDATER,
  updaterPrivateKey = process.env.ROBINHOOD_TESTNET_ORACLE_UPDATER_PRIVATE_KEY,
  honestPrice = process.env.ROBINHOOD_ETH_USD_8,
} = {}) {
  if (!provider) throw new Error('ORACLE_PROVIDER_REQUIRED');

  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  if (chainId === FORBIDDEN_CHAIN_ID) throw new Error('PRODUCTION_4663_FORBIDDEN');
  if (chainId !== EXPECTED_CHAIN_ID) throw new Error(`WRONG_CHAIN_${chainId}`);
  if (!same(oracleAddress, EXPECTED_ORACLE)) throw new Error(`WRONG_ORACLE_${oracleAddress}`);

  const readOracle = new ethers.Contract(
    oracleAddress,
    [
      'function updater() view returns(address)',
      'function decimals() view returns(uint8)',
      'function latestRoundData() view returns(uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)',
      'function updateAnswer(int256) returns(uint80)',
    ],
    provider,
  );

  const runtimeUpdater = ethers.getAddress(await readOracle.updater());
  if (!same(runtimeUpdater, expectedUpdater)) throw new Error(`ORACLE_UPDATER_RUNTIME_MISMATCH_${runtimeUpdater}`);
  const decimals = Number(await readOracle.decimals());
  if (decimals !== 8) throw new Error(`ORACLE_DECIMALS_MISMATCH_${decimals}`);

  const before = await readOracle.latestRoundData();
  const beforeAnswer = BigInt(before.answer ?? before[1]);
  const beforeUpdatedAt = BigInt(before.updatedAt ?? before[3]);
  if (beforeAnswer <= 0n) throw new Error('ORACLE_CURRENT_ANSWER_NOT_POSITIVE');
  const latestBefore = await provider.getBlock('latest');
  if (!latestBefore) throw new Error('ORACLE_LATEST_BLOCK_MISSING');
  const initial = assessFreshness({ latestTimestamp: latestBefore.timestamp, updatedAt: beforeUpdatedAt });

  if (!initial.needsRefresh) {
    return {
      chainId,
      oracle: ethers.getAddress(oracleAddress),
      updater: runtimeUpdater,
      refreshed: false,
      refreshTxHash: null,
      answer: beforeAnswer.toString(),
      updatedAt: beforeUpdatedAt.toString(),
      age: initial.age.toString(),
    };
  }

  const answer = parseHonestPrice(honestPrice);
  const pk = String(updaterPrivateKey ?? '').trim();
  if (!pk) throw new Error('MISSING_PROTECTED_INPUT_ROBINHOOD_TESTNET_ORACLE_UPDATER_PRIVATE_KEY');
  const signer = new ethers.Wallet(pk.startsWith('0x') ? pk : `0x${pk}`, provider);
  assertUpdaterIdentity({ signerAddress: signer.address, onchainUpdater: runtimeUpdater, expectedUpdater });

  const writeOracle = readOracle.connect(signer);
  const tx = await writeOracle.updateAnswer(answer);
  const receipt = await tx.wait();
  if (!receipt) throw new Error('ORACLE_REFRESH_RECEIPT_MISSING');

  const after = await readOracle.latestRoundData();
  const afterAnswer = BigInt(after.answer ?? after[1]);
  const afterUpdatedAt = BigInt(after.updatedAt ?? after[3]);
  if (afterAnswer !== answer) throw new Error(`ORACLE_REFRESH_ANSWER_MISMATCH_${afterAnswer}_${answer}`);
  const updaterAfter = ethers.getAddress(await readOracle.updater());
  assertUpdaterIdentity({ signerAddress: signer.address, onchainUpdater: updaterAfter, expectedUpdater });
  const decimalsAfter = Number(await readOracle.decimals());
  const latestAfter = await provider.getBlock('latest');
  if (!latestAfter) throw new Error('ORACLE_LATEST_BLOCK_MISSING_AFTER_REFRESH');
  const freshness = validateRefreshedSnapshot({
    beforeUpdatedAt,
    afterUpdatedAt,
    afterAnswer,
    decimals: decimalsAfter,
    latestTimestamp: latestAfter.timestamp,
    receiptStatus: receipt.status,
  });

  return {
    chainId,
    oracle: ethers.getAddress(oracleAddress),
    updater: updaterAfter,
    refreshed: true,
    refreshTxHash: receipt.hash,
    refreshBlockNumber: receipt.blockNumber,
    answer: afterAnswer.toString(),
    previousUpdatedAt: beforeUpdatedAt.toString(),
    updatedAt: afterUpdatedAt.toString(),
    age: freshness.age.toString(),
  };
}
