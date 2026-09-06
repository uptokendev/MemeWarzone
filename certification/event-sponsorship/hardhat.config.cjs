require("@nomicfoundation/hardhat-toolbox");

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
    sources: "../../contracts",
    tests: "../../test",
    cache: "../../cache-sponsorship-cert",
    artifacts: "../../artifacts-sponsorship-cert",
  },
};
