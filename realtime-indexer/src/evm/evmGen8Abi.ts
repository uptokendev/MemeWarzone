/**
 * EVM generation 8 (Uniswap V4 pool with the MemeWarzone hook): the events and views the indexer reads.
 * Signatures are copied from contracts/gen8/abi/*.abi.json on build/evm-gen8 (commit 5775ee7a) and the topic0 of each
 * one is pinned in src/tests/evmGen8Decode.test.ts against docs/evm-launch/GEN8_INTERNAL_AUDIT.md section 10.1.
 */
import { ethers } from "ethers";

export const GEN8_FACTORY_GENERATION = 8;
export const GEN8_CAMPAIGN_GENERATION = 8;

export const GEN8_LAUNCHER_EVENTS = [
  "event Launched(address indexed token, bytes32 indexed id, address indexed creator, address hookCreator, uint256 targetUsd, uint256 marketCapNative, uint256 virtualNative, uint256 virtualToken, int24 tickStart, int24 tickGrad, uint8 feeChoice, uint8 feeCreatorPct, uint256 firstBuyIn, uint256 firstBuyOut)",
  "event LaunchMetadata(address indexed token, bytes32 indexed id, string name, string symbol, string logoURI, string xAccount, string website, string extraLink, bytes32 metadataHash)",
  "event CreatePauseUpdated(bool paused)",
  "event CreateSignerUpdated(address indexed previous, address indexed next)",
] as const;

export const GEN8_HOOK_EVENTS = [
  "event PoolLaunched(bytes32 indexed id, address indexed token, address indexed creator, int24 tickStart, int24 tickGrad, uint128 liqA, uint128 liqB, (uint16 bondingBps, uint16 postBps, uint16 creatorPostBps, uint16 sniperStartBps, uint16 creatorBondingBps) fees, address display)",
  "event HookFee(bytes32 indexed id, address indexed swapSender, address indexed referrer, bool buy, bool graduated, uint256 curveAmount, uint256 fee, uint256 feeBps, uint256 creatorShare)",
  "event Graduated(bytes32 indexed id, uint256 gradFeeNative, uint256 nativeInA, uint128 liquidityRemoved)",
  "event CreatorClaimed(bytes32 indexed id, address indexed to, uint256 amount)",
  "event CreatorProposed(bytes32 indexed id, address indexed current, address indexed proposed)",
  "event CreatorTransferred(bytes32 indexed id, address indexed previous, address indexed next)",
  "event RouterClaimed(address indexed router, uint256 amount, uint256 bondingFees, uint256 gradFees)",
  "event RouterFlushFailed(address indexed router, uint256 amount)",
  "event RouterProposed(address indexed router, uint256 eta)",
  "event RouterChanged(address indexed previous, address indexed next)",
  "event RouterProposalCancelled(address indexed router)",
  "event DisplayUpdateFailed(bytes32 indexed id)",
] as const;

export const GEN8_SPLITTER_EVENTS = [
  "event Routed(uint256 indexed runId, bytes32 indexed accrualRoot, address indexed caller, (uint256 total, uint256 bondingFees, uint256 gradFees, uint256 weeklyLeague, uint256 monthlyLeague, uint256 recruiter, uint256 squad, uint256 airdrop, uint256 protocol) run)",
] as const;

/** Choice vault: only the creator hand-over matters to the indexer (owner of a choice coin). */
export const GEN8_CHOICE_VAULT_EVENTS = [
  "event CoinRegistered(bytes32 indexed id, address indexed token, address indexed creator, uint8 choice, uint8 creatorPct)",
  "event CreatorTransferred(bytes32 indexed id, address indexed previous, address indexed next)",
] as const;

export const V4_POOL_MANAGER_EVENTS = [
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
] as const;

export const GEN8_HOOK_VIEWS = [
  "function pools(bytes32) view returns (address creator, uint40 launchTime, bool graduated, int24 tickGrad, int24 tickStart, uint128 liqA, uint128 liqB, uint160 sqrtGrad, (uint16 bondingBps, uint16 postBps, uint16 creatorPostBps, uint16 sniperStartBps, uint16 creatorBondingBps) fees)",
  "function routerOwed() view returns (uint128)",
  "function pendingBondingFees() view returns (uint128)",
  "function pendingGradFees() view returns (uint256)",
  "function routerPaid(address) view returns (uint256 amount, uint256 bondingFees, uint256 gradFees)",
  "function treasuryRouter() view returns (address)",
  "function claimRouter()",
] as const;

export const GEN8_SPLITTER_ABI = [
  ...GEN8_SPLITTER_EVENTS,
  "function hook() view returns (address)",
  "function operator() view returns (address)",
  "function runs() view returns (uint256)",
  "function pending() view returns (uint256 total, uint256 bondingFees, uint256 gradFees)",
  "function bands(uint256 bondingFees, uint256 gradFees) pure returns (uint256 weekly, uint256 monthly, uint256 rsaMin, uint256 rsaMax, uint256 squadMax)",
  // V13 (build/evm-gen8 aac801d5): expectedPaid pins the run to hook.routerPaid(splitter).amount; no auto-claim.
  "function route(uint256 runId, uint256 expectedPaid, uint256 recruiter, uint256 squad, uint256 airdrop, bytes32 accrualRoot) returns ((uint256 total, uint256 bondingFees, uint256 gradFees, uint256 weeklyLeague, uint256 monthlyLeague, uint256 recruiter, uint256 squad, uint256 airdrop, uint256 protocol) r)",
  "error PaidMismatch(uint256 expected, uint256 actual)",
] as const;

