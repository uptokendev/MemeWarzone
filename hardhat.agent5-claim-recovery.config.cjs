require("@nomicfoundation/hardhat-toolbox");

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 1 },
      viaIR: true,
      metadata: { bytecodeHash: "none" },
    },
  },
  networks: {
    hardhat: { chainId: 97 },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./.agent5-cache",
    artifacts: "./.agent5-artifacts",
  },
};
