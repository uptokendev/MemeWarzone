import fs from 'node:fs';
import { ethers } from 'ethers';

const CHAIN_ID = 46630;
const FORBIDDEN_CHAIN_ID = 4663;
const LOCKER = '0x1977178fDeAcE51318cA22B57dfdD246461b9f24';
const TREASURY = '0x144170c53ADBc5cF7Ec454612C948B931e231C9e';
const WETH = '0x52A47A33930B8a90a2000b1bA3CB96e879569670';
const TRADER_A = '0x38D8054789aB2068C3E6B04382787eFE15617ac7';
const CREATOR = '0xf0558484531204645fB6eaF35c5082Fc55d869A6';
const OUT = process.env.RH46630_LIFECYCLE_EVIDENCE || 'rh46630-native-lifecycle-evidence.json';

const lockerAbi = [
  'function harvest(address) returns(uint256,uint256)',
  'function poolInfo(address) view returns(address campaign,address creator,address creatorFeeRecipient,address pool,address token0,address token1,uint256 tokenId,uint128 lockedLiquidity,uint24 feeTier,uint16 creatorFeeBps,uint16 protocolFeeBps,bool registered)',
  'event FeesHarvested(address indexed pool,address indexed caller,address indexed token,uint256 collected,uint256 creatorPaid,uint256 protocolRouted)'
];
const treasuryAbi = ['function protocolRevenueVault() view returns(address)'];
const erc20Abi = ['function balanceOf(address) view returns(uint256)'];
const pmAbi = ['function ownerOf(uint256) view returns(address)','function positions(uint256) view returns(uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)'];
const POSITION_MANAGER = '0xfF64Bd6970966dB58F0dd65BA76669D3b8BE9eC4';

const req=(n)=>{const v=String(process.env[n]||'').trim();if(!v)throw new Error(`MISSING_PROTECTED_INPUT_${n}`);return v;};
const same=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
const assert=(v,m)=>{if(!v)throw new Error(m);};
const errText=(e)=>String(e?.shortMessage||e?.reason||e?.message||e);
async function mustRevert(provider,tx,label){try{await provider.call(tx);throw new Error(`${label}_DID_NOT_REVERT`);}catch(e){if(String(e?.message).includes('_DID_NOT_REVERT'))throw e;return errText(e);}}

async function main(){
  const provider=new ethers.JsonRpcProvider(req('ROBINHOOD_TESTNET_RPC_URL'));
  const network=await provider.getNetwork();
  assert(Number(network.chainId)===CHAIN_ID,`WRONG_CHAIN_${network.chainId}`);
  assert(Number(network.chainId)!==FORBIDDEN_CHAIN_ID,'PRODUCTION_4663_FORBIDDEN');
  const trader=new ethers.Wallet(req('ROBINHOOD_TESTNET_TRADER_A_PRIVATE_KEY'),provider);
  assert(same(trader.address,TRADER_A),`SIGNER_MISMATCH_${trader.address}`);
  const evidence=JSON.parse(fs.readFileSync(OUT,'utf8'));
  const locker=new ethers.Contract(LOCKER,lockerAbi,trader);
  const treasury=new ethers.Contract(TREASURY,treasuryAbi,provider);
  const token=new ethers.Contract(evidence.token,erc20Abi,provider);
  const weth=new ethers.Contract(WETH,erc20Abi,provider);
  const protocolVault=await treasury.protocolRevenueVault();
  const info=await locker.poolInfo(evidence.pool);
  assert(info.registered,'POSTCHECK_POOL_NOT_REGISTERED');
  const pm=new ethers.Contract(POSITION_MANAGER,pmAbi,provider);
  const ownerBefore=await pm.ownerOf(info.tokenId);
  const posBefore=await pm.positions(info.tokenId);
  assert(same(ownerBefore,LOCKER),'POSTCHECK_POSITION_OWNER_CHANGED');
  assert(posBefore[7]===info.lockedLiquidity,'POSTCHECK_PRINCIPAL_CHANGED_BEFORE_RETRY');

  const before={creatorToken:(await token.balanceOf(CREATOR)).toString(),creatorWeth:(await weth.balanceOf(CREATOR)).toString(),protocolToken:(await token.balanceOf(protocolVault)).toString(),protocolWeth:(await weth.balanceOf(protocolVault)).toString()};
  const retry=await locker.harvest(evidence.pool);const receipt=await retry.wait();assert(receipt.status===1,'REPLAY_HARVEST_FAILED');
  const after={creatorToken:(await token.balanceOf(CREATOR)).toString(),creatorWeth:(await weth.balanceOf(CREATOR)).toString(),protocolToken:(await token.balanceOf(protocolVault)).toString(),protocolWeth:(await weth.balanceOf(protocolVault)).toString()};
  assert(JSON.stringify(before)===JSON.stringify(after),'REPLAY_HARVEST_DUPLICATED_FINANCIAL_STATE');
  const nonzero=[];for(const log of receipt.logs){try{const p=locker.interface.parseLog(log);if(p?.name==='FeesHarvested'&&p.args.collected>0n)nonzero.push(p.args.collected.toString());}catch{}}
  assert(nonzero.length===0,'REPLAY_HARVEST_COLLECTED_SECOND_CREDIT');

  const transferSelector=new ethers.Interface(['function transferFrom(address,address,uint256)']).encodeFunctionData('transferFrom',[LOCKER,TRADER_A,info.tokenId]);
  const decreaseSelector=new ethers.Interface(['function decreaseLiquidity(uint256,uint128,uint256,uint256,uint256)']).encodeFunctionData('decreaseLiquidity',[info.tokenId,1n,0n,0n,0n]);
  const transferRejected=await mustRevert(provider,{from:TRADER_A,to:LOCKER,data:transferSelector},'LOCKER_TRANSFER_SELECTOR');
  const decreaseRejected=await mustRevert(provider,{from:TRADER_A,to:LOCKER,data:decreaseSelector},'LOCKER_DECREASE_SELECTOR');

  const ownerAfter=await pm.ownerOf(info.tokenId);const posAfter=await pm.positions(info.tokenId);
  assert(same(ownerAfter,LOCKER),'POSTCHECK_POSITION_OWNER_CHANGED_AFTER_RETRY');
  assert(posAfter[7]===info.lockedLiquidity,'POSTCHECK_PRINCIPAL_CHANGED_AFTER_RETRY');
  evidence.retryFinancialNoOp={txHash:receipt.hash,blockNumber:receipt.blockNumber,before,after,nonzeroFeeEvents:nonzero,positionOwner:ownerAfter,lockedLiquidity:info.lockedLiquidity.toString()};
  evidence.permanentLockerFaults={transferRejected,decreaseLiquidityRejected:decreaseRejected};
  fs.writeFileSync(OUT,JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({chainId:CHAIN_ID,retryHarvestNoOp:true,txHash:receipt.hash,blockNumber:receipt.blockNumber,positionOwner:ownerAfter,lockedLiquidity:info.lockedLiquidity.toString(),transferRejected:true,decreaseLiquidityRejected:true},null,2));
}
main().catch((e)=>{console.error(errText(e));process.exit(1);});
