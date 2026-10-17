// L2Scan source verification for DogeOS Chikyu testnet (chain 6281971).
//
// Use only for DogeOS verification:
//   npx hardhat --config hardhat.dogeos-verify.config.ts verify --network dogeosTestnet <address> [...args]
//
// It extends the shared hardhat.config.ts without mutating it. The shared config's `etherscan`
// (single-string apiKey, Etherscan v2 for BSC) stays as it is, so BSC verification is untouched.
// The object-form apiKey makes hardhat-verify call L2Scan's Etherscan-style /api directly.
import { HardhatUserConfig } from "hardhat/config";
import baseConfig from "./hardhat.config";
import {
  DOGEOS_TESTNET_CHAIN_ID,
  DOGEOS_TESTNET_EXPLORER_API_URL,
  DOGEOS_TESTNET_EXPLORER_URL,
  DOGEOS_TESTNET_NETWORK_NAME,
} from "./scripts/lib/dogeosNetwork";

// L2Scan's Etherscan-style API needs a real key (since 2026-10: 401 "Invalid API Key" without one):
// DOGEOS_TESTNET_L2SCAN_API_KEY in config/dogeos.local (loaded by hardhat.config.ts). The placeholder only keeps
// hardhat-verify from refusing before the request.
const l2scanApiKey = String(process.env.DOGEOS_TESTNET_L2SCAN_API_KEY || "").trim() || "l2scan";

const config: HardhatUserConfig = {
  ...baseConfig,
  etherscan: {
    ...baseConfig.etherscan,
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
  // L2Scan only. Sourcify removed its v1 API (404 "API v1 is removed"), which hardhat-verify still calls.
  sourcify: { enabled: false },
};

export default config;
