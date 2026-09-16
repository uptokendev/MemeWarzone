import fs from 'node:fs';
import { ethers } from 'ethers';

const CHAIN_ID = 46630;
const FORBIDDEN_CHAIN_ID = 4663;
const FACTORY = '0xd03D1CC03d108B7F9b2195489DC6CFda1FB1a943';
const CAMPAIGN_IMPL = '0xf3EF4d2000B2eD2aBAC70a661F211f5eC1599E8f';
const ADAPTER = '0x3A2f190Dc17BA64E241f223D34dFf25984476Cbe';
const LOCKER = '0x1977178fDeAcE51318cA22B57dfdD246461b9f24';
const TREASURY = '0x144170c53ADBc5cF7Ec454612C948B931e231C9e';
const GRAD_ORACLE = '0x399E529c0C6888543E6501FD137ac49CA3E1Df58';
const WETH = '0x52A47A33930B8a90a2000b1bA3CB96e879569670';
const V3_FACTORY = '0x948463E91d63a7A51cEeC0342735D1B738044aea';
const POSITION_MANAGER = '0xfF64Bd6970966dB58F0dd65BA76669D3b8BE9eC4';
const SWAP_ROUTER = '0xDfd381ECfA6D4CcD4248e319C6fecD76A6bf3296';
const ETH_USD_ORACLE = '0x5D2A88b0963Bb5b561B495a5fDCba869C01a8cAb';
const DEPLOYER = '0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714';
const UPDATER = '0xE755A2c52654b2133c7A4fdC5349821C6527A766';
const CREATOR = '0xf0558484531204645fB6eaF35c5082Fc55d869A6';
const TRADER_A = '0x38D8054789aB2068C3E6B04382787eFE15617ac7';
const TRADER_B = '0xeAE58347aA643a228C88Bd62295651388163E1CA';
const FEE_TIER = 3000;
const SOURCE_SHA = process.env.GITHUB_SHA || 'local';
const OUT = process.env.RH46630_LIFECYCLE_EVIDENCE || 'rh46630-native-lifecycle-evidence.json';
const mode = process.argv.includes('--reconcile') ? 'reconcile' : 'execute';

const req = (name) => {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`MISSING_PROTECTED_INPUT_${name}`);
  return value;
};
const same = (a,b) => String(a).toLowerCase() === String(b).toLowerCase();
const assert = (v,m) => { if (!v) throw new Error(m); };
const codeHash = (code) => ethers.keccak256(code);
const errText = (e) => String(e?.shortMessage || e?.reason || e?.message || e);

