/** Canonical Arena layout + live-gate helpers. No Vite aliases. Safe for API and tests. */

export const REWARDS_TREASURY_PROGRAM_ID = "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX";
export const ARENA_CONFIG_SEED = "arena_config";
export const ARENA_POOL_SEED = "arena_pool";
export const ARENA_VAULT_SEED = "arena_vault";
export const ARENA_CONFIG_VERSION = 2;
export const ARENA_STATE_OPEN = 0;
export const ARENA_STATE_LIVE = 1;
export const ARENA_STATE_RESOLVED = 2;
export const ARENA_STATE_CANCELLED = 3;
export const LAMPORTS_PER_SOL = 1_000_000_000n;

export const ARENA_CONFIG_DISCRIMINATOR = Uint8Array.from([9, 186, 181, 145, 197, 50, 33, 38]);
export const ARENA_POOL_DISCRIMINATOR = Uint8Array.from([199, 155, 111, 90, 242, 136, 105, 8]);

export const SOLANA_GENESIS = Object.freeze({
  101: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKvcnbdEad4t",
  102: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wavy2uVvL2jH",
});

export function isSolanaWarzoneChainId(chainId) {
  const id = Number(chainId);
  return id === 101 || id === 102;
}

export function expectedGenesisHash(chainId) {
  return SOLANA_GENESIS[Number(chainId)] || "";
}

