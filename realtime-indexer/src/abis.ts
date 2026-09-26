export const CAMPAIGN_CREATED_EVENT_V3 =
  "event CampaignCreated(uint256 indexed id,address indexed campaign,address indexed token,address creator,string name,string symbol,string logoURI,string metadataURI)";

export const CAMPAIGN_CREATED_EVENT_V2 =
  "event CampaignCreated(uint256 indexed id,address indexed campaign,address indexed token,address creator,string name,string symbol,string logoURI)";

export const CAMPAIGN_CREATED_EVENT_LEGACY =
  "event CampaignCreated(uint256 indexed id,address indexed campaign,address indexed token,address creator,string name,string symbol)";

export const LAUNCH_FACTORY_ABI = [
  CAMPAIGN_CREATED_EVENT_V3,
  "event CampaignGraduated(address indexed campaign,address indexed creator,address indexed lpToken,address locker)",

  // Current generation registry shape. metadataURI was inserted before the
  // social/link fields, so createdAt is tuple index 10 rather than index 9.
  "function campaignsCount() view returns (uint256)",
  "function getCampaign(uint256 id) view returns (tuple(address campaign,address token,address creator,string name,string symbol,string logoURI,string metadataURI,string xAccount,string website,string extraLink,uint64 createdAt))",
  "function router() view returns (address)",
  // The treasury router (fee recipient). router() is the DEX router, not this.
  "function feeRecipient() view returns (address)"
];

export const LEGACY_LAUNCH_FACTORY_ABI = [
  CAMPAIGN_CREATED_EVENT_LEGACY,
  "event CampaignGraduated(address indexed campaign,address indexed creator,address indexed lpToken,address locker)",
  "function campaignsCount() view returns (uint256)",
  "function getCampaign(uint256 id) view returns (tuple(address campaign,address token,address creator,string name,string symbol,string logoURI,string xAccount,string website,string extraLink,uint64 createdAt))",
  "function router() view returns (address)"
];

export const LAUNCH_CAMPAIGN_ABI = [
  "event TokensPurchased(address indexed buyer,uint256 amountOut,uint256 cost)",
  "event TokensSold(address indexed seller,uint256 amountIn,uint256 payout)",
  // Current gen-3 full graduation event (pair + prices + burns). Older short shape is no longer active.
  "event CampaignFinalized(address indexed caller,address indexed pair,uint256 graduationBalance,uint256 graduationOvershoot,uint256 liquidityTokens,uint256 liquidityBnb,uint256 liquidityLp,uint256 protocolFee,uint256 creatorPayout,uint256 burnedUnsoldTokens,uint256 burnedUnusedLpTokens,uint256 finalCurvePrice,uint256 initialDexPrice,uint256 postBurnTotalSupply)",
  "function feeRecipient() view returns (address)",
  "function token() view returns (address)",
  "function router() view returns (address)",
  "function factory() view returns (address)",
  "function launched() view returns (bool)",
  "function getGraduationState() view returns (address dexPair,uint256 finalCurvePrice,uint256 initialDexPrice,uint256 graduatedLiquidityTokens,uint256 graduatedLiquidityBnb,uint256 graduatedLiquidityLp,uint256 burnedUnsoldTokens,uint256 burnedUnusedLpTokens,uint256 postBurnTotalSupply,uint256 graduationBalance,uint256 graduationOvershoot)",
];

export const TOPAZ_ROUTER_ADAPTER_ABI = [
  "function topazRouter() view returns (address)",
  "function poolFactory() view returns (address)",
  "function WETH() view returns (address)",
];

export const TOPAZ_PRODUCTION_ROUTER_ABI = [
  "function defaultFactory() view returns (address)",
  "function weth() view returns (address)",
];

export const TOPAZ_FACTORY_ABI = [
  "function getPool(address tokenA,address tokenB,bool stable) view returns (address pool)",
  "function getFee(address pool,bool stable) view returns (uint256)",
  "function getFee(address pool) view returns (uint256)",
];

export const TOPAZ_POOL_ABI = [
  "event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)",
  "event Sync(uint256 reserve0,uint256 reserve1)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function stable() view returns (bool)",
  "function getReserves() view returns (uint256 reserve0,uint256 reserve1,uint256 blockTimestampLast)",
  "function fee() view returns (uint256)",
  "function swapFee() view returns (uint256)",
];

// TreasuryRouterV2 (old BNB router 0xe157a6FD...).
export const TREASURY_ROUTER_ABI = [
  "event RouteExecuted(uint8 indexed kind,uint8 indexed profile,uint256 amountIn,uint256 leagueAmount,uint256 recruiterAmount,uint256 airdropAmount,uint256 squadAmount,uint256 protocolAmount)",
];

// TreasuryRouterV3 (BNB 0xe635AA43..., Robinhood 0xda0a9Ed9...): adds the campaign and the creator slice,
// so its topic0 differs and a V2-only filter matches none of its logs.
export const TREASURY_ROUTER_V3_ABI = [
  "event RouteExecuted(uint8 indexed kind,uint8 indexed profile,address indexed campaign,uint256 amountIn,uint256 leagueAmount,uint256 creatorAmount,uint256 recruiterAmount,uint256 airdropAmount,uint256 squadAmount,uint256 protocolAmount)",
];

// UPVoteTreasury (paid upvote events)
export const UP_VOTE_TREASURY_ABI = [
  "event VoteCast(address indexed campaign,address indexed voter,address indexed asset,uint256 amountPaid,bytes32 meta)",
];
