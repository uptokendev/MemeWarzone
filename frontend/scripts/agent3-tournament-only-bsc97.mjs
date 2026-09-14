#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Contract, JsonRpcProvider, Wallet, parseEther } from 'ethers';

const SOURCE = '8eefcc4b49d30f70bda64f4e6f3e647c26de24eb';
const CHAIN_ID = 97;
const TREASURY = process.env.AGENT3_BSC97_TREASURY || '0xAb8cb6d117b79dd7502898e50C900360924fDa85';
const BUYIN = BigInt(process.env.AGENT3_BSC97_BUYIN_WEI || '100000000000000'); // 0.0001 tBNB
const BOOST_UNIT = BigInt(process.env.AGENT3_BSC97_BOOST_UNIT_WEI || '100000000000000');
const RPC = process.env.BSC_TESTNET_RPC_URL || 'https://data-seed-prebsc-1-s1.bnbchain.org:8545';
const PK = String(process.env.BSC_TESTNET_PRIVATE_KEY || process.env.EVM_TESTNET_PRIVATE_KEY || '').trim();
if (!PK) throw new Error('MISSING_BSC_TESTNET_PRIVATE_KEY');

const ABI = [
 'function owner() view returns(address)',
 'function resolver() view returns(address)',
 'function boostQuoteSigner() view returns(address)',
 'function protocolReceiver() view returns(address)',
 'function postGradLeagueTreasury() view returns(address)',
 'function authorizedCreators(address) view returns(bool)',
 'function depositsPaused() view returns(bool)',
 'function openTournamentPool(bytes32,uint96,uint256,uint256)',
 'function depositBuyIn(bytes32) payable',
 'function setTournamentLive(bytes32)',
 'function boostTournament(bytes32,bytes32,uint256,address,uint256,uint256,uint256,uint256,uint256,uint256,bytes) payable',
 'function resolve(bytes32,address,uint256,bytes)',
 'function claimWinner(bytes32)',
 'function pools(bytes32) view returns(uint8 kind,uint8 state,address ownerA,address ownerB,uint96 stakeAmount,uint96 buyInAmount,uint256 stakeA,uint256 stakeB,uint256 buyInTotal,uint256 boostTotal,address winnerPayout,uint256 pendingWinner,uint256 pendingProtocol,uint256 pendingLeague,uint256 depositDeadline,uint256 resolveDeadline,bool claimedWinner,bool claimedProtocol,bool claimedLeague,bool refundedA,bool refundedB)',
 'function buyIns(bytes32,address) view returns(uint256)',
 'function usedBoostNonces(address,uint256) view returns(bool)'
];
const assert = (c,m)=>{if(!c)throw new Error(`ASSERT_${m}`)};
const low = x=>String(x).toLowerCase();
const wait = async tx => { const r=await tx.wait(); if(!r || r.status!==1) throw new Error(`TX_FAILED_${tx.hash}`); return {hash:tx.hash,blockNumber:r.blockNumber,gasUsed:String(r.gasUsed)}; };
const mustReject = async (fn,label)=>{ try { await fn(); } catch(e) { return String(e?.shortMessage||e?.message||e).slice(0,800); } throw new Error(`EXPECTED_REJECTION_${label}`); };
const id = label => '0x'+crypto.createHash('sha256').update(`${label}:${Date.now()}:${crypto.randomBytes(12).toString('hex')}`).digest('hex');
const poolJson = p => ({kind:Number(p.kind),state:Number(p.state),ownerA:p.ownerA,buyInAmount:String(p.buyInAmount),buyInTotal:String(p.buyInTotal),boostTotal:String(p.boostTotal),winnerPayout:p.winnerPayout,pendingWinner:String(p.pendingWinner),pendingProtocol:String(p.pendingProtocol),pendingLeague:String(p.pendingLeague),claimedWinner:Boolean(p.claimedWinner)});

