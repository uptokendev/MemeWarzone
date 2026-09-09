import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { AbiCoder, ContractFactory, JsonRpcProvider, keccak256, randomBytes, hexlify } from "ethers";

import { pool } from "../../server/db.js";
import { buildWalletActionMessage } from "./walletActionAuth.js";
import {
  normalTournamentEntitlementIdentity,
  verifyNormalTournamentClaim,
} from "./normalTournamentClaimRecovery.js";
import { rewardClaimIntent, rewardClaimRecord } from "../dev-fix/reward-claim-intent.js";

const coder = AbiCoder.defaultAbiCoder();
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const CASES = [
  { label: "BNB", chainId: 97, rpc: "http://127.0.0.1:8545", symbol: "BNB" },
  { label: "Robinhood", chainId: 46630, rpc: "http://127.0.0.1:9545", symbol: "ETH" },
];
let artifact;
let sequence = 0;

function bytes32() { return hexlify(randomBytes(32)); }
function uuid() {
  const h = Buffer.from(randomBytes(16)).toString("hex");
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
function leafFor(account, amount) {
  const inner = keccak256(coder.encode(["address", "uint256"], [account, BigInt(amount)]));
  return keccak256(inner);
}

async function resetSchema() {
  await pool.query(`drop table if exists public.reward_audit_logs,public.reward_batch_items,public.reward_batches,public.reward_ledger,public.auth_nonces cascade`);
  await pool.query(`create table public.auth_nonces(chain_id integer not null,address text not null,nonce text not null,used_at timestamptz,expires_at timestamptz not null,primary key(chain_id,address,nonce))`);
  await pool.query(`create table public.reward_ledger(id uuid primary key,reward_type text not null,source_id text,source_label text,wallet_address text not null,user_id text,chain text not null,token_symbol text not null,amount numeric(78,0) not null,amount_usd numeric(20,6),status text not null,claim_batch_id text,claim_tx_hash text,claim_error text,metadata jsonb not null default '{}'::jsonb,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),claimable_at timestamptz,claimed_at timestamptz,expires_at timestamptz)`);
  await pool.query(`create table public.reward_batches(id uuid primary key,reward_type text not null,chain text not null,token_symbol text not null,status text not null,total_amount numeric(78,0) not null default 0,recipient_count integer not null default 0,claimable_count integer not null default 0,claimed_count integer not null default 0,failed_count integer not null default 0,source text,metadata jsonb not null default '{}'::jsonb,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),published_at timestamptz,closed_at timestamptz)`);
  await pool.query(`create table public.reward_batch_items(id uuid primary key,batch_id uuid not null references public.reward_batches(id),reward_ledger_id uuid references public.reward_ledger(id),wallet_address text not null,amount numeric(78,0) not null,status text not null,metadata jsonb not null default '{}'::jsonb,created_at timestamptz not null default now())`);
  await pool.query(`create table public.reward_audit_logs(id uuid primary key default gen_random_uuid(),batch_id uuid,reward_ledger_id uuid,actor_type text not null,actor_id text,action text not null,old_value text,new_value text,reason text,tx_hash text,metadata jsonb not null default '{}'::jsonb,created_at timestamptz not null default now())`);
}

async function context(spec) {
  const provider = new JsonRpcProvider(spec.rpc, spec.chainId, { staticNetwork: true });
  const owner = await provider.getSigner(0);
  const user = await provider.getSigner(1);
  const other = await provider.getSigner(2);
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, owner);
  const distributor = await factory.deploy(await owner.getAddress());
  await distributor.waitForDeployment();
  return { ...spec, provider, owner, user, other, distributor, distributorAddress: await distributor.getAddress() };
}

