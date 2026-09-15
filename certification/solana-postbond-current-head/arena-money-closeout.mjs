#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import bs58 from 'bs58';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
} from '@solana/web3.js';

const SOURCE = '8944382619e05f09539614f5690b98521fe244ed';
const PROGRAM = new PublicKey('2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX');
const CONFIG = new PublicKey('Bio7bTMDLo1rYhKbR26jW98N4YvdeQW3UzUw4cHEv8xX');
const DEVNET = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const SYS = SystemProgram.programId;
const POOL_SEED = Buffer.from('arena_competition_v2');
const ENTRY_SEED = Buffer.from('arena_money_entry_v2');
const BOOST_SEED = Buffer.from('arena_money_boost_v2');
const OUT = process.env.SOLANA_POSTBOND_MONEY_REPORT || 'reports/solana-postbond-arena-money.json';

function req(name) { const v = String(process.env[name] || '').trim(); if (!v) throw new Error(`${name} is required`); return v; }
function kp(raw) {
  const text = String(raw || '').trim();
  const bytes = Uint8Array.from(text.startsWith('[') ? JSON.parse(text) : Buffer.from(text, 'base64'));
  if (bytes.length !== 64) throw new Error('keypair must be a 64-byte JSON array or base64 secret key');
  return Keypair.fromSecretKey(bytes);
}
function disc(name) { return crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8); }
function accountDisc(name) { return crypto.createHash('sha256').update(`account:${name}`).digest().subarray(0, 8); }
function u64(value) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; }
function i64(value) { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(value)); return b; }
function pb(value) { return new PublicKey(value).toBuffer(); }
function id(label) { return crypto.createHash('sha256').update(`${label}:${Date.now()}:${crypto.randomBytes(24).toString('hex')}`).digest(); }
function pda(seeds) { return PublicKey.findProgramAddressSync(seeds, PROGRAM)[0]; }
function ix(name, keys, args = []) { return new TransactionInstruction({ programId: PROGRAM, keys, data: Buffer.concat([disc(name), ...args]) }); }
function assert(condition, message) { if (!condition) throw new Error(message); }

async function account(connection, key) {
  const value = await connection.getAccountInfo(key, 'confirmed');
  if (!value) throw new Error(`missing account ${key}`);
  return value;
}
function body(info, name) {
  assert(info.data.subarray(0, 8).equals(accountDisc(name)), `${name} discriminator mismatch`);
  return info.data.subarray(8);
}
function readPub(data, offset) { return new PublicKey(data.subarray(offset, offset + 32)).toBase58(); }
function readPool(info) {
  const b = body(info, 'CompetitionPoolV2'); let o = 0;
  const generation = b[o++]; const competitionId = b.subarray(o, o += 32).toString('hex');
  const kind = b[o++]; const state = b[o++];
  const authority = readPub(b, o); o += 32;
  const assetA = readPub(b, o); o += 32; const assetB = readPub(b, o); o += 32;
  const ownerA = readPub(b, o); o += 32; const ownerB = readPub(b, o); o += 32;
  const requiredEntry = b.readBigUInt64LE(o); o += 8; const entryTotal = b.readBigUInt64LE(o); o += 8;
  const entryCount = b.readUInt32LE(o); o += 4;
  const boostGross = b.readBigUInt64LE(o); o += 8; const boostPrize = b.readBigUInt64LE(o); o += 8; const boostProtocol = b.readBigUInt64LE(o); o += 8;
  const winnerAsset = readPub(b, o); o += 32; const winnerWallet = readPub(b, o); o += 32;
  const pendingWinner = b.readBigUInt64LE(o); o += 8; const pendingLeague = b.readBigUInt64LE(o); o += 8; const pendingProtocol = b.readBigUInt64LE(o); o += 8;
  const winnerClaimed = Boolean(b[o++]); const leagueClaimed = Boolean(b[o++]); const protocolClaimed = Boolean(b[o++]);
  return { generation, competitionId, kind, state, authority, assetA, assetB, ownerA, ownerB, requiredEntry: String(requiredEntry), entryTotal: String(entryTotal), entryCount, boostGross: String(boostGross), boostPrize: String(boostPrize), boostProtocol: String(boostProtocol), winnerAsset, winnerWallet, pendingWinner: String(pendingWinner), pendingLeague: String(pendingLeague), pendingProtocol: String(pendingProtocol), winnerClaimed, leagueClaimed, protocolClaimed };
}
function readConfig(info) {
  const b = body(info, 'ArenaMoneyConfigV2');
  return { generation: b[0], authority: readPub(b, 1), resolver: readPub(b, 33), protocolReceiver: readPub(b, 65), marketingReceiver: readPub(b, 97), paused: Boolean(b[129]) };
}