const factoryAbi = [
  'function owner() view returns(address)','function FACTORY_GENERATION() view returns(uint32)','function CAMPAIGN_GENERATION() view returns(uint32)',
  'function liquidityKind() view returns(uint8)','function campaignImplementation() view returns(address)','function router() view returns(address)',
  'function graduationOracle() view returns(address)','function permanentLpLocker() view returns(address)','function leagueReceiver() view returns(address)',
  'function routeAuthority() view returns(address)','function live() view returns(bool)','function createPaused() view returns(bool)','function globalPaused() view returns(bool)',
  'function securityDefaultsLocked() view returns(bool)','function requireAuthorizedTrading() view returns(bool)','function requireRouteAuthorization() view returns(bool)',
  'function campaignsCount() view returns(uint256)','function enableLive()','function setCreatePaused(bool)','function setGlobalPaused(bool)',
  'function canCreatorLaunch(address) view returns(bool)',
  'function createCampaignAuthorized((string name,string symbol,string logoURI,string xAccount,string website,string extraLink,uint256 graduationTarget),(uint8 tradeRouteProfile,uint8 finalizeRouteProfile,uint64 deadline,bytes signature)) returns(address,address)',
  'function campaignGraduationRecorded(address) view returns(bool)',
  'event CampaignCreated(uint256 indexed id,address indexed campaign,address indexed token,address creator,string name,string symbol,string logoURI,string metadataURI)',
  'event CampaignGraduated(address indexed campaign,address indexed creator,address indexed lpToken,address locker)'
];
const campaignAbi = [
  'function token() view returns(address)','function creator() view returns(address)','function graduationTarget() view returns(uint256)','function graduationNativeTarget() view returns(uint256)',
  'function tradeRouteProfile() view returns(uint8)','function finalizeRouteProfile() view returns(uint8)','function requireAuthorizedTrading() view returns(bool)',
  'function launched() view returns(bool)','function netRaisedWei() view returns(uint256)','function sold() view returns(uint256)',
  'function quoteBuyExactBnb(uint256) view returns(uint256,uint256,uint256)','function quoteSellExactTokens(uint256) view returns(uint256)',
  'function buyExactBnbAuthorized(uint256,uint8,uint64,bytes) payable returns(uint256,uint256)',
  'function sellExactTokensAuthorized(uint256,uint256,uint8,uint64,bytes) returns(uint256)',
  'function graduateIfEligible(uint256,uint256) returns(uint256,uint256)',
  'function getGraduationState() view returns(address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)',
  'event TokensPurchased(address indexed buyer,uint256 amountOut,uint256 cost)','event TokensSold(address indexed seller,uint256 amountIn,uint256 payout)',
  'event CampaignFinalized(address indexed caller,address indexed pair,uint256 graduationBalance,uint256 graduationOvershoot,uint256 liquidityTokens,uint256 liquidityBnb,uint256 liquidityLp,uint256 protocolFee,uint256 creatorPayout,uint256 burnedUnsoldTokens,uint256 burnedUnusedLpTokens,uint256 finalCurvePrice,uint256 initialDexPrice,uint256 postBurnTotalSupply)'
];
const erc20Abi = ['function balanceOf(address) view returns(uint256)','function approve(address,uint256) returns(bool)','function allowance(address,address) view returns(uint256)','function totalSupply() view returns(uint256)'];
const adapterAbi = ['function liquidityKind() view returns(uint8)','function feeTier() view returns(uint24)','function v3Factory() view returns(address)','function positionManager() view returns(address)','function WETH() view returns(address)','function getPool(address,address,bool) view returns(address)'];
const lockerAbi = [
  'function positionManager() view returns(address)','function v3Factory() view returns(address)','function wrappedNative() view returns(address)','function configuredFeeTier() view returns(uint24)',
  'function registeredLpToken(address) view returns(bool)','function registrationCount() view returns(uint256)',
  'function poolInfo(address) view returns(address campaign,address creator,address creatorFeeRecipient,address pool,address token0,address token1,uint256 tokenId,uint128 lockedLiquidity,uint24 feeTier,uint16 creatorFeeBps,uint16 protocolFeeBps,bool registered)',
  'function harvest(address) returns(uint256,uint256)','event FeesHarvested(address indexed pool,address indexed caller,address indexed token,uint256 collected,uint256 creatorPaid,uint256 protocolRouted)'
];
const pmAbi = [
  'function ownerOf(uint256) view returns(address)',
  'function positions(uint256) view returns(uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)'
];
const v3FactoryAbi = ['function getPool(address,address,uint24) view returns(address)'];
const routerAbi = [
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns(uint256 amountOut)',
  'function unwrapWETH9(uint256 amountMinimum,address recipient) payable',
  'function multicall(bytes[] data) payable returns(bytes[] results)'
];
const oracleAbi = ['function decimals() view returns(uint8)','function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)','function updater() view returns(address)'];
const treasuryAbi = ['function protocolRevenueVault() view returns(address)','event LpTokenRouted(address indexed locker,address indexed token,address indexed protocolRevenueVault,uint256 amount)','event RouteExecuted(uint8 indexed kind,uint8 indexed profile,address indexed campaign,uint256 amountIn,uint256 leagueAmount,uint256 creatorAmount,uint256 recruiterAmount,uint256 airdropAmount,uint256 squadAmount,uint256 protocolAmount)'];

