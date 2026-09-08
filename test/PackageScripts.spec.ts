import { expect } from "chai";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("package scripts", function () {
  const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8"));

  it("keeps core compile, test, coverage, gas, and size scripts", async () => {
    expect(pkg.scripts.compile).to.eq("hardhat compile");
    expect(pkg.scripts.test).to.eq("hardhat test");
    expect(pkg.scripts.coverage).to.eq("hardhat coverage");
    expect(pkg.scripts.gas).to.eq("cross-env REPORT_GAS=true hardhat test");
    expect(pkg.scripts.size).to.eq("hardhat run scripts/check-contract-size.ts");
  });

  it("keeps deployment environment and verification scripts wired", async () => {
    expect(pkg.scripts["deploy:check-env"]).to.eq("node scripts/check-deploy-env.cjs");
    expect(pkg.scripts["deploy:check-env:bsc-testnet"]).to.eq("node scripts/check-deploy-env.cjs bscTestnet");
    expect(pkg.scripts["deploy:verify"]).to.eq("hardhat run scripts/deploy-and-verify.ts");
    expect(pkg.scripts["deploy:verify:localhost"]).to.eq("hardhat run scripts/deploy-and-verify.ts --network localhost");
    expect(pkg.scripts["deploy:verify:bsc-testnet"]).to.eq("hardhat run scripts/deploy-and-verify.ts --network bscTestnet");
    expect(pkg.scripts["deploy:treasury-v2-minimal"]).to.eq("hardhat run scripts/deploy-minimal-treasury-router-v2.ts");
    expect(pkg.scripts["deploy:treasury-v2-minimal:bsc-testnet"]).to.eq(
      "hardhat run scripts/deploy-minimal-treasury-router-v2.ts --network bscTestnet",
    );
    expect(pkg.scripts["deploy:scheduled-test-factory:bsc-testnet"]).to.eq(
      "hardhat run scripts/deploy-scheduled-test-factory.ts --network bscTestnet",
    );
    expect(pkg.scripts["activate:scheduled-test-factory"]).to.eq(
      "hardhat run scripts/activate-scheduled-test-factory.ts",
    );
    expect(pkg.scripts["activate:scheduled-test-factory:bsc-testnet"]).to.eq(
      "hardhat run scripts/activate-scheduled-test-factory.ts --network bscTestnet",
    );
    expect(pkg.scripts["verify:authority"]).to.eq("hardhat run scripts/verify-deployment-authority.ts");
    expect(pkg.scripts["verify:authority:localhost"]).to.eq("hardhat run scripts/verify-deployment-authority.ts --network localhost");
    expect(pkg.scripts["verify:authority:bsc-testnet"]).to.eq("hardhat run scripts/verify-deployment-authority.ts --network bscTestnet");
    expect(pkg.scripts["verify:deployment"]).to.eq("hardhat run scripts/verify-deployment.ts");
    expect(pkg.scripts["verify:deployment:localhost"]).to.eq("hardhat run scripts/verify-deployment.ts --network localhost");
    expect(pkg.scripts["verify:deployment:bsc-testnet"]).to.eq("hardhat run scripts/verify-deployment.ts --network bscTestnet");
    expect(pkg.scripts["verify:route-authority"]).to.eq("node scripts/verify-route-authority.cjs");
    expect(pkg.scripts["protocol:rehearsal"]).to.eq("hardhat run scripts/local-protocol-rehearsal.ts");
    expect(pkg.scripts["rehearsal:check"]).to.eq("node scripts/rehearsal-check.cjs");
  });

  it("keeps frontend ABI and env export scripts wired", async () => {
    expect(pkg.scripts["sync:frontend-abis"]).to.eq("node scripts/sync-frontend-abis.cjs");
    expect(pkg.scripts["compile:frontend-abis"]).to.eq("hardhat compile && node scripts/sync-frontend-abis.cjs");
    expect(pkg.scripts["frontend:env"]).to.eq("node scripts/export-frontend-env.cjs");
    expect(pkg.scripts["frontend:env:bsc-testnet"]).to.eq("node scripts/export-frontend-env.cjs bscTestnet");
  });

  it("keeps pretestnet, deployment summary, simulation, indexer, monitoring, and acceptance scripts wired", async () => {
    expect(pkg.scripts["pretestnet:check"]).to.eq("node scripts/pretestnet-check.cjs");
    expect(pkg.scripts["deployment:summary"]).to.eq("node scripts/deployment-summary.cjs");
    expect(pkg.scripts["deployment:summary:bsc-testnet"]).to.eq("node scripts/deployment-summary.cjs bscTestnet");
    expect(pkg.scripts["economics:simulate"]).to.eq("node scripts/economic-simulations.cjs");
    expect(pkg.scripts["economics:simulate:suite"]).to.eq("node scripts/economic-simulations.cjs --config config/economic-scenarios.json");
    expect(pkg.scripts["economics:simulate:acceptance"]).to.eq(
      "node scripts/economic-simulations.cjs --config config/economic-scenarios.json --output output/economic-simulation-results.json",
    );
    expect(pkg.scripts["indexer:manifest"]).to.eq("node scripts/export-indexer-manifest.cjs");
    expect(pkg.scripts["indexer:manifest:localhost"]).to.eq("node scripts/export-indexer-manifest.cjs localhost");
    expect(pkg.scripts["indexer:manifest:bsc-testnet"]).to.eq("node scripts/export-indexer-manifest.cjs bscTestnet");
    expect(pkg.scripts["indexer:schema"]).to.eq("node scripts/export-indexer-schema.cjs");
    expect(pkg.scripts["indexer:run"]).to.eq("node scripts/indexer-runtime.cjs");
    expect(pkg.scripts["indexer:run:localhost"]).to.eq("node scripts/indexer-runtime.cjs localhost");
    expect(pkg.scripts["indexer:run:bsc-testnet"]).to.eq("node scripts/indexer-runtime.cjs bscTestnet");
    expect(pkg.scripts["keeper:graduation"]).to.eq("hardhat run scripts/graduation-keeper.ts");
    expect(pkg.scripts["keeper:graduation:localhost"]).to.eq("hardhat run scripts/graduation-keeper.ts --network localhost");
    expect(pkg.scripts["keeper:graduation:bsc-testnet"]).to.eq("hardhat run scripts/graduation-keeper.ts --network bscTestnet");
    expect(pkg.scripts["keeper:lp-harvest"]).to.eq("hardhat run scripts/lp-fee-harvester.ts");
    expect(pkg.scripts["keeper:lp-harvest:localhost"]).to.eq("hardhat run scripts/lp-fee-harvester.ts --network localhost");
    expect(pkg.scripts["keeper:lp-harvest:bsc-testnet"]).to.eq("hardhat run scripts/lp-fee-harvester.ts --network bscTestnet");
    expect(pkg.scripts["monitor:readiness"]).to.eq("node scripts/monitoring-readiness.cjs");
    expect(pkg.scripts["monitor:readiness:bsc-testnet"]).to.eq("node scripts/monitoring-readiness.cjs bscTestnet");
    expect(pkg.scripts["monitor:snapshot"]).to.eq("hardhat run scripts/monitoring-snapshot.ts");
    expect(pkg.scripts["monitor:snapshot:bsc-testnet"]).to.eq("hardhat run scripts/monitoring-snapshot.ts --network bscTestnet");
    expect(pkg.scripts["testnet:acceptance"]).to.eq("node scripts/testnet-acceptance.cjs");
  });

  it("keeps LP revenue wiring scripts available", async () => {
    expect(pkg.scripts["wire:lp-revenue"]).to.eq("hardhat run scripts/wire-lp-revenue.ts");
    expect(pkg.scripts["wire:lp-revenue:localhost"]).to.eq("hardhat run scripts/wire-lp-revenue.ts --network localhost");
    expect(pkg.scripts["wire:lp-revenue:bsc-testnet"]).to.eq("hardhat run scripts/wire-lp-revenue.ts --network bscTestnet");
  });

  it("keeps security scripts wired", async () => {
    expect(pkg.scripts["security:matrix"]).to.eq("node scripts/security-access-matrix.cjs");
    expect(pkg.scripts["security:check"]).to.eq("node scripts/security-check.cjs");
  });

  it("uses npm workflow and expected core dependencies", async () => {
    expect(pkg).to.not.have.property("packageManager");
    expect(pkg.devDependencies.hardhat).to.eq("^2.22.10");
    expect(pkg.devDependencies["@nomicfoundation/hardhat-toolbox"]).to.eq("^5.0.0");
    expect(pkg.dependencies["@openzeppelin/contracts"]).to.eq("^5.0.2");
  });
});
