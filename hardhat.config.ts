import { execSync } from "node:child_process";
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "hardhat-gas-reporter";
import "solidity-coverage";
import * as dotenv from "dotenv";

dotenv.config();

const bscTestnetRpcUrl = process.env.BSC_TESTNET_RPC || process.env.BSC_TESTNET_RPC_URL || "";
const bscMainnetRpcUrl =
  process.env.BNB_FORK_RPC || process.env.BSC_MAINNET_RPC || process.env.BSC_MAINNET_RPC_URL || "https://bsc-mainnet.public.blastapi.io";
const robinhoodTestnetRpcUrl = process.env.ROBINHOOD_TESTNET_RPC_URL || process.env.ROBINHOOD_TESTNET_RPC || "";
const deployerPrivateKey = process.env.DEPLOYER_PK || process.env.PRIVATE_KEY_DEPLOY || "";
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
        count: 2,
      },
    },

    // --- Added for deployments ---
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
      accounts: deployerPrivateKey ? [deployerPrivateKey.startsWith("0x") ? deployerPrivateKey : `0x${deployerPrivateKey}`] : [],
      chainId: 46630,
    },
  },

  // --- Added for contract verification ---
  etherscan: {
    // A single string opts @nomicfoundation/hardhat-verify into Etherscan API V2.
    // The old per-network object selects the retired BscScan V1 endpoint.
    apiKey: explorerApiKey,
  },

  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 1 }, // low runs shrinks code size
      viaIR: true,
      metadata: { bytecodeHash: "none" }, // removes metadata hash bytes
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
