import { Contract, Interface, getAddress, id, keccak256 } from "ethers";

import { isSolanaChainId } from "./chainNative.js";

export const DEFAULT_TOURNAMENT_PRICE_MAX_AGE_SECONDS = 300n;
export const TOURNAMENT_COMPETITION_GENERATION = "arena_competition_v2";

export const STAGING_ARENA_V2_AUTHORITY = Object.freeze({
  97: Object.freeze({
    treasury: "0xAb8cb6d117b79dd7502898e50C900360924fDa85",
    runtimeHash: "0xfec2ed674329f7145f202948cfae00abd0fd6fc4a8cdbdb129e8fd2c9c493422",
    leagueTreasury: "0x34f2C55c0d8cd7998afDa18ED7369f2E6be9619b",
    leagueRuntimeHash: "0xaa3da82375f44bccd4d3007b039f7cb97316e7518a9a393415ad78417927d2d4",
  }),
  46630: Object.freeze({
    treasury: "0x1eDd34933E5395c82F14CE2A220b81adF35C52B7",
    runtimeHash: "0x79979c3684c328e866c2b5b03d276cda7072a4c39d7f5b55c42672f9cb82958d",
    leagueTreasury: "0x794Cbd0912A71394f25B81C32f3994cC737A4B13",
    leagueRuntimeHash: "0xaa3da82375f44bccd4d3007b039f7cb97316e7518a9a393415ad78417927d2d4",
  }),
});

function positiveBigInt(value, label) {
  try {
    const parsed = BigInt(String(value));
    if (parsed <= 0n) throw new Error(`${label} must be positive`);
    return parsed;
  } catch (error) {
    if (error instanceof Error && /must be positive/.test(error.message)) throw error;
    throw new Error(`${label} must be a positive integer`);
  }
}

function sameAddress(left, right) {
  try {
    return getAddress(String(left)) === getAddress(String(right));
  } catch {
    return false;
  }
}

export function tournamentNativeDecimals(chainId) {
  return isSolanaChainId(Number(chainId)) ? 9 : 18;
}

export function tournamentPoolIdV2(tournamentId) {
  return id(`arena-tournament:${String(tournamentId)}`);
}

/**
 * V2 tournament buy-ins use the exact admin-configured arena_tournaments.buy_in_native value.
 * The former fixed $0.25 USD conversion is historical-only and intentionally absent here.
 */
export function tournamentBuyInNativeRaw({ chainId, buyInNative }) {
  const decimals = tournamentNativeDecimals(chainId);
  const raw = String(buyInNative ?? "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(raw)) throw new Error("Tournament buy_in_native must be a positive decimal");
  const [whole, fraction = ""] = raw.split(".");
  if (fraction.length > decimals) throw new Error(`Tournament buy_in_native exceeds ${decimals} native decimals`);
  const value = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
  return positiveBigInt(value, "buyInNativeRaw");
}

export function arenaWarPoolTreasuryV2Address(chainId, env = process.env) {
  const chain = Number(chainId);
  const raw = String(env[`ARENA_WAR_POOL_TREASURY_V2_ADDRESS_${chain}`] || "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) {
    throw new Error(`ArenaWarPoolTreasuryV2 address is not configured for chain ${chain}`);
  }
  const configured = getAddress(raw);
  const staging = STAGING_ARENA_V2_AUTHORITY[chain];
  if (staging && !sameAddress(configured, staging.treasury)) {
    throw new Error(`ArenaWarPoolTreasuryV2 address for staging chain ${chain} does not match the independently attested authority`);
  }
  return configured;
}

export function arenaWarPoolTreasuryV2RuntimeHash(chainId, env = process.env) {
  const chain = Number(chainId);
  const configured = String(env[`ARENA_WAR_POOL_TREASURY_V2_RUNTIME_HASH_${chain}`] || "").trim().toLowerCase();
  const staging = STAGING_ARENA_V2_AUTHORITY[chain];
  if (staging) {
    if (configured && configured !== staging.runtimeHash.toLowerCase()) {
      throw new Error(`ArenaWarPoolTreasuryV2 runtime hash for staging chain ${chain} does not match the attested authority`);
    }
    return staging.runtimeHash.toLowerCase();
  }
  if (configured && !/^0x[a-f0-9]{64}$/.test(configured)) throw new Error(`Invalid ArenaWarPoolTreasuryV2 runtime hash for chain ${chain}`);
  return configured || null;
}

export const TOURNAMENT_POOL_READ_ABI = [
  "function GENERATION() view returns (uint256)",
  "function buyIns(bytes32 poolId,address wallet) view returns (uint256)",
  "function pools(bytes32 poolId) view returns (uint8 kind,uint8 state,address ownerA,address ownerB,uint96 stakeAmount,uint96 buyInAmount,uint256 stakeA,uint256 stakeB,uint256 buyInTotal,uint256 boostTotal,address winnerPayout,uint256 pendingWinner,uint256 pendingProtocol,uint256 pendingLeague,uint256 depositDeadline,uint256 resolveDeadline,bool claimedWinner,bool claimedProtocol,bool claimedLeague,bool refundedA,bool refundedB)",
  "event BuyInDeposited(bytes32 indexed poolId,address indexed owner,uint256 amount)",
];

export async function readEvmTournamentPoolV2({ provider, chainId, tournamentId, treasuryAddress, expectedBuyInRaw = null, wallet = null }) {
  if (!provider) throw new Error("Tournament RPC provider is unavailable");
  const chain = Number(chainId);
  if (isSolanaChainId(chain)) throw new Error("EVM Tournament V2 reader refuses Solana");
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== chain) throw new Error(`Tournament RPC chain mismatch: expected ${chain}, got ${network.chainId}`);

  const treasury = treasuryAddress ? getAddress(String(treasuryAddress)) : arenaWarPoolTreasuryV2Address(chain);
  const configuredTreasury = arenaWarPoolTreasuryV2Address(chain);
  if (!sameAddress(treasury, configuredTreasury)) throw new Error("Tournament Treasury does not match backend authority");

  const code = await provider.getCode(treasury);
  if (!code || code === "0x") throw new Error("ArenaWarPoolTreasuryV2 has no runtime bytecode");
  const expectedRuntimeHash = arenaWarPoolTreasuryV2RuntimeHash(chain);
  const runtimeHash = keccak256(code).toLowerCase();
  if (expectedRuntimeHash && runtimeHash !== expectedRuntimeHash) throw new Error("ArenaWarPoolTreasuryV2 runtime hash mismatch");

  const contract = new Contract(treasury, TOURNAMENT_POOL_READ_ABI, provider);
  if (BigInt(await contract.GENERATION()) !== 2n) throw new Error("ArenaWarPoolTreasuryV2 generation is not 2");
  const poolId = tournamentPoolIdV2(tournamentId);
  const pool = await contract.pools(poolId);
  const kind = Number(pool.kind ?? pool[0]);
  const state = Number(pool.state ?? pool[1]);
  const ownerA = String(pool.ownerA ?? pool[2] ?? "");
  const buyInAmount = BigInt(pool.buyInAmount ?? pool[5] ?? 0);
  if (!ownerA || sameAddress(ownerA, "0x0000000000000000000000000000000000000000")) throw new Error("Tournament V2 pool is not opened");
  if (kind !== 1) throw new Error("Tournament V2 pool is not a tournament pool");
  if (![0, 1].includes(state)) throw new Error("Tournament V2 pool is not accepting/reconciling active entries");
  if (expectedBuyInRaw != null && buyInAmount !== positiveBigInt(expectedBuyInRaw, "expectedBuyInRaw")) {
    throw new Error("Tournament V2 on-chain buy-in does not match arena_tournaments.buy_in_native");
  }
  const paid = wallet ? BigInt(await contract.buyIns(poolId, getAddress(String(wallet)))) : null;
  return {
    configured: true,
    live: true,
    treasuryAddress: treasury,
    runtimeHash,
    poolId,
    kind,
    state,
    opened: true,
    ownerA,
    buyInAmount,
    paid,
  };
}

