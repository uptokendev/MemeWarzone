import { ethers } from "ethers";

import {
  arenaWarPoolTreasuryV2Address,
  arenaWarPoolTreasuryV2RuntimeHash,
} from "./arenaTournamentBuyInV2.mjs";

export const WAR_POOL_GENERATION_V1 = "war_pool_v1";
export const WAR_POOL_GENERATION_V2 = "war_pool_v2";

export const WAR_POOL_ABI = [
  "function openBattlePool(bytes32 poolId,address ownerA,address ownerB,uint96 stakeAmount,uint256 depositDeadline,uint256 resolveDeadline) payable",
  "function openTournamentPool(bytes32 poolId,uint96 buyInAmount,uint256 depositDeadline,uint256 resolveDeadline)",
  "function depositStake(bytes32 poolId) payable",
  "function depositBuyIn(bytes32 poolId) payable",
  "function donateSupport(bytes32 poolId) payable",
  "function resolve(bytes32 poolId,address winnerPayout,uint256 deadline,bytes signature)",
  "function claimWinner(bytes32 poolId)",
  "function claimProtocol(bytes32 poolId)",
  "function claimMwl(bytes32 poolId)",
  "function refundStake(bytes32 poolId)",
  "function pools(bytes32) view returns (uint8 kind,uint8 state,address ownerA,address ownerB,uint96 stakeAmount,uint96 buyInAmount,uint256 stakeA,uint256 stakeB,uint256 buyInTotal,uint256 supportTotal,address winnerPayout,uint256 pendingWinner,uint256 pendingProtocol,uint256 pendingMwl,uint256 depositDeadline,uint256 resolveDeadline,bool claimedWinner,bool claimedProtocol,bool claimedMwl,bool refundedA,bool refundedB)",
];

export const WAR_POOL_V2_ABI = [
  "function GENERATION() view returns (uint256)",
  "function openBattlePool(bytes32 poolId,address ownerA,address ownerB,uint96 stakeAmount,uint256 depositDeadline,uint256 resolveDeadline) payable",
  "function openTournamentPool(bytes32 poolId,uint96 buyInAmount,uint256 depositDeadline,uint256 resolveDeadline)",
  "function depositStake(bytes32 poolId) payable",
  "function depositBuyIn(bytes32 poolId) payable",
  "function resolve(bytes32 poolId,address winnerPayout,uint256 deadline,bytes signature)",
  "function claimWinner(bytes32 poolId)",
  "function claimProtocol(bytes32 poolId)",
  "function claimLeague(bytes32 poolId,bytes32 monthlyEpoch,bytes32 quarterlyEpoch)",
  "function refundStake(bytes32 poolId)",
  "function resolvePlaces(bytes32 poolId,address[] payouts,uint16[] bps,uint256 deadline,bytes signature)",
  "function claimPlace(bytes32 poolId,uint8 place)",
  "function placeOf(bytes32 poolId,uint8 place) view returns (address payout,uint256 pending,bool claimed)",
  "function placeCount(bytes32 poolId) view returns (uint8)",
  "function pools(bytes32) view returns (uint8 kind,uint8 state,address ownerA,address ownerB,uint96 stakeAmount,uint96 buyInAmount,uint256 stakeA,uint256 stakeB,uint256 buyInTotal,uint256 boostTotal,address winnerPayout,uint256 pendingWinner,uint256 pendingProtocol,uint256 pendingLeague,uint256 depositDeadline,uint256 resolveDeadline,bool claimedWinner,bool claimedProtocol,bool claimedLeague,bool refundedA,bool refundedB)",
];

function v1TreasuryAddress(chainId, env) {
  const id = Number(chainId);
  const perChain = String(
    env[`ARENA_WAR_POOL_TREASURY_ADDRESS_${id}`] ||
      env[`VITE_ARENA_WAR_POOL_TREASURY_ADDRESS_${id}`] ||
      "",
  ).trim();
  if (perChain) return perChain;
  if (id === 56 || id === 97) {
    return String(env.ARENA_WAR_POOL_TREASURY_ADDRESS || env.VITE_ARENA_WAR_POOL_TREASURY_ADDRESS || "").trim();
  }
  return "";
}

function resolveWarPoolTreasury(chainId, env = process.env) {
  const id = Number(chainId);

  const v2Raw = String(env[`ARENA_WAR_POOL_TREASURY_V2_ADDRESS_${id}`] || "").trim();
  if (v2Raw) {
    const address = arenaWarPoolTreasuryV2Address(id, env);
    arenaWarPoolTreasuryV2RuntimeHash(id, env);
    return { address, generation: WAR_POOL_GENERATION_V2 };
  }

  // Robinhood, staging and production alike, is V2-only: a missing V2 env
  // fails closed instead of inheriting BNB's V1 treasury. Production (4663)
  // used to be refused outright, from before a Robinhood V2 treasury existed;
  // it is now enabled the same way as every other chain -- by its own
  // ARENA_WAR_POOL_TREASURY_V2_ADDRESS_4663, with the runtime hash enforced
  // against the deployed bytecode when configured.
  if (id === 46630 || id === 4663) return { address: "", generation: "" };

  const v1 = v1TreasuryAddress(id, env);
  if (v1) return { address: v1, generation: WAR_POOL_GENERATION_V1 };
  return { address: "", generation: "" };
}