async function entitlement(ctx, { status="claimable", recordedTx=null, amount=1000000000000000n }={}) {
  sequence += 1;
  const wallet = (await ctx.user.getAddress()).toLowerCase();
  const contractBatchId = bytes32();
  const root = leafFor(await ctx.user.getAddress(), amount);
  const latest = await ctx.provider.getBlock("latest");
  await (await ctx.distributor.connect(ctx.owner).authorizeBatch(contractBatchId, amount, 0, BigInt(latest.timestamp + 3600))).wait();
  await (await ctx.distributor.connect(ctx.owner).createBatch(contractBatchId, root, BigInt(latest.timestamp + 7200), { value: amount })).wait();
  const ledgerId=uuid(), dbBatchId=uuid();
  const metadata={contractBatchId,merkleRoot:root,merkleProof:[],distributorAddress:ctx.distributorAddress,entitlementVersion:"normal-v1"};
  await pool.query(`insert into public.reward_batches(id,reward_type,chain,token_symbol,status,total_amount,recipient_count,claimable_count,source,metadata) values($1,'tournament',$2,$3,'claim_open',$4,1,1,$5,$6::jsonb)`,[dbBatchId,String(ctx.chainId),ctx.symbol,String(amount),`tournament-${sequence}`,JSON.stringify(metadata)]);
  await pool.query(`insert into public.reward_ledger(id,reward_type,source_id,source_label,wallet_address,chain,token_symbol,amount,status,claim_tx_hash,metadata,claimable_at) values($1,'tournament',$2,'Normal Tournament prize',$3,$4,$5,$6,$7,$8,$9::jsonb,now())`,[ledgerId,`tournament-${sequence}`,wallet,String(ctx.chainId),ctx.symbol,String(amount),status,recordedTx,JSON.stringify(metadata)]);
  await pool.query(`insert into public.reward_batch_items(id,batch_id,reward_ledger_id,wallet_address,amount,status,metadata) values($1,$2,$3,$4,$5,$6,$7::jsonb)`,[uuid(),dbBatchId,ledgerId,wallet,String(amount),status,JSON.stringify(metadata)]);
  const row=(await pool.query(`select * from public.reward_ledger where id=$1::uuid`,[ledgerId])).rows[0];
  return { ledgerId, wallet, row, contractBatchId, amount };
}

async function auth(ctx,wallet,action) {
  const nonce=`agent5-tournament-${Date.now()}-${Math.random()}`;
  await pool.query(`insert into public.auth_nonces(chain_id,address,nonce,expires_at) values($1,$2,$3,now()+interval '10 minutes')`,[ctx.chainId,wallet,nonce]);
  const message=buildWalletActionMessage({action,walletAddress:wallet,chainId:ctx.chainId,nonce});
  return {action,walletAddress:wallet,address:wallet,chainId:ctx.chainId,nonce,message,signature:await ctx.user.signMessage(message)};
}
function response(){return{statusCode:200,payload:null,status(code){this.statusCode=code;return this;},json(v){this.payload=v;return v;},setHeader(){},end(){}}}
async function call(handler,body){const res=response();await handler({method:"POST",body,headers:{}},res);return res;}
async function claim(ctx,b){const tx=await ctx.distributor.connect(ctx.user).claim(b.contractBatchId,b.amount,[]);await tx.wait();return tx;}

before(async()=>{
  await resetSchema();
  artifact=JSON.parse(await fs.readFile(path.join(repoRoot,".agent5-artifacts/contracts/RewardDistributor.sol/RewardDistributor.json"),"utf8"));
});
after(async()=>{await pool.end();});

