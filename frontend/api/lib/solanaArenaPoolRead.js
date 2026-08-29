import { Connection, PublicKey } from "@solana/web3.js";
import {
  ARENA_CONFIG_SEED,
  ARENA_POOL_SEED,
  ARENA_STATE_OPEN,
  ARENA_VAULT_SEED,
  REWARDS_TREASURY_PROGRAM_ID,
  isSolanaWarzoneChainId,
  parseArenaPool,
  poolIdToBytes,
  stakeToLamports,
  validateCanonicalArenaConfig,
  walletsEqual,
} from "../../src/lib/solanaArenaLayout.mjs";
import { battlePoolId, tournamentPoolId } from "./arenaWarPoolEscrow.js";

const liveCache = new Map();
const LIVE_TTL_MS = 15_000;

function env(...names) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function rpcUrl(chainId) {
  const id = Number(chainId);
  return (
    env(`SOLANA_RPC_URL_${id}`, `SOLANA_RPC_HTTP_${id}`, `SOLANA_REWARDS_RPC_URL_${id}`) ||
    env("SOLANA_RPC_URL", "SOLANA_RPC_HTTP", "SOLANA_REWARDS_RPC_URL", "VITE_SOLANA_RPC")
  )
    .split(",")
    .map((item) => item.trim())
    .find(Boolean) || "";
}

function connectionFor(chainId) {
  const url = rpcUrl(chainId);
  if (!url) return null;
  return new Connection(url, "confirmed");
}

function programId() {
  return new PublicKey(REWARDS_TREASURY_PROGRAM_ID);
}

export function deriveArenaConfigPda() {
  return PublicKey.findProgramAddressSync([Buffer.from(ARENA_CONFIG_SEED)], programId())[0];
}

export function deriveArenaBuyInPda(poolIdHex, entryAsset, entrant) {
  const id = Buffer.from(poolIdToBytes(poolIdHex));
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("arena_buyin"),
      id,
      new PublicKey(entryAsset).toBuffer(),
      new PublicKey(entrant).toBuffer(),
    ],
    programId(),
  )[0];
}

export function deriveArenaPoolPdas(poolIdHex) {
  const id = Buffer.from(poolIdToBytes(poolIdHex));
  const pid = programId();
  return {
    programId: REWARDS_TREASURY_PROGRAM_ID,
    config: deriveArenaConfigPda().toBase58(),
    pool: PublicKey.findProgramAddressSync([Buffer.from(ARENA_POOL_SEED), id], pid)[0].toBase58(),
    vault: PublicKey.findProgramAddressSync([Buffer.from(ARENA_VAULT_SEED), id], pid)[0].toBase58(),
  };
}

export async function probeCanonicalArenaLive(chainId) {
  const id = Number(chainId);
  if (!isSolanaWarzoneChainId(id)) return { live: false, reason: "not-solana" };
  const cached = liveCache.get(id);
  if (cached && Date.now() - cached.at < LIVE_TTL_MS) return cached.value;
  const connection = connectionFor(id);
  if (!connection) {
    const value = { live: false, reason: "rpc-missing" };
    liveCache.set(id, { at: Date.now(), value });
    return value;
  }
  try {
    const configPda = deriveArenaConfigPda();
    const [account, genesisHash] = await Promise.all([
      connection.getAccountInfo(configPda, "confirmed"),
      connection.getGenesisHash(),
    ]);
    const value = validateCanonicalArenaConfig({
      account,
      owner: account?.owner?.toBase58?.() || "",
      genesisHash,
      chainId: id,
      PublicKey,
    });
    liveCache.set(id, { at: Date.now(), value });
    return value;
  } catch (error) {
    const value = { live: false, reason: "rpc-error", error: String(error?.message || error) };
    liveCache.set(id, { at: Date.now(), value });
    return value;
  }
}

export async function readSolanaArenaPool(chainId, subjectId, kind = "battle") {
  const poolId = kind === "tournament" ? tournamentPoolId(subjectId) : battlePoolId(subjectId);
  const probe = await probeCanonicalArenaLive(chainId);
  if (!probe.live) {
    return {
      configured: false,
      live: false,
      liveReason: probe.reason,
      treasury: "",
      programId: REWARDS_TREASURY_PROGRAM_ID,
      poolId,
      opened: false,
      bothPaid: false,
      paidA: false,
      paidB: false,
    };
  }
  const pdas = deriveArenaPoolPdas(poolId);
  const connection = connectionFor(chainId);
  try {
    const account = await connection.getAccountInfo(new PublicKey(pdas.pool), "confirmed");
    if (!account?.data || account.owner.toBase58() !== REWARDS_TREASURY_PROGRAM_ID) {
      return {
        configured: true,
        live: true,
        treasury: pdas.programId,
        programId: pdas.programId,
        poolId,
        poolPda: pdas.pool,
        vaultPda: pdas.vault,
        opened: false,
        bothPaid: false,
        paidA: false,
        paidB: false,
      };
    }
    const parsed = parseArenaPool(Uint8Array.from(account.data), PublicKey);
    if (!parsed) {
      return {
        configured: true,
        live: true,
        treasury: pdas.programId,
        programId: pdas.programId,
        poolId,
        poolPda: pdas.pool,
        vaultPda: pdas.vault,
        opened: false,
        bothPaid: false,
        error: "bad-pool-layout",
      };
    }
    const paidA = parsed.requiredStakeA > 0n && parsed.depositedStakeA === parsed.requiredStakeA;
    const paidB = parsed.requiredStakeB > 0n && parsed.depositedStakeB === parsed.requiredStakeB;
    return {
      configured: true,
      live: true,
      treasury: pdas.programId,
      programId: pdas.programId,
      poolId,
      poolPda: pdas.pool,
      vaultPda: pdas.vault,
      opened: parsed.state === ARENA_STATE_OPEN || parsed.state === 1 || parsed.state === 2 || parsed.state === 3,
      ownerA: parsed.ownerA,
      ownerB: parsed.ownerB,
      assetA: parsed.assetA,
      assetB: parsed.assetB,
      stakeAmount: parsed.requiredStakeA.toString(),
      requiredStakeA: parsed.requiredStakeA.toString(),
      requiredStakeB: parsed.requiredStakeB.toString(),
      stakeA: parsed.depositedStakeA.toString(),
      stakeB: parsed.depositedStakeB.toString(),
      paidA,
      paidB,
      bothPaid: paidA && paidB,
      depositDeadline: parsed.depositDeadline,
      resolveDeadline: parsed.resolveDeadline,
      supportDeadline: parsed.supportDeadline,
      supportClosed: parsed.supportClosed,
      onchainState: parsed.state,
      refundedA: parsed.refundedA,
      refundedB: parsed.refundedB,
      winnerWallet: parsed.winnerWallet,
      pendingWinner: parsed.pendingWinner.toString(),
      claimedWinner: parsed.claimedWinner,
      kind: parsed.kind,
    };
  } catch (error) {
    return {
      configured: true,
      live: true,
      treasury: pdas.programId,
      programId: pdas.programId,
      poolId,
      opened: false,
      bothPaid: false,
      paidA: false,
      paidB: false,
      error: String(error?.message || error),
    };
  }
}

export { stakeToLamports, walletsEqual, isSolanaWarzoneChainId, REWARDS_TREASURY_PROGRAM_ID };
