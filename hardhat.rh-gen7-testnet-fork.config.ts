/**
 * Robinhood TESTNET (46630) fork config for the local dry run of the gen-7 testnet path
 * (scripts/test-robinhood-testnet-gen7-lifecycle.ts with GEN7_DRY_RUN=1). Read-only: it forks the public 46630 RPC
 * into the in-process hardhat network; the deployer is impersonated, nothing is signed for 46630.
 *
 *   GEN7_DRY_RUN=1 npx hardhat --config hardhat.rh-gen7-testnet-fork.config.ts run scripts/test-robinhood-testnet-gen7-lifecycle.ts
 *
 * RH_TESTNET_FORK_BLOCK pins the block (default: latest - 16).
 */
import { execSync } from "node:child_process";
import base from "./hardhat.config";
import { HardhatUserConfig } from "hardhat/config";

const url = process.env.ROBINHOOD_TESTNET_FORK_RPC || "https://rpc.testnet.chain.robinhood.com";
function forkBlock(): number | undefined {
  const pinned = Number(process.env.RH_TESTNET_FORK_BLOCK || "");
  if (Number.isInteger(pinned) && pinned > 0) return pinned;
  try {
    const raw = execSync(
      `curl -sS -m 12 -A Mozilla -X POST ${JSON.stringify(url)} -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'`,
      { encoding: "utf8" },
    );
    const latest = parseInt(String(JSON.parse(raw).result), 16);
    return Number.isFinite(latest) && latest > 32 ? latest - 16 : undefined;
  } catch {
    return undefined;
  }
}

const config: HardhatUserConfig = {
  ...base,
  networks: {
    ...base.networks,
    hardhat: {
      chainId: 46630,
      accounts: { count: 4, accountsBalance: "10000000000000000000000" },
      chains: { 46630: { hardforkHistory: { london: 0, shanghai: 1, cancun: 2 } } },
      forking: { url, blockNumber: forkBlock(), httpHeaders: { "User-Agent": "Mozilla/5.0 hardhat-fork" } },
      allowUnlimitedContractSize: false,
      blockGasLimit: 32_000_000,
      hardfork: "cancun",
    },
  },
  mocha: { timeout: 1_800_000 },
};

export default config;
