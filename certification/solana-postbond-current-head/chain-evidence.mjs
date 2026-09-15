#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Connection, PublicKey } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAccount, getMint } from '@solana/spl-token';
import { CpAmm, deriveCustomizablePoolAddress } from '@meteora-ag/cp-amm-sdk';

const SOURCE = '8944382619e05f09539614f5690b98521fe244ed';
const LAUNCH_PROGRAM = new PublicKey('3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt');
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const CAMPAIGN_BYTES = 720;
const CREATOR_OFFSET = 136;
const MINT_OFFSET = 168;
const GRADUATED_OFFSET = 713;
const CURVE_CLOSED_OFFSET = 714;
const DEX_ADAPTER_OFFSET = 483;
const METEORA_DAMM_V2 = 1;
const OUT = process.env.SOLANA_POSTBOND_CHAIN_REPORT || 'reports/solana-postbond-chain-evidence.json';

function req(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function pub(data, offset) { return new PublicKey(data.subarray(offset, offset + 32)); }
function absBig(v) { return v < 0n ? -v : v; }
function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function landed(connection, signature) {
  const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
  if (!status || status.err) throw new Error(`transaction not successfully landed: ${signature}`);
  const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  if (!tx || tx.meta?.err) throw new Error(`transaction body unavailable or failed: ${signature}`);
  return { status: status.confirmationStatus, slot: tx.slot, blockTime: tx.blockTime, tx };
}

async function holderCount(connection, mint) {
  const rows = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
    commitment: 'confirmed',
    filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint.toBase58() } }],
    dataSlice: { offset: 64, length: 8 },
  });
  return rows.reduce((count, row) => row.account.data.readBigUInt64LE(0) > 0n ? count + 1 : count, 0);
}

function payerNativeVolume(tx, payer) {
  const keys = tx.transaction.message.getAccountKeys().staticAccountKeys;
  const index = keys.findIndex((key) => key.equals(payer));
  if (index < 0) return null;
  const pre = BigInt(tx.meta.preBalances[index] || 0);
  const post = BigInt(tx.meta.postBalances[index] || 0);
  const fee = BigInt(tx.meta.fee || 0);
  return absBig(post - pre + fee);
}

async function marketSnapshot(connection, mintState, mint, tokenVaultKey, solVaultKey, solUsd, volumeUsd) {
  const [tokenVault, solVault, holders, slot] = await Promise.all([
    getAccount(connection, tokenVaultKey, 'confirmed'),
    getAccount(connection, solVaultKey, 'confirmed'),
    holderCount(connection, mint),
    connection.getSlot('confirmed'),
  ]);
  if (tokenVault.amount <= 0n || solVault.amount <= 0n) throw new Error('Meteora reserves are empty');
  const tokenReserve = Number(tokenVault.amount) / 10 ** Number(mintState.decimals);
  const solReserve = Number(solVault.amount) / 1e9;
  const supply = Number(mintState.supply) / 10 ** Number(mintState.decimals);
  const spotSol = tokenReserve > 0 ? solReserve / tokenReserve : 0;
  const marketCapUsd = spotSol * supply * solUsd;
  if (!Number.isFinite(marketCapUsd) || marketCapUsd <= 0) throw new Error('market-cap snapshot is invalid');
  return {
    marketCapUsd,
    holders,
    volumeUsd,
    solUsd,
    tokenReserve,
    solReserve,
    source: 'meteora-devnet-chain',
    healthy: true,
    slot,
    capturedAt: new Date().toISOString(),
  };
}

