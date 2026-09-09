import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

const { AnchorProvider, BN, Program, setProvider } = anchor;

import { pool } from "../../frontend/server/db.js";
import { buildWalletActionMessage } from "../../frontend/api/lib/walletActionAuth.js";
import {
  normalTournamentEntitlementIdentity,
  verifyNormalTournamentClaim,
} from "../../frontend/api/lib/normalTournamentClaimRecovery.js";
import {
  rewardClaimIntent,
  rewardClaimRecord,
} from "../../frontend/api/dev-fix/reward-claim-intent.js";

const CHAIN_ID = 102;
const ENTRY = 1_000_000_000n;
const PRIZE = 750_000_000n;
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
let provider;
let program;
let configPda;
let sequence = 0;

function uuid() { return crypto.randomUUID(); }
function competitionHex(bytes) { return `0x${Buffer.from(bytes).toString("hex")}`; }
function response() { return { statusCode: 200, payload: null, status(code){this.statusCode=code;return this;}, json(v){this.payload=v;return v;}, setHeader(){}, end(){} }; }
async function call(handler, body) { const res=response(); await handler({method:"POST",body,headers:{}},res); return res; }

async function resetSchema() {
  await pool.query(`drop table if exists public.reward_audit_logs,public.reward_batch_items,public.reward_batches,public.reward_ledger,public.auth_nonces cascade`);
  await pool.query(`create table public.auth_nonces(chain_id integer not null,address text not null,nonce text not null,used_at timestamptz,expires_at timestamptz not null,primary key(chain_id,address,nonce))`);
  await pool.query(`create table public.reward_ledger(id uuid primary key,reward_type text not null,source_id text,source_label text,wallet_address text not null,user_id text,chain text not null,token_symbol text not null,amount numeric(78,0) not null,amount_usd numeric(20,6),status text not null,claim_batch_id text,claim_tx_hash text,claim_error text,metadata jsonb not null default '{}'::jsonb,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),claimable_at timestamptz,claimed_at timestamptz,expires_at timestamptz)`);
  await pool.query(`create table public.reward_batches(id uuid primary key,reward_type text not null,chain text not null,token_symbol text not null,status text not null,total_amount numeric(78,0) not null default 0,recipient_count integer not null default 0,claimable_count integer not null default 0,claimed_count integer not null default 0,failed_count integer not null default 0,source text,metadata jsonb not null default '{}'::jsonb,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),published_at timestamptz,closed_at timestamptz)`);
  await pool.query(`create table public.reward_batch_items(id uuid primary key,batch_id uuid not null references public.reward_batches(id),reward_ledger_id uuid references public.reward_ledger(id),wallet_address text not null,amount numeric(78,0) not null,status text not null,metadata jsonb not null default '{}'::jsonb,created_at timestamptz not null default now())`);
  await pool.query(`create table public.reward_audit_logs(id uuid primary key default gen_random_uuid(),batch_id uuid,reward_ledger_id uuid,actor_type text not null,actor_id text,action text not null,old_value text,new_value text,reason text,tx_hash text,metadata jsonb not null default '{}'::jsonb,created_at timestamptz not null default now())`);
}

async function fund(keypair, lamports=4_000_000_000) {
  const sig=await provider.connection.requestAirdrop(keypair.publicKey,lamports);
  await provider.connection.confirmTransaction(sig,"confirmed");
}

