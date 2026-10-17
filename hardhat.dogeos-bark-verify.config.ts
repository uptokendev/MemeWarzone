// L2Scan source verification of the DogeOS Bark contracts on Chikyu testnet (chain 6281971): the seven Bark
// contracts and the launcher's two libraries (barkswap plan t15).
//
//   npm run verify:dogeos-bark-testnet
//   (= npx hardhat --config hardhat.dogeos-bark-verify.config.ts run scripts/verify-dogeos-testnet.ts --network dogeosTestnet)
//
// The Bark build exactly as hardhat.dogeos-bark-fork.config.ts defines it (gen-8's solc 0.8.26 settings, the source
// roots contracts/gen8 and contracts/dogeos/barkswap, artifacts-bark / cache-bark), plus the dogeosTestnet network and
// L2Scan's Etherscan-style API. The reused oracle and vaults stay on the root 0.8.24 build and are verified with
// hardhat.dogeos-verify.config.ts. It does not import hardhat.config.ts: the root config filters the Bark sources out
// of every build that uses ./contracts.
//
// Verification sends no transaction, so the network has no account and no private key is loaded; the only secret
// read is the L2Scan API key, through scripts/lib/dogeosL2scanKey.ts (that one value only).
// DOGEOS_TESTNET_RPC_URL overrides the public RPC.
import { HardhatUserConfig } from "hardhat/config";
import bark from "./hardhat.dogeos-bark-fork.config";
import {
  DOGEOS_TESTNET_CHAIN_ID,
  DOGEOS_TESTNET_EXPLORER_API_URL,
  DOGEOS_TESTNET_EXPLORER_URL,
  DOGEOS_TESTNET_NETWORK_NAME,
  resolveDogeosTestnetRpcUrl,
} from "./scripts/lib/dogeosNetwork";
import { dogeosL2scanApiKey } from "./scripts/lib/dogeosL2scanKey";

// L2Scan's Etherscan-style API needs a real key (since 2026-10: 401 "Invalid API Key" without one). The helper reads
// only that one value (env first, else the gitignored local file) and loads no private key into this process.
const l2scanApiKey = dogeosL2scanApiKey();

const config: HardhatUserConfig = {
  solidity: bark.solidity,
  paths: bark.paths,
  typechain: bark.typechain,
  networks: {
    [DOGEOS_TESTNET_NETWORK_NAME]: {
      url: resolveDogeosTestnetRpcUrl(process.env),
      accounts: [],
      chainId: DOGEOS_TESTNET_CHAIN_ID,
    },
  },
  etherscan: {
    apiKey: {
      [DOGEOS_TESTNET_NETWORK_NAME]: l2scanApiKey,
    },
    customChains: [
      {
        network: DOGEOS_TESTNET_NETWORK_NAME,
        chainId: DOGEOS_TESTNET_CHAIN_ID,
        urls: {
          apiURL: DOGEOS_TESTNET_EXPLORER_API_URL,
          browserURL: DOGEOS_TESTNET_EXPLORER_URL,
        },
      },
    ],
  },
  sourcify: { enabled: false },
};

export default config;
