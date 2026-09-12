import { JsonRpcProvider, Wallet, getAddress } from "ethers";

const EXPECTED_CHAIN_ID = 97;
const EXPECTED_OPERATOR = getAddress("0xEE2c6A7605ED378CF1D26D1d828446d63A3fdeDa");
const EXPECTED_ROUTE = getAddress("0x2b72A9E6C4Ea3525d83B8C5E8F2044BDbC1f1Dec");
const HISTORICAL_OPERATOR = "0x6404b7ea3156f621ad9616c32214caf1d0780c3";
const HISTORICAL_ROUTE = "0xb989a99823ea96552c3e3198a40cdbf682edf1aa";

function fail(code) {
  throw new Error(`STAGE_DEPLOY_GATE:${code}`);
}

function normalizedPrivateKey() {
  const raw = String(process.env.BSC_TESTNET_PRIVATE_KEY || process.env.DEPLOYER_PK || process.env.PRIVATE_KEY_DEPLOY || "").trim();
  if (!raw) fail("DEPLOYER_KEY_MISSING");
  return raw.startsWith("0x") ? raw : `0x${raw}`;
}

function configuredAddress(name) {
  const raw = String(process.env[name] || "").trim();
  if (!raw) fail(`${name}_MISSING`);
  try {
    return getAddress(raw);
  } catch {
    fail(`${name}_INVALID`);
  }
}

function lower(address) {
  return String(address).toLowerCase();
}

async function main() {
  const rpc = String(process.env.BSC_TESTNET_RPC || process.env.BSC_TESTNET_RPC_URL || "").trim();
  if (!rpc) fail("RPC_MISSING");

  const deployer = getAddress(new Wallet(normalizedPrivateKey()).address);
  const admin = configuredAddress("BNB_TESTNET_ADMIN");
  const route = configuredAddress("BNB_6C_ROUTE_AUTHORITY_ADDRESS");

  if (deployer !== EXPECTED_OPERATOR) fail("DEPLOYER_NOT_FROZEN_OPERATOR");
  if (admin !== EXPECTED_OPERATOR || admin !== deployer) fail("ADMIN_NOT_DEPLOYER");
  if (route !== EXPECTED_ROUTE) fail("ROUTE_NOT_FROZEN");
  if (route === deployer) fail("ROUTE_EQUALS_DEPLOYER");

  for (const [label, address] of [["DEPLOYER", deployer], ["ADMIN", admin], ["ROUTE", route]]) {
    const normalized = lower(address);
    if (normalized === HISTORICAL_OPERATOR) fail(`${label}_USES_HISTORICAL_OPERATOR`);
    if (normalized === HISTORICAL_ROUTE) fail(`${label}_USES_HISTORICAL_ROUTE`);
  }

  const provider = new JsonRpcProvider(rpc);
  const chainId = Number((await provider.getNetwork()).chainId);
  if (chainId !== EXPECTED_CHAIN_ID) fail("CHAIN_NOT_97");

  console.log(`stage_deployer=${deployer}`);
  console.log(`stage_admin=${admin}`);
  console.log(`stage_route_authority=${route}`);
  console.log(`stage_chain_id=${chainId}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