export const GEN8_LAUNCHER_IFACE = new ethers.Interface(GEN8_LAUNCHER_EVENTS as unknown as string[]);
export const GEN8_HOOK_IFACE = new ethers.Interface([...GEN8_HOOK_EVENTS, ...GEN8_HOOK_VIEWS] as unknown as string[]);
export const GEN8_SPLITTER_IFACE = new ethers.Interface(GEN8_SPLITTER_ABI as unknown as string[]);
export const GEN8_CHOICE_VAULT_IFACE = new ethers.Interface(GEN8_CHOICE_VAULT_EVENTS as unknown as string[]);
export const V4_POOL_MANAGER_IFACE = new ethers.Interface(V4_POOL_MANAGER_EVENTS as unknown as string[]);

function topic(iface: ethers.Interface, name: string): string {
  const ev = iface.getEvent(name);
  if (!ev) throw new Error(`gen-8 ABI: missing event ${name}`);
  return ev.topicHash;
}

export const GEN8_TOPICS = {
  Launched: topic(GEN8_LAUNCHER_IFACE, "Launched"),
  LaunchMetadata: topic(GEN8_LAUNCHER_IFACE, "LaunchMetadata"),
  CreatePauseUpdated: topic(GEN8_LAUNCHER_IFACE, "CreatePauseUpdated"),
  CreateSignerUpdated: topic(GEN8_LAUNCHER_IFACE, "CreateSignerUpdated"),
  PoolLaunched: topic(GEN8_HOOK_IFACE, "PoolLaunched"),
  HookFee: topic(GEN8_HOOK_IFACE, "HookFee"),
  Graduated: topic(GEN8_HOOK_IFACE, "Graduated"),
  CreatorClaimed: topic(GEN8_HOOK_IFACE, "CreatorClaimed"),
  CreatorProposed: topic(GEN8_HOOK_IFACE, "CreatorProposed"),
  CreatorTransferred: topic(GEN8_HOOK_IFACE, "CreatorTransferred"),
  RouterClaimed: topic(GEN8_HOOK_IFACE, "RouterClaimed"),
  RouterFlushFailed: topic(GEN8_HOOK_IFACE, "RouterFlushFailed"),
  RouterProposed: topic(GEN8_HOOK_IFACE, "RouterProposed"),
  RouterChanged: topic(GEN8_HOOK_IFACE, "RouterChanged"),
  RouterProposalCancelled: topic(GEN8_HOOK_IFACE, "RouterProposalCancelled"),
  DisplayUpdateFailed: topic(GEN8_HOOK_IFACE, "DisplayUpdateFailed"),
  Routed: topic(GEN8_SPLITTER_IFACE, "Routed"),
  CoinRegistered: topic(GEN8_CHOICE_VAULT_IFACE, "CoinRegistered"),
  Swap: topic(V4_POOL_MANAGER_IFACE, "Swap"),
  Initialize: topic(V4_POOL_MANAGER_IFACE, "Initialize"),
} as const;

export const GEN8_LAUNCHER_TOPICS = [GEN8_TOPICS.Launched, GEN8_TOPICS.LaunchMetadata, GEN8_TOPICS.CreatePauseUpdated, GEN8_TOPICS.CreateSignerUpdated];
export const GEN8_HOOK_TOPICS = [
  GEN8_TOPICS.PoolLaunched,
  GEN8_TOPICS.HookFee,
  GEN8_TOPICS.Graduated,
  GEN8_TOPICS.CreatorClaimed,
  GEN8_TOPICS.CreatorProposed,
  GEN8_TOPICS.CreatorTransferred,
  GEN8_TOPICS.RouterClaimed,
  GEN8_TOPICS.RouterFlushFailed,
  GEN8_TOPICS.RouterProposed,
  GEN8_TOPICS.RouterChanged,
  GEN8_TOPICS.RouterProposalCancelled,
  GEN8_TOPICS.DisplayUpdateFailed,
];

/** V4 DYNAMIC_FEE_FLAG and the gen-8 pool key constants (design 2.2). */
export const V4_DYNAMIC_FEE_FLAG = 0x800000;
export const GEN8_TICK_SPACING = 10;

/** Pool id = keccak256(abi.encode(address(0), token, 0x800000, 10, hook)) (audit 10). */
export function gen8PoolId(token: string, hook: string): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "uint24", "int24", "address"],
      [ethers.ZeroAddress, token, V4_DYNAMIC_FEE_FLAG, GEN8_TICK_SPACING, hook],
    ),
  ).toLowerCase();
}
