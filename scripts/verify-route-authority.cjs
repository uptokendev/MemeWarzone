const { ethers } = require("ethers");

const CREATE_AUTH_TYPES = ["string", "uint256", "address", "address", "bytes32", "uint8", "uint8", "uint64"];
const TRADE_AUTH_TYPES = ["string", "uint256", "address", "address", "uint8", "uint8", "uint256", "uint256", "uint64"];
// LaunchFactory._hashCampaignRequest from factory generation 6 (C3 first buy, C6 fee choice).
const REQUEST_HASH_TYPES = [
  "bytes32",
  "bytes32",
  "bytes32",
  "bytes32",
  "bytes32",
  "bytes32",
  "uint256",
  "uint256",
  "uint256",
  "uint8",
  "uint8",
];
// Factories before generation 6 (the live 4/3 and older, E14) hash only the first seven fields.
const LEGACY_REQUEST_HASH_TYPES = ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "uint256"];
const GEN6_FACTORY_GENERATION = 6;

function normalizeAddress(value, label) {
  if (!value) throw new Error(`${label} is required`);
  return ethers.getAddress(String(value).trim());
}

function hardhatEphemeralHint(address, networkName = process.env.HARDHAT_NETWORK || "") {
  if (networkName !== "hardhat") return "";
  return ` The hardhat network is ephemeral per command, so a factory deployed by a previous command no longer has code at ${address}. Use npm run deploy:verify for same-run checks, run against localhost with a persistent node, or use a real network such as bscTestnet.`;
}

function providerFromEnv() {
  const rpcUrl = process.env.ROUTE_AUTHORITY_RPC_URL || process.env.RPC_URL || process.env.BSC_RPC_HTTP || process.env.BSC_TESTNET_RPC_URL;
  if (!rpcUrl) throw new Error("Set ROUTE_AUTHORITY_RPC_URL or RPC_URL before running this check");
  return new ethers.JsonRpcProvider(rpcUrl);
}

async function requireContractCode(address, label, provider = providerFromEnv(), networkName = process.env.HARDHAT_NETWORK || "") {
  const code = await provider.getCode(address);
  if (code === "0x") {
    throw new Error(`${label} ${address} has no code on ${networkName || "the configured network"}.${hardhatEphemeralHint(address, networkName)}`);
  }
}

function configuredRouteAuthority() {
  if (process.env.ROUTE_AUTHORITY_PRIVATE_KEY) {
    const raw = process.env.ROUTE_AUTHORITY_PRIVATE_KEY.trim();
    const privateKey = raw.startsWith("0x") ? raw : `0x${raw}`;
    const wallet = new ethers.Wallet(privateKey);
    return { address: wallet.address, wallet };
  }

  if (process.env.ROUTE_AUTHORITY_ADDRESS) {
    return { address: normalizeAddress(process.env.ROUTE_AUTHORITY_ADDRESS, "ROUTE_AUTHORITY_ADDRESS"), wallet: null };
  }

  throw new Error("Set ROUTE_AUTHORITY_ADDRESS or ROUTE_AUTHORITY_PRIVATE_KEY before running this check");
}

function hashString(value) {
  return ethers.keccak256(ethers.toUtf8Bytes(String(value ?? "")));
}

/**
 * The request hash the factory checks. `factoryGeneration` >= 6 (or omitted) hashes the 11-field
 * generation-6 request; an older generation hashes the 7-field one.
 */
function hashCampaignRequest(req, { factoryGeneration = GEN6_FACTORY_GENERATION } = {}) {
  const base = [
    hashString(req.name),
    hashString(req.symbol),
    hashString(req.logoURI),
    hashString(req.xAccount),
    hashString(req.website),
    hashString(req.extraLink),
    BigInt(req.graduationTarget ?? 0),
  ];
  const coder = ethers.AbiCoder.defaultAbiCoder();
  if (Number(factoryGeneration) < GEN6_FACTORY_GENERATION) {
    return ethers.keccak256(coder.encode(LEGACY_REQUEST_HASH_TYPES, base));
  }
  return ethers.keccak256(
    coder.encode(REQUEST_HASH_TYPES, [
      ...base,
      BigInt(req.firstBuyTokens ?? 0),
      BigInt(req.firstBuyMaxCost ?? 0),
      Number(req.feeChoice ?? 1),
      Number(req.feeCreatorPct ?? 0),
    ])
  );
}

/** FACTORY_GENERATION() from chain; factories that predate the constant read as generation 0 (legacy layout). */
async function readFactoryGeneration(factoryAddress, provider) {
  try {
    const factory = new ethers.Contract(factoryAddress, ["function FACTORY_GENERATION() view returns (uint32)"], provider);
    return Number(await factory.FACTORY_GENERATION());
  } catch {
    return 0;
  }
}

function createRouteAuthDigest({ chainId, factory, creator, requestHash, tradeRouteProfile, finalizeRouteProfile, deadline }) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(CREATE_AUTH_TYPES, [
      "MWZ_CREATE_ROUTE_AUTH",
      BigInt(chainId),
      factory,
      creator,
      requestHash,
      Number(tradeRouteProfile),
      Number(finalizeRouteProfile),
      BigInt(deadline),
    ])
  );
}

