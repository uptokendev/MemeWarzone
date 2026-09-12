/**
 * Shared notification contract V1 (Discordfix N4).
 *
 * Producers call enqueueNotification(). This module resolves chain identity
 * (BNB / Solana / Robinhood), environment, and the canonical envelope so
 * callers never handcraft outbox rows or collapse Robinhood into BNB.
 *
 * Unknown chain fails closed. Never: isEvm ? "bnb" : "solana".
 */

export const NOTIFICATION_SCHEMA_VERSION = 1;

export const CHAIN_LABELS = ["bnb", "solana", "robinhood"];
export const NOTIFICATION_CHAINS = ["bnb", "solana", "robinhood", "global"];

const CHAIN_IDS = {
  56: "bnb",
  97: "bnb",
  101: "solana",
  102: "solana",
  4663: "robinhood",
  46630: "robinhood",
};

const LABEL_ALIASES = {
  bnb: "bnb",
  bsc: "bnb",
  solana: "solana",
  sol: "solana",
  "mainnet-beta": "solana",
  mainnet: "solana",
  devnet: "solana",
  "solana-devnet": "solana",
  robinhood: "robinhood",
  rh: "robinhood",
  "robinhood-testnet": "robinhood",
};

const STAGING_IDS = new Set(["97", "102", "46630"]);
const PRODUCTION_IDS = new Set(["56", "101", "4663"]);

const ENTITY_TYPES = [
  "campaign",
  "battle",
  "tournament",
  "league",
  "reward",
  "recruiter",
  "squad",
  "platform",
];

function chainIdKey(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") {
    if (!Number.isInteger(input)) return null;
    return String(input);
  }
  const trimmed = String(input).trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return String(Number.parseInt(trimmed, 10));
  return trimmed.toLowerCase();
}

export function getChainById(chainId) {
  const key = chainIdKey(chainId);
  if (!key) return null;
  if (/^\d+$/.test(key)) return CHAIN_IDS[Number(key)] ?? null;
  return LABEL_ALIASES[key] ?? null;
}

export function normalizeChain(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") return getChainById(input);
  const normalized = String(input).trim().toLowerCase();
  if (!normalized) return null;
  if (CHAIN_LABELS.includes(normalized)) return normalized;
  if (LABEL_ALIASES[normalized]) return LABEL_ALIASES[normalized];
  return getChainById(normalized);
}

export function getNotificationChain(input) {
  if (typeof input === "string" && input.trim().toLowerCase() === "global") return "global";
  return normalizeChain(input);
}

export function resolveChainEnvironment({ environment, chainId } = {}) {
  const explicit = typeof environment === "string" ? environment.trim().toLowerCase() : "";
  if (explicit === "staging" || explicit === "production") return explicit;
  const key = chainIdKey(chainId);
  if (!key) return null;
  if (STAGING_IDS.has(key)) return "staging";
  if (PRODUCTION_IDS.has(key)) return "production";
  if (key === "devnet" || key === "solana-devnet" || key === "bsc-testnet" || key === "robinhood-testnet") {
    return "staging";
  }
  return null;
}

export function entityTypeFromEvent(eventType) {
  const prefix = String(eventType || "").split(".")[0] || "platform";
  return ENTITY_TYPES.includes(prefix) ? prefix : "platform";
}

export function entityIdFromPayload(eventType, payload = {}) {
  const candidates = [
    payload.entityId,
    payload.campaignId,
    payload.campaign,
    payload.draftId,
    payload.battleId,
    payload.tournamentId,
    payload.leagueId,
    payload.epoch,
    payload.epochId,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return String(eventType || "unknown");
}

/**
 * Build the V1 envelope Discord consumes. Throws UNSUPPORTED_CHAIN rather
 * than labelling an unknown id as BNB.
 */
export function buildNotificationEnvelope(input) {
  const eventType = String(input.eventType || "").trim();
  if (!eventType) throw new Error("UNSUPPORTED_SCHEMA: missing eventType");

  const inner = input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
    ? { ...input.payload }
    : {};

  const chainId = input.chainId ?? inner.chainId ?? inner.chain_id ?? null;
  const chain = getNotificationChain(input.chain) || getNotificationChain(chainId);
  if (!chain) {
    throw new Error(`UNSUPPORTED_CHAIN: ${String(input.chain ?? chainId)}`);
  }

  const environment = resolveChainEnvironment({
    environment: input.environment,
    chainId,
  });

  const entityType = input.entityType || entityTypeFromEvent(eventType);
  const entityId = input.entityId || entityIdFromPayload(eventType, inner);
  const dedupKey = String(input.dedupKey || "").trim();
  if (!dedupKey) throw new Error("UNSUPPORTED_SCHEMA: missing dedupKey");

  const occurredAt = input.occurredAt || new Date().toISOString();

  return {
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    eventType,
    chain,
    chainId: chainId === undefined ? null : chainId,
    environment,
    entityType,
    entityId,
    occurredAt,
    dedupKey,
    payload: inner,
  };
}

export async function enqueueNotification(db, input) {
  const envelope = buildNotificationEnvelope(input);

  if (input.markerKey) {
    const { rowCount } = await db.query(
      `INSERT INTO public.notification_markers (marker_key)
       VALUES ($1) ON CONFLICT DO NOTHING`,
      [input.markerKey],
    );
    if (rowCount === 0) return false;
  }

  await db.query(
    `INSERT INTO public.notification_outbox (event_type, chain, dedup_key, payload)
     VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING`,
    [envelope.eventType, envelope.chain, envelope.dedupKey, JSON.stringify(envelope)],
  );
  return true;
}