async function setupTournament({status="claimable",recordedTx=null}={}) {
  sequence += 1;
  const competitionId=crypto.randomBytes(32);
  const winner=Keypair.generate();
  const asset=Keypair.generate().publicKey;
  await fund(winner);
  const [poolPda]=PublicKey.findProgramAddressSync([Buffer.from("arena_competition_v2"),competitionId],program.programId);
  const [receiptPda]=PublicKey.findProgramAddressSync([Buffer.from("arena_money_entry_v2"),competitionId,asset.toBuffer(),winner.publicKey.toBuffer()],program.programId);
  const now=Math.floor(Date.now()/1000);
  await program.methods.openCompetitionPoolV2(
    Array.from(competitionId),1,PublicKey.default,PublicKey.default,PublicKey.default,PublicKey.default,
    new BN(ENTRY.toString()),new BN(now-10),new BN(now+600),
  ).accounts({authority:provider.wallet.publicKey,config:configPda,pool:poolPda,systemProgram:SystemProgram.programId}).rpc();
  await program.methods.depositCompetitionEntryV2(Array.from(competitionId),asset)
    .accounts({entrant:winner.publicKey,config:configPda,pool:poolPda,receipt:receiptPda,systemProgram:SystemProgram.programId})
    .signers([winner]).rpc();
  await program.methods.resolveCompetitionPoolV2(Array.from(competitionId),asset,winner.publicKey)
    .accounts({resolver:provider.wallet.publicKey,config:configPda,pool:poolPda,winnerEntryReceipt:receiptPda}).rpc();

  const ledgerId=uuid(), dbBatchId=uuid(), wallet=winner.publicKey.toBase58();
  const metadata={competitionIdBytes32:competitionHex(competitionId),entitlementVersion:"normal-v1",arenaMoneyProgramId:program.programId.toBase58()};
  await pool.query(`insert into public.reward_batches(id,reward_type,chain,token_symbol,status,total_amount,recipient_count,claimable_count,source,metadata) values($1,'tournament','102','SOL','claim_open',$2,1,1,$3,$4::jsonb)`,[dbBatchId,PRIZE.toString(),`sol-tournament-${sequence}`,JSON.stringify(metadata)]);
  await pool.query(`insert into public.reward_ledger(id,reward_type,source_id,source_label,wallet_address,chain,token_symbol,amount,status,claim_tx_hash,metadata,claimable_at) values($1,'tournament',$2,'Normal Tournament prize',$3,'102','SOL',$4,$5,$6,$7::jsonb,now())`,[ledgerId,`sol-tournament-${sequence}`,wallet,PRIZE.toString(),status,recordedTx,JSON.stringify(metadata)]);
  await pool.query(`insert into public.reward_batch_items(id,batch_id,reward_ledger_id,wallet_address,amount,status,metadata) values($1,$2,$3,$4,$5,$6,$7::jsonb)`,[uuid(),dbBatchId,ledgerId,wallet,PRIZE.toString(),status,JSON.stringify(metadata)]);
  const row=(await pool.query(`select * from public.reward_ledger where id=$1::uuid`,[ledgerId])).rows[0];
  return {competitionId,winner,asset,poolPda,receiptPda,ledgerId,wallet,row};
}

function signMessage(keypair,message) {
  const key=crypto.createPrivateKey({key:Buffer.concat([PKCS8_PREFIX,Buffer.from(keypair.secretKey.subarray(0,32))]),format:"der",type:"pkcs8"});
  return crypto.sign(null,Buffer.from(message,"utf8"),key).toString("base64");
}

async function auth(t,action) {
  const nonce=`agent5-sol-${Date.now()}-${Math.random()}`;
  await pool.query(`insert into public.auth_nonces(chain_id,address,nonce,expires_at) values(102,$1,$2,now()+interval '10 minutes')`,[t.wallet,nonce]);
  const message=buildWalletActionMessage({action,walletAddress:t.wallet,chainId:102,nonce});
  return {action,walletAddress:t.wallet,address:t.wallet,chainId:102,nonce,message,signature:signMessage(t.winner,message),walletType:"solana"};
}

async function claimWinner(t) {
  return program.methods.claimCompetitionWinnerV2(Array.from(t.competitionId))
    .accounts({winner:t.winner.publicKey,pool:t.poolPda}).signers([t.winner]).rpc();
}

