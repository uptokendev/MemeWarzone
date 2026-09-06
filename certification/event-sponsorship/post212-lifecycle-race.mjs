import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "pg";
import { ContractFactory, HDNodeWallet, Interface, JsonRpcProvider, NonceManager, id } from "ethers";

const ROOT = path.resolve(process.cwd());
const DB_URL = process.env.DATABASE_URL;
const RPC_URL = process.env.SPONSORSHIP_CERT_RPC || "http://127.0.0.1:8545";
const API_PORT = Number(process.env.SPONSORSHIP_POST212_API_PORT || 3302);
const API = `http://127.0.0.1:${API_PORT}/api`;
const CHAIN_ID = 97;
const PHRASE = "test test test test test test test test test test test junk";
const OPS_KEY = "sponsorship-process-cert-ops";
const INTERNAL_TOKEN = "sponsorship-process-cert-internal";
const PRICE = "9990009990009990010";
const report = { lifecycle: {}, idempotency: false, split1001: false, races: [], anomalousStateConstraint: false };

const db = new Client({ connectionString: DB_URL });
await db.connect();
const provider = new JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
const wallet = (i) => HDNodeWallet.fromPhrase(PHRASE, "", `m/44'/60'/0'/0/${i}`).connect(provider);
const ownerWallet = wallet(0);
const owner = new NonceManager(ownerWallet);
const payerWallet = wallet(1);
const payer = new NonceManager(payerWallet);
const quoteSigner = wallet(2);
const marketing = wallet(3);
const protocol = wallet(4);
const eventReceiver = wallet(5);
const payerAddress = payerWallet.address.toLowerCase();
let seq = 5000;
let nonceSeq = 0;
function uuid(n){ return `91000000-0000-4000-8000-${BigInt(n).toString(16).padStart(12,"0")}`; }
async function artifact(name){ return JSON.parse(await readFile(path.join(ROOT,"artifacts-sponsorship-cert","contracts",`${name}.sol`,`${name}.json`),"utf8")); }
async function deploy(name,args=[]){ const a=await artifact(name); const c=await new ContractFactory(a.abi,a.bytecode,owner).deploy(...args); await c.waitForDeployment(); return c; }
const vault=await deploy("EventPrizeVaultV1",[ownerWallet.address]);
const router=await deploy("WarzoneSponsorshipRouterV1",[ownerWallet.address,quoteSigner.address,await vault.getAddress(),marketing.address,protocol.address]);
await (await vault.setRouter(await router.getAddress())).wait();

