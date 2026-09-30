/**
 * BSC testnet (97) config for the EVM launch generation run (gen 6 / campaign 5). Same compiler, paths
 * and keys as hardhat.config.ts; only the bscTestnet gas price differs: the base config pins 1 gwei,
 * BSC testnet reports 0.1 gwei (eth_gasPrice, 2026-09-30), so this one pays what the node reports.
 * Only the bscTestnet network is exposed, so a script run with this config cannot reach chain 56.
 *   npx hardhat --config hardhat.bsc-testnet.config.ts run <script> --network bscTestnet
 */
import base from "./hardhat.config";
import { HardhatUserConfig } from "hardhat/config";

const testnet = (base.networks as any).bscTestnet;
const gwei = process.env.BSC_TESTNET_GAS_PRICE_WEI ? Number(process.env.BSC_TESTNET_GAS_PRICE_WEI) : 100_000_000;

const config: HardhatUserConfig = {
  ...base,
  networks: {
    hardhat: (base.networks as any).hardhat,
    bscTestnet: { ...testnet, chainId: 97, gasPrice: gwei },
  },
};

export default config;
