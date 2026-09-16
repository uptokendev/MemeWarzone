import { ethers } from 'ethers';

const CHAIN_ID = 46630;
const FORBIDDEN_CHAIN_ID = 4663;
const FACTORY = '0xd03D1CC03d108B7F9b2195489DC6CFda1FB1a943';
const UPDATER = '0xE755A2c52654b2133c7A4fdC5349821C6527A766';
const CREATOR = '0xf0558484531204645fB6eaF35c5082Fc55d869A6';
const TRADER_A = '0x38D8054789aB2068C3E6B04382787eFE15617ac7';

const factoryAbi = [
  'function createCampaignAuthorized((string name,string symbol,string logoURI,string xAccount,string website,string extraLink,uint256 graduationTarget),(uint8 tradeRouteProfile,uint8 finalizeRouteProfile,uint64 deadline,bytes signature)) returns(address,address)',
  'function routeAuthority() view returns(address)'
];
const req = (name) => {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`MISSING_PROTECTED_INPUT_${name}`);
  return value;
};
const same = (a,b) => String(a).toLowerCase() === String(b).toLowerCase();
const assert = (v,m) => { if (!v) throw new Error(m); };
const errText = (e) => String(e?.shortMessage || e?.reason || e?.message || e);
function wallet(name, expected, provider) {
  const w = new ethers.Wallet(req(name), provider);
  assert(same(w.address, expected), `SIGNER_MISMATCH_${name}_${w.address}`);
  return w;
}
function requestHash(r) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(coder.encode(
    ['bytes32','bytes32','bytes32','bytes32','bytes32','bytes32','uint256'],
    [ethers.keccak256(ethers.toUtf8Bytes(r.name)),ethers.keccak256(ethers.toUtf8Bytes(r.symbol)),ethers.keccak256(ethers.toUtf8Bytes(r.logoURI)),ethers.keccak256(ethers.toUtf8Bytes(r.xAccount)),ethers.keccak256(ethers.toUtf8Bytes(r.website)),ethers.keccak256(ethers.toUtf8Bytes(r.extraLink)),r.graduationTarget]
  ));
}
function createDigest(creator, r, tradeProfile, finalizeProfile, deadline) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['string','uint256','address','address','bytes32','uint8','uint8','uint64'],
    ['MWZ_CREATE_ROUTE_AUTH',CHAIN_ID,FACTORY,creator,requestHash(r),tradeProfile,finalizeProfile,deadline]
  ));
}
async function mustRevert(promise,label) {
  try { await promise; throw new Error(`${label}_DID_NOT_REVERT`); }
  catch(e) { if (String(e?.message).includes('_DID_NOT_REVERT')) throw e; return errText(e); }
}

async function main() {
  const provider = new ethers.JsonRpcProvider(req('ROBINHOOD_TESTNET_RPC_URL'));
  const network = await provider.getNetwork();
  assert(Number(network.chainId) === CHAIN_ID, `WRONG_CHAIN_${network.chainId}`);
  assert(Number(network.chainId) !== FORBIDDEN_CHAIN_ID, 'PRODUCTION_4663_FORBIDDEN');
  const updater = wallet('ROBINHOOD_TESTNET_ORACLE_UPDATER_PRIVATE_KEY',UPDATER,provider);
  const creator = wallet('ROBINHOOD_TESTNET_CREATOR_PRIVATE_KEY',CREATOR,provider);
  const traderA = wallet('ROBINHOOD_TESTNET_TRADER_A_PRIVATE_KEY',TRADER_A,provider);
  const factory = new ethers.Contract(FACTORY,factoryAbi,provider);
  assert(same(await factory.routeAuthority(),UPDATER),'ROUTE_AUTHORITY_MISMATCH');

  const latest = await provider.getBlock('latest');
  const deadline = Number(latest.timestamp) + 600;
  const campaignRequest = {name:'RH46630 Fault Preflight',symbol:'RHF',logoURI:'ipfs://rh46630-fault-preflight',xAccount:'',website:'',extraLink:'',graduationTarget:ethers.parseEther('6')};
  const tradeProfile=1, finalizeProfile=1;

  // A non-authority signer cannot authorize creation.
  const badAuthoritySig = await creator.signMessage(ethers.getBytes(createDigest(CREATOR,campaignRequest,tradeProfile,finalizeProfile,deadline)));
  const unauthorizedRoute = await mustRevert(
    factory.connect(creator).createCampaignAuthorized.staticCall(campaignRequest,{tradeRouteProfile:tradeProfile,finalizeRouteProfile:finalizeProfile,deadline,signature:badAuthoritySig}),
    'UNAUTHORIZED_ROUTE'
  );

  // A valid authority signature bound to Creator cannot be replayed by Trader A.
  const creatorBoundSig = await updater.signMessage(ethers.getBytes(createDigest(CREATOR,campaignRequest,tradeProfile,finalizeProfile,deadline)));
  const wrongSigner = await mustRevert(
    factory.connect(traderA).createCampaignAuthorized.staticCall(campaignRequest,{tradeRouteProfile:tradeProfile,finalizeRouteProfile:finalizeProfile,deadline,signature:creatorBoundSig}),
    'WRONG_CREATOR_SIGNER'
  );

  console.log(JSON.stringify({chainId:CHAIN_ID,production4663Rejected:true,routeAuthority:UPDATER,unauthorizedRouteRejected:true,unauthorizedRoute,wrongSignerRejected:true,wrongSigner},null,2));
}
main().catch((e)=>{console.error(errText(e));process.exit(1);});