async function seedEvent(){ seq+=1; const eventId=uuid(seq); const ref=uuid(seq+10000); await db.query(`insert into public.sponsorship_events(id,event_type,event_reference_id,chain_id,starts_at,ends_at,sponsorship_open,prize_native_raw,sponsorship_prize_native_raw) values($1,'normal_tournament',$2,$3,now()-interval '1 minute',now()+interval '1 day',true,0,0)`,[eventId,ref,CHAIN_ID]); await db.query(`insert into public.arena_tournaments(id,chain_id,status,origin,starts_at,ends_at,battle_mode,competition_generation,contest_scoring_version) values($1,$2,'open','normal',now()-interval '1 minute',now()+interval '1 day','normal',1,3)`,[ref,CHAIN_ID]); const eventKey=id(`warzone-sponsorship-event:${eventId}`); await (await vault.setEventReceiver(eventKey,eventReceiver.address)).wait(); await (await router.setEventEnabled(eventKey,true)).wait(); return {eventId,ref,eventKey}; }
async function signedAuth(event){ nonceSeq+=1; const nonce=`post212-${Date.now()}-${nonceSeq}`; await db.query(`insert into public.auth_nonces(chain_id,address,nonce,expires_at) values($1,$2,$3,now()+interval '10 minutes')`,[CHAIN_ID,payerAddress,nonce]); const lines=["MemeWarzone API Action","Action: arena_sponsorship_quote",`Wallet: ${payerAddress}`,`Chain ID: ${CHAIN_ID}`,`Event: ${event.eventId}`,`Event Reference: ${event.ref}`,"Tier: CERT","Minimum USD cents: 1","Requested USD cents: 1",`Nonce: ${nonce}`]; const message=lines.join("\n"); return {action:"arena_sponsorship_quote",walletAddress:payerAddress,chainId:CHAIN_ID,nonce,message,signature:await payerWallet.signMessage(message)}; }
async function http(method,route,body,headers={}){ const r=await fetch(`${API}${route}`,{method,headers:{...(body?{"content-type":"application/json"}:{}),...headers},body:body?JSON.stringify(body):undefined}); let data=null; try{data=await r.json();}catch{} return {status:r.status,data}; }
function startApi(){ const now=Math.floor(Date.now()/1000); return spawn(process.execPath,[path.join(ROOT,"frontend","api","server.mjs")],{cwd:path.join(ROOT,"frontend"),env:{...process.env,NODE_ENV:"production",PORT:String(API_PORT),DATABASE_URL:DB_URL,POSTGRAD_SPONSORSHIPS_ENABLED:"1",API_AUTH_ENFORCE_USER_WRITES:"1",API_AUTH_ENFORCE_INTERNAL:"1",API_AUTH_ENFORCE_SECURITY_MUTATIONS:"1",DASHBOARD_OPS_KEY:OPS_KEY,INTERNAL_API_TOKEN:INTERNAL_TOKEN,RANK_EVENTS_TOKEN:INTERNAL_TOKEN,BSC_RPC_HTTP_97:RPC_URL,WARZONE_SPONSORSHIP_ROUTER_V1_ADDRESS_97:router.target,ARENA_SPONSORSHIP_NATIVE_USD_MICROS_97:PRICE,ARENA_SPONSORSHIP_PRICING_VERSION_97:"1",ARENA_SPONSORSHIP_NATIVE_USD_UPDATED_AT_97:String(now),ARENA_SPONSORSHIP_PRICE_MAX_AGE_SECONDS_97:"3600",ARENA_SPONSORSHIP_QUOTE_SIGNER_PRIVATE_KEY:quoteSigner.privateKey,ARENA_SPONSORSHIP_QUOTE_SIGNER_ADDRESS_97:quoteSigner.address},stdio:["ignore","pipe","pipe"]}); }
const api=startApi(); let log=""; for(const s of [api.stdout,api.stderr]) s.on("data",c=>{log+=c.toString();});
for(let i=0;i<80;i++){ try{const r=await fetch(`http://127.0.0.1:${API_PORT}/healthz`); if(r.ok) break;}catch{} if(i===79) throw new Error(`API failed\n${log}`); await sleep(250); }
async function quoteFor(event){ const auth=await signedAuth(event); const q=await http("POST","/arena/sponsorships/quote",{eventId:event.eventId,chainId:CHAIN_ID,walletAddress:payerAddress,requestedUsdCents:"1",auth}); assert.equal(q.status,201,JSON.stringify(q.data)); assert.equal(q.data.quote.value.requestedNativeRaw,"1001"); return q.data; }
function quoteArgs(q){ const v=q.quote.value; return [v.eventId,v.pricingTier,v.pricingVersion,v.minimumUsdMicros,v.requestedUsdMicros,v.minimumNativeRaw,v.requestedNativeRaw,v.nativeUsdReferenceMicros,v.oracleTimestamp,v.nonce,v.deadline,q.quote.signature]; }
async function pay(q){ const tx=await router.connect(payer).paySponsorship(...quoteArgs(q),{value:1001n,gasLimit:1500000}); const receipt=await tx.wait(); const iface=new Interface((await artifact("WarzoneSponsorshipRouterV1")).abi); const topic=iface.getEvent("SponsorshipPaid").topicHash; const ev=receipt.logs.find(x=>x.address.toLowerCase()===router.target.toLowerCase()&&x.topics?.[0]===topic); assert.ok(ev); return {receipt,logIndex:Number(ev.index??ev.logIndex)}; }
async function confirm(q,p){ return http("POST","/arena/sponsorships/confirm",{quoteId:q.quoteId,txHash:p.receipt.hash,logIndex:p.logIndex},{"x-rank-events-token":INTERNAL_TOKEN}); }
async function counts(q){ return (await db.query(`select es.status,es.gross_native_raw,es.prize_native_raw,es.marketing_native_raw,es.protocol_native_raw,e.sponsorship_prize_native_raw,(select count(*)::int from public.sponsorship_payments p where p.quote_id=$1) payments from public.event_sponsorships es join public.sponsorship_events e on e.id=es.event_id where es.quote_id=$1`,[q.quoteId])).rows[0]; }