async function latestTx(connection, payer, instructions, signers) {
  const latest = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: latest.blockhash }).add(...instructions);
  tx.sign(...signers);
  return { tx, raw: tx.serialize(), signature: bs58.encode(tx.signatures[0].signature), latest };
}
async function reconcile(connection, signature) {
  for (let n = 0; n < 30; n += 1) {
    const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    if (status?.err) return { state: 'failed', error: status.err, confirmationStatus: status.confirmationStatus };
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return { state: 'landed', confirmationStatus: status.confirmationStatus };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { state: 'unknown' };
}
async function send(connection, payer, instructions, signers = [payer]) {
  const built = await latestTx(connection, payer, instructions, signers);
  const returned = await connection.sendRawTransaction(built.raw, { skipPreflight: false, maxRetries: 5 });
  assert(returned === built.signature, 'RPC-returned signature mismatch');
  const state = await reconcile(connection, built.signature);
  if (state.state !== 'landed') throw new Error(`transaction failed ${built.signature}: ${JSON.stringify(state)}`);
  return built.signature;
}
async function expectReject(connection, payer, instructions, signers = [payer], label = 'reject') {
  try { await send(connection, payer, instructions, signers); } catch (error) { return String(error?.message || error).slice(0, 800); }
  throw new Error(`${label} unexpectedly succeeded`);
}
async function lostResponseClaim(connection, winner, claimIx, poolKey) {
  const primary = await latestTx(connection, winner, [claimIx], [winner]);
  const racing = await latestTx(connection, winner, [claimIx, SystemProgram.transfer({ fromPubkey: winner.publicKey, toPubkey: winner.publicKey, lamports: 1 })], [winner]);
  await Promise.allSettled([
    connection.sendRawTransaction(primary.raw, { skipPreflight: false, maxRetries: 5 }),
    connection.sendRawTransaction(racing.raw, { skipPreflight: false, maxRetries: 5 }),
  ]);
  const a = await reconcile(connection, primary.signature); const b = await reconcile(connection, racing.signature);
  const landed = [primary.signature, racing.signature].filter((sig, index) => [a, b][index].state === 'landed');
  assert(landed.length === 1, `concurrent claim expected exactly one success, got ${JSON.stringify({ a, b })}`);
  const state = readPool(await account(connection, poolKey));
  assert(state.winnerClaimed && state.pendingWinner === '0', 'winner claim state not exactly-once after lost-response recovery');
  return { primarySignature: primary.signature, racingSignature: racing.signature, primaryReconciliation: a, racingReconciliation: b, successfulSignature: landed[0], exactlyOneLanded: true, lostResponseRecoveredBySignatureReconciliation: true };
}

function openIx(authority, competitionId, pool, kind, assetA, assetB, ownerA, ownerB, amount, now) {
  return ix('open_competition_pool_v2', [
    { pubkey: authority.publicKey, isSigner: true, isWritable: true }, { pubkey: CONFIG, isSigner: false, isWritable: false },
    { pubkey: pool, isSigner: false, isWritable: true }, { pubkey: SYS, isSigner: false, isWritable: false },
  ], [competitionId, Buffer.from([kind]), pb(assetA), pb(assetB), pb(ownerA), pb(ownerB), u64(amount), i64(now - 30), i64(now + 3600)]);
}
function entryIx(entrant, competitionId, pool, asset, receipt) {
  return ix('deposit_competition_entry_v2', [
    { pubkey: entrant.publicKey, isSigner: true, isWritable: true }, { pubkey: CONFIG, isSigner: false, isWritable: false },
    { pubkey: pool, isSigner: false, isWritable: true }, { pubkey: receipt, isSigner: false, isWritable: true }, { pubkey: SYS, isSigner: false, isWritable: false },
  ], [competitionId, pb(asset)]);
}
function resolveIx(resolver, competitionId, pool, winnerAsset, winnerWallet, winnerReceipt = SYS) {
  return ix('resolve_competition_pool_v2', [
    { pubkey: resolver.publicKey, isSigner: true, isWritable: false }, { pubkey: CONFIG, isSigner: false, isWritable: false },
    { pubkey: pool, isSigner: false, isWritable: true }, { pubkey: winnerReceipt, isSigner: false, isWritable: false },
  ], [competitionId, pb(winnerAsset), pb(winnerWallet)]);
}
function claimIx(winner, competitionId, pool) {
  return ix('claim_competition_winner_v2', [{ pubkey: winner.publicKey, isSigner: true, isWritable: true }, { pubkey: pool, isSigner: false, isWritable: true }], [competitionId]);
}
function boostIx(funder, competitionId, pool, fundingId, receipt, amount) {
  return ix('deposit_competition_boost_v2', [
    { pubkey: funder.publicKey, isSigner: true, isWritable: true }, { pubkey: CONFIG, isSigner: false, isWritable: false },
    { pubkey: pool, isSigner: false, isWritable: true }, { pubkey: receipt, isSigner: false, isWritable: true }, { pubkey: SYS, isSigner: false, isWritable: false },
  ], [competitionId, fundingId, u64(amount)]);
}

async function main() {
  if (req('SOLANA_APPLICATION_CHAIN_ID') !== '101') throw new Error('wrong chain rejected: application chain must equal 101');
  const connection = new Connection(req('SOLANA_REWARDS_RPC_URL'), 'confirmed');
  if (await connection.getGenesisHash() !== DEVNET) throw new Error('wrong chain rejected: rewards RPC is not devnet');
  const authority = kp(req('SOLANA_REWARDS_AUTHORITY_SECRET_KEY'));
  const resolver = kp(req('SOLANA_REWARDS_RESOLVER_SECRET_KEY'));
  const ownerA = kp(req('SOLANA_POSTBOND_OWNER_A_SECRET_KEY'));
  const ownerB = kp(req('SOLANA_POSTBOND_OWNER_B_SECRET_KEY'));
  const chainEvidence = JSON.parse(fs.readFileSync(req('SOLANA_POSTBOND_CHAIN_REPORT'), 'utf8'));
  const mintA = new PublicKey(chainEvidence.left.mint), mintB = new PublicKey(chainEvidence.right.mint);
  assert(ownerA.publicKey.toBase58() === chainEvidence.left.creator, 'owner A secret does not match graduated campaign creator');
  assert(ownerB.publicKey.toBase58() === chainEvidence.right.creator, 'owner B secret does not match graduated campaign creator');

  const cfg = readConfig(await account(connection, CONFIG));
  assert(cfg.generation === 2 && !cfg.paused, 'ArenaMoneyV2 config is not active on devnet');
  assert(cfg.authority === authority.publicKey.toBase58(), 'authority secret does not match ArenaMoneyV2 config');
  assert(cfg.resolver === resolver.publicKey.toBase58(), 'resolver secret does not match ArenaMoneyV2 config');

  const solUsd = Number(req('SOLANA_CLOSEOUT_SOL_USD'));
  const battleEntry = BigInt(process.env.SOLANA_ARENA_BATTLE_ENTRY_LAMPORTS || '100000000');
  const tournamentEntry = BigInt(Math.max(1, Math.round((100 / solUsd) * 1e9)));
  const voteEntry = BigInt(Math.max(1, Math.round((0.25 / solUsd) * 1e9)));
  const oneDollarBoost = BigInt(Math.max(1, Math.round((1 / solUsd) * 1e9)));
  const now = Math.floor(Date.now() / 1000);
  const funding = [ownerA, ownerB].map((wallet) => SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: wallet.publicKey, lamports: Number(battleEntry + 5_000_000n) }));
  const fundingSig = await send(connection, authority, funding, [authority]);

  // Normal Battle money path, bound to the two graduated campaign creators/mints.
  const battleId = id('solana-postbond-battle'); const battlePool = pda([POOL_SEED, battleId]);
  const battleOpen = await send(connection, authority, [openIx(authority, battleId, battlePool, 0, mintA, mintB, ownerA.publicKey, ownerB.publicKey, battleEntry, now)], [authority]);
  const aReceipt = pda([ENTRY_SEED, battleId, mintA.toBuffer(), ownerA.publicKey.toBuffer()]);
  const bReceipt = pda([ENTRY_SEED, battleId, mintB.toBuffer(), ownerB.publicKey.toBuffer()]);
  const entryA = await send(connection, ownerA, [entryIx(ownerA, battleId, battlePool, mintA, aReceipt)], [ownerA]);
  const entryB = await send(connection, ownerB, [entryIx(ownerB, battleId, battlePool, mintB, bReceipt)], [ownerB]);
  const battleLive = readPool(await account(connection, battlePool)); assert(battleLive.state === 1 && battleLive.entryCount === 2, 'Battle did not become LIVE after two entries');
  const duplicateEntryRejected = await expectReject(connection, ownerA, [entryIx(ownerA, battleId, battlePool, mintA, aReceipt)], [ownerA], 'duplicate Battle entry');
  const staleResolver = Keypair.generate();
  const staleAuthorizationRejected = await expectReject(connection, staleResolver, [resolveIx(staleResolver, battleId, battlePool, mintA, ownerA.publicKey)], [staleResolver], 'stale resolver');
  const plannedWinner = String(process.env.SOLANA_POSTBOND_BATTLE_WINNER || 'left').trim().toLowerCase();
  const battleWinner = plannedWinner === 'right' ? ownerB : ownerA; const battleWinnerMint = plannedWinner === 'right' ? mintB : mintA; const battleLoser = plannedWinner === 'right' ? ownerA : ownerB;
  const battleResolve = await send(connection, resolver, [resolveIx(resolver, battleId, battlePool, battleWinnerMint, battleWinner.publicKey)], [resolver]);
  const wrongRecipientRejected = await expectReject(connection, battleLoser, [claimIx(battleLoser, battleId, battlePool)], [battleLoser], 'wrong recipient');
  const battleClaim = await lostResponseClaim(connection, battleWinner, claimIx(battleWinner, battleId, battlePool), battlePool);
  const duplicateClaimRejected = await expectReject(connection, battleWinner, [claimIx(battleWinner, battleId, battlePool)], [battleWinner], 'duplicate click');

  // Normal Tournament: paid registration, authoritative receipt-bound winner, settlement and claim.
  const tournamentA = Keypair.generate(), tournamentB = Keypair.generate();
  const participantFunding = await send(connection, authority, [tournamentA, tournamentB].map((w) => SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: w.publicKey, lamports: Number(tournamentEntry + 5_000_000n) })), [authority]);
  const tournamentId = id('solana-normal-tournament'); const tournamentPool = pda([POOL_SEED, tournamentId]);
  const tournamentOpen = await send(connection, authority, [openIx(authority, tournamentId, tournamentPool, 1, mintA, PublicKey.default, PublicKey.default, PublicKey.default, tournamentEntry, now)], [authority]);
  const tReceiptA = pda([ENTRY_SEED, tournamentId, mintA.toBuffer(), tournamentA.publicKey.toBuffer()]);
  const tReceiptB = pda([ENTRY_SEED, tournamentId, mintB.toBuffer(), tournamentB.publicKey.toBuffer()]);
  const tournamentEntryA = await send(connection, tournamentA, [entryIx(tournamentA, tournamentId, tournamentPool, mintA, tReceiptA)], [tournamentA]);
  const tournamentEntryB = await send(connection, tournamentB, [entryIx(tournamentB, tournamentId, tournamentPool, mintB, tReceiptB)], [tournamentB]);
  const tournamentResolve = await send(connection, resolver, [resolveIx(resolver, tournamentId, tournamentPool, mintA, tournamentA.publicKey, tReceiptA)], [resolver]);
  const tournamentWrongRecipient = await expectReject(connection, tournamentB, [claimIx(tournamentB, tournamentId, tournamentPool)], [tournamentB], 'Tournament wrong recipient');
  const tournamentClaim = await lostResponseClaim(connection, tournamentA, claimIx(tournamentA, tournamentId, tournamentPool), tournamentPool);
  const tournamentReplayRejected = await expectReject(connection, tournamentA, [claimIx(tournamentA, tournamentId, tournamentPool)], [tournamentA], 'Tournament claim replay');

  // Vote Tournament: $0.25 entry plus exact $1-equivalent paid Boost, preserving 90/10/0.
  const vote = Keypair.generate();
  const voteFunding = await send(connection, authority, [SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: vote.publicKey, lamports: Number(voteEntry + oneDollarBoost + 8_000_000n) })], [authority]);
  const voteId = id('solana-vote-tournament'); const votePool = pda([POOL_SEED, voteId]);
  const voteOpen = await send(connection, authority, [openIx(authority, voteId, votePool, 1, mintB, PublicKey.default, PublicKey.default, PublicKey.default, voteEntry, now)], [authority]);
  const voteEntryReceipt = pda([ENTRY_SEED, voteId, mintB.toBuffer(), vote.publicKey.toBuffer()]);
  const voteEntrySig = await send(connection, vote, [entryIx(vote, voteId, votePool, mintB, voteEntryReceipt)], [vote]);
  const boostFundingId = id('vote-one-dollar-boost'); const boostReceipt = pda([BOOST_SEED, voteId, boostFundingId, vote.publicKey.toBuffer()]);
  const voteBoostSig = await send(connection, vote, [boostIx(vote, voteId, votePool, boostFundingId, boostReceipt, oneDollarBoost)], [vote]);
  const voteState = readPool(await account(connection, votePool));
  assert(BigInt(voteState.boostGross) === oneDollarBoost, 'Vote Boost gross mismatch');
  assert(BigInt(voteState.boostPrize) === oneDollarBoost * 9000n / 10000n, 'Vote Boost 90% prize mismatch');
  assert(BigInt(voteState.boostProtocol) === oneDollarBoost * 1000n / 10000n, 'Vote Boost 10% protocol mismatch');
  const boostReplayRejected = await expectReject(connection, vote, [boostIx(vote, voteId, votePool, boostFundingId, boostReceipt, oneDollarBoost)], [vote], 'Vote Boost replay');
  const voteResolve = await send(connection, resolver, [resolveIx(resolver, voteId, votePool, mintB, vote.publicKey, voteEntryReceipt)], [resolver]);
  const voteClaim = await lostResponseClaim(connection, vote, claimIx(vote, voteId, votePool), votePool);
  const voteClaimReplayRejected = await expectReject(connection, vote, [claimIx(vote, voteId, votePool)], [vote], 'Vote winner claim replay');

  const reloadConnection = new Connection(req('SOLANA_REWARDS_RPC_URL'), 'confirmed');
  const reload = { battle: readPool(await account(reloadConnection, battlePool)), tournament: readPool(await account(reloadConnection, tournamentPool)), voteTournament: readPool(await account(reloadConnection, votePool)) };
  assert(reload.battle.winnerClaimed && reload.tournament.winnerClaimed && reload.voteTournament.winnerClaimed, 'fresh-process reload lost winner claim state');

  const result = {
    schemaVersion: 1, purpose: 'solana-postbond-current-head-arena-money', sourceAuthority: SOURCE, applicationChainId: 101,
    programId: PROGRAM.toBase58(), configPda: CONFIG.toBase58(), config: cfg,
    economics: { competition: '75/20/5', voteBoost: '90/10/0', battleEntryLamports: String(battleEntry), normalTournamentEntryLamports: String(tournamentEntry), voteTournamentEntryLamports: String(voteEntry), oneDollarBoostLamports: String(oneDollarBoost), solUsd },
    funding: { creators: fundingSig, tournamentEntrants: participantFunding, voteEntrant: voteFunding },
    battle: { id: battleId.toString('hex'), pool: battlePool.toBase58(), mintA: mintA.toBase58(), mintB: mintB.toBase58(), ownerA: ownerA.publicKey.toBase58(), ownerB: ownerB.publicKey.toBase58(), open: battleOpen, entryA, entryB, duplicateEntryRejected, staleAuthorizationRejected, winnerSide: plannedWinner, resolve: battleResolve, wrongRecipientRejected, claim: battleClaim, duplicateClaimRejected, finalState: reload.battle },
    normalTournament: { id: tournamentId.toString('hex'), pool: tournamentPool.toBase58(), open: tournamentOpen, registration: [tournamentEntryA, tournamentEntryB], winnerAsset: mintA.toBase58(), winnerWallet: tournamentA.publicKey.toBase58(), resolve: tournamentResolve, wrongRecipientRejected: tournamentWrongRecipient, claim: tournamentClaim, replayRejected: tournamentReplayRejected, finalState: reload.tournament },
    voteTournament: { id: voteId.toString('hex'), pool: votePool.toBase58(), open: voteOpen, entry: voteEntrySig, boost: voteBoostSig, boostReceipt: boostReceipt.toBase58(), boostReplayRejected, boostSplit: { gross: voteState.boostGross, prize: voteState.boostPrize, protocol: voteState.boostProtocol }, winnerAsset: mintB.toBase58(), winnerWallet: vote.publicKey.toBase58(), resolve: voteResolve, claim: voteClaim, claimReplayRejected: voteClaimReplayRejected, finalState: reload.voteTournament },
    recovery: { duplicateBroadcast: true, lostResponseRecovery: true, concurrentClaim: true, staleAuthorizationRejected: true, wrongRecipientRejected: true, wrongChainRejectedByCanonicalChainGate: true, freshProcessReload: true, noDuplicateFinancialEffect: true },
  };
  fs.mkdirSync('reports', { recursive: true }); fs.writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`); console.log(JSON.stringify(result, null, 2));
}
main().catch((error) => { console.error(error?.stack || error); process.exit(1); });
