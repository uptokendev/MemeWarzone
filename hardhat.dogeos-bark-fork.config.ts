// DogeOS Barkswap (Algebra Integral 1.2.1 custom pools) build and fork-test config.
//
// The Bark contracts (contracts/dogeos/barkswap) sit on top of gen-8 (contracts/gen8) and build with gen-8's exact
// compiler settings (solc 0.8.26, cancun, viaIR, 200 runs, bytecodeHash none, the v4-core PoolManager override and
// the solmate remapping), taken from hardhat.gen8.config.ts so the two builds cannot drift. It does NOT spread the root
// hardhat.config.ts: that one is solc 0.8.24 and skips both trees. Outputs go to artifacts-bark / cache-bark /
// typechain-types-bark.
//
// Barkswap publishes no npm package, so Bark tests run only against the deployed contracts on an in-process fork of
// the public Chikyu RPC (read-only). The fork signs with hardhat's local accounts and impersonation; no key is read,
// no config/*.local file is loaded and nothing is ever broadcast to Chikyu.
//
//   npx hardhat --config hardhat.dogeos-bark-fork.config.ts compile
//   npx hardhat --config hardhat.dogeos-bark-fork.config.ts test test/dogeos/barkswap/<spec>
//
// DOGEOS_FORK_BLOCK pins the fork block (default 8,578,734, the block of the research proof).
import path from "node:path";
import { HardhatUserConfig, subtask } from "hardhat/config";
import { TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS } from "hardhat/builtin-tasks/task-names";
import "@nomicfoundation/hardhat-toolbox";
// Importing the gen-8 config also registers its solmate remapping subtask.
import gen8 from "./hardhat.gen8.config";
import { DOGEOS_TESTNET_CHAIN_ID, DOGEOS_TESTNET_DEFAULT_RPC_URL } from "./scripts/lib/dogeosNetwork";

const DEFAULT_FORK_BLOCK = 8_578_734;

function forkBlock(): number {
  const raw = (process.env.DOGEOS_FORK_BLOCK ?? "").trim();
  if (raw === "") return DEFAULT_FORK_BLOCK;
  const block = Number(raw);
  if (!Number.isSafeInteger(block) || block <= 0) throw new Error(`DOGEOS_FORK_BLOCK must be a positive block number, got "${raw}"`);
  return block;
}

// Only contracts/gen8/** and contracts/dogeos/barkswap/** are build roots. Files they import from elsewhere (OZ,
// v4-core, the gen-7 vaults Gen8TestImports pulls in) are still compiled as dependencies, exactly as in the gen-8 build.
const SOURCES_DIR = path.resolve(__dirname, "contracts");
const BUILD_ROOTS = [path.join(SOURCES_DIR, "gen8"), path.join(SOURCES_DIR, "dogeos", "barkswap")];

// Windows paths compare case-insensitively.
function normalizedPath(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInsideAny(file: string, dirs: string[]): boolean {
  const target = normalizedPath(file);
  return dirs.some((dir) => target.startsWith(normalizedPath(dir) + path.sep));
}

subtask(TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS).setAction(async (args, _hre, runSuper) => {
  const sourcePaths: string[] = await runSuper(args);
  return sourcePaths.filter((file) => isInsideAny(file, BUILD_ROOTS));
});

const config: HardhatUserConfig = {
  solidity: gen8.solidity,
  networks: {
    hardhat: {
      chainId: DOGEOS_TESTNET_CHAIN_ID,
      // hardhat's default local accounts (they hold no code on Chikyu at the pinned fork block)
      accounts: { count: 10, accountsBalance: "10000000000000000000000000" },
      // Calls at the forked block itself fail ("No known hardfork for execution on historical block"; a
      // `chains.hardforkHistory` entry does not change that here), so readyFork() in
      // test/dogeos/barkswap/fixtures/barkswap.ts mines one local block first.
      forking: {
        url: DOGEOS_TESTNET_DEFAULT_RPC_URL,
        blockNumber: forkBlock(),
        httpHeaders: { "User-Agent": "Mozilla/5.0 hardhat-fork" },
      },
      hardfork: "cancun",
      // EIP-170 is real on Chikyu
      allowUnlimitedContractSize: false,
      // Chikyu's block gas limit (eth_getBlockByNumber gasLimit 0x989680), so a fork tx that fits here fits there
      blockGasLimit: 10_000_000,
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test/dogeos/barkswap",
    cache: "./cache-bark",
    artifacts: "./artifacts-bark",
  },
  typechain: {
    outDir: "typechain-types-bark",
  },
  mocha: {
    timeout: 1_800_000,
  },
};

export default config;
