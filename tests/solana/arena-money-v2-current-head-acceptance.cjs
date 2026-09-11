const crypto = require('crypto');
const fs = require('fs');
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} = require('@solana/web3.js');

const EXPECTED_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const PROGRAM_ID = new PublicKey('2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX');
const EXPECTED_PROGRAMDATA = new PublicKey('H8DKTTSuGQQccvQ9A3DZWesxsdcw619qJnr57yHtB9ZP');
const EXPECTED_AUTHORITY = new PublicKey('HuKfoFUuWxC5qFZXzr5dbaX4S7w4vJUW8AHV9LD4C2J9');
const RESOLVER = new PublicKey('7hKQd798Z1ERmRUhm7shmstB1V13FQNnDLqtYjZBuJUz');
const PROTOCOL = new PublicKey('4AjT4LkVuf9mrgoPN4KisZnKKQwiPw7JbMUJckBEhy8j');
const MARKETING = new PublicKey('3z7984gPAmbopC82pd6R5F2jgGSQekQVSM6rmPffVmsj');
const SYSTEM = SystemProgram.programId;
const ZERO = new PublicKey(new Uint8Array(32));
const CONFIG_SEED = Buffer.from('arena_money_config_v2');
const POOL_SEED = Buffer.from('arena_competition_v2');
const RECEIPT_SEED = Buffer.from('arena_money_entry_v2');
const ENTRY = 1_000_000;

