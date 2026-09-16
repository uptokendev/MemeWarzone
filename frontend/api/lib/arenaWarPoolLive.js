import { ethers } from "ethers";
import { getServerReadProvider } from "./getServerReadProvider.js";
import {
  WAR_POOL_ABI,
  WAR_POOL_GENERATION_V2,
  WAR_POOL_V2_ABI,
  battlePoolId,
  tournamentPoolId,
  warPoolGeneration,
  warPoolTreasuryAddress,
} from "./arenaWarPoolEscrow.js";
import { arenaWarPoolTreasuryV2RuntimeHash, readEvmTournamentPoolV2 } from "./arenaTournamentBuyInV2.mjs";
import { isSolanaWarzoneChainId, probeCanonicalArenaLive, readSolanaArenaPool } from "./solanaArenaPoolRead.js";

export function escrowRequired(chainId, env = process.env) {
  if (isSolanaWarzoneChainId(chainId)) return false;
  return Boolean(warPoolTreasuryAddress(chainId, env));
}

export async function escrowRequiredAsync(chainId, env = process.env) {
  if (isSolanaWarzoneChainId(chainId)) {
    const probe = await probeCanonicalArenaLive(chainId);
    return Boolean(probe.live);
  }
  return Boolean(warPoolTreasuryAddress(chainId, env));
}

export function stakeToWei(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return 0n;
  return ethers.parseEther(n.toFixed(8).replace(/0+$/, "").replace(/\.$/, ""));
}

export async function readOnchainPool(chainId, subjectId, kind = "battle") {
  if (isSolanaWarzoneChainId(chainId)) {
    return readSolanaArenaPool(chainId, subjectId, kind);
  }

  if (kind === "tournament") {
    try {
      const provider = await getServerReadProvider(chainId);
      const onchain = await readEvmTournamentPoolV2({ provider, chainId, tournamentId: subjectId });
      return {
        configured: true,
        live: true,
        treasury: onchain.treasuryAddress,
        poolId: onchain.poolId,
        opened: onchain.opened,
        buyInAmount: onchain.buyInAmount.toString(),
        onchainState: onchain.state,
        poolGeneration: "arena_competition_v2",
        bothPaid: false,
        paidA: false,
        paidB: false,
      };
    } catch (error) {
      return {
        configured: false,
        live: false,
        treasury: "",
        poolId: tournamentPoolId(subjectId),
        opened: false,
        bothPaid: false,
        paidA: false,
        paidB: false,
        error: String(error?.message || error),
      };
    }
  }

  const treasury = warPoolTreasuryAddress(chainId);
  const poolId = battlePoolId(subjectId);
  const generation = warPoolGeneration(chainId);
  const abi = generation === WAR_POOL_GENERATION_V2 ? WAR_POOL_V2_ABI : WAR_POOL_ABI;
  if (!treasury) {
    return { configured: false, treasury: "", poolId, opened: false, bothPaid: false, poolGeneration: generation };
  }
  try {
    const provider = await getServerReadProvider(chainId);
    if (generation === WAR_POOL_GENERATION_V2) {
      const code = await provider.getCode(treasury);
      if (!code || code === "0x") throw new Error("ArenaWarPoolTreasuryV2 has no runtime bytecode");
      const expectedRuntimeHash = arenaWarPoolTreasuryV2RuntimeHash(chainId);
      const runtimeHash = ethers.keccak256(code).toLowerCase();
      if (expectedRuntimeHash && runtimeHash !== expectedRuntimeHash) {
        throw new Error("ArenaWarPoolTreasuryV2 runtime hash mismatch");
      }
    }
    const contract = new ethers.Contract(treasury, abi, provider);
    if (generation === WAR_POOL_GENERATION_V2 && BigInt(await contract.GENERATION()) !== 2n) {
      throw new Error("ArenaWarPoolTreasuryV2 generation is not 2");
    }
    const onchain = await contract.pools(poolId);
    const ownerA = String(onchain.ownerA || "");
    const opened = Boolean(ownerA && ownerA !== ethers.ZeroAddress);
    const stakeAmount = BigInt(onchain.stakeAmount || 0);
    const stakeA = BigInt(onchain.stakeA || 0);
    const stakeB = BigInt(onchain.stakeB || 0);
    const paidA = opened && stakeAmount > 0n && stakeA === stakeAmount;
    const paidB = opened && stakeAmount > 0n && stakeB === stakeAmount;
    return {
      configured: true,
      treasury,
      poolId,
      abi,
      poolGeneration: generation,
      opened,
      ownerA: opened ? ownerA : "",
      ownerB: opened ? String(onchain.ownerB || "") : "",
      stakeAmount: stakeAmount.toString(),
      stakeA: stakeA.toString(),
      stakeB: stakeB.toString(),
      paidA,
      paidB,
      bothPaid: paidA && paidB,
      depositDeadline: Number(onchain.depositDeadline || 0),
      resolveDeadline: Number(onchain.resolveDeadline || 0),
      onchainState: Number(onchain.state || 0),
      refundedA: Boolean(onchain.refundedA),
      refundedB: Boolean(onchain.refundedB),
    };
  } catch (error) {
    return {
      configured: true,
      treasury,
      poolId,
      abi,
      poolGeneration: generation,
      opened: false,
      bothPaid: false,
      paidA: false,
      paidB: false,
      error: String(error?.message || error),
    };
  }
}