for (const spec of CASES) {
  test(`${spec.label}: full exactly-once Tournament matrix`, async()=>{
    const ctx=await context(spec);

    const normal=await entitlement(ctx);
    let a=await auth(ctx,normal.wallet,"claim_intent");
    let res=await call(rewardClaimIntent,{walletAddress:normal.wallet,chainId:ctx.chainId,rewardLedgerIds:[normal.ledgerId],auth:a});
    assert.equal(res.statusCode,202,JSON.stringify(res.payload));
    assert.equal(res.payload.claimIntent.calls.length,1);
    assert.equal(res.payload.claimIntent.calls[0].tokenSymbol,ctx.symbol);
    const normalTx=await claim(ctx,normal);
    a=await auth(ctx,normal.wallet,"claim_record");
    res=await call(rewardClaimRecord,{walletAddress:normal.wallet,chainId:ctx.chainId,rewardLedgerIds:[normal.ledgerId],txHash:normalTx.hash,status:"claimed",auth:a});
    assert.equal(res.statusCode,200,JSON.stringify(res.payload));

    const totalAfterFirst = (await ctx.distributor.batches(normal.contractBatchId)).totalClaimed;
    await assert.rejects(() => ctx.distributor.connect(ctx.user).claim(normal.contractBatchId,normal.amount,[]));
    assert.equal((await ctx.distributor.batches(normal.contractBatchId)).totalClaimed,totalAfterFirst);

    a=await auth(ctx,normal.wallet,"claim_intent");
    res=await call(rewardClaimIntent,{walletAddress:normal.wallet,chainId:ctx.chainId,rewardLedgerIds:[normal.ledgerId],auth:a});
    assert.equal(res.statusCode,200,JSON.stringify(res.payload));
    assert.equal(res.payload.claimIntent.calls.length,0);
    assert.equal(res.payload.idempotent,true);

    const crash=await entitlement(ctx,{status:"claim_pending"});
    const crashTx=await claim(ctx,crash);
    a=await auth(ctx,crash.wallet,"claim_intent");
    res=await call(rewardClaimIntent,{walletAddress:crash.wallet,chainId:ctx.chainId,rewardLedgerIds:[crash.ledgerId],auth:a});
    assert.equal(res.statusCode,200,JSON.stringify(res.payload));
    assert.equal(res.payload.recovered,true);
    assert.equal(res.payload.claimIntent.calls.length,0);
    let row=(await pool.query(`select status,claim_tx_hash from public.reward_ledger where id=$1::uuid`,[crash.ledgerId])).rows[0];
    assert.equal(row.status,"claimed");assert.equal(row.claim_tx_hash.toLowerCase(),crashTx.hash.toLowerCase());

    const concurrent=await entitlement(ctx,{status:"claim_pending"});
    const concurrentTx=await claim(ctx,concurrent);
    const [authA,authB]=await Promise.all([auth(ctx,concurrent.wallet,"claim_intent"),auth(ctx,concurrent.wallet,"claim_intent")]);
    const [ra,rb]=await Promise.all([
      call(rewardClaimIntent,{walletAddress:concurrent.wallet,chainId:ctx.chainId,rewardLedgerIds:[concurrent.ledgerId],auth:authA}),
      call(rewardClaimIntent,{walletAddress:concurrent.wallet,chainId:ctx.chainId,rewardLedgerIds:[concurrent.ledgerId],auth:authB}),
    ]);
    assert.equal(ra.statusCode,200,JSON.stringify(ra.payload));assert.equal(rb.statusCode,200,JSON.stringify(rb.payload));
    assert.equal(ra.payload.claimIntent.calls.length+rb.payload.claimIntent.calls.length,0);
    row=(await pool.query(`select status,claim_tx_hash from public.reward_ledger where id=$1::uuid`,[concurrent.ledgerId])).rows[0];
    assert.equal(row.status,"claimed");assert.equal(row.claim_tx_hash.toLowerCase(),concurrentTx.hash.toLowerCase());
    const audits=await pool.query(`select count(*)::int n from public.reward_audit_logs where reward_ledger_id=$1::uuid and action='tournament_claim_reconciled_onchain'`,[concurrent.ledgerId]);
    assert.equal(audits.rows[0].n,1);

    const wrong=await entitlement(ctx);
    const wrongTx=await ctx.user.sendTransaction({to:ctx.distributorAddress,value:1n});await wrongTx.wait();
    await assert.rejects(()=>verifyNormalTournamentClaim({row:wrong.row,txHash:wrongTx.hash,requestedChainId:ctx.chainId,requestedWallet:wrong.wallet}));
    const otherWallet = await ctx.other.getAddress();
    assert.throws(()=>normalTournamentEntitlementIdentity(wrong.row,{requestedChainId:ctx.chainId,requestedWallet:otherWallet}),(e)=>e?.code==="CLAIM_WALLET_MISMATCH");
    assert.throws(()=>normalTournamentEntitlementIdentity(wrong.row,{requestedChainId:ctx.chainId===97?56:4663,requestedWallet:wrong.wallet}),(e)=>e?.code==="REWARD_CHAIN_MISMATCH");
    const rightTx=await claim(ctx,wrong);
    await assert.rejects(()=>verifyNormalTournamentClaim({row:{...wrong.row,amount:String(wrong.amount+1n)},txHash:rightTx.hash,requestedChainId:ctx.chainId,requestedWallet:wrong.wallet}),(e)=>e?.code==="CLAIM_AMOUNT_MISMATCH");

    const immutable=await entitlement(ctx,{status:"claim_pending",recordedTx:bytes32()});
    await claim(ctx,immutable);
    a=await auth(ctx,immutable.wallet,"claim_intent");
    res=await call(rewardClaimIntent,{walletAddress:immutable.wallet,chainId:ctx.chainId,rewardLedgerIds:[immutable.ledgerId],auth:a});
    assert.equal(res.statusCode,409,JSON.stringify(res.payload));
    assert.equal(res.payload.code,"CLAIM_ALREADY_RECORDED");

    await ctx.provider.destroy();
  });
}
