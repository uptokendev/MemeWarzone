/**
 * DogeOS Chikyū TESTNET (6281971) fork config for the MuchFi fork tests (MuchFi publishes no source, so its
 * real bytecode can only be exercised on a fork). Read-only: it forks the public Chikyū RPC into the in-process
 * hardhat network and signs with hardhat's own funded local accounts. No key from config/dogeos.local is used
 * on the fork, and nothing is ever broadcast to Chikyū.
 *
 *   npx hardhat --config hardhat.dogeos-testnet-fork.config.ts test test/MuchfiFork.facts.spec.ts
 *
 * DOGEOS_TESTNET_FORK_RPC overrides the RPC; DOGEOS_FORK_BLOCK pins the block (default: latest - 16).
 */
import { execFileSync } from "node:child_process";
import base from "./hardhat.config";
import { HardhatUserConfig } from "hardhat/config";
import { DOGEOS_TESTNET_CHAIN_ID, DOGEOS_TESTNET_DEFAULT_RPC_URL } from "./scripts/lib/dogeosNetwork";

const url = process.env.DOGEOS_TESTNET_FORK_RPC || DOGEOS_TESTNET_DEFAULT_RPC_URL;
function forkBlock(): number | undefined {
  const pinned = Number(process.env.DOGEOS_FORK_BLOCK || "");
  if (Number.isInteger(pinned) && pinned > 0) return pinned;
  try {
    // execFileSync (no shell) so the JSON body is quoted the same way on Windows and POSIX.
    const raw = execFileSync(
      "curl",
      [
        "-sS",
        "-m",
        "12",
        "-A",
        "Mozilla",
        "-X",
        "POST",
        url,
        "-H",
        "content-type: application/json",
        "--data",
        '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}',
      ],
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
      chainId: DOGEOS_TESTNET_CHAIN_ID,
      accounts: { count: 4, accountsBalance: "10000000000000000000000" },
      chains: { [DOGEOS_TESTNET_CHAIN_ID]: { hardforkHistory: { london: 0, shanghai: 1, cancun: 2 } } },
      forking: { url, blockNumber: forkBlock(), httpHeaders: { "User-Agent": "Mozilla/5.0 hardhat-fork" } },
      allowUnlimitedContractSize: false,
      // Chikyū's real block gas limit (eth_getBlockByNumber gasLimit 0x989680), so a fork tx that fits here fits there.
      blockGasLimit: 10_000_000,
      hardfork: "cancun",
    },
  },
  mocha: { timeout: 1_800_000 },
};

export default config;
