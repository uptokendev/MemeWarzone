// Read-only canary. No wallet, private key, database, transaction submission or production write.
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {resolveSolanaProjectImport} from '../frontend/api/lib/projectImportResolverAdapters.js';
import {scanProjectImportSecurity} from '../frontend/api/lib/projectImportRiskSecurity.js';
import {readBnbImportMarket,BNB_IMPORT_MARKETS as C} from '../frontend/api/lib/projectImportBnbMarket.js';
const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const {JsonRpcProvider,FetchRequest,Interface}=require('ethers');
const out={checkedAt:new Date().toISOString(),readOnly:true,liveSignaturesVerified:false,rows:[],errors:[]};
const solTokens=[
 ['ASK','7AVB9viRcpmr8gRMTCAYSmhP7gbuBMpBR51DMjwcpump','9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H'],
 ['Everglen','FcBb7avR9LgmgwFxRcVJDiroZxZfgvtnUJrRKQ7kpump','3ZMWQiR7YauYYmdHPs8Qr1bLZZbtvnPeobhDvjR7VbkD'],
 ['Legacy Coin','2XnP5fdNbeBbBUX1sh4gKTJCM7zD1SoKX2QhEHudpump','2wsYUHLBo8Y7voFjLkwXFZFn7iayUmaXARtQTZkrNhYB'],
];
for(const [name,contractAddress,claimant] of solTokens) {
 try {
  const resolved=await resolveSolanaProjectImport({chainId:101,tokenAddress:contractAddress,signedWallet:claimant});
  const security=await scanProjectImportSecurity({chainId:101,tokenAddress:contractAddress,market:resolved.market,custody:resolved.custody});
  out.rows.push({name,contractAddress,market:resolved.market,authority:resolved.currentAuthority,claimantMatchesAddress:resolved.signedWalletMatchesAuthority,relationships:resolved.projectAuthorityEvidence?.relationships,critical:security.criticalRisks,review:security.reviewRisks});
 }catch(e){out.errors.push({name,error:String(e.message),code:e.code});}
}
const rpcRequest=new FetchRequest(process.env.BSC_RPC_URL||'https://bsc-rpc.publicnode.com');rpcRequest.timeout=8000;
const rpc=new JsonRpcProvider(rpcRequest,56,{batchMaxCount:1});
try {
 const events=new Interface([
  'event TokenCreate(address creator,address token,uint256 requestId,string name,string symbol,uint256 totalSupply,uint256 launchTime,uint256 launchFee)',
  'event LiquidityAdded(address base,uint256 offers,address quote,uint256 funds)',
 ]);
 const latest=BigInt(await rpc.send('eth_blockNumber',[]))-3n;
 const logs=await rpc.send('eth_getLogs',[{address:C.managers[2],fromBlock:'0x'+(latest-2000n).toString(16),toBlock:'0x'+latest.toString(16),topics:[[events.getEvent('TokenCreate').topicHash,events.getEvent('LiquidityAdded').topicHash]]}]);
 const parsed=logs.filter(x=>!x.removed).map(x=>({event:events.parseLog(x),transaction:x.transactionHash}));
 const latestCreated=parsed.filter(x=>x.event.name==='TokenCreate').slice(-2);
 const latestGraduated=parsed.filter(x=>x.event.name==='LiquidityAdded').slice(-2);
 const samples=[{name:'CAKE direct-DEX control',contractAddress:'0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82'},
  ...latestCreated.map(x=>({name:'Four creation-event sample',contractAddress:x.event.args.token,sourceTransaction:x.transaction})),
  ...latestGraduated.map(x=>({name:'Four liquidity-event sample',contractAddress:x.event.args.base,sourceTransaction:x.transaction}))];
 out.bnbDiscovery={block:latest.toString(),blockWindow:2000,creationEvents:latestCreated.length,liquidityEvents:latestGraduated.length};
 for(const sample of samples)try{out.rows.push({...sample,...await readBnbImportMarket({provider:rpc,tokenAddress:sample.contractAddress})});}catch(e){out.errors.push({...sample,error:String(e.message),code:e.code});}
 // Independent primary-source token-list check for the fixed discovery quote identities.
 try {
  const r=await fetch('https://tokens.pancakeswap.finance/pancakeswap-extended.json',{signal:AbortSignal.timeout(8000)});
  if(!r.ok)throw Error('Official token list HTTP '+r.status);
  const list=await r.json();out.quoteReferences=C.discoveryQuotes.map(a=>({address:a,match:list.tokens?.find(t=>t.chainId===56&&t.address.toLowerCase()===a)}));
 }catch(e){out.quoteReferenceError=String(e.message);}
}catch(e){out.errors.push({name:'BNB discovery',error:String(e.message)});}finally{rpc.destroy();}
fs.writeFileSync(process.env.IMPORT_CANARY_OUTPUT||'/tmp/import-market-canary.json',JSON.stringify(out,null,2));
for(const row of out.rows)console.log(JSON.stringify({name:row.name,contractAddress:row.contractAddress,phase:row.market?.phase,verified:row.market?.verified,reason:row.market?.reason,venue:row.market?.venue,actualQuote:row.market?.quoteReserve,virtualQuote:row.market?.virtualQuoteReserves,launchReview:row.market?.requiresLaunchReview,creatorMatch:row.claimantMatchesAddress}));
for(const e of out.errors)console.log('READ_ERROR',JSON.stringify(e));
const ask=out.rows.find(x=>x.name==='ASK');
if(!ask||ask.market?.phase!=='postgrad'||ask.market?.verified!==true||ask.claimantMatchesAddress!==false)throw Error('ASK read-only acceptance failed; inspect artifact.');
const bnb=out.rows.find(x=>x.name==='CAKE direct-DEX control');
if(!bnb||bnb.market?.verified!==true||!bnb.market?.requiresLaunchReview)throw Error('BNB direct-DEX read-only acceptance failed; inspect artifact.');