async function verifyTransactionHint({ provider, treasury, poolId, wallet, expected, txHash }) {
  if (!txHash) return { checked: false, reconciliation: true };
  if (!/^0x[a-fA-F0-9]{64}$/.test(String(txHash))) throw new Error("Tournament buy-in transaction hash is invalid");
  const [receipt, tx] = await Promise.all([provider.getTransactionReceipt(txHash), provider.getTransaction(txHash)]);
  if (!receipt || receipt.status !== 1) throw new Error("Tournament buy-in transaction is not confirmed successful");
  if (!tx) throw new Error("Tournament buy-in transaction is unavailable");
  if (!sameAddress(receipt.to, treasury) || !sameAddress(tx.to, treasury)) throw new Error("Tournament buy-in transaction used the wrong Treasury");
  if (!sameAddress(tx.from, wallet)) throw new Error("Tournament buy-in transaction used the wrong payer");
  if (BigInt(tx.value || 0) !== expected) throw new Error("Tournament buy-in transaction used the wrong amount");

  const iface = new Interface(TOURNAMENT_POOL_READ_ABI);
  const event = receipt.logs.map((log) => {
    try { return iface.parseLog(log); } catch { return null; }
  }).find((parsed) => parsed?.name === "BuyInDeposited");
  if (!event) throw new Error("Tournament buy-in transaction emitted no BuyInDeposited event");
  if (String(event.args.poolId).toLowerCase() !== poolId.toLowerCase()) throw new Error("Tournament buy-in transaction used the wrong Tournament pool");
  if (!sameAddress(event.args.owner, wallet)) throw new Error("Tournament buy-in event used the wrong payer");
  if (BigInt(event.args.amount) !== expected) throw new Error("Tournament buy-in event used the wrong amount");
  return { checked: true, reconciliation: false, txHash: String(txHash), blockNumber: receipt.blockNumber };
}

export async function verifyEvmTournamentBuyInV2({ provider, chainId, tournamentId, wallet, expectedBuyInRaw, treasuryAddress, txHash = "" }) {
  const expected = positiveBigInt(expectedBuyInRaw, "expectedBuyInRaw");
  const proof = await readEvmTournamentPoolV2({ provider, chainId, tournamentId, wallet, expectedBuyInRaw: expected, treasuryAddress });
  if (proof.paid !== expected) throw new Error("Tournament V2 wallet has not paid the exact buy-in");
  const txProof = await verifyTransactionHint({
    provider,
    treasury: proof.treasuryAddress,
    poolId: proof.poolId,
    wallet: getAddress(String(wallet)),
    expected,
    txHash: String(txHash || "").trim(),
  });
  return {
    ok: true,
    treasuryAddress: proof.treasuryAddress,
    treasuryRuntimeHash: proof.runtimeHash,
    poolId: proof.poolId,
    state: proof.state,
    buyInAmount: proof.buyInAmount,
    paid: proof.paid,
    txProof,
  };
}
