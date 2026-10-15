// EVM generation 8 (Uniswap V4 hook launch) build and test config.
//
// Separate from hardhat.config.ts on purpose: gen-8 needs solc 0.8.26 + cancun (transient storage, v4-core), while
// every earlier generation stays byte-for-byte on its own 0.8.24 settings. Sources: contracts/gen8 only (plus the
// gen-7 contracts the gen-8 test helpers import unchanged). Outputs go to artifacts-gen8 / cache-gen8.
//
//   npx hardhat --config hardhat.gen8.config.ts compile
//   npx hardhat --config hardhat.gen8.config.ts test
import { HardhatUserConfig, subtask } from "hardhat/config";
import { TASK_COMPILE_GET_REMAPPINGS } from "hardhat/builtin-tasks/task-names";
import "@nomicfoundation/hardhat-toolbox";
import { id } from "ethers";

// v4-core's PoolManager (built only for local tests) imports solmate through a foundry remapping; the pinned
// @uniswap/v4-core 1.0.2 npm package ships that exact solmate copy under lib/.
subtask(TASK_COMPILE_GET_REMAPPINGS).setAction(async (_args, _hre, runSuper) => ({
  ...(await runSuper()),
  "solmate/": "node_modules/@uniswap/v4-core/lib/solmate/",
}));

// Pinned production compiler settings (recorded in docs/evm-launch/GEN8_INTERNAL_AUDIT.md, verification manifest).
const GEN8_SOLC = {
  version: "0.8.26",
  settings: {
    evmVersion: "cancun",
    viaIR: true,
    optimizer: { enabled: true, runs: 200 },
    metadata: { bytecodeHash: "none" },
  },
};

// v4-core's own settings (foundry.toml of @uniswap/v4-core 1.0.2), used only to build the PoolManager the local unit
// tests run against. Forks use the canonical deployed PoolManager.
const V4_CORE_SOLC = {
  version: "0.8.26",
  settings: {
    evmVersion: "cancun",
    viaIR: true,
    optimizer: { enabled: true, runs: 44444444 },
    metadata: { bytecodeHash: "none" },
  },
};

const config: HardhatUserConfig = {
  solidity: {
    compilers: [GEN8_SOLC],
    overrides: {
      "@uniswap/v4-core/src/PoolManager.sol": V4_CORE_SOLC,
    },
  },
  networks: {
    hardhat: {
      // the local PoolManager is compiled here, not size-optimized like the deployed one; our own contract sizes are
      // checked against EIP-170 explicitly in test/gen8/sizes.spec.ts
      allowUnlimitedContractSize: true,
      hardfork: "cancun",
      // fresh deterministic test keys (never the standard hardhat / anvil mnemonic keys: an EIP-7702 sweeper sits on
      // them on live chains). Local in-process network only.
      accounts: Array.from({ length: 12 }, (_, i) => ({ privateKey: id(`mwz-gen8-local/${i}`), balance: "100000000000000000000000000" })),
    },
  },
  paths: {
    sources: "./contracts/gen8",
    tests: "./test/gen8",
    cache: "./cache-gen8",
    artifacts: "./artifacts-gen8",
  },
  typechain: {
    outDir: "typechain-types-gen8",
  },
  mocha: {
    timeout: 600_000,
  },
};

export default config;