export function warPoolTreasuryAddress(chainId, env = process.env) {
  return resolveWarPoolTreasury(chainId, env).address;
}

export function warPoolGeneration(chainId, env = process.env) {
  return resolveWarPoolTreasury(chainId, env).generation;
}

export function battlePoolId(battleId) {
  return ethers.id(`arena-battle:${String(battleId)}`);
}

export function tournamentPoolId(tournamentId) {
  return ethers.id(`arena-tournament:${String(tournamentId)}`);
}

export async function signResolvePool({ treasuryAddress, chainId, poolId, winnerPayout, stakeTotal, supportTotal, buyInTotal, deadline }) {
  const key = String(process.env.ARENA_WAR_POOL_RESOLVER_KEY || "").trim();
  if (!key) return null;
  const wallet = new ethers.Wallet(key.startsWith("0x") ? key : `0x${key}`);
  const domain = {
    name: "ArenaWarPoolTreasury",
    version: "1",
    chainId: Number(chainId),
    verifyingContract: treasuryAddress,
  };
  const types = {
    ResolvePool: [
      { name: "poolId", type: "bytes32" },
      { name: "winnerPayout", type: "address" },
      { name: "stakeTotal", type: "uint256" },
      { name: "supportTotal", type: "uint256" },
      { name: "buyInTotal", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };
  const signature = await wallet.signTypedData(domain, types, {
    poolId,
    winnerPayout,
    stakeTotal,
    supportTotal,
    buyInTotal,
    deadline,
  });
  return { signature, domain, types, resolver: wallet.address };
}

export function warPoolAbiForGeneration(generation) {
  return generation === WAR_POOL_GENERATION_V2 ? WAR_POOL_V2_ABI : WAR_POOL_ABI;
}

export async function signResolvePoolV2({ treasuryAddress, chainId, poolId, winnerPayout, stakeTotal, buyInTotal, boostTotal, deadline }) {
  const key = String(process.env.ARENA_WAR_POOL_RESOLVER_KEY || "").trim();
  if (!key) return null;
  const wallet = new ethers.Wallet(key.startsWith("0x") ? key : `0x${key}`);
  const domain = {
    name: "ArenaWarPoolTreasury",
    version: "2",
    chainId: Number(chainId),
    verifyingContract: treasuryAddress,
  };
  const types = {
    ResolvePoolV2: [
      { name: "poolId", type: "bytes32" },
      { name: "winnerPayout", type: "address" },
      { name: "stakeTotal", type: "uint256" },
      { name: "buyInTotal", type: "uint256" },
      { name: "boostTotal", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };
  const signature = await wallet.signTypedData(domain, types, {
    poolId,
    winnerPayout,
    stakeTotal,
    buyInTotal,
    boostTotal,
    deadline,
  });
  return { signature, domain, types, resolver: wallet.address };
}

/** keccak256(abi.encode(address[] payouts, uint16[] bps)), the placesHash ArenaWarPoolTreasuryV2.resolvePlaces verifies. */
export function resolvePlacesHash(payouts, bps) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address[]", "uint16[]"], [payouts, bps]));
}

/**
 * Tournament places resolution (1-3 paid places) on ArenaWarPoolTreasuryV2:
 * EIP-712 ResolvePoolPlacesV2 over the place list hash and the pool totals.
 */
export async function signResolvePlacesV2({ treasuryAddress, chainId, poolId, payouts, bps, stakeTotal, buyInTotal, boostTotal, deadline }) {
  const key = String(process.env.ARENA_WAR_POOL_RESOLVER_KEY || "").trim();
  if (!key) return null;
  if (!Array.isArray(payouts) || !Array.isArray(bps) || !payouts.length || payouts.length > 3 || payouts.length !== bps.length) {
    throw new Error("resolvePlaces needs 1-3 payouts with matching bps");
  }
  if (bps.reduce((sum, value) => sum + Number(value), 0) !== 10_000) throw new Error("resolvePlaces bps must sum to 10000");
  const wallet = new ethers.Wallet(key.startsWith("0x") ? key : `0x${key}`);
  const domain = {
    name: "ArenaWarPoolTreasury",
    version: "2",
    chainId: Number(chainId),
    verifyingContract: treasuryAddress,
  };
  const types = {
    ResolvePoolPlacesV2: [
      { name: "poolId", type: "bytes32" },
      { name: "placesHash", type: "bytes32" },
      { name: "stakeTotal", type: "uint256" },
      { name: "buyInTotal", type: "uint256" },
      { name: "boostTotal", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };
  const placesHash = resolvePlacesHash(payouts, bps);
  const signature = await wallet.signTypedData(domain, types, {
    poolId,
    placesHash,
    stakeTotal,
    buyInTotal,
    boostTotal,
    deadline,
  });
  return { signature, domain, types, placesHash, resolver: wallet.address };
}
