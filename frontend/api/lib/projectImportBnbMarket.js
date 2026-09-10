import { Interface, getAddress } from 'ethers';

// Read-only import evidence. This is NOT a trading router or the launchpad quote catalog.
// Four ABI: four-meme-community/four-meme-ai @ c81f0eebbabec16998b2457f7e881e1b70b86420.
// Factory deployments: developer.pancakeswap.finance/contracts/{v2,v3}/addresses.
export const BNB_IMPORT_MARKETS = Object.freeze({
  chainId: 56,
  fourHelper: '0xf251f83e40a78868fcfa3fa4599dad6494e46034',
  managers: Object.freeze({1:'0xec4549cadce5da21df6e6422d448034b5233bfbc',2:'0x5c952063c7fc8610ffdb798152d69f0b9550762b'}),
  v2Factory: '0xca143ce32fe78f1f7019d7d551a6402fc5350c73',
  v3Factory: '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865',
  wrappedNative: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  discoveryQuotes: Object.freeze(['0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c','0x55d398326f99059ff775485246999027b3197955','0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d']),
  v3Fees: Object.freeze([100,500,2500,10000]),
});
export const BNB_MARKET_ABI = new Interface([
  'function getTokenInfo(address) view returns(uint256 version,address tokenManager,address quote,uint256 lastPrice,uint256 tradingFeeRate,uint256 minTradingFee,uint256 launchTime,uint256 offers,uint256 maxOffers,uint256 funds,uint256 maxFunds,bool liquidityAdded)',
  'function getPair(address,address) view returns(address)',
  'function getPool(address,address,uint24) view returns(address)',
  'function token0() view returns(address)', 'function token1() view returns(address)',
  'function factory() view returns(address)', 'function getReserves() view returns(uint112,uint112,uint32)',
  'function balanceOf(address) view returns(uint256)', 'function totalSupply() view returns(uint256)',
  'function liquidity() view returns(uint128)', 'function fee() view returns(uint24)',
  'function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint32,bool)',
]);
const ZERO='0x0000000000000000000000000000000000000000';
const address=x=>getAddress(String(x)).toLowerCase();
const same=(a,b)=>address(a)===address(b);
const failure=(message,code='PROJECT_IMPORT_RPC_UNAVAILABLE')=>Object.assign(new Error(message),{code});
const hasCode=x=>typeof x==='string'&&/^0x(?:[0-9a-fA-F]{2})+$/.test(x)&&!/^0x0*$/.test(x);
const unverified=(reason,extra={})=>({phase:'unknown',verified:false,liquidityAvailable:false,reason,executionTested:false,...extra});

function boundedReader(provider,{requestTimeoutMs=7000,budgetMs=18000,now=Date.now}={}) {
  const deadline=now()+budgetMs;
  let reads=0;
  return async (method,params) => {
    if(++reads>90||now()>=deadline)throw failure('BNB market check exceeded its bounded read budget. Retry.');
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(()=>provider.send(method,params)),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(failure('BNB market lookup timed out. Retry.')),Math.min(requestTimeoutMs,Math.max(1,deadline-now())));}),
      ]);
    } finally { clearTimeout(timer); }
  };
}
async function mapLimited(items,fn,width=4) {
  const results=new Array(items.length);let index=0;
  await Promise.all(Array.from({length:Math.min(width,items.length)},async()=>{while(index<items.length){const i=index++;results[i]=await fn(items[i]);}}));
  return results;
}

