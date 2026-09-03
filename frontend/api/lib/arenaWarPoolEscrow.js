import { ethers } from "ethers";

export const WAR_POOL_ABI = [
  "function openBattlePool(bytes32 poolId,address ownerA,address ownerB,uint96 stakeAmount,uint256 depositDeadline,uint256 resolveDeadline) payable",
  "function depositStake(bytes32 poolId) payable",
  "function depositBuyIn(bytes32 poolId) payable",
  "function donateSupport(bytes32 poolId) payable",
  "function resolve(bytes32 poolId,address winnerPayout,uint256 deadline,bytes signature)",
  "function claimWinner(bytes32 poolId)",
  "function claimProtocol(bytes32 poolId)",
  "function claimMwl(bytes32 poolId)",
  "function pools(bytes32) view returns (uint8 kind,uint8 state,address ownerA,address ownerB,uint96 stakeAmount,uint96 buyInAmount,uint256 stakeA,uint256 stakeB,uint256 buyInTotal,uint256 supportTotal,address winnerPayout,uint256 pendingWinner,uint256 pendingProtocol,uint256 pendingMwl,uint256 depositDeadline,uint256 resolveDeadline,bool claimedWinner,bool claimedProtocol,bool claimedMwl,bool refundedA,bool refundedB)",
];

export function warPoolTreasuryAddress(chainId) {
  const id = Number(chainId);
  return String(
    process.env[`ARENA_WAR_POOL_TREASURY_ADDRESS_${id}`] ||
      process.env[`VITE_ARENA_WAR_POOL_TREASURY_ADDRESS_${id}`] ||
      process.env.ARENA_WAR_POOL_TREASURY_ADDRESS ||
      process.env.VITE_ARENA_WAR_POOL_TREASURY_ADDRESS ||
      "",
  ).trim();
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
