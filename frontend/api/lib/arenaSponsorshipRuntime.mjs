import crypto from "node:crypto";
import { Contract, Interface, Wallet, getAddress, id } from "ethers";

const EVENT_BPS = 7_000n;
const MARKETING_BPS = 2_000n;
const PROTOCOL_BPS = 1_000n;
const BPS = 10_000n;
const DEFAULT_QUOTE_TTL_SECONDS = 300n;
const DEFAULT_PRICE_MAX_AGE_SECONDS = 300n;

const sponsorshipInterface = new Interface([
  "event SponsorshipPaid(bytes32 indexed eventId,address indexed sponsor,uint256 indexed nonce,bytes32 pricingTier,uint256 pricingVersion,uint256 minimumUsdMicros,uint256 requestedUsdMicros,uint256 nativeUsdReferenceMicros,uint256 oracleTimestamp,uint256 grossNativeRaw,uint256 eventNativeRaw,uint256 marketingNativeRaw,uint256 protocolNativeRaw)",
]);

const ROUTER_READ_ABI = [
  "function enabledEvents(bytes32 eventId) view returns (bool)",
  "function eventPrizeVault() view returns (address)",
];
const VAULT_READ_ABI = ["function eventReceivers(bytes32 eventId) view returns (address)"];

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

function ceilDiv(a, b) {
  return (a + b - 1n) / b;
}

export function sponsorshipEventId(eventUuid) {
  const value = String(eventUuid || "").trim();
  if (!value) throw new Error("sponsorship event id is required");
  return id(`warzone-sponsorship-event:${value}`);
}

export function sponsorshipPricingTierId(code) {
  const value = String(code || "").trim().toUpperCase();
  if (!value) throw new Error("sponsorship pricing tier is required");
  return id(`warzone-sponsorship-tier:${value}`);
}

export function sponsorshipSplit(grossRaw) {
  const gross = positiveBigInt(grossRaw, "grossNativeRaw");
  const marketing = (gross * MARKETING_BPS) / BPS;
  const protocol = (gross * PROTOCOL_BPS) / BPS;
  const prize = gross - marketing - protocol;
  return { gross, prize, marketing, protocol, eventBps: 7000, marketingBps: 2000, protocolBps: 1000 };
}

export function sponsorshipRouterAddress(chainId, env = process.env) {
  const chain = Number(chainId);
  const raw = String(
    env[`WARZONE_SPONSORSHIP_ROUTER_V1_ADDRESS_${chain}`] || env.WARZONE_SPONSORSHIP_ROUTER_V1_ADDRESS || "",
  ).trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) throw new Error(`Sponsorship router address is not configured for chain ${chain}`);
  return getAddress(raw);
}

export function readSponsorshipPricingConfig(chainId, env = process.env, nowSeconds = Math.floor(Date.now() / 1000)) {
  const chain = Number(chainId);
  if (!Number.isInteger(chain) || chain <= 0) throw new Error("chainId is invalid");
  const nativeUsdRaw =
    env[`ARENA_SPONSORSHIP_NATIVE_USD_MICROS_${chain}`] || env.ARENA_SPONSORSHIP_NATIVE_USD_MICROS ||
    env[`ARENA_BOOST_NATIVE_USD_MICROS_${chain}`] || env.ARENA_BOOST_NATIVE_USD_MICROS;
  const pricingVersionRaw =
    env[`ARENA_SPONSORSHIP_PRICING_VERSION_${chain}`] || env.ARENA_SPONSORSHIP_PRICING_VERSION ||
    env[`ARENA_BOOST_PRICING_VERSION_${chain}`] || env.ARENA_BOOST_PRICING_VERSION;
  const updatedAtRaw =
    env[`ARENA_SPONSORSHIP_NATIVE_USD_UPDATED_AT_${chain}`] || env.ARENA_SPONSORSHIP_NATIVE_USD_UPDATED_AT ||
    env[`ARENA_BOOST_NATIVE_USD_UPDATED_AT_${chain}`] || env.ARENA_BOOST_NATIVE_USD_UPDATED_AT;
  const maxAgeRaw =
    env[`ARENA_SPONSORSHIP_PRICE_MAX_AGE_SECONDS_${chain}`] || env.ARENA_SPONSORSHIP_PRICE_MAX_AGE_SECONDS ||
    env[`ARENA_BOOST_PRICE_MAX_AGE_SECONDS_${chain}`] || env.ARENA_BOOST_PRICE_MAX_AGE_SECONDS ||
    DEFAULT_PRICE_MAX_AGE_SECONDS;
  const signerKey = String(env.ARENA_SPONSORSHIP_QUOTE_SIGNER_PRIVATE_KEY || "").trim();
  if (!nativeUsdRaw || !pricingVersionRaw || !updatedAtRaw || !signerKey) {
    throw new Error("Arena sponsorship pricing/signing is not configured for this chain");
  }
  const routerAddress = sponsorshipRouterAddress(chain, env);
  const nativeUsdMicros = positiveBigInt(nativeUsdRaw, "nativeUsdMicros");
  const pricingVersion = positiveBigInt(pricingVersionRaw, "pricingVersion");
  const oracleTimestamp = positiveBigInt(updatedAtRaw, "oracleTimestamp");
  const maxAgeSeconds = positiveBigInt(maxAgeRaw, "maxAgeSeconds");
  const now = BigInt(nowSeconds);
  if (oracleTimestamp > now || now - oracleTimestamp > maxAgeSeconds) throw new Error("Arena sponsorship native/USD price is stale");
  const signer = new Wallet(signerKey.startsWith("0x") ? signerKey : `0x${signerKey}`);
  const configuredSigner = String(
    env[`ARENA_SPONSORSHIP_QUOTE_SIGNER_ADDRESS_${chain}`] || env.ARENA_SPONSORSHIP_QUOTE_SIGNER_ADDRESS || "",
  ).trim();
  if (configuredSigner && getAddress(configuredSigner) !== signer.address) throw new Error("Sponsorship quote signer key/address mismatch");
  return { chainId: chain, nativeUsdMicros, pricingVersion, oracleTimestamp, routerAddress, signer };
}

