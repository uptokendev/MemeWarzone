import { expect } from "chai";
import hre from "hardhat";
import {
  DOGEOS_TESTNET_CHAIN_ID,
  DOGEOS_TESTNET_DEFAULT_RPC_URL,
  assertDogeosKeyPresentWhenSelected,
  resolveDogeosTestnetDeployerKey,
  resolveDogeosTestnetRpcUrl,
} from "../scripts/lib/dogeosNetwork";

// Synthetic, well-known Hardhat test keys only. Never the values in config/dogeos.local.
const SYNTHETIC_DOGEOS_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SYNTHETIC_FALLBACK_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

describe("DogeOS testnet network config", function () {
  describe("resolveDogeosTestnetRpcUrl", function () {
    it("defaults to the public Chikyu RPC", function () {
      expect(DOGEOS_TESTNET_DEFAULT_RPC_URL).to.equal("https://rpc.testnet.dogeos.com");
      expect(resolveDogeosTestnetRpcUrl({})).to.equal("https://rpc.testnet.dogeos.com");
      expect(resolveDogeosTestnetRpcUrl({ DOGEOS_TESTNET_RPC_URL: "   " })).to.equal("https://rpc.testnet.dogeos.com");
    });

    it("uses DOGEOS_TESTNET_RPC_URL when set, trimmed", function () {
      expect(resolveDogeosTestnetRpcUrl({ DOGEOS_TESTNET_RPC_URL: " https://rpc.example.invalid " })).to.equal(
        "https://rpc.example.invalid",
      );
    });

    it("never reads a BSC or Robinhood RPC", function () {
      expect(
        resolveDogeosTestnetRpcUrl({
          BSC_TESTNET_RPC: "https://bsc.example.invalid",
          ROBINHOOD_TESTNET_RPC_URL: "https://rh.example.invalid",
        }),
      ).to.equal("https://rpc.testnet.dogeos.com");
    });
  });

  describe("resolveDogeosTestnetDeployerKey", function () {
    it("reads DOGEOS_TESTNET_DEPLOYER_PRIVATE_KEY", function () {
      expect(resolveDogeosTestnetDeployerKey({ DOGEOS_TESTNET_DEPLOYER_PRIVATE_KEY: SYNTHETIC_DOGEOS_KEY })).to.equal(
        SYNTHETIC_DOGEOS_KEY,
      );
    });

    it("adds the 0x prefix and trims", function () {
      expect(
        resolveDogeosTestnetDeployerKey({ DOGEOS_TESTNET_DEPLOYER_PRIVATE_KEY: ` ${SYNTHETIC_DOGEOS_KEY.slice(2)} ` }),
      ).to.equal(SYNTHETIC_DOGEOS_KEY);
    });

    it("ignores DEPLOYER_PK and PRIVATE_KEY_DEPLOY when the DogeOS key is missing", function () {
      expect(
        resolveDogeosTestnetDeployerKey({ DEPLOYER_PK: SYNTHETIC_FALLBACK_KEY, PRIVATE_KEY_DEPLOY: SYNTHETIC_FALLBACK_KEY }),
      ).to.equal("");
      expect(
        resolveDogeosTestnetDeployerKey({
          DOGEOS_TESTNET_DEPLOYER_PRIVATE_KEY: "  ",
          DEPLOYER_PK: SYNTHETIC_FALLBACK_KEY,
          PRIVATE_KEY_DEPLOY: SYNTHETIC_FALLBACK_KEY,
        }),
      ).to.equal("");
    });

    it("ignores DEPLOYER_PK and PRIVATE_KEY_DEPLOY when the DogeOS key is set", function () {
      expect(
        resolveDogeosTestnetDeployerKey({
          DOGEOS_TESTNET_DEPLOYER_PRIVATE_KEY: SYNTHETIC_DOGEOS_KEY,
          DEPLOYER_PK: SYNTHETIC_FALLBACK_KEY,
          PRIVATE_KEY_DEPLOY: SYNTHETIC_FALLBACK_KEY,
        }),
      ).to.equal(SYNTHETIC_DOGEOS_KEY);
    });
  });

  describe("assertDogeosKeyPresentWhenSelected", function () {
    it("throws when --network dogeosTestnet is selected and the key is empty", function () {
      expect(() =>
        assertDogeosKeyPresentWhenSelected(["node", "hardhat", "run", "x.ts", "--network", "dogeosTestnet"], ""),
      ).to.throw("DOGEOS_TESTNET_DEPLOYER_PRIVATE_KEY missing");
      expect(() => assertDogeosKeyPresentWhenSelected(["node", "hardhat", "--network=dogeosTestnet"], "")).to.throw(
        "DOGEOS_TESTNET_DEPLOYER_PRIVATE_KEY missing",
      );
    });

    it("does not throw when dogeosTestnet is selected and the key is present", function () {
      expect(() =>
        assertDogeosKeyPresentWhenSelected(["node", "hardhat", "--network", "dogeosTestnet"], SYNTHETIC_DOGEOS_KEY),
      ).not.to.throw();
    });

    it("does not throw when another network or no network is selected", function () {
      expect(() => assertDogeosKeyPresentWhenSelected(["node", "hardhat", "test"], "")).not.to.throw();
      expect(() =>
        assertDogeosKeyPresentWhenSelected(["node", "hardhat", "--network", "robinhoodTestnet"], ""),
      ).not.to.throw();
      expect(() => assertDogeosKeyPresentWhenSelected(["node", "hardhat", "dogeosTestnet"], "")).not.to.throw();
    });
  });

  describe("hardhat.config.ts", function () {
    it("registers dogeosTestnet on chain 6281971 with the resolved RPC", function () {
      const net = hre.config.networks.dogeosTestnet as { chainId?: number; url?: string; accounts?: unknown };
      expect(net, "dogeosTestnet network missing").to.not.equal(undefined);
      expect(DOGEOS_TESTNET_CHAIN_ID).to.equal(6281971);
      expect(net.chainId).to.equal(6281971);
      expect(net.url).to.equal(resolveDogeosTestnetRpcUrl(process.env));
      // Never compare or print the account values: they may be the real key from config/dogeos.local.
      expect(Array.isArray(net.accounts), "accounts must be an explicit key list").to.equal(true);
    });

    it("leaves the shared etherscan config untouched (no customChains, single-string apiKey)", function () {
      expect(hre.config.etherscan.customChains).to.deep.equal([]);
      const expectedApiKey = process.env.ETHERSCAN_API_KEY || "";
      expect(typeof hre.config.etherscan.apiKey).to.equal("string");
      // Boolean compare so a failure never prints the API key.
      expect(hre.config.etherscan.apiKey === expectedApiKey, "etherscan.apiKey differs from ETHERSCAN_API_KEY").to.equal(
        true,
      );
    });
  });
});
