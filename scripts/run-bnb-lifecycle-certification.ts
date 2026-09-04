import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";

/**
 * Gate D driver.
 *
 * Local Hardhat: source-head Gate D evidence in
 * test/BnbLifecycleCertification.spec.ts (LaunchFactory 4 / Campaign 3 +
 * Topaz V2 + TreasuryRouterV3 + CreatorRewardsVault + liquidityKind 1 +
 * 30 bps locker). This is not a claim that generation 4/3 is live BNB.
 *
 * bscTestnet: deploys an isolated source-head 4/3 staging stack, verifies it,
 * then runs the full acceptance lifecycle. The live 3/2 factory remains
 * untouched and chain 56 broadcasts remain forbidden by the 6C guard.
 */
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
  if (network.name === "hardhat" || network.name === "localhost") {
    run("npx", ["hardhat", "test", "test/BnbLifecycleCertification.spec.ts"]);
    const evidence = path.join(__dirname, "..", "reports", "bnb-lifecycle-certification-local.json");
    if (!fs.existsSync(evidence)) {
      throw new Error(`local lifecycle did not write ${evidence}`);
    }
    console.log("[bnb-lifecycle] local Gate D evidence written", evidence);
    return;
  }

  if (network.name !== "bscTestnet") {
    throw new Error(`unsupported network ${network.name}; use hardhat or bscTestnet`);
  }

  const manifest = path.resolve(
    String(process.env.BNB_6C_STAGE_DEPLOYMENT_FILE || "deployments/bnb/testnet.staged.json"),
  );
  const evidence = path.resolve(
    String(process.env.BNB_6C_ACCEPTANCE_RESULT_FILE || "reports/bnb-6c-testnet-acceptance.json"),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BNB_6C_ALLOW_SOURCE_HEAD_BROADCAST: "true",
    BNB_6C_ACK_CONTROLLED_TOPAZ: "true",
    BNB_6C_ACCEPTANCE_ENABLE_LIVE: "true",
    BNB_6C_ACCEPTANCE_SIGNER: "true",
    BNB_6C_STAGE_DEPLOYMENT_FILE: manifest,
    BNB_6C_ACCEPTANCE_RESULT_FILE: evidence,
  };

  // Testnet-only identities. The lifecycle funds actor EOAs from the dedicated
  // tBNB deployer; none of these keys are production or persisted.
  ephemeralKey(env, "BNB_6C_ROUTE_AUTHORITY_PRIVATE_KEY");
  ephemeralKey(env, "BNB_6C_TEST_CREATOR_PRIVATE_KEY");
  ephemeralKey(env, "BNB_6C_TEST_BUYER_PRIVATE_KEY");
  ephemeralKey(env, "BNB_6C_TEST_TRADER_PRIVATE_KEY");

  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.mkdirSync(path.dirname(evidence), { recursive: true });

  run("npx", ["hardhat", "run", "scripts/deploy-bnb-testnet-stage.ts", "--network", "bscTestnet"], env);
  run("npx", ["hardhat", "run", "scripts/verify-bnb-testnet-stage.ts", "--network", "bscTestnet"], env);
  run("npx", ["hardhat", "run", "scripts/test-bnb-6c-testnet-lifecycle.ts", "--network", "bscTestnet"], env);

  if (!fs.existsSync(evidence)) throw new Error(`BNB 6C lifecycle did not write ${evidence}`);
  const result = JSON.parse(fs.readFileSync(evidence, "utf8"));
  if (result.chainId !== 97 || result.accepted !== true || result.factoryLiveAfter !== true || result.createPausedAfter !== true) {
    throw new Error(`BNB 6C testnet evidence did not reach accepted safe state: ${JSON.stringify(result)}`);
  }
  console.log("[bnb-lifecycle] BNB 6C chain-97 acceptance passed", {
    manifest,
    evidence,
    factory: result.factory,
    campaign: result.campaign,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