export async function verifySponsorshipEventConfiguration({ provider, chainId, eventUuid, env = process.env }) {
  if (!provider) throw new Error("Sponsorship RPC provider is unavailable");
  const routerAddress = sponsorshipRouterAddress(chainId, env);
  const eventId = sponsorshipEventId(eventUuid);
  const router = new Contract(routerAddress, ROUTER_READ_ABI, provider);
  if ((await router.enabledEvents(eventId)) !== true) throw new Error("Sponsorship event is not enabled on-chain");
  const vaultAddress = getAddress(String(await router.eventPrizeVault()));
  const vault = new Contract(vaultAddress, VAULT_READ_ABI, provider);
  const receiver = getAddress(String(await vault.eventReceivers(eventId)));
  if (receiver === "0x0000000000000000000000000000000000000000") throw new Error("Sponsorship event prize receiver is not configured");
  return { routerAddress, vaultAddress, eventId, receiver };
}

export function usdMicrosToNativeRaw(usdMicros, nativeUsdMicros, nativeDecimals = 18) {
  const usd = positiveBigInt(usdMicros, "usdMicros");
  const nativeUsd = positiveBigInt(nativeUsdMicros, "nativeUsdMicros");
  const decimals = Number(nativeDecimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("nativeDecimals is invalid");
  return ceilDiv(usd * (10n ** BigInt(decimals)), nativeUsd);
}

export async function signSponsorshipQuote({
  config,
  eventUuid,
  sponsor,
  pricingTierCode,
  minimumUsdMicros,
  requestedUsdMicros,
  nativeDecimals = 18,
  nonce = BigInt(`0x${crypto.randomBytes(16).toString("hex")}`),
  deadline = BigInt(Math.floor(Date.now() / 1000)) + DEFAULT_QUOTE_TTL_SECONDS,
}) {
  const minimumUsd = positiveBigInt(minimumUsdMicros, "minimumUsdMicros");
  const requestedUsd = positiveBigInt(requestedUsdMicros, "requestedUsdMicros");
  if (requestedUsd < minimumUsd) throw new Error("requested sponsorship is below the authoritative minimum");
  const minimumNativeRaw = usdMicrosToNativeRaw(minimumUsd, config.nativeUsdMicros, nativeDecimals);
  const requestedNativeRaw = usdMicrosToNativeRaw(requestedUsd, config.nativeUsdMicros, nativeDecimals);
  const value = {
    eventId: sponsorshipEventId(eventUuid),
    sponsor: getAddress(String(sponsor)),
    pricingTier: sponsorshipPricingTierId(pricingTierCode),
    pricingVersion: config.pricingVersion,
    minimumUsdMicros: minimumUsd,
    requestedUsdMicros: requestedUsd,
    minimumNativeRaw,
    requestedNativeRaw,
    nativeUsdReferenceMicros: config.nativeUsdMicros,
    oracleTimestamp: config.oracleTimestamp,
    nonce,
    deadline,
  };
  const domain = {
    name: "WarzoneSponsorshipRouter",
    version: "1",
    chainId: config.chainId,
    verifyingContract: config.routerAddress,
  };
  const types = {
    SponsorshipQuote: [
      { name: "eventId", type: "bytes32" },
      { name: "sponsor", type: "address" },
      { name: "pricingTier", type: "bytes32" },
      { name: "pricingVersion", type: "uint256" },
      { name: "minimumUsdMicros", type: "uint256" },
      { name: "requestedUsdMicros", type: "uint256" },
      { name: "minimumNativeRaw", type: "uint256" },
      { name: "requestedNativeRaw", type: "uint256" },
      { name: "nativeUsdReferenceMicros", type: "uint256" },
      { name: "oracleTimestamp", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };
  const signature = await config.signer.signTypedData(domain, types, value);
  return { domain, types, value, signature, signer: config.signer.address };
}

export function serializeSponsorshipQuote(signed) {
  return {
    domain: signed.domain,
    value: Object.fromEntries(Object.entries(signed.value).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value])),
    signature: signed.signature,
    signer: signed.signer,
  };
}

export function decodeSponsorshipPaidLog(log, routerAddress) {
  if (!log) throw new Error("Sponsorship payment log was not found");
  if (routerAddress && String(log.address || "").toLowerCase() !== String(routerAddress).toLowerCase()) {
    throw new Error("Sponsorship payment log came from an unexpected router");
  }
  let parsed;
  try {
    parsed = sponsorshipInterface.parseLog({ topics: log.topics, data: log.data });
  } catch {
    throw new Error("Transaction log is not SponsorshipPaid");
  }
  if (!parsed || parsed.name !== "SponsorshipPaid") throw new Error("Transaction log is not SponsorshipPaid");
  return {
    eventId: String(parsed.args.eventId),
    sponsor: String(parsed.args.sponsor),
    nonce: BigInt(parsed.args.nonce),
    pricingTier: String(parsed.args.pricingTier),
    pricingVersion: BigInt(parsed.args.pricingVersion),
    minimumUsdMicros: BigInt(parsed.args.minimumUsdMicros),
    requestedUsdMicros: BigInt(parsed.args.requestedUsdMicros),
    nativeUsdReferenceMicros: BigInt(parsed.args.nativeUsdReferenceMicros),
    oracleTimestamp: BigInt(parsed.args.oracleTimestamp),
    grossNativeRaw: BigInt(parsed.args.grossNativeRaw),
    eventNativeRaw: BigInt(parsed.args.eventNativeRaw),
    marketingNativeRaw: BigInt(parsed.args.marketingNativeRaw),
    protocolNativeRaw: BigInt(parsed.args.protocolNativeRaw),
  };
}

export function assertSponsorshipPaidMatches(event, expected) {
  if (event.eventId.toLowerCase() !== sponsorshipEventId(expected.eventUuid).toLowerCase()) throw new Error("Sponsorship event id mismatch");
  if (getAddress(event.sponsor) !== getAddress(String(expected.sponsor))) throw new Error("Sponsorship wallet mismatch");
  if (event.nonce !== BigInt(String(expected.nonce))) throw new Error("Sponsorship nonce mismatch");
  if (event.pricingTier.toLowerCase() !== sponsorshipPricingTierId(expected.pricingTierCode).toLowerCase()) throw new Error("Sponsorship tier mismatch");
  if (event.pricingVersion !== BigInt(String(expected.pricingVersion))) throw new Error("Sponsorship pricing version mismatch");
  if (event.minimumUsdMicros !== BigInt(String(expected.minimumUsdMicros))) throw new Error("Sponsorship minimum USD mismatch");
  if (event.requestedUsdMicros !== BigInt(String(expected.requestedUsdMicros))) throw new Error("Sponsorship requested USD mismatch");
  if (event.nativeUsdReferenceMicros !== BigInt(String(expected.nativeUsdReferenceMicros))) throw new Error("Sponsorship native/USD reference mismatch");
  if (event.oracleTimestamp !== BigInt(String(expected.oracleTimestamp))) throw new Error("Sponsorship oracle timestamp mismatch");
  if (event.grossNativeRaw !== BigInt(String(expected.requestedNativeRaw))) throw new Error("Sponsorship gross native mismatch");
  const split = sponsorshipSplit(event.grossNativeRaw);
  if (event.eventNativeRaw !== split.prize || event.marketingNativeRaw !== split.marketing || event.protocolNativeRaw !== split.protocol) {
    throw new Error("Sponsorship 70/20/10 split mismatch");
  }
  return event;
}

export async function verifySponsorshipPayment({ provider, chainId, txHash, logIndex, expected, env = process.env }) {
  if (!provider || typeof provider.getTransactionReceipt !== "function") throw new Error("Sponsorship RPC provider is unavailable");
  const index = Number(logIndex);
  if (!Number.isInteger(index) || index < 0) throw new Error("Sponsorship log index is invalid");
  const routerAddress = sponsorshipRouterAddress(chainId, env);
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error("Sponsorship transaction receipt is not available yet");
  if (Number(receipt.status) !== 1) throw new Error("Sponsorship transaction failed");
  const log = (receipt.logs || []).find((item) => Number(item.index ?? item.logIndex) === index);
  const event = decodeSponsorshipPaidLog(log, routerAddress);
  assertSponsorshipPaidMatches(event, expected);
  let confirmedAt = null;
  if (receipt.blockNumber != null && typeof provider.getBlock === "function") {
    const block = await provider.getBlock(receipt.blockNumber);
    const timestamp = Number(block?.timestamp);
    if (Number.isFinite(timestamp) && timestamp > 0) confirmedAt = new Date(timestamp * 1000).toISOString();
  }
  return {
    ...event,
    routerAddress,
    txHash: String(receipt.hash || receipt.transactionHash || txHash).toLowerCase(),
    logIndex: index,
    blockNumber: receipt.blockNumber == null ? null : Number(receipt.blockNumber),
    confirmedAt,
  };
}
