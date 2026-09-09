import test from 'node:test';import assert from 'node:assert/strict';
import {PublicKey,Keypair} from '@solana/web3.js';
import {AccountLayout,TOKEN_2022_PROGRAM_ID,TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {PUMP_PROGRAM,PUMP_FEES_PROGRAM,PUMP_AMM_PROGRAM,WRAPPED_SOL,pumpCurveAddress,pumpSharingAddress,pumpPoolAddress,decodePumpCurve,decodePumpSharing,decodeCanonicalPumpPool,inspectCustodyTokenAccount,readPumpImportEvidence} from './projectImportPumpEvidence.js';
const mint=new PublicKey('FcBb7avR9LgmgwFxRcVJDiroZxZfgvtnUJrRKQ7kpump'),claimant=new PublicKey('3ZMWQiR7YauYYmdHPs8Qr1bLZZbtvnPeobhDvjR7VbkD');
const info=(data,owner)=>({data,owner,executable:false,lamports:10000000});
function curve(creator,complete=false){const b=Buffer.alloc(151);Buffer.from([23,183,248,55,96,216,172,96]).copy(b);b[48]=Number(complete);creator.toBuffer().copy(b,49);b.writeBigUInt64LE(1000000n,24);b.writeBigUInt64LE(100000n,32);return info(b,PUMP_PROGRAM);}
function shares(){const [key,bump]=pumpSharingAddress(mint),b=Buffer.alloc(1024);Buffer.from([216,74,9,0,56,140,93,75]).copy(b);b[8]=bump;b[9]=2;b[10]=1;mint.toBuffer().copy(b,11);claimant.toBuffer().copy(b,43);b[75]=1;b.writeUInt32LE(1,76);claimant.toBuffer().copy(b,80);b.writeUInt16LE(10000,112);return{key,account:info(b,PUMP_FEES_PROGRAM)};}
function token(owner,amount=1000n,tokenMint=mint,program=TOKEN_2022_PROGRAM_ID){const b=Buffer.alloc(AccountLayout.span);AccountLayout.encode({mint:tokenMint,owner,amount,delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},b);return info(b,program);}
function pool(creator=claimant){const p=pumpPoolAddress(mint),b=Buffer.alloc(261);Buffer.from([241,154,109,4,17,177,109,188]).copy(b);b[8]=p.bump;p.authority.toBuffer().copy(b,11);mint.toBuffer().copy(b,43);WRAPPED_SOL.toBuffer().copy(b,75);const baseAta=getAssociatedTokenAddressSync(mint,p.address,true,TOKEN_2022_PROGRAM_ID),quoteAta=getAssociatedTokenAddressSync(WRAPPED_SOL,p.address,true,TOKEN_PROGRAM_ID);baseAta.toBuffer().copy(b,139);quoteAta.toBuffer().copy(b,171);b.writeBigUInt64LE(100n,203);creator.toBuffer().copy(b,211);return{...p,baseAta,quoteAta,account:info(b,PUMP_AMM_PROGRAM)};}
const connection=entries=>({getAccountInfo:async address=>entries.get(address.toBase58())||null});
test('fee account identity and layout are authenticated; admin and recipients confer no automatic authority',async()=>{
 const sh=shares(),c=curve(sh.key),map=new Map([[sh.key.toBase58(),sh.account]]);
 const e=await readPumpImportEvidence({connection:connection(map),mint,curveAccount:c,tokenProgram:TOKEN_2022_PROGRAM_ID,claimant:claimant.toBase58()});
 assert.equal(e.market.phase,'bonding');assert.equal(e.authorityType,'fee_sharing');assert.equal(e.sharing.adminRevoked,true);assert.equal(e.relationships.length,2);assert.ok(e.relationships.every(r=>r.confersProjectAuthority===false));
});
test('spoofed fee records fail exact program, address, mint, version, totals and discriminator checks',()=>{
 const s=shares();assert.ok(decodePumpSharing(s.account,mint,s.key));
 assert.equal(decodePumpSharing({...s.account,owner:TOKEN_PROGRAM_ID},mint,s.key),null);assert.equal(decodePumpSharing(s.account,mint,claimant),null);
 for(const [offset,value] of [[0,0],[9,7],[10,9],[11,7],[75,4],[76,11],[112,0]]){const b=Buffer.from(s.account.data);b[offset]=value;assert.equal(decodePumpSharing(info(b,PUMP_FEES_PROGRAM),mint,s.key),null,`offset ${offset}`);}
});
test('a wallet creator and an arbitrary off-curve account are not fee-sharing proof',async()=>{
 const e=await readPumpImportEvidence({connection:connection(new Map()),mint,curveAccount:curve(claimant),claimant:claimant.toBase58()});assert.equal(e.authorityType,'wallet');assert.equal(e.sharing,null);assert.equal(e.relationships.length,0);
 const f=await readPumpImportEvidence({connection:connection(new Map()),mint,curveAccount:curve(pumpCurveAddress(mint)),claimant:claimant.toBase58()});assert.equal(f.authorityType,'program_account');
});
test('exact verified curve custody is distinguished from a holder, wrong mint or frozen custody is rejected',async()=>{
 const c=pumpCurveAddress(mint),ata=getAssociatedTokenAddressSync(mint,c,true,TOKEN_2022_PROGRAM_ID),account=token(c);
 assert.ok(inspectCustodyTokenAccount(account,ata,mint,c));assert.equal(inspectCustodyTokenAccount(account,ata,claimant,c),null);assert.equal(inspectCustodyTokenAccount(account,ata,mint,claimant),null);
 const frozen=Buffer.from(account.data);frozen[108]=2;assert.equal(inspectCustodyTokenAccount(info(frozen,TOKEN_2022_PROGRAM_ID),ata,mint,c),null);
 const e=await readPumpImportEvidence({connection:connection(new Map([[ata.toBase58(),account]])),mint,curveAccount:curve(claimant),tokenProgram:TOKEN_2022_PROGRAM_ID,claimant:claimant.toBase58()});assert.equal(e.custody.length,1);assert.equal(e.market.phase,'bonding');
});
test('completed curve alone does not prove graduation market readiness',async()=>{const e=await readPumpImportEvidence({connection:connection(new Map()),mint,curveAccount:curve(claimant,true),claimant:claimant.toBase58()});assert.equal(e.market.phase,'migration_pending');});
test('canonical pool validates authority, mint, index, bump and funded custody',async()=>{
 const p=pool(),map=new Map([[p.address.toBase58(),p.account],[p.baseAta.toBase58(),token(p.address)],[p.quoteAta.toBase58(),token(p.address,500n,WRAPPED_SOL,TOKEN_PROGRAM_ID)]]);
 assert.ok(decodeCanonicalPumpPool(p.account,mint));
 for(const off of [8,9,11,43,75,243,245]){const b=Buffer.from(p.account.data);b[off]^=1;assert.equal(decodeCanonicalPumpPool(info(b,PUMP_AMM_PROGRAM),mint),null,`pool offset ${off}`);}
 const e=await readPumpImportEvidence({connection:connection(map),mint,curveAccount:curve(claimant,true),claimant:claimant.toBase58()});assert.equal(e.market.phase,'postgrad');assert.equal(e.market.liquidityAvailable,true);assert.equal(e.market.executionTested,false);
 map.set(p.quoteAta.toBase58(),token(p.address,0n,WRAPPED_SOL,TOKEN_PROGRAM_ID));const empty=await readPumpImportEvidence({connection:connection(map),mint,curveAccount:curve(claimant,true)});assert.equal(empty.market.liquidityAvailable,false);
});
test('wrong program, malformed flags, pool lookup outage and non-native quote remain fail closed',async()=>{
 assert.equal(decodePumpCurve({...curve(claimant),owner:TOKEN_PROGRAM_ID}),null);const b=curve(claimant);b.data[82]=3;assert.equal(decodePumpCurve(b),null);
 const e=await readPumpImportEvidence({connection:{getAccountInfo:async()=>{throw Error('RPC outage');}},mint,curveAccount:curve(claimant,true)});assert.equal(e.market.verified,false);
 const q=curve(claimant,true);Keypair.generate().publicKey.toBuffer().copy(q.data,83);const other=await readPumpImportEvidence({connection:connection(new Map()),mint,curveAccount:q});assert.equal(other.market.phase,'migration_pending');
});