function wallet(pkName, expected, provider) {
  const w = new ethers.Wallet(req(pkName), provider);
  assert(same(w.address, expected), `SIGNER_MISMATCH_${pkName}_${w.address}`);
  return w;
}
function makeCreateDigest(reqObj, tradeProfile, finalizeProfile, deadline) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const requestHash = ethers.keccak256(coder.encode(
    ['bytes32','bytes32','bytes32','bytes32','bytes32','bytes32','uint256'],
    [ethers.keccak256(ethers.toUtf8Bytes(reqObj.name)),ethers.keccak256(ethers.toUtf8Bytes(reqObj.symbol)),ethers.keccak256(ethers.toUtf8Bytes(reqObj.logoURI)),ethers.keccak256(ethers.toUtf8Bytes(reqObj.xAccount)),ethers.keccak256(ethers.toUtf8Bytes(reqObj.website)),ethers.keccak256(ethers.toUtf8Bytes(reqObj.extraLink)),reqObj.graduationTarget]
  ));
  return ethers.keccak256(coder.encode(['string','uint256','address','address','bytes32','uint8','uint8','uint64'],['MWZ_CREATE_ROUTE_AUTH',CHAIN_ID,FACTORY,CREATOR,requestHash,tradeProfile,finalizeProfile,deadline]));
}
function makeTradeDigest(campaign, actor, profile, action, amount, limit, deadline) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(coder.encode(['string','uint256','address','address','uint8','uint8','uint256','uint256','uint64'],['MWZ_ROUTE_TRADE_AUTH',CHAIN_ID,campaign,actor,profile,action,amount,limit,deadline]));
}
async function signDigest(w, digest) { return w.signMessage(ethers.getBytes(digest)); }
async function receiptEntry(provider, tx, label) {
  const r = await tx.wait(); assert(r?.status === 1, `${label}_RECEIPT_FAILED`);
  return {label,txHash:r.hash,blockNumber:r.blockNumber,gasUsed:r.gasUsed.toString()};
}
async function bal(provider, address) { return (await provider.getBalance(address)).toString(); }
async function tokenBal(token, address) { return (await token.balanceOf(address)).toString(); }
async function freshDeadline(provider, seq=0) { const b=await provider.getBlock('latest'); return Number(b.timestamp)+600+seq; }
async function safeCodeChecks(provider) {
  const expected = {FACTORY,CAMPAIGN_IMPL,ADAPTER,LOCKER,TREASURY,GRAD_ORACLE,WETH,V3_FACTORY,POSITION_MANAGER,SWAP_ROUTER,ETH_USD_ORACLE};
  const hashes={};
  for (const [k,a] of Object.entries(expected)) { const c=await provider.getCode(a); assert(c && c!=='0x',`MISSING_RUNTIME_${k}`); hashes[k]=codeHash(c); }
  return hashes;
}
function parseEvent(receipt, iface, name) {
  for (const log of receipt.logs) { try { const p=iface.parseLog(log); if (p?.name===name) return p; } catch {} }
  return null;
}
async function ensureRevert(promise,label) { try { await promise; throw new Error(`${label}_DID_NOT_REVERT`); } catch(e) { if (String(e.message).includes('_DID_NOT_REVERT')) throw e; return errText(e); } }

async function reconcile(provider, evidence) {
  const f = new ethers.Contract(FACTORY,factoryAbi,provider);
  const c = new ethers.Contract(evidence.campaign,campaignAbi,provider);
  const l = new ethers.Contract(LOCKER,lockerAbi,provider);
  const vf = new ethers.Contract(V3_FACTORY,v3FactoryAbi,provider);
  const pm = new ethers.Contract(POSITION_MANAGER,pmAbi,provider);
  const info = await l.poolInfo(evidence.pool);
  const canonicalPool = await vf.getPool(evidence.token,WETH,FEE_TIER);
  const owner = await pm.ownerOf(info.tokenId);
  const pos = await pm.positions(info.tokenId);
  assert(await c.launched(), 'RECONCILE_CAMPAIGN_NOT_LAUNCHED');
  assert(await f.campaignGraduationRecorded(evidence.campaign),'RECONCILE_GRADUATION_NOT_RECORDED');
  assert(same(canonicalPool,evidence.pool),'RECONCILE_POOL_MISMATCH');
  assert(info.registered && same(info.campaign,evidence.campaign),'RECONCILE_LOCKER_REGISTRATION_MISMATCH');
  assert(same(owner,LOCKER),'RECONCILE_POSITION_OWNER_MISMATCH');
  assert(pos[7] === info.lockedLiquidity,'RECONCILE_LIQUIDITY_MISMATCH');
  return {campaign:evidence.campaign,token:evidence.token,pool:evidence.pool,tokenId:info.tokenId.toString(),lockedLiquidity:info.lockedLiquidity.toString(),positionOwner:owner,registrationCount:(await l.registrationCount()).toString(),factoryCampaigns:(await f.campaignsCount()).toString(),createPaused:await f.createPaused(),globalPaused:await f.globalPaused(),live:await f.live()};
}