const b58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function decodeBase58(value) {
  let num = 0n;
  for (const ch of value) {
    const i = b58.indexOf(ch);
    if (i < 0) throw new Error('invalid base58');
    num = num * 58n + BigInt(i);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const body = Buffer.from(hex, 'hex');
  let zeros = 0;
  for (const ch of value) { if (ch === '1') zeros += 1; else break; }
  return Uint8Array.from(Buffer.concat([Buffer.alloc(zeros), body]));
}
function parseKeypair(raw, name) {
  const value = String(raw || '').trim();
  if (!value) throw new Error(`${name} missing`);
  let bytes;
  if (value.startsWith('[')) bytes = Uint8Array.from(JSON.parse(value).map(Number));
  else if (/^(0x)?[0-9a-fA-F]{64}$/.test(value)) bytes = Uint8Array.from(Buffer.from(value.replace(/^0x/, ''), 'hex'));
  else if (/^(0x)?[0-9a-fA-F]{128}$/.test(value)) bytes = Uint8Array.from(Buffer.from(value.replace(/^0x/, ''), 'hex'));
  else bytes = decodeBase58(value);
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error(`${name} invalid secret length ${bytes.length}`);
}
function disc(name) { return crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8); }
function u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
function i64(n) { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; }
function id32(label) { return crypto.createHash('sha256').update(`${label}:${Date.now()}:${crypto.randomBytes(16).toString('hex')}`).digest(); }
function ix(name, keys, parts = []) { return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: Buffer.concat([disc(name), ...parts]) }); }
function pda(seed, id) { return PublicKey.findProgramAddressSync([seed, id], PROGRAM_ID)[0]; }
function receiptPda(id, asset, entrant) { return PublicKey.findProgramAddressSync([RECEIPT_SEED, id, asset.toBuffer(), entrant.toBuffer()], PROGRAM_ID)[0]; }
function pk(buf, offset) { return new PublicKey(buf.subarray(offset, offset + 32)); }
function readU64(buf, offset) { return Number(buf.readBigUInt64LE(offset)); }
function decodeConfig(data) {
  let o = 8;
  const generation = data[o++];
  const authority = pk(data, o); o += 32;
  const resolver = pk(data, o); o += 32;
  const protocolReceiver = pk(data, o); o += 32;
  const marketingReceiver = pk(data, o); o += 32;
  const paused = Boolean(data[o++]);
  const bump = data[o++];
  return { generation, authority: authority.toBase58(), resolver: resolver.toBase58(), protocolReceiver: protocolReceiver.toBase58(), marketingReceiver: marketingReceiver.toBase58(), paused, bump };
}
function decodeReceipt(data) {
  let o = 8;
  const generation = data[o++];
  const competitionId = data.subarray(o, o + 32).toString('hex'); o += 32;
  const entrant = pk(data, o); o += 32;
  const entryAsset = pk(data, o); o += 32;
  const amountLamports = readU64(data, o); o += 8;
  const createdAt = Number(data.readBigInt64LE(o)); o += 8;
  const refunded = Boolean(data[o++]);
  const bump = data[o++];
  return { generation, competitionId, entrant: entrant.toBase58(), entryAsset: entryAsset.toBase58(), amountLamports, createdAt, refunded, bump };
}
function decodePool(data) {
  let o = 8;
  const generation = data[o++];
  const competitionId = data.subarray(o, o + 32).toString('hex'); o += 32;
  const kind = data[o++];
  const state = data[o++];
  const authority = pk(data, o); o += 32;
  const assetA = pk(data, o); o += 32;
  const assetB = pk(data, o); o += 32;
  const ownerA = pk(data, o); o += 32;
  const ownerB = pk(data, o); o += 32;
  const requiredEntryLamports = readU64(data, o); o += 8;
  const entryTotalLamports = readU64(data, o); o += 8;
  const entryCount = data.readUInt32LE(o); o += 4;
  const boostGrossLamports = readU64(data, o); o += 8;
  const boostPrizeLamports = readU64(data, o); o += 8;
  const boostProtocolLamports = readU64(data, o); o += 8;
  const winnerAsset = pk(data, o); o += 32;
  const winnerWallet = pk(data, o); o += 32;
  const pendingWinnerLamports = readU64(data, o); o += 8;
  const pendingLeagueLamports = readU64(data, o); o += 8;
  const pendingProtocolLamports = readU64(data, o); o += 8;
  const winnerClaimed = Boolean(data[o++]);
  const leagueClaimed = Boolean(data[o++]);
  const protocolClaimed = Boolean(data[o++]);
  const opensAt = Number(data.readBigInt64LE(o)); o += 8;
  const closesAt = Number(data.readBigInt64LE(o)); o += 8;
  const resolvedAt = Number(data.readBigInt64LE(o)); o += 8;
  const bump = data[o++];
  return { generation, competitionId, kind, state, authority: authority.toBase58(), assetA: assetA.toBase58(), assetB: assetB.toBase58(), ownerA: ownerA.toBase58(), ownerB: ownerB.toBase58(), requiredEntryLamports, entryTotalLamports, entryCount, boostGrossLamports, boostPrizeLamports, boostProtocolLamports, winnerAsset: winnerAsset.toBase58(), winnerWallet: winnerWallet.toBase58(), pendingWinnerLamports, pendingLeagueLamports, pendingProtocolLamports, winnerClaimed, leagueClaimed, protocolClaimed, opensAt, closesAt, resolvedAt, bump };
}
async function bal(c, key) { return c.getBalance(key, 'confirmed'); }
async function txEvidence(c, label, instruction, feePayer, signers, tracked = []) {
  const before = {};
  for (const [name, key] of tracked) before[name] = await bal(c, key);
  const latest = await c.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: feePayer.publicKey, recentBlockhash: latest.blockhash }).add(instruction);
  tx.sign(...signers);
  const sim = await c.simulateTransaction(tx);
  console.log(`${label}_SIMULATION ${JSON.stringify({ err: sim.value.err, unitsConsumed: sim.value.unitsConsumed, logs: sim.value.logs })}`);
  if (sim.value.err) throw new Error(`${label} simulation failed: ${JSON.stringify(sim.value.err)}`);
  const raw = tx.serialize();
  const signature = await c.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
  const confirmation = await c.confirmTransaction({ signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, 'confirmed');
  if (confirmation.value.err) throw new Error(`${label} confirmation failed: ${JSON.stringify(confirmation.value.err)}`);
  const parsed = await c.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  const after = {};
  for (const [name, key] of tracked) after[name] = await bal(c, key);
  console.log(`${label}_EVIDENCE ${JSON.stringify({ signature, payer: feePayer.publicKey.toBase58(), slot: parsed?.slot ?? null, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, before, after })}`);
  return { signature, raw, latest, before, after };
}
async function simulateFailure(c, label, instruction, feePayer, signers) {
  const latest = await c.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: feePayer.publicKey, recentBlockhash: latest.blockhash }).add(instruction);
  tx.sign(...signers);
  const sim = await c.simulateTransaction(tx);
  console.log(`${label}_EXPECTED_FAILURE ${JSON.stringify({ err: sim.value.err, logs: sim.value.logs })}`);
  if (!sim.value.err) throw new Error(`${label} unexpectedly succeeded`);
  return sim.value;
}
async function preflight() {
  const c = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
  const payer = parseKeypair(process.env.SOLANA_DEVNET_PAYER, 'SOLANA_DEVNET_PAYER');
  const resolver = parseKeypair(process.env.SOLANA_DEVNET_ROUTE_SIGNER_SECRET_KEY, 'SOLANA_DEVNET_ROUTE_SIGNER_SECRET_KEY');
  if (!payer.publicKey.equals(EXPECTED_AUTHORITY)) throw new Error(`payer mismatch ${payer.publicKey.toBase58()}`);
  if (!resolver.publicKey.equals(RESOLVER)) throw new Error(`resolver mismatch ${resolver.publicKey.toBase58()}`);
  const distinct = new Set([payer.publicKey, RESOLVER, PROTOCOL, MARKETING].map(k => k.toBase58()));
  if (distinct.size !== 4 || [RESOLVER, PROTOCOL, MARKETING].some(k => k.equals(ZERO))) throw new Error('authority/receiver distinctness failure');
  const genesis = await c.getGenesisHash();
  if (genesis !== EXPECTED_GENESIS) throw new Error(`wrong genesis ${genesis}`);
  const program = await c.getAccountInfo(PROGRAM_ID, 'confirmed');
  if (!program) throw new Error('program missing');
  const data = Buffer.from(program.data);
  if (data.readUInt32LE(0) !== 2) throw new Error('program is not upgradeable-loader Program');
  const programData = new PublicKey(data.subarray(4, 36));
  if (!programData.equals(EXPECTED_PROGRAMDATA)) throw new Error(`programdata mismatch ${programData.toBase58()}`);
  const pd = await c.getAccountInfo(programData, 'confirmed');
  if (!pd) throw new Error('programdata missing');
  const pdd = Buffer.from(pd.data);
  if (pdd.readUInt32LE(0) !== 3 || pdd[12] !== 1) throw new Error('programdata authority encoding invalid');
  const slot = Number(pdd.readBigUInt64LE(4));
  const auth = new PublicKey(pdd.subarray(13, 45));
  if (!auth.equals(EXPECTED_AUTHORITY)) throw new Error(`upgrade authority mismatch ${auth.toBase58()}`);
  const [config, bump] = PublicKey.findProgramAddressSync([CONFIG_SEED], PROGRAM_ID);
  const configInfo = await c.getAccountInfo(config, 'confirmed');
  console.log(`PREFLIGHT ${JSON.stringify({ genesis, programId: PROGRAM_ID.toBase58(), programData: programData.toBase58(), deploymentSlot: slot, upgradeAuthority: auth.toBase58(), payer: payer.publicKey.toBase58(), payerBalance: await bal(c, payer.publicKey), resolver: RESOLVER.toBase58(), protocolReceiver: PROTOCOL.toBase58(), marketingReceiver: MARKETING.toBase58(), configPda: config.toBase58(), configBump: bump, configExists: Boolean(configInfo), programDataAccountBytes: pd.data.length, maxProgramBytesApprox: pd.data.length - 45 })}`);
  if (configInfo) throw new Error('ArenaMoneyV2 config already exists; stop before mutation');
  fs.writeFileSync('/tmp/mwz-payer.json', JSON.stringify(Array.from(payer.secretKey)), { mode: 0o600 });
  fs.writeFileSync('/tmp/mwz-resolver.json', JSON.stringify(Array.from(resolver.secretKey)), { mode: 0o600 });
}
async function execute() {
  const c = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
  const payer = parseKeypair(process.env.SOLANA_DEVNET_PAYER, 'SOLANA_DEVNET_PAYER');
  const resolver = parseKeypair(process.env.SOLANA_DEVNET_ROUTE_SIGNER_SECRET_KEY, 'SOLANA_DEVNET_ROUTE_SIGNER_SECRET_KEY');
  const [config] = PublicKey.findProgramAddressSync([CONFIG_SEED], PROGRAM_ID);
  if (await c.getAccountInfo(config, 'confirmed')) throw new Error('config unexpectedly exists before initialize');
  const tracked = [['payer', payer.publicKey], ['protocol', PROTOCOL], ['marketing', MARKETING], ['config', config]];
  const initIx = ix('initialize_arena_money_v2', [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: config, isSigner: false, isWritable: true },
    { pubkey: SYSTEM, isSigner: false, isWritable: false },
  ], [RESOLVER.toBuffer(), PROTOCOL.toBuffer(), MARKETING.toBuffer()]);
  const init = await txEvidence(c, 'INITIALIZE_TX', initIx, payer, [payer], tracked);
  let cfg = decodeConfig(Buffer.from((await c.getAccountInfo(config, 'confirmed')).data));
  console.log(`CONFIG_AFTER_INITIALIZE ${JSON.stringify(cfg)}`);
  if (cfg.generation !== 2 || cfg.authority !== payer.publicKey.toBase58() || cfg.resolver !== RESOLVER.toBase58() || cfg.protocolReceiver !== PROTOCOL.toBase58() || cfg.marketingReceiver !== MARKETING.toBase58() || cfg.paused !== true) throw new Error('initialized config mismatch');
  const unpauseIx = ix('set_arena_money_v2_pause', [
    { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    { pubkey: config, isSigner: false, isWritable: true },
  ], [Buffer.from([0])]);
  const unpause = await txEvidence(c, 'UNPAUSE_TX', unpauseIx, payer, [payer], tracked);
  cfg = decodeConfig(Buffer.from((await c.getAccountInfo(config, 'confirmed')).data));
  console.log(`CONFIG_AFTER_UNPAUSE ${JSON.stringify(cfg)}`);
  if (cfg.paused) throw new Error('config remained paused');

  const protocolStart = await bal(c, PROTOCOL);
  const marketingStart = await bal(c, MARKETING);
  const ownerB = Keypair.generate();
  const fundIx = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: ownerB.publicKey, lamports: 5_000_000 });
  await txEvidence(c, 'BATTLE_FIXTURE_FUND_TX', fundIx, payer, [payer], [['payer', payer.publicKey], ['ownerB', ownerB.publicKey]]);
  const assetA = Keypair.generate().publicKey;
  const assetB = Keypair.generate().publicKey;
  const battleId = id32('agent3-battle');
  const battlePool = pda(POOL_SEED, battleId);
  const now = Math.floor(Date.now() / 1000);
  const openBattleIx = ix('open_competition_pool_v2', [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: config, isSigner: false, isWritable: false },
    { pubkey: battlePool, isSigner: false, isWritable: true },
    { pubkey: SYSTEM, isSigner: false, isWritable: false },
  ], [battleId, Buffer.from([0]), assetA.toBuffer(), assetB.toBuffer(), payer.publicKey.toBuffer(), ownerB.publicKey.toBuffer(), u64(ENTRY), i64(now - 10), i64(now + 900)]);
  await txEvidence(c, 'BATTLE_OPEN_TX', openBattleIx, payer, [payer], [['payer', payer.publicKey], ['battlePool', battlePool]]);
  const battleReceiptA = receiptPda(battleId, assetA, payer.publicKey);
  const depAIx = ix('deposit_competition_entry_v2', [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: config, isSigner: false, isWritable: false },
    { pubkey: battlePool, isSigner: false, isWritable: true },
    { pubkey: battleReceiptA, isSigner: false, isWritable: true },
    { pubkey: SYSTEM, isSigner: false, isWritable: false },
  ], [battleId, assetA.toBuffer()]);
  const depA = await txEvidence(c, 'NORMAL_BATTLE_PAYMENT_A', depAIx, payer, [payer], [['payer', payer.publicKey], ['battlePool', battlePool], ['protocol', PROTOCOL], ['marketing', MARKETING]]);
  const receiptAState = decodeReceipt(Buffer.from((await c.getAccountInfo(battleReceiptA, 'confirmed')).data));
  console.log(`NORMAL_BATTLE_RECEIPT_A ${JSON.stringify({ pda: battleReceiptA.toBase58(), ...receiptAState })}`);
  const reconcile = await c.getSignaturesForAddress(battleReceiptA, { limit: 10 }, 'confirmed');
  console.log(`PROCESS_FAILURE_RECONCILIATION ${JSON.stringify({ receipt: battleReceiptA.toBase58(), originalSignature: depA.signature, discoveredSignatures: reconcile.map(x => x.signature), recovered: reconcile.some(x => x.signature === depA.signature) })}`);
  if (!reconcile.some(x => x.signature === depA.signature)) throw new Error('could not recover original payment by receipt PDA');
  const replayBefore = { payer: await bal(c, payer.publicKey), pool: await bal(c, battlePool) };
  let replayResult;
  try { replayResult = await c.sendRawTransaction(depA.raw, { skipPreflight: false, maxRetries: 0 }); } catch (e) { replayResult = `rejected:${e.message}`; }
  await new Promise(r => setTimeout(r, 1500));
  const replayAfter = { payer: await bal(c, payer.publicKey), pool: await bal(c, battlePool) };
  console.log(`EXACT_TX_RETRY ${JSON.stringify({ originalSignature: depA.signature, retryResult: replayResult, replayBefore, replayAfter, noSecondEconomicEffect: replayBefore.payer === replayAfter.payer && replayBefore.pool === replayAfter.pool })}`);
  if (replayBefore.payer !== replayAfter.payer || replayBefore.pool !== replayAfter.pool) throw new Error('exact retry changed balances');
  await simulateFailure(c, 'DUPLICATE_FRESH_BLOCKHASH', depAIx, payer, [payer]);
  const wrongPayerReceipt = receiptPda(battleId, assetA, ownerB.publicKey);
  const wrongPayerIx = ix('deposit_competition_entry_v2', [
    { pubkey: ownerB.publicKey, isSigner: true, isWritable: true },
    { pubkey: config, isSigner: false, isWritable: false },
    { pubkey: battlePool, isSigner: false, isWritable: true },
    { pubkey: wrongPayerReceipt, isSigner: false, isWritable: true },
    { pubkey: SYSTEM, isSigner: false, isWritable: false },
  ], [battleId, assetA.toBuffer()]);
  await simulateFailure(c, 'WRONG_PAYER', wrongPayerIx, payer, [payer, ownerB]);
  const battleReceiptB = receiptPda(battleId, assetB, ownerB.publicKey);
  const depBIx = ix('deposit_competition_entry_v2', [
    { pubkey: ownerB.publicKey, isSigner: true, isWritable: true },
    { pubkey: config, isSigner: false, isWritable: false },
    { pubkey: battlePool, isSigner: false, isWritable: true },
    { pubkey: battleReceiptB, isSigner: false, isWritable: true },
    { pubkey: SYSTEM, isSigner: false, isWritable: false },
  ], [battleId, assetB.toBuffer()]);
  await txEvidence(c, 'NORMAL_BATTLE_PAYMENT_B', depBIx, payer, [payer, ownerB], [['payer', payer.publicKey], ['ownerB', ownerB.publicKey], ['battlePool', battlePool], ['protocol', PROTOCOL], ['marketing', MARKETING]]);
  const resolveBattleIx = ix('resolve_competition_pool_v2', [
    { pubkey: resolver.publicKey, isSigner: true, isWritable: false },
    { pubkey: config, isSigner: false, isWritable: false },
    { pubkey: battlePool, isSigner: false, isWritable: true },
    { pubkey: SYSTEM, isSigner: false, isWritable: false },
  ], [battleId, assetA.toBuffer(), payer.publicKey.toBuffer()]);
  await txEvidence(c, 'BATTLE_RESOLVE_TX', resolveBattleIx, payer, [payer, resolver], [['battlePool', battlePool], ['protocol', PROTOCOL], ['marketing', MARKETING]]);
  let battleState = decodePool(Buffer.from((await c.getAccountInfo(battlePool, 'confirmed')).data));
  console.log(`BATTLE_RESOLVED_STATE ${JSON.stringify(battleState)}`);
  if (battleState.entryTotalLamports !== 2 * ENTRY || battleState.pendingWinnerLamports !== 1_500_000 || battleState.pendingLeagueLamports !== 400_000 || battleState.pendingProtocolLamports !== 100_000) throw new Error('battle 75/20/5 split mismatch');
  const wrongReceiverIx = ix('claim_competition_protocol_v2', [
    { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    { pubkey: config, isSigner: false, isWritable: false },
    { pubkey: MARKETING, isSigner: false, isWritable: true },
    { pubkey: battlePool, isSigner: false, isWritable: true },
  ], [battleId]);
  await simulateFailure(c, 'WRONG_PROTOCOL_RECEIVER', wrongReceiverIx, payer, [payer]);
  const claimBattleProtocolIx = ix('claim_competition_protocol_v2', [
    { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    { pubkey: config, isSigner: false, isWritable: false },
    { pubkey: PROTOCOL, isSigner: false, isWritable: true },
    { pubkey: battlePool, isSigner: false, isWritable: true },
  ], [battleId]);
  await txEvidence(c, 'BATTLE_PROTOCOL_CLAIM_TX', claimBattleProtocolIx, payer, [payer], [['battlePool', battlePool], ['protocol', PROTOCOL], ['marketing', MARKETING]]);
  battleState = decodePool(Buffer.from((await c.getAccountInfo(battlePool, 'confirmed')).data));
  console.log(`BATTLE_POST_PROTOCOL_STATE ${JSON.stringify(battleState)}`);

  const tournamentId = id32('agent3-tournament');
  const tournamentPool = pda(POOL_SEED, tournamentId);
  const tournamentAsset = Keypair.generate().publicKey;
  const openTournamentIx = ix('open_competition_pool_v2', [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: config, isSigner: false, isWritable: false },
    { pubkey: tournamentPool, isSigner: false, isWritable: true },
    { pubkey: SYSTEM, isSigner: false, isWritable: false },
  ], [tournamentId, Buffer.from([1]), ZERO.toBuffer(), ZERO.toBuffer(), ZERO.toBuffer(), ZERO.toBuffer(), u64(ENTRY), i64(now - 10), i64(now + 900)]);
  await txEvidence(c, 'TOURNAMENT_OPEN_TX', openTournamentIx, payer, [payer], [['payer', payer.publicKey], ['tournamentPool', tournamentPool]]);
  const tournamentReceipt = receiptPda(tournamentId, tournamentAsset, payer.publicKey);
  const tournamentPayIx = ix('deposit_competition_entry_v2', [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: config, isSigner: false, isWritable: false },
    { pubkey: tournamentPool, isSigner: false, isWritable: true },
    { pubkey: tournamentReceipt, isSigner: false, isWritable: true },
    { pubkey: SYSTEM, isSigner: false, isWritable: false },
  ], [tournamentId, tournamentAsset.toBuffer()]);
  const tournamentPay = await txEvidence(c, 'TOURNAMENT_PAYMENT', tournamentPayIx, payer, [payer], [['payer', payer.publicKey], ['tournamentPool', tournamentPool], ['protocol', PROTOCOL], ['marketing', MARKETING]]);
  console.log(`TOURNAMENT_RECEIPT ${JSON.stringify({ pda: tournamentReceipt.toBase58(), ...decodeReceipt(Buffer.from((await c.getAccountInfo(tournamentReceipt, 'confirmed')).data)) })}`);
  await simulateFailure(c, 'TOURNAMENT_DUPLICATE', tournamentPayIx, payer, [payer]);
  const wrongCompetition = id32('wrong-competition');
  const wrongPool = pda(POOL_SEED, wrongCompetition);
  const wrongReceipt = receiptPda(wrongCompetition, tournamentAsset, payer.publicKey);
  const wrongCompetitionIx = ix('deposit_competition_entry_v2', [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: config, isSigner: false, isWritable: false },
    { pubkey: wrongPool, isSigner: false, isWritable: true },
    { pubkey: wrongReceipt, isSigner: false, isWritable: true },
    { pubkey: SYSTEM, isSigner: false, isWritable: false },
  ], [wrongCompetition, tournamentAsset.toBuffer()]);
  await simulateFailure(c, 'WRONG_COMPETITION', wrongCompetitionIx, payer, [payer]);
  const resolveTournamentIx = ix('resolve_competition_pool_v2', [
    { pubkey: resolver.publicKey, isSigner: true, isWritable: false },
    { pubkey: config, isSigner: false, isWritable: false },
    { pubkey: tournamentPool, isSigner: false, isWritable: true },
    { pubkey: tournamentReceipt, isSigner: false, isWritable: false },
  ], [tournamentId, tournamentAsset.toBuffer(), payer.publicKey.toBuffer()]);
  await txEvidence(c, 'TOURNAMENT_RESOLVE_TX', resolveTournamentIx, payer, [payer, resolver], [['tournamentPool', tournamentPool], ['protocol', PROTOCOL], ['marketing', MARKETING]]);
  let tournamentState = decodePool(Buffer.from((await c.getAccountInfo(tournamentPool, 'confirmed')).data));
  console.log(`TOURNAMENT_RESOLVED_STATE ${JSON.stringify(tournamentState)}`);
  if (tournamentState.entryTotalLamports !== ENTRY || tournamentState.pendingWinnerLamports !== 750_000 || tournamentState.pendingLeagueLamports !== 200_000 || tournamentState.pendingProtocolLamports !== 50_000) throw new Error('tournament 75/20/5 split mismatch');
  const claimTournamentProtocolIx = ix('claim_competition_protocol_v2', [
    { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    { pubkey: config, isSigner: false, isWritable: false },
    { pubkey: PROTOCOL, isSigner: false, isWritable: true },
    { pubkey: tournamentPool, isSigner: false, isWritable: true },
  ], [tournamentId]);
  await txEvidence(c, 'TOURNAMENT_PROTOCOL_CLAIM_TX', claimTournamentProtocolIx, payer, [payer], [['tournamentPool', tournamentPool], ['protocol', PROTOCOL], ['marketing', MARKETING]]);
  tournamentState = decodePool(Buffer.from((await c.getAccountInfo(tournamentPool, 'confirmed')).data));
  const protocolEnd = await bal(c, PROTOCOL);
  const marketingEnd = await bal(c, MARKETING);
  console.log(`FINAL_ECONOMICS ${JSON.stringify({ protocolStart, protocolEnd, protocolDelta: protocolEnd - protocolStart, expectedProtocolDelta: 150_000, marketingStart, marketingEnd, marketingDelta: marketingEnd - marketingStart, expectedMarketingDelta: 0, battle: battleState, tournament: tournamentState, normalEntryAmountIsCanonicalPoolField: true, clientSuppliedAmountFieldExists: false })}`);
  if (protocolEnd - protocolStart !== 150_000) throw new Error('protocol receiver delta mismatch');
  if (marketingEnd - marketingStart !== 0) throw new Error('marketing received ordinary competition money');
  if (battleState.pendingLeagueLamports !== 400_000 || tournamentState.pendingLeagueLamports !== 200_000) throw new Error('league pending bucket mismatch');
  console.log(`SUMMARY ${JSON.stringify({ initialize: init.signature, unpause: unpause.signature, battlePaymentA: depA.signature, tournamentPayment: tournamentPay.signature, config: config.toBase58(), battlePool: battlePool.toBase58(), tournamentPool: tournamentPool.toBase58() })}`);
}
(async () => {
  const mode = process.argv[2];
  if (mode === 'preflight') return preflight();
  if (mode === 'execute') return execute();
  throw new Error('usage: preflight|execute');
})().catch(e => { console.error(e?.stack || e); process.exit(1); });
