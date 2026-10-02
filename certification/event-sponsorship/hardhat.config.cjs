const path = require("node:path");
require("@nomicfoundation/hardhat-toolbox");

const root = path.resolve(__dirname, "../..");

module.exports = {
  networks: {
    hardhat: {
      chainId: 97,
      accounts: {
        mnemonic: "test test test test test test test test test test test junk",
        count: 20,
        accountsBalance: "10000000000000000000000",
      },
    },
  },
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 1 },
      viaIR: true,
      metadata: { bytecodeHash: "none" },
    },
  },
  paths: {
    root,
    sources: path.join(root, "contracts"),
    tests: path.join(root, "test"),
    cache: path.join(root, "cache-sponsorship-cert"),
    artifacts: path.join(root, "artifacts-sponsorship-cert"),
  },
};
