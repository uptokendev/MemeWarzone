import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";

function truthy(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}
function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32", env });
  if (result.status !== 0) process.exit(result.status || 1);
}
function ephemeralKey(env: NodeJS.ProcessEnv, name: string) {
  if (!String(env[name] || "").trim()) env[name] = ethers.Wallet.createRandom().privateKey;
}

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (network.name !== "bscTestnet" || chainId !== 97) throw new Error(`real Topaz certification refuses ${network.name}/${chainId}`);
  if (!truthy(process.env.BNB_REAL_TOPAZ_EXECUTION_AUTHORIZED)) {
    throw new Error("Launch Control authorization required: set BNB_REAL_TOPAZ_EXECUTION_AUTHORIZED=true only for the approved destructive run");
  }

  const stage = path.resolve(String(process.env.BNB_REAL_TOPAZ_STAGE_DEPLOYMENT_FILE || "reports/bnb-real-topaz-testnet-stage.json"));
  const evidence = path.resolve(String(process.env.BNB_REAL_TOPAZ_EVIDENCE_FILE || "reports/bnb-real-topaz-testnet-acceptance.json"));
  const topazManifest = path.resolve(String(process.env.TOPAZ_MANIFEST || "deployments/bscTestnet/minimal-topaz.json"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TOPAZ_MANIFEST: topazManifest,
    BNB_6C_ALLOW_SOURCE_HEAD_BROADCAST: "true",
    BNB_REAL_TOPAZ_ACCEPTANCE_ENABLE_LIVE: "true",
    BNB_REAL_TOPAZ_ACCEPTANCE_SIGNER: "true",
    BNB_REAL_TOPAZ_STAGE_DEPLOYMENT_FILE: stage,
    BNB_REAL_TOPAZ_EVIDENCE_FILE: evidence,
  };
  ephemeralKey(env, "BNB_6C_ROUTE_AUTHORITY_PRIVATE_KEY");
  ephemeralKey(env, "BNB_6C_TEST_CREATOR_PRIVATE_KEY");
  ephemeralKey(env, "BNB_6C_TEST_BUYER_PRIVATE_KEY");
  ephemeralKey(env, "BNB_6C_TEST_TRADER_PRIVATE_KEY");
  fs.mkdirSync(path.dirname(stage), { recursive: true });
  fs.mkdirSync(path.dirname(evidence), { recursive: true });

  run("npx", ["hardhat", "run", "scripts/deploy-bnb-real-topaz-testnet-stage.ts", "--network", "bscTestnet"], env);
  run("npx", ["hardhat", "run", "scripts/test-bnb-real-topaz-testnet-lifecycle.ts", "--network", "bscTestnet"], env);

  if (!fs.existsSync(evidence)) throw new Error(`real Topaz evidence missing: ${evidence}`);
  const result = JSON.parse(fs.readFileSync(evidence, "utf8"));
  const requiredTrue = ["realTopazCompatibility", "permanentLpLock", "feeHarvest80_20", "lpPrincipalPreserved", "factoryLiveAfter", "createPausedAfter", "accepted"];
  for (const key of requiredTrue) if (result[key] !== true) throw new Error(`evidence ${key} must be true`);
  if (result.controlledTopazDex !== false || result.chainId !== 97) throw new Error("evidence must be real Topaz chain 97 with controlledTopazDex=false");
  console.log(`[bnb-real-topaz] final certification evidence=${evidence}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
