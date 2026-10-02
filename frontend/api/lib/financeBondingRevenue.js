import { postFinanceEconomicEvent } from "./financePosting.js";

const SUPPORTED_BNB_CHAINS = new Set([56, 97]);

function requiredText(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new TypeError(`${field} is required`);
  return normalized;
}

function integerString(value, field) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) throw new TypeError(`${field} must be a non-negative integer`);
  return text.replace(/^0+(?=\d)/, "");
}

function positiveInteger(value, field) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError(`${field} must be a non-negative integer`);
  return parsed;
}

function lowerAddress(value, field) {
  const normalized = requiredText(value, field).toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) throw new TypeError(`${field} must be an EVM address`);
  return normalized;
}

function timestamp(value, field) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${field} must be a valid timestamp`);
  return parsed.toISOString();
}

export function buildBnbBondingProtocolRevenuePosting(rewardEvent = {}, options = {}) {
  const chainId = Number(rewardEvent.chain_id ?? rewardEvent.chainId);
  if (!SUPPORTED_BNB_CHAINS.has(chainId)) throw new TypeError("BNB bonding revenue adapter only supports chain 56 or 97");

  const routeKind = requiredText(rewardEvent.route_kind ?? rewardEvent.routeKind, "rewardEvent.route_kind");
  if (routeKind !== "trade") throw new TypeError("BNB bonding revenue adapter requires rewardEvent.route_kind = trade");

  const protocolAmount = integerString(rewardEvent.protocol_amount ?? rewardEvent.protocolAmount, "rewardEvent.protocol_amount");
  if (protocolAmount === "0") throw new TypeError("BNB bonding revenue adapter requires protocol_amount > 0");

  const sourceContract = lowerAddress(rewardEvent.source_contract ?? rewardEvent.sourceContract, "rewardEvent.source_contract");
  const expectedSourceContract = lowerAddress(options.expectedSourceContract, "expectedSourceContract");
  if (sourceContract !== expectedSourceContract) {
    throw new TypeError("rewardEvent.source_contract does not match the configured Treasury routing authority");
  }

  const occurredAt = timestamp(rewardEvent.occurred_at ?? rewardEvent.occurredAt, "rewardEvent.occurred_at");
  const finalizedAt = timestamp(options.finalizedAt, "finalizedAt");
  if (new Date(finalizedAt).getTime() < new Date(occurredAt).getTime()) {
    throw new TypeError("finalizedAt must be at or after rewardEvent.occurred_at");
  }

  const rewardEventId = positiveInteger(rewardEvent.id, "rewardEvent.id");
  const txHash = requiredText(rewardEvent.tx_hash ?? rewardEvent.txHash, "rewardEvent.tx_hash").toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(txHash)) throw new TypeError("rewardEvent.tx_hash must be a 32-byte EVM transaction hash");

  const logIndex = positiveInteger(rewardEvent.log_index ?? rewardEvent.logIndex, "rewardEvent.log_index");
  const blockNumber = integerString(rewardEvent.block_number ?? rewardEvent.blockNumber, "rewardEvent.block_number");
  const rawAmount = integerString(rewardEvent.raw_amount ?? rewardEvent.rawAmount, "rewardEvent.raw_amount");

  return {
    evidence: {
      chainFamily: "evm",
      chainId,
      networkKey: requiredText(options.networkKey, "networkKey"),
      deploymentGeneration: requiredText(options.deploymentGeneration, "deploymentGeneration"),
      sourceSystem: "reward_events",
      sourceEventType: "BondingTradeProtocolRevenue",
      sourcePrimaryKey: `reward_events:${rewardEventId}`,
      transactionRef: txHash,
      blockOrSlot: blockNumber,
      eventIndex: logIndex,
      innerEventIndex: -1,
      decoderVersion: requiredText(options.decoderVersion, "decoderVersion"),
      assetSymbol: "BNB",
      assetAddressOrMint: null,
      grossAmountRaw: protocolAmount,
      occurredAt,
      finalizedAt,
      metadata: {
        rewardEventId,
        routeKind,
        routeProfile: String(rewardEvent.route_profile ?? rewardEvent.routeProfile ?? ""),
        sourceContract,
        sourceEvent: String(rewardEvent.source_event ?? rewardEvent.sourceEvent ?? "RouteExecuted"),
        campaignAddress: rewardEvent.campaign_address ?? rewardEvent.campaignAddress ?? null,
        matchedActivitySource: rewardEvent.matched_activity_source ?? rewardEvent.matchedActivitySource ?? null,
        rawRouteAmount: rawAmount,
      },
    },
    classifications: [
      {
        classificationVersion: 1,
        componentKey: "protocol",
        economicClass: "protocol_revenue",
        economicLane: "bonding_curve_fee",
        amountRaw: protocolAmount,
        recognitionStatus: "recognized",
        reconciliationStatus: "matched",
        policyVersion: requiredText(options.policyVersion, "policyVersion"),
        classificationReason: "Authoritative reward_events.protocol_amount for BNB trade routing",
        metadata: { rewardEventId },
      },
    ],
  };
}

export async function postBnbBondingProtocolRevenue(pool, rewardEvent, options) {
  return postFinanceEconomicEvent(pool, buildBnbBondingProtocolRevenuePosting(rewardEvent, options));
}