function bytesToHex(bytes) {
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

export function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

export function poolIdToBytes(poolId) {
  const raw = String(poolId || "").trim();
  const hex = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("Arena pool id must be 32 bytes hex.");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function readU8(data, offset) {
  return data[offset];
}
function readU32le(data, offset) {
  return data[offset] + (data[offset + 1] << 8) + (data[offset + 2] << 16) + (data[offset + 3] * 0x1000000);
}
function readU64le(data, offset) {
  const lo = BigInt(readU32le(data, offset));
  const hi = BigInt(readU32le(data, offset + 4));
  return lo + (hi << 32n);
}
function readI64le(data, offset) {
  const u = readU64le(data, offset);
  return u > 0x7fffffffffffffffn ? u - 0x10000000000000000n : u;
}
function readPubkeyBase58(PublicKey, data, offset) {
  const slice = data.subarray(offset, offset + 32);
  if (slice.every((b) => b === 0)) return "";
  return new PublicKey(slice).toBase58();
}

export function stakeToLamports(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Stake/Support amount must be a positive SOL value.");
  const lamports = BigInt(Math.round(n * Number(LAMPORTS_PER_SOL)));
  if (lamports <= 0n) throw new Error("Stake/Support amount is below one lamport.");
  return lamports;
}

export function walletsEqual(a, b) {
  const left = String(a || "").trim();
  const right = String(b || "").trim();
  return Boolean(left && right && left === right);
}

export function parseArenaConfig(data, PublicKey) {
  if (!data || data.length < 8 + 32 * 4 + 3) return null;
  if (!bytesEqual(data.subarray(0, 8), ARENA_CONFIG_DISCRIMINATOR)) return null;
  let o = 8;
  const authority = readPubkeyBase58(PublicKey, data, o); o += 32;
  const resolver = readPubkeyBase58(PublicKey, data, o); o += 32;
  const protocolReceiver = readPubkeyBase58(PublicKey, data, o); o += 32;
  const mwlReceiver = readPubkeyBase58(PublicKey, data, o); o += 32;
  const depositsPaused = readU8(data, o) !== 0; o += 1;
  const bump = readU8(data, o); o += 1;
  const version = readU8(data, o);
  if (version !== ARENA_CONFIG_VERSION) return null;
  if (!authority || !resolver || !protocolReceiver || !mwlReceiver) return null;
  return { authority, resolver, protocolReceiver, mwlReceiver, depositsPaused, bump, version };
}

export function parseArenaPool(data, PublicKey) {
  if (!data || data.length < 8 + 385) return null;
  if (!bytesEqual(data.subarray(0, 8), ARENA_POOL_DISCRIMINATOR)) return null;
  let o = 8;
  const poolId = bytesToHex(data.subarray(o, o + 32)); o += 32;
  const kind = readU8(data, o); o += 1;
  const state = readU8(data, o); o += 1;
  const assetA = readPubkeyBase58(PublicKey, data, o); o += 32;
  const assetB = readPubkeyBase58(PublicKey, data, o); o += 32;
  const ownerA = readPubkeyBase58(PublicKey, data, o); o += 32;
  const ownerB = readPubkeyBase58(PublicKey, data, o); o += 32;
  const requiredStakeA = readU64le(data, o); o += 8;
  const requiredStakeB = readU64le(data, o); o += 8;
  const depositedStakeA = readU64le(data, o); o += 8;
  const depositedStakeB = readU64le(data, o); o += 8;
  const buyInLamports = readU64le(data, o); o += 8;
  const buyInTotal = readU64le(data, o); o += 8;
  const entryCount = readU32le(data, o); o += 4;
  const supportTotal = readU64le(data, o); o += 8;
  const prizeBoostTotal = readU64le(data, o); o += 8;
  const supportDeadline = Number(readI64le(data, o)); o += 8;
  const depositDeadline = Number(readI64le(data, o)); o += 8;
  const resolveDeadline = Number(readI64le(data, o)); o += 8;
  const supportClosed = readU8(data, o) !== 0; o += 1;
  const resultType = readU8(data, o); o += 1;
  const winnerSide = readU8(data, o); o += 1;
  const winnerAsset = readPubkeyBase58(PublicKey, data, o); o += 32;
  const winnerWallet = readPubkeyBase58(PublicKey, data, o); o += 32;
  o += 32; // outcome_hash
  const cancellationReason = readU8(data, o); o += 1;
  const pendingWinner = readU64le(data, o); o += 8;
  const pendingProtocol = readU64le(data, o); o += 8;
  const pendingMwl = readU64le(data, o); o += 8;
  const claimedWinner = readU8(data, o) !== 0; o += 1;
  const claimedProtocol = readU8(data, o) !== 0; o += 1;
  const claimedMwl = readU8(data, o) !== 0; o += 1;
  const refundedA = readU8(data, o) !== 0; o += 1;
  const refundedB = readU8(data, o) !== 0; o += 1;
  return {
    poolId,
    kind,
    state,
    assetA,
    assetB,
    ownerA,
    ownerB,
    requiredStakeA,
    requiredStakeB,
    depositedStakeA,
    depositedStakeB,
    buyInLamports,
    buyInTotal,
    entryCount,
    supportTotal,
    prizeBoostTotal,
    supportDeadline,
    depositDeadline,
    resolveDeadline,
    supportClosed,
    resultType,
    winnerSide,
    winnerAsset,
    winnerWallet,
    cancellationReason,
    pendingWinner,
    pendingProtocol,
    pendingMwl,
    claimedWinner,
    claimedProtocol,
    claimedMwl,
    refundedA,
    refundedB,
  };
}

export function validateCanonicalArenaConfig({ account, owner, genesisHash, chainId, PublicKey }) {
  const expectedOwner = REWARDS_TREASURY_PROGRAM_ID;
  const expectedGenesis = expectedGenesisHash(chainId);
  if (expectedGenesis && String(genesisHash || "") !== expectedGenesis) {
    return { live: false, reason: "cluster-mismatch" };
  }
  if (!account?.data) return { live: false, reason: "missing-account" };
  if (String(owner || "") !== expectedOwner) return { live: false, reason: "wrong-owner" };
  const parsed = parseArenaConfig(account.data instanceof Uint8Array ? account.data : Uint8Array.from(account.data), PublicKey);
  if (!parsed) return { live: false, reason: "bad-layout" };
  if (parsed.depositsPaused) return { live: false, reason: "paused", config: parsed };
  return { live: true, reason: "ok", config: parsed };
}