async function main() {
  await resetSchema();
  provider=AnchorProvider.env();setProvider(provider);
  const idl=JSON.parse(await fs.readFile("target/idl/mwz_rewards_treasury.json","utf8"));
  program=new Program(idl,provider);
  [configPda]=PublicKey.findProgramAddressSync([Buffer.from("arena_money_config_v2")],program.programId);
  await program.methods.initializeArenaMoneyV2(provider.wallet.publicKey,provider.wallet.publicKey,provider.wallet.publicKey)
    .accounts({authority:provider.wallet.publicKey,config:configPda,systemProgram:SystemProgram.programId}).rpc();
  await program.methods.setArenaMoneyV2Pause(false).accounts({authority:provider.wallet.publicKey,config:configPda}).rpc();

  const normal=await setupTournament();
  let signed=await auth(normal,"claim_intent");
  let res=await call(rewardClaimIntent,{walletAddress:normal.wallet,chainId:102,rewardLedgerIds:[normal.ledgerId],auth:signed});
  assert.equal(res.statusCode,202,JSON.stringify(res.payload));
  assert.equal(res.payload.claimIntent.calls.length,1);
  assert.equal(res.payload.claimIntent.calls[0].kind,"solana_tournament");
  assert.equal(res.payload.claimIntent.calls[0].mode,"solana_airdrop");
  assert.equal(res.payload.claimIntent.calls[0].tokenSymbol,"SOL");
  const normalSig=await claimWinner(normal);
  signed=await auth(normal,"claim_record");
  res=await call(rewardClaimRecord,{walletAddress:normal.wallet,chainId:102,rewardLedgerIds:[normal.ledgerId],txHash:normalSig,status:"claimed",auth:signed});
  assert.equal(res.statusCode,200,JSON.stringify(res.payload));
  signed=await auth(normal,"claim_intent");
  res=await call(rewardClaimIntent,{walletAddress:normal.wallet,chainId:102,rewardLedgerIds:[normal.ledgerId],auth:signed});
  assert.equal(res.statusCode,200);assert.equal(res.payload.claimIntent.calls.length,0);assert.equal(res.payload.idempotent,true);

  const crash=await setupTournament({status:"claim_pending"});
  const crashSig=await claimWinner(crash);
  signed=await auth(crash,"claim_intent");
  res=await call(rewardClaimIntent,{walletAddress:crash.wallet,chainId:102,rewardLedgerIds:[crash.ledgerId],auth:signed});
  assert.equal(res.statusCode,200,JSON.stringify(res.payload));assert.equal(res.payload.recovered,true);assert.equal(res.payload.claimIntent.calls.length,0);
  let row=(await pool.query(`select status,claim_tx_hash from public.reward_ledger where id=$1::uuid`,[crash.ledgerId])).rows[0];
  assert.equal(row.status,"claimed");assert.equal(row.claim_tx_hash,crashSig);

  const concurrent=await setupTournament({status:"claim_pending"});
  const concurrentSig=await claimWinner(concurrent);
  const [a1,a2]=await Promise.all([auth(concurrent,"claim_intent"),auth(concurrent,"claim_intent")]);
  const [r1,r2]=await Promise.all([
    call(rewardClaimIntent,{walletAddress:concurrent.wallet,chainId:102,rewardLedgerIds:[concurrent.ledgerId],auth:a1}),
    call(rewardClaimIntent,{walletAddress:concurrent.wallet,chainId:102,rewardLedgerIds:[concurrent.ledgerId],auth:a2}),
  ]);
  assert.equal(r1.statusCode,200,JSON.stringify(r1.payload));assert.equal(r2.statusCode,200,JSON.stringify(r2.payload));
  assert.equal(r1.payload.claimIntent.calls.length+r2.payload.claimIntent.calls.length,0);
  row=(await pool.query(`select status,claim_tx_hash from public.reward_ledger where id=$1::uuid`,[concurrent.ledgerId])).rows[0];
  assert.equal(row.status,"claimed");assert.equal(row.claim_tx_hash,concurrentSig);
  const audits=await pool.query(`select count(*)::int n from public.reward_audit_logs where reward_ledger_id=$1::uuid and action='tournament_claim_reconciled_onchain'`,[concurrent.ledgerId]);
  assert.equal(audits.rows[0].n,1);

  await assert.rejects(()=>claimWinner(concurrent));
  assert.throws(()=>normalTournamentEntitlementIdentity(concurrent.row,{requestedChainId:101,requestedWallet:concurrent.wallet}),(e)=>e?.code==="REWARD_CHAIN_MISMATCH");
  const other=Keypair.generate().publicKey.toBase58();
  assert.throws(()=>normalTournamentEntitlementIdentity(concurrent.row,{requestedChainId:102,requestedWallet:other}),(e)=>e?.code==="CLAIM_WALLET_MISMATCH");
  await assert.rejects(()=>verifyNormalTournamentClaim({row:{...concurrent.row,amount:(PRIZE+1n).toString()},txHash:concurrentSig,requestedChainId:102,requestedWallet:concurrent.wallet}),(e)=>e?.code==="CLAIM_AMOUNT_MISMATCH");
  const transfer=SystemProgram.transfer({fromPubkey:normal.winner.publicKey,toPubkey:provider.wallet.publicKey,lamports:1000});
  const badTx=await provider.sendAndConfirm(new (await import("@solana/web3.js")).Transaction().add(transfer),[normal.winner]);
  await assert.rejects(()=>verifyNormalTournamentClaim({row:normal.row,txHash:badTx,requestedChainId:102,requestedWallet:normal.wallet}));

  const immutable=await setupTournament({status:"claim_pending",recordedTx:"1".repeat(64)});
  await claimWinner(immutable);
  signed=await auth(immutable,"claim_intent");
  res=await call(rewardClaimIntent,{walletAddress:immutable.wallet,chainId:102,rewardLedgerIds:[immutable.ledgerId],auth:signed});
  assert.equal(res.statusCode,409,JSON.stringify(res.payload));assert.equal(res.payload.code,"CLAIM_ALREADY_RECORDED");

  console.log("SOLANA_NORMAL_TOURNAMENT_MATRIX=PASS");
  console.log(JSON.stringify({normalSig,crashSig,concurrentSig,chainId:102,asset:"SOL",programId:program.programId.toBase58()}));
  await pool.end();
}

main().catch(async(error)=>{console.error(error);try{await pool.end();}catch{}process.exit(1);});
