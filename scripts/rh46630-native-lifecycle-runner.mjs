import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const scriptsDir = path.dirname(new URL(import.meta.url).pathname);
const sourcePath = path.join(scriptsDir, 'rh46630-native-lifecycle-certification.mjs');
const patchedPath = path.join(scriptsDir, '.rh46630-native-lifecycle-certification.runtime.mjs');

let source = fs.readFileSync(sourcePath, 'utf8');
const unnamedOracleAbi = "const oracleAbi = ['function decimals() view returns(uint8)','function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)','function updater() view returns(address)'];";
const namedOracleAbi = "const oracleAbi = ['function decimals() view returns(uint8)','function latestRoundData() view returns(uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)','function updater() view returns(address)'];";
if (!source.includes(unnamedOracleAbi)) throw new Error('EXPECTED_ORACLE_ABI_NOT_FOUND');
source = source.replace(unnamedOracleAbi, namedOracleAbi);
source = source.replace("const SOURCE_SHA = process.env.GITHUB_SHA || 'local';", "const SOURCE_SHA = process.env.RH46630_CERT_HEAD_SHA || process.env.GITHUB_SHA || 'local';");
fs.writeFileSync(patchedPath, source);
try {
  await import(pathToFileURL(patchedPath).href + `?mode=${Date.now()}`);
} finally {
  try { fs.unlinkSync(patchedPath); } catch {}
}
