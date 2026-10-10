// DogeOS Chikyu testnet (chain 6281971) Hardhat network resolvers.
//
// Pure functions over an env object, so tests can pass synthetic values. Unlike the
// Robinhood networks, the deployer key has NO fallback to DEPLOYER_PK / PRIVATE_KEY_DEPLOY:
// a missing DOGEOS_TESTNET_DEPLOYER_PRIVATE_KEY is a missing key, never another chain's key.
// Never log or print the value these return.

export const DOGEOS_TESTNET_NETWORK_NAME = "dogeosTestnet";
export const DOGEOS_TESTNET_CHAIN_ID = 6281971;
export const DOGEOS_TESTNET_DEFAULT_RPC_URL = "https://rpc.testnet.dogeos.com";
export const DOGEOS_TESTNET_EXPLORER_URL = "https://dogeos-testnet.l2scan.co";
export const DOGEOS_TESTNET_EXPLORER_API_URL = "https://dogeos-testnet.l2scan.co/api";

type Env = Record<string, string | undefined>;

export function resolveDogeosTestnetRpcUrl(env: Env): string {
  const url = String(env.DOGEOS_TESTNET_RPC_URL || "").trim();
  return url || DOGEOS_TESTNET_DEFAULT_RPC_URL;
}

export function resolveDogeosTestnetDeployerKey(env: Env): string {
  const key = String(env.DOGEOS_TESTNET_DEPLOYER_PRIVATE_KEY || "").trim();
  if (!key) return "";
  return key.startsWith("0x") ? key : `0x${key}`;
}

function argvSelectsDogeosTestnet(argv: readonly string[]): boolean {
  return argv.some(
    (arg, index) =>
      arg === `--network=${DOGEOS_TESTNET_NETWORK_NAME}` ||
      (arg === "--network" && argv[index + 1] === DOGEOS_TESTNET_NETWORK_NAME),
  );
}

export function assertDogeosKeyPresentWhenSelected(argv: readonly string[], key: string): void {
  if (!argvSelectsDogeosTestnet(argv)) return;
  if (String(key || "").trim()) return;
  throw new Error(
    "DOGEOS_TESTNET_DEPLOYER_PRIVATE_KEY missing. Set it in config/dogeos.local before --network dogeosTestnet " +
      "(there is no fallback to DEPLOYER_PK / PRIVATE_KEY_DEPLOY).",
  );
}
