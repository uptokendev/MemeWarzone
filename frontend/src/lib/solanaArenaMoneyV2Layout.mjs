/** Solana Arena Money V2 layout helpers. Historical ArenaPool parsing stays in solanaArenaLayout.mjs. */

export const ARENA_MONEY_V2_PROGRAM_ID = "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX";
export const ARENA_MONEY_CONFIG_SEED_V2 = "arena_money_config_v2";
export const COMPETITION_POOL_SEED_V2 = "arena_competition_v2";
export const COMPETITION_ENTRY_RECEIPT_SEED_V2 = "arena_money_entry_v2";
export const BOOST_RECEIPT_SEED_V2 = "arena_money_boost_v2";
export const POSTGRAD_LEAGUE_TREASURY_SEED_V2 = "postgrad_league_v2";
export const LEAGUE_SOURCE_RECEIPT_SEED_V2 = "arena_money_league_src_v2";
export const SPONSORSHIP_EVENT_SEED_V1 = "arena_sponsor_event_v1";
export const EVENT_PRIZE_VAULT_SEED_V1 = "arena_event_prize_v1";
export const SPONSORSHIP_RECEIPT_SEED_V1 = "arena_sponsor_receipt_v1";

export const ARENA_MONEY_GENERATION_V2 = 2;
export const SPONSORSHIP_GENERATION_V1 = 1;

export const ARENA_MONEY_CONFIG_V2_DISCRIMINATOR = Uint8Array.from([58, 203, 116, 47, 28, 49, 122, 236]);
export const COMPETITION_POOL_V2_DISCRIMINATOR = Uint8Array.from([107, 211, 169, 103, 128, 136, 73, 98]);
export const COMPETITION_ENTRY_RECEIPT_V2_DISCRIMINATOR = Uint8Array.from([151, 49, 194, 209, 77, 39, 50, 125]);
export const BOOST_RECEIPT_V2_DISCRIMINATOR = Uint8Array.from([158, 98, 73, 140, 127, 221, 19, 73]);
export const POSTGRAD_LEAGUE_TREASURY_V2_DISCRIMINATOR = Uint8Array.from([248, 230, 242, 102, 70, 70, 70, 91]);
export const LEAGUE_SOURCE_RECEIPT_V2_DISCRIMINATOR = Uint8Array.from([93, 81, 214, 19, 51, 155, 232, 229]);
export const SPONSORSHIP_EVENT_V1_DISCRIMINATOR = Uint8Array.from([237, 19, 33, 175, 240, 22, 152, 166]);
export const EVENT_PRIZE_VAULT_V1_DISCRIMINATOR = Uint8Array.from([179, 86, 37, 35, 246, 141, 219, 61]);
export const SPONSORSHIP_RECEIPT_V1_DISCRIMINATOR = Uint8Array.from([63, 55, 160, 125, 182, 10, 105, 83]);

function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function readU8(data, offset) {
  return data[offset];
}

function readU32le(data, offset) {
  return data[offset] + (data[offset + 1] << 8) + (data[offset + 2] << 16) + data[offset + 3] * 0x1000000;
}

function readU64le(data, offset) {
  const lo = BigInt(readU32le(data, offset));
  const hi = BigInt(readU32le(data, offset + 4));
  return lo + (hi << 32n);
}

function readI64le(data, offset) {
  const value = readU64le(data, offset);
  return value > 0x7fffffffffffffffn ? value - 0x10000000000000000n : value;
}

function readPubkey(PublicKey, data, offset) {
  const bytes = data.subarray(offset, offset + 32);
  if (bytes.every((value) => value === 0)) return "";
  return new PublicKey(bytes).toBase58();
}

function bytesToHex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function parseArenaMoneyConfigV2(data, PublicKey) {
  if (!data || data.length < 8 + 1 + 32 * 4 + 2) return null;
  if (!bytesEqual(data.subarray(0, 8), ARENA_MONEY_CONFIG_V2_DISCRIMINATOR)) return null;
  let o = 8;
  const generation = readU8(data, o); o += 1;
  const authority = readPubkey(PublicKey, data, o); o += 32;
  const resolver = readPubkey(PublicKey, data, o); o += 32;
  const protocolReceiver = readPubkey(PublicKey, data, o); o += 32;
  const marketingReceiver = readPubkey(PublicKey, data, o); o += 32;
  const paused = readU8(data, o) !== 0; o += 1;
  const bump = readU8(data, o);
  if (generation !== ARENA_MONEY_GENERATION_V2) return null;
  if (!authority || !resolver || !protocolReceiver || !marketingReceiver) return null;
  return { generation, authority, resolver, protocolReceiver, marketingReceiver, paused, bump };
}