async function main() {
  const rpc=req('ROBINHOOD_TESTNET_RPC_URL');
  const provider=new ethers.JsonRpcProvider(rpc);
  const network=await provider.getNetwork();
  assert(Number(network.chainId)===CHAIN_ID,`WRONG_CHAIN_${network.chainId}`); assert(Number(network.chainId)!==FORBIDDEN_CHAIN_ID,'PRODUCTION_4663_FORBIDDEN');

  if (mode==='reconcile') {
    const evidence=JSON.parse(fs.readFileSync(OUT,'utf8'));
    const replay=await reconcile(provider,evidence);
    evidence.restartReconciliation=replay;
    fs.writeFileSync(OUT,JSON.stringify(evidence,null,2));
    console.log(JSON.stringify({mode:'reconcile',chainId:CHAIN_ID,campaign:evidence.campaign,token:evidence.token,pool:evidence.pool,tokenId:evidence.tokenId,restartReconciliation:replay},null,2));
    return;
  }

  const deployer=wallet('ROBINHOOD_TESTNET_DEPLOYER_PRIVATE_KEY',DEPLOYER,provider);
  const updater=wallet('ROBINHOOD_TESTNET_ORACLE_UPDATER_PRIVATE_KEY',UPDATER,provider);
  const creator=wallet('ROBINHOOD_TESTNET_CREATOR_PRIVATE_KEY',CREATOR,provider);
  const traderA=wallet('ROBINHOOD_TESTNET_TRADER_A_PRIVATE_KEY',TRADER_A,provider);
  const traderB=wallet('ROBINHOOD_TESTNET_TRADER_B_PRIVATE_KEY',TRADER_B,provider);
  const runtimeCodeHashes=await safeCodeChecks(provider);
  const factory=new ethers.Contract(FACTORY,factoryAbi,deployer);
  const adapter=new ethers.Contract(ADAPTER,adapterAbi,provider);
  const locker=new ethers.Contract(LOCKER,lockerAbi,traderA);
  const extOracle=new ethers.Contract(ETH_USD_ORACLE,oracleAbi,provider);
  const treasury=new ethers.Contract(TREASURY,treasuryAbi,provider);

  assert(await factory.FACTORY_GENERATION()===4n,'FACTORY_GENERATION_NOT_4');
  assert(await factory.CAMPAIGN_GENERATION()===3n,'CAMPAIGN_GENERATION_NOT_3');
  assert(await factory.liquidityKind()===2n,'LIQUIDITY_KIND_NOT_2');
  assert(same(await factory.campaignImplementation(),CAMPAIGN_IMPL),'CAMPAIGN_IMPL_MISMATCH');
  assert(same(await factory.router(),ADAPTER),'FACTORY_ADAPTER_MISMATCH');
  assert(same(await factory.graduationOracle(),GRAD_ORACLE),'GRAD_ORACLE_MISMATCH');
  assert(same(await factory.permanentLpLocker(),LOCKER),'LOCKER_MISMATCH');
  assert(same(await factory.leagueReceiver(),TREASURY),'TREASURY_MISMATCH');
  assert(same(await factory.owner(),DEPLOYER),'FACTORY_OWNER_MISMATCH');
  assert(same(await factory.routeAuthority(),UPDATER),'ROUTE_AUTHORITY_MISMATCH');
  assert(await factory.securityDefaultsLocked(),'SECURITY_DEFAULTS_NOT_LOCKED');
  assert(await factory.requireAuthorizedTrading(),'AUTHORIZED_TRADING_NOT_REQUIRED');
  assert(await factory.requireRouteAuthorization(),'ROUTE_AUTH_NOT_REQUIRED');
  assert(await adapter.liquidityKind()===2n,'ADAPTER_KIND_NOT_2');
  assert(await adapter.feeTier()===3000n,'FEE_TIER_NOT_3000');
  assert(same(await adapter.v3Factory(),V3_FACTORY),'V3_FACTORY_MISMATCH');
  assert(same(await adapter.positionManager(),POSITION_MANAGER),'POSITION_MANAGER_MISMATCH');
  assert(same(await adapter.WETH(),WETH),'WETH_MISMATCH');
  assert(same(await locker.positionManager(),POSITION_MANAGER),'LOCKER_PM_MISMATCH');
  assert(same(await locker.v3Factory(),V3_FACTORY),'LOCKER_FACTORY_MISMATCH');
  assert(same(await locker.wrappedNative(),WETH),'LOCKER_WETH_MISMATCH');
  assert(await locker.configuredFeeTier()===3000n,'LOCKER_FEE_TIER_MISMATCH');

  const decimals=Number(await extOracle.decimals());
  const round=await extOracle.latestRoundData();
  const latest=await provider.getBlock('latest');
  const age=Number(latest.timestamp)-Number(round.updatedAt);
  assert(decimals===8,'ORACLE_DECIMALS_NOT_8'); assert(round.answer>0n,'ORACLE_ANSWER_NOT_POSITIVE');
  if (age>=900) {
    console.log('Agent 4 Robinhood Testnet Oracle Refresh Dispatcher');
    console.log('REFRESH_CHAIN_46630_ETH_USD_ORACLE');
    console.log(`eth_usd_8=${round.answer.toString()}`);
    throw new Error(`ORACLE_STALE_AGE_SECONDS_${age}`);
  }

  const preState={sourceSha:SOURCE_SHA,chainId:CHAIN_ID,productionChainId:FORBIDDEN_CHAIN_ID,productionCompatible:false,factoryGeneration:4,campaignGeneration:3,liquidityKind:2,feeTier:FEE_TIER,factoryLive:await factory.live(),createPaused:await factory.createPaused(),globalPaused:await factory.globalPaused(),securityDefaultsLocked:await factory.securityDefaultsLocked(),oracle:{address:ETH_USD_ORACLE,decimals,answer:round.answer.toString(),updatedAt:round.updatedAt.toString(),ageSeconds:age},runtimeCodeHashes,balances:{deployer:await bal(provider,DEPLOYER),creator:await bal(provider,CREATOR),traderA:await bal(provider,TRADER_A),traderB:await bal(provider,TRADER_B),adapter:await bal(provider,ADAPTER),locker:await bal(provider,LOCKER),treasury:await bal(provider,TREASURY)}};
  assert(preState.factoryLive===false,'FACTORY_NOT_INITIAL_FAIL_CLOSED_LIVE_FALSE'); assert(preState.createPaused===true,'FACTORY_NOT_INITIAL_CREATE_PAUSED');
  assert(await factory.canCreatorLaunch(CREATOR),'CREATOR_NOT_ELIGIBLE');

  const txs=[];
  try {
    txs.push(await receiptEntry(provider,await factory.enableLive(),'enableLive'));
    txs.push(await receiptEntry(provider,await factory.setCreatePaused(false),'openCreateForCertification'));

    const stamp=(await provider.getBlockNumber()).toString().slice(-6);
    const request={name:`RH46630 Native Cert ${stamp}`,symbol:`RH${stamp.slice(-4)}`,logoURI:'ipfs://mwz-rh46630-native-cert',xAccount:'',website:'',extraLink:'',graduationTarget:ethers.parseEther('6')};
    const tradeProfile=1, finalizeProfile=1;
    const createDeadline=await freshDeadline(provider,1);
    const createSig=await signDigest(updater,makeCreateDigest(request,tradeProfile,finalizeProfile,createDeadline));
    const fCreator=factory.connect(creator);
    const createBefore={creatorEth:await bal(provider,CREATOR),campaigns:(await factory.campaignsCount()).toString()};
    const createTx=await fCreator.createCampaignAuthorized(request,{tradeRouteProfile:tradeProfile,finalizeRouteProfile:finalizeProfile,deadline:createDeadline,signature:createSig});
    const createReceipt=await createTx.wait(); assert(createReceipt.status===1,'CREATE_FAILED');
    txs.push({label:'CREATE',txHash:createReceipt.hash,blockNumber:createReceipt.blockNumber,gasUsed:createReceipt.gasUsed.toString()});
    const created=parseEvent(createReceipt,factory.interface,'CampaignCreated'); assert(created,'CAMPAIGN_CREATED_EVENT_MISSING');
    const campaignAddress=created.args.campaign, tokenAddress=created.args.token;
    const campaign=new ethers.Contract(campaignAddress,campaignAbi,provider);
    const token=new ethers.Contract(tokenAddress,erc20Abi,provider);
    assert(same(await campaign.creator(),CREATOR),'CAMPAIGN_CREATOR_MISMATCH');
    assert(same(await campaign.token(),tokenAddress),'CAMPAIGN_TOKEN_MISMATCH');
    assert(await campaign.graduationTarget()===request.graduationTarget,'CAMPAIGN_TARGET_MISMATCH');
    assert(await campaign.requireAuthorizedTrading(),'CAMPAIGN_AUTH_TRADING_NOT_REQUIRED');
    const target=await campaign.graduationNativeTarget(); assert(target>0n,'NATIVE_TARGET_ZERO');

    async function authBuy(walletObj,actor,value,label,seq) {
      const c=campaign.connect(walletObj); const q=await c.quoteBuyExactBnb(value); assert(q[0]>0n,`${label}_QUOTE_ZERO`);
      const deadline=await freshDeadline(provider,10+seq); const sig=await signDigest(updater,makeTradeDigest(campaignAddress,actor,tradeProfile,1,value,0n,deadline));
      const before={eth:await bal(provider,actor),token:await tokenBal(token,actor),netRaised:(await campaign.netRaisedWei()).toString()};
      const t=await c.buyExactBnbAuthorized(0,tradeProfile,deadline,sig,{value}); const r=await t.wait(); assert(r.status===1,`${label}_FAILED`);
      const after={eth:await bal(provider,actor),token:await tokenBal(token,actor),netRaised:(await campaign.netRaisedWei()).toString()};
      txs.push({label,txHash:r.hash,blockNumber:r.blockNumber,gasUsed:r.gasUsed.toString()});
      return {before,after,receipt:r};
    }
    async function authSell(walletObj,actor,amount,label,seq) {
      const c=campaign.connect(walletObj); const tok=token.connect(walletObj); const approve=await tok.approve(campaignAddress,amount); txs.push(await receiptEntry(provider,approve,`${label}_approve`));
      const quoted=await c.quoteSellExactTokens(amount); const min=quoted*99n/100n; const deadline=await freshDeadline(provider,30+seq); const sig=await signDigest(updater,makeTradeDigest(campaignAddress,actor,tradeProfile,2,amount,min,deadline));
      const before={eth:await bal(provider,actor),token:await tokenBal(token,actor),netRaised:(await campaign.netRaisedWei()).toString()};
      const t=await c.sellExactTokensAuthorized(amount,min,tradeProfile,deadline,sig); const r=await t.wait(); assert(r.status===1,`${label}_FAILED`);
      const after={eth:await bal(provider,actor),token:await tokenBal(token,actor),netRaised:(await campaign.netRaisedWei()).toString()};
      txs.push({label,txHash:r.hash,blockNumber:r.blockNumber,gasUsed:r.gasUsed.toString()});
      return {before,after};
    }

    let firstValue=target/5n; if(firstValue<10000000000000n) firstValue=10000000000000n;
    const preGradBuy=await authBuy(traderA,TRADER_A,firstValue,'preGradBuy',1); assert(!(await campaign.launched()),'GRADUATED_TOO_EARLY_AFTER_FIRST_BUY');
    const aTokens=BigInt(preGradBuy.after.token); const sellAmount=aTokens/3n; assert(sellAmount>0n,'SELL_AMOUNT_ZERO');
    const preGradSell=await authSell(traderA,TRADER_A,sellAmount,'preGradSell',1); assert(!(await campaign.launched()),'GRADUATED_DURING_SELL');

    let seq=0; let graduationReceipt=null;
    while(!(await campaign.launched()) && seq<12) {
      const raised=await campaign.netRaisedWei(); const remaining=target>raised?target-raised:1n; let value=remaining+remaining/20n+1n;
      const actor=seq%2===0?TRADER_B:TRADER_A; const w=seq%2===0?traderB:traderA;
      const res=await authBuy(w,actor,value,`bondBuy${seq+1}`,50+seq); if(await campaign.launched()) graduationReceipt=res.receipt; seq++;
    }
    assert(await campaign.launched(),'GRADUATION_DID_NOT_COMPLETE'); assert(graduationReceipt,'GRADUATION_RECEIPT_MISSING');
    const gradEvent=parseEvent(graduationReceipt,campaign.interface,'CampaignFinalized'); assert(gradEvent,'CAMPAIGN_FINALIZED_EVENT_MISSING');
    const g=await campaign.getGraduationState(); const pool=g[0]; assert(pool && pool!==ethers.ZeroAddress,'POOL_MISSING');
    const vf=new ethers.Contract(V3_FACTORY,v3FactoryAbi,provider); const canonicalPool=await vf.getPool(tokenAddress,WETH,FEE_TIER); assert(same(pool,canonicalPool),'CANONICAL_POOL_MISMATCH');
    const poolInfo=await locker.poolInfo(pool); assert(poolInfo.registered,'LOCKER_NOT_REGISTERED'); assert(same(poolInfo.campaign,campaignAddress),'LOCKER_CAMPAIGN_MISMATCH'); assert(poolInfo.feeTier===3000n,'LOCKER_POOL_FEE_MISMATCH');
    const tokenId=poolInfo.tokenId; const pm=new ethers.Contract(POSITION_MANAGER,pmAbi,provider); assert(same(await pm.ownerOf(tokenId),LOCKER),'POSITION_NOT_OWNED_BY_LOCKER'); const pos=await pm.positions(tokenId); assert(pos[7]===poolInfo.lockedLiquidity,'LOCKED_LIQUIDITY_MISMATCH');
    const pairOk=(same(poolInfo.token0,tokenAddress)&&same(poolInfo.token1,WETH))||(same(poolInfo.token1,tokenAddress)&&same(poolInfo.token0,WETH)); assert(pairOk,'TOKEN_WETH_ORDERING_INVALID');
    const duplicateGraduationRevert=await ensureRevert(campaign.connect(traderA).graduateIfEligible.staticCall(0,0),'DUPLICATE_GRADUATION');
    const duplicateCreateRevert=await ensureRevert(fCreator.createCampaignAuthorized.staticCall(request,{tradeRouteProfile:tradeProfile,finalizeRouteProfile:finalizeProfile,deadline:createDeadline,signature:createSig}),'CREATE_AUTH_REPLAY');

    const adapterTokenBefore=await token.balanceOf(ADAPTER); const adapterWethBefore=new ethers.Contract(WETH,erc20Abi,provider); const adapterWethBal=await adapterWethBefore.balanceOf(ADAPTER); const adapterEth=await provider.getBalance(ADAPTER); assert(adapterTokenBefore===0n,'ADAPTER_TOKEN_RESIDUAL'); assert(adapterWethBal===0n,'ADAPTER_WETH_RESIDUAL'); assert(adapterEth===0n,'ADAPTER_ETH_RESIDUAL');

    const swapRouter=new ethers.Contract(SWAP_ROUTER,routerAbi,traderA); const postBuyIn=target/20n>10000000000000n?target/20n:10000000000000n;
    const postBuyBefore={eth:await bal(provider,TRADER_A),token:await tokenBal(token,TRADER_A)};
    const buySwap=await swapRouter.exactInputSingle({tokenIn:WETH,tokenOut:tokenAddress,fee:FEE_TIER,recipient:TRADER_A,amountIn:postBuyIn,amountOutMinimum:0,sqrtPriceLimitX96:0},{value:postBuyIn}); txs.push(await receiptEntry(provider,buySwap,'postGradNativeBuy'));
    const postBuyAfter={eth:await bal(provider,TRADER_A),token:await tokenBal(token,TRADER_A)}; assert(BigInt(postBuyAfter.token)>BigInt(postBuyBefore.token),'POSTGRAD_BUY_NO_TOKEN_DELTA');
    const bought=BigInt(postBuyAfter.token)-BigInt(postBuyBefore.token); const sellPost=bought/2n; assert(sellPost>0n,'POSTGRAD_SELL_ZERO');
    const approvePost=await token.connect(traderA).approve(SWAP_ROUTER,sellPost); txs.push(await receiptEntry(provider,approvePost,'postGradSellApprove'));
    const routerIface=new ethers.Interface(routerAbi); const swapData=routerIface.encodeFunctionData('exactInputSingle',[{tokenIn:tokenAddress,tokenOut:WETH,fee:FEE_TIER,recipient:SWAP_ROUTER,amountIn:sellPost,amountOutMinimum:0,sqrtPriceLimitX96:0}]); const unwrapData=routerIface.encodeFunctionData('unwrapWETH9',[0,TRADER_A]);
    const postSellBefore={eth:await bal(provider,TRADER_A),token:await tokenBal(token,TRADER_A)}; const sellTx=await swapRouter.multicall([swapData,unwrapData]); txs.push(await receiptEntry(provider,sellTx,'postGradNativeSell')); const postSellAfter={eth:await bal(provider,TRADER_A),token:await tokenBal(token,TRADER_A)}; assert(BigInt(postSellAfter.token)<BigInt(postSellBefore.token),'POSTGRAD_SELL_NO_TOKEN_DELTA');

    const protocolVault=await treasury.protocolRevenueVault(); const creatorTokenBefore=await token.balanceOf(CREATOR); const protocolTokenBefore=await token.balanceOf(protocolVault); const creatorWethBefore=await adapterWethBefore.balanceOf(CREATOR); const protocolWethBefore=await adapterWethBefore.balanceOf(protocolVault);
    const harvestTx=await locker.harvest(pool); const harvestReceipt=await harvestTx.wait(); assert(harvestReceipt.status===1,'HARVEST_FAILED'); txs.push({label:'feeHarvest',txHash:harvestReceipt.hash,blockNumber:harvestReceipt.blockNumber,gasUsed:harvestReceipt.gasUsed.toString()});
    const feeEvents=[]; for(const log of harvestReceipt.logs){try{const p=locker.interface.parseLog(log);if(p?.name==='FeesHarvested')feeEvents.push({token:p.args.token,collected:p.args.collected.toString(),creatorPaid:p.args.creatorPaid.toString(),protocolRouted:p.args.protocolRouted.toString()});}catch{}}
    assert(feeEvents.length>0 && feeEvents.some(x=>BigInt(x.collected)>0n),'NO_V3_FEES_HARVESTED');
    const feeAfter={creatorToken:(await token.balanceOf(CREATOR)).toString(),protocolToken:(await token.balanceOf(protocolVault)).toString(),creatorWeth:(await adapterWethBefore.balanceOf(CREATOR)).toString(),protocolWeth:(await adapterWethBefore.balanceOf(protocolVault)).toString()};

    await (await factory.setCreatePaused(true)).wait(); await (await factory.setGlobalPaused(true)).wait();
    const postState={factoryLive:await factory.live(),createPaused:await factory.createPaused(),globalPaused:await factory.globalPaused(),securityDefaultsLocked:await factory.securityDefaultsLocked(),requireAuthorizedTrading:await factory.requireAuthorizedTrading(),requireRouteAuthorization:await factory.requireRouteAuthorization()}; assert(postState.createPaused&&postState.globalPaused,'POST_TEST_NOT_FAIL_CLOSED');

    const evidence={sourceSha:SOURCE_SHA,chainId:CHAIN_ID,productionChainId:FORBIDDEN_CHAIN_ID,productionCompatible:false,preState,createBefore,campaign:campaignAddress,token:tokenAddress,pool,token0:poolInfo.token0,token1:poolInfo.token1,feeTier:FEE_TIER,tokenId:tokenId.toString(),lockedLiquidity:poolInfo.lockedLiquidity.toString(),locker:LOCKER,positionOwner:await pm.ownerOf(tokenId),graduation:{txHash:graduationReceipt.hash,blockNumber:graduationReceipt.blockNumber,nativeTarget:target.toString(),graduationBalance:g[9].toString(),graduationOvershoot:g[10].toString(),liquidityTokens:g[3].toString(),liquidityNative:g[4].toString(),liquidity:g[5].toString()},preGradBuy,preGradSell,postGradBuy:{before:postBuyBefore,after:postBuyAfter},postGradSell:{before:postSellBefore,after:postSellAfter},adapterResiduals:{token:adapterTokenBefore.toString(),weth:adapterWethBal.toString(),eth:adapterEth.toString()},feeProvenance:{treasury:TREASURY,protocolVault,events:feeEvents,before:{creatorToken:creatorTokenBefore.toString(),protocolToken:protocolTokenBefore.toString(),creatorWeth:creatorWethBefore.toString(),protocolWeth:protocolWethBefore.toString()},after:feeAfter},replay:{duplicateGraduationRevert,duplicateCreateRevert},txs,postState};
    evidence.sameProcessReconciliation=await reconcile(provider,evidence); fs.writeFileSync(OUT,JSON.stringify(evidence,null,2));
    console.log(JSON.stringify({mode:'execute',chainId:CHAIN_ID,campaign:campaignAddress,token:tokenAddress,pool,tokenId:tokenId.toString(),locker:LOCKER,txs,feeEvents,postState},null,2));
  } catch (e) {
    try { if(await factory.live()) { await (await factory.setCreatePaused(true)).wait(); await (await factory.setGlobalPaused(true)).wait(); } } catch {}
    throw e;
  }
}
main().catch((e)=>{console.error(errText(e));process.exit(1);});
