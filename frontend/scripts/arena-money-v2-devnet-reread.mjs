#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';

const EXPECTED_PROGRAM_ID = new PublicKey('2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX');
const EXPECTED_CONFIG_PDA = new PublicKey('Bio7bTMDLo1rYhKbR26jW98N4YvdeQW3UzUw4cHEv8xX');
const EXPECTED_DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const UPGRADEABLE_LOADER_ID = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const CONFIG_SEED = Buffer.from('arena_money_config_v2');

function requireEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`MISSING_${name}`);
  return value;
}

function parseSecret(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('MISSING_SOLANA_REWARDS_AUTHORITY_SECRET_KEY');
  let bytes;
  if (value.startsWith('[')) bytes = Uint8Array.from(JSON.parse(value));
  else {
    try { bytes = Uint8Array.from(Buffer.from(value, 'base64')); }
    catch { throw new Error('INVALID_SOLANA_REWARDS_AUTHORITY_SECRET_KEY'); }
  }
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error(`INVALID_SOLANA_REWARDS_AUTHORITY_SECRET_KEY_LENGTH_${bytes.length}`);
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function instructionDiscriminator(name) {
  return crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

function decodePubkey(buffer, offset) {
  return new PublicKey(buffer.subarray(offset, offset + 32)).toBase58();
}

function decodeArenaMoneyConfig(data) {
  if (data.length < 139) throw new Error(`ARENA_MONEY_CONFIG_TOO_SMALL_${data.length}`);
  return {
    generation: data.readUInt8(8),
    authority: decodePubkey(data, 9),
    resolver: decodePubkey(data, 41),
    protocolReceiver: decodePubkey(data, 73),
    marketingReceiver: decodePubkey(data, 105),
    paused: data.readUInt8(137) !== 0,
    bump: data.readUInt8(138),
  };
}

function encodeInitializeArgs(pubkey) {
  const key = pubkey.toBuffer();
  return Buffer.concat([instructionDiscriminator('initialize_arena_money_v2'), key, key, key]);
}

async function simulateInitialize(connection, authority, configPda) {
  const ix = new TransactionInstruction({
    programId: EXPECTED_PROGRAM_ID,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeInitializeArgs(authority.publicKey),
  });
  const latest = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: authority.publicKey, recentBlockhash: latest.blockhash }).add(ix);
  tx.sign(authority);
  const sim = await connection.simulateTransaction(tx, undefined, true);
  const logs = sim.value.logs || [];
  const text = logs.join('\n');
  const fallback = /InstructionFallbackNotFound|fallback functions are not supported|custom program error: 0x65\b/i.test(text);
  const invoked = text.includes(`Program ${EXPECTED_PROGRAM_ID.toBase58()} invoke`);
  const recognized = invoked && !fallback;
  return {
    recognized,
    fallback,
    err: sim.value.err,
    unitsConsumed: sim.value.unitsConsumed ?? null,
    logs,
  };
}

