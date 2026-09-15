import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";

const EXPECTED_SOURCE_SHA = "47c1f3f4338638931b8b6b1b2296ae8813d2b7f2";
const EXPECTED_INTEGRATION_SHA = "8944382619e05f09539614f5690b98521fe244ed";
const BNB_TESTNET_CHAIN_ID = 97;
const BNB_MAINNET_CHAIN_ID = 56;

function run(command: string, args: string[], env = process.env) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env,
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

function ephemeralKey(env: NodeJS.ProcessEnv, name: string) {
  if (!String(env[name] || "").trim()) env[name] = ethers.Wallet.createRandom().privateKey;
}

async function main() {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  if (chainId === BNB_MAINNET_CHAIN_ID) throw new Error("REJECTED: chain 56 production broadcast is forbidden");
  if (chainId !== BNB_TESTNET_CHAIN_ID) throw new Error(`native pending cert requires chain 97; got ${chainId}`);

  const expected = String(process.env.EXPECTED_SOURCE_SHA || EXPECTED_SOURCE_SHA).trim();
  const integration = String(process.env.EXPECTED_INTEGRATION_SHA || EXPECTED_INTEGRATION_SHA).trim();
  const campaignBlob = spawnSync("git", ["rev-parse", "HEAD:contracts/LaunchCampaign.sol"], { encoding: "utf8" });
  const expectedBlob = spawnSync("git", ["rev-parse", `${expected}:contracts/LaunchCampaign.sol`], { encoding: "utf8" });
  if (campaignBlob.status !== 0 || expectedBlob.status !== 0) {
    throw new Error("Unable to pin LaunchCampaign.sol blob against EXPECTED_SOURCE_SHA");
  }
  if (campaignBlob.stdout.trim() !== expectedBlob.stdout.trim()) {
    throw new Error(`LaunchCampaign.sol blob is not PR #358 head ${expected}`);
  }

  const manifest = path.resolve(String(process.env.BNB_6C_STAGE_DEPLOYMENT_FILE || "deployments/bnb/testnet.staged.json"));
  const evidence = path.resolve(
    String(process.env.BNB_PENDING_CERT_RESULT_FILE || "reports/bnb97-native-pending-graduation.json"),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BNB_6C_ALLOW_SOURCE_HEAD_BROADCAST: "true",
    BNB_6C_ACK_CONTROLLED_TOPAZ: "true",
    BNB_6C_ACCEPTANCE_ENABLE_LIVE: "true",
    BNB_6C_ACCEPTANCE_SIGNER: "true",
    BNB_6C_STAGE_DEPLOYMENT_FILE: manifest,
    BNB_PENDING_CERT_RESULT_FILE: evidence,
    EXPECTED_SOURCE_SHA: expected,
    EXPECTED_INTEGRATION_SHA: integration,
  };
  ephemeralKey(env, "BNB_6C_TEST_CREATOR_PRIVATE_KEY");
  ephemeralKey(env, "BNB_6C_TEST_BUYER_PRIVATE_KEY");
  ephemeralKey(env, "BNB_6C_TEST_TRADER_PRIVATE_KEY");

  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.mkdirSync(path.dirname(evidence), { recursive: true });

  run("npx", ["hardhat", "run", "scripts/deploy-bnb-testnet-stage.ts", "--network", "bscTestnet"], env);
  run("npx", ["hardhat", "run", "scripts/verify-bnb-testnet-stage.ts", "--network", "bscTestnet"], env);
  run("npx", ["hardhat", "run", "scripts/verify-bnb97-controlled-topaz-30bps.ts", "--network", "bscTestnet"], env);
  run("node", ["scripts/prepare-bnb97-native-pending-graduation-cert.mjs"], env);
  run("npx", ["hardhat", "run", "scripts/test-bnb97-native-pending-graduation.ts", "--network", "bscTestnet"], env);

  if (!fs.existsSync(evidence)) throw new Error(`missing evidence ${evidence}`);
  const result = JSON.parse(fs.readFileSync(evidence, "utf8"));
  if (result.chainId !== 97 || result.accepted !== true) {
    throw new Error(`native pending cert did not accept: ${JSON.stringify({ chainId: result.chainId, accepted: result.accepted })}`);
  }
  console.log("[bnb97-pending-cert] accepted", {
    chainId: result.chainId,
    factory: result.factory,
    campaign: result.campaign,
    pool: result.pool,
    harvestTx: result.harvestTx,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