async function main(){
 const provider = new JsonRpcProvider(RPC, CHAIN_ID, {staticNetwork:true});
 const net = await provider.getNetwork(); assert(Number(net.chainId)===CHAIN_ID,'CHAIN_97');
 const signer = new Wallet(PK, provider); const treasury = new Contract(TREASURY, ABI, signer);
 const [owner,resolver,quoteSigner,protocol,league,paused,creator] = await Promise.all([treasury.owner(),treasury.resolver(),treasury.boostQuoteSigner(),treasury.protocolReceiver(),treasury.postGradLeagueTreasury(),treasury.depositsPaused(),treasury.authorizedCreators(signer.address)]);
 assert(!paused,'DEPOSITS_NOT_PAUSED'); assert(low(owner)===low(signer.address)||creator,'SIGNER_CREATOR'); assert(low(resolver)===low(signer.address),'SIGNER_RESOLVER'); assert(low(quoteSigner)===low(signer.address),'SIGNER_BOOST_QUOTE');
 const bal=await provider.getBalance(signer.address); assert(bal>parseEther('0.003'),'SIGNER_FUNDED');
 const a=Wallet.createRandom().connect(provider), b=Wallet.createRandom().connect(provider), side=Wallet.createRandom().address, poolId=id('agent3-normal-tournament');
 const fundEach=parseEther('0.0012'); const fundReceipt=await wait(await signer.sendTransaction({to:a.address,value:fundEach})); const fundReceiptB=await wait(await signer.sendTransaction({to:b.address,value:fundEach}));
 const block=await provider.getBlock('latest'); const now=Number(block.timestamp), depositDeadline=now+1200, resolveDeadline=now+2400;
 const open=await wait(await treasury.openTournamentPool(poolId,BUYIN,depositDeadline,resolveDeadline));
 const ta=treasury.connect(a), tb=treasury.connect(b); const entryA=await wait(await ta.depositBuyIn(poolId,{value:BUYIN})); const entryB=await wait(await tb.depositBuyIn(poolId,{value:BUYIN}));
 const duplicateEntryError=await mustReject(()=>ta.depositBuyIn(poolId,{value:BUYIN}),'DUPLICATE_ENTRY');
 const afterEntries=await treasury.pools(poolId); assert(Number(afterEntries.kind)===1&&Number(afterEntries.state)===0,'TOURNAMENT_OPEN'); assert(afterEntries.buyInTotal===BUYIN*2n,'BUYIN_TOTAL'); assert(await treasury.buyIns(poolId,a.address)===BUYIN,'ENTRY_A_RECORDED');
 const live=await wait(await treasury.setTournamentLive(poolId));
 // Vote-Tournament paid Boost semantics are the same Tournament treasury rail. Two independent signed quotes prove unlimited regulation Boost and replay rejection.
 const domain={name:'ArenaWarPoolTreasury',version:'2',chainId:CHAIN_ID,verifyingContract:TREASURY};
 const types={BoostQuote:[{name:'poolId',type:'bytes32'},{name:'matchId',type:'bytes32'},{name:'roundNumber',type:'uint256'},{name:'booster',type:'address'},{name:'sideToken',type:'address'},{name:'boostUnits',type:'uint256'},{name:'unitPriceNativeRaw',type:'uint256'},{name:'grossNativeRaw',type:'uint256'},{name:'pricingVersion',type:'uint256'},{name:'oracleTimestamp',type:'uint256'},{name:'nonce',type:'uint256'},{name:'deadline',type:'uint256'}]};
 const matchId=id('vote-match'); const pricingVersion=1n; const oracleTimestamp=BigInt((await provider.getBlock('latest')).timestamp); const quoteDeadline=oracleTimestamp+900n;
 async function boost(nonce){ const value={poolId,matchId,roundNumber:1n,booster:a.address,sideToken:side,boostUnits:1n,unitPriceNativeRaw:BOOST_UNIT,grossNativeRaw:BOOST_UNIT,pricingVersion,oracleTimestamp,nonce,deadline:quoteDeadline}; const sig=await signer.signTypedData(domain,types,value); return {receipt:await wait(await ta.boostTournament(poolId,matchId,1,side,1,BOOST_UNIT,pricingVersion,oracleTimestamp,nonce,quoteDeadline,sig,{value:BOOST_UNIT})),sig,value}; }
 const boost1=await boost(900001n); const boostReplayError=await mustReject(()=>ta.boostTournament(poolId,matchId,1,side,1,BOOST_UNIT,pricingVersion,oracleTimestamp,900001n,quoteDeadline,boost1.sig,{value:BOOST_UNIT}),'BOOST_REPLAY'); const boost2=await boost(900002n);
 const beforeResolve=await treasury.pools(poolId); assert(beforeResolve.boostTotal===BOOST_UNIT*2n,'MULTIPLE_BOOSTS');
 // Resolve Tournament using authoritative resolver signature.
 const rtypes={ResolvePoolV2:[{name:'poolId',type:'bytes32'},{name:'winnerPayout',type:'address'},{name:'stakeTotal',type:'uint256'},{name:'buyInTotal',type:'uint256'},{name:'boostTotal',type:'uint256'},{name:'deadline',type:'uint256'}]}; const rdeadline=BigInt((await provider.getBlock('latest')).timestamp+900); const rval={poolId,winnerPayout:a.address,stakeTotal:0n,buyInTotal:beforeResolve.buyInTotal,boostTotal:beforeResolve.boostTotal,deadline:rdeadline}; const rsig=await signer.signTypedData(domain,rtypes,rval); const resolveTx=await wait(await treasury.resolve(poolId,a.address,rdeadline,rsig)); const resolved=await treasury.pools(poolId); assert(Number(resolved.state)===2,'RESOLVED'); assert(low(resolved.winnerPayout)===low(a.address),'WINNER_IDENTITY');
 const expectedEntryLeague=(BUYIN*2n*2000n)/10000n, expectedEntryProtocol=(BUYIN*2n*500n)/10000n, expectedEntryPrize=BUYIN*2n-expectedEntryLeague-expectedEntryProtocol, expectedBoostProtocol=(BOOST_UNIT*2n*1000n)/10000n, expectedBoostPrize=BOOST_UNIT*2n-expectedBoostProtocol;
 assert(resolved.pendingWinner===expectedEntryPrize+expectedBoostPrize,'75_20_5_PLUS_90_10_WINNER'); assert(resolved.pendingProtocol===expectedEntryProtocol+expectedBoostProtocol,'PROTOCOL_SPLIT'); assert(resolved.pendingLeague===expectedEntryLeague,'LEAGUE_20');
 const repeatResolveError=await mustReject(()=>treasury.resolve(poolId,a.address,rdeadline,rsig),'REPEAT_FINALIZER');
 const winnerBalBefore=await provider.getBalance(a.address); const claim=await wait(await ta.claimWinner(poolId)); const winnerBalAfter=await provider.getBalance(a.address); const afterClaim=await treasury.pools(poolId); assert(afterClaim.pendingWinner===0n&&afterClaim.claimedWinner,'WINNER_SETTLED'); assert(winnerBalAfter>winnerBalBefore,'WINNER_BALANCE_EFFECT');
 const reloadProvider=new JsonRpcProvider(RPC,CHAIN_ID,{staticNetwork:true}); const reloadTreasury=new Contract(TREASURY,ABI,reloadProvider); const reloaded=await reloadTreasury.pools(poolId); assert(Number(reloaded.state)===2&&reloaded.claimedWinner&&reloaded.pendingWinner===0n,'RELOAD_RECONCILIATION');
 const out={sourceAuthority:SOURCE,network:'bsc-testnet-97',chainId:CHAIN_ID,treasury:TREASURY,roles:{runner:signer.address,owner,resolver,boostQuoteSigner:quoteSigner,protocolReceiver:protocol,postGradLeagueTreasury:league},funding:{a:fundReceipt,b:fundReceiptB},normalTournament:{poolId,open,entryA,entryB,duplicateEntryRejected:true,duplicateEntryError,live,buyInTotal:String(BUYIN*2n),entrySplit:{gross:String(BUYIN*2n),prize:String(expectedEntryPrize),league:String(expectedEntryLeague),protocol:String(expectedEntryProtocol)},resolve:resolveTx,repeatFinalizerRejected:true,repeatResolveError,winner:a.address,winnerClaim:claim,winnerBalanceBefore:String(winnerBalBefore),winnerBalanceAfter:String(winnerBalAfter),reloadReconciled:true},voteTournamentMoney:{matchId,round:1,boost1:boost1.receipt,boost2:boost2.receipt,replayRejected:true,replayError:boostReplayError,gross:String(BOOST_UNIT*2n),prize:String(expectedBoostPrize),league:'0',protocol:String(expectedBoostProtocol),multiplePaidBoosts:true},noBattleTransactions:true,noMainnet:true};
 const path=process.env.AGENT3_TOURNAMENT_BSC97_OUT||'reports/agent3-tournament-bsc97.json'; fs.mkdirSync(path.split('/').slice(0,-1).join('/')||'.',{recursive:true}); fs.writeFileSync(path,JSON.stringify(out,null,2)+'\n'); console.log(JSON.stringify(out,null,2));
}
main().catch(e=>{console.error(e?.stack||e);process.exitCode=1});