async function main() {
  const rpcUrl = requireEnv('SOLANA_REWARDS_RPC_URL');
  const configuredProgram = String(process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID || EXPECTED_PROGRAM_ID.toBase58()).trim();
  if (configuredProgram !== EXPECTED_PROGRAM_ID.toBase58()) throw new Error(`PROGRAM_ID_ENV_MISMATCH_${configuredProgram}`);
  const authority = parseSecret(requireEnv('SOLANA_REWARDS_AUTHORITY_SECRET_KEY'));
  const candidatePath = requireEnv('ARENA_MONEY_V2_CANDIDATE_PATH');
  const outPath = String(process.env.ARENA_MONEY_V2_REREAD_OUT || '/tmp/arena-money-v2-live-reread.json').trim();

  const connection = new Connection(rpcUrl, 'confirmed');
  const genesisHash = await connection.getGenesisHash();
  if (genesisHash !== EXPECTED_DEVNET_GENESIS) throw new Error(`REFUSE_NON_DEVNET_GENESIS_${genesisHash}`);

  const [derivedConfigPda, configBump] = PublicKey.findProgramAddressSync([CONFIG_SEED], EXPECTED_PROGRAM_ID);
  if (!derivedConfigPda.equals(EXPECTED_CONFIG_PDA)) throw new Error(`CONFIG_PDA_DRIFT_${derivedConfigPda.toBase58()}`);

  const programInfo = await connection.getAccountInfo(EXPECTED_PROGRAM_ID, 'confirmed');
  if (!programInfo) throw new Error('REWARDS_TREASURY_PROGRAM_MISSING');
  if (!programInfo.executable) throw new Error('REWARDS_TREASURY_PROGRAM_NOT_EXECUTABLE');
  if (!programInfo.owner.equals(UPGRADEABLE_LOADER_ID)) throw new Error(`UNEXPECTED_PROGRAM_OWNER_${programInfo.owner.toBase58()}`);
  if (programInfo.data.length < 36 || programInfo.data.readUInt32LE(0) !== 2) throw new Error('INVALID_UPGRADEABLE_PROGRAM_ACCOUNT');
  const programDataAddress = new PublicKey(programInfo.data.subarray(4, 36));

  const programDataInfo = await connection.getAccountInfo(programDataAddress, 'confirmed');
  if (!programDataInfo) throw new Error('PROGRAMDATA_MISSING');
  if (!programDataInfo.owner.equals(UPGRADEABLE_LOADER_ID)) throw new Error(`UNEXPECTED_PROGRAMDATA_OWNER_${programDataInfo.owner.toBase58()}`);
  if (programDataInfo.data.length < 13 || programDataInfo.data.readUInt32LE(0) !== 3) throw new Error('INVALID_PROGRAMDATA_ACCOUNT');
  const deploymentSlot = Number(programDataInfo.data.readBigUInt64LE(4));
  const authorityOption = programDataInfo.data.readUInt8(12);
  const liveUpgradeAuthority = authorityOption === 1 ? new PublicKey(programDataInfo.data.subarray(13, 45)) : null;
  if (!liveUpgradeAuthority) throw new Error('PROGRAM_IS_IMMUTABLE_NO_UPGRADE_AUTHORITY');

  const configuredAuthorityMatches = authority.publicKey.equals(liveUpgradeAuthority);
  const upgradeAuthorityBalanceLamports = await connection.getBalance(liveUpgradeAuthority, 'confirmed');

  const liveDumpPath = '/tmp/mwz-rewards-treasury-live.so';
  execFileSync('solana', ['program', 'dump', EXPECTED_PROGRAM_ID.toBase58(), liveDumpPath, '--url', rpcUrl], { stdio: ['ignore', 'pipe', 'pipe'] });
  const deployedBinarySha256 = sha256File(liveDumpPath);
  const deployedBinaryBytes = fs.statSync(liveDumpPath).size;
  const candidateBinarySha256 = sha256File(candidatePath);
  const candidateBinaryBytes = fs.statSync(candidatePath).size;

  const configInfo = await connection.getAccountInfo(EXPECTED_CONFIG_PDA, 'confirmed');
  let config = null;
  if (configInfo) {
    if (!configInfo.owner.equals(EXPECTED_PROGRAM_ID)) throw new Error(`CONFIG_OWNER_MISMATCH_${configInfo.owner.toBase58()}`);
    config = decodeArenaMoneyConfig(configInfo.data);
    if (config.generation !== 2) throw new Error(`CONFIG_GENERATION_MISMATCH_${config.generation}`);
    if (config.bump !== configBump) throw new Error(`CONFIG_BUMP_MISMATCH_${config.bump}_${configBump}`);
  }

  const instructionProbe = await simulateInitialize(connection, authority, EXPECTED_CONFIG_PDA);
  const result = {
    sourceSha: process.env.GITHUB_SHA || null,
    genesisHash,
    network: 'solana-devnet',
    programId: EXPECTED_PROGRAM_ID.toBase58(),
    programData: programDataAddress.toBase58(),
    deploymentSlot,
    upgradeAuthority: liveUpgradeAuthority.toBase58(),
    configuredAuthorityPublicKey: authority.publicKey.toBase58(),
    configuredAuthorityMatches,
    upgradeAuthorityBalanceLamports,
    upgradeAuthorityBalanceSol: upgradeAuthorityBalanceLamports / 1_000_000_000,
    deployedBinarySha256,
    deployedBinaryBytes,
    candidateBinarySha256,
    candidateBinaryBytes,
    binaryIdentityMatch: deployedBinarySha256 === candidateBinarySha256,
    configPda: EXPECTED_CONFIG_PDA.toBase58(),
    configBump,
    configExists: Boolean(configInfo),
    config,
    protocolReceiver: config?.protocolReceiver ?? null,
    marketingReceiver: config?.marketingReceiver ?? null,
    marketingAuthority: config?.authority ?? null,
    arenaMoneyV2InstructionAvailable: instructionProbe.recognized,
    initializeProbe: instructionProbe,
    readOnly: true,
  };

  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  console.log(`[arena-money-v2] READ_ONLY_REREAD_COMPLETE output=${outPath}`);
  if (!configuredAuthorityMatches) throw new Error('CONFIGURED_REWARDS_AUTHORITY_DOES_NOT_MATCH_LIVE_UPGRADE_AUTHORITY');
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