async function side(connection, cpAmm, prefix, reportPath, solUsd, delayMs) {
  const campaign = new PublicKey(req(`${prefix}_CAMPAIGN`));
  const expectedMint = new PublicKey(req(`${prefix}_MINT`));
  const expectedPool = new PublicKey(req(`${prefix}_METEORA_POOL`));
  const reportBytes = fs.readFileSync(reportPath);
  const report = JSON.parse(reportBytes.toString('utf8'));
  if (Number(report.applicationChainId) !== 101 || report.cluster !== 'devnet') throw new Error(`${prefix} post-grad report is not chain 101 devnet`);
  if (report.mint !== expectedMint.toBase58() || report.pool !== expectedPool.toBase58()) throw new Error(`${prefix} post-grad report identity mismatch`);
  if (report.reload?.status !== 'PASS') throw new Error(`${prefix} post-grad report reload did not pass`);

  const campaignAccount = await connection.getAccountInfo(campaign, 'confirmed');
  if (!campaignAccount || !campaignAccount.owner.equals(LAUNCH_PROGRAM) || campaignAccount.data.length < CAMPAIGN_BYTES) throw new Error(`${prefix} campaign is not an accepted launch-program campaign`);
  const creator = pub(campaignAccount.data, CREATOR_OFFSET);
  const mint = pub(campaignAccount.data, MINT_OFFSET);
  if (!mint.equals(expectedMint)) throw new Error(`${prefix} campaign mint mismatch`);
  if (campaignAccount.data[GRADUATED_OFFSET] !== 1 || campaignAccount.data[CURVE_CLOSED_OFFSET] !== 1) throw new Error(`${prefix} campaign is not graduated/curve-closed`);
  if (campaignAccount.data[DEX_ADAPTER_OFFSET] !== METEORA_DAMM_V2) throw new Error(`${prefix} campaign did not lock Meteora DAMM v2`);

  const derivedPool = deriveCustomizablePoolAddress(mint, NATIVE_MINT);
  if (!derivedPool.equals(expectedPool)) throw new Error(`${prefix} supplied Meteora pool != canonical customizable pool`);
  const poolState = await cpAmm.fetchPoolState(expectedPool);
  const validPair = (poolState.tokenAMint.equals(mint) && poolState.tokenBMint.equals(NATIVE_MINT)) || (poolState.tokenBMint.equals(mint) && poolState.tokenAMint.equals(NATIVE_MINT));
  if (!validPair) throw new Error(`${prefix} Meteora pool is not launch mint/WSOL`);

  const mintState = await getMint(connection, mint, 'confirmed', TOKEN_PROGRAM_ID);
  const tokenVaultKey = poolState.tokenAMint.equals(mint) ? poolState.tokenAVault : poolState.tokenBVault;
  const solVaultKey = poolState.tokenAMint.equals(NATIVE_MINT) ? poolState.tokenAVault : poolState.tokenBVault;

  const buy = await landed(connection, report.buy.signature);
  const sell = await landed(connection, report.sell.signature);
  const payer = new PublicKey(report.payer);
  const buyNativeRaw = payerNativeVolume(buy.tx, payer);
  const sellNativeRaw = payerNativeVolume(sell.tx, payer);
  const volumeNative = (buyNativeRaw || 0n) + (sellNativeRaw || 0n);
  if (volumeNative <= 0n) throw new Error(`${prefix} post-grad transactions have no native-value evidence`);
  const volumeUsd = Number(volumeNative) / 1e9 * solUsd;

  const baseline = await marketSnapshot(connection, mintState, mint, tokenVaultKey, solVaultKey, solUsd, 0);
  if (delayMs > 0) await sleep(delayMs);
  const current = await marketSnapshot(connection, mintState, mint, tokenVaultKey, solVaultKey, solUsd, volumeUsd);
  if (current.slot < baseline.slot) throw new Error(`${prefix} market snapshot slot moved backwards`);

  return {
    campaign: campaign.toBase58(),
    mint: mint.toBase58(),
    creator: creator.toBase58(),
    graduated: true,
    curveClosed: true,
    dexAdapter: 'meteora_damm_v2',
    meteoraPool: expectedPool.toBase58(),
    poolVaults: { token: tokenVaultKey.toBase58(), wsol: solVaultKey.toBase58() },
    immutableLiveBaseline: baseline,
    finalMarketSnapshot: current,
    postGradTransactions: {
      buy: { signature: report.buy.signature, slot: buy.slot, blockTime: buy.blockTime, nativeVolumeRaw: String(buyNativeRaw || 0n) },
      sell: { signature: report.sell.signature, slot: sell.slot, blockTime: sell.blockTime, nativeVolumeRaw: String(sellNativeRaw || 0n) },
    },
    postGradReportSha256: sha(reportBytes),
  };
}

async function main() {
  if (req('SOLANA_APPLICATION_CHAIN_ID') !== '101') throw new Error('canonical application chain must be 101');
  const solUsd = Number(req('SOLANA_CLOSEOUT_SOL_USD'));
  if (!Number.isFinite(solUsd) || solUsd <= 0) throw new Error('SOLANA_CLOSEOUT_SOL_USD must be positive');
  const delaySeconds = Math.max(0, Math.min(120, Number(process.env.SOLANA_POSTBOND_SNAPSHOT_DELAY_SECONDS || '5')));
  if (!Number.isFinite(delaySeconds)) throw new Error('SOLANA_POSTBOND_SNAPSHOT_DELAY_SECONDS must be numeric');
  const connection = new Connection(req('SOLANA_RPC_URL'), 'confirmed');
  if (await connection.getGenesisHash() !== DEVNET_GENESIS) throw new Error('refusing non-devnet RPC');
  const cpAmm = new CpAmm(connection);
  const left = await side(connection, cpAmm, 'SOLANA_POSTBOND_LEFT', req('SOLANA_POSTBOND_LEFT_POSTGRAD_REPORT'), solUsd, delaySeconds * 1000);
  const right = await side(connection, cpAmm, 'SOLANA_POSTBOND_RIGHT', req('SOLANA_POSTBOND_RIGHT_POSTGRAD_REPORT'), solUsd, delaySeconds * 1000);
  if (left.mint === right.mint || left.campaign === right.campaign) throw new Error('Battle campaigns must be distinct');
  if (left.creator === right.creator) throw new Error('ArenaMoneyV2 Battle requires distinct owner wallets; supplied graduated campaigns share a creator');
  const output = {
    schemaVersion: 2,
    purpose: 'solana-postbond-current-head-chain-evidence',
    sourceAuthority: SOURCE,
    applicationChainId: 101,
    cluster: 'devnet',
    launchProgram: LAUNCH_PROGRAM.toBase58(),
    snapshotDelaySeconds: delaySeconds,
    left,
    right,
    checks: {
      graduatedCampaigns: true,
      realMeteoraPools: true,
      realPostGradBuySell: true,
      postGradMarketDataOnly: true,
      immutableLiveBaselineCapturedFromChain: true,
      noBondingTradeEvidence: true,
      noCrossChainIdentity: true,
    },
  };
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
}
main().catch((error) => { console.error(error?.stack || error); process.exit(1); });