function tradeRouteAuthDigest({ chainId, campaign, actor, routeProfile, action, amount, limit, deadline }) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(TRADE_AUTH_TYPES, [
      "MWZ_ROUTE_TRADE_AUTH",
      BigInt(chainId),
      campaign,
      actor,
      Number(routeProfile),
      Number(action),
      BigInt(amount),
      BigInt(limit),
      BigInt(deadline),
    ])
  );
}

async function assertSignerRoundTrip(wallet, expectedAuthority, digest, label) {
  const signature = await wallet.signMessage(ethers.getBytes(digest));
  const recovered = ethers.verifyMessage(ethers.getBytes(digest), signature);
  if (ethers.getAddress(recovered) !== ethers.getAddress(expectedAuthority)) {
    throw new Error(`${label} signer self-test failed: recovered ${recovered}`);
  }
  console.log(`[route-authority] ${label} signer self-test: ok`);
}

async function main() {
  const provider = providerFromEnv();
  const network = await provider.getNetwork();
  const networkName = process.env.NETWORK_NAME || `chain-${network.chainId}`;
  const factoryAddress = normalizeAddress(
    process.env.LAUNCH_FACTORY_ADDRESS || process.env.FACTORY_ADDRESS,
    "LAUNCH_FACTORY_ADDRESS or FACTORY_ADDRESS"
  );
  const configured = configuredRouteAuthority();
  const expectedAuthority = ethers.getAddress(configured.address);
  const chainId = network.chainId;

  console.log(`[route-authority] network=${networkName}`);
  console.log(`[route-authority] chainId=${chainId}`);
  console.log(`[route-authority] factory=${factoryAddress}`);
  console.log(`[route-authority] expected=${expectedAuthority}`);

  await requireContractCode(factoryAddress, "LaunchFactory", provider, networkName);

  const factory = new ethers.Contract(factoryAddress, ["function routeAuthority() view returns (address)"], provider);
  const onChainAuthority = ethers.getAddress(await factory.routeAuthority());
  console.log(`[route-authority] on-chain=${onChainAuthority}`);

  if (onChainAuthority !== expectedAuthority) {
    throw new Error("Route authority mismatch: backend signer does not match LaunchFactory.routeAuthority");
  }

  const factoryGeneration = await readFactoryGeneration(factoryAddress, provider);
  console.log(
    `[route-authority] factory generation=${factoryGeneration} request layout=${
      factoryGeneration >= GEN6_FACTORY_GENERATION ? "11-field (generation 6)" : "7-field (legacy)"
    }`
  );
  const sampleRequest = {
    name: "RouteAuthProbe",
    symbol: "RAP",
    logoURI: "ipfs://route-auth-probe",
    xAccount: "",
    website: "",
    extraLink: "",
    firstBuyTokens: 0n,
    firstBuyMaxCost: 0n,
    feeChoice: 1,
    feeCreatorPct: 0,
  };
  const requestHash = hashCampaignRequest(sampleRequest, { factoryGeneration });
  const sampleDeadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const sampleCreator = expectedAuthority;
  const sampleCampaign = process.env.CAMPAIGN_ADDRESS
    ? normalizeAddress(process.env.CAMPAIGN_ADDRESS, "CAMPAIGN_ADDRESS")
    : factoryAddress;

  const createDigest = createRouteAuthDigest({
    chainId,
    factory: factoryAddress,
    creator: sampleCreator,
    requestHash,
    tradeRouteProfile: 1,
    finalizeRouteProfile: 1,
    deadline: sampleDeadline,
  });
  const tradeDigest = tradeRouteAuthDigest({
    chainId,
    campaign: sampleCampaign,
    actor: sampleCreator,
    routeProfile: 1,
    action: 0,
    amount: ethers.parseEther("1"),
    limit: ethers.parseEther("0.01"),
    deadline: sampleDeadline,
  });

  console.log(`[route-authority] create request hash sample=${requestHash}`);
  console.log(`[route-authority] create digest sample=${createDigest}`);
  console.log(`[route-authority] trade digest sample=${tradeDigest}`);

  if (configured.wallet) {
    await assertSignerRoundTrip(configured.wallet, expectedAuthority, createDigest, "create route auth");
    await assertSignerRoundTrip(configured.wallet, expectedAuthority, tradeDigest, "trade route auth");
  } else {
    console.log("[route-authority] signer self-test skipped: set ROUTE_AUTHORITY_PRIVATE_KEY to verify signatures locally");
  }

  console.log("[route-authority] EIP-191 digest compatibility self-test: OK");
}

module.exports = {
  CREATE_AUTH_TYPES,
  TRADE_AUTH_TYPES,
  REQUEST_HASH_TYPES,
  LEGACY_REQUEST_HASH_TYPES,
  GEN6_FACTORY_GENERATION,
  readFactoryGeneration,
  normalizeAddress,
  hardhatEphemeralHint,
  requireContractCode,
  configuredRouteAuthority,
  hashString,
  hashCampaignRequest,
  createRouteAuthDigest,
  tradeRouteAuthDigest,
  assertSignerRoundTrip,
  main,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`[route-authority] ${error.message}`);
    process.exitCode = 1;
  });
}
