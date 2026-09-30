/**
 * Robinhood mainnet (4663) fork config for the evmgen-rh fork specs. Read-only: it forks
 * https://rpc.mainnet.chain.robinhood.com into the in-process hardhat network and never
 * signs for a live network. Usage:
 *   npx hardhat --config hardhat.rh-fork.config.ts test test/evmgen-rh-*.fork.spec.ts
 * RH_FORK_BLOCK pins the block (default: latest - 16).
 */
import { execSync } from "node:child_process";
import base from "./hardhat.config";
import { HardhatUserConfig } from "hardhat/config";

const url = process.env.ROBINHOOD_FORK_RPC || "https://rpc.mainnet.chain.robinhood.com";
/**
 * The public RPC keeps state for only ~5,000 blocks (about half an hour), so the fork runs at
 * latest - 16 unless RH_FORK_BLOCK pins one (an archive RPC in ROBINHOOD_FORK_RPC is then needed).
 */
function forkBlock(): number | undefined {
  const pinned = Number(process.env.RH_FORK_BLOCK || "");
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
const blockNumber = forkBlock();

const config: HardhatUserConfig = {
  ...base,
  networks: {
    ...base.networks,
    hardhat: {
      chainId: 4663,
      accounts: { count: 8, accountsBalance: "10000000000000000000000" },
      chains: {
        4663: { hardforkHistory: { london: 0, shanghai: 1, cancun: 2 } },
      },
      forking: { url, blockNumber, httpHeaders: { "User-Agent": "Mozilla/5.0 hardhat-fork" } },
      allowUnlimitedContractSize: false,
      // Robinhood Chain is Arbitrum Nitro: one transaction is capped at 32M gas (C7 open question 2).
      blockGasLimit: 32_000_000,
      // Cancun rules: EDR's newer default applies Osaka's 2^24 per-transaction gas cap (EIP-7825),
      // which Nitro does not have; the 32M block limit above is the cap that matters on 4663.
      hardfork: "cancun",
    },
  },
  mocha: { timeout: 1_800_000 },
};

export default config;
