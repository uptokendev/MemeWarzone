import { execSync } from "node:child_process";
import path from "node:path";
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "hardhat-gas-reporter";
import "solidity-coverage";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, ".env") });
dotenv.config({ path: path.resolve(__dirname, "config/robinhood.local") });
dotenv.config({ path: path.resolve(__dirname, "config/bnb.local") });

function argvSelectsNetwork(name: string): boolean {
  return process.argv.some((arg, index, args) => arg === name || (arg === "--network" && args[index + 1] === name));
}

function requiredNetworkUrl(url: string, networkName: string, envNames: string[]): string {
  const trimmed = String(url || "").trim();
  if (trimmed) return trimmed;
  if (!argvSelectsNetwork(networkName)) return "http://127.0.0.1:8545";
  throw new Error(
    `${networkName} RPC URL is empty. Set ${envNames.join(" or ")} in config/robinhood.local or the shell before --network ${networkName}.`,
  );
}

function normalizePrivateKey(value: string): string {
  const key = String(value || "").trim();
  if (!key) return "";
  return key.startsWith("0x") ? key : `0x${key}`;
}

const bscTestnetRpcUrl = process.env.BSC_TESTNET_RPC || process.env.BSC_TESTNET_RPC_URL || "";
const bscMainnetRpcUrl =
  process.env.BNB_FORK_RPC || process.env.BSC_MAINNET_RPC || process.env.BSC_MAINNET_RPC_URL || "https://bsc-mainnet.public.blastapi.io";
const robinhoodTestnetRpcUrl = requiredNetworkUrl(
  process.env.ROBINHOOD_TESTNET_RPC_URL || process.env.ROBINHOOD_TESTNET_RPC || "",
  "robinhoodTestnet",
  ["ROBINHOOD_TESTNET_RPC_URL", "ROBINHOOD_TESTNET_RPC"],
);
const robinhoodMainnetRpcUrl = requiredNetworkUrl(
  process.env.ROBINHOOD_MAINNET_RPC_URL || process.env.ROBINHOOD_MAINNET_RPC || "",
  "robinhoodMainnet",
  ["ROBINHOOD_MAINNET_RPC_URL", "ROBINHOOD_MAINNET_RPC"],
);
const deployerPrivateKey = process.env.DEPLOYER_PK || process.env.PRIVATE_KEY_DEPLOY || "";
const robinhoodTestnetPrivateKey = normalizePrivateKey(
  process.env.ROBINHOOD_TESTNET_DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY_DEPLOY || process.env.DEPLOYER_PK || "",
);
const robinhoodMainnetPrivateKey = normalizePrivateKey(
  process.env.ROBINHOOD_MAINNET_DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY_DEPLOY || process.env.DEPLOYER_PK || "",
);
const explorerApiKey = process.env.ETHERSCAN_API_KEY || "";
const forkMainnet = ["1", "true", "yes", "on"].includes(String(process.env.BNB_FORK || "").trim().toLowerCase());

function recentForkBlock(url: string): number | undefined {
  const pinned = Number(process.env.BNB_FORK_BLOCK || "");
  if (Number.isInteger(pinned) && pinned > 0) return pinned;
  try {
    const raw = execSync(
      `curl -sS -m 12 -A Mozilla -X POST ${JSON.stringify(url)} -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'`,
      { encoding: "utf8" },
    );
    const hex = JSON.parse(raw).result;
    const latest = parseInt(String(hex), 16);
    if (!Number.isFinite(latest) || latest <= 32) return undefined;
    return latest - 16;
  } catch {
    return undefined;
  }
}

const forkBlockNumber = forkMainnet ? recentForkBlock(bscMainnetRpcUrl) : undefined;

const config: HardhatUserConfig = {
  networks: {
    hardhat: {
      chainId: forkMainnet ? 56 : 31337,
      accounts: forkMainnet ? { count: 2, accountsBalance: "10000000000000000000000" } : undefined,
      chains: forkMainnet
        ? {
            56: {
              hardforkHistory: {
                london: 0,
                shanghai: 1,
                cancun: 2,
                prague: 3,
              },
            },
          }
        : undefined,
      forking: forkMainnet
        ? {
            url: bscMainnetRpcUrl,
            blockNumber: forkBlockNumber,
            httpHeaders: { "User-Agent": "Mozilla/5.0 hardhat-fork" },
          }
        : undefined,
    },
    bscMainnetFork: {
      url: process.env.BNB_FORK_ANVIL_URL || "http://127.0.0.1:8545",
      chainId: 56,
      timeout: 600_000,
      accounts: {
        mnemonic: "test test test test test test test test test test test junk",
        count: 3,
      },
    },

    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
    bscTestnet: {
      url: bscTestnetRpcUrl,
      accounts: deployerPrivateKey ? [deployerPrivateKey.startsWith("0x") ? deployerPrivateKey : `0x${deployerPrivateKey}`] : [],
      chainId: 97,
    },
    bscMainnet: {
      url: bscMainnetRpcUrl,
      accounts: deployerPrivateKey ? [deployerPrivateKey.startsWith("0x") ? deployerPrivateKey : `0x${deployerPrivateKey}`] : [],
      chainId: 56,
    },
    robinhoodTestnet: {
      url: robinhoodTestnetRpcUrl,
      accounts: robinhoodTestnetPrivateKey ? [robinhoodTestnetPrivateKey] : [],
      chainId: 46630,
    },
    robinhoodMainnet: {
      url: robinhoodMainnetRpcUrl,
      accounts: robinhoodMainnetPrivateKey ? [robinhoodMainnetPrivateKey] : [],
      chainId: 4663,
    },
  },

  etherscan: {
    apiKey: explorerApiKey,
  },

  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 1 },
      viaIR: true,
      metadata: { bytecodeHash: "none" },
    },
  },

  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },

  mocha: {
    timeout: forkMainnet ? 600_000 : 120_000,
  },

  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
  },
};

export default config;