for(const state of ["cancelled_before_payment","inactive","operator_policy_required","completed","active"]){ const event=await seedEvent(); const q=await quoteFor(event); const p=await pay(q); await db.query(`update public.event_sponsorships set status=$2 where quote_id=$1`,[q.quoteId,state]); const before=await counts(q); const r=await confirm(q,p); const after=await counts(q); assert.equal(r.status,409); assert.equal(r.data?.code,"SPONSORSHIP_INVALID_STATE"); assert.equal(after.status,state); assert.equal(Number(after.payments),0); for(const k of ["gross_native_raw","prize_native_raw","marketing_native_raw","protocol_native_raw","sponsorship_prize_native_raw"]) assert.equal(String(after[k]),String(before[k])); report.lifecycle[state]="PASS"; }
try{ const e=await seedEvent(); const q=await quoteFor(e); await db.query(`update public.event_sponsorships set status='anomalous_unknown' where quote_id=$1`,[q.quoteId]); }catch{ report.anomalousStateConstraint=true; }
assert.equal(report.anomalousStateConstraint,true);

const idemEvent=await seedEvent(); const idemQ=await quoteFor(idemEvent); const idemP=await pay(idemQ); const first=await confirm(idemQ,idemP); assert.equal(first.status,201); const retry=await confirm(idemQ,idemP); assert.equal(retry.status,200); assert.equal(retry.data?.idempotent,true); const idem=await counts(idemQ); assert.equal(Number(idem.payments),1); assert.equal(idem.status,"active"); assert.equal(String(idem.gross_native_raw),"1001"); assert.equal(String(idem.prize_native_raw),"701"); assert.equal(String(idem.marketing_native_raw),"200"); assert.equal(String(idem.protocol_native_raw),"100"); assert.equal(String(idem.sponsorship_prize_native_raw),"701"); assert.equal(await vault.eventBalances(idemEvent.eventKey),701n); report.idempotency=true; report.split1001=true;

for(let rep=1;rep<=10;rep++){
  if(rep<=4){ const e=await seedEvent(); const q=await quoteFor(e); const p=await pay(q); const [a,b]=await Promise.all([confirm(q,p),confirm(q,p)]); const c=await counts(q); const ok=[a.status,b.status].sort().join(",")==="200,201"&&Number(c.payments)===1&&c.status==="active"&&String(c.sponsorship_prize_native_raw)==="701"; assert.equal(ok,true); report.races.push({rep,type:"same-receipt",http:[a.status,b.status],payments:c.payments,state:c.status,result:"PASS"});
  } else if(rep<=7){ const e1=await seedEvent(),e2=await seedEvent(); const q1=await quoteFor(e1),q2=await quoteFor(e2); const p1=await pay(q1),p2=await pay(q2); const [a,b]=await Promise.all([confirm(q1,p1),confirm(q1,p2)]); const c=await counts(q1); const statuses=[a.status,b.status].sort((x,y)=>x-y); const ok=statuses[0]===201&&statuses[1]===409&&Number(c.payments)===1&&c.status==="active"&&String(c.sponsorship_prize_native_raw)==="701"; assert.equal(ok,true); report.races.push({rep,type:"competing-receipt",http:[a.status,b.status],payments:c.payments,state:c.status,result:"PASS"});
  } else { const e=await seedEvent(); const q=await quoteFor(e); const p=await pay(q); const blocker=new Client({connectionString:DB_URL}); await blocker.connect(); await blocker.query("begin"); await blocker.query(`update public.event_sponsorships set status='cancelled_before_payment' where quote_id=$1`,[q.quoteId]); const pending=confirm(q,p); await sleep(150); await blocker.query("commit"); await blocker.end(); const r=await pending; const c=await counts(q); const ok=r.status===409&&r.data?.code==="SPONSORSHIP_INVALID_STATE"&&Number(c.payments)===0&&c.status==="cancelled_before_payment"&&String(c.sponsorship_prize_native_raw)==="0"; assert.equal(ok,true); report.races.push({rep,type:"confirm-vs-cancel",http:[r.status],payments:c.payments,state:c.status,result:"PASS"}); }
}
console.log("POST212_EVENT_SPONSORSHIP_JSON="+JSON.stringify(report));
api.kill("SIGTERM"); await db.end();