export function parseCompetitionPoolV2(data, PublicKey) {
  if (!data || data.length < 8 + 1 + 32 + 2 + 32 * 5) return null;
  if (!bytesEqual(data.subarray(0, 8), COMPETITION_POOL_V2_DISCRIMINATOR)) return null;
  let o = 8;
  const generation = readU8(data, o); o += 1;
  const competitionId = bytesToHex(data.subarray(o, o + 32)); o += 32;
  const kind = readU8(data, o); o += 1;
  const state = readU8(data, o); o += 1;
  const authority = readPubkey(PublicKey, data, o); o += 32;
  const assetA = readPubkey(PublicKey, data, o); o += 32;
  const assetB = readPubkey(PublicKey, data, o); o += 32;
  const ownerA = readPubkey(PublicKey, data, o); o += 32;
  const ownerB = readPubkey(PublicKey, data, o); o += 32;
  const requiredEntryLamports = readU64le(data, o); o += 8;
  const entryTotalLamports = readU64le(data, o); o += 8;
  const entryCount = readU32le(data, o); o += 4;
  const boostGrossLamports = readU64le(data, o); o += 8;
  const boostPrizeLamports = readU64le(data, o); o += 8;
  const boostProtocolLamports = readU64le(data, o); o += 8;
  const winnerAsset = readPubkey(PublicKey, data, o); o += 32;
  const winnerWallet = readPubkey(PublicKey, data, o); o += 32;
  const pendingWinnerLamports = readU64le(data, o); o += 8;
  const pendingLeagueLamports = readU64le(data, o); o += 8;
  const pendingProtocolLamports = readU64le(data, o); o += 8;
  const winnerClaimed = readU8(data, o) !== 0; o += 1;
  const leagueClaimed = readU8(data, o) !== 0; o += 1;
  const protocolClaimed = readU8(data, o) !== 0; o += 1;
  const opensAt = Number(readI64le(data, o)); o += 8;
  const closesAt = Number(readI64le(data, o)); o += 8;
  const resolvedAt = Number(readI64le(data, o)); o += 8;
  const bump = readU8(data, o);
  if (generation !== ARENA_MONEY_GENERATION_V2) return null;
  return {
    generation,
    competitionId,
    kind,
    state,
    authority,
    assetA,
    assetB,
    ownerA,
    ownerB,
    requiredEntryLamports,
    entryTotalLamports,
    entryCount,
    boostGrossLamports,
    boostPrizeLamports,
    boostProtocolLamports,
    winnerAsset,
    winnerWallet,
    pendingWinnerLamports,
    pendingLeagueLamports,
    pendingProtocolLamports,
    winnerClaimed,
    leagueClaimed,
    protocolClaimed,
    opensAt,
    closesAt,
    resolvedAt,
    bump,
  };
}

export function parseCompetitionEntryReceiptV2(data, PublicKey) {
  if (!data || data.length < 8 + 1 + 32 + 32 + 32 + 8 + 8 + 2) return null;
  if (!bytesEqual(data.subarray(0, 8), COMPETITION_ENTRY_RECEIPT_V2_DISCRIMINATOR)) return null;
  let o = 8;
  const generation = readU8(data, o); o += 1;
  const competitionId = bytesToHex(data.subarray(o, o + 32)); o += 32;
  const entrant = readPubkey(PublicKey, data, o); o += 32;
  const entryAsset = readPubkey(PublicKey, data, o); o += 32;
  const amountLamports = readU64le(data, o); o += 8;
  const createdAt = Number(readI64le(data, o)); o += 8;
  const refunded = readU8(data, o) !== 0; o += 1;
  const bump = readU8(data, o);
  if (generation !== ARENA_MONEY_GENERATION_V2 || !entrant || !entryAsset) return null;
  return { generation, competitionId, entrant, entryAsset, amountLamports, createdAt, refunded, bump };
}

export function verifyCompetitionEntryReceiptV2({ account, owner, expectedCompetitionId, expectedEntrant, expectedEntryAsset, expectedAmountLamports, PublicKey }) {
  if (!account?.data) return { ok: false, reason: "missing-account" };
  if (String(owner || "") !== ARENA_MONEY_V2_PROGRAM_ID) return { ok: false, reason: "wrong-owner" };
  const parsed = parseCompetitionEntryReceiptV2(account.data instanceof Uint8Array ? account.data : Uint8Array.from(account.data), PublicKey);
  if (!parsed) return { ok: false, reason: "bad-layout-or-generation" };
  if (parsed.competitionId.toLowerCase() !== String(expectedCompetitionId || "").replace(/^0x/i, "").toLowerCase()) return { ok: false, reason: "competition-mismatch" };
  if (parsed.entrant !== String(expectedEntrant || "")) return { ok: false, reason: "entrant-mismatch" };
  if (parsed.entryAsset !== String(expectedEntryAsset || "")) return { ok: false, reason: "asset-mismatch" };
  if (parsed.amountLamports !== BigInt(expectedAmountLamports)) return { ok: false, reason: "amount-mismatch" };
  if (parsed.refunded) return { ok: false, reason: "refunded" };
  return { ok: true, receipt: parsed };
}
