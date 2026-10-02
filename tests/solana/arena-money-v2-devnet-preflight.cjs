'use strict';

const crypto = require('crypto');
const {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} = require('@solana/web3.js');

const EXPECTED_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const PROGRAM_ID = new PublicKey('2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX');
const EXPECTED_CONFIG = new PublicKey('Bio7bTMDLo1rYhKbR26jW98N4YvdeQW3UzUw4cHEv8xX');
const OPERATOR = new PublicKey('HuKfoFUuWxC5qFZXzr5dbaX4S7w4vJUW8AHV9LD4C2J9');
const BPF_UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

function disc(name) {
  return crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}
function u64(v) {
  const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b;
}
function i64(v) {
  const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b;
}
function randomPubkey(label) {
  return new PublicKey(crypto.createHash('sha256').update(label).digest());
}
function pubkeyBytes(pk) { return new PublicKey(pk).toBuffer(); }

function decodeUpgradeableProgram(programInfo) {
  if (!programInfo || !programInfo.executable) throw new Error('rewards treasury program account is missing/non-executable');
  if (!programInfo.owner.equals(BPF_UPGRADEABLE_LOADER)) {
    throw new Error(`unexpected program loader owner ${programInfo.owner.toBase58()}`);
  }
  const data = Buffer.from(programInfo.data);
  if (data.length < 36 || data.readUInt32LE(0) !== 2) {
    throw new Error(`unexpected upgradeable Program state tag/length tag=${data.length >= 4 ? data.readUInt32LE(0) : 'short'} bytes=${data.length}`);
  }
  return new PublicKey(data.subarray(4, 36));
}

function decodeProgramData(info) {
  if (!info) throw new Error('ProgramData account missing');
  const data = Buffer.from(info.data);
  if (data.length < 13 || data.readUInt32LE(0) !== 3) throw new Error('unexpected ProgramData state');
  const slot = data.readBigUInt64LE(4).toString();
  const option = data[12];
  let authority = null;
  if (option === 1) {
    if (data.length < 45) throw new Error('short ProgramData authority payload');
    authority = new PublicKey(data.subarray(13, 45)).toBase58();
  } else if (option !== 0) {
    // Bincode Option is currently one byte in Solana's loader state. Fail closed if layout differs.
    throw new Error(`unexpected ProgramData authority option ${option}`);
  }
  return { slot, authority };
}

function classifyDispatch(logs, err) {
  const text = (logs || []).join('\n');
  const fallback = /InstructionFallbackNotFound|Fallback functions are not supported|instruction fallback is not implemented/i.test(text);
  const unknown = /unknown instruction|invalid instruction data/i.test(text) && !/not enough account/i.test(text);
  const enteredProgram = text.includes(`Program ${PROGRAM_ID.toBase58()} invoke`);
  const recognized = enteredProgram && !fallback && !unknown;
  return { recognized, fallback, unknown, err, logs: logs || [] };
}

async function probe(connection, name, data) {
  const ix = new TransactionInstruction({ programId: PROGRAM_ID, keys: [], data });
  const tx = new Transaction();
  tx.feePayer = OPERATOR;
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  tx.add(ix);
  const sim = await connection.simulateTransaction(tx, undefined, false);
  const c = classifyDispatch(sim.value.logs, sim.value.err);
  console.log(`DISPATCH_PROBE ${name} ${JSON.stringify(c)}`);
  if (!c.recognized) throw new Error(`LIVE_BINARY_MISMATCH: deployed binary did not recognize ${name}`);
  return c;
}

function printCandidatePublicVars() {
  const raw = process.env.GITHUB_PUBLIC_VARS_JSON || '{}';
  let vars = {};
  try { vars = JSON.parse(raw); } catch { return; }
  const candidates = {};
  for (const [key, value] of Object.entries(vars)) {
    if (!/(ARENA|SOLANA)/i.test(key)) continue;
    if (/(RPC|URL|ENDPOINT|SECRET|TOKEN|PASSWORD|PRIVATE|KEY)/i.test(key)) continue;
    if (typeof value !== 'string' || !value) continue;
    try {
      const pk = new PublicKey(value);
      candidates[key] = pk.toBase58();
    } catch {}
  }
  console.log(`PUBLIC_KEY_RUNTIME_VARS ${JSON.stringify(candidates)}`);
}

(async () => {
  const rpc = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
  const connection = new Connection(rpc, 'confirmed');
  const genesis = await connection.getGenesisHash();
  console.log(`GENESIS ${genesis}`);
  if (genesis !== EXPECTED_GENESIS) throw new Error(`wrong cluster genesis ${genesis}`);

  const opBalance = await connection.getBalance(OPERATOR, 'confirmed');
  console.log(`OPERATOR ${OPERATOR.toBase58()} BALANCE_LAMPORTS ${opBalance}`);

  const [derivedConfig, bump] = PublicKey.findProgramAddressSync([Buffer.from('arena_money_config_v2')], PROGRAM_ID);
  console.log(`CONFIG_DERIVED ${derivedConfig.toBase58()} BUMP ${bump}`);
  if (!derivedConfig.equals(EXPECTED_CONFIG)) throw new Error('canonical config PDA mismatch');

  const pinfo = await connection.getAccountInfo(PROGRAM_ID, 'confirmed');
  const programData = decodeUpgradeableProgram(pinfo);
  const pdInfo = await connection.getAccountInfo(programData, 'confirmed');
  const pd = decodeProgramData(pdInfo);
  console.log(`PROGRAM ${PROGRAM_ID.toBase58()} OWNER ${pinfo.owner.toBase58()} EXECUTABLE ${pinfo.executable}`);
  console.log(`PROGRAMDATA ${programData.toBase58()} DEPLOY_SLOT ${pd.slot} UPGRADE_AUTHORITY ${pd.authority || 'NONE'}`);

  const configInfo = await connection.getAccountInfo(EXPECTED_CONFIG, 'confirmed');
  console.log(`CONFIG_BEFORE ${JSON.stringify({address: EXPECTED_CONFIG.toBase58(), exists: !!configInfo, owner: configInfo ? configInfo.owner.toBase58() : null, bytes: configInfo ? configInfo.data.length : 0})}`);

  const resolver = randomPubkey('mwz-agent3-probe-resolver');
  const protocol = randomPubkey('mwz-agent3-probe-protocol');
  const marketing = randomPubkey('mwz-agent3-probe-marketing');
  await probe(connection, 'initialize_arena_money_v2', Buffer.concat([
    disc('initialize_arena_money_v2'), pubkeyBytes(resolver), pubkeyBytes(protocol), pubkeyBytes(marketing),
  ]));

  const cid = crypto.createHash('sha256').update('mwz-agent3-probe-competition').digest();
  await probe(connection, 'open_competition_pool_v2', Buffer.concat([
    disc('open_competition_pool_v2'), cid, Buffer.from([0]),
    pubkeyBytes(randomPubkey('asset-a')), pubkeyBytes(randomPubkey('asset-b')),
    pubkeyBytes(randomPubkey('owner-a')), pubkeyBytes(randomPubkey('owner-b')),
    u64(1_000_000), i64(0), i64(1_900_000_000),
  ]));
  await probe(connection, 'deposit_competition_entry_v2', Buffer.concat([
    disc('deposit_competition_entry_v2'), cid, pubkeyBytes(randomPubkey('asset-entry')),
  ]));

  printCandidatePublicVars();
  console.log('LIVE_BINARY_SUPPORTS_ARENA_MONEY_V2 YES');
  console.log('MUTATION_PERFORMED NO');
})().catch((err) => {
  console.error(`PREFLIGHT_BLOCKER ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
