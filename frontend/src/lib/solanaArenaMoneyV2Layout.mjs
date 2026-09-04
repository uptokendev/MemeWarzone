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

function accountData(account) {
  if (!account?.data) return null;
  return account.data instanceof Uint8Array ? account.data : Uint8Array.from(account.data);
}

function verifyAccountIdentity({ account, owner, accountAddress, expectedPda }) {
  if (!account?.data) return { ok: false, reason: "missing-account" };
  if (String(owner || "") !== ARENA_MONEY_V2_PROGRAM_ID) return { ok: false, reason: "wrong-owner" };
  if (expectedPda && String(accountAddress || "") !== String(expectedPda)) return { ok: false, reason: "wrong-pda" };
  return { ok: true };
}

function normalizedHex(value) {
  return String(value || "").replace(/^0x/i, "").toLowerCase();
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
  if (!data || data.length < 8 + 1 + 32 + 2 + 32 * 5 + 8 * 6 + 4 + 32 * 2 + 8 * 3 + 3 + 8 * 3 + 1) return null;
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
    generation, competitionId, kind, state, authority, assetA, assetB, ownerA, ownerB,
    requiredEntryLamports, entryTotalLamports, entryCount, boostGrossLamports, boostPrizeLamports,
    boostProtocolLamports, winnerAsset, winnerWallet, pendingWinnerLamports, pendingLeagueLamports,
    pendingProtocolLamports, winnerClaimed, leagueClaimed, protocolClaimed, opensAt, closesAt, resolvedAt, bump,
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

export function parseBoostReceiptV2(data, PublicKey) {
  if (!data || data.length < 8 + 1 + 32 + 32 + 32 + 8 * 4 + 2) return null;
  if (!bytesEqual(data.subarray(0, 8), BOOST_RECEIPT_V2_DISCRIMINATOR)) return null;
  let o = 8;
  const generation = readU8(data, o); o += 1;
  const competitionId = bytesToHex(data.subarray(o, o + 32)); o += 32;
  const fundingId = bytesToHex(data.subarray(o, o + 32)); o += 32;
  const funder = readPubkey(PublicKey, data, o); o += 32;
  const grossLamports = readU64le(data, o); o += 8;
  const prizeLamports = readU64le(data, o); o += 8;
  const protocolLamports = readU64le(data, o); o += 8;
  const createdAt = Number(readI64le(data, o)); o += 8;
  const refunded = readU8(data, o) !== 0; o += 1;
  const bump = readU8(data, o);
  if (generation !== ARENA_MONEY_GENERATION_V2 || !funder) return null;
  return { generation, competitionId, fundingId, funder, grossLamports, prizeLamports, protocolLamports, createdAt, refunded, bump };
}

export function parsePostGradLeagueTreasuryV2(data, PublicKey) {
  if (!data || data.length < 8 + 1 + 32 * 3 + 8 * 4 + 1) return null;
  if (!bytesEqual(data.subarray(0, 8), POSTGRAD_LEAGUE_TREASURY_V2_DISCRIMINATOR)) return null;
  let o = 8;
  const generation = readU8(data, o); o += 1;
  const authority = readPubkey(PublicKey, data, o); o += 32;
  const monthlyReceiver = readPubkey(PublicKey, data, o); o += 32;
  const quarterlyReceiver = readPubkey(PublicKey, data, o); o += 32;
  const monthlyLamports = readU64le(data, o); o += 8;
  const quarterlyLamports = readU64le(data, o); o += 8;
  const monthlyClaimedLamports = readU64le(data, o); o += 8;
  const quarterlyClaimedLamports = readU64le(data, o); o += 8;
  const bump = readU8(data, o);
  if (generation !== ARENA_MONEY_GENERATION_V2 || !authority || !monthlyReceiver || !quarterlyReceiver) return null;
  return { generation, authority, monthlyReceiver, quarterlyReceiver, monthlyLamports, quarterlyLamports, monthlyClaimedLamports, quarterlyClaimedLamports, bump };
}

export function parseLeagueSourceReceiptV2(data) {
  if (!data || data.length < 8 + 1 + 32 + 1 + 8 * 4 + 1) return null;
  if (!bytesEqual(data.subarray(0, 8), LEAGUE_SOURCE_RECEIPT_V2_DISCRIMINATOR)) return null;
  let o = 8;
  const generation = readU8(data, o); o += 1;
  const sourceId = bytesToHex(data.subarray(o, o + 32)); o += 32;
  const sourceKind = readU8(data, o); o += 1;
  const amountLamports = readU64le(data, o); o += 8;
  const monthlyLamports = readU64le(data, o); o += 8;
  const quarterlyLamports = readU64le(data, o); o += 8;
  const createdAt = Number(readI64le(data, o)); o += 8;
  const bump = readU8(data, o);
  if (generation !== ARENA_MONEY_GENERATION_V2) return null;
  return { generation, sourceId, sourceKind, amountLamports, monthlyLamports, quarterlyLamports, createdAt, bump };
}

export function parseSponsorshipEventV1(data, PublicKey) {
  if (!data || data.length < 8 + 1 + 32 + 32 * 2 + 8 + 2) return null;
  if (!bytesEqual(data.subarray(0, 8), SPONSORSHIP_EVENT_V1_DISCRIMINATOR)) return null;
  let o = 8;
  const generation = readU8(data, o); o += 1;
  const eventId = bytesToHex(data.subarray(o, o + 32)); o += 32;
  const authority = readPubkey(PublicKey, data, o); o += 32;
  const eventReceiver = readPubkey(PublicKey, data, o); o += 32;
  const minimumLamports = readU64le(data, o); o += 8;
  const enabled = readU8(data, o) !== 0; o += 1;
  const bump = readU8(data, o);
  if (generation !== SPONSORSHIP_GENERATION_V1 || !authority || !eventReceiver) return null;
  return { generation, eventId, authority, eventReceiver, minimumLamports, enabled, bump };
}

export function parseEventPrizeVaultV1(data) {
  if (!data || data.length < 8 + 1 + 32 + 8 * 6 + 1) return null;
  if (!bytesEqual(data.subarray(0, 8), EVENT_PRIZE_VAULT_V1_DISCRIMINATOR)) return null;
  let o = 8;
  const generation = readU8(data, o); o += 1;
  const eventId = bytesToHex(data.subarray(o, o + 32)); o += 32;
  const prizeLamports = readU64le(data, o); o += 8;
  const marketingLamports = readU64le(data, o); o += 8;
  const protocolLamports = readU64le(data, o); o += 8;
  const prizeClaimedLamports = readU64le(data, o); o += 8;
  const marketingClaimedLamports = readU64le(data, o); o += 8;
  const protocolClaimedLamports = readU64le(data, o); o += 8;
  const bump = readU8(data, o);
  if (generation !== SPONSORSHIP_GENERATION_V1) return null;
  return { generation, eventId, prizeLamports, marketingLamports, protocolLamports, prizeClaimedLamports, marketingClaimedLamports, protocolClaimedLamports, bump };
}

export function parseSponsorshipReceiptV1(data, PublicKey) {
  if (!data || data.length < 8 + 1 + 32 + 32 + 32 + 8 * 5 + 1) return null;
  if (!bytesEqual(data.subarray(0, 8), SPONSORSHIP_RECEIPT_V1_DISCRIMINATOR)) return null;
  let o = 8;
  const generation = readU8(data, o); o += 1;
  const eventId = bytesToHex(data.subarray(o, o + 32)); o += 32;
  const paymentId = bytesToHex(data.subarray(o, o + 32)); o += 32;
  const sponsor = readPubkey(PublicKey, data, o); o += 32;
  const grossLamports = readU64le(data, o); o += 8;
  const prizeLamports = readU64le(data, o); o += 8;
  const marketingLamports = readU64le(data, o); o += 8;
  const protocolLamports = readU64le(data, o); o += 8;
  const createdAt = Number(readI64le(data, o)); o += 8;
  const bump = readU8(data, o);
  if (generation !== SPONSORSHIP_GENERATION_V1 || !sponsor) return null;
  return { generation, eventId, paymentId, sponsor, grossLamports, prizeLamports, marketingLamports, protocolLamports, createdAt, bump };
}

export function verifyCompetitionEntryReceiptV2({ account, owner, accountAddress, expectedPda, expectedCompetitionId, expectedEntrant, expectedEntryAsset, expectedAmountLamports, PublicKey }) {
  const identity = verifyAccountIdentity({ account, owner, accountAddress, expectedPda });
  if (!identity.ok) return identity;
  const parsed = parseCompetitionEntryReceiptV2(accountData(account), PublicKey);
  if (!parsed) return { ok: false, reason: "bad-layout-or-generation" };
  if (parsed.competitionId !== normalizedHex(expectedCompetitionId)) return { ok: false, reason: "competition-mismatch" };
  if (parsed.entrant !== String(expectedEntrant || "")) return { ok: false, reason: "entrant-mismatch" };
  if (parsed.entryAsset !== String(expectedEntryAsset || "")) return { ok: false, reason: "asset-mismatch" };
  if (parsed.amountLamports !== BigInt(expectedAmountLamports)) return { ok: false, reason: "amount-mismatch" };
  if (parsed.refunded) return { ok: false, reason: "refunded" };
  return { ok: true, receipt: parsed };
}

export function verifyBoostReceiptV2({ account, owner, accountAddress, expectedPda, expectedCompetitionId, expectedFundingId, expectedFunder, expectedGrossLamports, expectedPrizeLamports, expectedProtocolLamports, PublicKey }) {
  const identity = verifyAccountIdentity({ account, owner, accountAddress, expectedPda });
  if (!identity.ok) return identity;
  const parsed = parseBoostReceiptV2(accountData(account), PublicKey);
  if (!parsed) return { ok: false, reason: "bad-layout-or-generation" };
  if (parsed.competitionId !== normalizedHex(expectedCompetitionId)) return { ok: false, reason: "competition-mismatch" };
  if (parsed.fundingId !== normalizedHex(expectedFundingId)) return { ok: false, reason: "funding-mismatch" };
  if (parsed.funder !== String(expectedFunder || "")) return { ok: false, reason: "funder-mismatch" };
  if (parsed.grossLamports !== BigInt(expectedGrossLamports)) return { ok: false, reason: "gross-mismatch" };
  if (expectedPrizeLamports != null && parsed.prizeLamports !== BigInt(expectedPrizeLamports)) return { ok: false, reason: "prize-mismatch" };
  if (expectedProtocolLamports != null && parsed.protocolLamports !== BigInt(expectedProtocolLamports)) return { ok: false, reason: "protocol-mismatch" };
  if (parsed.prizeLamports + parsed.protocolLamports !== parsed.grossLamports) return { ok: false, reason: "split-mismatch" };
  if (parsed.refunded) return { ok: false, reason: "refunded" };
  return { ok: true, receipt: parsed };
}

export function verifyPostGradLeagueTreasuryV2({ account, owner, accountAddress, expectedPda, PublicKey }) {
  const identity = verifyAccountIdentity({ account, owner, accountAddress, expectedPda });
  if (!identity.ok) return identity;
  const parsed = parsePostGradLeagueTreasuryV2(accountData(account), PublicKey);
  return parsed ? { ok: true, treasury: parsed } : { ok: false, reason: "bad-layout-or-generation" };
}

export function verifyLeagueSourceReceiptV2({ account, owner, accountAddress, expectedPda, expectedSourceId, expectedSourceKind = 1, expectedAmountLamports }) {
  const identity = verifyAccountIdentity({ account, owner, accountAddress, expectedPda });
  if (!identity.ok) return identity;
  const parsed = parseLeagueSourceReceiptV2(accountData(account));
  if (!parsed) return { ok: false, reason: "bad-layout-or-generation" };
  if (parsed.sourceId !== normalizedHex(expectedSourceId)) return { ok: false, reason: "source-mismatch" };
  if (parsed.sourceKind !== Number(expectedSourceKind)) return { ok: false, reason: "source-kind-mismatch" };
  if (expectedAmountLamports != null && parsed.amountLamports !== BigInt(expectedAmountLamports)) return { ok: false, reason: "amount-mismatch" };
  if (parsed.monthlyLamports + parsed.quarterlyLamports !== parsed.amountLamports) return { ok: false, reason: "split-mismatch" };
  return { ok: true, receipt: parsed };
}

export function verifySponsorshipEventV1({ account, owner, accountAddress, expectedPda, expectedEventId, PublicKey }) {
  const identity = verifyAccountIdentity({ account, owner, accountAddress, expectedPda });
  if (!identity.ok) return identity;
  const parsed = parseSponsorshipEventV1(accountData(account), PublicKey);
  if (!parsed) return { ok: false, reason: "bad-layout-or-generation" };
  if (parsed.eventId !== normalizedHex(expectedEventId)) return { ok: false, reason: "event-mismatch" };
  return { ok: true, event: parsed };
}

export function verifyEventPrizeVaultV1({ account, owner, accountAddress, expectedPda, expectedEventId }) {
  const identity = verifyAccountIdentity({ account, owner, accountAddress, expectedPda });
  if (!identity.ok) return identity;
  const parsed = parseEventPrizeVaultV1(accountData(account));
  if (!parsed) return { ok: false, reason: "bad-layout-or-generation" };
  if (parsed.eventId !== normalizedHex(expectedEventId)) return { ok: false, reason: "event-mismatch" };
  return { ok: true, vault: parsed };
}

export function verifySponsorshipReceiptV1({ account, owner, accountAddress, expectedPda, expectedEventId, expectedPaymentId, expectedSponsor, expectedGrossLamports, expectedPrizeLamports, expectedMarketingLamports, expectedProtocolLamports, PublicKey }) {
  const identity = verifyAccountIdentity({ account, owner, accountAddress, expectedPda });
  if (!identity.ok) return identity;
  const parsed = parseSponsorshipReceiptV1(accountData(account), PublicKey);
  if (!parsed) return { ok: false, reason: "bad-layout-or-generation" };
  if (parsed.eventId !== normalizedHex(expectedEventId)) return { ok: false, reason: "event-mismatch" };
  if (parsed.paymentId !== normalizedHex(expectedPaymentId)) return { ok: false, reason: "payment-mismatch" };
  if (parsed.sponsor !== String(expectedSponsor || "")) return { ok: false, reason: "sponsor-mismatch" };
  if (parsed.grossLamports !== BigInt(expectedGrossLamports)) return { ok: false, reason: "gross-mismatch" };
  if (expectedPrizeLamports != null && parsed.prizeLamports !== BigInt(expectedPrizeLamports)) return { ok: false, reason: "prize-mismatch" };
  if (expectedMarketingLamports != null && parsed.marketingLamports !== BigInt(expectedMarketingLamports)) return { ok: false, reason: "marketing-mismatch" };
  if (expectedProtocolLamports != null && parsed.protocolLamports !== BigInt(expectedProtocolLamports)) return { ok: false, reason: "protocol-mismatch" };
  if (parsed.prizeLamports + parsed.marketingLamports + parsed.protocolLamports !== parsed.grossLamports) return { ok: false, reason: "split-mismatch" };
  return { ok: true, receipt: parsed };
}
