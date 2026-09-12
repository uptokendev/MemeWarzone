/**
 * Indexer copy of the V1 notification contract (Discordfix N4).
 * Keep in lockstep with frontend/api/lib/notificationContract.js.
 */

export const NOTIFICATION_SCHEMA_VERSION = 1 as const;

const CHAIN_IDS: Record<number, "bnb" | "solana" | "robinhood"> = {
  56: "bnb",
  97: "bnb",
  101: "solana",
  102: "solana",
  4663: "robinhood",
  46630: "robinhood",
};

const LABEL_ALIASES: Record<string, "bnb" | "solana" | "robinhood"> = {
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
] as const;

export type NotificationChain = "bnb" | "solana" | "robinhood" | "global";

function chainIdKey(input: unknown): string | null {
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

export function normalizeChain(input: unknown): "bnb" | "solana" | "robinhood" | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") {
    return CHAIN_IDS[input] ?? null;
  }
  const normalized = String(input).trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "bnb" || normalized === "solana" || normalized === "robinhood") return normalized;
  if (LABEL_ALIASES[normalized]) return LABEL_ALIASES[normalized];
  const key = chainIdKey(normalized);
  if (key && /^\d+$/.test(key)) return CHAIN_IDS[Number(key)] ?? null;
  return null;
}

export function getNotificationChain(input: unknown): NotificationChain | null {
  if (typeof input === "string" && input.trim().toLowerCase() === "global") return "global";
  return normalizeChain(input);
}

export function resolveChainEnvironment(params: {
  environment?: string | null;
  chainId?: unknown;
}): "staging" | "production" | null {
  const explicit = typeof params.environment === "string" ? params.environment.trim().toLowerCase() : "";
  if (explicit === "staging" || explicit === "production") return explicit;
  const key = chainIdKey(params.chainId);
  if (!key) return null;
  if (STAGING_IDS.has(key)) return "staging";
  if (PRODUCTION_IDS.has(key)) return "production";
  return null;
}

function entityTypeFromEvent(eventType: string): string {
  const prefix = eventType.split(".")[0] || "platform";
  return (ENTITY_TYPES as readonly string[]).includes(prefix) ? prefix : "platform";
}

function entityIdFromPayload(eventType: string, payload: Record<string, unknown>): string {
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
  return eventType || "unknown";
}

export function buildNotificationEnvelope(input: {
  eventType: string;
  chain?: string;
  chainId?: unknown;
  environment?: string | null;
  entityType?: string;
  entityId?: string;
  dedupKey: string;
  payload?: Record<string, unknown>;
  occurredAt?: string;
}) {
  const eventType = String(input.eventType || "").trim();
  if (!eventType) throw new Error("UNSUPPORTED_SCHEMA: missing eventType");
  const inner =
    input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
      ? { ...input.payload }
      : {};
  const chainId = input.chainId ?? inner.chainId ?? inner.chain_id ?? null;
  const chain = getNotificationChain(input.chain) || getNotificationChain(chainId);
  if (!chain) throw new Error(`UNSUPPORTED_CHAIN: ${String(input.chain ?? chainId)}`);
  const dedupKey = String(input.dedupKey || "").trim();
  if (!dedupKey) throw new Error("UNSUPPORTED_SCHEMA: missing dedupKey");
  return {
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    eventType,
    chain,
    chainId,
    environment: resolveChainEnvironment({ environment: input.environment, chainId }),
    entityType: input.entityType || entityTypeFromEvent(eventType),
    entityId: input.entityId || entityIdFromPayload(eventType, inner),
    occurredAt: input.occurredAt || new Date().toISOString(),
    dedupKey,
    payload: inner,
  };
}
