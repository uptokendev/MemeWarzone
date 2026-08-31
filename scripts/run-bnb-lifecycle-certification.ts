import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { network } from "hardhat";

/**
 * Gate D driver.
 *
 * Local Hardhat: source-head Gate D evidence in
 * test/BnbLifecycleCertification.spec.ts (LaunchFactory 4 / Campaign 3 +
 * Topaz V2 + TreasuryRouterV3 + CreatorRewardsVault + liquidityKind 1 +
 * 30 bps locker). This is not a claim that generation 4/3 is live BNB.
 *
 * bscTestnet: refuses to masquerade as a preflight. It requires a funded
 * dedicated test EOA plus route-authority signing, then must produce the
 * evidence file consumed by test-topaz-graduation-flow.ts with
 * TOPAZ_ACCEPTANCE_REQUIRE_EVIDENCE=true.
 */
async function main() {
  if (network.name === "hardhat" || network.name === "localhost") {
    const result = spawnSync("npx", ["hardhat", "test", "test/BnbLifecycleCertification.spec.ts"], {
      stdio: "inherit",
      shell: process.platform === "win32",
      env: process.env,
    });
    if (result.status !== 0) process.exit(result.status || 1);
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

  throw new Error(
    [
      "bsc-testnet-full-cycle is not a preflight.",
      "It must create → buy to the low-threshold factory 0x77Af… → graduate → Topaz BUY → SELL → harvest → 80/20 → LP principal,",
      "then set TOPAZ_ACCEPTANCE_INPUT to that evidence and TOPAZ_ACCEPTANCE_REQUIRE_EVIDENCE=true.",
      "Do not fund this path until the dedicated testnet-certification EOA and route-authority signer are in GitHub Environment secrets.",
      "Local proof: npm run cert:bnb-lifecycle:local",
    ].join(" "),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
