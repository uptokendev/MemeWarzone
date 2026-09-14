import { ethers } from 'ethers';

const CHAIN_ID = 46630;
const FORBIDDEN_CHAIN_ID = 4663;
const FACTORY = '0xa20388579323e22076b07e89Ac916aE6Ff91A0E0';
const LOCKER = '0x401B2F703B4756E0BC98dd4BCD92eaa9AaAd70c9';
const WETH = '0x52A47A33930B8a90a2000b1bA3CB96e879569670';
const V3_FACTORY = '0x948463E91d63a7A51cEeC0342735D1B738044aea';
const POSITION_MANAGER = '0xfF64Bd6970966dB58F0dd65BA76669D3b8BE9eC4';
const DEPLOY_BLOCK = 119497671;
const FEE_TIER = 3000;

const req = (name) => {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`MISSING_PROTECTED_INPUT_${name}`);
  return value;
};
const same=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
const factoryAbi = [
  'function live() view returns(bool)','function createPaused() view returns(bool)','function globalPaused() view returns(bool)','function campaignsCount() view returns(uint256)',
  'function getCampaign(uint256) view returns((address campaign,address token,address creator,string name,string symbol,string logoURI,string metadataURI,string xAccount,string website,string extraLink,uint64 createdAt))',
  'function campaignGraduationRecorded(address) view returns(bool)',
  'event CampaignCreated(uint256 indexed id,address indexed campaign,address indexed token,address creator,string name,string symbol,string logoURI,string metadataURI)',
  'event CampaignGraduated(address indexed campaign,address indexed creator,address indexed lpToken,address locker)',
  'event CreatePauseUpdated(bool paused)','event GlobalPauseUpdated(bool paused)','event LiveEnabled(uint64 at)'
];
const campaignAbi = [
  'function token() view returns(address)','function creator() view returns(address)','function launched() view returns(bool)','function netRaisedWei() view returns(uint256)','function sold() view returns(uint256)','function graduationNativeTarget() view returns(uint256)',
  'function graduationState() view returns(address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)'
];
const lockerAbi = ['function poolInfo(address) view returns(address campaign,address creator,address creatorFeeRecipient,address pool,address token0,address token1,uint256 tokenId,uint128 lockedLiquidity,uint24 feeTier,uint16 creatorFeeBps,uint16 protocolFeeBps,bool registered)'];
const v3FactoryAbi = ['function getPool(address,address,uint24) view returns(address)'];
const pmAbi = ['function ownerOf(uint256) view returns(address)','function positions(uint256) view returns(uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)'];

async function main(){
  const provider=new ethers.JsonRpcProvider(req('ROBINHOOD_TESTNET_RPC_URL'));
  const network=await provider.getNetwork();
  if(Number(network.chainId)!==CHAIN_ID) throw new Error(`WRONG_CHAIN_${network.chainId}`);
  if(Number(network.chainId)===FORBIDDEN_CHAIN_ID) throw new Error('PRODUCTION_4663_FORBIDDEN');
  const latest=await provider.getBlockNumber();
  const factory=new ethers.Contract(FACTORY,factoryAbi,provider);
  const count=await factory.campaignsCount();
  const iface=new ethers.Interface(factoryAbi);
  const topics={
    created: iface.getEvent('CampaignCreated').topicHash,
    graduated: iface.getEvent('CampaignGraduated').topicHash,
    live: iface.getEvent('LiveEnabled').topicHash,
    createPause: iface.getEvent('CreatePauseUpdated').topicHash,
    globalPause: iface.getEvent('GlobalPauseUpdated').topicHash,
  };
  const logs=await provider.getLogs({address:FACTORY,fromBlock:DEPLOY_BLOCK,toBlock:latest});
  const decoded=[];
  for(const log of logs){
    try{
      const p=iface.parseLog(log);
      if(['CampaignCreated','CampaignGraduated','LiveEnabled','CreatePauseUpdated','GlobalPauseUpdated'].includes(p.name)){
        const args={};
        for(let i=0;i<p.fragment.inputs.length;i++) args[p.fragment.inputs[i].name||String(i)]=typeof p.args[i]==='bigint'?p.args[i].toString():p.args[i];
        decoded.push({event:p.name,txHash:log.transactionHash,blockNumber:log.blockNumber,logIndex:log.index,args});
      }
    }catch{}
  }
  const campaigns=[];
  const start=count>5n?count-5n:0n;
  for(let i=start;i<count;i++){
    const info=await factory.getCampaign(i);
    const c=new ethers.Contract(info.campaign,campaignAbi,provider);
    const launched=await c.launched();
    const g=await c.graduationState();
    const pool=g[0];
    const row={
      id:i.toString(),campaign:info.campaign,token:info.token,creator:info.creator,name:info.name,symbol:info.symbol,createdAt:info.createdAt.toString(),
      launched,netRaisedWei:(await c.netRaisedWei()).toString(),sold:(await c.sold()).toString(),graduationNativeTarget:(await c.graduationNativeTarget()).toString(),
      graduationRecorded:await factory.campaignGraduationRecorded(info.campaign),pool,
      graduationBalance:g[9].toString(),graduationOvershoot:g[10].toString()
    };
    if(pool!==ethers.ZeroAddress){
      const locker=new ethers.Contract(LOCKER,lockerAbi,provider);
      const li=await locker.poolInfo(pool);
      row.locker={registered:li.registered,campaign:li.campaign,creator:li.creator,pool:li.pool,token0:li.token0,token1:li.token1,tokenId:li.tokenId.toString(),lockedLiquidity:li.lockedLiquidity.toString(),feeTier:li.feeTier.toString()};
      const vf=new ethers.Contract(V3_FACTORY,v3FactoryAbi,provider);
      row.canonicalPool=await vf.getPool(info.token,WETH,FEE_TIER);
      if(li.registered && li.tokenId>0n){
        const pm=new ethers.Contract(POSITION_MANAGER,pmAbi,provider);
        try{row.positionOwner=await pm.ownerOf(li.tokenId);const pos=await pm.positions(li.tokenId);row.positionLiquidity=pos[7].toString();}catch(e){row.positionReadError=String(e?.shortMessage||e?.message||e);}
      }
    }
    campaigns.push(row);
  }
  console.log(JSON.stringify({chainId:CHAIN_ID,latestBlock:latest,factory:{live:await factory.live(),createPaused:await factory.createPaused(),globalPaused:await factory.globalPaused(),campaignsCount:count.toString()},recentCampaigns:campaigns,relevantFactoryEvents:decoded.slice(-30)},null,2));
}
main().catch((e)=>{console.error(String(e?.shortMessage||e?.message||e));process.exit(1);});
