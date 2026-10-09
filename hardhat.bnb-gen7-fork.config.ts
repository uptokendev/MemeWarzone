/**
 * Gen-7 BNB fork rehearsals (no key, local anvil only). Same compiler and networks as hardhat.config.ts, plus
 * `bscTestnetForkRehearsal`: a local anvil fork of BSC testnet (97) on 127.0.0.1:8697, so the testnet deploy
 * (scripts/deploy-bnb-gen7-generation.ts) and the testnet acceptance (scripts/test-bnb-testnet-gen7-lifecycle.ts)
 * can be dry-run with the testnet deployer impersonated before the founder runs them on 97. The deploy script
 * accepts the network only after anvil_nodeInfo proves a local fork of chain 97.
 *
 *   anvil --fork-url https://bsc-testnet-rpc.publicnode.com --port 8697 --accounts 0
 *   npx hardhat --config hardhat.bnb-gen7-fork.config.ts run scripts/rehearse-evm-gen7-bnb-fork.ts --network bscTestnetForkRehearsal
 */
import base from "./hardhat.config";
import { HardhatUserConfig } from "hardhat/config";

const config: HardhatUserConfig = {
  ...base,
  networks: {
    ...base.networks,
    bscTestnetForkRehearsal: {
      url: process.env.BSC_TESTNET_FORK_REHEARSAL_URL || "http://127.0.0.1:8697",
      chainId: 97,
      accounts: "remote",
      gasPrice: 100_000_000, // 0.1 gwei, as hardhat.bsc-testnet.config.ts sends on the real 97
      timeout: 600_000,
    },
  },
};

export default config;