// The caller's endpoint is trusted SERVER configuration. Never use an address/URL from import input.
// A pinned block plus hash recheck prevents combining pool/registry state from different forks.
export async function readBnbImportMarket({provider,tokenAddress,now=Date.now,requestTimeoutMs=7000,budgetMs=18000}) {
  const token=address(tokenAddress);
  if(typeof provider?.send!=='function')return {market:unverified('bnb_market_rpc_unavailable'),custody:[]};
  const send=boundedReader(provider,{now,requestTimeoutMs,budgetMs});
  if(BigInt(await send('eth_chainId',[]))!==56n)throw failure('The BNB import service is connected to the wrong chain.','PROJECT_IMPORT_CHAIN_MISMATCH');
  const latest=BigInt(await send('eth_blockNumber',[]));
  const tag='0x'+(latest>3n?latest-3n:latest).toString(16);
  const block=await send('eth_getBlockByNumber',[tag,false]);
  if(!block||block.number!==tag||!/^0x[0-9a-fA-F]{64}$/.test(block.hash||'')||!Number.isFinite(Number(BigInt(block.timestamp||'0x0')))||Math.abs(now()/1000-Number(BigInt(block.timestamp||'0x0')))>180)throw failure('BNB market evidence is stale or inconsistent. Retry.');
  const observedBlock={number:tag,hash:block.hash,timestamp:new Date(Number(BigInt(block.timestamp))*1000).toISOString(),finality:'block_pinned_not_execution_proof'};
  const call=async(to,method,args=[])=>BNB_MARKET_ABI.decodeFunctionResult(method,await send('eth_call',[{to:address(to),data:BNB_MARKET_ABI.encodeFunctionData(method,args)},tag]));
  const code=async a=>hasCode(await send('eth_getCode',[address(a),tag]));
  const result={market:unverified('supported_market_not_verified'),custody:[],launchEvidence:null,observedBlock};
  const finish=async()=>{
    const end=await send('eth_getBlockByNumber',[tag,false]);
    if(end?.hash!==block.hash)throw failure('BNB chain state changed during the check. Retry.');
    return result;
  };

  // Membership comes from Four's deployed registry, never an address suffix or website label.
  try {
    if(!await code(BNB_IMPORT_MARKETS.fourHelper))throw failure('Four registry code unavailable');
    const info=await call(BNB_IMPORT_MARKETS.fourHelper,'getTokenInfo',[token]);
    const version=Number(info[0]);
    if(version===0) {
      if(!same(info[1],ZERO)||info[11]!==false)throw failure('Inconsistent Four non-membership response');
      result.launchEvidence={platform:'unidentified',fourRegistry:'not_registered',helper:BNB_IMPORT_MARKETS.fourHelper};
    } else {
      if(!BNB_IMPORT_MARKETS.managers[version]||!same(info[1],BNB_IMPORT_MARKETS.managers[version])||!await code(info[1]))throw failure('Unknown Four registry generation');
      const quote=same(info[2],ZERO)?BNB_IMPORT_MARKETS.wrappedNative:address(info[2]);
      result.launchEvidence={platform:'fourmeme',version,tokenManager:address(info[1]),helper:BNB_IMPORT_MARKETS.fourHelper,liquidityAdded:info[11],quoteMint:quote,offers:info[7].toString(),maxOffers:info[8].toString(),funds:info[9].toString(),maxFunds:info[10].toString()};
      if(!info[11]) {
        result.market={phase:'bonding',verified:true,platform:'fourmeme',venue:'Four.meme',reason:'external_bonding',quoteMint:quote,liquidityAvailable:false,executionTested:false};
        return finish(); // Even a real permissionless DEX pair cannot override active launch bonding.
      }
    }
  } catch {
    result.market=unverified('launch_registry_unavailable');
    return finish(); // RPC errors must never masquerade as non-membership.
  }

  const registered=result.launchEvidence.platform==='fourmeme';
  const quotes=registered?[result.launchEvidence.quoteMint]:BNB_IMPORT_MARKETS.discoveryQuotes.filter(q=>q!==token);
  if(quotes.some(q=>!BNB_IMPORT_MARKETS.discoveryQuotes.includes(q))) {
    result.market=unverified('quote_asset_requires_technical_review',{platform:result.launchEvidence.platform,bondingComplete:registered});
    return finish();
  }
  const candidates=[];const issues=[];
  const discover=async(kind)=>{
    const factory=kind==='v2'?BNB_IMPORT_MARKETS.v2Factory:BNB_IMPORT_MARKETS.v3Factory;
    if(!await code(factory))throw failure('Canonical DEX factory unavailable');
    const queries=kind==='v2'?quotes.map(quote=>({quote})):quotes.flatMap(quote=>BNB_IMPORT_MARKETS.v3Fees.map(fee=>({quote,fee})));
    await mapLimited(queries,async q=>{
      try {
        const [p]=await call(factory,kind==='v2'?'getPair':'getPool',kind==='v2'?[token,q.quote]:[token,q.quote,q.fee]);
        if(!same(p,ZERO))candidates.push({kind,factory,pool:address(p),...q});
      } catch { issues.push(`${kind}_discovery_unavailable`); }
    });
  };
  const validate=async c=>{
    const {pool,factory,quote,kind}=c;
    if(!await code(pool))throw failure('Registered pool has no bytecode');
    const [[t0],[t1],[reportedFactory],[baseBalance],[quoteBalance]]=await Promise.all([
      call(pool,'token0'),call(pool,'token1'),call(pool,'factory'),call(token,'balanceOf',[pool]),call(quote,'balanceOf',[pool]),
    ]);
    if(!same(reportedFactory,factory)||!((same(t0,token)&&same(t1,quote))||(same(t1,token)&&same(t0,quote))))throw failure('Pool identity does not match canonical registry');
    let baseReserve,quoteReserve,usable=false,details;
    if(kind==='v2') {
      const [reserves,[supply]]=await Promise.all([call(pool,'getReserves'),call(pool,'totalSupply')]);
      [baseReserve,quoteReserve]=same(t0,token)?[reserves[0],reserves[1]]:[reserves[1],reserves[0]];
      // balanceOf alone can be donated. Conversely reserves must be backed by actual token balances.
      usable=baseReserve>0n&&quoteReserve>0n&&baseBalance>=baseReserve&&quoteBalance>=quoteReserve&&supply>0n;
      details={lpSupply:supply.toString(),lpLockStatus:'not_established'};
    } else {
      const [[liquidity],slot,[fee]]=await Promise.all([call(pool,'liquidity'),call(pool,'slot0'),call(pool,'fee')]);
      if(Number(fee)!==c.fee)throw failure('Pool fee identity mismatch');
      baseReserve=baseBalance;quoteReserve=quoteBalance;
      usable=baseBalance>0n&&quoteBalance>0n&&liquidity>0n&&slot[0]>0n&&slot[6]===true;
      details={activeLiquidity:liquidity.toString(),sqrtPriceX96:slot[0].toString(),unlocked:slot[6],fee:Number(fee),lpLockStatus:'not_established'};
    }
    return {...c,usable,baseReserve:baseReserve.toString(),quoteReserve:quoteReserve.toString(),baseBalance:baseBalance.toString(),quoteBalance:quoteBalance.toString(),details};
  };
  const pools=[];
  try {
    await discover('v2');
    for(const c of candidates.slice(0,3))try{pools.push(await validate(c));}catch{issues.push('pool_validation_unavailable');}
    if(!pools.some(p=>p.usable)) {
      candidates.length=0;await discover('v3');
      for(const c of candidates.sort((a,b)=>a.quote.localeCompare(b.quote)||a.fee-b.fee).slice(0,3))try{pools.push(await validate(c));}catch{issues.push('pool_validation_unavailable');}
    }
  } catch { issues.push('market_rpc_unavailable'); }
  const selected=pools.find(p=>p.usable);
  result.market={...unverified(issues.length?'market_checks_unavailable':'supported_pool_not_verified'),platform:registered?'fourmeme':'unidentified',bondingComplete:registered,discoveryIssues:[...new Set(issues)]};
  if(selected) {
    result.market={...result.market,phase:registered?'postgrad':'dex_market',verified:true,liquidityAvailable:true,venue:selected.kind==='v2'?'PancakeSwap V2':'PancakeSwap V3',poolAddress:selected.pool,factory:selected.factory,baseMint:token,quoteMint:selected.quote,baseReserve:selected.baseReserve,quoteReserve:selected.quoteReserve,baseBalance:selected.baseBalance,quoteBalance:selected.quoteBalance,poolDetails:selected.details,
      reason:registered?'four_graduation_and_pancake_pool_verified':'dex_market_verified_launch_origin_unresolved',
      requiresLaunchReview:!registered,launchStageVerified:registered,pricingValid:true,controlsVerified:true,
      // This records pool readability/funding, not permission to trade or proven sell execution.
      executionTested:false};
    result.custody=pools.filter(p=>p.usable).map(p=>({chainId:56,mint:token,owner:p.pool,tokenAccount:p.pool,amount:p.baseBalance,verified:true,kind:'evm_factory_pool'}));
  }
  return finish();
}
